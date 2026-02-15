/*
  Logging library for Learning Observer clients
*/

import { timestampEvent, mergeMetadata } from './util.js';
import { getBrowserInfo } from './metadata/browserinfo.js';
import * as Queue from './queue.js';
import * as disabler from './disabler.js';
import * as debug from './debugLog.js';
import * as util from './util.js';
import type { Logger, MetadataTask } from './types.js';
import type { LogDestination } from './debugLog.js';

export const QueueType = Queue.QueueType;

// We implement this as something like an FSM.
const INIT_STATES = {
  NOT_STARTED: 'NOT_STARTED', // init() has not been called
  IN_PROGRESS: 'IN_PROGRESS', // init() called, but waiting on loggers or metadata
  LOGGERS_READY: 'LOGGERS_READY', // loggers initialized, but queuing initial events / auth
  READY: 'READY', // Events streaming to loggers (which might have their own queues)
  ERROR: 'ERROR' // Something went very, very wrong
} as const;

let initialized: string = INIT_STATES.NOT_STARTED; // Current FSM state
let currentState: Promise<unknown> = Promise.resolve(); // promise pipeline to ensure we handle all initialization


let loggersEnabled: Logger[] = []; // A list of all loggers which should receive events.
let queue: Queue.Queue;
let pendingSource: string;
let pendingVersion: string;
let pendingMetadata: MetadataTask[] = [];

function isInitialized () {
  return initialized === INIT_STATES.READY;
}

/**
 * Collect all enabled loggers with an init function, call it,
 * and wait for all of them to finish initializing. We add this
 * function to our `currentState` pipeline to ensure loggers
 * are ready to go before we send events.
 */
async function initializeLoggers () {
  debug.info('initializing loggers');
  const initializedLoggers = loggersEnabled
    .filter(logger => typeof logger.init === 'function') // Filter out loggers without .init property
    .map(logger => logger.init!()); // Call .init() on each logger, which may return a promise

  try {
    await Promise.all(initializedLoggers);
    debug.info('Loggers initialized!');
    initialized = INIT_STATES.LOGGERS_READY;
  } catch (error) {
    initialized = INIT_STATES.ERROR;
    debug.error('Error resolving logger initializers:', error);
  }
}

/**
 * Executes and compiles metadata tasks into a single metadata object.
 *
 * When initializing `lo_event`, clients can set which metadata items
 * they wish to include.
 */
export async function compileMetadata(metadataTasks: MetadataTask[]) {
  const taskPromises = metadataTasks.map(async task => {
    try {
      const result = await Promise.resolve(task.func());
      return { [task.name]: result };
    } catch (error) {
      debug.error(`Error in initialization task ${task.name}:`, error);
      return null;
    }
  });

  const results = await Promise.all(taskPromises);
  return results.filter((r): r is Record<string, unknown> => r !== null);
}


/**
 * Set specific key/value pairs using the `lock_fields`
 * event. We use this to set specific fields that we want
 * included overall for subsequent events to prevent
 * sending the same information in each event.
 *
 * This is useful for items such as `source` and `version`
 * which should be the same for every event.
 *
 * This function works even after we are initialized and
 * processing items from the queue (INIT_STATES.READY).
 *
 * Each individual logger should keep track of state and
 * handle their respecitive reconnects properly.
 */
export function lockFields (data: Record<string, unknown>[]) {
  currentState = currentState.then(
    () => lockFieldsAsync(data)
  );
}

/**
 * Runs and awaits for all loggers to run their `setField` command
 */
async function lockFieldsAsync (data: Record<string, unknown>[]) {
  const payload = { fields: await mergeMetadata(data), event: 'lock_fields' };
  timestampEvent(payload);
  const authpromises = loggersEnabled
    .filter(logger => typeof logger.setField === 'function')
    .map(logger => logger.setField!(JSON.stringify(payload)));

  await Promise.all(authpromises);
}

// TODO: We should consider specifying a set of verbs, nouns, etc. we
// might use, and outlining what can be expected in the protocol
// TODO: We should consider structing / destructing here
export function init (
  source: string,
  version: string,
  loggers: Logger[],
  {
    debugLevel = debug.LEVEL.NONE as string,
    debugDest = [debug.LOG_OUTPUT.CONSOLE] as LogDestination[],
    useDisabler = true,
    queueType = Queue.QueueType.AUTODETECT as string,
    sendBrowserInfo = false,
    verboseEvents = false,
    metadata = [] as MetadataTask[],
  } = {}
) {
  if (!source || typeof source !== 'string') throw new Error('source must be a non-null string');
  if (!version || typeof version !== 'string') throw new Error('version must be a non-null string');

  util.setVerboseEvents(verboseEvents);
  queue = new Queue.Queue('LOEvent', { queueType });

  debug.setLevel(debugLevel);
  debug.setLogOutputs(debugDest);
  if (useDisabler) {
    currentState = currentState.then(() => disabler.init(useDisabler));
  }

  loggersEnabled = loggers;
  initialized = INIT_STATES.IN_PROGRESS;
  pendingSource = source;
  pendingVersion = version;
  pendingMetadata = metadata;
  currentState = currentState.then(initializeLoggers);
  if(sendBrowserInfo) {
    // In the future, some or all of this might be sent on every
    // reconnect
    logEvent("BROWSER_INFO", getBrowserInfo());
  }
}

/**
 * Begin dequeuing and streaming events.
 *
 * This should be called after init() and any preauth lockFields()
 * calls. Source/version and metadata are sent here so that preauth
 * fields (set between init() and go()) are transmitted first.
 *
 * Typical usage:
 *   lo_event.init(source, version, loggers, options);
 *   lo_event.lockFields([{ preauth_type: 'test' }]);   // sent first
 *   lo_event.lockFields([{ postauth: 'data' }]);       // sent second
 *   lo_event.go();  // source/version sent here, then streaming begins
 */
export function go () {
  lockFields([{ source: pendingSource, version: pendingVersion }]);
  currentState = currentState.then(async () => {
    const results = await compileMetadata(pendingMetadata);
    await lockFieldsAsync(results);
  });
  currentState = currentState.then(() => {
    if (initialized === INIT_STATES.ERROR) {
      debug.error('Cannot start dequeue loop: logger initialization failed');
      return;
    }
    initialized = INIT_STATES.READY;
    queue.startDequeueLoop({
      initialize: isInitialized,
      shouldDequeue: disabler.retry,
      onDequeue: sendEvent
    });
  });
}

function sendEvent (event: unknown) {
  const jsonEncodedEvent = JSON.stringify(event);
  for (const logger of loggersEnabled) {
    try {
      logger(jsonEncodedEvent);
    } catch (error) {
      if (error instanceof disabler.BlockError) {
        // Handle BlockError exception here
        disabler.handleBlockError(error);
      } else {
        // Other types of exceptions will propagate up
        throw error;
      }
    }
  }
}

export function logEvent (eventType: string, event: Record<string, unknown>) {
  // opt out / dead
  if (!disabler.storeEvents()) {
    return;
  }
  event.event = eventType;
  timestampEvent(event);

  queue.enqueue(event);
}

/**
 * We would like to be able to log events roughly following the xAPI
 * conventions (and possibly Caliper conventions). This allows us to
 * explicitly structure events with the same fields as xAPI, and
 * might have validation logic in the future. However, we have not
 * figured out the best way to do this, so please treath this as
 * stub / in-progress code.
 *
 * In the long term, we'd like to be as close to standards as possible.
 */
export function logXAPILite (
  {
    verb,
    object,
    result,
    context,
    attachments
  }: { verb: string; object?: unknown; result?: unknown; context?: unknown; attachments?: unknown }
) {
  logEvent(verb,
    { object, result, context, attachments }
  );
}

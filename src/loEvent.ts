/*
  Logging library for Learning Observer clients
*/

import { timestampEvent, mergeMetadata } from './util.js';
import type { QueueDebug } from './types.js';
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

/**
 * Total enqueued-but-unacked events across all ack-aware loggers (currently
 * websocketLogger). Zero means every event has been durably acknowledged by
 * the server — the precise "is anything unsaved?" signal for a beforeunload
 * warning, replacing the blob-based heuristic. Loggers without ack support
 * (which confirm on send) contribute zero.
 */
export async function unackedCount (): Promise<number> {
  const counts = await Promise.all(
    loggersEnabled
      .filter(logger => typeof logger.unackedCount === 'function')
      .map(logger => Promise.resolve(logger.unackedCount!()))
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Console debugging for the durable queue.
 *
 * Attached to `globalThis.loDebug` in browsers, because the useful moment for
 * this is a console prompt in a stuck tab, where there is no module to import:
 *
 *   loDebug.queue()        what is waiting, and WHY it is waiting
 *   loDebug.clearQueue()   drop everything, unsent included
 *
 * `queue()` summarizes rather than dumping records. A queue that only grows
 * looks identical whether the client is offline, the server is not acking, or
 * a frame was enqueued that can never BE acked — and the last one is invisible
 * in a raw dump unless you happen to notice a missing field. So it counts the
 * unnamed records explicitly and breaks the rest down by event type, which is
 * what turns "there are a ton of save_blobs" into a diagnosis.
 */
async function queueReport (limit = 50): Promise<Record<string, unknown>[]> {
  const handles = loggersEnabled.filter(l => l.queueDebug).map(l => l.queueDebug!);
  if (!handles.length) {
    console.log('loDebug: no ack-aware logger with a durable queue.');
    return [];
  }

  const rows: Record<string, unknown>[] = [];
  let total = 0;
  let unnamed = 0;
  const byType: Record<string, number> = {};

  for (const h of handles) {
    total += await h.count();
    for (const rec of await h.inspect(limit)) {
      // Records are stored as { seq, payload } (memory) or the raw stored
      // object (IDB); the payload is the serialized frame either way.
      const r = rec as Record<string, unknown>;
      const raw = (r.payload ?? r) as unknown;
      let frame: Record<string, any> = {};
      try { frame = typeof raw === 'string' ? JSON.parse(raw) : (raw as any) ?? {}; }
      catch { /* unparseable — reported as unknown below */ }

      const type = frame.event ?? frame.type ?? '(unknown)';
      const id = frame?.metadata?.eventId;
      byType[type] = (byType[type] ?? 0) + 1;
      if (!id) unnamed++;
      rows.push({ seq: r.seq, event: type, eventId: id ?? '— UNNAMED —', bytes: JSON.stringify(frame).length });
    }
  }

  console.log(`loDebug: ${total} record(s) waiting; showing up to ${limit}.`);
  console.table(byType);
  if (unnamed) {
    console.warn(
      `loDebug: ${unnamed} of the first ${limit} record(s) inspected have no ` +
      'metadata.eventId (the total above may hold more). The server acks ' +
      'by name, so these can never be acked — they are sent best-effort and ' +
      'dropped. If they keep appearing, an enqueue path is not stamping.'
    );
  }
  console.table(rows);
  return rows;
}

function clearQueues (): void {
  const handles = loggersEnabled.filter(l => l.queueDebug).map(l => l.queueDebug!);
  handles.forEach(h => h.clear());
  console.warn(`loDebug: cleared ${handles.length} queue(s) — unsent events discarded.`);
}

export const loDebug = { queue: queueReport, clearQueue: clearQueues };

// Attach for console use. Debug-only affordance, browser-only, and it never
// overwrites something already there.
if (typeof globalThis !== 'undefined' && !(globalThis as any).loDebug) {
  (globalThis as any).loDebug = loDebug;
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
    sendBrowserInfo = false,
    verboseEvents = false,
    metadata = [] as MetadataTask[],
  } = {}
) {
  if (!source || typeof source !== 'string') throw new Error('source must be a non-null string');
  if (!version || typeof version !== 'string') throw new Error('version must be a non-null string');

  util.setVerboseEvents(verboseEvents);
  // The front desk is IN_MEMORY, explicitly (§5). It is a hand-off buffer
  // between logEvent() and the loggers, not a durable store — and in a browser
  // an autodetected backend would make it a *second* IndexedDB store on the
  // delivery path: a destructive delete-on-read hop inside §1's promise that
  // adds no durability. One durable store, the outbox.
  queue = new Queue.Queue('LOEvent', { queueType: Queue.QueueType.IN_MEMORY });

  debug.setLevel(debugLevel);
  debug.setLogOutputs(debugDest);
  if (useDisabler) {
    currentState = currentState.then(() => disabler.init(useDisabler));
  }

  loggersEnabled = loggers;
  // Loggers are constructed before init() runs, so the application's identity
  // reaches them here. A durable logger needs it to namespace its store: two
  // apps on one origin otherwise share an outbox and drain each other's
  // records (§2).
  loggers.forEach(logger => logger.configure?.({ source, version }));
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
    // No disabler gate here. Rate limits and blocklists gate the SEND stage,
    // inside the durable loggers, *after* the outbox commit (§5): a blocked
    // client keeps accepting and storing events and merely stops sending them.
    // Gating here would hold events in this in-memory buffer for the length of
    // the block — outside §1's promise, and lost if the tab closes. The
    // privacy half of the disabler (a DROP action refusing to store at all)
    // lives in logEvent() below, where it belongs.
    queue.startDequeueLoop({
      initialize: isInitialized,
      onDequeue: sendEvent
    });
  });
}

function sendEvent (event: unknown) {
  const jsonEncodedEvent = JSON.stringify(event);
  for (const logger of loggersEnabled) {
    // A throwing logger must not cost its siblings their copy of the event.
    try {
      logger(jsonEncodedEvent);
    } catch (error) {
      debug.error(`Logger ${logger.lo_id ?? logger.lo_name ?? 'unnamed'} threw on an event`, error);
    }
  }
}

/**
 * Protocol frame names. Application events share the `event` field with the
 * protocol, and an app event named like a protocol frame would be misparsed on
 * every redelivery, forever — so the client refuses to enqueue one (§12).
 */
const RESERVED_EVENTS = new Set(['fetch_blob', 'save_blob', 'lock_fields']);

export function logEvent (eventType: string, event: Record<string, unknown>) {
  if (RESERVED_EVENTS.has(eventType)) {
    // Throwing rather than dropping: it is a caller bug, caught the first time
    // the line runs, and silently dropping an event is the one thing this
    // library must not do.
    throw new Error(`logEvent: '${eventType}' is a reserved protocol frame name; pick another event type`);
  }
  // opt out / dead
  if (!disabler.storeEvents()) {
    return;
  }
  const stamped = { ...event, event: eventType };
  timestampEvent(stamped);

  queue.enqueue(stamped);
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

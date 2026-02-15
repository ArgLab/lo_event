// import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { storage } from './browserStorage.js';

/**
 * Helper function for copying specific field values
 * from a given source. This is called to collect browser
 * information if available.
 *
 * Example usage:
 *  const copied = copyFields({ a: 1, b: 2, c: 3 }, ['a', 'b'])
 *  console.log(copied)
 *  // expected output: { a: 1, b: 2 }
 */
export function copyFields(source: object | null | undefined, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (source) {
    const obj = source as Record<string, unknown>;
    fields.forEach(field => {
      if (field in obj) {
        result[field] = obj[field];
      }
    });
  }
  return result;
}

/*
  Generate a unique key, which can be used for session IDs, anonymous user IDs, and other similar purposes.

  Parameters:
  - prefix (str): Optional prefix to prepend to the generated key.

  Returns:
  str: A string representing the unique key, in the format "{prefix}-{randomUUID}-{timestamp}". If no prefix is provided, the format will be "{randomUUID}-{timestamp}".
  */
export function keystamp (prefix?: string): string {
  return `${prefix ? prefix + '-' : ''}${uuidv4()}-${Date.now()}`;
  //  return `${prefix ? prefix + '-' : ''}${crypto.randomUUID()}-${Date.now()}`;
}

/*
  Create a fully-qualified web socket URL.

  All parameters are optional when running on a web page. On an extension,
  we need, at least, the base server.

  This will:
  * Convert relative URLs into fully-qualified ones, if necessary
  * Convert HTTP/HTTPS URLs into WS/WSS ones, if necessary

  Example usage:
    fullyQualifiedWebsocketURL('/websocket/endpoint', 'http://websocket.server');
    // Expected output: ws://websocket.server/websocket/endpoint
    // See tests for more examples
  */
export function fullyQualifiedWebsocketURL (defaultRelativeUrl?: string, defaultBaseServer?: string): string {
  const relativeUrl = defaultRelativeUrl || '/wsapi/in';
  const baseServer = defaultBaseServer || (typeof document !== 'undefined' && document.location);

  if (!baseServer) {
    throw new Error('Base server is not provided.');
  }

  const url = new URL(relativeUrl, baseServer as string | URL);

  const protocolMap: Record<string, string> = { 'https:': 'wss:', 'http:': 'ws:', 'ws:': 'ws:', 'wss:': 'wss:' };

  if (!protocolMap[url.protocol]) {
    throw new Error('Protocol mapping not found.');
  }

  url.protocol = protocolMap[url.protocol];

  return url.href;
}

let cachedBrowserStamp: string | null = null;

function browserStamp(): string {
  if (cachedBrowserStamp) {
    return cachedBrowserStamp;
  }
  // Generate a stamp immediately so we can return synchronously
  cachedBrowserStamp = keystamp();
  const stampKey = 'loBrowserStamp';
  // Attempt to load a previously-stored stamp from storage (callback-based)
  storage.get([stampKey], (result) => {
    if (result[stampKey]) {
      cachedBrowserStamp = result[stampKey] as string;
    } else {
      storage.set({ [stampKey]: cachedBrowserStamp });
    }
  });
  return cachedBrowserStamp;
}

let eventIndex = 0; // Initialize index counter
let sessionStamp = keystamp();

// TODO:
// (a) We probably want this elsewhere
// (b) With the current flow of logic, init() might be called after logEvent,
//     and even if set to false, a few events might have extra metadata.
// This isn't a killer, since the reason not to do this is mostly due to
// bandwidth.
let verboseEvents = true;

export function setVerboseEvents(value: boolean): void {
  verboseEvents = value;
}

/**
 * Example usage:
 *  event = { event: 'ADD', data: 'stuff' }
 *  timestampEvent(event)
 *  event
 *  // { event: 'ADD', data: 'stuff', metadata: { ts, human_ts, iso_ts, sessionIndex, sessionTag } }
 */
export function timestampEvent (event: Record<string, unknown>): void {
  if (!event.metadata) {
    event.metadata = {};
  }

  const metadata = event.metadata as Record<string, unknown>;
  metadata.iso_ts = new Date().toISOString();
  if(verboseEvents) {
    metadata.ts = Date.now();
    metadata.human_ts = Date();
    metadata.sessionIndex = eventIndex++;
    metadata.sessionTag = sessionStamp;
    metadata.browserTag = browserStamp();
  }
}

/**
 * We provide an id for each system that is stored
 * locally with the client. This allows us to more easily
 * parse events when debugging in specific contexts.
 *
 * Example usage:
 *  const debugMetadata = await fetchDebuggingIdentifier();
 *  console.log(debugMetadata);
 *  // Expected output: { logger_id: <unique_logger_id> }
 */
export function fetchDebuggingIdentifier (): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const metadata: Record<string, unknown> = {};

    storage.get(['logger_id', 'name'], (result) => {
      if (result.logger_id) {
        metadata.logger_id = result.logger_id;
      } else {
        metadata.logger_id = keystamp('lid');
        storage.set({ logger_id: metadata.logger_id });
      }
      if (result.name) {
        metadata.name = result.name;
      }
      resolve(metadata);
    });
  });
}

/**
 * Deeply merge `source` into `target`.
 * `target` should be passed by reference
 *
 * This is a helper function for `mergeMetadata`.
 *
 * Example usage:
 *  const obj1 = { a: 1, b: { c: 3 } };
 *  const obj2 = { b: { d: 4 }, e: 5 };
 *  util.mergeDictionary(obj1, obj2);
 *  obj1
 *  // { a: 1, b: { c: 3, d: 4 }, e: 5 }
 */
export function mergeDictionary (target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key in source) {
    if (
      Object.prototype.hasOwnProperty.call(target, key) &&
      typeof target[key] === 'object' && target[key] !== null &&
      typeof source[key] === 'object' && source[key] !== null
    ) {
      mergeDictionary(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = source[key];
    }
  }
}

/**
 * Merges the output of dictionaries, sync functions, and async
 * functions into a single master dictionary.
 *
 * Functions and async functions should return dictionaries.
 *
 * @param {Array} inputList - List of dictionaries, sync functions, and async functions
 * @returns {Promise<Object>} - A Promise that resolves to the compiled master dictionary
 *
 * Example usage:
 *  const metadata = await mergeMetadata([ browserInfo(), { source: '0.0.1' }, extraMetadata() ])
 *  console.log(metadata);
 * // { browserInfo: {}, source: '0.0.1', metadata: { extra: 'extra data' }}
 */
type MetadataInput = Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);

export async function mergeMetadata (inputList: MetadataInput[]): Promise<Record<string, unknown>> {
  // Initialize the master dictionary
  const masterDict: Record<string, unknown> = {};

  // Iterate over each item in the input list
  for (const item of inputList) {
    let result;

    if (typeof item === 'object') {
      // If the item is a dictionary, merge it into the master dictionary
      mergeDictionary(masterDict, item);
    } else if (typeof item === 'function') {
      // If the item is a function (sync or async), execute it
      result = await item();

      if (typeof result === 'object') {
        // If the result of the function is a dictionary, merge it into the master dictionary
        mergeDictionary(masterDict, result);
      } else {
        console.log('Ignoring non-dictionary result:', result);
      }
    } else {
      console.log('Ignoring invalid item:', item);
    }
  }

  return masterDict;
}

export function delay (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
const MS = 1;
const SECS = 1000 * MS;
const MINS = 60 * SECS;
const HOURS = 60 * MINS;

export const TERMINATION_POLICY = {
  DIE: 'DIE',
  RETRY: 'RETRY'
} as const;

/**
 * This function repeatedly tries to run another function
 * until it returns a truthy value while waiting a set amount
 * of time inbetween each attempt.
 *
 * The system will either terminate when we have await each
 * delay amount in the `delays` list (TERMINATION_POLICY.DIE)
 * OR we continue retrying using the last item in our `delays`
 * list until we reach the `maxRetries` (TERMINATION_POLICY.RETRY).
 *
 * Example usage:
 *  util.backoff(checkCondition, 'Condition not met after retries.')
 *    .then(() => console.log('Condition met.'))
 *    .catch(error => console.error(error.message));
 *
 * @param {*} predicate function that returns truthy value
 * @param {*} errorMessage message to be thrown when we run out of delays
 * @param {*} delays list of MS values to be await in order
 * @default delays defaults to [100ms, 1sec, 1min, 5min, 30min]
 * @param {*} terminationPolicy when to be done retrying
 * @default terminationPolicy defaults to TERMINATION_POLICY.DIE
 * @param {*} maxRetries number of maximum retries when terminationPolicy is set to RETRY
 * @default maxRetries defaults to Infinity
 * @returns returns when predicate is true or throws errorMessage
 */
export async function backoff (
  predicate: () => unknown | Promise<unknown>,
  errorMessage = 'Could not resolve backoff function',
  // In milliseconds, time between retries until we fail.
  delays = [100 * MS, 1 * SECS, 10 * SECS, 1 * MINS, 5 * MINS, 30 * MINS],
  terminationPolicy: typeof TERMINATION_POLICY[keyof typeof TERMINATION_POLICY] = TERMINATION_POLICY.DIE,
  maxRetries = Infinity
): Promise<true> {
  let retryCount = 0;
  while (true) {
    if (await predicate()) {
      return true;
    }
    // terminate if we are done with delays list
    if (terminationPolicy === TERMINATION_POLICY.DIE && retryCount >= delays.length) {
      break;
    }
    const delayTime = retryCount < delays.length ? delays[retryCount] : delays[delays.length - 1];
    await delay(delayTime);

    retryCount++;
    // terminate if past max retries
    if (terminationPolicy === TERMINATION_POLICY.RETRY && retryCount > maxRetries) {
      break;
    }
  }
  throw new Error(errorMessage);
}

// The `once` function is a decorater function that takes in a
// function `func` and returns a new function. The returned function
// can only be called once, and any subsequent calls will result in an
// error. It is intended for the event loops in the various queue
// code.
//
// This is similar to the underscore once, but in contrast to that
// one, subsequent calls give an error rather than silently doing
// nothing. This is important as we are debugging the code. In the
// future, we might make this configurable or just switch, but for
// now, we'd like to understand if this ever happens and make it very
// obvious,
export function once<T extends (...args: any[]) => any>(func: T): T {
  let run = false;
  return function (this: unknown, ...args: any[]) {
    if (!run) {
      run = true;
      return func.apply(this, args);
    } else {
      console.log('>>>> Function called more than once. This should never happen <<<<');
      throw new Error('Error! Function was called more than once! This should never happen');
    }
  } as T;
}

/*
  Retrieve an element from a tree with dotted notation

  e.g. treeget(
     {"hello": {"bar":"biff"}},
     "hello.bar"
  )

  This can also handle embbedded lists identified
  using notations like addedNodes[0].className.

  If not found, return null

  This was created in the extension, but is being transferred into
  `lo_event`. Once it is merged, the extension should be modified to
  use the version from `lo_event`, and this should be removed from
  there.
*/
export function treeget(tree: Record<string, unknown>, key: string): unknown {
  let keylist = key.split(".");
  let subtree: unknown = tree;
  for(let i=0; i<keylist.length; i++) {
    // Don't process empty subtrees
    if (subtree === null) {
      return null;
    }
    const node = subtree as Record<string, unknown>;
    // If the next dotted element is present,
    // reset the subtree to only include that node
    // and its descendants.
    if (keylist[i] in node) {
      subtree = node[keylist[i]];
    }
    // If a bracketed element is present, parse out
    // the index, grab the node at the index, and
    // set the subtree equal to that node and its
    // descendants.
    else {
      if (keylist[i] && keylist[i].indexOf('[')>0) {
        const item = keylist[i].split('[')[0];
        const idx_orig = keylist[i].split('[')[1];
        const idx = idx_orig.split(']')[0];
        if (item in node) {
          const arr = node[item] as Record<string, unknown>;
          if (arr[idx] !== undefined) {
            subtree = arr[idx];
          } else {
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    }
  }
  return subtree;
}

/**
 * Takes a number of seconds and converts it into a human-friendly time string in the format HH:MM:SS.
 *
 * @param {number} seconds - The number of seconds to format into a time string
 * @returns {string} The formatted time string
 *
 * Will do things like omit hours (and perhaps be smarter in the future)
 */
export function formatTime(seconds: number): string {
  // Calculate hours, minutes, and remaining seconds
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = (seconds % 60).toFixed(2);

  // Format hours, minutes, and remaining seconds to include leading zeros
  const formattedHours = hours.toString().padStart(2, '0');
  const formattedMinutes = minutes.toString().padStart(2, '0');
  const formattedSeconds = remainingSeconds.padStart(5, '0');

  // Concatenate and return the formatted time
  if (hours > 0) {
    return `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
  } else {
    return `${formattedMinutes}:${formattedSeconds}`;
  }
}

/**
 * This function dispatches an event in the appropriate context for
 * our environment.
 *
 * When working in an extension, we want to send a message via the
 * `chrome.runtime` object.
 *
 * When working in a browser, we want to dispatch the event via the
 * `window` object.
 */
export function dispatchCustomEvent (eventName: string, detail: CustomEventInit): void {
  const event = new CustomEvent(eventName, detail);
  if (typeof window !== 'undefined') {
    // Web page: dispatch directly on window
    window.dispatchEvent(event);
  } else if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    // Chrome extension background script: use chrome.runtime to send messages
    chrome.runtime.sendMessage({ eventName, detail }, () => {
      if (chrome.runtime?.lastError) {
        console.warn(`No listeners found for event, ${eventName}, in this context.`);
      }
    });
  } else {
    console.warn('Event dispatching is not supported in this environment.');
  }
}

/**
 * This function consumes a custom event in the appropriate context for
 * our environment.
 *
 * When working in an extension, it listens for messages via the
 * `chrome.runtime.onMessage` object.
 *
 * When working in a browser, it listens for events on the
 * `window` object.
 */
export function consumeCustomEvent (eventName: string, callback: (detail: unknown, sender?: unknown) => void): () => void {
  if (typeof window !== 'undefined') {
    // Web page: listen for the event on the window object
    const listener = (event: CustomEvent) => {
      callback(event.detail);
    };
    window.addEventListener(eventName, listener as EventListener);

    // Return a function to remove the event listener
    return () => window.removeEventListener(eventName, listener as EventListener);
  } else if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    // Chrome extension background script: listen for messages via chrome.runtime
    const listener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      if (msg.eventName === eventName) {
        callback(msg.detail, sender);
        sendResponse?.({ status: 'received' });
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // Return a function to remove the message listener
    return () => chrome.runtime!.onMessage!.removeListener(listener);
  } else {
    console.warn('Event consumption is not supported in this environment.');
    return () => {
      console.warn('No listener to remove in this environment.');
    };
  }
}

/**
 * Convert seconds to a time string.
 *
 * Compact representation.
 *  10     ==> 10s
 *  125    ==> 2m
 *  3600   ==> 1h
 *  7601   ==> 2h
 *  764450 ==> 8d
 */
export function renderTime (t: number): string {
  const seconds = Math.floor(t) % 60;
  const minutes = Math.floor(t / 60) % 60;
  const hours = Math.floor(t / 3600) % 60;
  const days = Math.floor(t / 3600 / 24);

  if (days > 0) {
    return String(days) + 'd';
  }
  if (hours > 0) {
    return String(hours) + 'h';
  }
  if (minutes > 0) {
    return String(minutes) + 'm';
  }
  if (seconds > 0) {
    return String(seconds) + 's';
  }
  return '-';
}

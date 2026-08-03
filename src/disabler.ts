/*
 * Code to handle blacklists, opt-ins, opt-outs, etc.
 *
 * Unfinished. We need to flush out storage.js and connect to make
 * this work.
 *
 * TODO: At least document what's unfinished and what work is remaining. It
 * looks like there was some progress since the above was written.
 */

/*
 * We have different types of opt-in/opt-out scenarios. For example:
 * - If we have a contractual gap with a school, we might want to hold
 *   events on the client-side pending resolution
 * - If a school or student does not want us to collect their data, but
 *   have the extension installed, we don't want to store them
 *   client-side.
 */
import { storage } from './browserStorage.js';
import * as debug from './debugLog.js';
import * as util from './util.js';

export const EVENT_ACTION = {
  TRANSMIT: 'TRANSMIT',
  MAINTAIN: 'MAINTAIN',
  DROP: 'DROP'
} as const;

/*
 * We make the time limit stochastic, so we don't have all clients
 * retry at the same time if we e.g. block many clients at once.
 */
export const TIME_LIMIT = {
  PERMANENT: -1,
  MINUTES: 1000 * 60 * 5 * (1 + Math.random()), // 5-10 minutes
  DAYS: 1000 * 60 * 60 * 24 * (1 + Math.random()) // 1-2 days
} as const;

const DISABLER_STORE = 'disablerState';

interface DisablerState {
  action: string;
  expiration: number | null;
}

export class BlockError extends Error {
  timeLimit: number;
  action: string;

  constructor (message: string, timeLimit: string | number, action: string) {
    super(message);
    this.name = 'BlockError';
    this.message = message;
    this.timeLimit = isNaN(timeLimit as number) ? (TIME_LIMIT as Record<string, number>)[timeLimit as string] : timeLimit as number;
    this.action = (EVENT_ACTION as Record<string, string>)[action]; // <-- Check we're in EVENT_ACTION.
  }
}

const DEFAULTS: DisablerState = {
  action: EVENT_ACTION.TRANSMIT,
  expiration: null
};

let { action, expiration } = DEFAULTS;

export async function init (_defaults: unknown = null) {
  return new Promise<void>((resolve, reject) => {
    // Check if storage is defined
    if (!storage || !storage.get) {
      debug.error('Storage is not set or storage.get is undefined. This should never happen.');
      reject(new Error('Storage or storage.get is undefined'));
    } else {
      // Fetch initial values from storage upon loading
      storage.get(DISABLER_STORE, (storedState) => {
        const state = (storedState[DISABLER_STORE] || {}) as DisablerState;
        action = state.action || DEFAULTS.action;
        expiration = state.expiration || DEFAULTS.expiration;
        debug.info(`Initialized disabler. action: ${action} expiration: ${new Date(expiration!).toString()}`);
        resolve();
      });
    }
  });
}

export function handleBlockError (error: BlockError) {
  action = error.action;
  if (error.timeLimit === TIME_LIMIT.PERMANENT) {
    expiration = TIME_LIMIT.PERMANENT;
  } else {
    expiration = Date.now() + error.timeLimit;
  }
  storage.set({ [DISABLER_STORE]: { action, expiration } });
}

export function storeEvents () {
  return action !== EVENT_ACTION.DROP;
}

export function streamEvents () {
  return action === EVENT_ACTION.TRANSMIT;
}

/**
 * What kind of block is in effect right now:
 *
 *   'clear'     — none; transmit normally.
 *   'temporary' — a rate limit. Sending pauses until the expiry; admission
 *                 continues, and `retry()` sleeps until it may resume.
 *   'permanent' — a permanent hold on transmission (e.g. MAINTAIN pending a
 *                 contract resolution). Sending stops for good; events keep
 *                 accumulating durably. Nothing may be deleted.
 *   'opt-out'   — a permanent privacy opt-out (permanent *and* DROP). The only
 *                 condition under which stored, unsent events may be deleted
 *                 (§5 of docs/reliable-delivery.md).
 *
 * One predicate, in one place, deliberately. `retry()` answers "may I send
 * yet?" and returns false for anything permanent, which is a different question
 * from "may I destroy this user's unsent work?" — reconstructing the second
 * from the first at each call site is how a permanent rate limit turns into
 * silent data loss.
 */
export type BlockMode = 'clear' | 'temporary' | 'permanent' | 'opt-out';

export function currentMode (): BlockMode {
  if (action === EVENT_ACTION.TRANSMIT) return 'clear';
  if (expiration !== TIME_LIMIT.PERMANENT) return 'temporary';
  return action === EVENT_ACTION.DROP ? 'opt-out' : 'permanent';
}

/**
 * Sleep until sending is allowed again. Returns true once the block has
 * genuinely expired, false if it is (or becomes) permanent.
 *
 * The deadline is re-read after every sleep, and that is the whole point of the
 * loop: a second blocklist frame can arrive *while we are waiting* — extending
 * the block, or upgrading it to permanent. Reading `expiration` once on entry
 * and clearing the state unconditionally afterwards would let the sleep that
 * started under the old, shorter block wipe out the newer one, and the client
 * would resume sending straight through a block the server had just extended.
 */
export async function retry () {
  while (true) {
    if (expiration === TIME_LIMIT.PERMANENT) {
      return false;
    }
    if (expiration === null) {
      return true;                       // nothing is blocking us
    }
    const remaining = expiration - Date.now();
    if (remaining <= 0) {
      break;
    }
    debug.info(`waiting for expiration to happen ${new Date(expiration).toString()}`);
    await util.delay(remaining);
    debug.info('we are done waiting');
  }
  action = DEFAULTS.action;
  expiration = DEFAULTS.expiration;
  // NOTE: If the client continuously sends messages to the server and
  // keeps generating new messages, we may hit a rate limit depending on
  // the `storage` API in use. To avoid this, we only call the `set` method
  // when the new value differs from the existing value in `storage`.
  storage.get([DISABLER_STORE], (result) => {
    const currentValue = result[DISABLER_STORE] as DisablerState | undefined;
    if (!currentValue || currentValue.action !== action || currentValue.expiration !== expiration) {
      storage.set({ [DISABLER_STORE]: { action, expiration } });
    }
  });
  return true;
}

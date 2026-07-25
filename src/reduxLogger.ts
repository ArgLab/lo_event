/*
 * This is a logger which uses redux in order to route events to one
 * or more subscribers. It is currently used for working with the test
 * framework.
 *
 * In the future, our goal is to make this into a 'batteries included'
 * framework for developing `react`/`redux`/`lo_event` applications
 * which embodies good design practices for this domain.
 *
 * Our goal is NOT to be universal. Integrating `lo_event` into an
 * exiting `redux` workflow is ≈25 lines of code. This framework is
 * opinionated, and if there's a clash of opinions, you're better
 * off writing those 25 lines.
 *
 * Beyond test cases, the major use case is to make the development of
 * a broad class of simple educational activites, well, simple. For
 * larger applications, it probably makes more sense to start with
 * vanilla `react`/`redux`/`lo_event` without using this file, to just
 * use bits and pieces, or to treat this code as an examplar.
 */
import * as redux from 'redux';
import { thunk } from 'redux-thunk';
import { createStateSyncMiddleware, initMessageListener } from 'redux-state-sync';
import debounce from 'lodash/debounce.js';

import * as util from './util.js';
import type { Logger, ReducerFn, JSONObject, JSONValue } from './types.js';

declare global {
  interface Window {
    __REDUX_DEVTOOLS_EXTENSION_COMPOSE__?: typeof redux.compose;
  }
}

// =============================================================================
// Types
// =============================================================================

interface ReduxAction extends JSONObject {
  redux_type: string;
  type: string;
  payload: JSONValue;
}

export type SaveStatus = 'saved' | 'modified' | 'error';

/**
 * A fatal, sticky condition surfaced by a logger (currently websocketLogger's
 * requireAck mis-deploy: ACK_REQUIRED). Null = no fatal. Sticky until the
 * logger clears it (e.g. a late ack-capable hello recovers the connection).
 */
export type FatalState = { code: string; message: string } | null;

/**
 * Options for the Redux logger's persistence behavior.
 *
 * serializeForSave:  Called before every save (server and localStorage).
 *                    Receives the full Redux state, returns the subset to persist.
 *                    Default: identity (persist everything).
 *
 * deserializeOnLoad: Called when a fetch_blob response arrives.
 *                    Receives the raw blob from the server and the current Redux state.
 *                    Returns the blob to merge (via shallow spread) into current state.
 *                    Default: identity (merge entire blob).
 */
export interface ReduxLoggerOptions {
  serializeForSave?: (state: JSONObject) => JSONObject;
  deserializeOnLoad?: (blob: JSONObject, currentState: JSONObject) => JSONObject;
  /**
   * Cross-tab state sync via redux-state-sync. Default: false (off).
   *
   * - false (default): nothing is broadcast.
   * - true: broadcast every action to other store instances in the same
   *   browser — EXCEPT lo_event's own lifecycle actions (see below).
   * - { predicate }: broadcast only actions `predicate(action)` approves
   *   (still minus the lifecycle actions). Lets the app drop events that must
   *   not cross tabs — e.g. content-load events, which are per-tab.
   *
   * Regardless of true/predicate, lo_event NEVER broadcasts its own lifecycle
   * actions (SET_STATE — a full-state replace from blob restore — and
   * LOCKFIELDS), since those would clobber or duplicate state across tabs.
   *
   * Off by default because, unfiltered, lifecycle/content actions (and
   * non-idempotent reactive effects) echo between tabs and corrupt state.
   */
  stateSync?: boolean | { predicate?: (action: ReduxAction) => boolean };
}

// NOTE: a true local-only mode (no fetch_blob server) is not yet supported.
// It needs a real localStorage RESTORE path (there is only a write path today;
// see loadState, commented out below), plus local save-status handling
// (markSaved after the local write instead of waiting for a server ack that
// never comes). Until that feature lands, reduxLogger expects a load cycle
// (fetch_blob) to flip IS_LOADED.

// =============================================================================
// Module state
// =============================================================================

const EMIT_EVENT = 'EMIT_EVENT';
const EMIT_LOCKFIELDS = 'EMIT_LOCKFIELDS';
const EMIT_SET_STATE = 'SET_STATE';

let IS_LOADED = false;
let _options: ReduxLoggerOptions = {};

// Cross-tab state sync gating (see ReduxLoggerOptions.stateSync).
// The middleware's predicate reads _stateSyncEnabled at dispatch time, so
// toggling this after the store is created takes effect immediately. The
// incoming-message listener is attached lazily and only when enabled, so a
// disabled store neither sends nor receives. Default off (opt-in).
let _stateSyncEnabled = false;
let _stateSyncListenerAttached = false;
// Optional app-supplied filter for which actions to broadcast (see
// ReduxLoggerOptions.stateSync). null = broadcast all (minus lifecycle).
let _stateSyncPredicate: ((action: ReduxAction) => boolean) | null = null;

// Whether to broadcast a given action to other tabs. lo_event NEVER broadcasts
// its own lifecycle actions: SET_STATE (full-state replace from blob restore)
// and LOCKFIELDS would clobber/duplicate state across tabs. The app predicate
// filters the rest (e.g. dropping per-tab content-load events).
function shouldBroadcast (action: ReduxAction): boolean {
  if (!_stateSyncEnabled) return false;
  if (action.redux_type === EMIT_SET_STATE || action.redux_type === EMIT_LOCKFIELDS) return false;
  return _stateSyncPredicate ? _stateSyncPredicate(action) : true;
}

function ensureStateSyncListener () {
  // Browser-only: initMessageListener uses the BroadcastChannel, which is
  // not available (and not meaningful) server-side.
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  if (_stateSyncEnabled && !_stateSyncListenerAttached) {
    initMessageListener(store);
    _stateSyncListenerAttached = true;
  }
}

// TODO: Import debugLog and use those functions.
const DEBUG = false;

function debug_log (...args: unknown[]) {
  if (DEBUG) {
    console.log(...args);
  }
}

// =============================================================================
// Persistence status — plain external store (NOT in Redux)
//
// These are metadata about the save machinery, not application state.
// Keeping them outside Redux avoids cross-tab dispatch loops via
// redux-state-sync and keeps the store subscription read-only.
//
// React consumers use useSyncExternalStore via the hooks in hooks.ts.
// =============================================================================

let _saveStatus: SaveStatus = 'saved';
let _connected: boolean | null = null;  // null = no websocket configured
let _fatal: FatalState = null;          // sticky fatal condition (e.g. ACK_REQUIRED)

// Monotonic token: incremented on each save_blob dispatch, compared against
// the token echoed back in save_blob_ack. Status is 'saved' only when the
// server has confirmed the most recent save.
let _saveToken = 0;
let _ackedToken = 0;

const _statusListeners = new Set<() => void>();

function notifyStatusListeners () {
  _statusListeners.forEach(fn => fn());
}

function markModified () {
  if (_saveStatus !== 'modified') {
    _saveStatus = 'modified';
    notifyStatusListeners();
  }
}

function markSaved () {
  if (_saveStatus !== 'saved') {
    _saveStatus = 'saved';
    notifyStatusListeners();
  }
}

// The server reported a save failure. Distinct from 'modified' so the UI can
// tell "still saving" from "save failed". A subsequent change re-enters
// 'modified' (markModified), and the next successful ack clears it to 'saved'.
function markError () {
  if (_saveStatus !== 'error') {
    _saveStatus = 'error';
    notifyStatusListeners();
  }
}

function setConnected (value: boolean) {
  if (_connected !== value) {
    _connected = value;
    notifyStatusListeners();
  }
}

// Sticky: set on a fatal condition, cleared (null) when the logger recovers.
// Keyed by code so a repeated dispatch of the same fatal doesn't churn listeners.
function setFatal (value: FatalState) {
  if ((_fatal?.code ?? null) !== (value?.code ?? null)) {
    _fatal = value;
    notifyStatusListeners();
  }
}

/** Subscribe to persistence status changes (save status, connected, loaded). */
export function subscribeStatus (listener: () => void): () => void {
  _statusListeners.add(listener);
  return () => { _statusListeners.delete(listener); };
}

/** Snapshot of save status for useSyncExternalStore. */
export function getSaveStatus (): SaveStatus { return _saveStatus; }

/** Snapshot of connection status. null = no websocket, true/false = connected/disconnected. */
export function getConnected (): boolean | null { return _connected; }

/** Snapshot of loaded status (fetch_blob resolved or no persistence). */
export function getLoaded (): boolean { return IS_LOADED; }

/** Snapshot of the sticky fatal condition (null = none). */
export function getFatal (): FatalState { return _fatal; }

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Update the redux logger's state with `data`.
 * This is fired when consuming a custom `fetch_blob` event.
 */
export function handleLoadState (data: unknown) {
  IS_LOADED = true;
  const state = store.getState() as JSONObject;
  if (data) {
    const blob = _options.deserializeOnLoad
      ? _options.deserializeOnLoad(data as JSONObject, state)
      : data as JSONObject;
    setState({ ...state, ...blob });
  } else {
    debug_log('No data provided while handling state from server, continuing.');
  }
  // After loading, state matches the server — reset tokens and mark saved.
  // markSaved() AFTER setState so the subscription's markModified() fires
  // first (synchronously from the dispatch), then we correct it here.
  _ackedToken = _saveToken;
  markSaved();
  notifyStatusListeners();  // loaded changed
}

async function saveStateToLocalStorage (state: JSONObject) {
  if (!IS_LOADED) {
    debug_log('Not saving store locally because IS_LOADED is set to false.');
    return;
  }

  try {
    const KEY = (state?.settings as JSONObject)?.reduxID as string || 'redux';
    const toSave = _options.serializeForSave ? _options.serializeForSave(state) : state;
    const serializedState = JSON.stringify(toSave);
    localStorage.setItem(KEY, serializedState);
  } catch (e) {
    // Ignore
  }
}

/**
 * Dispatch a `save_blob` event on the redux logger.
 */
async function saveStateToServer (state: JSONObject) {
  if (!IS_LOADED) {
    debug_log('Not saving store on the server because IS_LOADED is set to false.');
    return;
  }

  try {
    const toSave = _options.serializeForSave ? _options.serializeForSave(state) : state;
    _saveToken++;
    util.dispatchCustomEvent('save_blob', { detail: { blob: toSave, token: _saveToken } });
    // Don't markSaved() here — wait for save_blob_ack from the server.
  } catch (e) {
    debug_log('Error in dispatch', { e });
  }
}

/**
 * Immediately flush any pending debounced saves.
 * Available for programmatic use (e.g. beforeunload handlers).
 */
export function saveNow () {
  debouncedSaveStateToLocalStorage.flush();
  debouncedSaveStateToServer.flush();
}

// =============================================================================
// Action creators
// =============================================================================

// Action creator function This is a little bit messy, since we
// duplicate type from the payload. It's not clear if this is a good
// idea. We used to have `type` be set to the current contents of
// `redux_type`. However, for debugging / logging tools
// (e.g. redux-dev-tools), it was convenient to have this match up to
// the internal event type.
const emitEvent = (event: string): ReduxAction => {
  return {
    redux_type: EMIT_EVENT,
    type: JSON.parse(event).event,
    payload: event
  };
};

// Action creator function
const emitSetField = (setField: string): ReduxAction => {
  return {
    redux_type: EMIT_LOCKFIELDS,
    type: EMIT_LOCKFIELDS,
    payload: setField
  };
};

const emitSetState = (state: JSONObject): ReduxAction => {
  return {
    redux_type: EMIT_SET_STATE,
    type: EMIT_SET_STATE,
    payload: state
  };
};

// =============================================================================
// Reducers
// =============================================================================

function store_last_event_reducer (state: JSONObject = {}, action: JSONObject): JSONObject {
  const a = action as ReduxAction;
  return { ...state, event: a.payload };
}

function lock_fields_reducer (state: JSONObject = {}, action: JSONObject): JSONObject {
  const a = action as ReduxAction;
  const payload = JSON.parse(a.payload as string);
  return {
    ...state,
    lock_fields: {
      ...payload,
      fields: {
        ...((state.lock_fields as JSONObject)?.fields as JSONObject || {}),
        ...payload.fields
      }
    }
  };
}

/*
 * This is our most common reducer. It simply updates a component's
 * state with the dictionary of an action.
 *
 * In the future, we plan to add various sorts of event validation and
 * potentially preprocessing. We would like things like:
 *
 *    updateComponentStateReducer({valid_fields: ['response'})
 *
 * Ergo, the two-level call with the destruct.
 */
export const updateComponentStateReducer = ({}: Record<string, unknown>): ReducerFn => (state: JSONObject = {}, action: JSONObject): JSONObject => {
  const { id, ...rest } = action;
  const component_state = (state.component_state || {}) as { [key: string]: JSONObject };
  const new_state: JSONObject = {
    ...state,
    component_state: {
      ...component_state,
      [id as string]: {...component_state?.[id as string], ...rest}
    }
  };

  debug_log(
    "==REGISTER REDUCER==\n",
    "Reducer action:", action, "\n",
    "Response reducer called\n",
    "Old state", state, "\n",
    "Action", action, "\n",
    "New state", new_state
  );

  return new_state;
}

function set_state_reducer (state: JSONObject = {}, action: JSONObject): JSONObject {
  return (action as ReduxAction).payload as JSONObject;
}

const BASE_REDUCERS: Record<string, ReducerFn[]> = {
  [EMIT_EVENT]: [store_last_event_reducer],
  [EMIT_LOCKFIELDS]: [lock_fields_reducer],
  [EMIT_SET_STATE]: [set_state_reducer]
}

const APPLICATION_REDUCERS: Record<string, ReducerFn[]> = {};

export const registerReducer = <S = JSONObject, A = JSONObject>(
  keys: string | string[],
  reducer: (state: S, action: A) => S
) => {
  const reducerKeys = Array.isArray(keys) ? keys : [keys];

  reducerKeys.forEach(key => {
    debug_log('registering key: ' + key);
    if (!APPLICATION_REDUCERS[key]) {
      APPLICATION_REDUCERS[key] = [];
    }
    // lo_event calls application reducers with generic JSONObject state.
    // The generic signature lets consumers keep their typed reducers;
    // the cast here is the single boundary between typed app state and
    // lo_event's internal representation.
    APPLICATION_REDUCERS[key].push(reducer as unknown as ReducerFn);
  });
  return reducer;
};

// Reducer function
const reducer = (state: JSONObject = {}, action: ReduxAction): JSONObject => {
  let payload;

  debug_log('Reducing ', action, ' on ', state);
  state = BASE_REDUCERS[action.redux_type]
    ? composeReducers(...BASE_REDUCERS[action.redux_type])(state, action)
    : state;

  if (action.redux_type === EMIT_EVENT) {
    payload = JSON.parse(action.payload as string);
    if (action.type === 'save_setting') {
      return {
        ...state,
        settings: {
          ...(state.settings as JSONObject),
          payload
        }
      };
    }
    debug_log(Object.keys(payload));

    if (APPLICATION_REDUCERS[payload.event]) {
      state = {
        ...state,
        application_state: composeReducers(...APPLICATION_REDUCERS[payload.event])(
          (state.application_state || {}) as JSONObject, payload
        )
      };
    }
  }

  return state;
};

// =============================================================================
// Store
// =============================================================================

const eventQueue: unknown[] = [];
const composeEnhancers = (typeof window !== 'undefined' && window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__) || redux.compose;

// This should just be redux.applyMiddleware(thunk))
// There is a bug in our version of redux-thunk where, in node, this must be thunk.default.
//
// This shows up as an error in the test case. If the error goes away, we should switch this
// back to thunk.
// const presistedState = loadState();

// Cross-tab sync is a browser concept and createStateSyncMiddleware()
// constructs a BroadcastChannel eagerly. In Node (server-side, SSR) that
// hits broadcast-channel's filesystem fallback and throws, so we only add
// the middleware in a browser. Note: a config object MUST include `channel`
// — redux-state-sync replaces its whole defaultConfig with the passed config,
// so omitting it yields `new BroadcastChannel(undefined)` and crashes.
const _baseMiddleware: redux.Middleware[] = [((thunk as any).default || thunk) as redux.Middleware];
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  // predicate gates outgoing broadcasts; the incoming listener is attached
  // separately in ensureStateSyncListener(). Both respect _stateSyncEnabled.
  _baseMiddleware.push(createStateSyncMiddleware({
    channel: 'redux_state_sync',
    predicate: (action: any) => shouldBroadcast(action as ReduxAction),
  }) as redux.Middleware);
}

export let store: redux.Store<Record<string, unknown>> = redux.createStore(
  reducer as unknown as redux.Reducer<Record<string, unknown>>,
  { event: null } as unknown as JSONObject, // Base state
  composeEnhancers(redux.applyMiddleware(..._baseMiddleware))
);

// initMessageListener is attached lazily by reduxLogger() when stateSync is
// enabled — see ensureStateSyncListener(). Attaching it unconditionally here
// would make a disabled store still receive (and respond to) broadcasts.

let promise: (Promise<unknown> & { resolve?: (value: unknown) => void }) | null = null;
let previousEventString: string | null = null;
let lockFields: Record<string, unknown> | null = null;
let eventSubscribers: Array<(event: unknown) => void> = [];

/*
  Compose reducers takes a dynamic number of reducers as arguments and
  returns a new reducer function. This applies each reducer to the
  state in the order they are provided, ultimately returning the
  final state after all reducers have been applied.

  Example usage:
  ```
  const rootReducer = composeReducers(reducer1, reducer2, reducer3);
  const finalState = rootReducer(initialState, { redux_type: 'SOME_ACTION' });
  ```
*/
function composeReducers(...reducers: ReducerFn[]): ReducerFn {
  return (state, action) => reducers.reduce(
    (currentState, reducer) => reducer(currentState, action),
    state
  );
}

export function setState(state: JSONObject) {
  debug_log('Set state called');
  if (Object.keys(state).length === 0) {
    debug_log('setState called with empty object — ignoring');
    return;
  }
  store.dispatch(emitSetState(state) as unknown as redux.Action);
}

const debouncedSaveStateToLocalStorage = debounce((state: JSONObject) => {
  saveStateToLocalStorage(state);
}, 1000);

const debouncedSaveStateToServer = debounce((state: JSONObject) => {
  saveStateToServer(state);
}, 1000);

// =============================================================================
// Store initialization & subscription
// =============================================================================

function initializeStore () {
  // The subscription is read-only — it never dispatches to the store.
  // Save status lives in a plain module-level variable (see above),
  // avoiding cross-tab loops via redux-state-sync.
  store.subscribe(() => {
    const state = store.getState() as JSONObject;

    markModified();
    debouncedSaveStateToLocalStorage(state);
    debouncedSaveStateToServer(state);

    if (state.lock_fields) {
      lockFields = (state.lock_fields as JSONObject).fields as JSONObject;
    }
    if (!state.event) return;
    debug_log('Received event:', state.event);
    const eventString = state.event as string;
    if (eventString === previousEventString) {
      return;
    }
    previousEventString = eventString;
    const event = JSON.parse(eventString);

    if (promise) {
      promise.resolve!(event);
      promise = null;
    } else {
      // This is only useful for awaitEvent below. Otherwise, events build up. Having
      // this event queue may be good or a memory leak. We should figure out whether
      // to have this behind a flag later.
      eventQueue.push(event);
    }
    for (const subscriber of eventSubscribers) {
      subscriber(event);
    }
  });

  // Flush any pending saves when the page is about to close.
  // The IndexedDB-backed queue in websocketLogger survives page close,
  // so even if the browser terminates before the WebSocket send completes,
  // the blob is persisted locally and transmitted on the next page load.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      saveNow();
    });
  }
}

// =============================================================================
// Logger factory
// =============================================================================

export function reduxLogger (subscribers?: Array<(event: unknown) => void>, options: ReduxLoggerOptions = {}): Logger {
  if (subscribers != null) {
    eventSubscribers = subscribers;
  }
  _options = options;

  // Opt-in (default false). `true` or a predicate enables it; a predicate also
  // filters which actions broadcast (see shouldBroadcast). When enabled, attach
  // the incoming listener (once); when disabled, the predicate stops all
  // outgoing broadcasts and we never attach the listener, so nothing is received.
  _stateSyncEnabled = options.stateSync != null && options.stateSync !== false;
  _stateSyncPredicate = (typeof options.stateSync === 'object' && options.stateSync !== null)
    ? (options.stateSync.predicate ?? null)
    : null;
  ensureStateSyncListener();

  const logEvent: Logger = function (event: string) {
    store.dispatch(emitEvent(event) as unknown as redux.Action);
  };
  logEvent.lo_name = 'Redux Logger'; // A human-friendly name for the logger
  logEvent.lo_id = 'redux_logger';   // A machine-frienly name for the logger

  logEvent.init = async function () {
    initializeStore();
  };

  logEvent.setField = function (event: string) {
    store.dispatch(emitSetField(event) as unknown as redux.Action);
  };

  logEvent.getLockFields = function () { return lockFields; };

  return logEvent;
}

// This is a convenience function which lets us simply await events.
//
// Note that this should not be used in threaded code or in multiple
// places at the same time in async code. It's a convenience function
// for _simple_ code.
export const awaitEvent = (): unknown | Promise<unknown> => {
  if (eventQueue.length > 0) {
    return eventQueue.shift(); // Return the first event in the queue
  }
  if (promise) {
    throw new Error('Only one call to awaitEvent is allowed at a time');
  }

  // Create a new promise
  let resolvePromise: (value: unknown) => void;

  promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  promise.resolve = resolvePromise!;
  return promise;
};

/**
 * Consume an `auth` DOM CustomEvent (dispatched by websocketLogger when the
 * server echoes `{status:'auth', ...}`) and land the resolved user identity
 * in Redux as `state.application_state.system.currentUser`.
 *
 * We dispatch an `EMIT_EVENT` with event type `SET_CURRENT_USER`, scope
 * `system`, and the full user object. Applications that register a field
 * for `currentUser` will pick this up via their normal field-reducer wiring.
 * Applications that don't register a matching reducer will simply no-op,
 * which is the correct default.
 *
 * No IS_LOADED gating: auth arrives on every connection, even before the
 * first fetch_blob round-trip, and we want currentUser available as soon as
 * it's known so downstream code (e.g., fetch_blob gating) can proceed.
 */
export function handleAuth (user: unknown) {
  if (!user || typeof user !== 'object' || !('user_id' in user) || !user.user_id) return;
  store.dispatch(emitEvent(JSON.stringify({
    event: 'SET_CURRENT_USER',
    currentUser: user,
    scope: 'system'
  })) as unknown as redux.Action);
}

// =============================================================================
// CustomEvent listeners
// =============================================================================

util.consumeCustomEvent('fetch_blob', handleLoadState);
util.consumeCustomEvent('auth', handleAuth);

// Connection status from websocketLogger
util.consumeCustomEvent('lo_connection_status', (data: unknown) => {
  const { connected } = data as { connected: boolean };
  setConnected(connected);
});

// Fatal conditions from a logger (websocketLogger's ACK_REQUIRED). detail is
// { code, message } to set, or null to clear on recovery. Surfaced reactively
// via useFatal() — do NOT consume this event in app code (bypasses React).
util.consumeCustomEvent('lo_fatal', (data: unknown) => {
  setFatal((data as FatalState) ?? null);
});

// Server acknowledgment of a save_blob write.
// Only mark saved if this ack is for the most recent save — stale acks
// (from earlier saves) are ignored because a newer save is still pending.
util.consumeCustomEvent('save_blob_ack', (data: unknown) => {
  const { token } = data as { token: number };
  if (token > _ackedToken) {
    _ackedToken = token;
  }
  if (_ackedToken >= _saveToken) {
    markSaved();
  }
});

// Server reported a save_blob write failure. Don't advance _ackedToken — the
// blob did not persist — and surface the failure so the UI isn't stuck looking
// like a save is merely in progress.
util.consumeCustomEvent('save_blob_nack', () => {
  markError();
});

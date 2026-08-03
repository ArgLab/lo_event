/**
 * React hooks for lo_event persistence status.
 *
 * These use useSyncExternalStore against a plain module-level store
 * in reduxLogger (NOT Redux state — see reduxLogger.ts for rationale).
 *
 * Import from 'lo_event/hooks' — this entry point depends on React.
 */
import { useSyncExternalStore } from 'react';
import {
  subscribeStatus,
  getSaveStatus,
  getConnected,
  getLoaded,
} from './reduxLogger.js';

export type { SaveStatus } from './reduxLogger.js';

/**
 * Whether the current state has been persisted.
 *
 *   'saved'    — all changes have been sent to the server / localStorage
 *   'modified' — changes exist, debounce timer running
 */
export function useSaved() {
  return useSyncExternalStore(subscribeStatus, getSaveStatus, () => 'saved' as const);
}

/**
 * WebSocket connection status.
 *
 *   true  — connected
 *   false — disconnected (show offline indicator)
 *   null  — no WebSocket configured (don't show indicator)
 */
export function useConnected() {
  return useSyncExternalStore(subscribeStatus, getConnected, () => null);
}

/**
 * Whether initialization is complete (a fetch_blob load cycle has resolved).
 *
 * Use this to gate the UI — show a loading screen until true. Note: a store
 * with no fetch_blob server never resolves loaded (local-only mode is not yet
 * supported — see reduxLogger).
 */
export function useLoaded() {
  return useSyncExternalStore(subscribeStatus, getLoaded, () => false);
}

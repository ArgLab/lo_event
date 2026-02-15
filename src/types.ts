/**
 * Shared type definitions for lo-event.
 *
 * Types are used for major interfaces and contracts between components.
 * We avoid exhaustive internal typing — focus is on boundaries.
 */

/**
 * Recursive type for JSON-serializable values.
 */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/**
 * A JSON object — the subset of JSONValue that's always an object.
 * Redux state and actions are always objects, never bare primitives.
 */
export type JSONObject = { [key: string]: JSONValue };

/**
 * Redux reducer function. Takes a JSON object (state) and a JSON
 * object (action), returns a JSON object. Application reducers
 * narrow internally to their specific state shapes.
 */
export type ReducerFn = (state: JSONObject, action: JSONObject) => JSONObject;

/**
 * A Logger is a callable that receives JSON-encoded event strings.
 * It may optionally have init(), setField(), and metadata properties.
 */
export interface Logger {
  (event: string): void;
  init?: () => Promise<void> | void;
  setField?: (data: string) => void;
  lo_name?: string;
  lo_id?: string;
  getLockFields?: () => Record<string, unknown> | null;
}

/**
 * Metadata task descriptor — used in compileMetadata.
 * Each task has a name and an async function that produces a result.
 */
export interface MetadataTask {
  name: string;
  func: () => unknown | Promise<unknown>;
}

/**
 * Queue backend interface — the contract both memoryQueue and
 * indexeddbQueue implement.
 */
export interface QueueBackend {
  enqueue(item: unknown): void;
  dequeue(): unknown | Promise<unknown>;
}

/**
 * Configuration for the dequeue loop in queue.ts.
 */
export interface DequeueLoopConfig {
  initialize?: () => Promise<boolean> | boolean;
  shouldDequeue?: () => Promise<boolean> | boolean;
  onDequeue?: (item: unknown) => Promise<void> | void;
  onError?: (message: string, error: unknown) => void;
}

/**
 * Storage interface — mirrors chrome.storage.sync API (callback-based).
 */
export interface StorageBackend {
  get(keys: string | string[] | null, callback?: (result: Record<string, unknown>) => void): void;
  set(items: Record<string, unknown>, callback?: () => void): void;
}

/**
 * Init options for lo_event.init().
 */
export interface InitOptions {
  debugLevel?: string;
  debugDest?: unknown[];
  useDisabler?: boolean;
  queueType?: string;
  sendBrowserInfo?: boolean;
  verboseEvents?: boolean;
  metadata?: MetadataTask[];
}

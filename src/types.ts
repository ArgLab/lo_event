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
  /** Enqueued-but-unacked count (ack-aware loggers, e.g. websocketLogger). */
  unackedCount?: () => Promise<number> | number;
  /** Console debug handles for this logger's durable queue, if it has one. */
  queueDebug?: QueueDebug;
  /**
   * Called by lo_event.init() with the application's identity, before any
   * event flows. A durable logger uses `source` to namespace its outbox: the
   * store is shared by everything on the origin that names it, so two apps
   * that share an origin must not share one (§2). Loggers are constructed
   * before init() runs, which is why this is a hook rather than a constructor
   * argument.
   */
  configure?: (identity: { source: string; version: string }) => void;
  /** Ask (or re-ask) the server for the state snapshot (§6). */
  requestState?: () => void;
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
 * A queued item paired with its durable sequence number, handed out by
 * leaseNext(). The seq is assigned at enqueue time, is monotonic per queue,
 * and survives reloads (IndexedDB autoIncrement id; a persisted counter in
 * memory). It is what the ack protocol confirms — see confirm().
 */
export interface LeasedItem {
  seq: number;
  item: unknown;
}

/**
 * Queue backend interface — the contract both memoryQueue and
 * indexeddbQueue implement.
 *
 * Two dequeue disciplines coexist:
 *   - dequeue():   destructive take (delete-on-read). Used by the front-desk
 *                  loop and simple consumers that don't need delivery proof.
 *   - leaseNext()/confirm()/rewind(): non-destructive lease. An item stays in
 *                  durable storage until confirm() acks it; rewind() re-hands
 *                  everything unconfirmed (resend on reconnect). This is the
 *                  ack protocol's backbone — nothing is deleted until the
 *                  recipient signs for it.
 * A given Queue instance uses ONE discipline; mixing them on one instance is
 * unsupported.
 */
/** Console-facing handles for a durable queue (see loEvent.queueDebug). */
export interface QueueDebug {
  count(): Promise<number> | number;
  inspect(limit?: number): Promise<unknown[]>;
  clear(): void;
}

export interface QueueBackend {
  enqueue(item: unknown): void;
  /** Destructive take (delete-on-read). Optional, and deliberately so: only
   *  the in-memory backend implements it, because the only consumer is
   *  loEvent's front desk — a hand-off buffer, not a store. The durable outbox
   *  has exactly one read discipline, the lease, so an event can never be
   *  deleted merely by being read (§5). */
  dequeue?(): unknown | Promise<unknown>;
  /** Next un-leased stored item (lowest seq), WITHOUT deleting it. Parks
   *  until an item is available. Advances an in-memory lease cursor. */
  leaseNext(): Promise<LeasedItem>;
  /** Delete EXACTLY the listed stored seqs.
   *
   *  Deliberately not a range delete. The store is shared by every tab in the
   *  browser (that is what gives tab-close recovery), while each tab acks over
   *  its OWN socket. A cumulative range delete therefore let one tab's ack
   *  delete another tab's records — including records that had been enqueued
   *  but never sent by anyone, which is data loss, not a duplicate. A caller
   *  passes only the seqs it sent and saw acked on its own connection. */
  confirm(seqs: number[]): void;
  /** Reset the lease cursor so leaseNext() re-hands all unconfirmed items
   *  from the lowest stored seq (used on reconnect to resend). */
  rewind(): void;
  /** Count of stored (enqueued, not yet confirmed) items. */
  unconfirmedCount(): Promise<number> | number;
  /** Highest stored seq, or null when the store is empty. Captured once per
   *  connection (after rewind) as the snapshot barrier's watermark: everything
   *  at or below it is "the backlog this connection started with". */
  maxSeq(): Promise<number | null>;
  /** Stored records with seq at or below `seq` that THIS instance has not yet
   *  leased (seq > lease cursor). This is the barrier question itself, asked
   *  of the queue because only the queue knows: on a shared store, another
   *  tab can send-and-delete records this instance was never going to see, so
   *  no captured count or send tally can answer it. Zero = barrier clear —
   *  everything below the watermark was either sent by this connection or
   *  deleted by an ack (meaning the server already has it). */
  unleasedAtOrBelow(seq: number): Promise<number>;
  /** DEBUG: the first `limit` stored items, without leasing or deleting.
   *  For answering "what is stuck in there, and why?" from a console. */
  inspect(limit: number): Promise<unknown[]>;
  /** DEBUG / RECOVERY: drop everything, unsent included. Destructive and
   *  deliberately so — the use case is a queue holding junk (e.g. frames a
   *  broken build could never get acked) that would otherwise be resent on
   *  every reconnect forever. */
  clear(): void;
}

/**
 * Configuration for the front desk's destructive loop in queue.ts.
 *
 * There is no lease variant here: the outbox's lease loop lives in
 * websocketLogger, next to the socket it sends on, because deciding what to do
 * with a leased record is a protocol decision and this file is plumbing (§9).
 */
export interface DequeueLoopConfig {
  initialize?: () => Promise<boolean> | boolean;
  /** A false answer terminates the loop permanently, so only wire this to a
   *  condition that means "never again". In particular NOT the disabler: that
   *  would gate events before the durable write (§5). */
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

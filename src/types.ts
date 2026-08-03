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
  /** Called once by lo_event.init() before init(), with application context
   *  (the app's `source`). Loggers that namespace durable stores per app use
   *  it to derive a default namespace. */
  configure?: (context: { source: string }) => void;
  lo_name?: string;
  lo_id?: string;
  getLockFields?: () => Record<string, unknown> | null;
  /** Enqueued-but-unacked count (ack-aware loggers, e.g. websocketLogger). */
  unackedCount?: () => Promise<number> | number;
  /** Ask (or re-ask) the server for the state snapshot (§6). Re-arms the
   *  ask-once latch; asking twice is free, never asking again is a hang. */
  requestState?: () => void;
  /** Console debug handles for this logger's durable queue, if it has one. */
  queueDebug?: QueueDebug;
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
  /** Destructive take (delete-on-read). Only the front-desk buffer uses this
   *  discipline; the durable outbox never does, so the IndexedDB backend does
   *  not implement it (§5: one durable store, one read discipline). */
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
 * Configuration for the front desk's destructive dequeue loop in queue.ts.
 * (The durable outbox is driven by websocketLogger's lease loop instead —
 * the two disciplines never share an instance.)
 */
export interface DequeueLoopConfig {
  initialize?: () => Promise<boolean> | boolean;
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
 *
 * `queueType` is gone: the front desk is IN_MEMORY unconditionally (§5 — one
 * durable store, the outbox; a second disk queue on the delivery path added a
 * delete-on-read hop without adding durability). The outbox backend is a
 * websocketLogger option.
 */
export interface InitOptions {
  debugLevel?: string;
  debugDest?: unknown[];
  useDisabler?: boolean;
  sendBrowserInfo?: boolean;
  verboseEvents?: boolean;
  metadata?: MetadataTask[];
}

/** Options for the delivery engine (protocol.ts). */
export interface DeliveryOptions {
  /** false (default) = durable: confirm on server ack.
   *  true = send-and-forget: confirm on a verified-OPEN send (§5). */
  autoack?: boolean;
}

/**
 * A decision returned by the delivery engine (protocol.ts) for the adapter
 * (websocketLogger.ts) to perform. Decisions carry everything the adapter
 * needs, so the adapter stays a pure executor (§9).
 */
export type Decision =
  | { do: 'rewind' }
  | { do: 'measureWatermark' }
  | { do: 'probeQueue'; watermark: number }
  | { do: 'sendFrame'; frame: string; seq: number }
  | { do: 'confirmIds'; ids: number[] }
  | { do: 'askForState'; frame: string }
  | { do: 'pauseSending' }
  | { do: 'resumeSending' }
  | { do: 'clearQueue' }
  | { do: 'log'; level: 'info' | 'error'; message: string };

/*
 * The durable IndexedDB queue backend — the outbox (§2).
 *
 * The store is shared across contexts in the same origin and storage
 * partition. That is the whole tab-close recovery story, and it is why every
 * deletion is by explicit id (L1) and why a parked consumer is woken by
 * re-running its scan, never by being handed the arriving item (§3).
 *
 * Design notes:
 *   - Writes are serialized through one promise chain, so a read issued after
 *     enqueue/confirm observes that write. Reads use ordinary short
 *     transactions and settle on the TRANSACTION (oncomplete/onerror/onabort),
 *     never by counting request callbacks (L15).
 *   - The lease cursor (`leasedThrough`) is per-instance and in-memory, as the
 *     spec requires (§3). Because IndexedDB scans are asynchronous, a rewind()
 *     can land between a scan starting and resolving; an epoch counter makes
 *     the resolving scan notice and re-run rather than overwrite the rewound
 *     cursor — without the guard, the backlog below the old cursor would be
 *     silently skipped and the flush barrier could clear with backlog unsent
 *     (a round-1 regression of the §7 duplicated-prose race).
 *   - IndexedDB has no cross-context change notification, so a parked lease
 *     re-scans on a slow timer: a record enqueued by another tab that then
 *     dies is discovered within ~300ms rather than on the next reconnect.
 *   - There is no dequeue(): the durable store has exactly one read
 *     discipline, the lease (§5). The front desk is in-memory.
 *   - autoIncrement keys are never reused, and clear() does not reset the key
 *     generator — an explicit backend invariant the ack protocol leans on
 *     (L4), pinned in the queue contract tests.
 */
import * as debug from './debugLog.js';
import type { LeasedItem } from './types.js';

interface StoredRecord {
  id?: number;
  payload: unknown;
}

/** How often a parked lease re-scans for another context's enqueues. */
const PARKED_RESCAN_MS = 300;

function transactionDone (transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class Queue {
  private readonly ready: Promise<IDBDatabase>;
  private writes: Promise<void> = Promise.resolve();
  private leasedThrough = 0;
  /** Bumped by rewind(); scans capture it at start and re-run if it moved. */
  private epoch = 0;
  private parkedLease: ((value: LeasedItem | PromiseLike<LeasedItem>) => void) | null = null;
  private parkedLeaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor (private readonly queueName: string) {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available. Use QueueType.IN_MEMORY outside a browser.');
    }
    this.ready = this.open();
  }

  private open (): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.queueName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.queueName, { keyPath: 'id', autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`IndexedDB queue ${this.queueName} is blocked`));
    });
  }

  /** Serialize writes; keep the chain usable after a failure. Admission errors
   *  are logged loudly because the logger API is not yet awaitable (§11's
   *  admission-contract hole): fail loudly, never silently drop. */
  private scheduleWrite (write: () => Promise<void>): void {
    const operation = this.writes.then(write);
    this.writes = operation.catch(error => {
      debug.error(`IndexedDB queue ${this.queueName}: write failed — the event may not be durable`, error);
    });
  }

  enqueue (item: unknown): void {
    this.scheduleWrite(async () => {
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readwrite');
      transaction.objectStore(this.queueName).add({ payload: item } satisfies StoredRecord);
      await transactionDone(transaction);
      this.wakeLease();
    });
  }

  async leaseNext (): Promise<LeasedItem> {
    // Loop rather than assign-after-await: if a rewind lands while our scan is
    // in flight, the hit is stale (its lower bound was the pre-rewind cursor)
    // and we must scan again from the rewound cursor.
    while (true) {
      const epochAtScan = this.epoch;
      const lowerBound = this.leasedThrough;
      await this.writes;
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readonly');
      const request = transaction.objectStore(this.queueName)
        .openCursor(IDBKeyRange.lowerBound(lowerBound, true));
      const hit = await new Promise<LeasedItem | null>((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(null); return; }
          resolve({ seq: cursor.key as number, item: (cursor.value as StoredRecord).payload });
        };
        request.onerror = () => reject(request.error);
      });
      await transactionDone(transaction);
      if (epochAtScan !== this.epoch) continue;
      if (hit) {
        this.leasedThrough = hit.seq;
        return hit;
      }
      // Drained. Park until a local enqueue/rewind wakes us — or the rescan
      // timer notices another context's enqueue.
      return await new Promise<LeasedItem>(resolve => {
        this.parkedLease = resolve;
        this.parkedLeaseTimer = setTimeout(() => this.wakeLease(), PARKED_RESCAN_MS);
        (this.parkedLeaseTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      });
    }
  }

  /** Delete EXACTLY the listed ids (L1). Per-request onerror must
   *  preventDefault(): an unhandled request error aborts the transaction and
   *  rolls back sibling deletes — one bad delete would un-confirm a whole
   *  batch (L15). */
  confirm (seqs: number[]): void {
    if (!seqs.length) return;
    this.scheduleWrite(async () => {
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readwrite');
      const store = transaction.objectStore(this.queueName);
      for (const seq of new Set(seqs)) {
        const request = store.delete(seq);
        request.onerror = event => {
          event.preventDefault();
          debug.error(`IndexedDB queue ${this.queueName}: unable to confirm record ${seq}`, request.error);
        };
      }
      await transactionDone(transaction);
    });
  }

  rewind (): void {
    this.leasedThrough = 0;
    this.epoch++;
    this.wakeLease();
  }

  async unconfirmedCount (): Promise<number> {
    await this.writes;
    const db = await this.ready;
    const request = db.transaction(this.queueName, 'readonly')
      .objectStore(this.queueName).count();
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Highest stored id, or null when empty — the barrier watermark (§7). */
  async maxSeq (): Promise<number | null> {
    await this.writes;
    const db = await this.ready;
    const request = db.transaction(this.queueName, 'readonly')
      .objectStore(this.queueName).openCursor(null, 'prev');
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ? request.result.key as number : null);
      request.onerror = () => reject(request.error);
    });
  }

  /** Stored, unleased-by-me, at or below `seq` — the barrier question (§7).
   *  Epoch-checked like leaseNext: a count computed against a pre-rewind
   *  cursor would under-count and could clear the barrier with backlog
   *  unsent. */
  async unleasedAtOrBelow (seq: number): Promise<number> {
    while (true) {
      const epochAtScan = this.epoch;
      const lowerBound = this.leasedThrough;
      if (lowerBound >= seq) return 0;
      await this.writes;
      const db = await this.ready;
      const range = IDBKeyRange.bound(lowerBound, seq, true, false);
      const request = db.transaction(this.queueName, 'readonly')
        .objectStore(this.queueName).count(range);
      const count = await new Promise<number>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (epochAtScan === this.epoch) return count;
    }
  }

  async inspect (limit = 20): Promise<unknown[]> {
    await this.writes;
    const db = await this.ready;
    const request = db.transaction(this.queueName, 'readonly')
      .objectStore(this.queueName).getAll(undefined, limit);
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(
        (request.result as StoredRecord[]).map(r => ({ seq: r.id, payload: r.payload }))
      );
      request.onerror = () => reject(request.error);
    });
  }

  /** Drop everything, unsent included — junk stores and the permanent
   *  opt-out only (§5). autoIncrement's key generator survives clear(), so
   *  ids are still never reused (L4). */
  clear (): void {
    this.scheduleWrite(async () => {
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readwrite');
      transaction.objectStore(this.queueName).clear();
      await transactionDone(transaction);
      this.leasedThrough = 0;
    });
  }

  /** Wake a parked lease by re-running its scan (§3: the store is the only
   *  authority on "next" — the waker is never handed directly). */
  private wakeLease (): void {
    if (!this.parkedLease) return;
    if (this.parkedLeaseTimer !== null) clearTimeout(this.parkedLeaseTimer);
    this.parkedLeaseTimer = null;
    const resolve = this.parkedLease;
    this.parkedLease = null;
    resolve(this.leaseNext());
  }
}

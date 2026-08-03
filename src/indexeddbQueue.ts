import * as debug from './debugLog.js';
import type { LeasedItem } from './types.js';

interface StoredRecord {
  id?: number;
  payload: unknown;
}

const CROSS_CONTEXT_POLL_MS = 300;

function transactionDone (transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Durable, shared outbox. Records leave only through explicit-id confirm().
 * The lease cursor is per instance and deliberately ephemeral.
 */
export class Queue {
  private readonly ready: Promise<IDBDatabase>;
  private writes: Promise<void> = Promise.resolve();
  private leasedThrough = 0;
  /** Changes whenever rewind/clear invalidates an asynchronous cursor result. */
  private leaseEpoch = 0;
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

  /** Serialize local writes so a following local read observes them. A failed
   * write is loud and does not poison later operations. The public logger API
   * remains non-awaitable; surfacing admission failure is tracked in spec §11. */
  private scheduleWrite (write: () => Promise<void>): void {
    const operation = this.writes.then(write);
    this.writes = operation.catch(error => {
      debug.error(`IndexedDB queue ${this.queueName} write failed`, error);
    });
  }

  enqueue (item: unknown): void {
    this.scheduleWrite(async () => {
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readwrite');
      transaction.objectStore(this.queueName).add({ payload: item } satisfies StoredRecord);
      await transactionDone(transaction);
      this.wakeParkedLease();
    });
  }

  /** Scan using a captured cursor. The caller checks leaseEpoch before applying
   * the result, so a rewind during this transaction cannot be overwritten. */
  private async scan (after: number): Promise<LeasedItem | null> {
    await this.writes;
    const db = await this.ready;
    const transaction = db.transaction(this.queueName, 'readonly');
    const request = transaction.objectStore(this.queueName)
      .openCursor(IDBKeyRange.lowerBound(after, true));
    const leased = await new Promise<LeasedItem | null>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor
          ? { seq: cursor.key as number, item: (cursor.value as StoredRecord).payload }
          : null);
      };
      request.onerror = () => reject(request.error);
    });
    await transactionDone(transaction);
    return leased;
  }

  async leaseNext (): Promise<LeasedItem> {
    while (true) {
      const epoch = this.leaseEpoch;
      const leased = await this.scan(this.leasedThrough);
      if (epoch !== this.leaseEpoch) continue;
      if (leased) {
        this.leasedThrough = leased.seq;
        return leased;
      }

      return await new Promise(resolve => {
        this.parkedLease = resolve;
        this.scheduleParkedPoll();
      });
    }
  }

  confirm (seqs: number[]): void {
    if (!seqs.length) return;
    this.scheduleWrite(async () => {
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readwrite');
      const store = transaction.objectStore(this.queueName);
      for (const seq of new Set(seqs)) {
        const request = store.delete(seq);
        request.onerror = event => {
          // Prevent one request error from aborting and rolling back its sibling
          // deletes. Promise settlement belongs to the transaction (L15).
          event.preventDefault();
          debug.error(`Unable to confirm IndexedDB record ${seq}`, request.error);
        };
      }
      await transactionDone(transaction);
    });
  }

  rewind (): void {
    this.leaseEpoch++;
    this.leasedThrough = 0;
    this.wakeParkedLease();
  }

  async unconfirmedCount (): Promise<number> {
    await this.writes;
    const db = await this.ready;
    const transaction = db.transaction(this.queueName, 'readonly');
    const request = transaction.objectStore(this.queueName).count();
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async maxSeq (): Promise<number | null> {
    await this.writes;
    const db = await this.ready;
    const transaction = db.transaction(this.queueName, 'readonly');
    const request = transaction.objectStore(this.queueName).openCursor(null, 'prev');
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ? request.result.key as number : null);
      request.onerror = () => reject(request.error);
    });
  }

  async unleasedAtOrBelow (seq: number): Promise<number> {
    // A failed send can rewind while this asynchronous count is in flight.
    // Re-run against the new cursor rather than letting a pre-rewind zero clear
    // the snapshot barrier with unsent backlog still present.
    while (true) {
      const epoch = this.leaseEpoch;
      const leasedThrough = this.leasedThrough;
      await this.writes;
      if (epoch !== this.leaseEpoch) continue;
      if (leasedThrough >= seq) return 0;

      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readonly');
      const range = IDBKeyRange.bound(leasedThrough, seq, true, false);
      const request = transaction.objectStore(this.queueName).count(range);
      const count = await new Promise<number>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await transactionDone(transaction);
      if (epoch === this.leaseEpoch) return count;
    }
  }

  async inspect (limit = 20): Promise<unknown[]> {
    await this.writes;
    const db = await this.ready;
    const transaction = db.transaction(this.queueName, 'readonly');
    const request = transaction.objectStore(this.queueName).getAll(undefined, limit);
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  clear (): void {
    this.scheduleWrite(async () => {
      const db = await this.ready;
      const transaction = db.transaction(this.queueName, 'readwrite');
      transaction.objectStore(this.queueName).clear();
      await transactionDone(transaction);
      this.leaseEpoch++;
      this.leasedThrough = 0;
    });
  }

  /** IndexedDB has no portable cross-context change event. Every wake re-runs
   * the normal scan, and a slow poll discovers records committed by other tabs.
   * BroadcastChannel would only be an optimization; correctness stays here. */
  private scheduleParkedPoll (): void {
    if (!this.parkedLease || this.parkedLeaseTimer !== null) return;
    this.parkedLeaseTimer = setTimeout(() => this.wakeParkedLease(), CROSS_CONTEXT_POLL_MS);
    (this.parkedLeaseTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private wakeParkedLease (): void {
    if (!this.parkedLease) return;
    if (this.parkedLeaseTimer !== null) clearTimeout(this.parkedLeaseTimer);
    this.parkedLeaseTimer = null;
    const resolve = this.parkedLease;
    this.parkedLease = null;
    resolve(this.leaseNext());
  }
}

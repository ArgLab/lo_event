/**
 * The durable outbox backend: an IndexedDB object store with auto-incrementing
 * integer keys (the storage id).
 *
 * The store is shared across contexts in the same origin and storage partition.
 * That is deliberate, and it is the whole tab-close recovery story: a tab that
 * dies with unacked events leaves them where the next page load finds them. The
 * cost is that several contexts operate on one store concurrently, each with
 * its own socket and its own lease cursor — which is why deletion is by
 * explicit id (§3, L1), why a parked consumer is woken by re-running its scan
 * rather than by hand-off (§3), and why a parked consumer also re-scans on a
 * timer: IndexedDB has no cross-context change notification, so another tab's
 * write is otherwise invisible until this one happens to write something.
 *
 * Node has no IndexedDB and no supported persistent backend today: an earlier
 * sqlite3/indexeddb-js fallback lacked autoIncrement and returned keys out of
 * order, and its imports broke browser bundlers. Use QueueType.IN_MEMORY there,
 * and read §2 on what that gives up.
 */
import * as debug from './debugLog.js';
import type { LeasedItem } from './types.js';

/** A stored record: `{ id, payload }`, where id is the auto-increment key. */
interface StoredRecord { id: number; payload: unknown; }

/** How often a parked consumer re-scans for records another context wrote.
 *  Bounds the delay on "another tab enqueued and died"; runs only while
 *  parked, so an active sender never pays for it. */
const CROSS_CONTEXT_POLL_MS = 300;

export class Queue {
  private readonly queueName: string;
  private readonly ready: Promise<IDBDatabase>;

  /** Highest id handed out by leaseNext() in THIS instance. In-memory and
   *  per-instance: other contexts have their own cursors over the same store
   *  (§3). */
  private leasedThrough = 0;
  /**
   * Bumped by every rewind() and clear(). A lease scan reads the cursor,
   * awaits, and writes it back; a rewind landing in that window would be
   * overwritten by the write-back — the cursor would jump forward again and the
   * backlog would be skipped silently, with the barrier counting it as leased.
   * The scan compares epochs and re-runs instead.
   */
  private cursorEpoch = 0;
  /** Parked lease consumers, woken by a local write, a rewind, or the poll. */
  private waiters: Array<() => void> = [];

  constructor (queueName: string) {
    this.queueName = queueName;
    this.ready = this.open();
    // The rejection is reported by whichever operation awaits it; this keeps an
    // unused queue from raising an unhandled rejection.
    this.ready.catch(() => {});
  }

  async initialize () { await this.ready; }

  private open (): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this environment. Use QueueType.IN_MEMORY for Node.js.'));
        return;
      }
      const request = indexedDB.open(this.queueName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.queueName, { keyPath: 'id', autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        debug.error('IDBQUEUE ERROR: could not open database', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Run one transaction. `body` must issue its requests synchronously — an
   * IndexedDB transaction commits as soon as the task queue drains with no
   * request outstanding, so an `await` in the middle of one closes it.
   *
   * Operations queue behind `ready` in call order, and IndexedDB runs
   * transactions with overlapping scopes in creation order, so callers get the
   * ordering they wrote without any scheduler of our own.
   */
  private run<T> (
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, transaction: IDBTransaction, resolve: (value: T) => void, reject: (error: unknown) => void) => void
  ): Promise<T> {
    return this.ready.then(db => new Promise<T>((resolve, reject) => {
      const transaction = db.transaction([this.queueName], mode);
      body(transaction.objectStore(this.queueName), transaction, resolve, reject);
    }));
  }

  /** Append. Durability — and therefore §1's promise — begins when this
   *  transaction commits, which is also when a parked consumer may be woken. */
  enqueue (item: unknown) {
    this.run<void>('readwrite', (store, transaction, resolve, reject) => {
      const request = store.add({ payload: item } as unknown as StoredRecord);
      request.onerror = (event) => {
        debug.error('IDBQUEUE ERROR: could not add item to the queue', request.error);
        // An unhandled request error ABORTS the whole transaction (L15).
        event.preventDefault();
      };
      // Settle on the TRANSACTION, never by counting request callbacks (L15).
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }).then(
      () => this.wake(),
      (error) => debug.error('IDBQUEUE ERROR: enqueue failed; the event was NOT stored', error)
    );
  }

  /** The lowest stored id above `above`, without advancing anything. */
  private scan (above: number): Promise<LeasedItem | null> {
    return this.run<LeasedItem | null>('readonly', (store, _transaction, resolve, reject) => {
      const request = store.openCursor(IDBKeyRange.lowerBound(above, true));
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? { seq: cursor.key as number, item: (cursor.value as StoredRecord).payload } : null);
      };
      request.onerror = () => {
        debug.error('IDBQUEUE ERROR: could not read the queue cursor', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Lease the next record WITHOUT deleting it. The record stays on disk until
   * confirm(); a crash between here and the ack costs nothing but a resend.
   *
   * The loop is the whole concurrency story: every wake source (a local write,
   * a rewind, another context's write found by the poll) does nothing but
   * release the park, and the scan re-runs against the store. Nothing is ever
   * handed to a parked consumer directly (§3), and a rewind that lands mid-scan
   * invalidates the epoch and is re-read rather than overwritten.
   */
  async leaseNext (): Promise<LeasedItem> {
    while (true) {
      const epoch = this.cursorEpoch;
      const from = this.leasedThrough;
      const hit = await this.scan(from);

      if (epoch !== this.cursorEpoch) continue;   // a rewind landed; re-scan
      if (hit) {
        this.leasedThrough = hit.seq;
        return hit;
      }
      await this.parkUntilChanged();
    }
  }

  /** Park until something might have changed: a local commit, a rewind, or the
   *  cross-context poll firing. Never resolves *with* a record — the caller
   *  re-scans, because the store is the only authority on what is next. */
  private parkUntilChanged (): Promise<void> {
    return new Promise<void>(resolve => {
      let done = false;
      const wake = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(wake, CROSS_CONTEXT_POLL_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.push(wake);
    });
  }

  private wake () {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach(wake => wake());
  }

  /**
   * Delete EXACTLY the listed ids, in one transaction.
   *
   * Never a ranged delete. This store is shared, and each context acks over its
   * own socket, so `delete(id <= n)` deletes records belonging to other
   * contexts — including records nobody has sent yet. Duplicates are covered by
   * at-least-once delivery; deletions never were (L1).
   */
  confirm (seqs: number[]) {
    if (!seqs.length) return;
    this.run<void>('readwrite', (store, transaction, resolve, reject) => {
      for (const id of seqs) {
        const request = store.delete(id);
        request.onerror = (event) => {
          debug.error('IDBQUEUE ERROR: could not confirm (delete) a record', request.error);
          // Without preventDefault, one bad delete aborts the transaction and
          // rolls back its siblings — un-confirming a whole batch (L15).
          event.preventDefault();
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }).catch(error => debug.error('IDBQUEUE ERROR: confirm failed; records will resend', error));
  }

  /** Cursor to the bottom: everything still stored re-leases, and resends. */
  rewind () {
    this.leasedThrough = 0;
    this.cursorEpoch++;
    this.wake();
  }

  /** Count of stored (unconfirmed) records. */
  unconfirmedCount (): Promise<number> {
    return this.run<number>('readonly', (store, _transaction, resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Highest stored id — the flush barrier's watermark — or null if empty. */
  maxSeq (): Promise<number | null> {
    return this.run<number | null>('readonly', (store, _transaction, resolve, reject) => {
      // 'prev' walks from the highest key, so the first hit IS the max.
      const request = store.openCursor(null, 'prev');
      request.onsuccess = () => resolve(request.result ? (request.result.key as number) : null);
      request.onerror = () => reject(request.error);
    });
  }

  /** Stored records in (leasedThrough, seq] — the barrier question itself. Only
   *  the store can answer it: another context can send-and-delete records this
   *  instance never leases, so no local send tally would do (§7). */
  unleasedAtOrBelow (seq: number): Promise<number> {
    if (this.leasedThrough >= seq) return Promise.resolve(0);   // IDBKeyRange.bound needs a non-empty range
    return this.run<number>('readonly', (store, _transaction, resolve, reject) => {
      const request = store.count(IDBKeyRange.bound(this.leasedThrough, seq, true, false));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** DEBUG: the first `limit` stored records, without leasing or deleting —
   *  how an unackable frame gets diagnosed, since "the queue only grows" looks
   *  the same whether we are offline, unacked, or holding an unnameable frame. */
  inspect (limit = 20): Promise<unknown[]> {
    return this.run<unknown[]>('readonly', (store, _transaction, resolve, reject) => {
      const request = store.getAll(undefined, limit);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** DEBUG / RECOVERY: drop every stored record, unsent included (§10). The key
   *  generator is untouched, so ids are still never reused (L4). */
  clear () {
    this.run<void>('readwrite', (store, transaction, resolve, reject) => {
      store.clear();
      transaction.oncomplete = () => {
        this.leasedThrough = 0;
        this.cursorEpoch++;
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    }).catch(error => debug.error('IDBQUEUE ERROR: could not clear the queue', error));
  }
}

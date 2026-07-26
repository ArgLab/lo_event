/**
 * This files functions as a Queue using an indexeddb backend.
 *
 * If we are operating in a browser environment, we will use
 * the built-in indexeddb. In node environments, we will use
 * packages that mirror the functionality of indexeddb.
 *
 * Each item can be added to the end of the queue with `enqueue(item)`.
 * Items can be retrieved from the queue with `item = await dequeue()`.
 *
 * TODO
 * This code works in the browser, but breaks in a node environment.
 * autoIncrement is NOT supported when working in the node
 * environment. We will likely need to make some form of wrapper
 * to achieve this behavior for node.
 * See https://github.com/metagriffin/indexeddb-js/blob/master/src/indexeddb-js.js#L418C1-L418C53
 * NOTE: When we had our own counter for the id, we did notice that the node
 * environment (indexeddb-js or sqlite3) handled keys differently, thus
 * returning items out of order.
 *
 * TODO: This needs a very good code review. We weren't able to do
 * this before merge.
 */
import * as debug from './debugLog.js';
import * as util from './util.js';
import type { LeasedItem } from './types.js';

const ENQUEUE = 'enqueue';
const DEQUEUE = 'dequeue';
const LEASE = 'lease';
const CONFIRM = 'confirm';
const COUNT = 'count';

interface DBOperation {
  operation: string;
  payload?: { payload: unknown };
  seqs?: number[];
  resolve?: (value: unknown) => void;
  reject?: (reason?: unknown) => void;
}

export class Queue {
  private db: IDBDatabase | null;
  private dbOperationQueue: DBOperation[];
  private nextDBOperationPromise: ((value: DBOperation) => void) | null;
  private nextItemPromise: ((value: unknown) => void) | null;
  // Parked lease consumer (leaseNext() called on an empty/fully-leased queue).
  // Resolved by a subsequent enqueue (addItemToDB) or by rewind().
  private nextLeasePromise: ((value: LeasedItem) => void) | null;
  // Highest seq (id) handed out by leaseNext() this session. LEASE returns the
  // lowest stored id > leasedThrough; rewind() resets it to resend unconfirmed.
  private leasedThrough: number;
  private queueName: string;
  private dbOperationDispatch: Record<string, (op: DBOperation) => Promise<void>>;
  nextDBOperation: () => AsyncGenerator<DBOperation>;

  constructor (queueName: string) {
    this.db = null;
    this.dbOperationQueue = [];
    this.nextDBOperationPromise = null;
    this.nextItemPromise = null;
    this.nextLeasePromise = null;
    this.leasedThrough = 0;
    this.queueName = queueName;

    this.initialize = this.initialize.bind(this);
    this.addItemToDB = this.addItemToDB.bind(this);
    this.nextItemFromDB = this.nextItemFromDB.bind(this);
    this.leaseFromDB = this.leaseFromDB.bind(this);
    this.confirmInDB = this.confirmInDB.bind(this);
    this.countInDB = this.countInDB.bind(this);
    this.nextDBOperation = util.once(this._nextDBOperation.bind(this));
    this.startProcessing = this.startProcessing.bind(this);
    this.addItemToDBOperationQueue = this.addItemToDBOperationQueue.bind(this);
    this.enqueue = this.enqueue.bind(this);
    this.dequeue = this.dequeue.bind(this);
    this.leaseNext = this.leaseNext.bind(this);
    this.confirm = this.confirm.bind(this);
    this.rewind = this.rewind.bind(this);
    this.unconfirmedCount = this.unconfirmedCount.bind(this);

    this.dbOperationDispatch = {
      [ENQUEUE]: this.addItemToDB,
      [DEQUEUE]: this.nextItemFromDB,
      [LEASE]: this.leaseFromDB,
      [CONFIRM]: this.confirmInDB,
      [COUNT]: this.countInDB
    };
    this.initialize();
  }

  /**
   * Determine which environment we are in to set
   * the appropriate indexeddb information.
   */
  async initialize () {
    let request;
    if (typeof indexedDB === 'undefined') {
      // Node.js persistent queue is not yet supported.
      // The sqlite3/indexeddb-js fallback was broken (autoIncrement
      // unsupported, keys returned out of order) and the imports
      // break browser bundlers. Use QueueType.IN_MEMORY for now.
      //
      // To restore Node support, install sqlite3 and indexeddb-js
      // and uncomment:
      //   const sqlite3 = await import('sqlite3');
      //   const indexeddbjs = await import('indexeddb-js');
      //   const engine = new sqlite3.default.Database('queue.sqlite');
      //   const scope = indexeddbjs.makeScope('sqlite3', engine);
      //   request = scope.indexedDB.open(this.queueName);
      throw new Error(
        'IndexedDB is not available in this environment. ' +
        'Use QueueType.IN_MEMORY for Node.js.'
      );
    } else {
      debug.info('idbQueue: Using browser consoleDB');
      request = indexedDB.open(this.queueName, 1);
    }

    request.onerror = () => {
      debug.error('QUEUE ERROR: could not open database', request.error);
    };

    request.onupgradeneeded = async () => {
      this.db = request.result;
      const objectStore = this.db.createObjectStore(this.queueName, { keyPath: 'id', autoIncrement: true });
      objectStore.createIndex('id', 'id');
    };

    request.onsuccess = () => {
      this.db = request.result;
      this.startProcessing();
    };
  }

  /**
   * Perform transaction to add item into indexeddb
   * If we are waiting for an item to available to dequeue,
   * we resolve the item immediately and don't add it to
   * the indexeddb.
   */
  async addItemToDB (op: DBOperation) {
    const payload = op.payload!;
    if (this.nextItemPromise) {
      this.nextItemPromise(payload.payload);
      this.nextItemPromise = null;
      return;
    }
    debug.info(`idbQueue: adding item to database, ${payload}`);
    const transaction = this.db!.transaction([this.queueName], 'readwrite');
    const objectStore = transaction.objectStore(this.queueName);

    const request = objectStore.add(payload);

    request.onsuccess = () => {
      // A parked lease consumer (leaseNext on an empty queue) is waiting for
      // the next item. autoIncrement assigned its id here, so hand it out now
      // (non-destructively — it stays in the DB until confirm()ed).
      const newId = request.result as number;
      if (this.nextLeasePromise && newId > this.leasedThrough) {
        const resolve = this.nextLeasePromise;
        this.nextLeasePromise = null;
        this.leasedThrough = newId;
        resolve({ seq: newId, item: payload.payload });
      }
    };

    request.onerror = () => {
      if (request.error?.name === 'ConstraintError') {
        debug.error('IDBQUEUE ERROR: Item already exists', request.error);
      } else {
        debug.error('IDBQUEUE ERROR: Error adding item to the queue:', request.error);
      }
    };
  }

  /**
   * Perform transaction to fetch next item in indexeddb
   */
  async nextItemFromDB (op: DBOperation) {
    const { resolve, reject } = op;
    debug.info('idbQueue: Fetching next item from database');
    const transaction = this.db!.transaction([this.queueName], 'readwrite');
    const objectStore = transaction.objectStore(this.queueName);
    const request = objectStore.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const item = cursor.value;
        const deleteRequest = objectStore.delete(cursor.key);

        deleteRequest.onsuccess = () => {
          resolve!(item.payload);
        };

        deleteRequest.onerror = () => {
          debug.error('IDBQUEUE ERROR: Error removing item from the queue:', deleteRequest.error);
          reject!(deleteRequest.error);
        };
      } else {
        // No more items in the IndexedDB.
        resolve!(new Promise((resolve) => {
          this.nextItemPromise = resolve;
        }));
      }
    };

    request.onerror = () => {
      debug.error('IDBQUEUE ERROR: Error reading queue cursor:', request.error);
      reject!(request.error);
    };
  }

  /**
   * Lease the next item WITHOUT deleting it: the lowest-id record with
   * id > leasedThrough. Advances leasedThrough so the next lease moves
   * forward. If none is available, park until a matching enqueue (or a
   * rewind) hands one over. The item stays in the DB until confirm().
   */
  async leaseFromDB (op: DBOperation) {
    const { resolve, reject } = op;
    const transaction = this.db!.transaction([this.queueName], 'readonly');
    const objectStore = transaction.objectStore(this.queueName);
    const request = objectStore.openCursor(IDBKeyRange.lowerBound(this.leasedThrough, true));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const id = cursor.key as number;
        this.leasedThrough = id;
        resolve!({ seq: id, item: cursor.value.payload } as LeasedItem);
      } else {
        // Nothing new to lease — park; addItemToDB (or rewind) resolves it.
        this.nextLeasePromise = resolve as (value: LeasedItem) => void;
      }
    };

    request.onerror = () => {
      debug.error('IDBQUEUE ERROR: Error leasing queue cursor:', request.error);
      reject!(request.error);
    };
  }

  /**
   * Delete EXACTLY the listed ids, in one transaction.
   *
   * NOT a ranged delete. This store is shared by every tab in the browser —
   * that sharing is what makes tab-close recovery work — but each tab acks
   * over its own socket. `delete(upperBound(seq))` therefore deleted records
   * belonging to other tabs, including ones nobody had sent yet. Duplicates
   * are covered by at-least-once delivery; deletions never were.
   */
  async confirmInDB (op: DBOperation) {
    const seqs = op.seqs ?? [];
    if (!seqs.length) { op.resolve?.(undefined); return; }
    const transaction = this.db!.transaction([this.queueName], 'readwrite');
    const objectStore = transaction.objectStore(this.queueName);

    for (const id of seqs) {
      const request = objectStore.delete(id);
      request.onerror = () => {
        debug.error('IDBQUEUE ERROR: Error confirming (deleting) item:', request.error);
      };
    }

    // Settle on the TRANSACTION, not on the individual deletes. Counting
    // per-request callbacks has a hole: if a middle delete fails and a later
    // one succeeds, the success path skips resolve (an error was recorded) and
    // the error path already ran while others were outstanding — so neither
    // fires and the promise hangs forever. Harmless while confirm() is
    // fire-and-forget, and a trap for the first caller who awaits it.
    transaction.oncomplete = () => { op.resolve?.(undefined); };
    transaction.onerror = () => { op.reject?.(transaction.error); };
    transaction.onabort = () => { op.reject?.(transaction.error); };
  }

  /** Count stored (unconfirmed) records. */
  async countInDB (op: DBOperation) {
    const transaction = this.db!.transaction([this.queueName], 'readonly');
    const objectStore = transaction.objectStore(this.queueName);
    const request = objectStore.count();

    request.onsuccess = () => { op.resolve!(request.result); };
    request.onerror = () => {
      debug.error('IDBQUEUE ERROR: Error counting items:', request.error);
      op.reject!(request.error);
    };
  }

  /**
   * The processing loop continually waits for the next
   * dbOperation to come using the following generator.
   */
  private async * _nextDBOperation (): AsyncGenerator<DBOperation> {
    while (true) {
      let operation: DBOperation;
      if (this.dbOperationQueue.length > 0) {
        operation = this.dbOperationQueue.shift()!;
      } else {
        operation = await new Promise<DBOperation>(resolve => {
          this.nextDBOperationPromise = resolve;
        });
      }
      debug.info(`idbQueue: Yielding next operation, ${operation}`);
      yield operation;
    }
  }

  /**
   * This method processes incoming dbOperations
   */
  async startProcessing () {
    const dbOperationStream = this.nextDBOperation();

    for await (const operation of dbOperationStream) {
      debug.info(`idbQueue: processing operation ${operation}`);
      try {
        await this.dbOperationDispatch[operation.operation](operation);
      } catch (error) {
        debug.error('Unable to perform operation on DB', error);
      }
    }
  }

  // helper function for enqueue/dequeue
  addItemToDBOperationQueue (payload: DBOperation) {
    if (this.nextDBOperationPromise) {
      this.nextDBOperationPromise(payload);
      this.nextDBOperationPromise = null;
    } else {
      this.dbOperationQueue.push(payload);
    }
  }

  /**
   * This functions will append an enqueue message to the
   * current operation stream.
   */
  enqueue (item: unknown) {
    debug.info(`idbQueue: Enqueuing item ${item}`);
    const payload = {
      operation: ENQUEUE,
      payload: { payload: item }
    };
    this.addItemToDBOperationQueue(payload);
  }

  /**
   * This function appends a dequeue message to the operation
   * stream and returns the result.
   */
  dequeue () {
    debug.info('idbQueue: dequeueing item');
    return new Promise((resolve, reject) => {
      const payload = { operation: DEQUEUE, resolve, reject };
      this.addItemToDBOperationQueue(payload);
    });
  }

  /** Lease the next unconfirmed item (non-destructive). See leaseFromDB. */
  leaseNext (): Promise<LeasedItem> {
    return new Promise<LeasedItem>((resolve, reject) => {
      this.addItemToDBOperationQueue({
        operation: LEASE,
        resolve: resolve as (value: unknown) => void,
        reject
      });
    });
  }

  /** Delete exactly these stored ids. Fire-and-forget. */
  confirm (seqs: number[]) {
    if (!seqs.length) return;
    this.addItemToDBOperationQueue({ operation: CONFIRM, seqs });
  }

  /**
   * Reset the lease cursor so the next lease re-hands unconfirmed items from
   * the lowest stored id (resend on reconnect). If a lease consumer is parked
   * (nothing was left to lease), re-issue a LEASE so it re-hands the earliest
   * still-stored item instead of waiting for a fresh enqueue.
   */
  rewind () {
    this.leasedThrough = 0;
    if (this.nextLeasePromise) {
      const resolve = this.nextLeasePromise;
      this.nextLeasePromise = null;
      this.addItemToDBOperationQueue({
        operation: LEASE,
        resolve: resolve as (value: unknown) => void,
        reject: () => {}
      });
    }
  }

  /** Count of stored (unconfirmed) items. */
  unconfirmedCount (): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.addItemToDBOperationQueue({
        operation: COUNT,
        resolve: resolve as (value: unknown) => void,
        reject
      });
    });
  }
}

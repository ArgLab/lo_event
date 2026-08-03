import * as indexeddbQueue from './indexeddbQueue.js';
import * as memoryQueue from './memoryQueue.js';
import * as debug from './debugLog.js';
import * as util from './util.js';
import type { QueueBackend, DequeueLoopConfig, LeasedItem } from './types.js';

export const QueueType = {
  AUTODETECT: 'AUTODETECT', // Persistent if available, otherwise in-memory
  IN_MEMORY: 'IN_MEMORY', // memoryQueue
  PERSISTENT: 'PERSISTENT' // SQLite or IndexedDB. Raise an exception if not available.
} as const;

const queueClasses: Record<string, new (name: string) => QueueBackend> = {
  [QueueType.IN_MEMORY]: memoryQueue.Queue,
  [QueueType.PERSISTENT]: indexeddbQueue.Queue
};

function autodetect () {
  if (typeof indexedDB === 'undefined') {
    return QueueType.IN_MEMORY;
  } else {
    return QueueType.PERSISTENT;
  }
}

export class Queue {
  private readonly queue: QueueBackend;
  startDequeueLoop: (config: DequeueLoopConfig) => Promise<void>;

  constructor (queueName: string, { queueType = QueueType.AUTODETECT as string } = {}) {
    if (queueType === QueueType.AUTODETECT) queueType = autodetect();

    const QueueClass = queueClasses[queueType];
    if (!QueueClass) throw new Error(`Invalid queue type: ${queueType}`);
    debug.info(`Queue: ${queueName} using ${queueType.toLowerCase()}Queue`);
    this.queue = new QueueClass(queueName);

    this.enqueue = this.enqueue.bind(this);
    this.startDequeueLoop = util.once(this._startDequeueLoop.bind(this));
  }

  enqueue (item: unknown) {
    this.queue.enqueue(item);
  }

  leaseNext (): Promise<LeasedItem> { return this.queue.leaseNext(); }

  /** Delete exactly the listed seqs — the ones THIS connection sent and saw
   *  acked. Never a range: the store is shared across tabs. */
  confirm (seqs: number[]) {
    this.queue.confirm(seqs);
  }

  /** Reset the lease cursor so unconfirmed items are re-handed (resend). */
  rewind () {
    this.queue.rewind();
  }

  /** Count of enqueued-but-unconfirmed items (drives the unsaved warning). */
  unconfirmedCount (): Promise<number> | number {
    return this.queue.unconfirmedCount();
  }

  /** Highest stored seq, or null when empty — the snapshot barrier watermark,
   *  captured once per connection after rewind. */
  maxSeq (): Promise<number | null> {
    return this.queue.maxSeq();
  }

  /** Stored records at or below `seq` that this instance has not yet leased.
   *  Zero means the flush barrier is clear (see QueueBackend in types.ts). */
  unleasedAtOrBelow (seq: number): Promise<number> {
    return this.queue.unleasedAtOrBelow(seq);
  }

  /** DEBUG: peek at what is sitting in the queue. */
  inspect (limit = 20): Promise<unknown[]> {
    return this.queue.inspect(limit);
  }

  /** DEBUG / RECOVERY: drop everything, unsent included. */
  clear () {
    this.queue.clear();
  }

  /**
   * This function starts a loop to continually
   * dequeue items and process them appropriately
   * based on provided functions.
   */
  private async _startDequeueLoop ({
    initialize = async () => true,
    onDequeue = async (_item: unknown) => {},
    onError = (message: string, error: unknown) => debug.error(message, error)
  }: DequeueLoopConfig = {}) {
    if (!this.queue.dequeue) {
      onError('QUEUE ERROR: this backend has no destructive dequeue', new Error('lease-only backend'));
      return;
    }
    try {
      if (!await initialize()) {
        throw new Error('QUEUE ERROR: Initialization function returned false.');
      }
    } catch (error) {
      onError('QUEUE ERROR: Failure to initialize before starting dequeue loop', error);
      return;
    }
    debug.info('QUEUE: Dequeue loop initialized.');

    while (true) {
      const item = await this.queue.dequeue();
      try {
        if (item !== null) {
          await onDequeue(item);
        }
      } catch (error) {
        onError('QUEUE ERROR: Unable to process item', error);
      }
    }
  }
}

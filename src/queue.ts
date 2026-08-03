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
  private queue: QueueBackend;
  startDequeueLoop: (config: DequeueLoopConfig) => Promise<void>;

  constructor (queueName: string, { queueType = QueueType.AUTODETECT as string } = {}) {
    if (queueType === QueueType.AUTODETECT) {
      queueType = autodetect();
    }

    const QueueClass = queueClasses[queueType];
    if (QueueClass) {
      debug.info(`Queue: using ${queueType.toLowerCase()}Queue`);
      this.queue = new QueueClass(queueName);
    } else {
      throw new Error('Invalid queue type');
    }

    this.enqueue = this.enqueue.bind(this);
    this.startDequeueLoop = util.once(this._startDequeueLoop.bind(this));
  }

  enqueue (item: unknown) {
    this.queue.enqueue(item);
  }

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

  /** Next stored record, without deleting it (§3). The outbox's only read
   *  discipline; the lease loop that drives it lives in websocketLogger, next
   *  to the socket it sends on. */
  leaseNext (): Promise<LeasedItem> {
    return this.queue.leaseNext();
  }

  /**
   * The front desk's loop: take an item, delete it, hand it on.
   *
   * Destructive by design and used in exactly one place — loEvent's in-process
   * buffer between logEvent() and the loggers, which is a hand-off, not a
   * store (§5). The outbox never dequeues destructively: an event deleted on
   * read is an event that exists only in a local variable, which is where §1's
   * promise goes to die.
   */
  private async _startDequeueLoop ({
    initialize = async () => true,
    shouldDequeue = async () => true,
    onDequeue = async (_item: unknown) => {},
    onError = (message: string, error: unknown) => debug.error(message, error)
  }: DequeueLoopConfig = {}) {
    const dequeue = this.queue.dequeue?.bind(this.queue);
    if (!dequeue) {
      onError('QUEUE ERROR: this backend is lease-only and has no destructive dequeue',
        new Error('lease-only backend'));
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
      // A false answer here terminates the loop permanently, so anything wired
      // to it must mean "never again", not "not right now". Nothing in
      // lo_event passes it today: gating this hop would hold events in memory,
      // *before* the durable write, which is the one place a gate must never
      // be (§5).
      try {
        if (!await shouldDequeue()) {
          throw new Error('QUEUE ERROR: Dequeue streaming returned false.');
        }
      } catch (error) {
        onError('QUEUE ERROR: Not allowed to start dequeueing', error);
        return;
      }

      const item = await dequeue();
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

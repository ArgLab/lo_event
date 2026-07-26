import * as indexeddbQueue from './indexeddbQueue.js';
import * as memoryQueue from './memoryQueue.js';
import * as debug from './debugLog.js';
import * as util from './util.js';
import type { QueueBackend, DequeueLoopConfig } from './types.js';

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

  /**
   * This function starts a loop to continually
   * dequeue items and process them appropriately
   * based on provided functions.
   */
  private async _startDequeueLoop ({
    initialize = async () => true,
    shouldDequeue = async () => true,
    onDequeue = async (_item: unknown) => {},
    onLease,
    onError = (message: string, error: unknown) => debug.error(message, error)
  }: DequeueLoopConfig = {}) {
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
      // Check if we are allowed to continue dequeueing.
      // When shouldDequeue() returns false, we permanently terminate
      // the loop. This is intentional — the primary caller is
      // disabler.retry(), which only returns false for permanent
      // opt-outs (e.g. student privacy requests). In that case,
      // the loop must stop and must not restart. Temporary blocks
      // (e.g. rate limits) are handled inside disabler.retry() by
      // awaiting the expiration before returning true.
      try {
        if (!await shouldDequeue()) {
          throw new Error('QUEUE ERROR: Dequeue streaming returned false.');
        }
      } catch (error) {
        onError('QUEUE ERROR: Not allowed to start dequeueing', error);
        return;
      }

      // Ack-aware lease discipline: hand the item to onLease WITHOUT deleting
      // it. The consumer confirm()s it later (on server ack); rewind() re-hands
      // unconfirmed items on reconnect. Nothing is lost if delivery fails.
      if (onLease) {
        try {
          const leased = await this.queue.leaseNext();
          await onLease(leased);
        } catch (error) {
          onError('QUEUE ERROR: Unable to lease/process item', error);
        }
        continue;
      }

      // Legacy destructive discipline: take-and-delete, then process.
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

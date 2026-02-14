import * as indexeddbQueue from './indexeddbQueue.js';
import * as memoryQueue from './memoryQueue.js';
import * as debug from './debugLog.js';
import * as util from './util.js';

export const QueueType = {
  AUTODETECT: 'AUTODETECT', // Persistent if available, otherwise in-memory
  IN_MEMORY: 'IN_MEMORY', // memoryQueue
  PERSISTENT: 'PERSISTENT' // SQLite or IndexedDB. Raise an exception if not available.
};

const queueClasses = {
  [QueueType.IN_MEMORY]: memoryQueue.Queue,
  [QueueType.PERSISTENT]: indexeddbQueue.Queue
};

function autodetect () {
  if (typeof indexedDB === 'undefined') {
    return QueueType.IN_MEMORY;
  } else {
    return QueueType.PERSISTENT;
  }
};

export class Queue {
  constructor (queueName, { queueType = QueueType.AUTODETECT } = {}) {
    this.queue = null;

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
    this.startDequeueLoop = util.once(this.startDequeueLoop.bind(this));
  }

  enqueue (item) {
    this.queue.enqueue(item);
  }

  /**
   * This function starts a loop to continually
   * dequeue items and process them appropriately
   * based on provided functions.
   */
  async startDequeueLoop ({
    initialize = async () => true,
    shouldDequeue = async () => true,
    onDequeue = async (item) => {},
    onError = (message, error) => debug.error(message, error)
  }) {
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

      // do something with the item
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

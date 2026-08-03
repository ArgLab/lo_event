/*
 * The front desk's destructive hand-off loop (queue.ts).
 *
 * These two tests pin the FRONT DESK's FIFO dequeue — the in-process buffer
 * every event passes through on its way to the loggers — not the outbox. The
 * outbox never dequeues destructively (§5); its lease/confirm/rewind contract
 * is pinned in queueContract.test.js, against both backends.
 */

import { describe, it, expect } from 'vitest';
import { Queue, QueueType } from '../src/queue.js';

describe('front desk dequeue loop', () => {
  it('dequeues items in FIFO order', async () => {
    const queue = new Queue('fifoTest', { queueType: QueueType.IN_MEMORY });
    const items = [0, 1, 2, 3, 4];
    const received = [];

    for (const item of items) {
      queue.enqueue(item);
    }

    queue.startDequeueLoop({
      onDequeue: (item) => { received.push(item); }
    });

    // Give the dequeue loop a tick to process
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(received).toEqual(items);
  });

  it('dequeues items enqueued after loop starts', async () => {
    const queue = new Queue('lateEnqueue', { queueType: QueueType.IN_MEMORY });
    const received = [];

    queue.startDequeueLoop({
      onDequeue: (item) => { received.push(item); }
    });

    queue.enqueue('a');
    queue.enqueue('b');

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(received).toEqual(['a', 'b']);
  });
});

// TODO: Test both types of queue, and then in node and
// browser, as well as various failure conditions.

import { describe, it, expect } from 'vitest';
import { Queue } from '../src/queue.js';

describe('Queue', () => {
  it('dequeues items in FIFO order', async () => {
    const queue = new Queue('fifoTest');
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
    const queue = new Queue('lateEnqueue');
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

// The queue facade: the front desk's destructive hand-off, and the outbox
// discipline as seen through Queue rather than through a backend.
//
// The outbox rules themselves — lease/confirm/rewind, the shared store, the
// barrier predicates, wake-by-rescan — live in queueContract.test.js, which
// runs one suite against BOTH backends. They used to be pinned here against
// memoryQueue alone; running them against IndexedDB too is what made the
// storage-level rules testable at all, so this file keeps only what is
// genuinely about the facade.

import { describe, it, expect } from 'vitest';
import { Queue } from '../src/queue.js';

// The front desk (loEvent's in-process buffer between logEvent() and the
// loggers) is the one remaining consumer of the destructive discipline: it
// takes an item and deletes it in the same breath. That is safe there and only
// there — it is a hand-off buffer, not a durable store, and nothing recovers
// from it (§5).
describe('front desk: destructive hand-off', () => {
  it('dequeues items in FIFO order', async () => {
    const queue = new Queue('fifoTest', { queueType: 'IN_MEMORY' });
    const items = [0, 1, 2, 3, 4];
    const received = [];

    for (const item of items) {
      queue.enqueue(item);
    }

    queue.startDequeueLoop({
      onDequeue: (item) => { received.push(item); }
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(received).toEqual(items);
  });

  it('dequeues items enqueued after the loop starts', async () => {
    const queue = new Queue('lateEnqueue', { queueType: 'IN_MEMORY' });
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

describe('outbox facade', () => {
  it('leases without deleting, and deletes only what confirm names', async () => {
    const queue = new Queue('facade', { queueType: 'IN_MEMORY' });
    queue.enqueue('x'); queue.enqueue('y');

    expect(await queue.leaseNext()).toEqual({ seq: 1, item: 'x' });
    expect(await queue.leaseNext()).toEqual({ seq: 2, item: 'y' });
    expect(await queue.unconfirmedCount()).toBe(2);   // held pending ack

    queue.confirm([1]);
    expect(await queue.unconfirmedCount()).toBe(1);
    queue.rewind();
    expect(await queue.leaseNext()).toEqual({ seq: 2, item: 'y' });
  });
});

// TODO: Test both types of queue, and then in node and
// browser, as well as various failure conditions.

import { describe, it, expect } from 'vitest';
import { Queue } from '../src/queue.js';
import { Queue as MemoryQueue } from '../src/memoryQueue.js';

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

// TODO(final PR review): these lease/confirm/rewind cases were load-bearing
// while building the lease discipline (caught the rewind-parked-consumer bug),
// but the algorithm is now stable — decide whether to keep all of them, trim to
// the two that pin the contract (lease-doesn't-delete + cumulative-confirm), or
// pull. They are mock-free/declarative, so low weight, but per the testing
// philosophy a stable algorithm's tests are candidate maintenance weight.
//
// Ack-protocol backbone: lease is non-destructive; confirm deletes the
// acked prefix; rewind re-hands unconfirmed items (resend on reconnect).
describe('MemoryQueue lease / confirm / rewind', () => {
  it('leases with seq WITHOUT deleting; confirm deletes cumulatively', async () => {
    const q = new MemoryQueue('lease-confirm');
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');

    expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
    expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
    expect(q.unconfirmedCount()).toBe(3);   // leased, but nothing deleted

    q.confirm(2);                            // ack "everything through #2"
    expect(q.unconfirmedCount()).toBe(1);    // only 'c' remains
    expect(await q.leaseNext()).toEqual({ seq: 3, item: 'c' });
  });

  it('rewind re-hands every unconfirmed item (full resend)', async () => {
    const q = new MemoryQueue('rewind-all');
    q.enqueue('a'); q.enqueue('b');
    await q.leaseNext(); await q.leaseNext();  // sent, not acked

    q.rewind();                                // reconnect

    expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
    expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
  });

  it('confirm then rewind: only the unconfirmed tail resends', async () => {
    const q = new MemoryQueue('rewind-partial');
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    await q.leaseNext(); await q.leaseNext(); await q.leaseNext();

    q.confirm(1);      // 'a' durably acked
    q.rewind();        // reconnect

    expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
    expect(q.unconfirmedCount()).toBe(2);
  });

  it('leaseNext parks when fully leased; rewind wakes the parked consumer', async () => {
    const q = new MemoryQueue('park-rewind');
    q.enqueue('a');
    expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });

    let resolved = null;
    const pending = q.leaseNext().then(v => { resolved = v; });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(null);               // parked — nothing new to lease

    q.rewind();                                // reconnect re-hands 'a'
    await pending;
    expect(resolved).toEqual({ seq: 1, item: 'a' });
  });

  it('leaseNext parks then resolves on a later enqueue', async () => {
    const q = new MemoryQueue('park-enqueue');
    let resolved = null;
    const pending = q.leaseNext().then(v => { resolved = v; });
    await new Promise(r => setTimeout(r, 10));
    expect(resolved).toBe(null);

    q.enqueue('late');
    await pending;
    expect(resolved).toEqual({ seq: 1, item: 'late' });
  });
});

// The lease loop (queue.ts) drives onLease non-destructively; confirm is
// external (server ack). Autodetects the in-memory backend under Node.
describe('Queue lease loop', () => {
  it('onLease receives leased items and does not delete until confirm', async () => {
    const q = new Queue('lease-loop');
    const received = [];
    q.enqueue('x'); q.enqueue('y');

    q.startDequeueLoop({ onLease: (leased) => { received.push(leased); } });
    await new Promise(r => setTimeout(r, 50));

    expect(received).toEqual([{ seq: 1, item: 'x' }, { seq: 2, item: 'y' }]);
    expect(await q.unconfirmedCount()).toBe(2);  // held pending ack

    q.confirm(2);
    expect(await q.unconfirmedCount()).toBe(0);
  });
});

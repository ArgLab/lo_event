import { describe, it, expect } from 'vitest';
import { Queue } from '../src/queue.js';
import { Queue as MemoryQueue } from '../src/memoryQueue.js';
import { queueContract } from './queueContract.js';

queueContract('memory', label => new MemoryQueue(`shared-${label}-${crypto.randomUUID()}`));

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
  it('leases with seq WITHOUT deleting; confirm deletes exactly what it is given', async () => {
    const q = new MemoryQueue('lease-confirm');
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');

    expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
    expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
    expect(q.unconfirmedCount()).toBe(3);   // leased, but nothing deleted

    q.confirm([1, 2]);                       // the two records this sender sent
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

    q.confirm([1]);    // 'a' durably acked
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

// ─────────────────────────────────────────────────────────────────────────────
// The shared-store, multi-sender hazard
// ─────────────────────────────────────────────────────────────────────────────
//
// One IndexedDB queue is shared by every tab in the browser — that sharing is
// exactly what makes tab-close recovery work. But each tab acks over its OWN
// socket. When deletion was a cumulative range (`delete(id <= n)`), one tab's
// ack deleted records belonging to other tabs, including records nobody had
// sent yet. Duplicates are covered by at-least-once delivery; deletions are
// not — that is silent data loss.
//
// The rule these lock in: a sender may delete ONLY the records it sent and saw
// acked on its own connection.

describe('shared store, independent senders', () => {
  it('one sender\'s ack does not delete another sender\'s unsent records', async () => {
    const q = new MemoryQueue('two-tabs');
    // Interleaved, as two tabs writing to one store would be.
    q.enqueue('A1'); q.enqueue('B1'); q.enqueue('A2'); q.enqueue('B2');

    // Tab A sent only its own two records (seqs 1 and 3) and got them acked.
    q.confirm([1, 3]);

    // Tab B's records must still be there. Under the old cumulative delete,
    // confirming "through 3" would have taken B1 with it — unsent and gone.
    expect(q.unconfirmedCount()).toBe(2);
    q.rewind();
    expect(await q.leaseNext()).toEqual({ seq: 2, item: 'B1' });
    expect(await q.leaseNext()).toEqual({ seq: 4, item: 'B2' });
  });

  it('a sender that dies before its ack loses nothing', async () => {
    const q = new MemoryQueue('dead-tab');
    q.enqueue('x'); q.enqueue('y');
    await q.leaseNext(); await q.leaseNext();   // sent, never acked

    // The tab dies: its sent-map dies with it, so nothing is confirmed.
    q.rewind();                                  // next connection

    expect(q.unconfirmedCount()).toBe(2);
    expect(await q.leaseNext()).toEqual({ seq: 1, item: 'x' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The flush barrier (snapshot-after-flush)
// ─────────────────────────────────────────────────────────────────────────────
//
// Before requesting a state snapshot, a connection must know its backlog has
// reached the server. The barrier is a question about the SHARED store, so it
// is asked of the store: capture the highest stored seq at connection start
// (maxSeq — the watermark), then probe unleasedAtOrBelow(watermark) until it
// reaches zero. Counting sends instead was wrong twice: on a shared store,
// another tab can send-and-delete records this connection was measured
// against, so no captured count is a quota this connection can be relied on
// to meet.

describe('flush barrier (maxSeq / unleasedAtOrBelow)', () => {
  it('maxSeq is null on an empty store, and the watermark otherwise', async () => {
    const q = new MemoryQueue('barrier-empty');
    expect(await q.maxSeq()).toBe(null);
    q.enqueue('a'); q.enqueue('b');
    expect(await q.maxSeq()).toBe(2);
  });

  it('clears as this connection leases (sends) the backlog', async () => {
    const q = new MemoryQueue('barrier-drain');
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    const w = await q.maxSeq();

    expect(await q.unleasedAtOrBelow(w)).toBe(3);
    await q.leaseNext();
    await q.leaseNext();
    expect(await q.unleasedAtOrBelow(w)).toBe(1);
    await q.leaseNext();
    expect(await q.unleasedAtOrBelow(w)).toBe(0);   // barrier clear
  });

  it('ignores records enqueued after the watermark (live typing cannot starve it)', async () => {
    const q = new MemoryQueue('barrier-live');
    q.enqueue('backlog');
    const w = await q.maxSeq();
    q.enqueue('keystroke-1'); q.enqueue('keystroke-2');

    await q.leaseNext();                             // the one backlog record
    expect(await q.unleasedAtOrBelow(w)).toBe(0);    // clear despite new events
  });

  it("clears when ANOTHER tab drains records this connection never leases", async () => {
    // Sol's starvation case, the one no send count can handle: the store is
    // shared, so another tab can send a backlog record and delete it on ack
    // before this connection reaches it. A connection waiting to observe N of
    // its own sends waits forever; asking the store instead sees the records
    // gone — and gone-by-ack means the server already has them, which is
    // exactly what the barrier wants to know.
    const q = new MemoryQueue('barrier-cross-tab');
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    const w = await q.maxSeq();

    await q.leaseNext();          // this connection sends 'a'...
    q.confirm([2, 3]);            // ...another tab sent and acked 'b' and 'c'

    expect(await q.unleasedAtOrBelow(w)).toBe(0);   // barrier clear, no starvation
  });

  it('a rewound cursor makes the backlog pending again (measure AFTER rewind)', async () => {
    // unleasedAtOrBelow measures against the lease cursor, so the watermark
    // must be captured after rewind(): before it, the cursor still holds the
    // previous connection's position and the backlog looks already-sent.
    const q = new MemoryQueue('barrier-rewind');
    q.enqueue('a'); q.enqueue('b');
    await q.leaseNext(); await q.leaseNext();        // previous connection sent both
    const w = await q.maxSeq();

    expect(await q.unleasedAtOrBelow(w)).toBe(0);    // stale cursor: looks clear
    q.rewind();                                      // new connection resends
    expect(await q.unleasedAtOrBelow(w)).toBe(2);    // truth: both pending again
  });
});

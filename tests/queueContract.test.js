/*
 * The queue contract (§3), as ONE suite run against BOTH backends. Memory and
 * IndexedDB must be interchangeable under the outbox; a contract test that
 * runs against only one backend is how round one shipped an untested
 * IndexedDB wake path and a rewind/scan race.
 *
 * IndexedDB is provided by fake-indexeddb. Store names are unique per test —
 * the fake persists per-process, which conveniently also lets us simulate a
 * "next page load" (a second Queue instance on the same store) and a second
 * tab (two live instances on one store).
 */

import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { Queue as MemoryQueue } from '../src/memoryQueue.js';
import { Queue as IDBQueue } from '../src/indexeddbQueue.js';

let storeCounter = 0;
const uniqueName = prefix => `${prefix}-${++storeCounter}`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until the backend's serialized writes have landed (IDB is async). */
async function settle (q) {
  await q.unconfirmedCount();
}

function contractSuite (backendName, makeQueue) {
  describe(`queue contract: ${backendName}`, () => {
    it('leases without deleting; confirm deletes exactly the listed ids (L1)', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
      expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
      expect(await q.unconfirmedCount()).toBe(3);   // leasing deleted nothing

      q.confirm([1]);
      expect(await q.unconfirmedCount()).toBe(2);
      // b (leased, unconfirmed) and c survive; the confirm was not a range.
      expect((await q.inspect(10)).map(r => r.seq)).toEqual([2, 3]);
    });

    it("one sender's ack does not delete another sender's unsent records (L1)", async () => {
      const q = makeQueue();
      q.enqueue('mine-1'); q.enqueue('theirs'); q.enqueue('mine-2');
      // This sender sent 1 and 3 and saw them acked. Record 2 belongs to
      // someone else and has never been sent. A cumulative "through 3"
      // delete would destroy it.
      q.confirm([1, 3]);
      expect((await q.inspect(10)).map(r => r.seq)).toEqual([2]);
    });

    it('a sender that dies before its ack loses nothing: rewind re-hands unconfirmed records (L2)', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b');
      await q.leaseNext();
      await q.leaseNext();
      // The "sender" dies: leases evaporate (cursor is in-memory). Rewind —
      // the next connection's first act — re-hands both.
      q.rewind();
      expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
    });

    it('confirm then rewind: only the unconfirmed tail resends', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
      await q.leaseNext(); await q.leaseNext(); await q.leaseNext();
      q.confirm([1]);    // 'a' durably acked
      q.rewind();        // reconnect
      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
      expect(await q.unconfirmedCount()).toBe(2);
    });

    it('wakes a parked lease by RE-SCANNING, never by hand-off: rewind hands the lowest stored record, not the waker (§3)', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b');
      await q.leaseNext();
      await q.leaseNext();
      const parked = q.leaseNext();          // drained: parks
      q.rewind();                            // wake — via a fresh scan
      expect(await parked).toEqual({ seq: 1, item: 'a' });
    });

    it('wakes a parked lease on enqueue with the lowest unleased record', async () => {
      const q = makeQueue();
      const parked = q.leaseNext();          // empty store: parks
      q.enqueue('a');
      expect(await parked).toEqual({ seq: 1, item: 'a' });
    });

    it('maxSeq is the highest stored id, or null when empty (§7 watermark)', async () => {
      const q = makeQueue();
      expect(await q.maxSeq()).toBe(null);
      q.enqueue('a'); q.enqueue('b');
      expect(await q.maxSeq()).toBe(2);
      q.confirm([2]);
      expect(await q.maxSeq()).toBe(1);
    });

    it('unleasedAtOrBelow answers the barrier: leases and acks drain it, live typing above the watermark never enters it (§7)', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b');        // the backlog; watermark = 2
      expect(await q.unleasedAtOrBelow(2)).toBe(2);
      q.enqueue('live-typing');              // id 3, above the watermark
      expect(await q.unleasedAtOrBelow(2)).toBe(2);
      await q.leaseNext();
      expect(await q.unleasedAtOrBelow(2)).toBe(1);
      q.confirm([2]);                        // an ack from anywhere deletes it
      expect(await q.unleasedAtOrBelow(2)).toBe(0);   // barrier clear
    });

    it('cross-tab drain clears the barrier rather than starving it (§7): deletions by another sender empty the count', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b');
      // Another tab sent both records and their acks deleted them; this
      // instance leased nothing. The predicate must observe the store, not a
      // captured count.
      q.confirm([1, 2]);
      expect(await q.unleasedAtOrBelow(2)).toBe(0);
    });

    it('measure-after-rewind: a pre-rewind cursor makes the backlog look leased (L10)', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b');
      await q.leaseNext();
      await q.leaseNext();
      // Old connection's cursor is at 2. Without rewind the barrier would
      // see zero and clear spuriously.
      expect(await q.unleasedAtOrBelow(2)).toBe(0);
      q.rewind();
      expect(await q.unleasedAtOrBelow(2)).toBe(2);
    });

    it('clear() empties the store but never resets the id sequence — storage ids are never reused (L4)', async () => {
      const q = makeQueue();
      q.enqueue('a'); q.enqueue('b');
      await settle(q);
      q.clear();
      await settle(q);
      q.enqueue('c');
      const [record] = await q.inspect(10);
      expect(record.seq).toBeGreaterThan(2);
    });

  });
}

contractSuite('memoryQueue', () => new MemoryQueue(uniqueName('contract-mem')));
contractSuite('indexeddbQueue', () => new IDBQueue(uniqueName('contract-idb')));

describe('indexeddbQueue: durability and sharing (IDB-only semantics)', () => {
  it('records survive an instance: a "next page load" finds the dead session\'s unconfirmed records', async () => {
    const name = uniqueName('durability');
    const first = new IDBQueue(name);
    first.enqueue('unacked-1');
    first.enqueue('unacked-2');
    await settle(first);
    // The tab dies. A new context opens the same store.
    const second = new IDBQueue(name);
    expect(await second.unconfirmedCount()).toBe(2);
    expect(await second.leaseNext()).toEqual({ seq: 1, item: 'unacked-1' });
  });

  it('a parked lease notices another context\'s enqueue via the slow re-scan', async () => {
    const name = uniqueName('cross-context');
    const tabA = new IDBQueue(name);
    const tabB = new IDBQueue(name);
    const parked = tabA.leaseNext();          // A parks on an empty store
    tabB.enqueue('from-b');                   // B commits and (say) dies
    // A has no change notification; its ~300ms re-scan must find the record.
    const leased = await Promise.race([parked, delay(2000).then(() => 'timed out')]);
    expect(leased).toEqual({ seq: 1, item: 'from-b' });
  });

  it('REGRESSION: a rewind landing while a lease scan is in flight is not overwritten — the backlog is not skipped', async () => {
    // Round 1: leaseNext captured the cursor at scan start and assigned it at
    // scan end; a rewind in between was clobbered, the rewound backlog stayed
    // unleased, and the barrier could clear with backlog unsent. The window
    // only exists on an async backend — the memory scan is atomic — which is
    // why this test lives here rather than in the shared contract.
    const q = new IDBQueue(uniqueName('rewind-race'));
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    await settle(q);
    await q.leaseNext();                    // cursor at 1
    const inFlight = q.leaseNext();         // scan starts above 1…
    q.rewind();                             // …and the rewind lands mid-scan
    const leased = await inFlight;
    expect(leased).toEqual({ seq: 1, item: 'a' });   // post-rewind truth
    expect(await q.unleasedAtOrBelow(3)).toBe(2);    // b and c still in the count
  });

  it('memoryQueue is honest about NOT sharing: two instances are two stores', async () => {
    const a = new MemoryQueue('same-name');
    const b = new MemoryQueue('same-name');
    a.enqueue('x');
    expect(await b.unconfirmedCount()).toBe(0);
  });
});

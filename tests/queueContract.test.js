// The outbox contract, run against BOTH backends.
//
// §3 and §9 ask for exactly this: memory and IndexedDB implement one contract
// and are tested through one suite. The IndexedDB half runs on fake-indexeddb,
// which is the only way the store-level rules — wake-by-rescan, the shared
// store, the rewind-mid-scan race — get tested at all. They were the ablated
// parts, and they are where a hand-off shortcut hides.

import { describe, it, expect, beforeEach } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { Queue as MemoryQueue } from '../src/memoryQueue.js';
import { Queue as IndexedDBQueue } from '../src/indexeddbQueue.js';

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** A distinct store per test: IndexedDB databases outlive their test. */
let storeCounter = 0;
const backends = [
  { name: 'memoryQueue', make: () => new MemoryQueue(`contract-${++storeCounter}`) },
  { name: 'indexeddbQueue', make: () => new IndexedDBQueue(`contract-idb-${++storeCounter}`) }
];

for (const backend of backends) {
  describe(`outbox contract: ${backend.name}`, () => {
    let q;
    beforeEach(async () => {
      q = backend.make();
      await q.initialize();
    });

    it('leases without deleting, and deletes only what confirm names', async () => {
      q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
      await settle();

      expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
      expect(await q.unconfirmedCount()).toBe(3);      // leased, nothing deleted

      q.confirm([1, 2]);
      await settle();
      expect(await q.unconfirmedCount()).toBe(1);
      expect(await q.leaseNext()).toEqual({ seq: 3, item: 'c' });
    });

    it('rewind re-hands every unconfirmed record (resend on reconnect)', async () => {
      q.enqueue('a'); q.enqueue('b');
      await settle();
      await q.leaseNext(); await q.leaseNext();        // sent, not acked

      q.rewind();
      expect(await q.leaseNext()).toEqual({ seq: 1, item: 'a' });
      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
    });

    it('confirm then rewind: only the unconfirmed tail resends', async () => {
      q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
      await settle();
      await q.leaseNext(); await q.leaseNext(); await q.leaseNext();

      q.confirm([1]);
      await settle();
      q.rewind();

      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
      expect(await q.unconfirmedCount()).toBe(2);
    });

    it('a sender that dies before its ack loses nothing (L2)', async () => {
      q.enqueue('x'); q.enqueue('y');
      await settle();
      await q.leaseNext(); await q.leaseNext();        // sent, never acked

      q.rewind();                                      // the next connection
      expect(await q.unconfirmedCount()).toBe(2);
      expect(await q.leaseNext()).toEqual({ seq: 1, item: 'x' });
    });

    it("one sender's ack does not delete another sender's unsent records (L1)", async () => {
      // Interleaved, as two tabs writing to one store would be. Tab A sent and
      // acked only its own records. A cumulative delete("through 3") would have
      // taken B1 with it — unsent, and gone.
      q.enqueue('A1'); q.enqueue('B1'); q.enqueue('A2'); q.enqueue('B2');
      await settle();

      q.confirm([1, 3]);
      await settle();

      expect(await q.unconfirmedCount()).toBe(2);
      q.rewind();
      expect(await q.leaseNext()).toEqual({ seq: 2, item: 'B1' });
      expect(await q.leaseNext()).toEqual({ seq: 4, item: 'B2' });
    });

    it('parks when fully leased, and a later enqueue wakes it', async () => {
      q.enqueue('a');
      await settle();
      await q.leaseNext();

      let resolved = null;
      const parked = q.leaseNext().then(v => { resolved = v; });
      await settle();
      expect(resolved).toBe(null);

      q.enqueue('late');
      await parked;
      expect(resolved).toEqual({ seq: 2, item: 'late' });
    });

    it('rewind wakes a parked consumer', async () => {
      q.enqueue('a');
      await settle();
      await q.leaseNext();

      let resolved = null;
      const parked = q.leaseNext().then(v => { resolved = v; });
      await settle();
      expect(resolved).toBe(null);

      q.rewind();
      await parked;
      expect(resolved).toEqual({ seq: 1, item: 'a' });
    });

    it('answers the barrier: maxSeq is the watermark, null when empty', async () => {
      expect(await q.maxSeq()).toBe(null);
      q.enqueue('a'); q.enqueue('b');
      await settle();
      expect(await q.maxSeq()).toBe(2);
    });

    it('unleasedAtOrBelow counts down as this connection leases the backlog', async () => {
      q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
      await settle();
      const watermark = await q.maxSeq();

      expect(await q.unleasedAtOrBelow(watermark)).toBe(3);
      await q.leaseNext(); await q.leaseNext();
      expect(await q.unleasedAtOrBelow(watermark)).toBe(1);
      await q.leaseNext();
      expect(await q.unleasedAtOrBelow(watermark)).toBe(0);
    });

    it('records above the watermark never block the barrier (live typing)', async () => {
      q.enqueue('backlog');
      await settle();
      const watermark = await q.maxSeq();
      q.enqueue('keystroke-1'); q.enqueue('keystroke-2');
      await settle();

      await q.leaseNext();
      expect(await q.unleasedAtOrBelow(watermark)).toBe(0);
    });

    it('the barrier clears when ANOTHER tab drains records we never lease', async () => {
      // No local send tally can answer this: the records this connection was
      // measured against were sent and deleted by someone else. Gone-by-ack
      // means the server already has them, which is what the barrier asks.
      q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
      await settle();
      const watermark = await q.maxSeq();

      await q.leaseNext();                            // we send 'a'
      q.confirm([2, 3]);                              // another tab acked 'b','c'
      await settle();

      expect(await q.unleasedAtOrBelow(watermark)).toBe(0);
    });

    it('a rewound cursor makes the backlog pending again (measure AFTER rewind)', async () => {
      q.enqueue('a'); q.enqueue('b');
      await settle();
      await q.leaseNext(); await q.leaseNext();
      const watermark = await q.maxSeq();

      expect(await q.unleasedAtOrBelow(watermark)).toBe(0);   // stale cursor lies
      q.rewind();
      expect(await q.unleasedAtOrBelow(watermark)).toBe(2);   // post-rewind truth
    });

    it('clear() drops everything, and never reuses a storage id (L4)', async () => {
      q.enqueue('a'); q.enqueue('b');
      await settle();
      q.clear();
      await settle();
      expect(await q.unconfirmedCount()).toBe(0);

      q.enqueue('after');
      await settle();
      // A reused id would let a stale in-flight entry confirm a fresh record.
      expect(await q.maxSeq()).toBeGreaterThan(2);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-context behavior — IndexedDB only. The store is shared across contexts
// in one origin, and that sharing IS the tab-close recovery story (§2). Two
// Queue instances over one database stand in for two tabs.
// ─────────────────────────────────────────────────────────────────────────────

describe('the shared store, across contexts (indexeddbQueue)', () => {
  it('a second context sees records the first enqueued', async () => {
    const name = `shared-${++storeCounter}`;
    const tabA = new IndexedDBQueue(name);
    const tabB = new IndexedDBQueue(name);
    await Promise.all([tabA.initialize(), tabB.initialize()]);

    tabA.enqueue('from-A');
    await settle();

    expect(await tabB.leaseNext()).toEqual({ seq: 1, item: 'from-A' });
    // Leases are per-instance: A has its own cursor and sees it too (L3 —
    // duplicates are the safe direction).
    expect(await tabA.leaseNext()).toEqual({ seq: 1, item: 'from-A' });
  });

  it('wakes a parked consumer when ANOTHER context enqueues', async () => {
    // IndexedDB has no cross-context change notification, so a parked sender
    // in an idle tab would otherwise sit until its own next enqueue or
    // reconnect — while another tab's record (possibly from a tab that then
    // died) waits undelivered.
    const name = `shared-${++storeCounter}`;
    const tabA = new IndexedDBQueue(name);
    const tabB = new IndexedDBQueue(name);
    await Promise.all([tabA.initialize(), tabB.initialize()]);

    let resolved = null;
    const parked = tabA.leaseNext().then(v => { resolved = v; });
    await settle();
    expect(resolved).toBe(null);

    tabB.enqueue('from-B');
    await parked;
    expect(resolved).toEqual({ seq: 1, item: 'from-B' });
  });

  it('wakes with the LOWEST unleased record, not the one that woke it (§3)', async () => {
    // The ablated hand-off: a parked consumer was resolved with the record
    // whose arrival woke it. Here tab B writes seq 2 while tab A is parked and
    // unaware; tab A's own enqueue (seq 3) is what wakes it. A hand-off gives
    // tab A seq 3 and jumps its cursor past seq 2 — which then goes unsent
    // until the next rewind. The store, not the waker, decides what is next.
    const name = `shared-${++storeCounter}`;
    const tabA = new IndexedDBQueue(name);
    const tabB = new IndexedDBQueue(name);
    await Promise.all([tabA.initialize(), tabB.initialize()]);

    tabA.enqueue('first');
    await settle();
    await tabA.leaseNext();                           // A's cursor at 1

    let resolved = null;
    const parked = tabA.leaseNext().then(v => { resolved = v; });
    await settle();
    expect(resolved).toBe(null);

    tabB.enqueue('from-B');                           // seq 2, unseen by A
    tabA.enqueue('from-A');                           // seq 3, wakes A
    await parked;

    expect(resolved).toEqual({ seq: 2, item: 'from-B' });
  });

  it('a rewind landing mid-scan is re-read, not overwritten', async () => {
    // leaseNext reads the cursor, awaits a scan, and writes the cursor back.
    // A rewind that lands inside that window is undone by the write-back: the
    // cursor jumps forward again and the records below it are skipped —
    // silently, and with the flush barrier counting them as leased. Only the
    // async backend can be caught mid-scan, so this lives here rather than in
    // the shared contract above.
    const q = new IndexedDBQueue(`rewind-race-${++storeCounter}`);
    await q.initialize();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    await settle();
    await q.leaseNext(); await q.leaseNext();          // cursor at 2

    const inFlight = q.leaseNext();                    // scan from 2 — will hit 3
    q.rewind();                                        // reconnect, mid-scan

    // Without the re-read, the scan's write-back sets the cursor to 3 and
    // returns 'c': the rewind is lost and 'a' and 'b' never resend.
    expect(await inFlight).toEqual({ seq: 1, item: 'a' });
    expect(await q.leaseNext()).toEqual({ seq: 2, item: 'b' });
  });

  it("one context's confirm does not disturb the other's cursor", async () => {
    const name = `shared-${++storeCounter}`;
    const tabA = new IndexedDBQueue(name);
    const tabB = new IndexedDBQueue(name);
    await Promise.all([tabA.initialize(), tabB.initialize()]);

    tabA.enqueue('one'); tabA.enqueue('two');
    await settle();

    expect(await tabA.leaseNext()).toEqual({ seq: 1, item: 'one' });
    tabA.confirm([1]);                                // A's ack landed
    await settle();

    // B never leased anything, so it still owes both — minus the one the
    // server demonstrably has.
    expect(await tabB.leaseNext()).toEqual({ seq: 2, item: 'two' });
    expect(await tabB.unconfirmedCount()).toBe(1);
  });
});

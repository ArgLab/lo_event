/*
 * The in-memory queue backend. Used for:
 * - the front desk (loEvent's in-process hand-off buffer — always in-memory);
 * - the outbox where IndexedDB is unavailable (Node, tests, SSR) — being
 *   honest about what that drops: no durability, no cross-context sharing,
 *   and storage ids restart per instance (acceptable only because an
 *   instance's lifetime is one JS context — L4).
 *
 * It implements both read disciplines (see QueueBackend in types.ts):
 *   - dequeue():   destructive take (delete-on-read) — the front desk;
 *   - leaseNext()/confirm()/rewind(): non-destructive lease — the outbox.
 * A given instance uses ONE discipline, and holds at most one parked
 * consumer: both loops are serial by construction.
 *
 * Wake discipline (§3): a parked leaseNext() is woken by RE-RUNNING the scan
 * for the lowest unleased stored id — never by handing it the item whose
 * arrival woke it. On a shared store the waker is not necessarily the next
 * record. A memory store has exactly one writer today, so hand-off would be
 * safe here — but this backend and IndexedDB are tested against one contract,
 * and the contract is the re-scan.
 */
import type { LeasedItem } from './types.js';

interface Entry { seq: number; payload: unknown; }

export class Queue {
  /** Stored entries, always in ascending seq (enqueue appends an increasing
   *  seq; confirm filters order-preservingly). */
  private items: Entry[] = [];
  private nextSeq = 1;
  /** Highest seq handed out by leaseNext(). leaseNext() returns the lowest
   *  stored item with seq > leasedThrough; rewind() resets it so unconfirmed
   *  items are re-handed. Per-instance and in-memory on purpose: a lease is a
   *  claim about this session's sending progress, not a fact about the world. */
  private leasedThrough = 0;
  private parkedDequeue: ((value: unknown) => void) | null = null;
  private parkedLease: ((value: LeasedItem) => void) | null = null;

  constructor (private readonly queueName: string) {
    this.enqueue = this.enqueue.bind(this);
    this.dequeue = this.dequeue.bind(this);
    this.leaseNext = this.leaseNext.bind(this);
    this.confirm = this.confirm.bind(this);
    this.rewind = this.rewind.bind(this);
    this.unconfirmedCount = this.unconfirmedCount.bind(this);
  }

  enqueue (item: unknown) {
    this.items.push({ seq: this.nextSeq++, payload: item });
    this.wake();
  }

  dequeue (): unknown | Promise<unknown> {
    if (this.items.length > 0) {
      return (this.items.shift() as Entry).payload;
    }
    return new Promise(resolve => { this.parkedDequeue = resolve; });
  }

  leaseNext (): Promise<LeasedItem> {
    const next = this.items.find(e => e.seq > this.leasedThrough);
    if (next) {
      this.leasedThrough = next.seq;
      return Promise.resolve({ seq: next.seq, item: next.payload });
    }
    return new Promise<LeasedItem>(resolve => { this.parkedLease = resolve; });
  }

  /** Delete exactly the listed seqs — never a range (L1). */
  confirm (seqs: number[]) {
    if (!seqs.length) return;
    const drop = new Set(seqs);
    this.items = this.items.filter(e => !drop.has(e.seq));
  }

  /** Cursor to the bottom; unconfirmed records re-lease. Wakes a parked
   *  consumer (everything had been leased) so the resend starts immediately. */
  rewind () {
    this.leasedThrough = 0;
    this.wake();
  }

  /** Re-run the scan for whoever is parked. The store is the only authority
   *  on "next" — the waker is never handed around it (§3).
   *
   *  The scan is deferred a microtask so it reads the cursor AFTER any
   *  same-tick follow-up: at socket open the metadata preamble is enqueued
   *  and then rewind() runs (§5 step order), and a consumer parked with the
   *  previous connection's cursor must be handed the post-rewind lowest
   *  record — the recovered backlog — not the preamble that woke it. (The
   *  IndexedDB backend gets this for free: its wake re-runs an async scan
   *  that resolves after the rewind anyway.) */
  private wake () {
    queueMicrotask(() => {
      if (this.parkedDequeue) {
        if (this.items.length === 0) return;
        const resolve = this.parkedDequeue;
        this.parkedDequeue = null;
        resolve((this.items.shift() as Entry).payload);
        return;
      }
      if (this.parkedLease) {
        const next = this.items.find(e => e.seq > this.leasedThrough);
        if (!next) return;
        const resolve = this.parkedLease;
        this.parkedLease = null;
        this.leasedThrough = next.seq;
        resolve({ seq: next.seq, item: next.payload });
      }
    });
  }

  unconfirmedCount (): number {
    return this.items.length;
  }

  /** Highest stored seq, or null when empty — the barrier watermark. */
  async maxSeq (): Promise<number | null> {
    return this.items.length ? this.items[this.items.length - 1].seq : null;
  }

  /** Stored records at or below `seq` that this instance has not leased —
   *  the barrier question itself (§7). */
  async unleasedAtOrBelow (seq: number): Promise<number> {
    return this.items.filter(e => e.seq > this.leasedThrough && e.seq <= seq).length;
  }

  async inspect (limit: number): Promise<unknown[]> {
    return this.items.slice(0, limit).map(e => ({ seq: e.seq, payload: e.payload }));
  }

  /** Drop everything, unsent included — junk stores and the permanent
   *  opt-out only (§5). The seq counter deliberately does NOT reset: storage
   *  ids are never reused (L4). */
  clear () {
    this.items = [];
    this.leasedThrough = 0;
  }
}

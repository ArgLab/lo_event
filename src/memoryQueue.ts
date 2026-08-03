/**
 * An in-memory queue backend. It implements the same contract as the IndexedDB
 * backend and is tested through the same suite (tests/queueContract.test.js),
 * but be honest about what it drops: no durability, no cross-context sharing
 * (the whole tab-close recovery story disappears), and storage ids restart per
 * instance (§2).
 *
 * It is the right choice in three places: Node and tests (no IndexedDB), dev
 * (where persisting events from buggy code is a nuisance), and loEvent's front
 * desk, which is a hand-off buffer rather than a durable store (§5).
 *
 * Two read disciplines live here, and an instance uses exactly one:
 *   - leaseNext()/confirm()/rewind() — the outbox discipline. Nothing is
 *     deleted until someone signs for it.
 *   - dequeue() — destructive take, for the front desk only.
 */
import type { LeasedItem } from './types.js';

interface Entry { seq: number; payload: unknown; }

export class Queue {
  private items: Entry[] = [];
  private readonly queueName: string;
  /** Never rewinds, not even across clear(): storage ids are never reused (L4),
   *  so a stale in-flight entry can never come to name a fresh record. */
  private nextSeq = 1;
  /** Highest seq handed out by leaseNext() *by this instance*. In-memory and
   *  per-instance on purpose: a lease is a claim about this session's sending
   *  progress, not a fact about the world (§3). */
  private leasedThrough = 0;
  /** A single parked consumer waiting on a queue with nothing to hand out. */
  private waiter: { resolve: (value: any) => void; lease: boolean } | null = null;

  constructor (queueName: string) {
    this.queueName = queueName;

    this.enqueue = this.enqueue.bind(this);
    this.dequeue = this.dequeue.bind(this);
    this.leaseNext = this.leaseNext.bind(this);
    this.confirm = this.confirm.bind(this);
    this.rewind = this.rewind.bind(this);
    this.unconfirmedCount = this.unconfirmedCount.bind(this);
  }

  async initialize () {}

  enqueue (item: unknown) {
    this.items.push({ seq: this.nextSeq++, payload: item });
    this.wake();
  }

  /**
   * Wake a parked consumer by RE-RUNNING ITS SCAN, never by handing it the
   * record that woke it. The store is the only authority on what comes next
   * (§3) — and on the destructive path, a hand-off also let items skip storage
   * entirely, which is how "durable" records routinely never got written.
   */
  private wake () {
    const waiter = this.waiter;
    if (!waiter) return;

    if (waiter.lease) {
      const next = this.items.find(entry => entry.seq > this.leasedThrough);
      if (!next) return;
      this.waiter = null;
      this.leasedThrough = next.seq;
      waiter.resolve({ seq: next.seq, item: next.payload });
    } else {
      if (!this.items.length) return;
      this.waiter = null;
      waiter.resolve((this.items.shift() as Entry).payload);
    }
  }

  /** Destructive take (front desk only). Parks when empty. */
  dequeue (): unknown | Promise<unknown> {
    if (this.items.length > 0) return (this.items.shift() as Entry).payload;
    return new Promise((resolve) => { this.waiter = { resolve, lease: false }; });
  }

  /** Hand out the lowest stored seq above the cursor WITHOUT deleting it.
   *  Parks when there is nothing new. */
  leaseNext (): Promise<LeasedItem> {
    const next = this.items.find(entry => entry.seq > this.leasedThrough);
    if (next) {
      this.leasedThrough = next.seq;
      return Promise.resolve({ seq: next.seq, item: next.payload });
    }
    return new Promise<LeasedItem>((resolve) => { this.waiter = { resolve, lease: true }; });
  }

  /** Delete EXACTLY these ids. Never a range: on a shared store a cumulative
   *  delete takes other senders' unsent records with it — data loss, not a
   *  duplicate (L1). */
  confirm (seqs: number[]) {
    if (!seqs.length) return;
    const drop = new Set(seqs);
    this.items = this.items.filter(entry => !drop.has(entry.seq));
  }

  /** Cursor to the bottom: everything still stored re-leases, and therefore
   *  resends. Called on every reconnect. */
  rewind () {
    this.leasedThrough = 0;
    this.wake();
  }

  unconfirmedCount (): number { return this.items.length; }

  /** Highest stored seq (the flush barrier's watermark), or null if empty. */
  async maxSeq (): Promise<number | null> {
    return this.items.length ? this.items[this.items.length - 1].seq : null;
  }

  /** Stored records at or below `seq` that this instance has not leased — the
   *  flush barrier question itself (§7). */
  async unleasedAtOrBelow (seq: number): Promise<number> {
    return this.items.filter(entry => entry.seq > this.leasedThrough && entry.seq <= seq).length;
  }

  /** DEBUG: peek without leasing or deleting. */
  async inspect (limit: number): Promise<unknown[]> {
    return this.items.slice(0, limit).map(entry => ({ seq: entry.seq, payload: entry.payload }));
  }

  /** DEBUG / RECOVERY: drop everything, unsent included (§10). */
  clear () {
    this.items = [];
    this.leasedThrough = 0;
  }
}

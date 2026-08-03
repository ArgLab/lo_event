/*
 * This is a small in-memory queue class. It is designed to:
 * - Allow us to experiment with interfaces, as we try to abstract the queue out of lo_event, websocket, etc., without moving all the indexeddb code
 * - Works everywhere / act as a fallback where indexeddb is unavailable
 * - Nice for dev, where we don't want to persist events from buggy code
 * - Nice for simple use-cases
 *
 * It implements two dequeue disciplines (see QueueBackend in types.ts):
 *   - dequeue():   destructive take (delete-on-read).
 *   - leaseNext()/confirm()/rewind(): non-destructive lease for the ack
 *     protocol — an item stays until confirm()ed, and rewind() re-hands
 *     everything unconfirmed.
 * A given instance should use one discipline, not both.
 */
import type { LeasedItem } from './types.js';

interface Entry { seq: number; payload: unknown; }

export class Queue {
  private items: Entry[];
  private readonly queueName: string;
  private nextSeq: number;
  // Highest seq handed out by leaseNext() this session. leaseNext() returns
  // the lowest stored item with seq > leasedThrough; rewind() resets it so
  // unconfirmed items are re-handed.
  private leasedThrough: number;
  // A single parked consumer (dequeue or leaseNext) waiting on an empty queue.
  private waiter: { resolve: (value: unknown) => void; lease: boolean } | null;

  constructor (queueName: string) {
    this.items = [];
    this.queueName = queueName;
    this.nextSeq = 1;
    this.leasedThrough = 0;
    this.waiter = null;

    this.enqueue = this.enqueue.bind(this);
    this.dequeue = this.dequeue.bind(this);
    this.leaseNext = this.leaseNext.bind(this);
    this.confirm = this.confirm.bind(this);
    this.rewind = this.rewind.bind(this);
    this.unconfirmedCount = this.unconfirmedCount.bind(this);
  }

  async initialize () {
  }

  async inspect (limit: number): Promise<unknown[]> {
    return this.items.slice(0, limit).map(e => ({ seq: e.seq, payload: e.payload }));
  }

  clear () {
    this.items = [];
    this.leasedThrough = 0;
  }

  enqueue (item: unknown) {
    this.items.push({ seq: this.nextSeq++, payload: item });
    this.wake();
  }

  /** Wake by re-running the queue's normal scan. Direct hand-off can advance a
   * cursor past an older record and violates the shared backend contract. */
  private wake () {
    const waiter = this.waiter;
    if (!waiter) return;
    if (waiter.lease) {
      const next = this.items.find(entry => entry.seq > this.leasedThrough);
      if (!next) return;
      this.waiter = null;
      this.leasedThrough = next.seq;
      waiter.resolve({ seq: next.seq, item: next.payload });
      return;
    }
    if (!this.items.length) return;
    this.waiter = null;
    waiter.resolve(this.items.shift()!.payload);
  }

  dequeue (): unknown | Promise<unknown> {
    if (this.items.length > 0) {
      return (this.items.shift() as Entry).payload;
    }
    return new Promise((resolve) => {
      this.waiter = { resolve, lease: false };
    });
  }

  leaseNext (): Promise<LeasedItem> {
    const next = this.items.find(e => e.seq > this.leasedThrough);
    if (next) {
      this.leasedThrough = next.seq;
      return Promise.resolve({ seq: next.seq, item: next.payload });
    }
    return new Promise<LeasedItem>((resolve) => {
      this.waiter = { resolve: resolve as (value: unknown) => void, lease: true };
    });
  }

  confirm (seqs: number[]) {
    if (!seqs.length) return;
    const drop = new Set(seqs);
    this.items = this.items.filter(e => !drop.has(e.seq));
  }

  rewind () {
    this.leasedThrough = 0;
    this.wake();
  }

  unconfirmedCount (): number {
    return this.items.length;
  }

  /** Highest stored seq (items are kept in ascending seq), or null if empty. */
  async maxSeq (): Promise<number | null> {
    return this.items.length ? this.items[this.items.length - 1].seq : null;
  }

  /** Stored records at or below `seq` that this instance has not leased. */
  async unleasedAtOrBelow (seq: number): Promise<number> {
    return this.items.filter(e => e.seq > this.leasedThrough && e.seq <= seq).length;
  }
}

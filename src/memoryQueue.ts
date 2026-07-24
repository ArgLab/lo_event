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
  private queueName: string;
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

  enqueue (item: unknown) {
    const entry: Entry = { seq: this.nextSeq++, payload: item };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      if (w.lease) {
        // Lease discipline: store it (confirm/rewind need it) AND hand it out.
        this.items.push(entry);
        this.leasedThrough = entry.seq;
        w.resolve({ seq: entry.seq, item: entry.payload });
      } else {
        // Destructive discipline: hand straight to the waiter, don't store.
        w.resolve(entry.payload);
      }
      return;
    }
    this.items.push(entry);
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

  confirm (uptoSeq: number) {
    this.items = this.items.filter(e => e.seq > uptoSeq);
  }

  rewind () {
    // items are stored in ascending seq (enqueue appends increasing seq;
    // confirm filters order-preservingly), so items[0] is the lowest — no need
    // to scan/spread the whole array.
    if (this.items.length === 0) { this.leasedThrough = 0; return; }
    const first = this.items[0];
    this.leasedThrough = first.seq - 1;
    // If a lease consumer is parked (everything had been leased, nothing left
    // to hand out), wake it with the earliest still-stored item so the resend
    // starts immediately rather than waiting for a fresh enqueue.
    if (this.waiter && this.waiter.lease) {
      const w = this.waiter;
      this.waiter = null;
      this.leasedThrough = first.seq;
      w.resolve({ seq: first.seq, item: first.payload });
    }
  }

  unconfirmedCount (): number {
    return this.items.length;
  }
}

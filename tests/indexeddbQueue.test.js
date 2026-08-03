import { beforeAll, describe, expect, it } from 'vitest';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { Queue } from '../src/indexeddbQueue.js';
import { queueContract } from './queueContract.js';

beforeAll(() => {
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
});

const name = label => `reliable-delivery-${label}-${crypto.randomUUID()}`;

queueContract('IndexedDB', label => new Queue(name(`shared-${label}`)));

describe('IndexedDB outbox contract', () => {
  it('leases without deleting and confirms only explicit ids', async () => {
    const queue = new Queue(name('lease'));
    queue.enqueue('a');
    queue.enqueue('b');
    expect(await queue.leaseNext()).toEqual({ seq: 1, item: 'a' });
    expect(await queue.leaseNext()).toEqual({ seq: 2, item: 'b' });
    expect(await queue.unconfirmedCount()).toBe(2);
    queue.confirm([1]);
    expect(await queue.unconfirmedCount()).toBe(1);
    queue.rewind();
    expect(await queue.leaseNext()).toEqual({ seq: 2, item: 'b' });
  });

  it('a parked lease wakes by rescanning committed storage', async () => {
    const queue = new Queue(name('park'));
    const waiting = queue.leaseNext();
    queue.enqueue('later');
    expect(await waiting).toEqual({ seq: 1, item: 'later' });
  });

  it('polling discovers an enqueue committed by another context', async () => {
    const database = name('cross-tab');
    const firstTab = new Queue(database);
    const secondTab = new Queue(database);
    const waiting = firstTab.leaseNext();
    secondTab.enqueue('other-tab');
    await secondTab.unconfirmedCount();
    expect(await waiting).toEqual({ seq: 1, item: 'other-tab' });
  });

  it('a rewind racing an in-progress scan cannot be overwritten', async () => {
    const queue = new Queue(name('rewind-race'));
    queue.enqueue('first');
    queue.enqueue('second');
    expect((await queue.leaseNext()).seq).toBe(1);

    const racingLease = queue.leaseNext();
    queue.rewind();
    expect(await racingLease).toEqual({ seq: 1, item: 'first' });
  });

  it('one sender cannot range-delete another sender\'s records', async () => {
    const database = name('explicit-confirm');
    const firstTab = new Queue(database);
    const secondTab = new Queue(database);
    for (const item of ['A1', 'B1', 'A2', 'B2']) firstTab.enqueue(item);
    await firstTab.unconfirmedCount();
    secondTab.confirm([1, 3]);
    expect(await secondTab.unconfirmedCount()).toBe(2);
    secondTab.rewind();
    expect(await secondTab.leaseNext()).toEqual({ seq: 2, item: 'B1' });
    expect(await secondTab.leaseNext()).toEqual({ seq: 4, item: 'B2' });
  });
});

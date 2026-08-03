import { describe, expect, it } from 'vitest';

/** The exact contract every outbox backend must satisfy. Backend-specific tests
 * cover persistence and cross-context behavior separately. */
export function queueContract (label, createQueue) {
  describe(`${label} shared outbox contract`, () => {
    it('leases in order without deleting', async () => {
      const queue = createQueue('lease');
      queue.enqueue('a');
      queue.enqueue('b');
      expect(await queue.leaseNext()).toEqual({ seq: 1, item: 'a' });
      expect(await queue.leaseNext()).toEqual({ seq: 2, item: 'b' });
      expect(await queue.unconfirmedCount()).toBe(2);
    });

    it('confirms only explicitly named storage ids', async () => {
      const queue = createQueue('confirm');
      for (const item of ['a', 'b', 'c']) queue.enqueue(item);
      await queue.unconfirmedCount();
      queue.confirm([1, 3]);
      expect(await queue.unconfirmedCount()).toBe(1);
      queue.rewind();
      expect(await queue.leaseNext()).toEqual({ seq: 2, item: 'b' });
    });

    it('rewind re-hands unconfirmed records', async () => {
      const queue = createQueue('rewind');
      queue.enqueue('a');
      expect(await queue.leaseNext()).toEqual({ seq: 1, item: 'a' });
      queue.rewind();
      expect(await queue.leaseNext()).toEqual({ seq: 1, item: 'a' });
    });

    it('a parked consumer wakes through the normal scan', async () => {
      const queue = createQueue('park');
      const waiting = queue.leaseNext();
      queue.enqueue('later');
      expect(await waiting).toEqual({ seq: 1, item: 'later' });
    });

    it('answers the watermark predicate and ignores later live traffic', async () => {
      const queue = createQueue('barrier');
      queue.enqueue('backlog');
      const watermark = await queue.maxSeq();
      queue.enqueue('live');
      expect(await queue.unleasedAtOrBelow(watermark)).toBe(1);
      await queue.leaseNext();
      expect(await queue.unleasedAtOrBelow(watermark)).toBe(0);
    });

    it('clear removes records without reusing their storage ids', async () => {
      const queue = createQueue('clear');
      queue.enqueue('first');
      queue.enqueue('second');
      await queue.unconfirmedCount();
      queue.clear();
      await queue.unconfirmedCount();
      queue.enqueue('third');

      expect(await queue.maxSeq()).toBeGreaterThan(2);
    });
  });
}

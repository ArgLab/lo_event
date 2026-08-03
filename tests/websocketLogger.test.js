/*
 * Adapter-level tests: the wiring on the far side of the sans-I/O seam.
 *
 * Round one proved that every defect lands here, not in the pure engine — the
 * engine tests all passed while two of three adapters gated admission on the
 * disabler and one killed its lease loop on the first storage error. So these
 * tests drive the real websocketLogger against a scripted fake socket and
 * assert the ORDERING facts the engine cannot see:
 *
 *   - the connection-start backlog reaches the wire before fetch_blob;
 *   - admission proceeds while the disabler is engaged (events reach the
 *     outbox; only sending pauses);
 *   - durable mode holds records until the identity ack; autoack drains on
 *     send and ignores acks and asks for no snapshot.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { websocketLogger } from '../src/websocketLogger.js';
import { QueueType } from '../src/queue.js';

class FakeWebSocket {
  static instances = [];

  constructor (url) {
    this.url = url;
    this.readyState = 0;           // CONNECTING
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send (frame) {
    if (this.readyState !== 1) throw new Error('send on a non-OPEN socket');
    this.sent.push(JSON.parse(frame));
  }

  close () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  // ── test-side controls ──
  open () { this.readyState = 1; this.onopen?.(); }
  message (obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil (predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await delay(20);
  }
}

/** Build a logger on the fake socket; returns helpers around it. */
async function startLogger (options = {}) {
  const logger = websocketLogger('ws://fake', {
    namespace: `t${Date.now()}.${Math.random()}`,
    queueType: QueueType.IN_MEMORY,
    ...options
  });
  await logger.init();
  await waitUntil(() => FakeWebSocket.instances.length > 0);
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  return { logger, socket };
}

beforeEach(() => {
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
});

describe('websocketLogger, durable profile', () => {
  it('sends the connection-start backlog before fetch_blob, and holds records until their identity ack', async () => {
    const { logger, socket } = await startLogger();
    logger(JSON.stringify({ event: 'answer', qid: 'q1' }));
    logger(JSON.stringify({ event: 'answer', qid: 'q2' }));

    socket.open();
    await waitUntil(() => socket.sent.some(f => f.event === 'fetch_blob'));

    // The two backlog events left before the snapshot request (§7).
    const kinds = socket.sent.map(f => f.event);
    expect(kinds.indexOf('fetch_blob')).toBeGreaterThan(kinds.lastIndexOf('answer'));
    expect(kinds.filter(k => k === 'answer')).toHaveLength(2);

    // Sent is not safe: both records still wait for their acks (L2).
    expect(await logger.unackedCount()).toBe(2);

    // Acks name identities; each confirms exactly its record (L4).
    const [first, second] = socket.sent.filter(f => f.event === 'answer');
    socket.message({ status: 'ack', id: first.metadata.eventId });
    await waitUntil(async () => await logger.unackedCount() === 1);
    socket.message({ status: 'ack', id: 'nobody.sent.this' });   // ignored
    await delay(50);
    expect(await logger.unackedCount()).toBe(1);
    socket.message({ status: 'ack', id: second.metadata.eventId });
    await waitUntil(async () => await logger.unackedCount() === 0);
  });

  it('REGRESSION: admission never blocks on the disabler — a blocked client keeps accepting and storing; only sending pauses (§5)', async () => {
    // Round 1: two of three rebuilds kept a disabler gate on the hop BEFORE
    // durability, so a temporary block held events in a non-durable buffer —
    // a loss window if the tab closed. Here the block must pause the wire
    // and nothing else.
    const { logger, socket } = await startLogger();
    socket.open();
    await waitUntil(() => socket.sent.some(f => f.event === 'fetch_blob'));
    const sentBefore = socket.sent.length;

    // A temporary block (numeric limit, ms). MAINTAIN = hold, don't drop.
    socket.message({ status: 'blocklist', message: 'rate limited', time_limit: 400, action: 'MAINTAIN' });
    await delay(50);

    logger(JSON.stringify({ event: 'answer', qid: 'q-blocked' }));
    await delay(150);

    expect(socket.sent.length).toBe(sentBefore);            // nothing reached the wire…
    expect(await logger.unackedCount()).toBe(1);            // …but the event is safely stored

    // The block expires; the stored record drains.
    await waitUntil(() => socket.sent.some(f => f.qid === 'q-blocked'));
  });

  it('refuses reserved protocol names with a throw (§12)', async () => {
    const { logger } = await startLogger();
    expect(() => logger(JSON.stringify({ event: 'fetch_blob' }))).toThrow(/reserved/);
    expect(() => logger(JSON.stringify({ event: 'save_blob' }))).toThrow(/reserved/);
    expect(() => logger(JSON.stringify({ event: 'lock_fields' }))).toThrow(/reserved/);
  });

  it('stamps a direct caller\'s unstamped frame at admission — nothing unackable enters the outbox (L5)', async () => {
    const { logger, socket } = await startLogger();
    logger(JSON.stringify({ event: 'bare' }));
    socket.open();
    await waitUntil(() => socket.sent.some(f => f.event === 'bare'));
    const frame = socket.sent.find(f => f.event === 'bare');
    expect(typeof frame.metadata.eventId).toBe('string');
  });
});

describe('websocketLogger, send-and-forget profile (autoack: true)', () => {
  it('confirms on send, ignores acks, and asks for no snapshot by default', async () => {
    const { logger, socket } = await startLogger({ autoack: true });
    logger(JSON.stringify({ event: 'pageview' }));
    socket.open();

    await waitUntil(() => socket.sent.some(f => f.event === 'pageview'));
    await waitUntil(async () => await logger.unackedCount() === 0);   // signed its own receipt

    // A server may still ack; a send-and-forget client ignores it (§12).
    const frame = socket.sent.find(f => f.event === 'pageview');
    socket.message({ status: 'ack', id: frame.metadata.eventId });
    await delay(50);
    expect(await logger.unackedCount()).toBe(0);
    expect(socket.sent.some(f => f.event === 'fetch_blob')).toBe(false);
  });
});

describe('reconnect', () => {
  it('resends an unacked record with the SAME identity on the next connection (L6), and does not re-ask a fulfilled snapshot', async () => {
    const { logger, socket } = await startLogger();
    logger(JSON.stringify({ event: 'answer', qid: 'q1' }));
    socket.open();
    await waitUntil(() => socket.sent.some(f => f.event === 'fetch_blob'));
    socket.message({ status: 'fetch_blob', data: { some: 'state' } });
    await delay(50);
    const firstSend = socket.sent.find(f => f.event === 'answer');

    // The connection dies before the ack; the record must survive.
    socket.close();
    await waitUntil(() => FakeWebSocket.instances.length >= 2, 20000);
    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    second.open();

    await waitUntil(() => second.sent.some(f => f.event === 'answer'));
    const resend = second.sent.find(f => f.event === 'answer');
    expect(resend.metadata.eventId).toBe(firstSend.metadata.eventId);   // same identity, that is the point of acks
    expect(second.sent.some(f => f.event === 'fetch_blob')).toBe(false); // snapshot already fulfilled (§6)
  });
});

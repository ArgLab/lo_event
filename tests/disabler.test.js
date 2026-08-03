/*
 * Disabler races and delivery resilience, at the adapter level.
 *
 * These tests poison module-global state (the disabler singleton, spied
 * queue prototypes), so each builds a fresh module world via
 * vi.resetModules() + dynamic import — nothing leaks between tests or into
 * other files.
 *
 * The REGRESSION tests pin defects found in adversarial review of this
 * rebuild's siblings — bugs that survived their authors' own suites:
 *
 *   - A blocklist frame arriving while disabler.retry() slept out an EARLIER
 *     temporary block was erased when the stale retry() woke and
 *     unconditionally reset state — in the worst case un-doing a permanent
 *     privacy opt-out and resuming sending through it.
 *   - A lease loop with no exception handling died permanently on the first
 *     storage error: events kept accumulating durably, nothing ever sent
 *     again, no recovery short of a reload.
 *   - A block persisted by a previous session was not re-engaged at startup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

class FakeWebSocket {
  static instances = [];

  constructor (url) {
    this.url = url;
    this.readyState = 0;
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

/** A fresh module world: fresh disabler state, fresh logger module. */
async function freshWorld () {
  vi.resetModules();
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];
  const disabler = await import('../src/disabler.js');
  const { websocketLogger } = await import('../src/websocketLogger.js');
  const { QueueType, Queue } = await import('../src/queue.js');
  return { disabler, websocketLogger, QueueType, Queue };
}

async function startLogger (websocketLogger, QueueType, options = {}) {
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
  vi.restoreAllMocks();
});

describe('blocklist upgrades during a wait', () => {
  it('REGRESSION: a permanent opt-out arriving mid-temporary-block engages, clears the outbox, and is not erased by the stale wait', async () => {
    const { websocketLogger, QueueType } = await freshWorld();
    const { logger, socket } = await startLogger(websocketLogger, QueueType);
    socket.open();
    await waitUntil(() => socket.sent.some(f => f.event === 'fetch_blob'));

    // A short temporary block starts a retry() sleep…
    socket.message({ status: 'blocklist', message: 'rate limited', time_limit: 250, action: 'MAINTAIN' });
    await delay(50);
    logger(JSON.stringify({ event: 'answer', qid: 'held' }));
    await delay(50);
    expect(await logger.unackedCount()).toBe(1);   // stored, not sent

    // …and a permanent privacy opt-out lands while that sleep is running.
    socket.message({ status: 'blocklist', message: 'opt out', time_limit: 'PERMANENT', action: 'DROP' });
    await waitUntil(async () => await logger.unackedCount() === 0);   // backlog discarded (§5)

    // The stale temporary wait expires. It must NOT reset the opt-out and
    // resume sending: nothing new reaches the wire, ever.
    const sentBefore = socket.sent.length;
    logger(JSON.stringify({ event: 'answer', qid: 'after-optout' }));
    await delay(500);   // well past the 250ms temporary expiry
    expect(socket.sent.length).toBe(sentBefore);
  });

  it('a longer second temporary block extends the wait instead of being cut short by the first', async () => {
    const { websocketLogger, QueueType } = await freshWorld();
    const { logger, socket } = await startLogger(websocketLogger, QueueType);
    socket.open();
    await waitUntil(() => socket.sent.some(f => f.event === 'fetch_blob'));

    socket.message({ status: 'blocklist', message: 'short', time_limit: 150, action: 'MAINTAIN' });
    await delay(30);
    socket.message({ status: 'blocklist', message: 'longer', time_limit: 700, action: 'MAINTAIN' });
    await delay(30);
    logger(JSON.stringify({ event: 'answer', qid: 'q-extended' }));

    await delay(300);   // past the first block's expiry, inside the second's
    expect(socket.sent.some(f => f.qid === 'q-extended')).toBe(false);

    // After the second block expires, the stored record drains.
    await waitUntil(() => socket.sent.some(f => f.qid === 'q-extended'));
  });
});

describe('a block persisted before this session', () => {
  it('REGRESSION: gates sending at startup instead of silently resuming', async () => {
    const { disabler, websocketLogger, QueueType } = await freshWorld();
    // A previous session stored a permanent hold; this session finds it at
    // disabler.init() time (simulated here by engaging the module state
    // before the logger initializes).
    disabler.handleBlockError(new disabler.BlockError('contract hold', 'PERMANENT', 'MAINTAIN'));

    const { logger, socket } = await startLogger(websocketLogger, QueueType);
    logger(JSON.stringify({ event: 'answer', qid: 'held-at-startup' }));
    socket.open();
    await delay(200);

    expect(await logger.unackedCount()).toBe(1);   // accepted and stored…
    expect(socket.sent.filter(f => f.event === 'answer')).toHaveLength(0);   // …never sent
  });
});

describe('delivery resilience', () => {
  it('REGRESSION: the lease loop survives a failing store — one storage error must not kill delivery forever', async () => {
    const { websocketLogger, QueueType, Queue } = await freshWorld();
    // The first lease attempt rejects; the loop must log, rest, and retry.
    vi.spyOn(Queue.prototype, 'leaseNext').mockRejectedValueOnce(new Error('IDB cursor error'));

    const { logger, socket } = await startLogger(websocketLogger, QueueType);
    logger(JSON.stringify({ event: 'answer', qid: 'after-error' }));
    socket.open();

    await waitUntil(() => socket.sent.some(f => f.qid === 'after-error'));
  });
});

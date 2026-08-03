// The adapter: sockets, the outbox, and the wiring between them.
//
// The engine tests (protocol.test.js) prove the decisions are right. These
// prove the adapter *performs* them in the right order against a real queue —
// which is the layer where every bug found in the earlier rebuilds actually
// lived: a gate on the wrong side of the durable write, a lease issued before a
// rewind, a clear() on the wrong kind of block. None of those is visible in a
// pure-engine test.
//
// A fake socket stands in for the network, with the open/close/deliver moments
// under the test's control, so ordering is asserted rather than raced. Each
// test gets its own server URL and looks only at sockets for that URL: a logger
// has no stop(), so loggers from earlier tests go on reconnecting, and a
// "latest socket" that ignored the URL would sometimes hand back theirs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const NativeWebSocket = globalThis.WebSocket;

class FakeSocket {
  static instances = [];
  /** URLs whose sends should throw, standing in for a socket that the runtime
   *  still reports as OPEN but that cannot carry a frame. */
  static failSendFor = new Set();

  constructor (url) {
    this.url = url;
    this.readyState = 0;      // CONNECTING
    this.sent = [];           // parsed frames
    this.sentRaw = [];        // exactly what went on the wire
    FakeSocket.instances.push(this);
  }

  /** The handshake completed. Deliberately manual: half these tests are about
   *  what must happen between "socket open" and "first frame out". */
  open () {
    this.readyState = 1;
    this.onopen?.();
  }

  send (data) {
    if (this.readyState !== 1) throw new Error('send on a socket that is not OPEN');
    if (FakeSocket.failSendFor.has(this.url)) throw new Error('simulated send failure');
    this.sentRaw.push(String(data));
    // Unparseable payloads reach the wire too (L7); keep them out of `sent`
    // rather than letting the fake socket be stricter than a real one.
    try { this.sent.push(JSON.parse(String(data))); } catch { /* see sentRaw */ }
  }

  /** A server → client frame. */
  deliver (frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  /** The frames sent, by `event` name — ordering assertions read better. */
  events () {
    return this.sent.map(frame => frame.event);
  }
}

/** Fresh module state per test: the disabler is module-global, and a block set
 *  by one test would leak into the next. */
async function freshModules () {
  vi.resetModules();
  return {
    websocketLogger: (await import('../src/websocketLogger.js')).websocketLogger,
    disabler: await import('../src/disabler.js')
  };
}

const OPTIONS = { queueType: 'IN_MEMORY', namespace: 'test' };

/** The reconnect floor is 1s (§11's backoff, reset on success), so anything
 *  that waits for a second socket needs more room than waitFor's default. */
const RECONNECT_TIMEOUT = { timeout: 4000 };

let urlCounter = 0;

/** Start a logger on its own URL, and hand back a view of *its* sockets. */
async function startLogger (websocketLogger, options = {}) {
  const url = `ws://test-${++urlCounter}.invalid`;
  const logger = websocketLogger(url, { ...OPTIONS, ...options });
  await logger.init();
  const sockets = () => FakeSocket.instances.filter(socket => socket.url === url);
  await vi.waitFor(() => expect(sockets().length).toBeGreaterThan(0));
  return { logger, url, sockets, latest: () => sockets().at(-1) };
}

beforeEach(() => {
  globalThis.WebSocket = FakeSocket;
  FakeSocket.instances = [];
  FakeSocket.failSendFor = new Set();
});

afterEach(() => {
  globalThis.WebSocket = NativeWebSocket;
  vi.useRealTimers();
});

describe('durable delivery', () => {
  it('holds a sent record until its identity ack arrives (L2)', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    logger(JSON.stringify({ event: 'answer', metadata: { eventId: 'id-1' } }));
    await vi.waitFor(() => expect(socket.events()).toContain('answer'));
    expect(await logger.unackedCount()).toBe(1);      // sent, nobody has signed

    socket.deliver({ status: 'ack', id: 'id-1' });
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
  });

  it('an ack for an identity we never sent deletes nothing (L1)', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    logger(JSON.stringify({ event: 'answer', metadata: { eventId: 'mine' } }));
    await vi.waitFor(() => expect(socket.events()).toContain('answer'));

    socket.deliver({ status: 'ack', id: 'another-tabs-record' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await logger.unackedCount()).toBe(1);
  });

  it('resends everything unacked on the next connection (L10 — rewind first)', async () => {
    // The lease cursor is per-connection state that only rewind() moves back.
    // If the new connection leases before rewinding, the whole backlog looks
    // already-sent and is silently skipped — the worse of the two L10 failures.
    const { websocketLogger } = await freshModules();
    const { logger, sockets, latest } = await startLogger(websocketLogger);
    const first = latest();
    first.open();

    logger(JSON.stringify({ event: 'a', metadata: { eventId: 'id-a' } }));
    logger(JSON.stringify({ event: 'b', metadata: { eventId: 'id-b' } }));
    // The snapshot request rides this connection too (the store was empty when
    // it opened, so the barrier cleared at once); only the events matter here.
    await vi.waitFor(() => expect(first.events()).toContain('b'));
    expect(first.events().filter(event => event !== 'fetch_blob')).toEqual(['a', 'b']);

    first.close();                                     // both still unacked
    await vi.waitFor(() => expect(sockets().length).toBe(2), RECONNECT_TIMEOUT);
    const second = latest();
    second.open();

    await vi.waitFor(() => expect(second.events()).toContain('b'));
    expect(second.events().filter(event => event !== 'fetch_blob')).toEqual(['a', 'b']);
    expect(await logger.unackedCount()).toBe(2);

    // And the snapshot re-ask waits behind that recovered backlog (§7): this
    // connection started with one, so the ordering the barrier exists for is
    // observable here in a way it never is on a first, empty-store connection.
    await vi.waitFor(() => expect(second.events()).toContain('fetch_blob'));
    expect(second.events().indexOf('b')).toBeLessThan(second.events().indexOf('fetch_blob'));
  });

  it('a send that never went out is not confirmed, and recovers (L13)', async () => {
    // A send that throws on a socket the runtime still calls OPEN: the record
    // must stay stored, and the adapter must drop the unusable socket rather
    // than re-leasing against it forever.
    const { websocketLogger } = await freshModules();
    const { logger, url, sockets, latest } = await startLogger(websocketLogger);
    const first = latest();
    first.open();

    FakeSocket.failSendFor.add(url);
    logger(JSON.stringify({ event: 'answer', metadata: { eventId: 'id-1' } }));

    await vi.waitFor(() => expect(first.readyState).toBe(3));   // socket dropped
    expect(first.sent).toEqual([]);
    expect(await logger.unackedCount()).toBe(1);                // stored, unconfirmed

    FakeSocket.failSendFor.delete(url);
    await vi.waitFor(() => expect(sockets().length).toBe(2), RECONNECT_TIMEOUT);
    latest().open();
    await vi.waitFor(() => expect(latest().events()).toContain('answer'));
  });
});

describe('starting up', () => {
  it('init() is idempotent — a second call does not raise a second sender', async () => {
    // Two connection loops and two lease loops over one outbox means two
    // sockets from one context, both draining the same store. Nothing would
    // look broken — the store is *designed* to tolerate several senders across
    // tabs (§2) — it would just deliver everything twice from a context that
    // meant to deliver it once.
    const { websocketLogger } = await freshModules();
    const url = `ws://test-${++urlCounter}.invalid`;
    const logger = websocketLogger(url, OPTIONS);

    await Promise.all([logger.init(), logger.init()]);
    await logger.init();

    const sockets = () => FakeSocket.instances.filter(socket => socket.url === url);
    await vi.waitFor(() => expect(sockets().length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sockets()).toHaveLength(1);
  });
});

describe('send-and-forget delivery', () => {
  it('confirms on an OPEN-socket send and ignores server acks', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger, { autoack: true });
    const socket = latest();
    socket.open();

    logger(JSON.stringify({ event: 'telemetry', metadata: { eventId: 'id-t' } }));
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
    expect(socket.events()).toContain('telemetry');
  });

  it('asks for no state snapshot by default — telemetry has no UI waiting', async () => {
    const { websocketLogger } = await freshModules();
    const { latest } = await startLogger(websocketLogger, { autoack: true });
    const socket = latest();
    socket.open();

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(socket.events()).not.toContain('fetch_blob');
  });
});

describe('unnamed records (L7)', () => {
  it('stamps an unnamed frame at admission rather than storing it unackable', async () => {
    // Everything from logEvent() is already stamped; a caller wiring the
    // logger up directly is not. Stamping at the door keeps L7's accepted loss
    // window for genuinely legacy records instead of opening it for new writes.
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    logger(JSON.stringify({ event: 'unstamped', value: 1 }));
    await vi.waitFor(() => expect(socket.events()).toContain('unstamped'));

    const frame = socket.sent.find(sent => sent.event === 'unstamped');
    expect(frame.metadata?.eventId).toEqual(expect.any(String));
    // And it now behaves like any named record: held until its ack.
    expect(await logger.unackedCount()).toBe(1);
    socket.deliver({ status: 'ack', id: frame.metadata.eventId });
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
  });

  it('drains a stored record that cannot be named, best-effort', async () => {
    // A payload that does not parse cannot be stamped and can never be acked,
    // so waiting for one means resending it on every reconnect until the end of
    // time. It goes out once, is confirmed on send, and says so.
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    logger('{ this is not valid json');
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
    expect(socket.sentRaw).toContain('{ this is not valid json');
  });
});

describe('the state snapshot (§6, L11)', () => {
  it('sends fetch_blob on the socket, never through the outbox', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    await vi.waitFor(() => expect(socket.events()).toContain('fetch_blob'));
    expect(await logger.unackedCount()).toBe(0);      // it never entered the queue
  });

  it('leaves only after the backlog this connection started with (§7)', async () => {
    const { websocketLogger } = await freshModules();
    // Enqueued before init: a crash-recovered backlog, present at connect time.
    const url = `ws://test-${++urlCounter}.invalid`;
    const logger = websocketLogger(url, OPTIONS);
    logger(JSON.stringify({ event: 'recovered', metadata: { eventId: 'id-r' } }));
    await logger.init();

    const sockets = () => FakeSocket.instances.filter(socket => socket.url === url);
    await vi.waitFor(() => expect(sockets().length).toBe(1));
    const socket = sockets().at(-1);
    socket.open();

    await vi.waitFor(() => expect(socket.events()).toContain('fetch_blob'));
    expect(socket.events().indexOf('recovered')).toBeLessThan(socket.events().indexOf('fetch_blob'));
  });

  it('re-asks on a new connection while the answer has not come', async () => {
    const { websocketLogger } = await freshModules();
    const { sockets, latest } = await startLogger(websocketLogger);
    latest().open();
    await vi.waitFor(() => expect(latest().events()).toContain('fetch_blob'));

    latest().close();
    await vi.waitFor(() => expect(sockets().length).toBe(2), RECONNECT_TIMEOUT);
    latest().open();
    await vi.waitFor(() => expect(latest().events()).toContain('fetch_blob'));
  });

  it('stops asking once answered', async () => {
    const { websocketLogger } = await freshModules();
    const { sockets, latest } = await startLogger(websocketLogger);
    const first = latest();
    first.open();
    await vi.waitFor(() => expect(first.events()).toContain('fetch_blob'));
    first.deliver({ status: 'fetch_blob', data: {} });

    first.close();
    await vi.waitFor(() => expect(sockets().length).toBe(2), RECONNECT_TIMEOUT);
    const second = latest();
    second.open();

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(second.events()).not.toContain('fetch_blob');
  });

  it('re-asks an unanswered request after the timeout (§6, L17)', async () => {
    // A healthy-looking connection whose server never answers must not leave
    // the spinner up forever. This is also the one adapter-level proof that the
    // engine is actually being told that time passed: the clock has to be faked
    // before init(), because the ticker is created there.
    vi.useFakeTimers();
    const { websocketLogger } = await freshModules();
    const url = `ws://test-${++urlCounter}.invalid`;
    const logger = websocketLogger(url, OPTIONS);

    const started = logger.init();
    await vi.advanceTimersByTimeAsync(1);
    await started;

    const socket = FakeSocket.instances.filter(s => s.url === url).at(-1);
    socket.open();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.events().filter(event => event === 'fetch_blob')).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(11_000);
    expect(socket.events().filter(event => event === 'fetch_blob').length).toBeGreaterThan(1);
  });
});

describe('the session metadata preamble (§5 step 2, L6)', () => {
  it('goes out ahead of the events logged after it, freshly stamped each time', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, sockets, latest } = await startLogger(websocketLogger);
    logger.setField(JSON.stringify({
      event: 'lock_fields',
      fields: { source: 'test-app' },
      metadata: { eventId: 'id-lock' }
    }));

    const first = latest();
    first.open();
    await vi.waitFor(() => expect(first.events()).toContain('lock_fields'));

    logger(JSON.stringify({ event: 'after', metadata: { eventId: 'id-after' } }));
    await vi.waitFor(() => expect(first.events()).toContain('after'));
    expect(first.events().indexOf('lock_fields')).toBeLessThan(first.events().indexOf('after'));

    // Both halves of L6, on the next connection: a *resend* of a stored record
    // reuses that record's identity (that is what makes an ack able to name
    // it), while the new connection's preamble is a new record and mints a
    // fresh one. The bug this pins absorbed a stamped frame into the long-lived
    // fields dict and re-enqueued it, so an already-used identity re-entered
    // the store — and since one identity maps to one storage id, the ack could
    // only ever confirm one of the twins. The rest resent forever.
    first.close();
    await vi.waitFor(() => expect(sockets().length).toBe(2), RECONNECT_TIMEOUT);
    const second = latest();
    second.open();
    await vi.waitFor(() => expect(second.events()).toContain('lock_fields'));
    await new Promise(resolve => setTimeout(resolve, 30));

    const lockIds = (socket) => socket.sent
      .filter(frame => frame.event === 'lock_fields')
      .map(frame => frame.metadata.eventId);
    const before = lockIds(first);
    const after = lockIds(second);

    // Every record the first connection sent and never had acked comes back
    // under the same name — a resend is the same record, not a new one. Were
    // identities minted at send time instead, this is the assertion that fails.
    expect(after).toEqual(expect.arrayContaining(before));
    // This connection's own preamble is a new record, with a new name.
    expect(after.filter(id => !before.includes(id)).length).toBeGreaterThanOrEqual(1);
    // And no identity appears twice on one connection: the same frame is never
    // in the store under two ids.
    expect(new Set(after).size).toBe(after.length);
  });
});

describe('the disabler gates sending, never storing (§5)', () => {
  it('keeps accepting and storing events while blocked', async () => {
    // The rule the earlier rebuilds broke in two different ways. A blocked
    // client must go on writing to the durable outbox — the block is about the
    // network, and a tab that closes mid-block must not lose the work.
    const { websocketLogger, disabler } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();
    await vi.waitFor(() => expect(socket.events()).toContain('fetch_blob'));

    socket.deliver({ status: 'blocklist', message: 'slow down', time_limit: 'DAYS', action: 'MAINTAIN' });
    await new Promise(resolve => setTimeout(resolve, 20));

    logger(JSON.stringify({ event: 'while-blocked', metadata: { eventId: 'id-w' } }));
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(1));
    expect(socket.events()).not.toContain('while-blocked');
    expect(disabler.storeEvents()).toBe(true);
  });

  it('a permanent rate limit stops sending WITHOUT deleting stored work', async () => {
    // The unforgivable category, reached through a plausible-looking path:
    // treating every permanent block as an opt-out and clearing the outbox. A
    // permanent MAINTAIN says "stop transmitting", never "destroy the work".
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    logger(JSON.stringify({ event: 'unsent', metadata: { eventId: 'id-u' } }));
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(1));

    socket.deliver({ status: 'blocklist', message: 'blocked', time_limit: 'PERMANENT', action: 'MAINTAIN' });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(await logger.unackedCount()).toBe(1);      // held, not discarded
  });

  it('a block arriving while a lease is parked stops that record too', async () => {
    // The race an earlier build lost: the disabler was checked before leasing,
    // so a lease that was already parked resolved *after* the block landed and
    // went straight out. The check has to be at the moment the record
    // surfaces, which is why the engine — not the loop — decides.
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();
    await vi.waitFor(() => expect(socket.events()).toContain('fetch_blob'));
    // The lease loop is now parked on an empty outbox.

    socket.deliver({ status: 'blocklist', message: 'slow down', time_limit: 'DAYS', action: 'MAINTAIN' });
    await new Promise(resolve => setTimeout(resolve, 20));

    // This enqueue wakes the parked lease. The record must not go out.
    logger(JSON.stringify({ event: 'woke-the-lease', metadata: { eventId: 'id-p' } }));
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(socket.events()).not.toContain('woke-the-lease');
    expect(await logger.unackedCount()).toBe(1);
  });

  it('a permanent opt-out discards the backlog — the one sanctioned clear()', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    logger(JSON.stringify({ event: 'unsent', metadata: { eventId: 'id-u' } }));
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(1));

    socket.deliver({ status: 'blocklist', message: 'opt out', time_limit: 'PERMANENT', action: 'DROP' });
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
  });
});

describe('server frames', () => {
  it('survives a frame that is not JSON', async () => {
    const { websocketLogger } = await freshModules();
    const { logger, latest } = await startLogger(websocketLogger);
    const socket = latest();
    socket.open();

    socket.onmessage({ data: 'not json at all' });

    logger(JSON.stringify({ event: 'after', metadata: { eventId: 'id-a' } }));
    await vi.waitFor(() => expect(socket.events()).toContain('after'));
  });
});

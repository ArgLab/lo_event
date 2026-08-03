import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { websocketLogger } from '../src/websocketLogger.js';
import { QueueType } from '../src/queue.js';
import { Queue as IndexedDBQueue } from '../src/indexeddbQueue.js';
import { storage } from '../src/browserStorage.js';
import 'fake-indexeddb/auto';

const NativeWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static instances = [];
  static acknowledge = false;
  static answerSnapshots = true;
  static autoOpen = true;

  readyState = 0;
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  sent = [];
  sentRaw = [];
  failSends = false;

  constructor () {
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
  }

  send (data) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    if (this.failSends) throw new Error('simulated send failure');
    const raw = String(data);
    this.sentRaw.push(raw);
    let frame;
    try {
      frame = JSON.parse(raw);
      this.sent.push(frame);
    } catch {
      return;
    }
    if (frame.event === 'fetch_blob' && FakeWebSocket.answerSnapshots) {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ status: 'fetch_blob', data: {} })
      }));
    } else if (FakeWebSocket.acknowledge && frame.metadata?.eventId) {
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ status: 'ack', id: frame.metadata.eventId })
      }));
    }
  }

  receive (frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }
}

beforeAll(() => { globalThis.WebSocket = FakeWebSocket; });
afterAll(() => { globalThis.WebSocket = NativeWebSocket; });
beforeEach(() => {
  FakeWebSocket.acknowledge = false;
  FakeWebSocket.answerSnapshots = true;
  FakeWebSocket.autoOpen = true;
  storage.set({ lo_server: undefined });
});

async function connectedLogger (options = {}) {
  const logger = websocketLogger('ws://test.invalid', {
    namespace: crypto.randomUUID(),
    queueType: QueueType.IN_MEMORY,
    ...options
  });
  await logger.init();
  await vi.waitFor(() => expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(1));
  return { logger, socket: FakeWebSocket.instances.at(-1) };
}

describe('WebSocket adapter', () => {
  it('durable mode retains records until their identity ack arrives', async () => {
    const { logger, socket } = await connectedLogger({ fetchState: false });
    logger(JSON.stringify({ event: 'answer', value: 42 }));
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.event === 'answer')).toBe(true));
    expect(await logger.unackedCount()).toBe(1);

    const answer = socket.sent.find(frame => frame.event === 'answer');
    expect(answer.metadata.eventId).toBeTypeOf('string');
    socket.receive({ status: 'ack', id: answer.metadata.eventId });
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
  });

  it('autoack confirms after an OPEN send and does not fetch state by default', async () => {
    const { logger, socket } = await connectedLogger({ autoack: true });
    logger(JSON.stringify({ event: 'telemetry' }));
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.event === 'telemetry')).toBe(true));
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
    expect(socket.sent.some(frame => frame.event === 'fetch_blob')).toBe(false);
  });

  it('keeps fetch_blob outside the outbox and exposes a mid-session re-request', async () => {
    const { logger, socket } = await connectedLogger({ fetchState: false });
    logger.requestState();
    await vi.waitFor(() => expect(socket.sent.filter(frame => frame.event === 'fetch_blob')).toHaveLength(1));
    expect(await logger.unackedCount()).toBe(0);
    logger.requestState();
    await vi.waitFor(() => expect(socket.sent.filter(frame => frame.event === 'fetch_blob')).toHaveLength(2));
  });

  it('drains a legacy stored record that cannot be named', async () => {
    const namespace = crypto.randomUUID();
    const queue = new IndexedDBQueue(`lo-event:${encodeURIComponent(namespace)}:durable`);
    queue.enqueue('{ legacy invalid json');
    await queue.unconfirmedCount();

    const { logger, socket } = await connectedLogger({
      namespace,
      queueType: QueueType.PERSISTENT,
      fetchState: false
    });
    await vi.waitFor(() => expect(socket.sentRaw).toContain('{ legacy invalid json'));
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
  });

  it('dispatches server side-channel frames', async () => {
    const previousWindow = globalThis.window;
    const eventTarget = new EventTarget();
    globalThis.window = eventTarget;
    const received = {};
    for (const eventName of ['auth', 'save_blob_ack', 'save_blob_nack', 'server-event']) {
      eventTarget.addEventListener(eventName, event => { received[eventName] = event.detail; });
    }

    try {
      const { socket } = await connectedLogger({ fetchState: false });
      socket.receive({ status: 'auth', user_id: 'u-1', display_name: 'Ada' });
      socket.receive({ status: 'local_storage', key: 'server-key', value: 42 });
      socket.receive({ status: 'browser_event', event_type: 'server-event', detail: { ok: true } });
      socket.receive({ status: 'save_blob_ack', token: 7 });
      socket.receive({ status: 'save_blob_nack', token: 8 });

      expect(received).toEqual({
        auth: { user_id: 'u-1', display_name: 'Ada' },
        'server-event': { ok: true },
        save_blob_ack: { token: 7 },
        save_blob_nack: { token: 8 }
      });
      const stored = await new Promise(resolve => {
        storage.get(['user_id', 'display_name', 'server-key'], resolve);
      });
      expect(stored).toEqual({ user_id: 'u-1', display_name: 'Ada', 'server-key': 42 });
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });

  it('rejects application protocol frames at admission', async () => {
    const { logger } = await connectedLogger({ fetchState: false });
    for (const event of ['fetch_blob', 'save_blob', 'lock_fields']) {
      expect(() => logger(JSON.stringify({ event }))).toThrow(/reserved/);
    }
  });

  it('ignores malformed server frames without stopping delivery', async () => {
    const { logger, socket } = await connectedLogger({ fetchState: false });
    socket.onmessage({ data: 'not json' });
    logger(JSON.stringify({ event: 'after-malformed-frame' }));

    await vi.waitFor(() => {
      expect(socket.sent.some(frame => frame.event === 'after-malformed-frame')).toBe(true);
    });
  });

  it('initializes only once when init is called repeatedly', async () => {
    const before = FakeWebSocket.instances.length;
    const logger = websocketLogger('ws://test.invalid', {
      namespace: crypto.randomUUID(),
      queueType: QueueType.IN_MEMORY,
      fetchState: false
    });

    await Promise.all([logger.init(), logger.init()]);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(before + 1));
  });

  it('keeps a stable direct-use outbox namespace across a server override', async () => {
    FakeWebSocket.autoOpen = false;
    const originalServer = `ws://original-${crypto.randomUUID()}.invalid`;
    storage.set({ lo_server: `ws://override-${crypto.randomUUID()}.invalid` });

    const beforeInit = websocketLogger(originalServer, {
      queueType: QueueType.PERSISTENT,
      fetchState: false
    });
    beforeInit(JSON.stringify({ event: 'before-init' }));
    await vi.waitFor(async () => expect(await beforeInit.unackedCount()).toBe(1));

    const afterInit = websocketLogger(originalServer, {
      queueType: QueueType.PERSISTENT,
      fetchState: false
    });
    await afterInit.init();
    expect(await afterInit.unackedCount()).toBe(1);
  });

  it('sends a recovered backlog before requesting its snapshot', async () => {
    FakeWebSocket.acknowledge = true;
    const logger = websocketLogger('ws://test.invalid', {
      namespace: crypto.randomUUID(),
      queueType: QueueType.IN_MEMORY
    });
    logger(JSON.stringify({ event: 'recovered-answer' }));
    await logger.init();
    const socket = FakeWebSocket.instances.at(-1);
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.event === 'fetch_blob')).toBe(true));
    const events = socket.sent.map(frame => frame.event);
    expect(events.indexOf('recovered-answer')).toBeLessThan(events.indexOf('fetch_blob'));
  });

  it('releases a lease parked on the previous connection before sending the new preamble', async () => {
    const { logger, socket: first } = await connectedLogger({ fetchState: false });
    logger.setField(JSON.stringify({
      event: 'lock_fields',
      fields: { source: 'test-app' },
      metadata: { eventId: 'initial-lock' }
    }));
    logger(JSON.stringify({ event: 'answer', metadata: { eventId: 'answer' } }));
    await vi.waitFor(() => expect(first.sent.some(frame => frame.event === 'answer')).toBe(true));

    first.close();
    await vi.waitFor(
      () => expect(FakeWebSocket.instances.at(-1)).not.toBe(first),
      { timeout: 4000 }
    );
    const second = FakeWebSocket.instances.at(-1);
    await vi.waitFor(() => expect(second.sent.some(frame => frame.event === 'answer')).toBe(true));

    expect(second.sent.map(frame => frame.event)).toEqual([
      'lock_fields',
      'answer',
      'lock_fields'
    ]);
    const lockIds = second.sent
      .filter(frame => frame.event === 'lock_fields')
      .map(frame => frame.metadata.eventId);
    expect(lockIds[0]).toBe('initial-lock');
    expect(lockIds[1]).not.toBe('initial-lock');
  });

  it('retires an OPEN socket whose send throws, then retries on a new connection', async () => {
    const { logger, socket: first } = await connectedLogger({ fetchState: false });
    first.failSends = true;
    logger(JSON.stringify({ event: 'answer', metadata: { eventId: 'answer' } }));

    await vi.waitFor(() => expect(first.readyState).toBe(3));
    expect(first.sent).toEqual([]);
    expect(await logger.unackedCount()).toBe(1);

    await vi.waitFor(
      () => expect(FakeWebSocket.instances.at(-1)).not.toBe(first),
      { timeout: 4000 }
    );
    const second = FakeWebSocket.instances.at(-1);
    await vi.waitFor(() => expect(second.sent.some(frame => frame.event === 'answer')).toBe(true));
  });

  // This mutates module-global disabler state permanently, so it stays last.
  it('a permanent hold retains a parked record and a privacy opt-out clears it', async () => {
    const { logger, socket } = await connectedLogger({ fetchState: false });
    // The drain loop is parked on an empty queue at this point.
    socket.receive({
      status: 'blocklist',
      message: 'hold',
      time_limit: 'PERMANENT',
      action: 'MAINTAIN'
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    logger(JSON.stringify({ event: 'must-stay-local' }));

    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(socket.sent.some(frame => frame.event === 'must-stay-local')).toBe(false);

    socket.receive({
      status: 'blocklist',
      message: 'privacy opt-out',
      time_limit: 'PERMANENT',
      action: 'DROP'
    });
    await vi.waitFor(async () => expect(await logger.unackedCount()).toBe(0));
  });
});

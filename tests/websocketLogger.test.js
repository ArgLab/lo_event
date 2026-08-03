import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { websocketLogger } from '../src/websocketLogger.js';
import { QueueType } from '../src/queue.js';

const NativeWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static instances = [];
  static acknowledge = false;
  static answerSnapshots = true;

  readyState = 0;
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  sent = [];
  failSends = false;

  constructor () {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send (data) {
    if (this.readyState !== 1) throw new Error('socket is not open');
    if (this.failSends) throw new Error('simulated send failure');
    const frame = JSON.parse(String(data));
    this.sent.push(frame);
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
  it('a block arriving while leaseNext is parked prevents the next record from sending', async () => {
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
  });
});

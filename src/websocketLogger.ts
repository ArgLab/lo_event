import { Queue, QueueType } from './queue.js';
import { DeliveryEngine } from './protocol.js';
import * as disabler from './disabler.js';
import * as util from './util.js';
import * as debug from './debugLog.js';
import { storage } from './browserStorage.js';
import type { Decision, Logger } from './types.js';

interface WsHostOverrides {
  hostname?: string;
  port?: string | number;
  path?: string;
  url?: string;
}

export interface WebsocketLoggerOptions {
  /** false (default): retain until server ack. true: confirm on OPEN send. */
  autoack?: boolean;
  /** Stable application namespace. lo_event.init's source is used by default. */
  namespace?: string;
  /** Whether init should request a state snapshot. Defaults to !autoack. */
  fetchState?: boolean;
  /** Outbox backend; primarily useful for tests and non-browser runtimes. */
  queueType?: string;
}

type SocketConstructor = new (url: string) => WebSocket;
const SOCKET_OPEN = 1;
const TICK_MS = 250;
const RETRY_PAUSE_MS = 50;
const FETCH_BLOB_FRAME = JSON.stringify({ event: 'fetch_blob' });

function defaultLocation (): Location {
  if (typeof window === 'undefined') throw new Error('A websocket URL is required outside a browser.');
  return window.location;
}

function wsHost (overrides: WsHostOverrides = {}, loc = defaultLocation()): string {
  const protocol = loc.protocol === 'https:' ? 'wss://' : 'ws://';
  const host = overrides.hostname || loc.hostname;
  const port = overrides.port || loc.port || (loc.protocol === 'https:' ? 443 : 80);
  const target = overrides.url || `${host}:${port}${overrides.path || '/wsapi/in/'}`;
  return `${protocol}${target}`;
}

function backoffDelay (failures: number): number {
  return Math.min(1_000 * 2 ** failures, 15 * 60_000);
}

function parseFrame (data: string): Record<string, unknown> {
  const frame = JSON.parse(data) as unknown;
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('WebSocket logger accepts JSON object frames only.');
  }
  return frame as Record<string, unknown>;
}

function eventIdOf (data: unknown): string | null {
  try {
    const frame = typeof data === 'string' ? parseFrame(data) : data as Record<string, unknown>;
    const metadata = frame.metadata as Record<string, unknown> | undefined;
    return typeof metadata?.eventId === 'string' && metadata.eventId ? metadata.eventId : null;
  } catch {
    return null;
  }
}

/** Clone before stamping: a resend must retain its identity, while every newly
 * constructed transport frame must receive a fresh one. */
function stamped (frame: Record<string, unknown>): string {
  const copy = {
    ...frame,
    metadata: { ...((frame.metadata as Record<string, unknown> | undefined) ?? {}) }
  };
  util.timestampEvent(copy);
  return JSON.stringify(copy);
}

function normalizedEvent (data: string): string {
  const frame = parseFrame(data);
  return eventIdOf(frame) === null ? stamped(frame) : data;
}

/** A sending gate. It controls leasing only; admission never waits here. */
class Gate {
  private open = false;
  private waiters: Array<() => void> = [];

  set (open: boolean): void {
    this.open = open;
    if (open) this.waiters.splice(0).forEach(resolve => resolve());
  }

  wait (): Promise<void> {
    return this.open
      ? Promise.resolve()
      : new Promise(resolve => { this.waiters.push(resolve); });
  }
}

export function websocketLogger (
  server: string | WsHostOverrides = {},
  {
    autoack = false,
    namespace,
    fetchState = !autoack,
    queueType = QueueType.AUTODETECT as string
  }: WebsocketLoggerOptions = {}
): Logger {
  let serverUrl = typeof server === 'string' ? server : wsHost(server);
  let queueNamespace = namespace ?? null;
  let queue: Queue | null = null;
  const profile = autoack ? 'autoack' : 'durable';
  const outbox = (): Queue => {
    const resolved = queueNamespace ?? serverUrl;
    return queue ??= new Queue(`lo-event:${encodeURIComponent(resolved)}:${profile}`, { queueType });
  };

  const engine = new DeliveryEngine({ autoack });
  const gate = new Gate();
  const lockedFields: Record<string, unknown> = {};

  let SocketLibrary: SocketConstructor;
  let socket: WebSocket | null = null;
  let socketAttempt = 0;
  let initialized = false;
  let stopped = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let waitingOnDisabler = false;

  /** External facts are reduced in arrival order. I/O answers start a new fact
   * instead of holding the serial lane, so a hung maxSeq cannot block elapsed()
   * from opening the barrier deadline. */
  let protocolWork: Promise<void> = Promise.resolve();

  function submit (fact: () => Decision[]): Promise<void> {
    const work = protocolWork.then(() => { perform(fact()); });
    protocolWork = work.catch(error => {
      debug.error('websocketLogger: protocol executor failed', error);
    });
    return work;
  }

  function perform (decisions: Decision[]): void {
    for (const decision of decisions) {
      switch (decision.do) {
        case 'rewind':
          outbox().rewind();
          break;

        case 'measureWatermark': {
          const generation = engine.generation();
          void outbox().maxSeq().then(
            max => submit(() => engine.watermarkResult(generation, max)),
            error => {
              debug.error('websocketLogger: could not read outbox watermark', error);
              return submit(() => engine.measurementFailed(generation, 'watermark measurement'));
            }
          );
          break;
        }

        case 'probeQueue': {
          const generation = engine.generation();
          void outbox().unleasedAtOrBelow(decision.watermark).then(
            count => submit(() => engine.probeResult(generation, count)),
            error => {
              debug.error('websocketLogger: could not probe outbox', error);
              return submit(() => engine.measurementFailed(generation, 'probe'));
            }
          );
          break;
        }

        case 'sendFrame': {
          const generation = engine.generation();
          perform(sendNow(decision.frame)
            ? engine.sendCompleted(generation)
            : engine.sendFailed(generation));
          break;
        }

        case 'confirmIds':
          outbox().confirm(decision.ids);
          break;

        case 'askForState': {
          const generation = engine.generation();
          if (sendNow(decision.frame)) {
            perform(engine.stateSendCompleted(generation));
          } else {
            perform(engine.stateSendFailed(generation));
            // A direct request has no durable retry carrier. Reconnect gives it
            // a fresh connection latch and is safer than spinning on one socket.
            try { socket?.close(); } catch { /* close is best effort */ }
          }
          break;
        }

        case 'pauseSending':
          gate.set(false);
          break;
        case 'resumeSending':
          gate.set(true);
          break;
        case 'discardOutbox':
          outbox().clear();
          break;
        case 'log':
          if (decision.level === 'error') debug.error(`websocketLogger: ${decision.message}`);
          else debug.info(`websocketLogger: ${decision.message}`);
          break;
      }
    }
  }

  function sendNow (frame: string): boolean {
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(frame);
      return true;
    } catch (error) {
      debug.error('websocketLogger: socket send failed', error);
      return false;
    }
  }

  async function leaseLoop (): Promise<void> {
    while (!stopped) {
      try {
        await gate.wait();
        if (stopped) return;
        const { seq, item } = await outbox().leaseNext();
        const frame = typeof item === 'string' ? item : JSON.stringify(item);
        let rewound = false;
        await submit(() => {
          const decisions = engine.recordLeased(seq, eventIdOf(item), frame);
          rewound = decisions.some(decision => decision.do === 'rewind');
          return decisions;
        });
        if (rewound) {
          await util.delay(RETRY_PAUSE_MS);
        }
      } catch (error) {
        // A transient storage failure must not kill the only delivery loop.
        debug.error('websocketLogger: outbox lease loop failed; retrying', error);
        await util.delay(RETRY_PAUSE_MS);
      }
    }
  }

  function enqueueMetadataPreamble (): void {
    if (!disabler.storeEvents() || !Object.keys(lockedFields).length) return;
    outbox().enqueue(stamped({ event: 'lock_fields', fields: { ...lockedFields } }));
  }

  function startTicker (attempt: number): void {
    stopTicker();
    let lastTick = Date.now();
    ticker = setInterval(() => {
      if (attempt !== socketAttempt) return;
      const now = Date.now();
      const elapsed = now - lastTick;
      lastTick = now;
      void submit(() => engine.elapsed(elapsed));
    }, TICK_MS);
    (ticker as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }

  function stopTicker (): void {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  }

  function runConnection (): Promise<boolean> {
    return new Promise(resolve => {
      const attempt = ++socketAttempt;
      const candidate = new SocketLibrary(serverUrl);
      socket = candidate;
      let opened = false;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (attempt === socketAttempt) {
          stopTicker();
          void submit(() => engine.disconnected());
          util.dispatchCustomEvent('lo_connection_status', { detail: { connected: false } });
          if (socket === candidate) socket = null;
        }
        resolve(opened);
      };

      candidate.onopen = () => {
        if (attempt !== socketAttempt) return;
        opened = true;
        try {
          enqueueMetadataPreamble();
          void submit(() => engine.connected()).then(() => {
            if (attempt !== socketAttempt || candidate.readyState !== SOCKET_OPEN) return;
            startTicker(attempt);
            util.dispatchCustomEvent('lo_connection_status', { detail: { connected: true } });
          }).catch(error => {
            debug.error('websocketLogger: failed to prepare an open connection', error);
            try { candidate.close(); } catch { /* best effort */ }
          });
        } catch (error) {
          debug.error('websocketLogger: failed to prepare an open connection', error);
          try { candidate.close(); } catch { /* best effort */ }
          finish();
        }
      };
      candidate.onmessage = event => receiveMessage(event, attempt);
      candidate.onclose = finish;
      candidate.onerror = event => {
        debug.error('websocketLogger: websocket error', event);
        try { candidate.close(); } catch { /* already closed */ }
        finish();
      };
    });
  }

  async function connectionLoop (): Promise<void> {
    let failures = 0;
    while (!stopped) {
      try {
        const opened = await runConnection();
        failures = opened ? 0 : failures + 1;
      } catch (error) {
        failures++;
        debug.error('websocketLogger: connection loop failed', error);
      }
      if (!stopped) await util.delay(backoffDelay(failures));
    }
  }

  function receiveMessage (event: MessageEvent, attempt: number): void {
    let response: Record<string, any>;
    try {
      response = JSON.parse(String(event.data));
    } catch (error) {
      debug.error('websocketLogger: ignoring invalid JSON from server', error);
      return;
    }

    // These are world facts: an old socket's durable ack or snapshot response
    // is still useful. Other side-channel frames belong to their connection.
    if (response.status === 'ack') {
      if (typeof response.id === 'string') void submit(() => engine.ackReceived(response.id));
      return;
    }
    if (response.status === 'fetch_blob') {
      void submit(() => engine.stateReceived());
      util.dispatchCustomEvent('fetch_blob', { detail: response.data });
      return;
    }
    if (attempt !== socketAttempt) return;

    switch (response.status) {
      case 'blocklist': {
        const block = new disabler.BlockError(response.message, response.time_limit, response.action);
        disabler.handleBlockError(block);
        if (!disabler.streamEvents()) {
          void submit(() => engine.disablerEngaged({
            permanent: disabler.isPermanent(),
            permanentOptOut: disabler.isPermanentOptOut()
          }));
          if (!disabler.isPermanent()) void awaitDisablerRelease();
        }
        break;
      }
      case 'auth': {
        const { status: _status, ...user } = response;
        storage.set(user);
        util.dispatchCustomEvent('auth', { detail: user });
        break;
      }
      case 'local_storage':
        storage.set({ [response.key]: response.value });
        break;
      case 'browser_event':
        util.dispatchCustomEvent(response.event_type, { detail: response.detail });
        break;
      case 'save_blob_ack':
        util.dispatchCustomEvent('save_blob_ack', { detail: { token: response.token } });
        break;
      case 'save_blob_nack':
        util.dispatchCustomEvent('save_blob_nack', { detail: { token: response.token } });
        break;
      default:
        debug.info(`websocketLogger: unhandled server frame: ${JSON.stringify(response)}`);
    }
  }

  async function awaitDisablerRelease (): Promise<void> {
    if (waitingOnDisabler) return;
    waitingOnDisabler = true;
    try {
      if (await disabler.retry()) await submit(() => engine.disablerReleased());
    } catch (error) {
      debug.error('websocketLogger: disabler wait failed; delivery remains paused', error);
    } finally {
      waitingOnDisabler = false;
    }
  }

  const logger = ((data: string) => {
    if (!disabler.storeEvents()) return;
    const frame = parseFrame(data);
    if (util.isProtocolEventName(String(frame.event))) {
      throw new Error(`Application event name is reserved: ${String(frame.event)}`);
    }
    outbox().enqueue(normalizedEvent(data));
  }) as Logger;

  logger.configure = ({ source }) => {
    if (initialized) throw new Error('WebSocket logger cannot be configured after init.');
    if (namespace === undefined) {
      if (queue !== null) throw new Error('WebSocket logger was used before its application namespace was configured.');
      queueNamespace = source;
    }
  };

  logger.init = async () => {
    initialized = true;
    try {
      const stored = await new Promise<Record<string, unknown>>(resolve => storage.get('lo_server', resolve));
      if (typeof stored.lo_server === 'string') serverUrl = stored.lo_server;
    } catch (error) {
      debug.info(`websocketLogger: could not read server override: ${String(error)}`);
    }

    SocketLibrary = typeof WebSocket === 'undefined'
      ? (await import('ws')).WebSocket as unknown as SocketConstructor
      : WebSocket;

    if (!disabler.streamEvents()) {
      await submit(() => engine.disablerEngaged({
        permanent: disabler.isPermanent(),
        permanentOptOut: disabler.isPermanentOptOut()
      }));
      if (!disabler.isPermanent()) void awaitDisablerRelease();
    }
    if (fetchState) await submit(() => engine.requestState(FETCH_BLOB_FRAME));
    void connectionLoop().catch(error => debug.error('websocketLogger: connection loop stopped', error));
    void leaseLoop().catch(error => debug.error('websocketLogger: lease loop stopped', error));
  };

  logger.setField = data => {
    if (!disabler.storeEvents()) return;
    const frame = parseFrame(data);
    const fields = frame.fields;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      util.mergeDictionary(lockedFields, fields as Record<string, unknown>);
    }
    outbox().enqueue(normalizedEvent(data));
  };

  logger.requestState = () => { void submit(() => engine.requestState(FETCH_BLOB_FRAME)); };
  logger.unackedCount = () => outbox().unconfirmedCount();
  logger.queueDebug = {
    count: () => outbox().unconfirmedCount(),
    inspect: (limit = 20) => outbox().inspect(limit),
    clear: () => outbox().clear()
  };
  logger.lo_name = 'Reliable WebSocket Logger';
  logger.lo_id = 'websocket_logger';

  util.consumeCustomEvent('save_blob', (data: unknown) => {
    if (!disabler.storeEvents()) return;
    const { blob, token } = data as { blob: unknown; token: number };
    outbox().enqueue(stamped({ event: 'save_blob', blob, token }));
  });

  return logger;
}

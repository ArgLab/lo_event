/**
 * The websocket adapter: sockets, the durable outbox, and timers.
 *
 * Every protocol decision in here is made by the DeliveryEngine (protocol.ts)
 * and merely *performed* by this file. That split is the point: the historical
 * failure mode of this module was correct-sounding orchestration living as
 * loose flags inside socket plumbing, unreachable by any test without a real
 * WebSocket and a real IndexedDB (§9). If you find yourself adding an `if`
 * here that changes *what* the protocol does rather than *how* it is carried
 * out, it belongs in the engine.
 *
 * What this file owns:
 *   - connecting, reconnect backoff, and turning socket lifecycle into facts;
 *   - the outbox: enqueue on log, lease in a serial loop, confirm on decision;
 *   - parsing server frames into facts, and stored records into identities;
 *   - a clock, fed to the engine as elapsed(ms).
 */
import { Queue, QueueType } from './queue.js';
import * as disabler from './disabler.js';
import * as util from './util.js';
import * as debug from './debugLog.js';
import { storage } from './browserStorage.js';
import { DeliveryEngine, type DisablerMode } from './protocol.js';
import type { Decision, Logger } from './types.js';

interface WsHostOverrides {
  hostname?: string;
  port?: string | number;
  path?: string;
  url?: string;
}

export interface WebsocketLoggerOptions {
  /**
   * The confirm source (§5). false (default) = durable: a record is deleted
   * only when the server acks it. true = send-and-forget: the client signs
   * its own receipt on a send made while the socket was verified OPEN.
   *
   * Configuration, never negotiation (L12). A durable client against a server
   * that never acks confirms nothing, so the queue only grows — visible in
   * unackedCount() and loDebug.queue(), and recoverable. Never a silent loss.
   */
  autoack?: boolean;
  /**
   * Outbox store namespace. The store is shared by everything on the origin
   * that names it, so two different apps must not share one (§2). When unset,
   * the namespace is taken from lo_event.init()'s `source` (via configure());
   * a logger used standalone without either falls back to 'default', loudly.
   * The profile is always part of the store name — mixing confirm semantics
   * on one store is forbidden.
   */
  namespace?: string;
  /** Ask the server for the state snapshot at startup (§6). Defaults to the
   *  profile's natural answer: durable editors load state; send-and-forget
   *  telemetry has no UI waiting on one. */
  fetchState?: boolean;
  /** Outbox backend. Default AUTODETECT: IndexedDB where it exists, memory
   *  otherwise — and read §2 on what memory gives up. */
  queueType?: string;
}

/** `WebSocket.OPEN`. Spelled out because `ws` and the browser both use 1, and
 *  the global constant is not available in every environment we run in. */
const SOCKET_OPEN = 1;

/** The snapshot request. Connection-scoped, never queued (§6, L11). */
const FETCH_BLOB_FRAME = JSON.stringify({ event: 'fetch_blob' });

/** How often the engine is told time passed. Fine enough for the barrier's
 *  ~300ms fallback probe; runs only while a socket is open. */
const TICK_MS = 250;

/** How long the lease loop rests after a lease it could not send, or a store
 *  it could not read. Keeps a failing loop from becoming a hot one. */
const RETRY_PAUSE_MS = 50;

function wsHost (overrides: WsHostOverrides = {}, loc = window.location) {
  const { hostname, port, path, url } = overrides;
  const protocol = loc.protocol === 'https:' ? 'wss://' : 'ws://';
  const host = hostname || loc.hostname;
  const portNumber = port || loc.port || (loc.protocol === 'https:' ? 443 : 80);
  const pathname = path || '/wsapi/in/';
  return `${protocol}${url || `${host}:${portNumber}${pathname}`}`;
}

/** 1s doubling to a 15-minute ceiling. The ceiling is the worst-case delivery
 *  tail on §1's promise while a laptop sits offline. */
function backoffDelay (failures: number) {
  return Math.min(1000 * Math.pow(2, failures), 1000 * 60 * 15);
}

/**
 * A latch the lease loop waits on. Open means "this connection may send";
 * it gates *sending only* — admission never waits on it (§5).
 */
class Gate {
  private open = false;
  private waiters: Array<() => void> = [];

  set (open: boolean) {
    this.open = open;
    if (open) this.waiters.splice(0).forEach(wake => wake());
  }

  wait (): Promise<void> {
    return this.open ? Promise.resolve() : new Promise(resolve => { this.waiters.push(resolve); });
  }
}

/** The identity of a stored record, or null when it has none — a
 *  pre-identity leftover, a path that forgot to stamp, or a payload that does
 *  not parse. Null is a protocol-relevant answer, not an error (L7). */
function eventIdOf (payload: unknown): string | null {
  try {
    const frame = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const id = (frame as Record<string, any>)?.metadata?.eventId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
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
  const engine = new DeliveryEngine({ autoack });
  const gate = new Gate();

  // The outbox is created lazily so that lo_event.init() can supply the app
  // namespace (via configure()) before the store name is fixed. The store
  // name carries the profile: every consumer of a store must have identical
  // confirm semantics (§2).
  let appNamespace: string | null = null;
  let queue: Queue | null = null;
  function outbox (): Queue {
    if (!queue) {
      const ns = namespace ?? appNamespace;
      if (ns === null) {
        debug.error('websocketLogger: no namespace configured; outbox store falls back to "default". Two apps on one origin will share it — set the namespace option or call lo_event.init() first.');
      }
      queue = new Queue(`lo-outbox.${ns ?? 'default'}.${autoack ? 'autoack' : 'durable'}`, { queueType });
    }
    return queue;
  }

  let socket: WebSocket | null = null;
  let WSLibrary: new (url: string) => WebSocket;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let waitingOnDisabler = false;
  /** The session's locked context fields, replayed as a freshly stamped frame
   *  on every connection (§5 step 2). We keep the *fields*, never a stamped
   *  frame: an object that has ever carried an eventId is never enqueued
   *  again (L6). */
  const lockedFields: Record<string, unknown> = {};

  let serverUrl = typeof server === 'string' ? server : wsHost(server);

  // ───────────────────────────────────────────────── performing decisions

  function apply (decisions: Decision[]) {
    for (const decision of decisions) {
      switch (decision.do) {
        case 'rewind':
          outbox().rewind();
          break;

        case 'measureWatermark': {
          const gen = engine.generation();
          outbox().maxSeq().then(
            max => apply(engine.watermarkResult(gen, max)),
            error => { debug.error('websocketLogger: could not read the outbox watermark', error); apply(engine.measurementFailed(gen, 'watermark')); }
          );
          break;
        }

        case 'probeQueue': {
          const gen = engine.generation();
          outbox().unleasedAtOrBelow(decision.watermark).then(
            unleased => apply(engine.probeResult(gen, unleased)),
            error => { debug.error('websocketLogger: could not probe the outbox', error); apply(engine.measurementFailed(gen, 'probe')); }
          );
          break;
        }

        case 'sendFrame': {
          const gen = engine.generation();
          apply(sendNow(decision.frame) ? engine.sendCompleted(gen) : engine.sendFailed(gen));
          break;
        }

        case 'confirmIds':
          outbox().confirm(decision.ids);
          break;

        case 'askForState':
          // Directly on the socket, never through the queue: the answer is
          // worthless to another tab and garbage once this session dies (§6).
          // A failed send is harmless — the ask timeout re-asks.
          sendNow(decision.frame);
          break;

        case 'pauseSending':
          gate.set(false);
          break;

        case 'resumeSending':
          gate.set(true);
          break;

        case 'clearQueue':
          // The single sanctioned deletion of unsent work: a permanent
          // privacy opt-out (§5). The engine logged why.
          outbox().clear();
          break;

        case 'log':
          if (decision.level === 'error') debug.error(`websocketLogger: ${decision.message}`);
          else debug.info(`websocketLogger: ${decision.message}`);
          break;
      }
    }
  }

  /**
   * Send, but only on a socket verified OPEN. Deliberately not "send() didn't
   * throw": a browser WebSocket.send() on a CLOSING/CLOSED socket returns
   * normally and silently discards the data, and Node's `ws` reports errors
   * via callback — either would let send-and-forget confirm-and-delete a frame
   * that was never even buffered (§5).
   */
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

  // ────────────────────────────────────────────────────── the lease loop

  /**
   * Lease one record, hand it to the engine, repeat. Serial by construction,
   * which is what lets a single send-in-flight flag interlock the barrier
   * probes (§7).
   *
   * The gate is awaited *before* leasing: a lease advances the cursor and only
   * rewind() moves it back, so we lease only what we can try to send (§3). A
   * lease that resolves into a connection that has since died — or into an
   * engaged disabler — is not lost either: the engine answers it with a
   * rewind, no send, no confirm (L13).
   *
   * Every iteration is inside try/catch: an unreadable store degrades to a
   * loud, resting retry — never a dead loop and never a silent stop (L17).
   * One rejected lease permanently killing delivery was a round-1 bug.
   */
  async function leaseLoop () {
    while (true) {
      try {
        await gate.wait();
        const { seq, item } = await outbox().leaseNext();
        const frame = typeof item === 'string' ? item : JSON.stringify(item);
        const decisions = engine.recordLeased(seq, eventIdOf(item), frame);
        apply(decisions);
        // A released lease means we could not send: the socket died under us,
        // or it is CLOSING and has not reported closed yet. The record is
        // safely back in reach, but re-leasing it immediately would spin. Rest
        // a moment; the gate closes as soon as the close is observed.
        if (decisions.some(d => d.do === 'rewind')) await util.delay(RETRY_PAUSE_MS);
      } catch (error) {
        debug.error('websocketLogger: could not lease from the outbox; retrying', error);
        await util.delay(RETRY_PAUSE_MS);
      }
    }
  }

  // ─────────────────────────────────────────────────── socket lifecycle

  function onOpen () {
    // The session's metadata rides the outbox like any event: behind any
    // recovered backlog, ahead of everything logged after it — so the server
    // always meets a session's metadata before its events (§5 step 2). It is
    // enqueued before the watermark is measured, so this connection's barrier
    // orders the snapshot after it too.
    enqueueSessionMetadata();
    apply(engine.connected());
    startTicker();
    util.dispatchCustomEvent('lo_connection_status', { detail: { connected: true } });
  }

  function onClose () {
    socket = null;
    stopTicker();
    apply(engine.disconnected());
    util.dispatchCustomEvent('lo_connection_status', { detail: { connected: false } });
  }

  function enqueueSessionMetadata () {
    if (!Object.keys(lockedFields).length) return;
    // Copy first, then stamp: timestampEvent() writes into its argument, so
    // stamping the long-lived dict would burn one identity into every future
    // frame (L6). Every enqueue mints a fresh identity (L5).
    const frame: Record<string, unknown> = { event: 'lock_fields', fields: { ...lockedFields } };
    util.timestampEvent(frame);
    outbox().enqueue(JSON.stringify(frame));
  }

  /** Resolves when the socket closes; true if it ever opened. */
  function runConnection (): Promise<boolean> {
    return new Promise(resolve => {
      let opened = false;
      let settled = false;
      const sock = new WSLibrary(serverUrl);
      socket = sock;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch { /* already closing */ }
        if (opened) onClose();
        resolve(opened);
      };

      sock.onopen = () => { opened = true; onOpen(); };
      sock.onmessage = receiveMessage;
      sock.onclose = finish;
      sock.onerror = (event) => {
        debug.error('websocketLogger: websocket error', event);
        finish();
      };
    });
  }

  async function connectionLoop () {
    let failures = 0;
    while (true) {
      try {
        const opened = await runConnection();
        failures = opened ? 0 : failures + 1;
      } catch (error) {
        // runConnection should not throw; if it somehow does, reconnect
        // rather than silently stopping delivery forever (L17).
        debug.error('websocketLogger: connection attempt failed unexpectedly; retrying', error);
        failures++;
      }
      await util.delay(backoffDelay(failures));
    }
  }

  function startTicker () {
    if (ticker) return;
    ticker = setInterval(() => apply(engine.elapsed(TICK_MS)), TICK_MS);
    // Don't hold a Node process open for a heartbeat.
    (ticker as unknown as { unref?: () => void }).unref?.();
  }

  function stopTicker () {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  // ──────────────────────────────────────────────── server → client frames

  function receiveMessage (event: MessageEvent) {
    let response: Record<string, any>;
    try {
      response = JSON.parse(event.data as string);
    } catch (error) {
      debug.error('websocketLogger: unparseable frame from the server', error);
      return;
    }

    switch (response.status) {
      case 'ack':
        // The server durably captured this identity. Idempotent server-side:
        // every copy is acked, including duplicates (§4). Deliberately not
        // gated on the socket that delivered it — an ack is a fact about the
        // world, actionable on any connection at any time.
        apply(engine.ackReceived(response.id));
        break;

      case 'fetch_blob':
        // Whichever snapshot arrives resolves the load — including a response
        // from an older connection satisfying a newer ask (§6's declared
        // staleness window), so this is not generation-gated either.
        apply(engine.stateReceived());
        util.dispatchCustomEvent('fetch_blob', { detail: response.data });
        break;

      case 'blocklist':
        handleBlocklist(response);
        break;

      case 'auth': {
        // The server telling us who it decided we are; we never wait for it
        // (attribution happens at accept time, before the upgrade — §5).
        //
        // Forward-compat: every field but `status` is spread into the user
        // object, so new profile fields flow through without touching this
        // file. Treat `user_id` as the only required one.
        const { status, ...user } = response;
        storage.set(user);
        util.dispatchCustomEvent('auth', { detail: user });
        break;
      }

      case 'save_blob_ack':
        util.dispatchCustomEvent('save_blob_ack', { detail: { token: response.token } });
        break;

      case 'save_blob_nack':
        util.dispatchCustomEvent('save_blob_nack', { detail: { token: response.token } });
        break;

      // Server-pushed side channels, unrelated to delivery. These assume we
      // trust the server, and should probably sit behind a feature flag.
      case 'local_storage':
        storage.set({ [response.key]: response.value });
        break;
      case 'browser_event':
        util.dispatchCustomEvent(response.event_type, { detail: response.detail });
        break;

      default:
        debug.info(`websocketLogger: unhandled frame: ${JSON.stringify(response)}`);
        break;
    }
  }

  /**
   * A blocklist frame: engage the disabler and tell the engine which of the
   * three modes this is (the engine owns what each mode does — §5). The
   * distinction comes from disabler.currentMode(), one predicate in one
   * place: an overloaded "permanent" boolean reconstructed at call sites is
   * how a round-1 build cleared durable unsent work on a permanent rate
   * limit.
   */
  function handleBlocklist (response: Record<string, any>) {
    debug.info('websocketLogger: blocked by the server; sending paused');
    disabler.handleBlockError(new disabler.BlockError(response.message, response.time_limit, response.action));
    engageDisabler(disabler.currentMode());
  }

  function engageDisabler (mode: disabler.BlockMode) {
    if (mode === 'clear') return;
    apply(engine.disablerEngaged(mode as DisablerMode));
    if (mode === 'temporary') awaitDisablerRelease();
  }

  /** Wait out a temporary block. `disabler.retry()` sleeps until the expiry
   *  and returns true. A blocked client goes on accepting and storing events
   *  the whole time — only sending stops (§5). */
  async function awaitDisablerRelease () {
    if (waitingOnDisabler) return;
    waitingOnDisabler = true;
    const mayResume = await disabler.retry();
    waitingOnDisabler = false;
    if (mayResume) apply(engine.disablerReleased());
  }

  // ──────────────────────────────────────────────────── the logger surface

  /**
   * Admission: straight to the outbox. Nothing here may wait on connection
   * state, a server response, or the disabler (§5).
   *
   * A frame missing its identity is stamped here rather than admitted
   * unackable (L5) — loEvent stamps its own frames, so this only catches
   * direct callers. Reserved protocol names are refused with a throw: a
   * programming error in the caller, caught the first time the line runs,
   * because silently dropping an event is the one thing this library must
   * not do (§12).
   */
  const wsLogData = function (data: string) {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data);
    } catch {
      throw new Error('websocketLogger accepts JSON object frames only.');
    }
    if (util.RESERVED_EVENT_NAMES.has(String(frame.event))) {
      throw new Error(`Application event name is reserved by the protocol: ${String(frame.event)}`);
    }
    if (eventIdOf(frame) === null) {
      util.timestampEvent(frame);
      data = JSON.stringify(frame);
    }
    outbox().enqueue(data);
  } as Logger;

  wsLogData.lo_name = 'Websocket Logger';
  wsLogData.lo_id = 'websocket_logger';

  /** Application context from lo_event.init(), before init(). Supplies the
   *  outbox namespace when the option was not given (§2). */
  wsLogData.configure = ({ source }) => {
    if (queue !== null && namespace === undefined && appNamespace === null) {
      debug.error('websocketLogger: outbox was created before configure(); the store keeps the "default" namespace this session');
      return;
    }
    appNamespace = source;
  };

  wsLogData.init = async function () {
    try {
      const stored = await new Promise<Record<string, unknown>>(resolve => storage.get('lo_server', resolve as never));
      if (stored?.lo_server) {
        debug.info('websocketLogger: overriding server from storage');
        serverUrl = stored.lo_server as string;
      }
    } catch {
      debug.info('websocketLogger: could not check storage for a server override');
    }

    if (typeof WebSocket === 'undefined') {
      WSLibrary = (await import('ws')).WebSocket as unknown as new (url: string) => WebSocket;
    } else {
      WSLibrary = WebSocket;
    }

    // A block persisted by a previous session (disabler.init loads it before
    // loggers initialize) must gate this session's sending too — otherwise a
    // reload would resume sending straight through a permanent block.
    engageDisabler(disabler.currentMode());

    connectionLoop();
    leaseLoop();
    if (fetchState) wsLogData.requestState!();
  };

  /** Context fields locked for the session. The frame loEvent stamped is
   *  enqueued as-is; the *fields* are kept for the per-connection replay. */
  wsLogData.setField = function (data: string) {
    const frame = JSON.parse(data);
    util.mergeDictionary(lockedFields, (frame.fields ?? {}) as Record<string, unknown>);
    outbox().enqueue(data);
  };

  /** Zero means every event has been durably acknowledged — the precise
   *  "is anything unsaved?" signal. In send-and-forget it drains on send. */
  wsLogData.unackedCount = () => outbox().unconfirmedCount();

  /** Ask (or re-ask) for the state snapshot. Idempotent: asking twice is
   *  free, never asking again is a hang (§6). */
  wsLogData.requestState = () => apply(engine.requestState(FETCH_BLOB_FRAME));

  wsLogData.queueDebug = {
    count: () => outbox().unconfirmedCount(),
    inspect: (limit = 20) => outbox().inspect(limit),
    clear: () => outbox().clear()
  };

  /** A full-state overwrite, and the one frame that violates the consumer
   *  contract §1 leans on — legacy, quarantined, scheduled for demolition
   *  (§12). It is an event like any other as far as delivery is concerned:
   *  stamped before enqueue (L5), acked by identity, confirmed by that ack.
   *  The separate save_blob_ack/nack + token drives the UI's save status. */
  util.consumeCustomEvent('save_blob', (data: unknown) => {
    const { blob, token } = data as { blob: unknown; token: number };
    const frame: Record<string, unknown> = { event: 'save_blob', blob, token };
    util.timestampEvent(frame);
    outbox().enqueue(JSON.stringify(frame));
  });

  return wsLogData;
}

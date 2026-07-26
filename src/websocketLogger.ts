import { Queue } from './queue.js';
import * as disabler from './disabler.js';
import * as util from './util.js';
import * as debug from './debugLog.js';
import { storage } from './browserStorage.js';
import type { Logger, LeasedItem } from './types.js';

interface WsHostOverrides {
  hostname?: string;
  port?: string | number;
  path?: string;
  url?: string;
}

interface WsLoggerOptions {
  /**
   * Whether this client REQUIRES the server's ack capability. Default false.
   *
   * false (writing_observer, other ack-less consumers): if ack isn't
   *   advertised, fall back to legacy send-and-delete (graceful degrade).
   * true (lo-blocks): if the server doesn't advertise `ack` (no `hello`,
   *   `hello` without it, or the grace window expires), FAIL LOUDLY — throw +
   *   visible error, and do NOT run legacy. A require-ack client on an
   *   ack-less server is a mis-deploy; running legacy silently loses events,
   *   which is the exact bug this protocol fixes. Fail fast, never run bad code.
   */
  requireAck?: boolean;
}

function wsHost(overrides: WsHostOverrides = {}, loc = window.location) {
  const { hostname, port, path, url } = overrides;
  const protocol = loc.protocol === 'https:' ? 'wss://' : 'ws://';
  const host = hostname || loc.hostname;
  const portNumber = port || loc.port || (loc.protocol === 'https:' ? 443 : 80);
  const pathname = path || '/wsapi/in/';
  const fullUrl = url || `${host}:${portNumber}${pathname}`;

  return `${protocol}${fullUrl}`;
}


export function websocketLogger (server: string | WsHostOverrides = {}, opts: WsLoggerOptions = {}): Logger {
  /*
    This is a pretty complex logger, which sends events over a web
    socket.

    `server` can be a URL (usually, ws:// or wss://) or an object
    containing one or more of hostname, port, path, and url.

    Note that if the server is an object, it can be overwritten in
    storage (key loServer).

    Most of the complexity comes from reconnections, retries,
    etc. and the need to keep robust queues, as well as the need be
    robust about queuing events before we have a socket open or during
    a network failure.
  */
  let socket: WebSocket | null = null;
  // Minimal WebSocket constructor — works with both browser WebSocket and the `ws` package
  let WSLibrary: new (url: string) => WebSocket;
  const queue = new Queue('websocketLogger');
  // This holds an exception, if we're blacklisted, between the web
  // socket and the API. We generate this when we receive a message,
  // which is not a helpful place to raise the exception from, so we
  // keep this around until we're called from the client, and then we
  // raise it there.
  let blockerror: disabler.BlockError | null = null;
  let metadata: Record<string, unknown> = {};

  // Resolve server to a URL string
  let serverUrl: string;
  if(!server) {
    serverUrl = wsHost();
  } else if(typeof server === 'object') {
    serverUrl = wsHost(server);
  } else {
    serverUrl = server;
  }

  function calculateExponentialBackoff (n: number) {
    return Math.min(1000 * Math.pow(2, n), 1000 * 60 * 15);
  }

  let failures = 0;
  let READY = false;
  let wsFailureResolve: (() => void) | null = null;
  let wsFailurePromise: Promise<void> | null = null;
  let wsConnectedResolve: ((value: boolean) => void) | null = null;

  // Ack protocol (Plane 1). Engaged only when the server advertises it via a
  // `hello` frame on THIS connection; against ack-less servers (writing_observer,
  // pre-upgrade lo-blocks) behavior is byte-identical to before: send-and-delete.
  //
  // Capability resolution is a GATE, not just a flag. On every (re)connection we
  // must NOT send until the mode is known: the window between socket-open and the
  // hello frame is exactly where rewind() hands out the durable resend backlog,
  // and sending it in legacy delete-on-send mode against an ack-capable server
  // would silently lose it. So sendLeased awaits the gate; `hello` opens it
  // authoritatively, and a grace timeout opens it as legacy for servers that
  // never say hello.
  // Comfortably > worst-case hello arrival. Legacy events simply wait this long
  // in the durable queue before first send — harmless (never lost). Optionally,
  // convert to a per-logger setting when needed (e.g. a high-frequency ack-less
  // client that wants a shorter first-send delay).
  const HELLO_GRACE_MS = 3000;
  const requireAck = opts.requireAck ?? false;
  let ackMode = false;
  let helloSeen = false;
  let capsGate: Promise<void> = Promise.resolve();
  let openCapsGate: (() => void) | null = null;
  // Identifies the current connection for the grace timer / gate-then callbacks.
  // Bumped when a connection opens AND when it closes, so a previous
  // connection's pending grace timer can't fire against a newer (still
  // connecting) connection's capability state.
  let connGen = 0;
  // Mirrors the sticky fatal banner state (useFatal): true once we've dispatched
  // lo_fatal, cleared when we recover (a late ack-capable hello). Not reset per
  // connection — it tracks the surfaced banner across reconnects until resolved.
  let fatalActive = false;

  // Per-connection reset: nothing is known about the new socket's capabilities
  // until its hello (or the grace timeout). Called from newWebsocket() before
  // onopen/onmessage, so a fast hello can't be clobbered.
  function resetCaps () {
    ackMode = false;
    helloSeen = false;
    capsGate = new Promise<void>((resolve) => { openCapsGate = resolve; });
  }
  function openGate () {
    if (openCapsGate) { openCapsGate(); openCapsGate = null; }
  }

  // The connection resolved to NO ack capability (no hello / hello without ack /
  // grace expired). requireAck clients fail loud and refuse legacy; others fall
  // back to legacy send-and-delete.
  function resolveNonAck (reason: string) {
    if (!requireAck) {
      openGate();   // legacy fallback (ackMode already false)
      return;
    }
    const msg = `lo_event: server did not advertise ack (${reason}) but this client requires it — ` +
      'refusing to run legacy (would silently lose events). Fix the deploy (server needs the ack half).';
    // Failure heuristic: console + localStorage + a consumer surface.
    debug.error(msg);                                              // 1. console
    if (!fatalActive) {
      fatalActive = true;
      util.recordFailure({ code: 'ACK_REQUIRED', message: msg }); // 2. localStorage (bounded)
      // 3. consumer surface — reactive useFatal → lo-blocks banner. We do NOT
      // throw from the logging path: the event is captured either way, and
      // throwing would only endanger delivery to sibling loggers.
      util.dispatchCustomEvent('lo_fatal', { detail: { code: 'ACK_REQUIRED', message: msg } });
    }
    // Deliberately do NOT open the gate: sendLeased stays held, so events
    // accumulate in the durable queue rather than going out un-acked and lost.
  }

  // THREE NUMBERS, THREE SCOPES — do not collapse them again.
  //
  //   1. storage id   — the queue's own key. Scope: this browser's shared
  //                     store. Orders and leases. NEVER goes on the wire: it
  //                     is meaningless outside that database.
  //   2. wire seq     — `wireSeq` below. Scope: ONE connection, restarting at
  //                     1 each time. This is what the server acks.
  //   3. identity     — [browser].[tab].[seq] (browserTag / sessionTag /
  //                     sessionIndex, already stamped on every event). Scope:
  //                     forever. For dedup, analytics, forensics. Never used
  //                     for acks or deletes.
  //
  // Collapsing 1 and 2 was the bug: cumulative acking is only sound when the
  // acknowledged sequence belongs to exactly one connection, and the storage
  // id is shared by every tab. A per-connection counter is owned by one
  // connection BY CONSTRUCTION, so there is nothing to coordinate.
  //
  // `sentThisConn` maps wire seq -> storage id for what this socket has sent
  // and not yet had acked. It is the precise answer to "what may I delete?",
  // and it is discarded on disconnect: unacked records simply stay in the
  // store and are re-sent (under fresh wire seqs) after rewind().
  let wireSeq = 0;
  const sentThisConn = new Map<number, number>();

  function resetConnectionSeq () {
    wireSeq = 0;
    sentThisConn.clear();
  }

  /** Storage ids this connection sent with wire seq <= n (cumulative ack). */
  function drainAcked (n: number): number[] {
    const ids: number[] = [];
    for (const [w, storageId] of sentThisConn) {
      if (w <= n) { ids.push(storageId); sentThisConn.delete(w); }
    }
    return ids;
  }

  // Tag an outgoing event with its wire seq so the server can ack it.
  // Only used in ack mode; leaves non-JSON frames untouched.
  //
  // `seq` is a RESERVED transport field (top-level, per the wire contract the
  // server acks against). Applications must not use a top-level `seq` on their
  // events — the ack protocol overwrites it. Not guarded at runtime: it's a
  // documented reserved key, not a phantom case to police per event.
  function tagSeq (item: unknown, seq: number): string {
    if (typeof item !== 'string') return JSON.stringify(item);
    try {
      const obj = JSON.parse(item);
      if (obj && typeof obj === 'object') {
        obj.seq = seq;
        return JSON.stringify(obj);
      }
    } catch { /* not JSON — can't tag, send verbatim */ }
    return item;
  }

  // Send a leased item. Ack mode: tag with seq and keep it queued until the
  // server acks. Legacy: send verbatim and confirm immediately (delete-on-send,
  // exactly today's behavior). Held until the connection's mode is resolved.
  async function sendLeased ({ seq, item }: LeasedItem) {
    await capsGate;
    // The gate is also resolved on disconnect (see the connection loop) to
    // unblock a send parked in the pre-hello window. If the connection is no
    // longer ready, do NOT send or confirm — leave the item leased-but-
    // unconfirmed; rewind() re-hands it on the next connection. Without this,
    // a resolved-on-disconnect gate would send on a dead socket and, in legacy
    // mode, confirm(delete) an event that never went out.
    if (!READY) return;
    if (ackMode) {
      // `seq` is the STORAGE id; the wire carries this connection's own counter.
      const w = ++wireSeq;
      sentThisConn.set(w, seq);
      socket!.send(tagSeq(item, w));
    } else {
      socket!.send(item as string);
      queue.confirm([seq]);
    }
  }

  async function startWebsocketConnectionLoop () {
    // A websocketLogger IS configured, so establish the status as offline (false)
    // rather than leaving it null. null means "no websocket configured / nothing
    // persists"; without this, repeated INITIAL connect failures (never yet
    // connected) leave it null and hide the offline indicator. setConnected
    // dedupes, so this is a no-op once we actually connect.
    util.dispatchCustomEvent('lo_connection_status', { detail: { connected: false } });
    while (true) {
      const connected = await newWebsocket();
      if (!connected) {
        failures++;
        await util.delay(calculateExponentialBackoff(failures));
      } else {
        READY = true;
        // New connection: the wire seq restarts at 1 and nothing is in flight.
        // Anything the previous socket sent but never had acked is still in the
        // store (we only ever delete on ack), so rewind() re-hands it below.
        resetConnectionSeq();
        failures = 0;
        util.dispatchCustomEvent('lo_connection_status', { detail: { connected: true } });
        // Resolve this connection's capability mode, THEN resend. hello opens the
        // gate authoritatively; otherwise the grace timer opens it as legacy. The
        // gen guard stops a stale timer from mis-flagging a newer connection.
        const myGen = ++connGen;
        const gate = capsGate;
        const myOpen = openCapsGate;   // THIS connection's gate resolver, captured
        util.delay(HELLO_GRACE_MS).then(() => {
          if (myGen === connGen && !helloSeen) resolveNonAck('no hello within grace window');
        });
        // Resend unconfirmed items only after the mode is known, so nothing is
        // handed to sendLeased (including the rewind-woken parked consumer) while
        // the mode is still unknown — the race the reviewers caught.
        gate.then(() => { if (myGen === connGen) queue.rewind(); });
        await socketClosed();
        READY = false;
        // Invalidate this connection's generation on close, so a still-pending
        // grace timer (or gate-then) from THIS connection no-ops instead of
        // firing against the NEXT connection's capability state while it's still
        // connecting (connGen would otherwise be unchanged until that one opens).
        connGen++;
        // Unblock any sendLeased parked on THIS connection's gate BEFORE the next
        // newWebsocket()/resetCaps() reassigns the shared gate and orphans it.
        // With READY already false, the unblocked sendLeased skips (item stays
        // unconfirmed; rewind resends it) rather than hanging the lease loop
        // forever — the deadlock both reviewers flagged. Idempotent if the gate
        // was already opened by hello/grace.
        if (myOpen) myOpen();
        util.dispatchCustomEvent('lo_connection_status', { detail: { connected: false } });
      }
    }
  }

  function socketClosed () { return wsFailurePromise; }

  function newWebsocket () {
    // New connection: capabilities unknown until its `hello` (or grace). Reset
    // here (before onopen/onmessage) so a fast hello can't be clobbered.
    resetCaps();
    socket = new WSLibrary(serverUrl);
    wsFailurePromise = new Promise<void>((resolve) => {
      wsFailureResolve = resolve;
    });
    const wsConnectedPromise = new Promise<boolean>((resolve) => {
      wsConnectedResolve = resolve;
    });
    socket.onopen = () => { prepareSocket(); wsConnectedResolve!(true); };
    socket.onerror = function (e) {
      debug.error('Could not connect to websocket', e);
      wsConnectedResolve!(false);
      wsFailureResolve!();
    };
    socket.onclose = () => { wsConnectedResolve!(false); wsFailureResolve!(); };
    socket.onmessage = receiveMessage;
    return wsConnectedPromise;
  }

  function prepareSocket () {
    if(Object.keys(metadata).length > 0) {
      queue.enqueue(JSON.stringify(metadata));
    }
  }

  async function waitForWSReady () {
    return await util.backoff(
      () => (READY),
      'WebSocket not ready',
      undefined,
      util.TERMINATION_POLICY.RETRY
    );
  }

  function receiveMessage (event: MessageEvent) {
    const response = JSON.parse(event.data);
    switch (response.status) {
      case 'hello':
        // Capability negotiation. Ack mode engages only if the server
        // advertises it; anything unadvertised stays off (graceful degrade).
        // Opening the gate authoritatively releases held sends in the right mode
        // (a late hello, after the grace timeout, still upgrades later sends).
        helloSeen = true;
        ackMode = !!(response.capabilities && response.capabilities.ack);
        if (ackMode) {
          openGate();
          if (fatalActive) {
            // Recovered — e.g. a slow ack-capable hello arrived after the grace
            // window already flagged ACK_REQUIRED. Clear the sticky banner.
            fatalActive = false;
            util.dispatchCustomEvent('lo_fatal', { detail: null });
          }
        } else {
          // Server said hello but without ack — a require-ack client must not
          // proceed in legacy.
          resolveNonAck('hello without ack capability');
        }
        debug.info(`websocket hello; ack mode ${ackMode ? 'on' : 'off'}`);
        break;
      case 'ack':
        // Cumulative: the server durably wrote everything through response.seq.
        if (typeof response.seq === 'number') {
          queue.confirm(drainAcked(response.seq));
        }
        break;
      case 'blocklist':
        debug.info('Received block error from server');
        blockerror = new disabler.BlockError(
          response.message,
          response.time_limit,
          response.action
        );
        break;
      case 'auth': {
        // Server pushes identity after it resolves the WS auth (HTTP Basic via
        // nginx, LTI session, guest cookie, etc.). We stash it in the storage
        // shim (for non-Redux consumers) and dispatch a DOM CustomEvent so
        // reduxLogger (and anything else that listens) can react.
        //
        // Forward-compat: we spread every field except `status` into the user
        // object so new profile fields (avatar, role, safe_user_id, ...) added
        // server-side flow through without touching this file. Consumers
        // should treat `user_id` as the only required field.
        const { status, ...user } = response;
        storage.set(user);
        util.dispatchCustomEvent('auth', { detail: user });
        break;
      }
      // These should probably be behind a feature flag, as they assume
      // we trust the server.
      case 'local_storage':
        storage.set({ [response.key]: response.value });
        break;
      case 'browser_event':
        util.dispatchCustomEvent(response.event_type, { detail: response.detail });
        break;
      case 'fetch_blob':
        util.dispatchCustomEvent('fetch_blob', { detail: response.data });
        break;
      case 'save_blob_ack':
        util.dispatchCustomEvent('save_blob_ack', { detail: { token: response.token } });
        break;
      case 'save_blob_nack':
        util.dispatchCustomEvent('save_blob_nack', { detail: { token: response.token } });
        break;
      default:
        debug.info(`Received response we do not yet handle: ${JSON.stringify(response)}`);
        break;
    }
  }

  function checkForBlockError () {
    if (blockerror) {
      console.log('Throwing block error');
      const b = blockerror;
      blockerror = null;
      socket!.close();
      throw b;
    }
  }

  function wsLogData (data: string) {
    checkForBlockError();
    // Capture is unconditional and durable — an event that reaches here ALWAYS
    // makes it into the queue, regardless of gate/fatal/UX state. The requireAck
    // mis-deploy is surfaced loudly via console.error + useFatal (reactive), NOT
    // by throwing: sendEvent (loEvent) re-throws non-BlockError out of its
    // fan-out over a DESTRUCTIVE front-desk queue, which would skip sibling
    // loggers and lose the event for them — violating "every event delivered".
    queue.enqueue(data);
  }

  wsLogData.init = async function () {
    // Check storage for server override (the storage API is callback-based,
    // so this must happen in async context, not at construction time)
    try {
      const stored = await new Promise(resolve => storage.get('lo_server', resolve));
      if (stored && (stored as Record<string, unknown>).lo_server) {
        debug.info('Overriding server from storage');
        serverUrl = (stored as Record<string, unknown>).lo_server as string;
      }
    } catch (e) {
      debug.info('Could not check storage for server override');
    }

    if (typeof WebSocket === 'undefined') {
      debug.info('Importing ws');
      WSLibrary = (await import('ws')).WebSocket as unknown as new (url: string) => WebSocket;
    } else {
      debug.info('Using built-in websocket');
      WSLibrary = WebSocket;
    }
    startWebsocketConnectionLoop();
    queue.startDequeueLoop({
      initialize: waitForWSReady,
      shouldDequeue: waitForWSReady,
      // Lease discipline: hold each item until the server acks it (ack mode)
      // or until it's sent (legacy). See sendLeased.
      onLease: sendLeased
    });
  };

  // Number of enqueued-but-unacked items — drives the unsaved-changes warning
  // (in ack mode; legacy confirms on send so this trends to zero immediately).
  wsLogData.unackedCount = function () { return queue.unconfirmedCount(); };

  wsLogData.setField = function (data: string) {
    util.mergeDictionary(metadata, JSON.parse(data));
    queue.enqueue(data);
  };

  function handleSaveBlob (data: unknown) {
    const { blob, token } = data as { blob: unknown; token: number };
    queue.enqueue(JSON.stringify({ event: 'save_blob', blob, token }));
  }

  util.consumeCustomEvent('save_blob', handleSaveBlob);

  return wsLogData as Logger;
}

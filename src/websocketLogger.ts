import { Queue } from './queue.js';
import * as disabler from './disabler.js';
import * as util from './util.js';
import * as debug from './debugLog.js';
import { storage } from './browserStorage.js';
import { StateRequest } from './stateRequest.js';
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

  // TWO NUMBERS, TWO SCOPES.
  //
  //   1. storage id — the queue's own key. Scope: this browser's shared store.
  //                   Orders and leases. Never goes on the wire: it is
  //                   meaningless outside that database.
  //   2. identity   — metadata.eventId, `<browser>.<session>.<seq>`, stamped at
  //                   creation. Scope: forever. This is what the server acks.
  //
  // There is deliberately no third, transport-level sequence. An ack keyed on
  // identity is a fact anyone can act on ("the server durably has this event"),
  // where a per-connection counter is meaningful only to the socket that
  // issued it — its meaning dies with that socket, which is exactly wrong for
  // a store shared by tabs that drain each other's leftovers. It also lets a
  // server eventually say "I have <session> through <seq>" across a reconnect.
  //
  // Consequence worth noticing: nothing tags or rewrites the outgoing frame
  // any more. Events go out verbatim, because they already carry their name.
  //
  // `inFlight` maps eventId -> storage id for what has been sent and not yet
  // acked. It is NOT reset per connection: an identity means the same thing on
  // every connection, and a resend simply rewrites the same entry. Deleting is
  // then exactly "the record this ack names", never a range and never a guess.
  const inFlight = new Map<string, number>();

  // CONNECTION-SCOPED RPC — deliberately NOT durable.
  //
  // A state snapshot request (fetch_blob) is a property of a CONNECTION, not of
  // durable history: its answer comes back on the socket that asked, once, and
  // is worthless to anyone else. Putting it in the durable queue produced two
  // hangs that both end in "Loading user state..." forever:
  //
  //   1. The queue is shared across tabs, so ANOTHER tab could lease the
  //      request and send it on ITS socket. The server answered that tab. The
  //      tab that actually needed the state waited for a reply addressed
  //      elsewhere.
  //   2. Acks are durable-capture, not request-fulfilment. If the socket
  //      dropped after the ack but before the response frame, the record was
  //      deleted as safely delivered while the answer never arrived — and
  //      nothing re-asked.
  //
  // So: never queued, sent directly, and re-sent on every connection while it
  // is still outstanding. Re-asking is free (the request is idempotent) and it
  // makes reconnect self-healing instead of terminal.
  const STATE_REQUEST = 'fetch_blob';
  // The rules and the reasons live in stateRequest.ts, along with the tests.
  // Loose counters and flags in this file are what produced three regressions
  // in a row, none of them reachable by a test from here.
  const stateRequest = new StateRequest();

  function isStateRequest (item: unknown): boolean {
    if (typeof item !== 'string') return false;
    // Substring pre-filter first: this runs on EVERY outgoing event, and
    // sendLeased parses again for the id — a double JSON.parse per event is
    // real cost when payloads carry a whole parsed idMap. The parse below only
    // runs for the handful of frames that could actually be a state request.
    if (!item.includes('"' + STATE_REQUEST + '"')) return false;
    try { return JSON.parse(item)?.event === STATE_REQUEST; } catch { return false; }
  }

  // THE FLUSH BARRIER, asked of the queue rather than counted here.
  //
  // Two count-based designs preceded this and both were structurally wrong on
  // a shared store (see stateRequest.ts for the full history): a captured
  // count is not a per-connection quota, because another tab can send-and-
  // delete shared records this connection was being measured against — it
  // then never observes that many sends and the barrier starves. Only the
  // queue knows what remains, so the barrier is: capture the highest stored
  // seq at connection start (after rewind — the lease cursor is part of the
  // question), then ask `unleasedAtOrBelow(watermark)` until it reaches zero.
  // Records below the watermark that vanish un-leased were deleted by an ack,
  // meaning the server already has them — the barrier clears correctly
  // without this connection ever seeing them.
  //
  // Re-checks are event-driven (each send nudges), with a slow fallback timer
  // for the case with no local events at all: an idle page whose backlog is
  // drained entirely by another tab. Cross-tab deletions emit no signal here,
  // so without the timer that page would never notice the barrier cleared.
  // The timer runs until the barrier clears (bounded — the backlog drains),
  // whether or not a request is waiting yet: the request can arrive later
  // than the connection, and must find the barrier already being evaluated.
  const BARRIER_RECHECK_MS = 300;
  let barrierWatermark: number | null = null;   // null = not captured / no backlog
  let barrierGen = -1;                          // connGen the watermark belongs to
  let barrierTimer: ReturnType<typeof setInterval> | null = null;
  let barrierCheckInFlight = false;
  // True while a leased record is between "cursor advanced" and "socket.send
  // done". The probe counts by the lease cursor, so in this window a record
  // looks sent that isn't — a timer probe resolving here could clear the
  // barrier one record early and let the snapshot jump the last backlog
  // frame on the wire. The lease loop is strictly serial (queue.ts awaits
  // onLease), so one flag is coherent; a probe that lands in the window skips,
  // and the send's own nudge re-probes immediately after.
  let sendInFlight = false;

  function stopBarrierTimer () {
    if (barrierTimer !== null) { clearInterval(barrierTimer); barrierTimer = null; }
  }

  async function checkBarrier (myGen: number, watermark: number) {
    if (barrierCheckInFlight) return;   // one probe at a time; next nudge retries
    barrierCheckInFlight = true;
    try {
      const pending = await queue.unleasedAtOrBelow(watermark);
      if (myGen !== connGen) return;    // stale connection — its barrier is moot
      if (sendInFlight) return;         // mid-send window: the nudge after it re-probes
      if (pending === 0) {
        stopBarrierTimer();
        stateRequest.barrierCleared();
        sendStateRequest();
      }
    } catch (err) {
      // An unreadable store must not strand the snapshot forever: fall back
      // to no barrier, which is the pre-barrier behavior.
      debug.error('WEBSOCKET: could not probe the flush barrier; asking for state without it', err);
      if (myGen === connGen) {
        stopBarrierTimer();
        stateRequest.barrierCleared();
        sendStateRequest();
      }
    } finally {
      barrierCheckInFlight = false;
    }
  }

  /** Start barrier evaluation for this connection. Called from the gate-then,
   *  AFTER rewind(): unleasedAtOrBelow measures against the lease cursor, and
   *  before rewind the cursor still holds the previous connection's position,
   *  which would make the backlog look already-sent. */
  function startBarrier (myGen: number) {
    void Promise.resolve(queue.maxSeq())
      .then((watermark) => {
        if (myGen !== connGen) return;
        if (watermark === null) {
          // Empty queue at connection start: nothing to flush. The common
          // page-load case — the snapshot goes out as soon as it is requested.
          stateRequest.barrierCleared();
          sendStateRequest();
          return;
        }
        barrierWatermark = watermark;
        barrierGen = myGen;
        void checkBarrier(myGen, watermark);
        stopBarrierTimer();
        // Runs until the barrier clears — NOT until a request is waiting.
        // The barrier is a property of the connection, and the request can
        // arrive later than the connection does (ReduxStoreLoader asks once
        // auth has landed). Stopping while nothing was outstanding would
        // leave a late request with no probe to clear it. Bounded either
        // way: the backlog drains, and the timer stops the moment it does.
        barrierTimer = setInterval(() => {
          if (myGen !== connGen || stateRequest.barrierIsClear()) { stopBarrierTimer(); return; }
          void checkBarrier(myGen, watermark);
        }, BARRIER_RECHECK_MS);
      })
      .catch((err) => {
        debug.error('WEBSOCKET: could not capture the flush watermark; asking for state without the barrier', err);
        if (myGen === connGen) {
          stateRequest.barrierCleared();
          sendStateRequest();
        }
      });
  }

  /** One record left this connection; the barrier may have just cleared. */
  function nudgeBarrier () {
    if (!stateRequest.barrierIsClear() && barrierWatermark !== null && barrierGen === connGen) {
      void checkBarrier(barrierGen, barrierWatermark);
    }
  }

  function sendStateRequest () {
    if (!READY) return;
    if (stateRequest.shouldSend()) socket!.send(stateRequest.frame()!);
  }

  /** The event's own name, or null for frames we cannot read. */
  function eventIdOf (item: unknown): string | null {
    if (typeof item !== 'string') return null;
    try {
      const obj = JSON.parse(item);
      const id = obj?.metadata?.eventId;
      return typeof id === 'string' ? id : null;
    } catch { return null; }
  }

  // Send a leased item. Ack mode: tag with seq and keep it queued until the
  // server acks. Legacy: send verbatim and confirm immediately (delete-on-send,
  // exactly today's behavior). Held until the connection's mode is resolved.
  async function sendLeased ({ seq, item }: LeasedItem) {
    // Set BEFORE the first await: this record's lease cursor has already
    // advanced, so from here until socket.send completes, a barrier probe
    // would over-count progress. See sendInFlight above.
    sendInFlight = true;
    try {
      await sendLeasedInner({ seq, item });
    } finally {
      sendInFlight = false;
    }
  }

  async function sendLeasedInner ({ seq, item }: LeasedItem) {
    await capsGate;
    // The gate is also resolved on disconnect (see the connection loop) to
    // unblock a send parked in the pre-hello window. If the connection is no
    // longer ready, do NOT send or confirm — leave the item leased-but-
    // unconfirmed; rewind() re-hands it on the next connection. Without this,
    // a resolved-on-disconnect gate would send on a dead socket and, in legacy
    // mode, confirm(delete) an event that never went out.
    if (!READY) return;
    if (ackMode) {
      // `seq` here is the STORAGE id — it stays local. The event travels
      // untouched; the server acks the name the event already carries.
      const id = eventIdOf(item);
      if (id === null) {
        // UNNAMED RECORD — legacy best-effort, then drop it.
        //
        // The server acks by name, so a record without one can never be
        // confirmed: it would sit in the durable queue forever and be resent on
        // every reconnect. That is not hypothetical — every record enqueued by
        // a pre-identity build is unnamed, and they are already sitting in real
        // IndexedDB queues.
        //
        // Send-and-confirm is the honest handling: these were written by a
        // client that never promised durable tracking (its transport tagged
        // whatever it happened to send), so delete-on-send is exactly the
        // guarantee they were created under. Holding them for an ack that
        // cannot arrive trades a real leak for a promise nobody made.
        //
        // Post-transition, an unnamed frame means a new enqueue path forgot to
        // stamp — hence the log. Draining beats leaking either way.
        debug.error(
          'WEBSOCKET: frame has no metadata.eventId — sent best-effort and ' +
          'dropped, since an unnamed record can never be acked. Legacy queue ' +
          'contents are expected here; anything else is an unstamped enqueue ' +
          'path (see enqueueOwnFrame).',
          item
        );
        socket!.send(item as string);
        queue.confirm([seq]);
        nudgeBarrier();
        return;
      }
      // NOTE: an entry can linger if another tab ends up delivering this record
      // (the planned stale-drain). Harmless — storage ids are never reused, so
      // a stale entry cannot cause a wrong delete. Do NOT "fix" this by
      // resetting per connection: identities outlive connections, which is the
      // whole point of acking by name.
      inFlight.set(id, seq);
      socket!.send(item as string);
      nudgeBarrier();
    } else {
      socket!.send(item as string);
      queue.confirm([seq]);
      // Legacy mode nudges too. Skipping it here once meant the barrier was
      // never satisfied in ack-less deployments — a permanent "loading" on
      // the path that worked before any of this.
      nudgeBarrier();
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
        // Snapshot state resets with the connection, BEFORE the capability
        // gate can open: the barrier starts un-evaluated (refuses to send),
        // and is captured/probed by startBarrier() after rewind() below.
        stateRequest.connected();
        barrierWatermark = null;
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
        // the mode is still unknown — the race the reviewers caught. The flush
        // barrier starts here too, AFTER rewind: it measures against the lease
        // cursor, which rewind has just reset — before that, the cursor still
        // holds the previous connection's position and would make the backlog
        // look already-sent. (If the gate never opens — requireAck against an
        // ack-less server — the barrier never evaluates and no snapshot is
        // requested, consistent with events being held.)
        gate.then(() => {
          if (myGen !== connGen) return;
          queue.rewind();
          startBarrier(myGen);
        });
        await socketClosed();
        READY = false;
        stateRequest.disconnected();
        stopBarrierTimer();
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

  // Frames this logger constructs itself (as opposed to events handed down
  // already stamped by loEvent.logEvent). They MUST be stamped too: an ack
  // names metadata.eventId, so an unnamed frame can never be acked, and a
  // record that is never acked is never deleted. It sits in the durable queue
  // forever and is resent on every reconnect. save_blob fires on every state
  // save, so "unnamed" shows up as a queue that only grows.
  function enqueueOwnFrame (frame: Record<string, unknown>) {
    util.timestampEvent(frame);
    queue.enqueue(JSON.stringify(frame));
  }

  function prepareSocket () {
    if(Object.keys(metadata).length > 0) {
      // Copy: timestampEvent would otherwise stamp the long-lived metadata
      // dict itself, and every later send would carry the first frame's id.
      enqueueOwnFrame({ ...metadata });
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
      case 'ack': {
        // The server durably wrote the event it names. Delete exactly that one.
        const acked = response.id;
        if (typeof acked === 'string') {
          const storageId = inFlight.get(acked);
          if (storageId !== undefined) {
            inFlight.delete(acked);
            queue.confirm([storageId]);
          }
        }
        break;
      }
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
        // Auth is what the server needs before it can route a state request,
        // so this is a trigger to (re-)ask — but it owns none of the
        // bookkeeping, which belongs to the connection (see READY above).
        sendStateRequest();
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
        stateRequest.fulfilled();   // answered; stop re-asking
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
    if (isStateRequest(data)) {
      // Connection-scoped: remembered, sent when the backlog is out, re-sent on
      // reconnect — never persisted. See stateRequest.ts.
      stateRequest.request(data);
      nudgeBarrier();     // the request can arrive after the barrier evaluation started
      sendStateRequest();
      return;
    }
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

  // Debug surface for this logger's durable queue. Reached from a console via
  // lo_event.queueDebug() — see loEvent.ts.
  wsLogData.queueDebug = {
    count: () => queue.unconfirmedCount(),
    inspect: (limit = 20) => queue.inspect(limit),
    clear: () => queue.clear(),
  };

  wsLogData.setField = function (data: string) {
    util.mergeDictionary(metadata, JSON.parse(data));
    queue.enqueue(data);
  };

  function handleSaveBlob (data: unknown) {
    const { blob, token } = data as { blob: unknown; token: number };
    enqueueOwnFrame({ event: 'save_blob', blob, token });
  }

  util.consumeCustomEvent('save_blob', handleSaveBlob);

  return wsLogData as Logger;
}

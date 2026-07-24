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

function wsHost(overrides: WsHostOverrides = {}, loc = window.location) {
  const { hostname, port, path, url } = overrides;
  const protocol = loc.protocol === 'https:' ? 'wss://' : 'ws://';
  const host = hostname || loc.hostname;
  const portNumber = port || loc.port || (loc.protocol === 'https:' ? 443 : 80);
  const pathname = path || '/wsapi/in/';
  const fullUrl = url || `${host}:${portNumber}${pathname}`;

  return `${protocol}${fullUrl}`;
}


export function websocketLogger (server: string | WsHostOverrides = {}): Logger {
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
  const HELLO_GRACE_MS = 3000;   // comfortably > worst-case hello arrival. Legacy
                                 // events simply wait this long in the durable
                                 // queue before first send — harmless.
  let ackMode = false;
  let helloSeen = false;
  let capsGate: Promise<void> = Promise.resolve();
  let openCapsGate: (() => void) | null = null;
  let connGen = 0;               // guards a stale grace timer against a newer connection

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

  // Tag an outgoing event with its durable seq so the server can ack it.
  // Only used in ack mode; leaves non-JSON frames untouched.
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
    if (ackMode) {
      socket!.send(tagSeq(item, seq));
    } else {
      socket!.send(item as string);
      queue.confirm(seq);
    }
  }

  async function startWebsocketConnectionLoop () {
    while (true) {
      const connected = await newWebsocket();
      if (!connected) {
        failures++;
        await util.delay(calculateExponentialBackoff(failures));
      } else {
        READY = true;
        failures = 0;
        util.dispatchCustomEvent('lo_connection_status', { detail: { connected: true } });
        // Resolve this connection's capability mode, THEN resend. hello opens the
        // gate authoritatively; otherwise the grace timer opens it as legacy. The
        // gen guard stops a stale timer from mis-flagging a newer connection.
        const myGen = ++connGen;
        const gate = capsGate;
        util.delay(HELLO_GRACE_MS).then(() => {
          if (myGen === connGen && !helloSeen) openGate();   // legacy: ackMode stays false
        });
        // Resend unconfirmed items only after the mode is known, so nothing is
        // handed to sendLeased (including the rewind-woken parked consumer) while
        // the mode is still unknown — the race the reviewers caught.
        gate.then(() => { if (myGen === connGen) queue.rewind(); });
        await socketClosed();
        READY = false;
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
        openGate();
        debug.info(`websocket hello; ack mode ${ackMode ? 'on' : 'off'}`);
        break;
      case 'ack':
        // Cumulative: the server durably wrote everything through response.seq.
        if (typeof response.seq === 'number') {
          queue.confirm(response.seq);
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

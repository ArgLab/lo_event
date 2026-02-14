import { Queue } from './queue.js';
import * as disabler from './disabler.js';
import * as util from './util.js';
import * as debug from './debugLog.js';
import { storage } from './browserStorage.js';
import type { Logger } from './types.js';

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

  async function startWebsocketConnectionLoop () {
    while (true) {
      const connected = await newWebsocket();
      if (!connected) {
        failures++;
        await util.delay(calculateExponentialBackoff(failures));
      } else {
        READY = true;
        failures = 0;
        await socketClosed();
        READY = false;
      }
    }
  }

  function socketClosed () { return wsFailurePromise; }

  function newWebsocket () {
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

  async function socketSend (item: unknown) {
    socket!.send(item as string);
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
      case 'blocklist':
        debug.info('Received block error from server');
        blockerror = new disabler.BlockError(
          response.message,
          response.time_limit,
          response.action
        );
        break;
      case 'auth':
        storage.set({ user_id: response.user_id });
        util.dispatchCustomEvent('auth', { detail: { user_id: response.user_id } });
        break;
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
      default:
        debug.info(`Received response we do not yet handle: ${response}`);
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
      onDequeue: socketSend
    });
  };

  wsLogData.setField = function (data: string) {
    util.mergeDictionary(metadata, JSON.parse(data));
    queue.enqueue(data);
  };

  function handleSaveBlob (blob: unknown) {
    queue.enqueue(JSON.stringify({ event: 'save_blob', blob }));
  }

  util.consumeCustomEvent('save_blob', handleSaveBlob);

  return wsLogData as Logger;
}

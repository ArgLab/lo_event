# Reliable-delivery implementation notes

`reliable-delivery.md` is the contract. This file records implementation shape
and the few choices the specification leaves open.

## Boundaries

- `protocol.ts` is the sans-I/O decision engine. Facts are method calls;
  decisions are plain data. It owns confirmation, reconnect behavior, the
  disabler gate, flush barrier, and state-request latch and timers.
- `websocketLogger.ts` owns sockets, clocks, reconnect policy, and the outbox.
  External facts enter one serial executor. Asynchronous storage reads do not
  occupy that executor while pending, so a stuck watermark read cannot prevent
  the barrier deadline from firing.
- `memoryQueue.ts` and `indexeddbQueue.ts` implement the same lease contract.
  The IndexedDB backend polls while parked because IndexedDB has no portable
  cross-context change notification.

## Deliberate choices

- Delivery profile is configuration: `autoack: false` is durable and
  `autoack: true` confirms on a verified-open send. There is no handshake.
- The default outbox namespace comes from `lo_event.init()`'s `source`; direct
  logger users fall back to the server URL. The delivery profile is part of the
  store name, so confirm semantics can never mix.
- `fetchState` defaults to `!autoack`: durable stateful applications load a
  snapshot, while send-and-forget telemetry does not create an irrelevant RPC.
  `logger.requestState()` supports later requests.
- Snapshot retry time starts only after the direct request reaches an OPEN
  socket. A failed direct send closes the socket so reconnect re-arms the latch.
- A permanent `MAINTAIN` command pauses delivery and retains the outbox. Only a
  permanent `DROP` privacy opt-out clears unsent records.
- The front desk remains an in-memory pre-go ordering buffer. It has no network
  or disabler gate; server policy begins only after each websocket logger has
  accepted the event into its outbox.

## Known open boundary

The public logger API is synchronous, while IndexedDB commit is asynchronous.
An enqueue failure is logged loudly but cannot yet be returned to `logEvent()`.
Making admission awaitable is API work described in specification section 11,
not silently claimed by this implementation.

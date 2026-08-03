# Implementation notes

`docs/reliable-delivery.md` is the specification. This file records where the
implementation departs from it or resolves something it left open, and — since
this build was written after reading three independent rebuilds of the same
spec — which of their defects it fixes by construction. Everything not listed
here follows the spec as written.

## Module layout

The spec names a sans-I/O decision core (§9) but not its shape. The code:

| file | role |
|---|---|
| `src/protocol.ts` | `DeliveryEngine` — the decision core. Facts in, decisions out. No socket, no store, no clock. |
| `src/websocketLogger.ts` | the adapter. Socket lifecycle, the lease loop, the tick, frame parsing, the disabler. No protocol decisions. |
| `src/queue.ts` | backend selection, the outbox facade, and the front desk's destructive loop. |
| `src/memoryQueue.ts`, `src/indexeddbQueue.ts` | the two backends, tested against one contract. |

`stateRequest.ts` is not restored. The snapshot latch and the flush barrier are
the same state machine as everything else in the protocol — they share the
connection generation, and the latch waits on the barrier's clearance — so
splitting them across modules meant duplicating that state. §9 permits
re-pointing imports and reshaping modules provided each assertion survives; the
five invariants from `tests/stateRequest.test.js` live in the "state snapshot"
block of `tests/protocol.test.js` (*un-evaluated refuses to send*, *ask once per
connection*, *re-ask on reconnect*, *stop once fulfilled*, *a new request
re-arms the latch*). That file is deleted.

## The fact / decision alphabet (§9)

Three names in the spec's list do not appear, each because nothing turns on
them:

- **`enqueued`** — a record enqueued after the watermark has a higher storage id
  and can never affect the barrier, and admission is not gated on anything.
  There is no decision to make, so it is not a fact.
- **`frameReceived`** — the frames that matter (`ack`, `fetch_blob`) are facts
  in their own right; a generic "something arrived" drives nothing.
- **`closeSocket`** — a blocklist pauses the lease loop rather than dropping the
  connection (closing would spin the reconnect loop through the whole block
  period for no gain). The adapter does close a socket whose send failed, but
  that is an adapter decision about a broken transport, not a protocol one.

Three additions:

- **`log`** is a decision. Every degradation must be loud (L17), and making the
  engine *name* the message is what lets a test assert that a barrier failure, a
  deadline, an unnamed record and a lost snapshot each say something.
- **`askFailed(gen)`** — the snapshot ask is executed directly on the socket, and
  that send can fail. Latching "asked" on a send that never happened would hold
  the request for a full re-ask timeout; this re-arms it immediately.
- **`clearOutbox`** — the permanent-opt-out deletion (§5), as a decision rather
  than something the adapter does on its own initiative. See below.

`disablerEngaged` takes `{ permanentOptOut }` rather than a bare "blocked".

## Fixes carried out relative to the three earlier rebuilds

Each of these is a defect one or more of `lo_event_fable`, `lo_event_opus` and
`lo_event_sol` shipped against this same spec. They are listed because "we
already know this shape of bug is reachable from this spec" is the most useful
thing this build inherits, and each has a test named for it.

1. **No disabler gate before the durable write.** `lo_event.go()` no longer
   passes `shouldDequeue: disabler.retry` into the front desk. Gating there
   holds events in the in-memory buffer for the length of a block — outside §1's
   promise, and lost if the tab closes. The gate is now the lease loop only,
   which is after the outbox commit (§5). Two of the three rebuilds kept the
   front-desk gate. *(websocketLogger.test.js: "keeps accepting and storing
   events while blocked")*
2. **`clear()` only for a permanent opt-out.** `disabler.retry()` returns false
   for *any* permanent block, which is not the same question as "may I delete
   this user's unsent work?". Re-deriving that at the call site is how a
   permanent rate limit becomes silent data loss, which one rebuild shipped. The
   distinction now lives in `disabler.isPermanentOptOut()` (DROP *and*
   permanent), is passed to the engine as a fact, and is the only path to
   `clearOutbox`. *(websocketLogger.test.js: "a permanent rate limit stops
   sending WITHOUT deleting stored work")*
3. **The barrier deadline runs in every non-clear state.** Scoping it to
   `pending` leaves an *un-evaluated* barrier — the state that refuses to send —
   with no way out if the watermark measurement never settles: a permanent
   spinner with no error, the exact failure L17 forbids. One rebuild shipped
   that scoping. *(protocol.test.js: "opens on its deadline even if the
   watermark measurement never answers")*
4. **A rewind landing mid-scan is re-read, not overwritten.** `leaseNext()`
   reads the cursor, awaits a scan, and writes the cursor back; a rewind inside
   that window was undone by the write-back, skipping the backlog while the
   barrier counted it as leased. The cursor now carries an epoch that a rewind
   bumps, and a scan whose epoch moved re-runs. *(queueContract.test.js: "a
   rewind landing mid-scan is re-read, not overwritten" — verified to fail
   without the guard)*
5. **A parked consumer notices another context's write.** IndexedDB has no
   cross-context change notification, so a parked sender in an idle tab would
   sit on another tab's undelivered record until it happened to write something
   itself. A parked consumer re-scans every 300 ms; the poll runs only while
   parked. *(queueContract.test.js: "wakes a parked consumer when ANOTHER
   context enqueues")*
6. **`memoryQueue` wakes by re-scan too.** One rebuild fixed the ablated
   hand-off in the IndexedDB backend only and left `memoryQueue` byte-identical
   to the ablated original. The distinction is unobservable with a single
   writer, but the memory backend is the outbox in Node and in tests, and the
   contract is the contract.
7. **The outbox is namespaced by application.** The default store name derives
   from the `source` passed to `lo_event.init()`, delivered through a new
   `Logger.configure()` hook, because loggers are constructed before `init()`
   runs. Defaults of `'default'` or `'lo_event_outbox'` mean two apps on one
   origin share an outbox and drain each other's records unless every caller
   remembers to override. An explicit `namespace` option still wins.
8. **A persistently failing send does not spin the lease loop.** A `send()` that
   throws on a socket the runtime still reports as OPEN used to be retried every
   50 ms forever. The adapter now drops that socket; the connection loop
   reconnects with backoff and the rewind resends. *(websocketLogger.test.js: "a
   send that never went out is not confirmed, and recovers")*
9. **Both backends run one contract suite**, including the IndexedDB one, under
   `fake-indexeddb` — the storage rules (wake-by-rescan, the shared store, the
   cursor race) are otherwise untested, which is where two of these defects
   were hiding.
10. **Adapter-level tests exist at all.** Every defect above lived in the
    wiring, not in a decision core; a fake socket and a fake clock are what make
    that layer assertable.

## The metadata preamble (§5 step 2)

The spec says events are "held at the front desk until this frame is ahead of
them". They are not held: ordering comes from enqueue order instead. A fresh
`lock_fields` frame is enqueued at socket open, ahead of everything logged after
it, and `lo_event.go()` locks fields before events stream.

It is enqueued **after** this connection's `rewind()`, not before, which is the
opposite of what "step 2 precedes step 3" suggests. Enqueueing first can wake a
lease consumer that has been parked since the previous connection and whose
cursor is therefore stale: the preamble gets handed out ahead of the recovered
backlog, and is then sent a second time when the rewind re-hands everything.
Enqueueing after the rewind keeps the ordering the spec actually asks for — the
backlog leads, the preamble follows it, everything logged afterwards queues
behind the preamble — at the cost of the preamble not being counted in this
connection's barrier watermark. That cost is nil: the barrier orders the
snapshot after *prior* backlog, and the preamble carries no state.

The residue the spec already accepts: events already in the outbox from earlier
in the session precede the *new* connection's metadata frame. The server saw a
metadata frame for those events on the connection that enqueued them.

## Timings

The spec gives ranges; these are the values.

| constant | value | spec |
|---|---|---|
| `PROBE_INTERVAL_MS` | 300 ms | "~300ms" fallback probe (§7) |
| `BARRIER_DEADLINE_MS` | 5 s | "a few seconds" (§7) |
| `ASK_TIMEOUT_MS` | 10 s | "~10s" (§6) |
| adapter tick | 250 ms | not specified |
| cross-context queue poll | 300 ms | not specified |
| lease-loop retry pause | 50 ms | not specified |

The adapter ticks the engine only while a socket is open: every deadline the
engine tracks is per-connection or, in the snapshot's case, only meaningful on a
connection.

## Store naming (§2)

`lo-outbox.<namespace>.<durable|autoack>`. The profile is in the name, so mixing
confirm semantics on one store is impossible rather than merely forbidden.

## The front desk (§5)

`loEvent`'s front-desk queue is `IN_MEMORY`, unconditionally. Consequences:

- the `queueType` option is gone from `lo_event.init()`; it now belongs to
  `websocketLogger`, which owns the only durable store;
- `dequeue()` is optional on the `QueueBackend` interface and implemented only
  by `memoryQueue`. The durable store has exactly one read discipline, the
  lease, so no delivery path can delete a record merely by reading it.

## Reserved frame names (§12)

`lock_fields` joins `fetch_blob` and `save_blob` in the reserved set — the
logger constructs it, so an application event by that name would be misparsed
identically. `logEvent()` **throws** rather than dropping: it is a programming
error in the caller, caught the first time the line runs, and silently dropping
an event is the one thing this library must not do.

## Asking for the snapshot (§6)

Nothing in the spec says who calls `request()`. `websocketLogger` asks once at
`init()` and exposes `logger.requestState()` for mid-session re-asks. The
`fetchState` option defaults to `!autoack`: a durable editor loads state,
send-and-forget telemetry has no UI waiting on one.

## Deletions carried out (§5, "what the flag deletes")

`requireAck`, the `hello`/capability handshake, the grace timer, the capability
gate, `lo_fatal`, `FatalState`, `getFatal()` and `useFatal()` are gone, with
nothing replacing them. `README.md` documented the negotiated protocol and has
been rewritten to match the spec.

## Still open (§11)

Nothing in §11 is implemented: no partition preference, no batched flush, no
bounded in-flight window, no record-level nacks, no unload handling, no delivery
domain, and `logEvent()` still returns before the outbox write commits. The
admission hole is the live one — an enqueue failure (quota, private browsing, a
broken store) is logged loudly by the backend but not surfaced to the caller.

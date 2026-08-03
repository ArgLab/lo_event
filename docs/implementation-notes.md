# Implementation notes: where the code diverges from the spec

`docs/reliable-delivery.md` is the specification. This file records every
place the implementation departs from it, resolves something it left open, or
hardens against a failure mode the spec's first three implementations proved
real. Everything not listed here follows the spec as written.

This is the second round of the rebuild. Round one produced three independent
implementations from the same spec; all three were reviewed adversarially,
and this build starts from that defect ledger. Where a choice below exists
*because* of a round-one bug, it says so — and each of those bugs has a test
marked REGRESSION pinning it.

## Module layout

The spec names a sans-I/O decision core (§9) but not its shape. The code:

| file | role |
|---|---|
| `src/protocol.ts` | `DeliveryEngine` — the decision core. Facts in, decisions out. No socket, no store, no clock. |
| `src/websocketLogger.ts` | the adapter. Socket lifecycle, the lease loop, the tick, frame parsing. No protocol decisions. |
| `src/queue.ts` | backend selection, plus the front desk's destructive loop. |
| `src/memoryQueue.ts`, `src/indexeddbQueue.ts` | the two backends, tested against ONE contract suite (`tests/queueContract.test.js`). |

`stateRequest.ts` is not restored as a module. The snapshot latch and the
flush barrier share the connection generation, and the latch waits on the
barrier's clearance, so they live in the engine together. §9 permits
reshaping modules provided each pinned assertion survives:
`tests/stateRequest.test.js` keeps the §6 invariant list intact, re-pointed
at the engine — *un-evaluated refuses to send*, *ask once per connection*,
*re-ask on reconnect*, *stop once fulfilled*, *a new request re-arms the
latch*, plus the re-ask timeout and `barrierIsClear()` as the evaluator's
stop condition.

## The fact / decision alphabet (§9)

Three names in the spec's list do not appear, each because nothing in the
protocol turns on them: **`enqueued`** (a record enqueued after the watermark
can never affect the barrier, and admission is gated on nothing),
**`frameReceived`** (the frames that matter are facts in their own right),
**`closeSocket`** (a blocklist pauses the lease loop rather than dropping the
connection; reconnect policy stays adapter policy, §11).

Additions and changes:

- **`log` is a decision.** Every degradation must be loud (L17); making the
  engine name the message lets tests assert that a barrier failure, a
  deadline, an unnamed record, a lost snapshot answer, and a permanent block
  each say something.
- **`clearQueue` is a decision**, emitted in exactly one place: the
  permanent-opt-out arm of `disablerEngaged`. Round one proved why the engine
  must own this: adapters that reconstructed "permanent" vs "opt-out" from an
  overloaded boolean diverged three ways, and one deleted durable unsent work
  on a permanent rate limit. The disabler side has the same single-source
  treatment: `disabler.currentMode()` is the one predicate that answers
  clear/temporary/permanent/opt-out.
- **`disablerEngaged(mode)`** therefore carries the three-way mode rather
  than a boolean.
- **`sendFailed(gen)`** carries a generation, like `sendCompleted`.
- `recordLeased(seq, eventId, frame)` carries the frame text so the engine
  can hand it back in `sendFrame` — the adapter stays a pure executor.

## Hardening beyond the spec's letter (each a round-one defect)

- **The barrier deadline runs from `unevaluated`, not just `pending`**
  (`protocol.ts`, `elapsed`). The spec's own §7 example — "a transaction that
  never settles" — includes the watermark measurement itself; a deadline
  scoped to `pending` reintroduced L17's forbidden hang.
- **IndexedDB scans are epoch-guarded** (`indexeddbQueue.ts`). The lease
  cursor is captured before an async scan and assigned after it; a `rewind()`
  landing in between must not be overwritten, or the rewound backlog is
  silently skipped and the barrier can clear with backlog unsent.
  `unleasedAtOrBelow` gets the same guard.
- **The lease loop cannot die.** Every iteration is inside try/catch; an
  unreadable store logs an error and retries after a rest. One rejected
  lease permanently killing delivery — durable events accumulating, nothing
  ever sending again — was a round-one bug.
- **No disabler gate before durability.** `loEvent.go()` starts the front
  desk with no `shouldDequeue` gate; the disabler gates only the lease loop,
  via the engine. Two of three round-one builds held events in a non-durable
  buffer during a temporary block — a loss window if the tab closed.
- **A stored block engages at startup.** `websocketLogger.init()` consults
  `disabler.currentMode()`, so a permanent block persisted by a previous
  session gates this one too instead of silently resuming.
- **A permanent non-opt-out block is loud.** A MAINTAIN-style permanent hold
  pauses sending with an error log; events keep accumulating durably. Round
  one had a silent forever-stall.
- **A parked lease notices another context's enqueue** via a slow (~300ms)
  re-scan in `indexeddbQueue`. Without it, tab A parked on a drained store
  never discovers a record tab B committed before dying — until A's next
  reconnect.
- **Snapshot responses are accepted from any socket.** §6 declares the
  staleness window ("an older in-flight response can satisfy a newer ask");
  a round-one build gated `fetch_blob` responses on the current socket and
  paid an extra 10s re-ask for a resolution the spec accepts.

## Adopted from cross-review of the sibling round-2 builds

After the three round-2 builds were complete, each was adversarially reviewed
and good ideas were shared. This build adopted:

- **The `retry()` re-read loop** (from the sol build): `disabler.retry()`
  re-reads block state after every sleep instead of resetting
  unconditionally. Without it, a blocklist frame arriving while an earlier
  temporary block was being waited out — including a permanent privacy
  opt-out — was erased when the stale wait expired, and sending resumed
  through it. The adapter's release path re-checks `currentMode()` in a loop
  for the same reason (a block landing between retry() resolving and the
  release being applied would otherwise bounce off the single-flight guard
  with nobody waiting on it). Both are pinned by REGRESSION tests in
  `tests/disabler.test.js`, mutation-checked to fail against the unfixed
  code.
- **`askFailed(gen)` as a fact, plus the tick as the recovery path for an
  owed-but-not-outstanding ask** (from the opus build): a snapshot ask whose
  direct send fails re-arms the latch immediately and retries on the next
  tick — one tick of delay instead of the full 10s re-ask timeout. The latch
  exists to stop bursts of answered asks, not to ration attempts that never
  happened.
- **Close a socket whose OPEN-state send throws** (from the opus build):
  otherwise the lease loop retries against a broken-but-OPEN socket forever,
  loudly but pointlessly; closing hands recovery to the reconnect loop.
- **An honest tick** (from the opus review's findings): the ticker reports
  measured `Date.now()` deltas, not its nominal 250ms period — background-tab
  timer throttling would otherwise stretch the barrier deadline and re-ask
  timeout arbitrarily.
- **Idempotent `init()`** (same source): a second `init()` must not spawn a
  second connection loop and lease loop against one engine.
- **Deferred re-scan wake in memoryQueue** (from the opus build's review of
  this tree): the socket-open sequence enqueues the metadata preamble and
  then rewinds (§5 step order), so a consumer parked with the previous
  connection's cursor must be woken by a scan that runs AFTER the rewind —
  or the preamble jumps the recovered backlog and is sent twice (benign
  under L3, but wasteful and against §5's ordering). The wake defers one
  microtask and re-scans; the IndexedDB backend already had this property
  structurally. Pinned by the enqueue-then-rewind contract test, which the
  memory backend fails without the deferral.

One reviewer note declined: the round-2 sol review flagged this tree's
`unleasedAtOrBelow` zero fast path as vulnerable to the stale-count race. In
this adapter the lease→send→fail→rewind sequence is a single synchronous
block and probes are issued (and the fast-path value computed) only outside
it, so the stale schedule is not reachable; the async count path is
epoch-guarded. The invariant is: probes are computed at consistent cursor
moments, which holds as long as the adapter's send path stays synchronous —
noted here so a future async refactor knows what it is breaking.

## Timings

| constant | value | spec |
|---|---|---|
| `PROBE_INTERVAL_MS` | 300 ms | "~300ms" fallback probe (§7) |
| `BARRIER_DEADLINE_MS` | 5 s | "a few seconds" (§7) |
| `ASK_TIMEOUT_MS` | 10 s | "~10s" (§6) |
| adapter tick | 250 ms | not specified |
| parked-lease re-scan | 300 ms | not specified (see above) |

The adapter ticks the engine only while a socket is open: every deadline the
engine tracks is per-connection, or only meaningful on one.

## Store naming (§2)

The outbox store is `lo-outbox.<namespace>.<durable|autoack>`. The profile is
in the name, so mixing profiles on one store is impossible rather than merely
forbidden. The namespace comes from, in order: the `namespace` option; the
app's `source` (handed to `logger.configure()` by `lo_event.init()`, so apps
are namespaced apart without remembering an option); a loud `'default'`
fallback for a standalone logger configured with neither.

## The front desk (§5)

`loEvent`'s front-desk queue is `IN_MEMORY`, unconditionally; the `queueType`
init option is gone (the outbox backend is a `websocketLogger` option). The
durable store has exactly one read discipline — `indexeddbQueue` has no
`dequeue()` at all. One logger's exception during fan-out is logged and
contained rather than allowed to kill the loop.

## The metadata preamble (§5, step 2)

Events are not held at the front desk. Ordering comes from enqueue order: a
fresh `lock_fields` frame (copied from the kept *fields*, stamped at enqueue
— L6) is enqueued at socket open, before the watermark is measured, so the
barrier orders the snapshot after it. The residue is that a recovered
backlog precedes the *new* connection's metadata frame; the server already
saw a metadata frame for those events on the connection that enqueued them,
and holding events outside the durable store on a network-driven condition
would trade §1's promise for an ordering nicety.

## Reserved frame names (§12)

`lock_fields` joins `fetch_blob` and `save_blob` (the logger constructs it,
so a same-named app event would be misparsed identically). The set lives in
`util.RESERVED_EVENT_NAMES`; both `lo_event.logEvent()` and the logger
callable **throw** — a programming error in the caller, caught the first
time the line runs, because silently dropping an event is the one thing this
library must not do. The logger callable also stamps any direct-caller frame
missing an identity, so nothing unackable can enter the outbox (L5).

## Asking for the snapshot (§6)

`websocketLogger` asks at `init()` when `fetchState` is true; the default is
`!autoack` — durable editors load state, send-and-forget telemetry has no UI
waiting on one. `logger.requestState()` re-asks mid-session and re-arms the
latch, as specified.

## Deletions carried out (§5, "what the flag deletes")

`requireAck`, the `hello`/capability handshake, the grace timer, the
capability gate, `lo_fatal`, `FatalState`, `getFatal()` and `useFatal()` are
gone, with nothing replacing them. `README.md` has been rewritten to match
the spec.

## Still open (§11)

Nothing in §11 is implemented: no partition preference, no batched flush, no
bounded in-flight window, no nacks, no unload handling, no delivery domain,
and `logEvent()` still returns before the outbox write commits. The
admission hole is the live one — an enqueue failure (quota, private
browsing, a broken store) is logged loudly by the backend but not surfaced
to the caller.

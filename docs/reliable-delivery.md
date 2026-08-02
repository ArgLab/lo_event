# Reliable event delivery and state loading

*The lo_event client protocol: durable queues, leases, acknowledgments, and
the state snapshot. (Referred to as "Plane 1" in some commit history and
architecture discussions — the client→server half of the sync protocol.)*

This document assumes no prior knowledge of lo_event's internals. It is both
developer documentation and the specification for the client implementation:
a correct implementation satisfies every contract and every MUST-NOT below,
and passes the behavioral test suites referenced throughout.

---

## 1. The problem

lo_event streams student work — keystrokes, answers, interactions — from a
browser to a server, as **events**: one self-contained JSON object per line.
Two properties make this harder than "call `send()`":

1. **The last few seconds matter most.** The events most at risk are the ones
   just before a tab closes, a laptop sleeps, or a network drops — which is
   precisely when a student finishes a thought and closes the tab. Losing the
   tail of a session means losing exactly the work the student believes was
   saved.
2. **The browser is a hostile environment.** Tabs die without warning,
   networks flap, the same page may be open twice, and JavaScript state
   evaporates with the page. Nothing in memory survives; only what has been
   written to disk (IndexedDB) or delivered to the server does.

The promise this protocol makes:

> **An event handed to lo_event is never lost.** It is either durably held on
> the client, or durably captured by the server — at every moment, at least
> one of those is true.

Everything below is machinery in service of that one sentence.

### Two profiles, one flag

Not every application wants to pay for the full promise. lo_event serves two
kinds of deployment, and the difference is a single configuration flag on
the logger, **`autoack`**:

- **durable** (`autoack: false`, the default) — an event is deleted from the
  client only when the server acknowledges capturing it. This is the mode
  the promise above describes, and the mode lo-blocks uses.
- **send-and-forget** (`autoack: true`) — the client confirms each event *to
  itself* the moment the send succeeds. For high-volume observational
  telemetry (e.g. an extension background page streaming events) where the
  accepted loss window is "the socket buffered it and then the connection
  died."

Both profiles run the *same pipeline* — same queue, same leases, same
confirm-by-explicit-id, same rewind-on-reconnect. The flag changes exactly
one thing: *who signs for a sent event, and when* (§5). The mode is chosen
by the application at configuration time; client and server deployments are
coordinated, so the client never infers the server's dialect at runtime
(L12).

### What the server promises back

The server acknowledges ("acks") an event only after appending it to its
event log **and flushing that write** (a compressed-stream sync flush). So an
ack means *"captured to the on-disk log."* It does not mean fsync'd against
power loss, and it does not mean processed/folded into live state — those are
separate, later steps. The client may forget an event when — and only when —
it has been acked.

### Delivery semantics

In the durable profile, delivery is **at-least-once**. In send-and-forget it
is best-effort — effectively at-most-once per connection, since a rewind can
still resend anything not yet confirmed-on-send. Either way, events can
arrive twice (a resend after a lost ack) or out of order across reconnects.
This is safe because the consumers
are built for it: state is a fold over the event stream, reducers are
idempotent and order-tolerant, and fields carry absolute values or CRDT
merges. **Duplicates are always acceptable. Deletions of undelivered work
never are.** Several of the historical bugs below come from forgetting which
of those two categories an operation falls into.

---

## 2. The outbox, and why "sent" is not "safe"

The naive design — `websocket.send(event)` — loses events three ways: the
socket isn't open yet, the socket dies mid-send, or the tab closes while
bytes sit in a network buffer. The standard fix is an **outbox** (a durable
queue): every event is first written to local storage, and only removed once
the server has acknowledged it.

```
logEvent(e) ──▶ [ durable queue (IndexedDB) ] ──▶ send ──▶ server
                        ▲                                    │
                        └──────── delete on ack ◀────────────┘
```

In the browser, the durable queue is an IndexedDB object store with
auto-incrementing integer keys (the **storage id**). Where IndexedDB is
unavailable (Node, tests, SSR), an in-memory queue with the same interface
substitutes — same semantics, no durability.

**The queue is shared by every tab of the app in the same browser.** That is
deliberate, and it is the whole tab-close recovery story: if a tab dies with
unacked events, the *next* page load finds them in the shared store and
sends them. The cost of sharing is that several tabs operate on one store
concurrently, each with its own socket — and most of the landmines in
section 8 are consequences of designs that quietly assumed the store had one
owner.

---

## 3. Leases: taking without deleting

A first-seeing-this reader should slow down here; leases are the load-bearing
idea.

A classic queue has one read operation: **dequeue** — take the next item
*and delete it*. That is exactly wrong for an outbox: if you dequeue an
event, send it, and the tab dies before the ack, the event is gone from disk
and from the world.

So the outbox uses a **lease** discipline instead — the *only* read
discipline this queue has; there is no destructive dequeue — with three
operations:

- **`leaseNext()`** — hand out the next item *without deleting it*. The item
  stays on disk. An in-memory cursor (`leasedThrough`) advances so the next
  lease hands out the following item rather than the same one again.
- **`confirm(ids)`** — delete items, by explicit id, once they are signed
  for. This is the *only* way items leave the store. Who signs depends on
  the profile (§5): the server's ack (durable), or the sender itself at
  send time (send-and-forget). The queue does not know or care which.
- **`rewind()`** — reset the cursor to the beginning. Called on every
  reconnect: anything still stored (i.e., not confirmed) gets leased — and
  therefore sent — again.

The mental model: leasing is *checking a book out of the library without
removing it from the catalog*. Confirming is the warehouse sending a signed
receipt — only then may the catalog entry be removed. A crash between
checkout and receipt costs nothing: the book is still in the catalog, and
the next session checks it out again. The worst case is the server receiving
a duplicate, which at-least-once delivery already tolerates.

Note what is durable and what is not: the *items* are durable; the *cursor
is not*. `leasedThrough` is per-tab, in-memory, and resets with the page.
That asymmetry is correct — a lease is a claim about *this session's
sending progress*, not a fact about the world — but it means any logic that
reads the cursor must remember that other tabs have their own cursors over
the same store (see §8, landmines 8–10).

### Why `confirm` takes an explicit id list, never a range

The tempting optimization is a **cumulative ack**: server says "I have
everything through #47," client deletes ids ≤ 47 in one ranged delete.
Cumulative acking is sound only when the acknowledged sequence is *owned by
exactly one sender*. Our store is shared: tab A's "through #47" says nothing
about ids in that range that tab B enqueued and nobody has sent yet.
Deleting them is silent data loss — not a duplicate, a deletion, the
unforgivable category.

**Rule: a sender deletes only records it sent and saw acked, named
individually.** `confirm(seqs: number[])` — an explicit set, never a range.
(Test: *"one sender's ack does not delete another sender's unsent
records"*, `tests/queue.test.js`.)

---

## 4. Names: the two identifiers, and the one we deleted

Every event has exactly two identifiers, with different scopes:

| Identifier | Example | Scope | Used for |
|---|---|---|---|
| **storage id** | `47` | this browser's queue | ordering, leasing, deletion |
| **event identity** (`metadata.eventId`) | `b3f1….9c2a….112` | forever | acks, dedup, analytics, forensics |

The **storage id** is IndexedDB's auto-increment key. It is meaningless
outside its own database — never put it on the wire.

The **event identity** is `<browserTag>.<sessionTag>.<sessionSeq>`, stamped
at creation time by `timestampEvent()`:

- `browserTag` — persistent per browser install,
- `sessionTag` — fresh per JS context (a page load, a worker, a Node
  process; deliberately *not* "tab", because lo_event runs where there are
  no tabs),
- `sessionSeq` — a counter within that context.

Identity is structured (it sorts, it tells you where an event came from) but
the composite is **opaque**: the parts contain `-` and could contain `.`, so
`eventId` is compared and grepped, never parsed apart. The components ride
alongside in `metadata` for anything that needs them structurally.

**The server acks by identity**: `{status: 'ack', id: <eventId>}`. An
identity-keyed ack is a fact about the world — *"the server durably has this
event"* — that anyone can act on, on any connection, at any time. The sender
maps the acked identity back to a storage id (via an in-memory `inFlight`
map of what it has sent) and confirms exactly that record.

An earlier design used a third number — a per-connection wire counter — and
acked cumulatively against it. It worked, but its meaning died with each
socket, which is exactly wrong for a shared store where one tab may deliver
another tab's leftovers. It was removed; do not reintroduce it. Because
identity is what gets acked, **identity is load-bearing**: every frame that
enters the durable queue MUST carry `metadata.eventId` (see landmine 5), and
identity stamping must never be gated behind a verbose/debug flag. Both
profiles stamp — in send-and-forget mode nothing acks the identity, but
dedup, analytics, and forensics still key on it, and a store must never
depend on which profile wrote it.

---

## 5. The connection: two confirm sources, one flag

Everything in §2–§3 runs identically in both profiles. The single point of
difference is what event causes `confirm()`:

- **durable** (`autoack: false`) — after sending a leased record, remember
  it in the in-flight map (§4) and wait. Confirm when the server's
  `{status:'ack', id}` arrives, and only then.
- **send-and-forget** (`autoack: true`) — confirm the record immediately
  after `socket.send()` returns without throwing. The client is signing its
  own receipt; the accepted loss window is exactly "buffered but the
  connection died."

That is the entire mode switch. There is no runtime negotiation: the
application states the mode at configuration time, and client and server
deployments are coordinated. A **misconfigured** pair is visible, not
silent: a durable client against a server that never acks confirms nothing,
so the queue only grows — `unackedCount()` climbs, the unsaved-work warning
fires, and `loDebug.queue()` shows a backlog of perfectly named records.
Loud, durable, recoverable; never a loss.

> **History, and a warning.** An earlier design treated the mode as a
> *server capability* to be discovered per connection: a `hello` frame
> advertising `{ack: true}`, a ~3s grace timer whose expiry meant "assume
> the old server," a capability gate holding all sends until the guess
> resolved, and a `requireAck` escape hatch with a sticky fatal banner for
> clients that couldn't accept the downgrade. All of it existed so the
> client could guess what it was talking to, and the guessing is where the
> bugs lived — send-before-mode-known races, timers firing into the wrong
> connection, silent downgrades. Coordinated rollouts make the guess
> unnecessary. Do not reintroduce runtime mode detection; if profiles ever
> need to vary per deployment, vary the *configuration*, not the handshake.

Ordering per connection, in full:

1. Socket opens. All per-connection state resets.
2. `rewind()` runs and the backlog drains through leases.
3. The flush barrier (§7) is measured **after** rewind, then evaluated.
4. The state snapshot request goes out once the barrier clears (§6–7).

Every asynchronous callback tied to a connection (reconnect logic, barrier
measurement, the barrier's fallback timer) carries a **connection
generation number** and no-ops if the connection has changed by the time it
fires. A stale timer from connection N firing into connection N+1's state
was a real deadlock once; the generation guard is the uniform cure.

### What the flag deletes

For the rebuild, the collapse from negotiated-capability to configured-flag
removes, with nothing replacing them:

- the `hello`/capability handshake, the grace timer, and the capability
  gate (sends may begin as soon as the socket is open);
- the `requireAck` option, the `lo_fatal` event, `FatalState` in
  reduxLogger, and the `useFatal()` hook — the misdeploy they guarded
  against is now a visible, recoverable misconfiguration (above);
- the destructive dequeue discipline (`dequeue()` / `onDequeue`) from the
  *outbox* — send-and-forget uses leases plus confirm-on-send, so no
  delivery path needs delete-on-read. (One non-delivery consumer remains:
  loEvent's in-process front-desk queue, which buffers events before
  loggers initialize and dispatches destructively. Either migrate it to
  lease-and-confirm or keep `dequeue()` as a front-desk-only affordance —
  but the websocket logger must not touch it.);
- the "unnamed records get special legacy treatment" rule — see L7, which
  shrinks to one sentence.

---

## 6. The state snapshot: an RPC is not an event

On page load, the client asks the server for its saved state — the
`fetch_blob` request — and shows *"Loading user state…"* until the answer
arrives. This is a **request/response over the same websocket**, and it is
the one message that must NOT go through the durable queue, because its
properties are the opposite of an event's:

| | Event | Snapshot request |
|---|---|---|
| Answer | none (fire-and-forget) | one response, on the socket that asked |
| Useful to another tab? | yes — anyone can deliver it | no — the answer is worthless elsewhere |
| Should survive the session? | yes, durably | no — a dead session's request is garbage |

Routing the request through the shared durable queue produced two distinct
production hangs, both ending in a permanent spinner with no error anywhere:
another tab leased the request and received the answer meant for us; and the
request was acked (durably captured!) then deleted, the socket dropped
before the response frame, and nothing ever re-asked.

**Rule: the snapshot request is connection-scoped.** It is held in memory,
sent directly on the socket, re-sent on every new connection while still
unanswered, and cleared when the response arrives. Asking twice is free (the
request is idempotent); never asking again is a hang. Additionally:

- **Ask at most once per connection** (a latch): the barrier below is
  re-checked constantly, and without a latch each re-check past the
  threshold fired another request — and the server built a full state blob
  for each.
- **A new `request()` re-arms the latch**: a second snapshot request on a
  long-lived connection is a new question, not a duplicate of the old one.

---

## 7. The flush barrier: snapshot after backlog

One more ordering constraint, and it is subtle enough to have been
implemented wrongly twice, so it gets its own section.

Suppose a tab died with unacked events (the recovered backlog) and the user
reopens the page. Two things now race toward the server: the backlog (the
user's own last keystrokes) and the snapshot request. If the snapshot is
answered *before* the backlog folds, it reflects state from before those
keystrokes — and since the server **never echoes a client's own events
back**, the UI has no remaining channel to learn about them. The screen
shows pre-tail state until the next full reload. The user retypes the
missing sentence; the text CRDT dutifully merges both copies. The recovery
machinery worked perfectly and produced duplicated prose.

**Rule: the snapshot request must reach the server after the backlog this
connection started with.** Ordering is by arrival on the connection (the
server folds serially), so the backlog need only be *sent* first, not acked.

### How not to build it (both shipped, briefly)

- **"Wait until the queue is empty."** A live editor never empties its
  queue; the snapshot starves.
- **"Count the backlog at connection start; wait for that many sends."**
  Two independent failures. (a) A zero-initialized count is *an answer, not
  a placeholder*: any check that runs before the measurement resolves sees a
  satisfied barrier and the snapshot overtakes the backlog through the
  timing window. (b) On a shared store, a captured count is not a quota this
  connection can meet: another tab can send-and-delete records you were
  measured against, so you never observe that many sends — the barrier
  starves, permanently, on an idle page.

The common root: the barrier is a question about the *shared store's
contents*, and only the store can answer it.

### How to build it

At connection start — **after `rewind()`**, because the lease cursor is part
of the question — capture the **watermark**: the highest storage id
currently in the store (`maxSeq()`). The backlog *is* everything at or below
the watermark. Then the barrier is a single predicate, asked of the queue:

> `unleasedAtOrBelow(watermark) === 0`
> ("no stored record at or below the watermark remains unleased by me")

Every way a record below the watermark can disappear from that count is a
way the barrier *should* clear: this connection leased-and-sent it, or an
ack deleted it — and an ack, from any tab, means the server already has it.
Records enqueued after the watermark have higher ids and never block the
barrier, so live typing cannot starve the snapshot.

Evaluation is event-driven — each send re-probes — plus a slow fallback
timer (~300ms) for the one case that emits no local signal: an idle page
whose backlog is drained entirely by another tab (cross-tab deletions are
invisible to this tab). The timer runs until the barrier clears, whether or
not a request is waiting yet: the request can arrive later than the
connection, and must find the barrier already evaluated. Three refinements,
each a fixed bug:

- **Un-evaluated refuses to send.** The barrier has three states —
  un-evaluated / pending / clear — and only *clear* permits the request.
  Never represent un-evaluated as zero.
- **Probes respect the lease-to-send window.** The cursor advances at
  *lease* time, a moment before the frame is on the wire; a probe resolving
  inside that window would clear the barrier one record early. A
  send-in-flight flag makes such probes skip; the send's own re-probe runs
  strictly after the frame is out. (The lease loop is serial, so one flag
  suffices.)
- **Every failure opens the barrier, loudly.** An unreadable store or
  failed watermark measurement logs an error and degrades to *no barrier* —
  the pre-barrier behavior. A broken barrier must cost freshness, never
  availability: the failure mode of this feature is a stale snapshot, and
  must never be a hang.

---

## 8. The landmine registry

Every entry below is a bug that actually existed — shipped to a branch, or
caught in review of one. Each is stated as an invariant with the test that
pins it. **A rewrite that violates any of these is wrong even if it looks
cleaner.** When a test below doesn't exist yet at the stated location, the
rewrite must add it.

**L1. Never range-delete a shared store.** `confirm` takes an explicit id
set. A cumulative `delete(id ≤ n)` deletes other tabs' unsent records —
data loss, not duplication.
*(queue.test.js: "one sender's ack does not delete another sender's unsent
records")*

**L2. Only delete on ack.** A sender that dies before its ack must lose
nothing: its leases evaporate, its records stay, the next connection
rewinds and resends.
*(queue.test.js: "a sender that dies before its ack loses nothing")*

**L3. Duplicates are the safe direction.** Any tab may send any record; two
tabs sending the same record, or a record resent after a lost ack, is
covered by at-least-once delivery. Every design choice with a
duplicate-vs-deletion tradeoff picks duplicate.

**L4. The server acks identity, not transport position.** No per-connection
wire counters. The ack `{status:'ack', id}` names `metadata.eventId`; the
sender maps it to a storage id via its in-flight map and confirms exactly
that. The in-flight map is NOT reset per connection — identities outlive
connections; stale entries are harmless because storage ids are never
reused.

**L5. Every queued frame carries an identity.** The server cannot ack what
it cannot name; an unnamed record can never be confirmed and would be
resent on every reconnect forever. All frames the logger constructs itself
(connection metadata, `save_blob`) are stamped before enqueue. Stamping is
not gated on any verbosity flag.
*(util.test.js: "identity survives verboseEvents being off")*

**L6. Stamp copies, not long-lived objects.** `timestampEvent` writes into
its argument; stamping the persistent metadata dict itself would burn one
identity into every future frame. Copy first.

**L7. Unnamed records drain, best-effort.** A stored record with no
`metadata.eventId` (a pre-identity build's leftover, or an enqueue path
that forgot to stamp) can never be acked. A durable-mode client sends it
and confirms on send — per-record send-and-forget semantics — with a loud
log, because draining beats resending it on every reconnect forever.

**L8–L10. The flush barrier** (§7): the snapshot request must not overtake
the connection-start backlog (L8); the barrier must be asked of the queue —
un-evaluated is a distinct state, counts are not quotas on a shared store
(L9); the watermark is measured after `rewind()`, because the lease cursor
is part of the question (L10).
*(queue.test.js: "flush barrier" describe block — cross-tab drain clears
rather than starves; live typing never defers; measure-after-rewind.
stateRequest.test.js: refuses to send un-evaluated.)*

**L11. The snapshot request never enters the durable queue.** Connection-
scoped, ask-once-per-connection latch, re-ask on reconnect, latch re-armed
by a new request. (§6.)
*(stateRequest.test.js: the "ask once per connection" describe block)*

**L12. Mode is configuration, never negotiation.** The confirm source
(`autoack`) is stated by the application; the client never infers the
server's dialect from a handshake or a timeout. In particular, a durable
client never downgrades itself to confirm-on-send at runtime — a
misconfigured pair shows up as a growing queue (recoverable), never as
silent deletion (not).

**L13. A closing connection must release, not strand.** A send parked on a
dead or dying connection must *unblock and skip* — no send, no confirm; the
record stays leased-but-stored for the next rewind. Skipping either half
reintroduces a deadlock (send parked forever) or a loss (a confirm-on-send
of a record that never went out).

**L14. Guard every cross-async callback with a connection generation.**
Reconnect timers, barrier measurements, fallback probes: capture the
generation when scheduled, no-op if it moved. Bump the generation on close
as well as on open, so callbacks from a dying connection cannot fire into a
connecting one.

**L15. IndexedDB error handling.** In multi-request transactions, a
per-request `onerror` must `preventDefault()` — an unhandled request error
aborts the whole transaction and rolls back sibling operations (one bad
delete would un-confirm a whole batch). Settle promises on the
*transaction* (`oncomplete`/`onerror`/`onabort`), never by counting request
callbacks: a middle failure plus a later success can leave a counted
promise unsettled forever.

**L16. `eventId` is opaque.** Compare it, grep it, never split it. The
components travel alongside for structural needs.

**L17. Failure degrades toward worse service, loudly.** Unreadable
count/store → no barrier (stale snapshot, not a hang). Unnamed frame →
best-effort send (duplicate-ish, not a leak). Server not acking a durable
client → the queue holds and warns (unsaved, not lost). Every degradation
logs. The protocol's failure modes must be *worse service*, never *silent
loss* and never *hang*.

---

## 9. Testability: the sans-I/O rule

The historical failure mode of this file set was not bad ideas — it was
correct-sounding orchestration living as loose flags inside socket
plumbing, unreachable by any test without a real WebSocket and a real
IndexedDB. Three regressions in a row shipped through that gap, each found
by a human reading a diff.

**Rule: protocol decisions live in pure code; I/O lives in thin adapters.**
The decision core — confirm bookkeeping (both profiles), the snapshot
latch and barrier, reconnect behavior — is a *sans-I/O engine*: it
consumes facts (`connected`, `frameReceived`, `recordLeased`,
`sendCompleted`, `ackReceived(id)`, `probeResult(n)`, `disconnected`) and
returns decisions (`sendFrame`, `confirmIds`, `probeQueue`,
`askForState`). The WebSocket adapter and the queue backends feed it and
obey it, and contain no decisions of their own.

Consequences:

- **Unit tests drive the whole protocol as data** — facts in, decisions
  out — with no mocks, no fake sockets, no timers. Every landmine above is
  expressible this way.
- **Storage backends are tested against the queue contract** (§3 plus
  `maxSeq`/`unleasedAtOrBelow`), through the same tests for the memory and
  IndexedDB implementations wherever the environment allows.
- **The existing test suites are part of this specification.** They encode
  the bug history; passing them is the acceptance gate for any rewrite. A
  rewrite may re-point their imports and construction to new module
  boundaries, but must preserve each test's *assertions*; it may add tests,
  and may delete a test only if the invariant it pins is covered by another.

What this rule forbids: a flag in the socket file that changes protocol
behavior; a decision made inside an IndexedDB callback; any behavior only
observable by opening a real connection.

---

## 10. Debugging surface

`globalThis.loDebug` in browsers (the useful moment is a console prompt in a
stuck tab, where there is no module to import):

- `loDebug.queue()` — what is waiting and *why*: total count, a breakdown
  by event type, and an explicit count of unnamed records. A queue that
  only grows looks identical whether the client is offline, the server is
  not acking, or a frame can never be acked — and only the third is a bug
  in our code.
- `loDebug.clearQueue()` — drop everything, unsent included. Destructive on
  purpose: it exists to recover a store holding junk a broken build left
  behind. Never on a queue believed to hold real work.

The `useConnected()` / `useSaved()` / `useLoaded()` hooks are the reactive
UI surface for connection, save, and snapshot state. (`useFatal()` and the
`lo_fatal` event existed only for the `requireAck` misdeploy banner and are
deleted with it — §5.)

---

## 11. Known-open work (deliberately not in this spec)

- **Partition preference / stale drain.** Today every open tab leases and
  sends the whole shared queue — duplicates, safe but wasteful (N tabs ≈ N×
  sends). The plan: stamp records with their enqueuing session; each tab
  drains its own partition immediately and foreign partitions only when
  they look stale. Pure efficiency — correctness must never depend on the
  heuristic, precisely because L3 makes wrong guesses free.
- **Batched server flush.** The server currently sync-flushes per event; a
  ~500ms batch boundary (append all → one flush → ack the batch as a set)
  is protocol-compatible because acks name identities.
- **Snapshot-vs-other-connections.** The barrier orders the snapshot after
  *this connection's* backlog. Records another tab has sent but not yet had
  acked, and the race between another connection's fold and our snapshot,
  are not controllable from this client; they are bounded by the same
  at-least-once/no-echo semantics and resolved properly by
  subscription-push ("Plane 2") when it exists.
- **Version/publish.** This protocol ships as lo_event 0.0.9; lo-blocks
  drops its local-tarball dependency and requires the published version.

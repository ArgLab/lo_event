# Reliable event delivery and state loading

*The lo_event client protocol: durable queues, leases, acknowledgments, and
the state snapshot. (Referred to as "Plane 1" in some commit history and
architecture discussions — the client→server half of the sync protocol.)*

This document assumes no prior knowledge of lo_event's internals. It is both
developer documentation and the specification for the client implementation:
a correct implementation satisfies every contract and every MUST-NOT below,
and passes the behavioral test suites referenced throughout. §12 is the
frame inventory and an annotated wire trace of a full session — if prose
anywhere seems ambiguous, the trace is the tiebreaker, and reading it first
is a fine way in.

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

> **An event accepted into the outbox is never lost.** It is either durably
> held on the client, or durably captured by the server — at every moment,
> at least one of those is true.

Everything below is machinery in service of that one sentence. Note the
promise's precise start: **durability begins when the outbox's IndexedDB
write commits.** Between `logEvent()` and that commit the event is
in-memory only — a hop that must therefore be short and must never involve
a second disk queue (see §5 on the front desk). A full admission contract
(an awaitable `logEvent`, surfacing enqueue failure such as quota
exhaustion to the caller) is deliberately out of scope for now; see §11.

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
is plain **best-effort: it may lose and it may duplicate** (a rewind resends
anything not yet confirmed-on-send, and two tabs can both send a shared
record before either confirms — confirm-on-send prevents neither). Either
way, events can arrive twice or out of order across reconnects.

That is safe because of a **server-side contract**, not client-side hope:
the server folds events into per-field state through reducers that are
idempotent and order-tolerant, and fields that admit concurrent edits are
**CRDTs, merged on the server** — a redelivered or reordered event
converges to the same state by construction. This contract is what
at-least-once transport leans on, and every new event type or reducer must
honor it. (The one legacy exception — `save_blob`, a full-state overwrite
that is neither idempotent-under-reorder nor merge-tolerant — is
quarantined in §12.) **Duplicates are always acceptable. Deletions of
undelivered work never are.** Several of the historical bugs below come
from forgetting which of those two categories an operation falls into.

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
substitutes — but be honest about what it drops: no durability, no
cross-context sharing (the entire tab-close recovery story disappears),
and storage ids restart per instance.

**The queue is shared across tabs — precisely: across contexts in the same
origin and storage partition.** That is deliberate, and it is the whole
tab-close recovery story: if a tab dies with unacked events, the *next*
page load finds them in the shared store and sends them. The cost of
sharing is that several tabs operate on one store concurrently, each with
its own socket — and most of the landmines in section 8 are consequences
of designs that quietly assumed the store had one owner.

Be precise about the sharing boundary, because it cuts both ways: two
*different apps* on one origin share an outbox unless the store name is
namespaced per app (today it is a constant — the rebuild should namespace
it), while an extension background page and a regular page *never* share
one (separate storage partitions — each is its own recovery domain), and a
third-party iframe gets partitioned storage in current browsers, so
cross-tab recovery silently does not span it. "Shared" means: same origin,
same partition, same store name — **and one profile**. Every consumer of a
store must have identical confirm semantics: a send-and-forget consumer
draining a durable producer's store would confirm-on-send records the
server never acked. So the store namespace includes the profile, and mixing
profiles on one store is forbidden.

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
is not*. `leasedThrough` is per-Queue-*instance*, in-memory, and resets
with the page (two instances in one context are two independent cursors —
"leased by me" always means "by this instance").
That asymmetry is correct — a lease is a claim about *this session's
sending progress*, not a fact about the world — but it means any logic that
reads the cursor must remember that other tabs have their own cursors over
the same store (see §8, landmines 8–10).

Two contract points that were violated by real implementations, stated
explicitly:

- **The store is the only authority on "next."** `leaseNext()` answers by
  scanning the store for the lowest id above the cursor. A parked consumer
  (leaseNext on a drained queue) must be woken by *re-running that scan* —
  never by handing it the item whose arrival woke it. On a shared store,
  the record that woke you is not necessarily the next record: another tab
  may have enqueued lower ids while you were parked, and handing the waker
  directly jumps the cursor past them. (This is marked ABLATED in
  `indexeddbQueue.ts` for the rebuild to fill in.)
- **Lease only what you can try to send.** A lease advances the cursor, and
  the cursor only rolls back via `rewind()`. A record leased and then *not*
  sent (connection died mid-loop, send threw) must trigger a rewind — cheap,
  since duplicates are free (L3) — or the barrier in §7 will count it as
  handled when it never went out.

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

### The queue contract, in one place

Everything a backend must implement (memory and IndexedDB are tested
against the same contract, §9):

- `enqueue(item)` — append; assigns the next storage id.
- `leaseNext(): {seq, item}` — lowest stored id above the cursor, without
  deleting; parks when none; woken by re-scan, never by hand-off (§3).
- `confirm(seqs)` — delete exactly these ids.
- `rewind()` — cursor to the bottom; unconfirmed records re-lease.
- `unconfirmedCount()` — stored records (the logger-level `unackedCount()`
  is the sum of this across ack-aware loggers; two names, one per layer).
- `maxSeq()` — highest stored id, or null when empty.
- `unleasedAtOrBelow(seq)` — stored, unleased-by-me, at or below `seq`.
- `inspect(limit)`, `clear()` — debug/recovery only (§10); `clear()` is
  the one sanctioned deletion of unsent work, reserved for junk stores and
  the permanent-opt-out case (§5).

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

**Identity must be unique**, and the spec leans on it: an ack for one
identity confirms (deletes) the record carrying it, so two distinct events
sharing an identity would let one ack delete the other's undelivered work —
the unforgivable category, through a side door. `browserTag` and
`sessionTag` are generated with collision-resistant randomness, and one
identity corresponds to at most one record in a given store. (One caveat to
the "persistent per browser install" description: `browserTag` is read from
storage asynchronously, so the first events of a session may carry a fresh
one-off tag. Identities stay unique either way; only per-install analytics
on `browserTag` see the seam.)

**The server acks by identity**: `{status: 'ack', id: <eventId>}`, and it
acks **every copy it receives, including duplicates of an
already-captured identity** — an idempotent ack. This is load-bearing:
under at-least-once delivery the server *will* see the same identity twice
(a resend after a lost ack, two tabs draining one store), and a server that
stays silent on the duplicate leaves the client's record unconfirmable —
resent on every reconnect, forever. An identity-keyed ack is a fact about
the world — *"the server durably has this event"* — that anyone can act on,
on any connection, at any time. The sender maps the acked identity back to
a storage id (via an in-memory `inFlight` map of what it has sent) and
confirms exactly that record, **removing the map entry as it does**. Two
rules on that map, both easy to get backwards:

- **Register before the send attempt**, not after: an ack can arrive
  faster than a post-send bookkeeping step, and an ack that finds no entry
  is dropped (below) — leaving the record to resend forever.
- **An ack for an identity not in the map is ignored.** That is correct
  and non-obvious: it names a record some other connection sent (or one
  already confirmed), and acting on it would require scanning the store
  for the identity — and scanning-to-delete records you didn't send is how
  L1 was violated the first time.

The map's honest bound is one entry per unacked send — roughly the outbox's
size, not "small" — and it empties as acks land. (What is stored: each
queue record is the serialized JSON string of the frame, so reading an
identity back out of a stored record means parsing it.)

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
  after a send attempted **while the socket was verified OPEN**. The client
  is signing its own receipt; the accepted loss window is exactly "buffered
  but the connection died." The predicate is deliberately *not* "`send()`
  didn't throw": browser `WebSocket.send()` on a CLOSING/CLOSED socket
  returns normally and silently discards the data, and Node's `ws` reports
  errors via callback — so "didn't throw" would confirm-and-delete frames
  that were never even buffered. A send attempted on a non-OPEN socket is
  L13's unblock-and-skip path: no send, no confirm.

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
2. The session's current **metadata frame** (browser info, lock fields —
   the client's identity material) is enqueued, freshly stamped (L6). It
   rides the outbox like any event: behind any recovered backlog, ahead of
   everything this session logs after it. Events are held at the front
   desk until this frame is ahead of them — so the server always meets a
   session's metadata before its events.
3. `rewind()` runs and the backlog drains through leases.
4. The flush barrier (§7) is measured **after** rewind, then evaluated.
5. The state snapshot request goes out once the barrier clears (§6–7).

**Who the server thinks we are.** The server binds the connection to a
principal at accept time — HTTP-layer auth (Basic via the proxy, LTI
session, guest cookie) resolves *before* the WebSocket upgrade completes —
so no frame is ever processed unattributed. The `{status:'auth'}` push is
the server *telling* the client who it decided we are; the client never
waits for it. (Sends may begin at socket open precisely because
attribution already happened.)

**Admission never blocks on the network.** Nothing between `logEvent()`
and the outbox commit may wait on connection state, a server response, or
the disabler — the only permitted hold is local metadata assembly (step 2),
which must not depend on the network. Rate limiting and blocklists gate
the **lease/send loop**, after durability: a blocked client keeps
*accepting and storing* events and merely stops *sending* them. (The §7
barrier under an engaged disabler opens via its deadline as a declared
degradation — a commanded quiet period, not a bug.) The one exception is a
**permanent opt-out** (a privacy request): draining the stored backlog
would violate the opt-out, so this is the single sanctioned use of
`clear()` — deletion of unsent work, on the user's own instruction.

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
  delivery path needs delete-on-read. One non-delivery consumer remains:
  loEvent's front-desk queue, the in-process buffer every event passes
  through on its way to the loggers. **Decision: the front desk is
  `IN_MEMORY`, explicitly.** Today it autodetects, which in a browser makes
  it a *second* IndexedDB store on the delivery path — accidental, and
  worse than useless: a destructive disk queue adds a delete-on-read hop
  inside the §1 promise without adding durability (its parked-consumer
  fast path skips the disk write anyway). One durable store, the outbox;
  the front desk is a hand-off buffer and may keep `dequeue()`;
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
- **A new `request()` re-arms the latch.** One honesty note: responses
  carry no correlation id, so an older in-flight response can satisfy a
  newer ask — a declared staleness window, accepted because mid-session
  re-requests are rare and get rarer (subscription push replaces them).
  A mid-session re-request does not wait on any barrier for events this
  context generated — those are already reflected in local state. The
  barrier orders the snapshot after *foreign and prior-session* backlog
  only.
- **An unanswered ask times out and re-asks.** "Once per connection" bounds
  the burst, not the patience: a healthy-looking connection whose server
  never answers (dropped internally, failed mid-build) must not leave the
  spinner up forever — that is L17's forbidden hang. After a generous
  timeout (~10s), re-arm the latch and ask again, loudly; asking is
  idempotent. Overlapping *responses* are benign for the same reason a
  reconnect re-ask is: whichever snapshot arrives resolves the load.

**The load gate is load-bearing, not cosmetic.** At page load, "already in
local state" is false — local state is empty, and the response *replaces*
it wholesale — so any state-bearing event enqueued before the snapshot
resolves gets no ordering protection (it lands above the watermark) and
any local edit made in that window would be overwritten by the response.
The rule: **no state-bearing event may be enqueued before the snapshot
resolves.** Today that holds because the only pre-snapshot frames are the
§5 metadata preamble and pageview-ish telemetry, and the "Loading user
state…" screen keeps the user from editing. Both halves are part of the
protocol: a rebuild (or a new caller) that lets state-bearing events jump
the gate reintroduces the §7 bug from this session's own keyboard.

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
connection started with.** For that to mean anything, the server owes one
contract, stated here because §1 deliberately does *not* imply it (an ack
means captured-to-log, not folded):

> **Server ordering contract.** Frames on one connection are processed
> serially, and a `fetch_blob` response reflects every event that arrived
> on that connection before the request.

Under that contract the backlog need only be *sent* first, not acked. A
server that acks eagerly but folds asynchronously would satisfy every ack
rule in this document and still reintroduce the duplicated-prose bug — the
contract is as load-bearing as anything in §8.

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

At connection start, capture the **watermark**: the highest storage id
currently in the store (`maxSeq()`). An empty store (`null`) means no
backlog — the barrier is immediately clear; this is the common page-load
fast path. The backlog *is* everything at or below the watermark. Then the
barrier is a single predicate, asked of the queue:

> `unleasedAtOrBelow(watermark) === 0`
> ("no stored record at or below the watermark remains unleased by me")

The ordering constraint: **no probe may be issued before this connection's
`rewind()` has completed.** The predicate reads the lease cursor, and
before rewind the cursor still holds the *previous* connection's position —
high enough to make the whole backlog look already-leased, clearing the
barrier spuriously. (The watermark itself reads only stored ids, so its
timing is forced by the same rule rather than mattering independently.)

The ways a record below the watermark leaves that count: this connection
leased it (the lease loop will send it ahead of the request — and if a
lease ends up *not* sent, §3's rule forces a rewind, which puts it back in
the count); or an ack deleted it. The ack case is deliberately good enough
rather than airtight: an ack proves the server *captured* the record, but
it arrived on another connection, so nothing orders its fold before our
snapshot — the same bounded race as any other tab's in-flight events
(§11, "snapshot-vs-other-connections"). The barrier's hard guarantee
covers what this connection sends; for everyone else's records it is a
freshness heuristic, and that is the accepted design. Records enqueued
after the watermark have higher ids and never block the barrier, so live
typing cannot starve the snapshot.

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
- **Clearance latches per connection.** Once clear, a later mid-connection
  `rewind()` (a failed send's recovery, §3) does not re-close it: the
  snapshot was ordered after the backlog that existed at connection start,
  which is all this barrier promises, and re-closing would let a §6
  timeout re-ask hang behind live traffic. §3's "puts it back in the
  count" therefore matters only before first clearance.
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
- **The barrier has a deadline.** Errors are not the only way to never
  answer: a lease loop stalled by a rate limit, a transaction that never
  settles, or a bug simply stops the count from reaching zero — no error,
  no progress, spinner forever. After a bounded wait (a few seconds) the
  barrier opens loudly and the request goes out. Same principle as above:
  a stale snapshot, never a hang.

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

**L2. In the durable profile, named records are deleted only on ack.** A
sender that dies before its ack must lose nothing: its leases evaporate,
its records stay, the next connection rewinds and resends. (The scoping is
the registry staying honest: `autoack: true` confirms on send *by
declared contract* (§5), and L7 is a bounded exception for records that
cannot be acked at all. Neither is a license for the durable path.)
*(queue.test.js: "a sender that dies before its ack loses nothing")*

**L3. Duplicates are the safe direction.** Any tab may send any record; two
tabs sending the same record, or a record resent after a lost ack, is
covered by at-least-once delivery. Every design choice with a
duplicate-vs-deletion tradeoff picks duplicate. (Known exceptions, each
declared rather than accidental: the send-and-forget profile's loss window,
and L7.)

**L4. The server acks identity, not transport position.** No per-connection
wire counters. The ack `{status:'ack', id}` names `metadata.eventId`; the
sender maps it to a storage id via its in-flight map and confirms exactly
that, removing the entry on confirm (the map holds only what awaits an
ack — bounded, not append-only). The map is NOT reset per connection —
identities outlive connections; an entry whose ack never comes is harmless
because storage ids are never reused. (That never-reused property is an
explicit backend invariant: IDB autoincrement provides it — `clear()` does
not reset the key generator — and any other backend must too; memoryQueue
restarts ids per instance, acceptable only because an instance's lifetime
is one JS context.)

**L5. Every queued frame carries an identity.** The server cannot ack what
it cannot name; an unnamed record can never be confirmed and would be
resent on every reconnect forever. All frames the logger constructs itself
(connection metadata, `save_blob`) are stamped before enqueue. Stamping is
not gated on any verbosity flag.
*(util.test.js: "identity survives verboseEvents being off")*

**L6. Identity is minted at the enqueue boundary — fresh every enqueue,
reused every resend, never re-enqueued.** Three clauses, each broken once:
`timestampEvent` writes into its argument, so stamping a long-lived object
(the persistent metadata dict) burns one identity into every future frame —
copy first. The old logger went further: it *absorbed* a stamped frame
into the metadata dict and re-enqueued that dict on every reconnect, so an
already-used identity re-entered the store as a new record — and since the
in-flight map holds one storage id per identity, the ack could only ever
confirm one of them; its twins resent forever. The rule that closes the
whole class: **every `enqueue()` stamps a fresh identity; a *resend* of a
stored record reuses the record's identity (that is the point of acks);
an object that has ever carried an eventId is never enqueued again.**

**L7. Unnamed records drain, best-effort — a declared exception to L2/L3.**
A stored record with no `metadata.eventId` (a pre-identity build's
leftover, an enqueue path that forgot to stamp, or a stored payload that
doesn't parse) can never be acked. A durable-mode client sends it and
confirms on send — per-record send-and-forget semantics — with a loud log,
because draining beats resending it on every reconnect forever. Why not
the safer-looking fix, minting an identity at drain time and waiting for
the ack? Because the stored copy isn't rewritten: a crash between that
send and its ack re-mints a *different* identity on the next drain, which
defeats dedup and re-opens the resend-forever loop the rule exists to
close. The loss window is accepted, once, loudly — and `loDebug.queue()`
counts these records so a *recurring* unnamed record is visible as what it
is: a live stamping bug, not legacy residue.

**L8–L10. The flush barrier** (§7): the snapshot request must not overtake
the connection-start backlog (L8); the barrier must be asked of the queue —
un-evaluated is a distinct state, counts are not quotas on a shared store
(L9); no barrier probe **and no lease** may run before this connection's
`rewind()` has completed — both read the lease cursor, and a pre-rewind
cursor makes the whole backlog look leased (a stale probe clears the
barrier spuriously; a stale lease silently *skips the backlog entirely*,
which is worse) (L10).
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
consumes facts (`connected`, `frameReceived`, `enqueued`,
`recordLeased(seq, eventId | null)`, `sendCompleted`, `sendFailed`,
`ackReceived(id)`, `watermarkResult(n | null)`, `probeResult(n)`,
`measurementFailed`, `elapsed(ms)`, `disablerEngaged`/`disablerReleased`,
`disconnected`) and returns decisions (`sendFrame`, `confirmIds`,
`measureWatermark`, `probeQueue`, `rewind`, `pauseSending`/`resumeSending`,
`closeSocket`, `askForState`). Notes on that list, each a bug-in-waiting
if skipped: **time is a fact** (`elapsed`) — the §7 fallback cadence, the
barrier deadline, and the §6 re-ask timeout are all decisions the engine
makes when *told* time has passed, so tests drive them without timers.
Facts that answer an earlier decision (`watermarkResult`, `probeResult`,
`sendCompleted`) must carry the connection generation they belong to, or a
slow answer from connection N is indistinguishable from one for N+1 —
`ackReceived` is the deliberate exception, generation-free, because an
identity ack is a fact about the world (§4). `recordLeased` carries the
parsed-out identity (or null) because L7 is a per-record protocol
decision; extracting it from the stored JSON is the adapter's job, with
exactly that defined output. And the disabler facts are in the alphabet
because §5 places rate-limit gating at the send stage — a protocol
decision, so it must live here, not in the adapter. The WebSocket adapter
and the queue backends feed it and obey it, and contain no decisions of
their own.

Consequences:

- **Unit tests drive the whole protocol as data** — facts in, decisions
  out — with no mocks, no fake sockets, no timers. Every landmine above is
  expressible this way.
- **Storage backends are tested against the queue contract** (§3 plus
  `maxSeq`/`unleasedAtOrBelow`), through the same tests for the memory and
  IndexedDB implementations wherever the environment allows.
- **The existing test suites are part of this specification — as pinned
  *invariants*, not as a pinned API.** They encode the bug history; a
  rewrite may re-point imports, rename methods, and reshape modules
  freely, but each test's *assertion* must survive somewhere: an invariant
  may be dropped only if another test covers it. Concretely for
  `stateRequest.test.js` (whose module the ablation deleted): the protocol
  facts are *un-evaluated-barrier refuses to send*, *ask once per
  connection*, *re-ask on reconnect*, *stop once fulfilled*, *a new
  request re-arms the latch* — the `StateRequest` class shape those tests
  currently drive is incidental. The two destructive-dequeue tests at the
  top of `queue.test.js` pin the *front desk's* FIFO hand-off, not the
  outbox — the outbox never dequeues destructively (§5).

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
- **Admission contract.** `logEvent()` returns before the outbox write
  commits, and enqueue failure (quota, private-browsing restrictions, a
  broken store) is logged but not surfaced to the caller — a real hole at
  the promise's front door (§1 scopes the promise around it). The eventual
  shape: an awaitable acceptance result, plus an explicit storage-pressure
  policy. Until then: fail loudly, never silently drop without a log.
- **Delivery domain.** Records are not bound to a server URL or
  authenticated principal; a backlog enqueued under user A could drain on
  a connection authenticated as user B (login change mid-session, server
  override). Real, privacy-relevant, and needs its own design — records
  stamped with a delivery domain, connections draining only their own.
- **Flow control.** The lease loop will happily push an entire offline
  backlog into the socket's local buffer. A bounded in-flight window
  (count or bytes, resumed on acks / low `bufferedAmount`) is the natural
  durable-mode mechanism.
- **Poison records / nack.** The server today never rejects a *queued
  record* (`save_blob_nack` reports a failed save attempt, not a rejected
  record — §12); a hypothetical permanent rejection would sit in a durable
  queue forever. If record-level nacks ever exist, they need a dead-letter
  policy that preserves the payload. Deliberately unspecified until the
  server can say no.
- **Unload.** No `pagehide`/`visibilitychange` handling is specified —
  the "last few seconds" case rides entirely on the outbox commit having
  already happened. Worth revisiting with the admission contract.
- **Reconnect policy.** Exponential backoff, 1s doubling to a 15-minute
  ceiling, reset on success. Adapter policy today, but note the
  consequence: the ceiling is the worst-case delivery tail on §1's
  promise while a laptop sits offline.
- **Version/publish.** This protocol ships as lo_event 0.0.9; lo-blocks
  drops its local-tarball dependency and requires the published version.

---

## 12. The wire: frames, and a sample session

Everything is JSON, one object per WebSocket message. Client→server frames
are distinguished by `event`; server→client frames by `status`.

**Client → server**

| frame | shape | queued? |
|---|---|---|
| event | `{event: <type>, ...payload, metadata: {eventId, browserTag, sessionTag, sessionSeq, ts, iso_ts, ...}}` | yes — the outbox |
| state save | `{event: 'save_blob', blob: {...}, token: <n>, metadata: {...}}` | yes — it is an event |
| metadata / lock fields | stamped like any event | yes |
| snapshot request | `{event: 'fetch_blob'}` | **never** (§6) |

The protocol's `event` names (`fetch_blob`, `save_blob`, and any future
protocol frame) are **reserved**: application events share the same field,
and an app event named like a protocol frame would be misparsed on every
redelivery, forever. The client refuses to enqueue an application event
bearing a reserved name.

**Server → client**

| frame | meaning |
|---|---|
| `{status: 'ack', id: <eventId>}` | event captured to the log (§1); idempotent — every received copy is acked (§4) |
| `{status: 'auth', user_id, ...}` | resolved identity, pushed once per connection after server-side auth |
| `{status: 'fetch_blob', data: {...}}` | the snapshot response; reflects all prior frames on this connection (§7's server contract) |
| `{status: 'save_blob_ack', token}` / `save_blob_nack` | save-status echo, keyed by the client's monotonic token |
| `{status: 'blocklist', message, time_limit, action}` | stop sending (rate limit / opt-out); feeds the disabler, which gates the lease loop |
| `{status: 'local_storage', key, value}` / `{status: 'browser_event', ...}` | server-pushed side channels; unrelated to delivery |

### `save_blob` is legacy — quarantined, scheduled for demolition

`save_blob` is a **full-state overwrite**, and therefore the one frame that
violates §1's consumer contract: it is neither idempotent-under-reorder nor
merge-tolerant. It is the interim persistence mechanism from before
per-field events; the destination is field-level events folded through
server-side CRDTs, at which point `save_blob` is deleted. Until then, its
hazards are **declared, contained, and not worth engineering around**:

- **Stale redelivery can regress state.** A dead session's unacked
  `save_blob`, recovered and redelivered, folds over anything newer —
  wrong in a way no client ordering can fix, since tokens are per-session.
  Contained by: blobs are superseded wholesale by the next save, and the
  field-event migration removes the frame. Do not add version vectors to a
  frame we are deleting.
- **Two acknowledgments, two jobs.** The identity ack confirms the *queue
  record* (outbox deletion, like any event); `save_blob_ack`/`nack` + token
  drives the *UI save status* (compared against the newest token, so a
  stale ack never marks newer edits saved). An ack-then-nack sequence
  therefore consumes the record while the save failed: the UI correctly
  shows unsaved, and recovery is the next save (full state again). If no
  further edit ever happens, that blob attempt is lost — a declared legacy
  hazard, accepted for the same reason as above.

### A durable session, annotated

Tab reopens after a crash. The store holds two unacked records (ids 41, 42)
from the dead session. `B.S1.*` are the dead session's identities; `B.S2.*`
this one's. `>` client→server, `<` server→client; unquoted lines are
client-local actions.

```
[socket open]  per-connection state resets; rewind(); watermark = maxSeq() = 42
<  {"status":"auth","user_id":"u-217"}
>  {"event":"save_blob","blob":{...},"token":7,"metadata":{"eventId":"B.S1.38",...}}   # id 41 leased, sent
>  {"event":"answer","qid":"q3","value":"...","metadata":{"eventId":"B.S1.39",...}}    # id 42 leased, sent
   unleasedAtOrBelow(42) == 0  →  barrier clear     # probed after the send completed — §7's in-flight interlock
>  {"event":"fetch_blob"}                                    # only now — after the backlog
   user types; enqueue id 43 (eventId B.S2.1); leased, sent
>  {"event":"keystroke","key":"e","metadata":{"eventId":"B.S2.1",...}}
<  {"status":"ack","id":"B.S1.38"}      →  confirm([41])     # exact id, never a range (§3)
<  {"status":"ack","id":"B.S1.39"}      →  confirm([42])
<  {"status":"fetch_blob","data":{...}}                      # reflects 38 & 39: they arrived first
<  {"status":"save_blob_ack","token":7}                      # UI flips to "saved"
[network drops before B.S2.1 is acked]
   id 43 is still stored; the lease evaporates; nothing was lost
[socket open]  reset; rewind(); watermark = 43
>  {"event":"keystroke","key":"e","metadata":{"eventId":"B.S2.1",...}}                 # resent — same identity
   barrier clear; snapshot already fulfilled → no fetch_blob                           # §6
<  {"status":"ack","id":"B.S2.1"}       →  confirm([43])     # server acks the copy it got — idempotent
```

Every §7 property is visible in the trace: `fetch_blob` leaves after ids
41–42 (the crash-recovered backlog) and before nothing — id 43 (live
typing, above the watermark) never delays it; the resend after reconnect
reuses the same identity, and the ack names it regardless of which copy
arrived.

### The same start, send-and-forget (`autoack: true`)

```
[socket open]  rewind(); lease id 41 → socket verified OPEN → send → confirm([41])
>  {"event":"pageview",...,"metadata":{"eventId":"B.S1.38",...}}
   lease id 42 → send → confirm([42])                        # no ack awaited, no in-flight map
[connection dies with a frame in the OS buffer]              # ← the accepted loss window, §5
```

The server may still send `ack` frames; a send-and-forget client ignores
them.

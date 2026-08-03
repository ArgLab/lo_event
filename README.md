# lo_event — Learning Observer Event Library

The 10,000-foot goal: **pipe diverse events from many sources into
learning record stores, including the original Learning Observer.**
Learning Observer is pluggable learning analytics; `lo_event` is the
client-side pipe that mates with it.

It was built to feed Learning Observer from a handful of
sources. Writing Observer — a $2M IES-funded writing-process research
platform — was the flagship, alongside a few smaller research
prototypes. Since then it has grown to serve a different kind of
source as well: systems designed from the ground up to elicit and
surface student thinking through process data. lo-blocks is an
example.

It does both: When a system is designed to provide good data, the
redux-style loop (below) gives us a *guarantee* of it: full
application state reconstructable from the stream. However, plenty of
systems aren't designed that way, and taking in their data is
messy. The data is partial: whatever they happen to emit. Pluggable
learning analytics means meeting sources where they are, and
correlating what you get.

## What we want from the library

- **Stream events through multiple loggers.**
  - In practice, usually a **websocket logger** with a persistent connection.
  - **AJAX logging** for occasional events.
  - A **console logger**, because being able to see your events is
    helpful for debugging.
  - And increasingly a **`react`/`redux` integration**, which gives you very good
    observability for free (your app state is your event log; see below).
- **One JSON object per event**, one line per event — the general shape used by
  Caliper, xAPI, and Open edX.
- **Free-form JSON**, but follow Caliper / xAPI vocabulary where it's convenient.
  Compatibility where reasonable; flexibility where learning outpaces the specs.
- **JavaScript today**, other languages later.

The goal is to *simplify* compatibility and stay compliant where it's reasonable
— while being a good deal more flexible than strict xAPI or Caliper.

## Events are like onions — they have layers

We don't assume we can trust the timestamps or authentication of the system
generating an event, or that we'll have all the context up front. Systems add
timestamps, authentication, and context as the event is passed along — much like
an SMTP message picking up headers as it hops between servers.

This isn't abstract. Some Tincan/xAPI libraries crash hard if an event
is missing a user, a timestamp, and so on. In practice, the client
generating the event often *can't* know the authenticated user; the
**server** ought to stamp it.  And there isn't one true timestamp —
there's the browser clock, the JS server's receive time, the Python
server's receive time. We keep those as layers rather than pretending
a single authoritative time exists, and we let each system add what it
knows when it knows it.

Consequences of taking layers seriously:

- **There's a header for metadata + authentication.** Context that's the same
  across many events (source, version, the authenticated identity) rides the
  header, stamped once, not re-sent per event.
- **We're sensitive to bandwidth.** It's not worth resending, on every
  event, what can live in a header or in an occasional update event. A
  lot of standards ship large, cumbersome events — not human-friendly,
  and expensive to store and process. So context is sent **once** (via
  `lock_fields`) and **omitted from subsequent events** until it
  changes; the server denormalizes it back per event. Downstream,
  locking in a page URL or sending it with each event are equivalent
  (we denormalize when processing).
- **We're freeform in what we send and accept.** Learning contexts are rich, and
  the technology evolves in ways the standards don't always keep up with.

## Two ways people use it

**A. Fire-and-forget telemetry (the original).** Configure loggers,
call `logEvent(...)`, events stream out. This is how a writing
extension or any external system feeds Learning Observer. The system
tries very hard never to lose an event (see *The delivery standard*).

**B. redux application state (the expanded role).** Events flow *through* a redux
store, so application state and event logging are one data flow — which is why
you get observability for free. The client applies its own events optimistically;
the server folds the *same* event stream through the *same* reducers into
authoritative state, and can push events back down. This is how lo-blocks builds
event-sourced, collaborative activities.

The two are not fully exclusive; in some cases, it is convenient to
add additional events on top of redux.

In the observable mode, on the client, **redux is the event bus** —
folding every change through reducers is what makes full application
state reconstructable from the event stream. Current state can be
thought of as a cache of the event stream.

We are gradually moving towards a model where **the server acts like
redux** as well: fast local redux for UX, a slower authoritative
server-side redux-equivalent for shared state.  `lo_event` is the
substrate both sit on (format, durable queue, transport, acks, client
redux front-end). It is a *sync-aware transport with a redux
front-end*, **not** a distributed state engine — server-side folding
is the consumer's business.

## The delivery standard

The event stream is the ground source of truth. Losing an event means losing
student work. So: **every event that reaches `logEvent` must make it into a log
file** (client durable queue → server event log). Three layers, and **only the
bottom is hard**:

1. **Capture (hard).** `logEvent → durable queue`, unconditionally. No gate,
   failure, disconnect, or disabled-UX state may stop an event that reached
   `lo_event` from being enqueued.
2. **Transmission (soft).** The lease discipline decides *when* to send and
   *when to delete* — only once the server durably logs it (the ack). Un-acked
   events sit durably and resend on reconnect. Rate limits and blocklists gate
   this layer, never layer 1: a blocked client keeps accepting and storing.
   Nothing is dropped, only deferred.
3. **UX (soft).** Hooks (`useConnected`, `useSaved`, …) let the app
   disable the interface. Presentation only — never a reason an event
   isn't captured -- but the goal is to be able to stop sending events
   if we lost connection (tell the user we're not connected). Of
   course, for offline operation, we would not use this; events would
   simply restream on reconnect. There is a time for both.

"Soft shut down the flow, keep hard delivery" = throttle layer 2, disable layer
3, **never touch layer 1**. A consumer that disables the UI on failure must do it
**read-only-after-capture** (log the event, *then* lock the input), never drop
pending input.

## Durability & the ack protocol

Backed by **IndexedDB** (the browser default), the queue survives reloads and
outages — events persist across a page reload or process restart. The
**in-memory fallback** (Node, or where IndexedDB is unavailable) survives
in-process outages and reconnects, but not a reload/restart. Reliability rests
on a **lease discipline**, not delete-on-read:

- Every record has a **storage id** (the queue's autoIncrement key), local to
  this browser's queue and never put on the wire, and an **event identity**
  (`metadata.eventId`), which is what the server acks and what dedup keys on.
- **Lease, don't take:** `leaseNext()` hands a record to the sender without
  deleting it; `confirm(ids)` deletes **exactly the named ids**; `rewind()`
  re-hands everything unconfirmed on reconnect.
- The server acks `{ status: 'ack', id }` **after durably writing** to its log,
  naming the event identity, and acks every copy it receives — including
  duplicates of an identity it already has.
- **Never a cumulative delete.** The store is shared across tabs, and each tab
  acks over its own socket, so "delete everything ≤ n" deletes records other
  tabs enqueued and nobody has sent. Duplicates are covered by at-least-once
  delivery; deletions are not.
- **At-least-once, not exactly-once.** Duplicates are harmless (the server folds
  events through idempotent, order-tolerant reducers), so we resend freely
  rather than risk loss.

Why it exists: the old queue deleted an event in the same transaction it read it
for sending, and `socket.send()` is fire-and-forget — so an event closed-tab in
that window vanished silently (we measured real tail-of-session losses). The
lease discipline closes that window.

**Two profiles, one flag.** Who signs for a sent record is **configuration, not
negotiation** — `autoack` on the logger:

- `autoack: false` (default, *durable*) — a record is deleted only when the
  server acks it. This is what lo-blocks uses.
- `autoack: true` (*send-and-forget*) — the client confirms each record to
  itself the moment a send goes out on a socket verified OPEN. For high-volume
  observational telemetry, where the accepted loss window is "the socket
  buffered it and then the connection died."

Both profiles run the same pipeline; the flag changes only who signs and when.
There is no runtime handshake to discover the server's dialect: client and
server deployments are coordinated, and a misconfigured pair is *visible* — a
durable client against a server that never acks confirms nothing, so the queue
grows, `unackedCount()` climbs and `loDebug.queue()` shows the backlog. Loud and
recoverable, never a silent loss. (An earlier design negotiated this per
connection with a `hello` frame, a grace timer and a `requireAck` escape hatch;
the guessing is where the bugs lived. Do not reintroduce it.)

**The state snapshot** (`fetch_blob`) is a request/response, not an event: it is
never queued, is re-asked on each new connection while unanswered, and waits
for the connection-start backlog to be sent first, so a recovered tail of
work cannot be overwritten by a snapshot that predates it.

## Client state-sync (the redux workflow)

The server can also send events *down* for the client's reducers, addressed by
`state://` keys and delivered by subscription **bound to the connection**. One
bus, three multiplexed traffic classes ("planes"):

| Plane | Direction | Carries | Reliability |
|---|---|---|---|
| 1 — client events | client→server | durable user actions | server-acked, resend on reconnect |
| 2 — control | client→server | `subscribe` / `unsubscribe` (batched) | idempotent, re-sent each connect, no ack |
| 3 — server events | server→client | events for the client's reducers | client-acked (ordering only); recovery = snapshot on (re)subscribe |

**No echo, either direction.** The client applies its own events optimistically;
the server folds authoritatively and forwards only to *other* subscribers.
Recovery is the **snapshot returned on (re)subscribe**, not an echo — so acks
carry no state; they exist only for durability tracking and replay ordering.

Inbound server events go through the same reducer registry as local ones: a
set-the-value reducer for the simple case, a registered merge reducer (e.g. CRDT)
for the hard case. The server folds with the same reducer code — a property of
the consumer (lo-blocks), not something `lo_event` encodes. The full wire
contract lives in the consuming project's protocol doc; `lo_event` implements the
client half.

## React hooks

Import from `lo_event/hooks` (this entry needs React). They read a plain
module-level status store via `useSyncExternalStore` — **not** Redux state — so
consumers stay reactive without an imperative `consumeCustomEvent` listener.

| Hook | Returns | Meaning |
|---|---|---|
| `useConnected()` | `true \| false \| null` | connected / offline / no websocket configured |
| `useSaved()` | `'saved' \| 'modified' \| 'error'` | persistence status |
| `useLoaded()` | `boolean` | initial state resolved (gate the UI on this) |

## Failure handling

When something fails in a way worth noticing, log to **all three** of:

1. **The console** (`debug.error`) — always.
2. **localStorage** (`util.recordFailure`) — a bounded, ring-buffered NDJSON log
   (`lo_event_failures`). Sized by calculation, not vibes: capped at a small
   fixed slice (~128 K chars ≈ ~5% of the ~5 MB browsers guarantee) and
   ring-buffered, so it can never grow toward the quota. Deliberately **not**
   wired to every `debug.error` — call it only for failures worth persisting, or
   you get exponentially growing logs.
3. **A consumer surface** — a reactive hook (e.g. `useConnected`, `useSaved`) so
   the app can tell the user. Prefer this to throwing: throwing from the logging
   path endangers delivery to sibling loggers (see *The delivery standard*).

Degradations follow one rule: fail toward **worse service**, never toward
silent loss and never toward a hang. An unreadable queue costs a stale
snapshot; an unackable frame drains best-effort and says so; a server that
stops acking leaves the queue holding work and warns.

## Installation

```bash
npm install
```

For local development against another project, link the checkout (or see
`pack-install` in `package.json` for a tarball-based alternative that sidesteps
`npm link` quirks).

## Usage: fire-and-forget mode

The basic loop is four calls — configure loggers, lock in context, start
streaming, log events:

```js
import * as lo_event from 'lo_event';
import { consoleLogger }   from 'lo_event/console';
import { websocketLogger } from 'lo_event/websocket';

// 1. Configure loggers. Each event fans out to all of them. A logger is just a
//    function that receives a JSON-encoded event string, so it's easy to add
//    your own (console for dev, websocket for the persistent connection, AJAX
//    for occasional events, …).
lo_event.init('my-app', '1.0.0', [
  consoleLogger(),
  // Durable by default: records are deleted only when the server acks them.
  // Pass { autoack: true } for send-and-forget telemetry.
  websocketLogger('wss://example.org/wsapi/in/'),
]);

// 2. Optional: lock in context that rides the header — sent once, denormalized
//    back onto each event server-side, not re-sent per event.
lo_event.lockFields([{ course: 'greenheart', activity: 'field-guide' }]);

// 3. Start streaming. Anything logged (or locked) before go() is queued and
//    sent first, in order.
lo_event.go();

// 4. Log events — one flat JSON object each. Follow xAPI/Caliper vocabulary
//    where convenient; be freeform where it isn't.
lo_event.logEvent('SUBMIT', { problem: 'q1', correct: true });
```

The order matters: `init` → any pre-auth `lockFields` → `go` → `logEvent`.
Events logged before `go()` don't get dropped — they queue durably and stream
once `go()` runs. And every `logEvent` lands in the **durable queue first**; the
websocket logger streams it and (in the durable profile) holds it until the
server confirms, so a reload or outage doesn't lose it. That's what "tries very hard
never to lose an event" means in practice — see *The delivery standard* and
*Durability & the ack protocol*.

This mode is plain JavaScript — no React or redux required. For the
state-sourced workflow, add `reduxLogger` and the `lo_event/hooks` (see
*Client state-sync* and *React hooks*).

## Exports

| Specifier | Module |
|---|---|
| `lo_event` | Main entry point (`loEvent.js`) |
| `lo_event/redux` | Redux logger + reducer registry |
| `lo_event/hooks` | React status hooks (needs React) |
| `lo_event/websocket` | WebSocket logger (durable queue, ack protocol) |
| `lo_event/console` | Console logger |
| `lo_event/browser-events` | Browser event capture |
| `lo_event/queue` | Event queue (lease / confirm / rewind) |
| `lo_event/storage` | Browser storage abstraction |
| `lo_event/disabler` | Opt-in / opt-out handling |
| `lo_event/debug` | Debug logging utilities |
| `lo_event/util` | Utility functions (incl. `recordFailure`) |
| `lo_event/types` | Shared TypeScript types |
| `lo_event/null` | Null logger (no-op) |

## Examples

The `examples/` directory has interactive browser demos (`npm run browser`):

- **Browser Events** (`browser_events.html`) — keystrokes, mouse, clipboard via
  `subscribeToEvents`; shows how metadata collectors work.
- **Redux Loop** (`redux_loop.html`) — the redux logger, where events flow
  through a store so application state and logging share one data flow.

## Testing

```bash
npm test
```

Testing philosophy: good tests > no tests > bad tests. The system is inherently
testable — wire events through reducers, render example files, keep assertions
declarative. Avoid committed mocks/harnesses/polyfills (each is one more thing to
keep aligned with the code); interim scaffolding stays uncommitted, and tests of
a now-stable algorithm are weighed against their maintenance cost before they're
kept.

/**
 * The delivery engine — the protocol's decision core, with no I/O.
 *
 * Everything that decides *what happens* in reliable delivery lives here: who
 * signs for a sent record and when, when the flush barrier is clear, when the
 * state snapshot may be asked for, and when sending is allowed at all. It
 * touches no socket, no IndexedDB and no clock. You feed it **facts** and it
 * hands back **decisions**; the adapter (websocketLogger) performs them.
 *
 *     facts                          decisions
 *     ─────                          ─────────
 *     connected / disconnected       rewind
 *     recordLeased                   measureWatermark / probeQueue
 *     sendCompleted / sendFailed     sendFrame
 *     ackReceived                    confirmIds
 *     watermarkResult / probeResult  askForState
 *     measurementFailed              pauseSending / resumeSending
 *     requestState / stateReceived   clearOutbox
 *     askFailed                      log
 *     disablerEngaged / Released
 *     elapsed(ms)
 *
 * Time is a fact, not an ambient capability: the barrier's fallback cadence,
 * the barrier deadline and the snapshot re-ask timeout are decisions the engine
 * makes when *told* that time passed, so tests drive them without timers.
 * Facts that answer an earlier decision (watermarkResult, probeResult,
 * sendCompleted, sendFailed, askFailed) carry the connection generation they
 * belong to, so a slow answer from connection N cannot be mistaken for one from
 * N+1. `ackReceived` is the deliberate exception: an identity ack is a fact
 * about the world, true on any connection at any time.
 *
 * See docs/reliable-delivery.md. Landmine references (L1–L17) point at §8.
 */

/** Re-probe cadence for the one case that emits no local signal: an idle page
 *  whose backlog is drained by another tab (§7). */
export const PROBE_INTERVAL_MS = 300;
/** The barrier opens loudly after this, whatever the count says — and whatever
 *  state it is in. A stalled lease loop, or a measurement that never answers,
 *  must cost a stale snapshot, never a hang (L17). */
export const BARRIER_DEADLINE_MS = 5000;
/** An unanswered snapshot ask re-arms and re-asks after this (§6). */
export const ASK_TIMEOUT_MS = 10000;

/** The barrier's three states. `unevaluated` is NOT zero: a not-yet-measured
 *  barrier must refuse to send, or the snapshot overtakes the backlog through
 *  the measurement window (L9). */
type Barrier = 'unevaluated' | 'pending' | 'clear';

export type Decision =
  | { do: 'rewind' }
  | { do: 'measureWatermark' }
  | { do: 'probeQueue'; watermark: number }
  | { do: 'sendFrame'; frame: string; seq: number }
  | { do: 'confirmIds'; ids: number[] }
  | { do: 'askForState'; frame: string }
  | { do: 'pauseSending' }
  | { do: 'resumeSending' }
  | { do: 'clearOutbox' }
  | { do: 'log'; level: 'info' | 'error'; message: string };

export interface DeliveryOptions {
  /** false (default) = durable: confirm on the server's ack. true =
   *  send-and-forget: confirm on a send made while the socket was verified
   *  OPEN. Configuration, never negotiation (L12). */
  autoack?: boolean;
}

/**
 * How a server block engages the disabler (§5, and the blocklist frame in §12):
 *
 *   'temporary' — a rate limit; sending pauses until the adapter reports
 *                 `disablerReleased`. Admission continues throughout.
 *   'permanent' — a permanent hold on transmission. Sending stops for good,
 *                 events keep accumulating durably, and it says so: a silent
 *                 permanent stall is exactly the failure L17 forbids.
 *   'opt-out'   — a permanent privacy opt-out. Draining the stored backlog
 *                 would violate it, so this is the single sanctioned deletion
 *                 of unsent work (§5).
 *
 * The three are named here, in the fact, rather than reconstructed from a
 * boolean at each call site: an earlier build reconstructed it wrongly and
 * cleared durable unsent work on a permanent *rate limit*.
 */
export type DisablerMode = 'temporary' | 'permanent' | 'opt-out';

export class DeliveryEngine {
  private readonly autoack: boolean;

  /** Bumped on open AND on close, so a callback from a dying connection cannot
   *  fire into a connecting one (L14). */
  private gen = 0;
  private online = false;
  /** Sending is gated (blocklist / rate limit / offline), not admission (§5). */
  private paused = false;
  /** A frame is between lease and wire. The lease cursor has already advanced,
   *  so a probe resolving in this window would clear the barrier one record
   *  early (§7). The lease loop is serial, so one flag suffices. */
  private sending = false;
  private inFlightSend: { seq: number; eventId: string | null } | null = null;

  /** eventId → storage id, for records sent and awaiting an ack. Bounded by
   *  the number of unacked sends; entries leave on confirm. NOT reset per
   *  connection — identities outlive connections, storage ids are never
   *  reused (L4). */
  private readonly inFlight = new Map<string, number>();

  // ── per-connection state; all of it resets in connected() ──
  private barrier: Barrier = 'unevaluated';
  private watermark: number | null = null;
  private sinceProbe = 0;
  private sinceConnect = 0;

  // ── the snapshot request; survives connections until answered (§6) ──
  private request: string | null = null;
  private asked = false;
  private sinceAsk = 0;

  constructor ({ autoack = false }: DeliveryOptions = {}) {
    this.autoack = autoack;
  }

  /** The current connection generation. The adapter stamps it onto any answer
   *  it will feed back asynchronously. */
  generation (): number { return this.gen; }

  /** Test/debug view of the barrier. The barrier is a property of the
   *  connection, not of the request: it keeps being evaluated even when
   *  nothing waits on it, so a request arriving late finds it already clear. */
  barrierIsClear (): boolean { return this.barrier === 'clear'; }

  /** Records sent but not yet acked (durable profile). */
  awaitingAck (): number { return this.inFlight.size; }

  // ───────────────────────────────────────────────────────────── connection

  /**
   * The socket is open. All per-connection state resets, the queue rewinds,
   * and only then may leasing resume (L10) and the watermark be measured (§7:
   * the watermark and every probe read the lease cursor, so they are
   * meaningless before this connection's rewind).
   */
  connected (): Decision[] {
    this.gen++;
    this.online = true;
    this.sending = false;
    this.inFlightSend = null;
    this.barrier = 'unevaluated';
    this.watermark = null;
    this.sinceProbe = 0;
    this.sinceConnect = 0;
    this.asked = false;          // ask once *per connection*, so re-ask on a new one
    this.sinceAsk = 0;

    const out: Decision[] = [{ do: 'rewind' }];
    if (!this.paused) out.push({ do: 'resumeSending' });
    out.push({ do: 'measureWatermark' });
    return out;
  }

  /** The socket is gone. Leases evaporate; the records stay stored and the
   *  next connection's rewind resends them (L2). */
  disconnected (): Decision[] {
    this.gen++;
    this.online = false;
    this.sending = false;
    this.inFlightSend = null;
    this.barrier = 'unevaluated';
    this.asked = false;
    return [{ do: 'pauseSending' }];
  }

  // ───────────────────────────────────────────────────────────────── sending

  /**
   * The queue handed us a record. `eventId` is the identity parsed out of the
   * stored frame by the adapter, or null when the frame carries none.
   *
   * Two things must happen before the frame goes out, and both were once done
   * backwards. The in-flight registration happens *before* the send, because
   * an ack can arrive faster than a post-send bookkeeping step and an ack with
   * no map entry is dropped (§4). And a lease we cannot send must be released
   * with a rewind rather than silently dropped — the cursor only moves back via
   * rewind, and the barrier would otherwise count the record as handled when it
   * never went out (§3, L13).
   */
  recordLeased (seq: number, eventId: string | null, frame: string): Decision[] {
    if (!this.online || this.paused) {
      // Unblock and skip: no send, no confirm, the record stays stored.
      return [{ do: 'rewind' }];
    }
    this.sending = true;
    this.inFlightSend = { seq, eventId };

    const out: Decision[] = [];
    if (eventId === null) {
      // L7: it can never be acked, so it drains best-effort — loudly, because
      // a *recurring* unnamed record is a live stamping bug, not legacy.
      out.push({
        do: 'log',
        level: 'error',
        message: `outbox record ${seq} has no metadata.eventId; sending best-effort and dropping it (L7)`
      });
    } else if (!this.autoack) {
      this.inFlight.set(eventId, seq);
    }
    out.push({ do: 'sendFrame', frame, seq });
    return out;
  }

  /**
   * The adapter verified the socket was OPEN and handed the frame over.
   *
   * That predicate is deliberately not "send() didn't throw": a browser
   * WebSocket.send() on a CLOSING/CLOSED socket returns normally and discards
   * the data, which would confirm-and-delete a frame that was never buffered
   * (§5).
   */
  sendCompleted (gen: number): Decision[] {
    if (gen !== this.gen || !this.inFlightSend) return [];
    const { seq, eventId } = this.inFlightSend;
    this.sending = false;
    this.inFlightSend = null;

    const out: Decision[] = [];
    // Who signs for the send: the client itself in send-and-forget, and for an
    // unackable record in either profile. Otherwise nobody yet — the server's
    // ack will.
    if (this.autoack || eventId === null) out.push({ do: 'confirmIds', ids: [seq] });
    // The frame is out, so the lease-to-send window is closed: re-probe now.
    out.push(...this.probeIfPending());
    return out;
  }

  /** The send did not happen (socket not OPEN, or it threw). Put the record
   *  back in reach of the next lease (§3), and drop the in-flight registration:
   *  it names a frame that never went out. */
  sendFailed (gen: number): Decision[] {
    if (gen !== this.gen || !this.inFlightSend) return [];
    const { seq, eventId } = this.inFlightSend;
    this.sending = false;
    this.inFlightSend = null;
    if (eventId !== null && this.inFlight.get(eventId) === seq) this.inFlight.delete(eventId);

    return [
      { do: 'log', level: 'error', message: `send of outbox record ${seq} did not go out; rewinding` },
      { do: 'rewind' }
    ];
  }

  /**
   * `{status:'ack', id}` — the server durably captured that identity.
   *
   * Generation-free on purpose: the ack is a fact about the world, not about a
   * connection. An ack for an identity we did not send is ignored: it names a
   * record some other connection sent, or one we already confirmed, and acting
   * on it would mean scanning the store for the identity — scanning-to-delete
   * records you did not send is how L1 was violated the first time.
   */
  ackReceived (eventId: string): Decision[] {
    if (this.autoack) return [];   // nothing here awaits an ack (§5)
    const seq = this.inFlight.get(eventId);
    if (seq === undefined) return [];
    this.inFlight.delete(eventId);
    return [{ do: 'confirmIds', ids: [seq] }, ...this.probeIfPending()];
  }

  // ───────────────────────────────────────────────────────────── the barrier

  /**
   * The watermark: the highest storage id at connection start. The backlog *is*
   * everything at or below it. An empty store means no backlog, and the barrier
   * is immediately clear — the common page-load fast path.
   */
  watermarkResult (gen: number, maxSeq: number | null): Decision[] {
    if (gen !== this.gen || this.barrier !== 'unevaluated') return [];
    if (maxSeq === null) {
      this.barrier = 'clear';
      return this.askIfReady();
    }
    this.watermark = maxSeq;
    this.barrier = 'pending';
    this.sinceProbe = 0;
    return [{ do: 'probeQueue', watermark: maxSeq }];
  }

  /** `unleasedAtOrBelow(watermark)`: nothing at or below the watermark is still
   *  unleased by us — either we leased it (and therefore sent it ahead of the
   *  request) or an ack deleted it. */
  probeResult (gen: number, unleased: number): Decision[] {
    if (gen !== this.gen || this.barrier !== 'pending' || this.sending) return [];
    if (unleased > 0) return [];
    this.barrier = 'clear';
    return this.askIfReady();
  }

  /** An unreadable store or a failed measurement degrades to *no barrier*
   *  (L17): the failure mode of this feature is a stale snapshot, never a hang.
   *  Loud, because it costs freshness. */
  measurementFailed (gen: number, what: string): Decision[] {
    if (gen !== this.gen || this.barrier === 'clear') return [];
    this.barrier = 'clear';
    return [
      {
        do: 'log',
        level: 'error',
        message: `flush barrier ${what} failed; proceeding with no barrier — the snapshot may be stale`
      },
      ...this.askIfReady()
    ];
  }

  private probeIfPending (): Decision[] {
    if (this.barrier !== 'pending' || this.sending) return [];
    this.sinceProbe = 0;
    return [{ do: 'probeQueue', watermark: this.watermark! }];
  }

  // ──────────────────────────────────────────────────────────── the snapshot

  /** Ask the server for the state snapshot. A new request re-arms the latch,
   *  even on a connection that already asked and was answered (§6). */
  requestState (frame: string): Decision[] {
    this.request = frame;
    this.asked = false;
    this.sinceAsk = 0;
    return this.askIfReady();
  }

  /** The `{status:'fetch_blob'}` response arrived. Whichever snapshot lands
   *  resolves the load; overlapping responses are benign (§6). */
  stateReceived (): Decision[] {
    this.request = null;
    this.asked = false;
    return [];
  }

  /** The ask could not be put on the wire (the socket closed between the
   *  decision and its execution). Re-arm immediately rather than holding the
   *  request for a full re-ask timeout: the latch exists to stop *bursts* of
   *  answered asks, not to ration attempts that never happened. */
  askFailed (gen: number): Decision[] {
    if (gen !== this.gen || !this.asked) return [];
    this.asked = false;
    this.sinceAsk = 0;
    return [{
      do: 'log',
      level: 'error',
      message: 'the state snapshot request did not reach an open socket; re-arming to ask again'
    }];
  }

  private askIfReady (): Decision[] {
    if (!this.online || !this.request || this.asked) return [];
    if (this.barrier !== 'clear') return [];   // un-evaluated refuses to send
    this.asked = true;
    this.sinceAsk = 0;
    return [{ do: 'askForState', frame: this.request }];
  }

  // ───────────────────────────────────────────────────────────── the disabler

  /**
   * A blocklist frame, or a block already in effect: stop *sending*. Admission
   * is untouched in every mode — a blocked client keeps accepting and storing
   * events (§5); what varies is what happens to sending and to the stored
   * backlog. See DisablerMode: only 'opt-out' may delete anything, and the
   * engine never infers that from "permanent" alone.
   */
  disablerEngaged (mode: DisablerMode = 'temporary'): Decision[] {
    const out: Decision[] = [];
    if (!this.paused) {
      this.paused = true;
      out.push({ do: 'pauseSending' });
    }
    if (mode === 'opt-out') {
      out.push({
        do: 'log',
        level: 'error',
        message: 'permanent opt-out: discarding the stored backlog on the user\'s instruction — the single sanctioned deletion of unsent work (§5)'
      });
      out.push({ do: 'clearOutbox' });
    } else if (mode === 'permanent') {
      // Loud, because the alternative is a client that quietly stops
      // delivering forever while its queue grows: worse service is allowed,
      // silence is not (L17).
      out.push({
        do: 'log',
        level: 'error',
        message: 'permanently blocked by the server; sending has stopped. Events keep accumulating durably and nothing is discarded'
      });
    }
    return out;
  }

  disablerReleased (): Decision[] {
    if (!this.paused) return [];
    this.paused = false;
    return this.online ? [{ do: 'resumeSending' }] : [];
  }

  // ─────────────────────────────────────────────────────────────────── time

  /**
   * `ms` of wall time passed. Drives three deadlines, each of which exists
   * because something can stop making progress without ever erroring:
   *
   *   - the barrier's fallback probe — cross-tab deletions are invisible here;
   *   - the barrier deadline — a stalled lease loop is silent, and so is a
   *     watermark measurement that never settles. It therefore runs in EVERY
   *     non-clear state: scoping it to `pending` leaves an un-evaluated barrier
   *     (the state that refuses to send) with no way out at all — a spinner
   *     with no error, which is the exact failure L17 forbids;
   *   - the snapshot re-ask — a server that never answers is silent.
   */
  elapsed (ms: number): Decision[] {
    if (!this.online) return [];
    const out: Decision[] = [];

    if (this.barrier !== 'clear') {
      this.sinceConnect += ms;
      if (this.sinceConnect >= BARRIER_DEADLINE_MS) {
        this.barrier = 'clear';
        out.push({
          do: 'log',
          level: 'error',
          message: 'flush barrier did not clear within its deadline; sending the snapshot request anyway — it may be stale'
        });
        out.push(...this.askIfReady());
      } else if (this.barrier === 'pending' && !this.sending) {
        this.sinceProbe += ms;
        if (this.sinceProbe >= PROBE_INTERVAL_MS) {
          this.sinceProbe = 0;
          out.push({ do: 'probeQueue', watermark: this.watermark! });
        }
      }
    }

    if (this.request) {
      if (!this.asked) {
        // Nothing is in flight: either the barrier just cleared with no other
        // trigger, or an ask failed to go out. Retrying here makes the tick the
        // single recovery path for a request that is owed but not outstanding.
        out.push(...this.askIfReady());
      } else {
        this.sinceAsk += ms;
        if (this.sinceAsk >= ASK_TIMEOUT_MS) {
          this.asked = false;      // re-arm the latch and ask again, loudly
          out.push({
            do: 'log',
            level: 'error',
            message: 'no answer to the state snapshot request; asking again'
          });
          out.push(...this.askIfReady());
        }
      }
    }
    return out;
  }
}

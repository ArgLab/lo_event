/*
 * The state-snapshot request (fetch_blob), as a testable state machine.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * This bookkeeping produced three regressions in a row, every one found by a
 * human reading the diff rather than by a test, because it lived as loose
 * variables inside websocketLogger's socket plumbing where nothing could reach
 * it without a real WebSocket and a real IndexedDB. The logic is pure — counts
 * and flags — so it belongs somewhere it can be driven directly.
 *
 * WHAT IT ENFORCES
 * ----------------
 * A snapshot request is a property of a CONNECTION, not of durable history:
 * the answer comes back on the socket that asked, once, and is worthless to
 * anyone else. So it is never queued. Three rules, each of which has already
 * been violated at least once:
 *
 *   1. SNAPSHOT AFTER FLUSH. The request must reach the server after the
 *      backlog this connection started with, or the snapshot predates the
 *      client's own last keystrokes — and since the server never echoes events
 *      back, the UI would show stale state until another reload. Ordering is by
 *      arrival (the server folds serially), so the backlog need only be SENT,
 *      not acked.
 *   2. ASK ONCE PER CONNECTION. The barrier is re-checked after every drained
 *      record; without a latch, every record past the threshold fires another
 *      request and the server builds a whole state blob for each.
 *   3. RE-ASK ON RECONNECT. A response lost to a dropped socket must not strand
 *      the client forever, so the latch clears with the connection while the
 *      request itself survives until answered.
 *
 * The barrier counts SENDS, not acks, and the count is captured once at
 * connection establishment — before the capability gate opens, since the lease
 * loop can push records the moment it does. Measuring later counted sends that
 * were then zeroed, leaving a deficit nothing could close. A live count is not
 * a valid watermark for the same reason: another tab draining the shared store
 * moves it.
 */

export interface StateRequestOptions {
  /** Records already in the durable queue when this connection came up. */
  backlog: number;
}

export class StateRequest {
  /** The request frame, held until answered. Null = nothing wanted. */
  private outstanding: string | null = null;
  /** Records this connection has sent (any mode: ack, legacy, or unnamed). */
  private sent = 0;
  /** Backlog present when this connection came up. */
  private backlog = 0;
  /** Asked already on this connection? */
  private asked = false;
  /** Is a connection up at all? */
  private live = false;

  /** The app wants a state snapshot. Idempotent; replaces any prior frame. */
  request(frame: string): void {
    this.outstanding = frame;
  }

  /** A snapshot arrived. Stop asking. */
  fulfilled(): void {
    this.outstanding = null;
  }

  /**
   * A connection came up. Called at establishment, BEFORE anything can be
   * sent on it — the backlog may not be known yet, so it starts at 0 and is
   * supplied by `backlogMeasured` when the count resolves.
   */
  connected(): void {
    this.live = true;
    this.sent = 0;
    this.asked = false;
    this.backlog = 0;
  }

  /** The backlog count for this connection resolved. */
  backlogMeasured(n: number): void {
    this.backlog = n;
  }

  /** The connection went away. */
  disconnected(): void {
    this.live = false;
  }

  /** One record went out on this connection. */
  sentRecord(): void {
    this.sent++;
  }

  /**
   * Should the request go out right now? True at most once per connection.
   * Calling this IS the decision: it latches.
   */
  shouldSend(): boolean {
    if (!this.live || this.asked || this.outstanding === null) return false;
    if (this.sent < this.backlog) return false;
    this.asked = true;
    return true;
  }

  /** The frame to send (null if nothing is outstanding). */
  frame(): string | null {
    return this.outstanding;
  }
}

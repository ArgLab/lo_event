/*
 * The state-snapshot request (fetch_blob), as a testable state machine.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * This bookkeeping produced three regressions in a row, every one found by a
 * human reading the diff rather than by a test, because it lived as loose
 * variables inside websocketLogger's socket plumbing where nothing could reach
 * it without a real WebSocket and a real IndexedDB. The logic is pure flags,
 * so it belongs somewhere it can be driven directly.
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
 *      back, the UI would show stale state until another reload.
 *   2. ASK ONCE PER CONNECTION. The barrier is re-checked after every drained
 *      record; without a latch, every record past the threshold fires another
 *      request and the server builds a whole state blob for each.
 *   3. RE-ASK ON RECONNECT. A response lost to a dropped socket must not strand
 *      the client forever, so the latch clears with the connection while the
 *      request itself survives until answered.
 *
 * WHY THE MACHINE DOES NOT COUNT
 * ------------------------------
 * Two prior designs kept the flush barrier here as arithmetic, and both were
 * wrong in ways a shared queue makes inevitable:
 *
 *   - A count captured at connection start is not a per-connection quota:
 *     another tab can send and delete a shared record before this connection
 *     leases it, so this connection may NEVER observe the counted number of
 *     sends — the barrier starves. Only the queue knows what remains.
 *   - A zero-initialized "backlog" is an answer, not a placeholder: any check
 *     that runs before the measurement resolves sees a satisfied barrier and
 *     lets the request overtake the backlog — the original bug, back again
 *     through a timing window.
 *
 * So the barrier lives where the truth lives. websocketLogger captures a
 * watermark (the highest stored seq at connection start, AFTER rewind) and
 * asks the queue "does anything at or below it remain unleased?"; when the
 * answer is no, it calls `barrierCleared()`. Until that call, this machine
 * refuses to send — un-evaluated is a distinct state here, not zero. Records
 * below the watermark that vanish without being leased were deleted by an ack,
 * which means the server already has them: the barrier clears without this
 * connection sending them, which is exactly right.
 */

export class StateRequest {
  /** The request frame, held until answered. Null = nothing wanted. */
  private outstanding: string | null = null;
  /** Asked already on this connection? */
  private asked = false;
  /** Is a connection up at all? */
  private live = false;
  /** Has the flush barrier been affirmatively cleared for THIS connection?
   *  Starts false on every connection: "not yet evaluated" must refuse to
   *  send, never default-allow. */
  private barrierClear = false;

  /** The app wants a state snapshot. Replaces any prior frame, and re-arms
   *  the ask-once latch: a new request is a new question, even on a
   *  connection that already asked (and was answered) once. */
  request (frame: string): void {
    this.outstanding = frame;
    this.asked = false;
  }

  /** A snapshot arrived. Stop asking. */
  fulfilled (): void {
    this.outstanding = null;
  }

  /** A connection came up. Called at establishment, before anything can be
   *  sent on it. The barrier resets to un-evaluated: nothing sends until
   *  websocketLogger's evaluation affirmatively clears it. */
  connected (): void {
    this.live = true;
    this.asked = false;
    this.barrierClear = false;
  }

  /** The connection went away. */
  disconnected (): void {
    this.live = false;
  }

  /** The flush barrier for this connection is clear: nothing at or below the
   *  connection-start watermark remains unleased in the durable queue. */
  barrierCleared (): void {
    this.barrierClear = true;
  }

  /** Has the barrier been cleared for this connection? Lets the evaluator
   *  stop probing once the answer is in — the barrier is a property of the
   *  connection, so it stays clear whether or not a request is waiting. */
  barrierIsClear (): boolean {
    return this.barrierClear;
  }

  /**
   * Should the request go out right now? True at most once per connection
   * (per request). Calling this IS the decision: it latches.
   */
  shouldSend (): boolean {
    if (!this.live || this.asked || this.outstanding === null || !this.barrierClear) return false;
    this.asked = true;
    return true;
  }

  /** The frame to send (null if nothing is outstanding). */
  frame (): string | null {
    return this.outstanding;
  }
}

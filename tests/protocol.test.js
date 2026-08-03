/*
 * The delivery engine, driven as pure data: facts in, decisions out. No
 * mocks, no fake sockets, no timers (§9).
 *
 * Layout mirrors the spec: connection lifecycle, confirm sources, the flush
 * barrier, the snapshot latch, the disabler, and a replay of §12's annotated
 * wire trace. Tests labeled REGRESSION pin bugs found in round one of this
 * rebuild — each shipped in a careful implementation and survived its own
 * test suite.
 */

import { describe, it, expect } from 'vitest';
import {
  DeliveryEngine,
  PROBE_INTERVAL_MS,
  BARRIER_DEADLINE_MS,
  ASK_TIMEOUT_MS
} from '../src/protocol.js';

const FETCH = JSON.stringify({ event: 'fetch_blob' });

/** Decisions of one kind, for terse assertions. */
const of = (decisions, kind) => decisions.filter(d => d.do === kind);

/** Bring a fresh engine to "connected, barrier clear, nothing stored". */
function connectedEmpty (opts) {
  const engine = new DeliveryEngine(opts);
  engine.connected();
  engine.watermarkResult(engine.generation(), null);
  return engine;
}

/** Bring a fresh engine to "connected, barrier pending behind `watermark`". */
function connectedPending (watermark, opts) {
  const engine = new DeliveryEngine(opts);
  engine.connected();
  engine.watermarkResult(engine.generation(), watermark);
  return engine;
}

describe('connection lifecycle', () => {
  it('rewinds before measuring the watermark (L10)', () => {
    const engine = new DeliveryEngine();
    const decisions = engine.connected();
    const order = decisions.map(d => d.do);
    expect(order.indexOf('rewind')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('rewind')).toBeLessThan(order.indexOf('measureWatermark'));
  });

  it('bumps the generation on close as well as open, so stale answers die (L14)', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    const staleGen = engine.generation();
    engine.disconnected();
    engine.connected();
    // The old connection's watermark answer arrives late: it must not seed
    // the new connection's barrier.
    expect(engine.watermarkResult(staleGen, 42)).toEqual([]);
    expect(engine.barrierIsClear()).toBe(false);
  });

  it('pauses sending on disconnect; leases surfacing afterwards are released, not sent (L13)', () => {
    const engine = connectedEmpty();
    expect(of(engine.disconnected(), 'pauseSending')).toHaveLength(1);
    const decisions = engine.recordLeased(7, 'B.S1.1', '{}');
    expect(of(decisions, 'rewind')).toHaveLength(1);
    expect(of(decisions, 'sendFrame')).toHaveLength(0);
    expect(of(decisions, 'confirmIds')).toHaveLength(0);
  });
});

describe('durable confirm source (autoack: false)', () => {
  it('registers in flight before the send decision — a faster-than-bookkeeping ack still lands (§4)', () => {
    const engine = connectedEmpty();
    engine.recordLeased(41, 'B.S1.38', '{"a":1}');
    // The ack arrives before sendCompleted is ever reported.
    const decisions = engine.ackReceived('B.S1.38');
    expect(of(decisions, 'confirmIds')).toEqual([{ do: 'confirmIds', ids: [41] }]);
  });

  it('does not confirm on send; confirms exactly the acked storage id (L2, L4)', () => {
    const engine = connectedEmpty();
    engine.recordLeased(41, 'B.S1.38', '{}');
    expect(of(engine.sendCompleted(engine.generation()), 'confirmIds')).toHaveLength(0);
    expect(of(engine.ackReceived('B.S1.38'), 'confirmIds')).toEqual([{ do: 'confirmIds', ids: [41] }]);
  });

  it('ignores an ack for an identity it did not send, and a second ack for one it did (§4)', () => {
    const engine = connectedEmpty();
    engine.recordLeased(41, 'B.S1.38', '{}');
    engine.sendCompleted(engine.generation());
    expect(engine.ackReceived('SOMEONE.ELSES.7')).toEqual([]);
    engine.ackReceived('B.S1.38');
    expect(engine.ackReceived('B.S1.38')).toEqual([]);   // map entry removed on confirm
  });

  it('keeps the in-flight map across reconnects — identities outlive connections (L4)', () => {
    const engine = connectedEmpty();
    engine.recordLeased(41, 'B.S1.38', '{}');
    engine.sendCompleted(engine.generation());
    engine.disconnected();
    engine.connected();
    engine.watermarkResult(engine.generation(), null);
    expect(of(engine.ackReceived('B.S1.38'), 'confirmIds')).toEqual([{ do: 'confirmIds', ids: [41] }]);
  });

  it('a failed send rewinds, loudly, and never confirms (§3, L13)', () => {
    const engine = connectedEmpty();
    engine.recordLeased(41, 'B.S1.38', '{}');
    const decisions = engine.sendFailed(engine.generation());
    expect(of(decisions, 'rewind')).toHaveLength(1);
    expect(of(decisions, 'log')).toHaveLength(1);
    expect(of(decisions, 'confirmIds')).toHaveLength(0);
  });
});

describe('send-and-forget confirm source (autoack: true)', () => {
  it('confirms on a completed (verified-OPEN) send, and only then (§5)', () => {
    const engine = connectedEmpty({ autoack: true });
    engine.recordLeased(41, 'B.S1.38', '{}');
    expect(engine.awaitingAck()).toBe(0);   // no in-flight map in this profile
    const decisions = engine.sendCompleted(engine.generation());
    expect(of(decisions, 'confirmIds')).toEqual([{ do: 'confirmIds', ids: [41] }]);
  });

  it('ignores server acks (§12)', () => {
    const engine = connectedEmpty({ autoack: true });
    engine.recordLeased(41, 'B.S1.38', '{}');
    engine.sendCompleted(engine.generation());
    expect(engine.ackReceived('B.S1.38')).toEqual([]);
  });

  it('a failed send still rewinds rather than confirming — the loss window is buffered-then-died, not never-sent (§5)', () => {
    const engine = connectedEmpty({ autoack: true });
    engine.recordLeased(41, 'B.S1.38', '{}');
    const decisions = engine.sendFailed(engine.generation());
    expect(of(decisions, 'confirmIds')).toHaveLength(0);
    expect(of(decisions, 'rewind')).toHaveLength(1);
  });
});

describe('unnamed records (L7)', () => {
  it('drain best-effort in the durable profile: loud error at lease, confirm on send', () => {
    const engine = connectedEmpty();
    const leaseDecisions = engine.recordLeased(9, null, '{"legacy":true}');
    expect(of(leaseDecisions, 'log').some(d => d.level === 'error')).toBe(true);
    expect(of(leaseDecisions, 'sendFrame')).toHaveLength(1);
    const sendDecisions = engine.sendCompleted(engine.generation());
    expect(of(sendDecisions, 'confirmIds')).toEqual([{ do: 'confirmIds', ids: [9] }]);
  });
});

describe('the flush barrier (§7, L8–L10)', () => {
  it('an empty store clears immediately — the page-load fast path', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), null);
    expect(engine.barrierIsClear()).toBe(true);
  });

  it('un-evaluated refuses to send the snapshot — not-yet-measured is not zero (L9)', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    expect(of(engine.requestState(FETCH), 'askForState')).toHaveLength(0);
    expect(of(engine.watermarkResult(engine.generation(), null), 'askForState')).toHaveLength(1);
  });

  it('clears only when the store reports nothing unleased at or below the watermark', () => {
    const engine = connectedPending(42);
    engine.requestState(FETCH);
    expect(of(engine.probeResult(engine.generation(), 2), 'askForState')).toHaveLength(0);
    expect(engine.barrierIsClear()).toBe(false);
    expect(of(engine.probeResult(engine.generation(), 0), 'askForState')).toHaveLength(1);
    expect(engine.barrierIsClear()).toBe(true);
  });

  it('discards a probe resolving inside the lease-to-send window; the send re-probes (§7)', () => {
    const engine = connectedPending(42);
    engine.recordLeased(41, 'B.S1.38', '{}');
    // The cursor has advanced but the frame is not on the wire: a probe
    // answering now would clear one record early.
    expect(engine.probeResult(engine.generation(), 0)).toEqual([]);
    expect(engine.barrierIsClear()).toBe(false);
    const decisions = engine.sendCompleted(engine.generation());
    expect(of(decisions, 'probeQueue')).toEqual([{ do: 'probeQueue', watermark: 42 }]);
  });

  it('re-probes when an ack deletes a record below the watermark', () => {
    const engine = connectedPending(42);
    engine.recordLeased(41, 'B.S1.38', '{}');
    engine.sendCompleted(engine.generation());
    expect(of(engine.ackReceived('B.S1.38'), 'probeQueue')).toHaveLength(1);
  });

  it('runs the ~300ms fallback probe — cross-tab deletions emit no local signal', () => {
    const engine = connectedPending(42);
    expect(of(engine.elapsed(PROBE_INTERVAL_MS - 1), 'probeQueue')).toHaveLength(0);
    expect(of(engine.elapsed(1), 'probeQueue')).toHaveLength(1);
  });

  it('a failed measurement opens the barrier loudly — stale snapshot, never a hang (L17)', () => {
    const engine = connectedPending(42);
    engine.requestState(FETCH);
    const decisions = engine.measurementFailed(engine.generation(), 'probe');
    expect(of(decisions, 'log').some(d => d.level === 'error')).toBe(true);
    expect(of(decisions, 'askForState')).toHaveLength(1);
  });

  it('opens at the deadline while pending, loudly', () => {
    const engine = connectedPending(42);
    engine.requestState(FETCH);
    const decisions = engine.elapsed(BARRIER_DEADLINE_MS);
    expect(of(decisions, 'log').some(d => d.level === 'error')).toBe(true);
    expect(of(decisions, 'askForState')).toHaveLength(1);
  });

  it('REGRESSION: opens at the deadline from un-evaluated too — a watermark that never settles must not hold the spinner forever', () => {
    // Round 1: the deadline only ran in the `pending` state, so a maxSeq()
    // call that never settled left the barrier un-evaluated forever — no
    // error, no progress, L17's forbidden hang.
    const engine = new DeliveryEngine();
    engine.connected();                      // watermark asked, never answered
    engine.requestState(FETCH);
    const decisions = engine.elapsed(BARRIER_DEADLINE_MS);
    expect(engine.barrierIsClear()).toBe(true);
    expect(of(decisions, 'askForState')).toHaveLength(1);
  });

  it('clearance latches per connection: a mid-connection rewind does not re-close it', () => {
    const engine = connectedPending(42);
    engine.recordLeased(41, 'B.S1.38', '{}');
    engine.sendCompleted(engine.generation());
    engine.probeResult(engine.generation(), 0);
    expect(engine.barrierIsClear()).toBe(true);
    // A later failed send forces a rewind (§3); the barrier stays clear —
    // it promised ordering after the *connection-start* backlog only.
    engine.recordLeased(43, 'B.S2.1', '{}');
    engine.sendFailed(engine.generation());
    expect(engine.barrierIsClear()).toBe(true);
  });

  it('live typing above the watermark never delays the snapshot', () => {
    const engine = connectedPending(42);
    engine.requestState(FETCH);
    // The connection-start backlog drains…
    engine.recordLeased(41, 'B.S1.38', '{}');
    engine.sendCompleted(engine.generation());
    engine.recordLeased(42, 'B.S1.39', '{}');
    engine.sendCompleted(engine.generation());
    // …and the probe answers zero even though id 43 was enqueued meanwhile:
    // records above the watermark are not in the count.
    expect(of(engine.probeResult(engine.generation(), 0), 'askForState')).toHaveLength(1);
  });
});

describe('the snapshot latch (§6, L11)', () => {
  it('asks once per connection — re-checks past the threshold do not re-fire', () => {
    const engine = connectedEmpty();
    expect(of(engine.requestState(FETCH), 'askForState')).toHaveLength(1);
    // The barrier keeps being consulted; none of these may re-ask.
    expect(of(engine.elapsed(PROBE_INTERVAL_MS), 'askForState')).toHaveLength(0);
    expect(of(engine.probeResult(engine.generation(), 0), 'askForState')).toHaveLength(0);
  });

  it('re-asks on reconnect while unanswered', () => {
    const engine = connectedEmpty();
    engine.requestState(FETCH);
    engine.disconnected();
    engine.connected();
    expect(of(engine.watermarkResult(engine.generation(), null), 'askForState')).toHaveLength(1);
  });

  it('stops once fulfilled — a reconnect does not re-ask', () => {
    const engine = connectedEmpty();
    engine.requestState(FETCH);
    engine.stateReceived();
    engine.disconnected();
    engine.connected();
    expect(of(engine.watermarkResult(engine.generation(), null), 'askForState')).toHaveLength(0);
  });

  it('a new request re-arms the latch, even on a connection that already asked and was answered', () => {
    const engine = connectedEmpty();
    engine.requestState(FETCH);
    engine.stateReceived();
    expect(of(engine.requestState(FETCH), 'askForState')).toHaveLength(1);
  });

  it('an unanswered ask times out and re-asks, loudly (§6)', () => {
    const engine = connectedEmpty();
    engine.requestState(FETCH);
    expect(of(engine.elapsed(ASK_TIMEOUT_MS - 1), 'askForState')).toHaveLength(0);
    const decisions = engine.elapsed(1);
    expect(of(decisions, 'askForState')).toHaveLength(1);
    expect(of(decisions, 'log').some(d => d.level === 'error')).toBe(true);
  });

  it('a request arriving after the barrier cleared finds it already evaluated', () => {
    const engine = connectedEmpty();   // barrier cleared before anyone asked
    expect(of(engine.requestState(FETCH), 'askForState')).toHaveLength(1);
  });
});

describe('the disabler (§5)', () => {
  it('a temporary block pauses sending; release resumes it; admission is never involved', () => {
    const engine = connectedEmpty();
    expect(of(engine.disablerEngaged('temporary'), 'pauseSending')).toHaveLength(1);
    expect(of(engine.disablerReleased(), 'resumeSending')).toHaveLength(1);
  });

  it('a lease surfacing under an engaged disabler is released, not sent — a blocklist can arrive while the lease sits parked (L13)', () => {
    const engine = connectedEmpty();
    engine.disablerEngaged('temporary');
    const decisions = engine.recordLeased(7, 'B.S1.1', '{}');
    expect(of(decisions, 'sendFrame')).toHaveLength(0);
    expect(of(decisions, 'rewind')).toHaveLength(1);
  });

  it('REGRESSION: a permanent non-opt-out block NEVER clears the queue — it pauses loudly and events keep accumulating', () => {
    // Round 1: one build conflated "permanent" with "opt-out" and destroyed
    // durable unsent records on a permanent rate limit — deletion of
    // undelivered work, the unforgivable category.
    const engine = connectedEmpty();
    const decisions = engine.disablerEngaged('permanent');
    expect(of(decisions, 'clearQueue')).toHaveLength(0);
    expect(of(decisions, 'pauseSending')).toHaveLength(1);
    expect(of(decisions, 'log').some(d => d.level === 'error')).toBe(true);   // never a silent stall
  });

  it('a permanent opt-out clears the queue — the single sanctioned deletion of unsent work', () => {
    const engine = connectedEmpty();
    const decisions = engine.disablerEngaged('opt-out');
    expect(of(decisions, 'clearQueue')).toHaveLength(1);
    expect(of(decisions, 'log').some(d => d.level === 'error')).toBe(true);
  });
});

describe('the §12 wire trace, replayed', () => {
  it('runs the annotated durable session end to end', () => {
    // Tab reopens after a crash: ids 41 and 42 (identities B.S1.38/39) sit
    // unacked in the store. B.S2.* is this session.
    const engine = new DeliveryEngine();
    const sent = [];
    const confirmed = [];
    const track = decisions => {
      sent.push(...of(decisions, 'sendFrame').map(d => d.seq));
      sent.push(...of(decisions, 'askForState').map(() => 'fetch_blob'));
      confirmed.push(...of(decisions, 'confirmIds').flatMap(d => d.ids));
      return decisions;
    };

    // [socket open]  reset; rewind; watermark = 42
    track(engine.connected());
    track(engine.requestState(FETCH));
    track(engine.watermarkResult(engine.generation(), 42));
    // backlog drains through leases
    track(engine.recordLeased(41, 'B.S1.38', '{"event":"save_blob"}'));
    track(engine.sendCompleted(engine.generation()));
    track(engine.probeResult(engine.generation(), 1));
    track(engine.recordLeased(42, 'B.S1.39', '{"event":"answer"}'));
    track(engine.sendCompleted(engine.generation()));
    // barrier probed after the send completed → clear → fetch_blob only now
    track(engine.probeResult(engine.generation(), 0));
    // user types; id 43 (B.S2.1) leased and sent — above the watermark
    track(engine.recordLeased(43, 'B.S2.1', '{"event":"keystroke"}'));
    track(engine.sendCompleted(engine.generation()));
    // acks land: exact ids, never a range
    track(engine.ackReceived('B.S1.38'));
    track(engine.ackReceived('B.S1.39'));
    track(engine.stateReceived());

    expect(sent).toEqual([41, 42, 'fetch_blob', 43]);   // snapshot after the backlog, before nothing
    expect(confirmed).toEqual([41, 42]);

    // [network drops before B.S2.1 is acked] — the lease evaporates.
    track(engine.disconnected());
    track(engine.connected());
    track(engine.watermarkResult(engine.generation(), 43));
    // resent with the SAME identity; snapshot already fulfilled → no fetch_blob
    track(engine.recordLeased(43, 'B.S2.1', '{"event":"keystroke"}'));
    track(engine.sendCompleted(engine.generation()));
    track(engine.probeResult(engine.generation(), 0));
    track(engine.ackReceived('B.S2.1'));

    expect(sent).toEqual([41, 42, 'fetch_blob', 43, 43]);
    expect(confirmed).toEqual([41, 42, 43]);
  });
});

// The delivery engine, driven as data: facts in, decisions out.
//
// No sockets, no IndexedDB, no timers — §9's whole point. Every landmine in
// §8 that is a *decision* is expressible here, and every test below names the
// bug it pins. Time is a fact (`elapsed`), so the deadlines are tested without
// waiting for them.
//
// The five invariants that used to live in tests/stateRequest.test.js (whose
// module the ablation deleted) are re-pinned in "the state snapshot" below:
// un-evaluated refuses to send, ask once per connection, re-ask on reconnect,
// stop once fulfilled, a new request re-arms the latch.

import { describe, it, expect } from 'vitest';
import {
  DeliveryEngine,
  PROBE_INTERVAL_MS,
  BARRIER_DEADLINE_MS,
  ASK_TIMEOUT_MS
} from '../src/protocol.js';

const FRAME = JSON.stringify({ event: 'fetch_blob' });

/** Decisions of one kind, in order. */
const only = (decisions, kind) => decisions.filter(d => d.do === kind);
const kinds = (decisions) => decisions.map(d => d.do);

/** Open a connection and clear the barrier on an empty store — the page-load
 *  fast path, which most tests want as a starting position rather than as the
 *  thing under test. */
function connectedWithEmptyStore (engine) {
  engine.connected();
  return engine.watermarkResult(engine.generation(), null);
}

describe('connection lifecycle', () => {
  it('rewinds BEFORE it resumes sending or measures (L10)', () => {
    // Both the lease cursor and every barrier probe read post-rewind truth. A
    // lease issued against the previous connection's cursor skips the backlog
    // entirely; a probe against it clears the barrier spuriously.
    const engine = new DeliveryEngine();
    const order = kinds(engine.connected());

    expect(order[0]).toBe('rewind');
    expect(order.indexOf('rewind')).toBeLessThan(order.indexOf('measureWatermark'));
    expect(order.indexOf('rewind')).toBeLessThan(order.indexOf('resumeSending'));
  });

  it('bumps the generation on close as well as on open (L14)', () => {
    // A callback scheduled by a dying connection must not fire into the
    // connecting one. Bumping only on open leaves a window where it can.
    const engine = new DeliveryEngine();
    engine.connected();
    const open = engine.generation();
    engine.disconnected();

    expect(engine.generation()).not.toBe(open);
  });

  it('stops sending when the socket goes', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    expect(kinds(engine.disconnected())).toContain('pauseSending');
  });

  it('ignores answers stamped with a connection that has since died (L14)', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    const stale = engine.generation();
    engine.disconnected();
    engine.connected();

    expect(engine.watermarkResult(stale, 42)).toEqual([]);
    expect(engine.probeResult(stale, 0)).toEqual([]);
    expect(engine.sendCompleted(stale)).toEqual([]);
    expect(engine.measurementFailed(stale, 'watermark')).toEqual([]);
  });
});

describe('durable profile — deleted only on ack (L2)', () => {
  it('sends without confirming, and confirms exactly the acked id (L1, L4)', () => {
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);

    const leased = engine.recordLeased(41, 'B.S1.38', 'frame');
    expect(kinds(leased)).toEqual(['sendFrame']);
    expect(engine.sendCompleted(engine.generation())).toEqual([]);   // nobody has signed yet

    expect(engine.ackReceived('B.S1.38')).toEqual([{ do: 'confirmIds', ids: [41] }]);
  });

  it('registers the identity BEFORE the send, so a fast ack still lands (§4)', () => {
    // An ack can arrive faster than a post-send bookkeeping step, and an ack
    // with no map entry is dropped — leaving the record to resend forever.
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.recordLeased(7, 'id-7', 'frame');

    // The ack overtakes sendCompleted entirely.
    expect(engine.ackReceived('id-7')).toEqual([{ do: 'confirmIds', ids: [7] }]);
  });

  it('ignores an ack for an identity it did not send (L1)', () => {
    // It names a record another connection sent. Acting on it would mean
    // scanning the store for the identity, and scanning-to-delete records you
    // did not send is how L1 was violated the first time.
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);

    expect(engine.ackReceived('someone-elses-id')).toEqual([]);
  });

  it('ignores a second ack for the same identity — the entry left on confirm (L4)', () => {
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.recordLeased(9, 'id-9', 'frame');
    engine.sendCompleted(engine.generation());

    expect(engine.ackReceived('id-9')).toEqual([{ do: 'confirmIds', ids: [9] }]);
    expect(engine.ackReceived('id-9')).toEqual([]);
    expect(engine.awaitingAck()).toBe(0);
  });

  it('keeps the in-flight map across connections — identities outlive sockets (L4)', () => {
    // Storage ids are never reused, so an entry whose ack arrives on a later
    // connection still names the right record.
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.recordLeased(3, 'id-3', 'frame');
    engine.disconnected();
    engine.connected();

    expect(engine.ackReceived('id-3')).toEqual([{ do: 'confirmIds', ids: [3] }]);
  });
});

describe('send-and-forget profile (autoack)', () => {
  it('confirms on a send made while the socket was verified OPEN (§5)', () => {
    const engine = new DeliveryEngine({ autoack: true });
    connectedWithEmptyStore(engine);

    expect(kinds(engine.recordLeased(5, 'id-5', 'frame'))).toEqual(['sendFrame']);
    expect(engine.sendCompleted(engine.generation())).toContainEqual({ do: 'confirmIds', ids: [5] });
  });

  it('does not confirm a send that never went out (L13)', () => {
    // The predicate is "the socket was verified OPEN", not "send() didn't
    // throw": a browser send() on a CLOSING socket returns normally and
    // discards the data.
    const engine = new DeliveryEngine({ autoack: true });
    connectedWithEmptyStore(engine);
    engine.recordLeased(5, 'id-5', 'frame');

    const decisions = engine.sendFailed(engine.generation());
    expect(only(decisions, 'confirmIds')).toEqual([]);
    expect(kinds(decisions)).toContain('rewind');
  });

  it('ignores acks — nothing here awaits one', () => {
    // The server may ack anyway (§12); a send-and-forget client drops them.
    const engine = new DeliveryEngine({ autoack: true });
    connectedWithEmptyStore(engine);
    engine.recordLeased(5, 'id-5', 'frame');
    engine.sendCompleted(engine.generation());

    expect(engine.ackReceived('id-5')).toEqual([]);
  });
});

describe('unnamed records drain best-effort (L7)', () => {
  it('confirms on send even in the durable profile, loudly', () => {
    // It can never be acked, so resending it on every reconnect is forever.
    // The loss window is accepted once, and logged, because a *recurring*
    // unnamed record is a live stamping bug rather than legacy residue.
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);

    const leased = engine.recordLeased(12, null, 'frame');
    expect(kinds(leased)).toContain('log');
    expect(engine.sendCompleted(engine.generation())).toContainEqual({ do: 'confirmIds', ids: [12] });
  });

  it('does not enter the in-flight map — an ack could never name it', () => {
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.recordLeased(12, null, 'frame');

    expect(engine.awaitingAck()).toBe(0);
  });
});

describe('a lease that cannot be sent is released, not stranded (L13, §3)', () => {
  it('rewinds instead of sending when the connection is gone', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.disconnected();

    const decisions = engine.recordLeased(4, 'id-4', 'frame');
    expect(kinds(decisions)).toEqual(['rewind']);
    expect(only(decisions, 'sendFrame')).toEqual([]);
  });

  it('rewinds instead of sending while the disabler is engaged (§5)', () => {
    // Including the case that broke an earlier build: the block arrived while
    // a lease sat parked, so the record surfaced *after* the pause. The check
    // is at the moment the record surfaces, not the moment it was requested.
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.disablerEngaged('temporary');

    expect(kinds(engine.recordLeased(4, 'id-4', 'frame'))).toEqual(['rewind']);
  });

  it('rewinds a failed send, so the barrier cannot count it as handled', () => {
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.recordLeased(4, 'id-4', 'frame');

    expect(kinds(engine.sendFailed(engine.generation()))).toContain('rewind');
  });

  it('drops the in-flight registration for a failed send', () => {
    // Otherwise the map grows an entry naming a record that never went out,
    // and a later ack for that identity (from another connection's copy)
    // would confirm a record this connection never sent.
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);
    engine.recordLeased(4, 'id-4', 'frame');
    engine.sendFailed(engine.generation());

    expect(engine.awaitingAck()).toBe(0);
  });
});

describe('the disabler gates sending, never admission (§5)', () => {
  it('pauses and resumes the lease loop', () => {
    const engine = new DeliveryEngine();
    connectedWithEmptyStore(engine);

    expect(kinds(engine.disablerEngaged('temporary'))).toContain('pauseSending');
    expect(kinds(engine.disablerReleased())).toContain('resumeSending');
  });

  it('a connection opened while blocked does not resume sending', () => {
    const engine = new DeliveryEngine();
    engine.disablerEngaged('temporary');

    expect(kinds(engine.connected())).not.toContain('resumeSending');
  });

  it('clears the outbox ONLY for a permanent opt-out', () => {
    // The single sanctioned deletion of unsent work (§5). Neither a temporary
    // nor a *permanent* rate limit is an opt-out: deleting for either would be
    // the unforgivable category, reached through a plausible-looking path.
    const temporary = new DeliveryEngine();
    expect(kinds(temporary.disablerEngaged('temporary'))).not.toContain('clearOutbox');

    const permanent = new DeliveryEngine();
    expect(kinds(permanent.disablerEngaged('permanent'))).not.toContain('clearOutbox');

    const optedOut = new DeliveryEngine();
    expect(kinds(optedOut.disablerEngaged('opt-out'))).toContain('clearOutbox');
  });

  it('says so when a block is permanent — a silent forever-stall is not allowed', () => {
    // Sending stops for good and the queue grows without bound. That is the
    // correct behavior, and it must be visible: worse service is permitted,
    // silence is not (L17).
    const permanent = new DeliveryEngine();
    expect(kinds(permanent.disablerEngaged('permanent'))).toContain('log');

    const temporary = new DeliveryEngine();
    expect(kinds(temporary.disablerEngaged('temporary'))).not.toContain('log');
  });
});

describe('the flush barrier (L8, L9)', () => {
  it('an empty store clears immediately — the page-load fast path', () => {
    const engine = new DeliveryEngine();
    engine.connected();

    engine.watermarkResult(engine.generation(), null);
    expect(engine.barrierIsClear()).toBe(true);
  });

  it('a backlog probes, and clears only at zero', () => {
    const engine = new DeliveryEngine();
    engine.connected();

    expect(engine.watermarkResult(engine.generation(), 42)).toEqual([{ do: 'probeQueue', watermark: 42 }]);
    engine.probeResult(engine.generation(), 2);
    expect(engine.barrierIsClear()).toBe(false);
    engine.probeResult(engine.generation(), 0);
    expect(engine.barrierIsClear()).toBe(true);
  });

  it('un-evaluated is a state, not a zero (L9)', () => {
    // Any check that runs before the measurement resolves must see an
    // unsatisfied barrier, or the snapshot overtakes the backlog through the
    // timing window.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    engine.connected();

    expect(engine.barrierIsClear()).toBe(false);
    expect(only(engine.elapsed(1), 'askForState')).toEqual([]);
  });

  it('skips a probe that resolves inside the lease-to-send window (§7)', () => {
    // The cursor advances at lease time, a moment before the frame is on the
    // wire; a probe resolving in that window clears the barrier one record
    // early. The send's own re-probe runs strictly after.
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), 10);
    engine.recordLeased(10, 'id-10', 'frame');       // cursor now past 10

    engine.probeResult(engine.generation(), 0);
    expect(engine.barrierIsClear()).toBe(false);     // ignored: send in flight

    const after = engine.sendCompleted(engine.generation());
    expect(after).toContainEqual({ do: 'probeQueue', watermark: 10 });
  });

  it('re-probes when an ack deletes a record (cross-connection drain)', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), 10);
    engine.recordLeased(9, 'id-9', 'frame');
    engine.sendCompleted(engine.generation());

    expect(kinds(engine.ackReceived('id-9'))).toContain('probeQueue');
  });

  it('re-probes on the fallback cadence — cross-tab deletions emit no local signal (§7)', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), 10);

    expect(only(engine.elapsed(PROBE_INTERVAL_MS - 1), 'probeQueue')).toEqual([]);
    expect(only(engine.elapsed(1), 'probeQueue')).toEqual([{ do: 'probeQueue', watermark: 10 }]);
  });

  it('clearance latches — a mid-connection rewind does not re-close it', () => {
    // A failed send's recovery rewinds (§3), which puts records back below the
    // cursor. The barrier promised ordering against the backlog that existed
    // at connection start, and that promise was already kept.
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), 10);
    engine.probeResult(engine.generation(), 0);

    engine.recordLeased(3, 'id-3', 'frame');
    engine.sendFailed(engine.generation());
    expect(engine.barrierIsClear()).toBe(true);
  });

  it('opens loudly on a failed measurement — worse service, never a hang (L17)', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    engine.connected();

    const decisions = engine.measurementFailed(engine.generation(), 'watermark');
    expect(kinds(decisions)).toContain('log');
    expect(engine.barrierIsClear()).toBe(true);
    expect(only(decisions, 'askForState')).toEqual([{ do: 'askForState', frame: FRAME }]);
  });

  it('opens loudly on its deadline when a probe never reaches zero (L17)', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    engine.connected();
    engine.watermarkResult(engine.generation(), 10);

    const decisions = engine.elapsed(BARRIER_DEADLINE_MS);
    expect(kinds(decisions)).toContain('log');
    expect(engine.barrierIsClear()).toBe(true);
    expect(only(decisions, 'askForState')).toEqual([{ do: 'askForState', frame: FRAME }]);
  });

  it('opens on its deadline even if the watermark measurement never answers', () => {
    // The deadline must cover the un-evaluated state too. A measurement that
    // never settles (a transaction that hangs — the spec names this exact
    // scenario) otherwise leaves the barrier un-evaluated forever, and
    // un-evaluated refuses to send: spinner, no error, no recovery.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    engine.connected();
    // No watermarkResult ever arrives.

    const decisions = engine.elapsed(BARRIER_DEADLINE_MS);
    expect(engine.barrierIsClear()).toBe(true);
    expect(only(decisions, 'askForState')).toEqual([{ do: 'askForState', frame: FRAME }]);
  });

  it('is a property of the connection, evaluated with or without a request', () => {
    // The request can arrive after the backlog drains, and must find the
    // barrier already clear rather than waiting for a probe nothing triggers.
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), null);

    expect(engine.barrierIsClear()).toBe(true);
    expect(engine.requestState(FRAME)).toEqual([{ do: 'askForState', frame: FRAME }]);
  });
});

describe('the state snapshot (§6, L11)', () => {
  it('asks once per connection, however often the barrier is re-checked', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    engine.connected();

    const first = engine.watermarkResult(engine.generation(), null);
    expect(only(first, 'askForState')).toEqual([{ do: 'askForState', frame: FRAME }]);
    expect(only(engine.elapsed(1), 'askForState')).toEqual([]);
    expect(only(engine.elapsed(1), 'askForState')).toEqual([]);
  });

  it('re-asks on a new connection when the answer never came', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedWithEmptyStore(engine);
    engine.disconnected();

    engine.connected();
    expect(only(engine.watermarkResult(engine.generation(), null), 'askForState'))
      .toEqual([{ do: 'askForState', frame: FRAME }]);
  });

  it('stops asking once answered, across reconnects', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedWithEmptyStore(engine);
    engine.stateReceived();

    engine.disconnected();
    engine.connected();
    expect(only(engine.watermarkResult(engine.generation(), null), 'askForState')).toEqual([]);
  });

  it('a NEW request re-arms the latch on the same connection', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedWithEmptyStore(engine);
    engine.stateReceived();

    expect(engine.requestState(FRAME)).toEqual([{ do: 'askForState', frame: FRAME }]);
  });

  it('never asks with no connection', () => {
    const engine = new DeliveryEngine();
    expect(engine.requestState(FRAME)).toEqual([]);
  });

  it('never asks when nothing was requested', () => {
    const engine = new DeliveryEngine();
    expect(only(connectedWithEmptyStore(engine), 'askForState')).toEqual([]);
  });

  it('an unanswered ask times out and re-asks, loudly (§6)', () => {
    // "Once per connection" bounds the burst, not the patience: a healthy
    // connection whose server never answers must not leave the spinner up.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedWithEmptyStore(engine);

    expect(only(engine.elapsed(ASK_TIMEOUT_MS - 1), 'askForState')).toEqual([]);
    const decisions = engine.elapsed(1);
    expect(kinds(decisions)).toContain('log');
    expect(only(decisions, 'askForState')).toEqual([{ do: 'askForState', frame: FRAME }]);
  });

  it('does not time out an answered request', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedWithEmptyStore(engine);
    engine.stateReceived();

    expect(only(engine.elapsed(ASK_TIMEOUT_MS * 2), 'askForState')).toEqual([]);
  });

  it('re-asks promptly when the ask itself could not go out', () => {
    // askForState is executed directly on the socket, and that send can fail
    // (a socket that closed between the decision and its execution). Latching
    // `asked` on a send that never happened would hold the request for a full
    // re-ask timeout — or forever, if nothing else re-triggers it.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedWithEmptyStore(engine);

    // Loudly: an ask that never left is a degradation like any other (L17).
    expect(kinds(engine.askFailed(engine.generation()))).toContain('log');
    expect(only(engine.elapsed(1), 'askForState')).toEqual([{ do: 'askForState', frame: FRAME }]);
  });
});

describe('the whole session, as the wire trace tells it (§12)', () => {
  it('drains the crash backlog, then asks — live typing never delays it', () => {
    // The trace: a tab reopens with ids 41 and 42 unacked from a dead session.
    // fetch_blob must leave after both, and id 43 (live typing, above the
    // watermark) must not delay it.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    const wire = [];

    engine.connected();
    engine.watermarkResult(engine.generation(), 42);

    for (const [seq, id] of [[41, 'B.S1.38'], [42, 'B.S1.39']]) {
      engine.recordLeased(seq, id, `frame-${seq}`).forEach(d => {
        if (d.do === 'sendFrame') wire.push(d.frame);
      });
      engine.sendCompleted(engine.generation());
    }

    // The probe the send triggered comes back empty: both records are leased.
    engine.probeResult(engine.generation(), 0).forEach(d => {
      if (d.do === 'askForState') wire.push('fetch_blob');
    });

    // Live typing, enqueued above the watermark.
    engine.recordLeased(43, 'B.S2.1', 'frame-43').forEach(d => {
      if (d.do === 'sendFrame') wire.push(d.frame);
    });
    engine.sendCompleted(engine.generation());

    expect(wire).toEqual(['frame-41', 'frame-42', 'fetch_blob', 'frame-43']);

    // The acks land, each confirming exactly one record, named individually.
    expect(engine.ackReceived('B.S1.38')).toContainEqual({ do: 'confirmIds', ids: [41] });
    expect(engine.ackReceived('B.S1.39')).toContainEqual({ do: 'confirmIds', ids: [42] });

    // The network drops before 43 is acked. Its lease evaporates; the record
    // stays stored, and the next connection resends it under the SAME identity.
    engine.disconnected();
    engine.connected();
    engine.watermarkResult(engine.generation(), 43);
    const resend = engine.recordLeased(43, 'B.S2.1', 'frame-43');
    expect(only(resend, 'sendFrame')).toEqual([{ do: 'sendFrame', frame: 'frame-43', seq: 43 }]);
    engine.sendCompleted(engine.generation());

    // Already fulfilled? No — it never was, so it asks again on this
    // connection. Had it been fulfilled, no fetch_blob would go out.
    engine.stateReceived();
    engine.disconnected();
    engine.connected();
    expect(only(engine.watermarkResult(engine.generation(), 43), 'askForState')).toEqual([]);

    // The server acks the copy it got, whichever one that was (idempotent).
    expect(engine.ackReceived('B.S2.1')).toContainEqual({ do: 'confirmIds', ids: [43] });
  });
});

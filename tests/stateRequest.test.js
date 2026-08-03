/*
 * The snapshot-request invariants (§6, L11).
 *
 * Every test here corresponds to a bug that actually shipped into a commit
 * and was caught by a human reading the diff, not by a test. Each one ends in
 * the same user-visible symptom: "Loading user state..." forever (or a stale
 * snapshot), with no error anywhere.
 *
 * The `StateRequest` module these tests once drove was folded into the
 * delivery engine — the latch waits on the barrier's clearance and shares the
 * connection generation, so splitting them meant duplicating that state. Per
 * §9, the module was free to go but the ASSERTIONS were not: this file keeps
 * them, driving the engine. (protocol.test.js covers the same machine in
 * context; this file exists so the §6 invariant list is auditable in one
 * place.)
 */

import { describe, it, expect } from 'vitest';
import { DeliveryEngine, ASK_TIMEOUT_MS } from '../src/protocol.js';

const FRAME = JSON.stringify({ event: 'fetch_blob' });

const asks = decisions => decisions.filter(d => d.do === 'askForState');

/** Connect and clear the barrier (empty store), returning the decisions. */
function connectedClear (engine) {
  engine.connected();
  return engine.watermarkResult(engine.generation(), null);
}

describe('barrier discipline', () => {
  it('refuses to send while the barrier is un-evaluated — not-yet-measured is not zero', () => {
    // A zero-initialized barrier is an answer, not a placeholder: any check
    // that ran before the backlog measurement resolved saw a satisfied
    // barrier, and the request overtook the backlog — the snapshot predated
    // the client's own last keystrokes.
    const engine = new DeliveryEngine();
    engine.connected();
    expect(asks(engine.requestState(FRAME))).toHaveLength(0);
    expect(asks(engine.watermarkResult(engine.generation(), null))).toHaveLength(1);
  });

  it('a reconnect re-arms the barrier — clearance is per-connection', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedClear(engine);
    engine.disconnected();
    engine.connected();                       // new connection, new backlog
    expect(engine.barrierIsClear()).toBe(false);
    expect(asks(engine.watermarkResult(engine.generation(), null))).toHaveLength(1);
  });
});

describe('ask once per connection', () => {
  it('does not re-ask after the first send, however often the barrier is re-checked', () => {
    // The latch is consulted constantly. Without it, every check past the
    // threshold fired another request — and the server built a full state
    // blob for each: a self-inflicted burst.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    expect(asks(connectedClear(engine))).toHaveLength(1);
    expect(asks(engine.elapsed(100))).toHaveLength(0);
    expect(asks(engine.probeResult(engine.generation(), 0))).toHaveLength(0);
  });

  it('re-asks on a new connection when the answer never came', () => {
    // A response lost to a dropped socket must not strand the client: the
    // latch clears with the connection, the request survives until answered.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedClear(engine);
    engine.disconnected();
    expect(asks(connectedClear(engine))).toHaveLength(1);
  });

  it('stops asking once answered, across reconnects', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedClear(engine);
    engine.stateReceived();
    engine.disconnected();
    expect(asks(connectedClear(engine))).toHaveLength(0);
  });

  it('a NEW request re-arms the latch on the same connection', () => {
    // A new request is a new question, even after a previous one was asked
    // and answered on this connection. Without re-arming, a second request
    // would silently wait for a reconnect that may never come.
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedClear(engine);
    engine.stateReceived();
    expect(asks(engine.requestState(FRAME))).toHaveLength(1);
  });
});

describe('an unanswered ask times out', () => {
  it('re-asks after ~10s, loudly — "once per connection" bounds the burst, not the patience (L17)', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedClear(engine);
    expect(asks(engine.elapsed(ASK_TIMEOUT_MS - 1))).toHaveLength(0);
    const decisions = engine.elapsed(1);
    expect(asks(decisions)).toHaveLength(1);
    expect(decisions.some(d => d.do === 'log' && d.level === 'error')).toBe(true);
  });

  it('the timeout clock stops once fulfilled', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FRAME);
    connectedClear(engine);
    engine.stateReceived();
    expect(asks(engine.elapsed(ASK_TIMEOUT_MS * 2))).toHaveLength(0);
  });
});

describe('preconditions', () => {
  it('never asks with no connection', () => {
    const engine = new DeliveryEngine();
    expect(asks(engine.requestState(FRAME))).toHaveLength(0);
  });

  it('never asks when nothing was requested', () => {
    const engine = new DeliveryEngine();
    expect(asks(connectedClear(engine))).toHaveLength(0);
  });
});

describe('barrierIsClear() — the evaluator stop condition', () => {
  it('reflects clearance per connection, independent of any request', () => {
    // The barrier is a property of the CONNECTION, so it keeps being
    // evaluated even when no request is waiting yet — the request can arrive
    // after the backlog has drained, and must find the barrier already clear
    // rather than waiting for a probe that nothing will ever trigger.
    const engine = new DeliveryEngine();
    engine.connected();
    expect(engine.barrierIsClear()).toBe(false);
    engine.watermarkResult(engine.generation(), null);
    expect(engine.barrierIsClear()).toBe(true);

    engine.disconnected();
    engine.connected();
    expect(engine.barrierIsClear()).toBe(false);   // re-armed by the reconnect
    expect(asks(engine.requestState(FRAME))).toHaveLength(0);   // late request waits for evaluation
  });
});

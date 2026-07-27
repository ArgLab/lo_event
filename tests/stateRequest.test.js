// The snapshot-request state machine.
//
// Every test here corresponds to a bug that actually shipped into a commit and
// was caught by a human reading the diff, not by a test — which is the reason
// this logic was pulled out of websocketLogger's socket plumbing in the first
// place. Each one ends in the same user-visible symptom: "Loading user
// state..." forever (or a stale snapshot), with no error anywhere.
//
// The flush barrier itself is NOT here: it is a question about the shared
// queue's contents, answered by the queue (unleasedAtOrBelow — see the
// "flush barrier" tests in queue.test.js). This machine only records the
// answer, and refuses to send until the answer has arrived.

import { describe, it, expect } from 'vitest';
import { StateRequest } from '../src/stateRequest.js';

const FRAME = JSON.stringify({ event: 'fetch_blob' });

describe('barrier discipline', () => {
  it('refuses to send while the barrier is un-evaluated — not-yet-measured is not zero', () => {
    // A zero-initialized barrier is an answer, not a placeholder: any check
    // that ran before the backlog measurement resolved saw a satisfied
    // barrier, and the request overtook the backlog — the snapshot predated
    // the client's own last keystrokes.
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();

    expect(sr.shouldSend()).toBe(false);   // barrier not yet evaluated
    sr.barrierCleared();
    expect(sr.shouldSend()).toBe(true);
  });

  it('a reconnect re-arms the barrier — clearance is per-connection', () => {
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();
    sr.barrierCleared();

    sr.disconnected();
    sr.connected();
    expect(sr.shouldSend()).toBe(false);   // new connection, new backlog
    sr.barrierCleared();
    expect(sr.shouldSend()).toBe(true);
  });
});

describe('ask once per connection', () => {
  it('does not re-ask after the first send', () => {
    // shouldSend() is consulted after every drained record. Without a latch,
    // each record past the barrier fired another request and the server built
    // a full state blob for each — a self-inflicted burst.
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();
    sr.barrierCleared();

    expect(sr.shouldSend()).toBe(true);
    expect(sr.shouldSend()).toBe(false);
    expect(sr.shouldSend()).toBe(false);
  });

  it('re-asks on a new connection when the answer never came', () => {
    // A response lost to a dropped socket must not strand the client: the
    // latch clears with the connection, the request survives until answered.
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();
    sr.barrierCleared();
    expect(sr.shouldSend()).toBe(true);

    sr.disconnected();
    sr.connected();
    sr.barrierCleared();
    expect(sr.shouldSend()).toBe(true);
  });

  it('stops asking once answered, across reconnects', () => {
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();
    sr.barrierCleared();
    sr.shouldSend();
    sr.fulfilled();

    sr.disconnected();
    sr.connected();
    sr.barrierCleared();
    expect(sr.shouldSend()).toBe(false);
    expect(sr.frame()).toBe(null);
  });

  it('a NEW request re-arms the latch on the same connection', () => {
    // request() is a new question, even after a previous one was asked and
    // answered on this connection. Without re-arming, a second request would
    // silently wait for a reconnect that may never come.
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();
    sr.barrierCleared();
    sr.shouldSend();
    sr.fulfilled();

    sr.request(FRAME);
    expect(sr.shouldSend()).toBe(true);
  });
});

describe('preconditions', () => {
  it('never asks with no connection', () => {
    const sr = new StateRequest();
    sr.request(FRAME);
    expect(sr.shouldSend()).toBe(false);
  });

  it('never asks when nothing was requested', () => {
    const sr = new StateRequest();
    sr.connected();
    sr.barrierCleared();
    expect(sr.shouldSend()).toBe(false);
  });
});

describe('barrierIsClear() — the evaluator stop condition', () => {
  it('reflects clearance per connection, independent of any request', () => {
    // The probe loop (nudges + fallback timer) keys off this: the barrier is
    // a property of the CONNECTION, so it must keep being evaluated even when
    // no request is waiting yet — the request can arrive after the backlog
    // has drained, and must find the barrier already clear rather than
    // waiting for a probe that nothing will ever trigger.
    const sr = new StateRequest();
    sr.connected();
    expect(sr.barrierIsClear()).toBe(false);
    sr.barrierCleared();
    expect(sr.barrierIsClear()).toBe(true);

    sr.disconnected();
    sr.connected();
    expect(sr.barrierIsClear()).toBe(false);   // re-armed by the reconnect
  });
});

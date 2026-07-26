// The snapshot-request state machine.
//
// Every test here corresponds to a bug that actually shipped into a commit and
// was caught by a human reading the diff, not by a test — which is the reason
// this logic was pulled out of websocketLogger's socket plumbing in the first
// place. Each one ends in the same user-visible symptom: "Loading user
// state..." forever, with no error anywhere.

import { describe, it, expect } from 'vitest';
import { StateRequest } from '../src/stateRequest.js';

const FRAME = JSON.stringify({ event: 'fetch_blob' });

/** Drive a connection that starts with `backlog` records already queued. */
function connected(sr, backlog = 0) {
  sr.connected();
  sr.backlogMeasured(backlog);
}

describe('snapshot after flush', () => {
  it('waits for the backlog to be sent before asking', () => {
    // Asking first means the snapshot predates the client's own last
    // keystrokes. The server folds them afterwards but never echoes them back,
    // so the UI shows stale state until another reload — losing exactly the
    // tail that durable recovery just saved.
    const sr = new StateRequest();
    sr.request(FRAME);
    connected(sr, 3);

    expect(sr.shouldSend()).toBe(false);
    sr.sentRecord();
    expect(sr.shouldSend()).toBe(false);
    sr.sentRecord();
    sr.sentRecord();
    expect(sr.shouldSend()).toBe(true);
  });

  it('asks immediately when there is no backlog', () => {
    const sr = new StateRequest();
    sr.request(FRAME);
    connected(sr, 0);
    expect(sr.shouldSend()).toBe(true);
  });

  it('counts sends made before the backlog count resolves', () => {
    // The capability gate opens at hello, so the lease loop can push records
    // before the count comes back. Those sends must still count: zeroing the
    // counter when the measurement landed left a deficit that nothing could
    // close on a page generating no new events.
    const sr = new StateRequest();
    sr.request(FRAME);
    sr.connected();
    sr.sentRecord();
    sr.sentRecord();
    sr.backlogMeasured(2);       // measurement arrives late
    expect(sr.shouldSend()).toBe(true);
  });
});

describe('ask once per connection', () => {
  it('does not re-ask after every subsequent record', () => {
    // shouldSend() is consulted after every drained record. Without a latch,
    // each record past the threshold fires another request and the server
    // builds a full state blob for each — a self-inflicted burst.
    const sr = new StateRequest();
    sr.request(FRAME);
    connected(sr, 0);

    expect(sr.shouldSend()).toBe(true);
    sr.sentRecord();
    expect(sr.shouldSend()).toBe(false);
    sr.sentRecord();
    expect(sr.shouldSend()).toBe(false);
  });

  it('re-asks on a new connection when the answer never came', () => {
    // A response lost to a dropped socket must not strand the client: the
    // latch clears with the connection, the request survives until answered.
    const sr = new StateRequest();
    sr.request(FRAME);
    connected(sr, 0);
    expect(sr.shouldSend()).toBe(true);

    sr.disconnected();
    connected(sr, 0);
    expect(sr.shouldSend()).toBe(true);
  });

  it('stops asking once answered, across reconnects', () => {
    const sr = new StateRequest();
    sr.request(FRAME);
    connected(sr, 0);
    sr.shouldSend();
    sr.fulfilled();

    sr.disconnected();
    connected(sr, 0);
    expect(sr.shouldSend()).toBe(false);
    expect(sr.frame()).toBe(null);
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
    connected(sr, 0);
    expect(sr.shouldSend()).toBe(false);
  });

  it('a fresh connection re-arms the barrier for its own backlog', () => {
    // Backlog is per-connection: a reconnect facing a new backlog must wait
    // again rather than inheriting the previous connection's progress.
    const sr = new StateRequest();
    sr.request(FRAME);
    connected(sr, 0);
    sr.shouldSend();

    sr.disconnected();
    connected(sr, 2);
    expect(sr.shouldSend()).toBe(false);
    sr.sentRecord();
    sr.sentRecord();
    expect(sr.shouldSend()).toBe(true);
  });
});

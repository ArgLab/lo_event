import { describe, expect, it } from 'vitest';
import {
  BARRIER_DEADLINE_MS,
  DeliveryEngine,
  PROBE_INTERVAL_MS,
  SNAPSHOT_RETRY_MS
} from '../src/protocol.js';

const FETCH = JSON.stringify({ event: 'fetch_blob' });
const kinds = decisions => decisions.map(decision => decision.do);
const pick = (decisions, kind) => decisions.filter(decision => decision.do === kind);

function connectedEngine (options = {}) {
  const engine = new DeliveryEngine(options);
  engine.connected();
  engine.watermarkResult(engine.generation(), null);
  return engine;
}

function send (engine, seq, id) {
  const leased = engine.recordLeased(seq, id, JSON.stringify({ metadata: { eventId: id } }));
  return [...leased, ...engine.sendCompleted(engine.generation())];
}

describe('connection and confirmation', () => {
  it('rewinds before enabling sends or measuring the watermark', () => {
    expect(kinds(new DeliveryEngine().connected()))
      .toEqual(['rewind', 'resumeSending', 'measureWatermark']);
  });

  it('invalidates every asynchronous connection result on close', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    const stale = engine.generation();
    engine.disconnected();
    engine.connected();
    expect(engine.watermarkResult(stale, null)).toEqual([]);
    expect(engine.probeResult(stale, 0)).toEqual([]);
    expect(engine.sendCompleted(stale)).toEqual([]);
  });

  it('durable mode confirms exactly the identity the server acked', () => {
    const engine = connectedEngine();
    expect(pick(send(engine, 7, 'browser.session.7'), 'confirmIds')).toEqual([]);
    expect(engine.ackReceived('browser.session.7'))
      .toEqual([{ do: 'confirmIds', ids: [7] }]);
    expect(engine.ackReceived('browser.session.7')).toEqual([]);
  });

  it('registers identity before send and keeps it across reconnects', () => {
    const engine = connectedEngine();
    engine.recordLeased(7, 'browser.session.7', '{}');
    engine.disconnected();
    engine.connected();
    expect(engine.ackReceived('browser.session.7'))
      .toContainEqual({ do: 'confirmIds', ids: [7] });
  });

  it('autoack confirms only after a successful send', () => {
    const engine = connectedEngine({ autoack: true });
    engine.recordLeased(7, 'browser.session.7', '{}');
    expect(engine.sendFailed(engine.generation()).some(d => d.do === 'confirmIds')).toBe(false);

    engine.recordLeased(7, 'browser.session.7', '{}');
    expect(engine.sendCompleted(engine.generation()))
      .toContainEqual({ do: 'confirmIds', ids: [7] });
  });

  it('drains an unnamed legacy record loudly after send', () => {
    const decisions = send(connectedEngine(), 7, null);
    expect(pick(decisions, 'log')[0].level).toBe('error');
    expect(decisions).toContainEqual({ do: 'confirmIds', ids: [7] });
  });
});

describe('disabler policy', () => {
  it('a block pauses sends and a parked lease is rewound', () => {
    const engine = connectedEngine();
    expect(kinds(engine.disablerEngaged())).toEqual(['pauseSending']);
    expect(kinds(engine.recordLeased(7, 'id', '{}'))).toEqual(['rewind']);
    expect(kinds(engine.disablerReleased())).toEqual(['resumeSending']);
  });

  it('permanent MAINTAIN retains the outbox, while privacy DROP discards it', () => {
    const maintain = connectedEngine().disablerEngaged({ permanent: true });
    expect(kinds(maintain)).not.toContain('discardOutbox');
    expect(pick(maintain, 'log')[0].level).toBe('error');

    const drop = connectedEngine().disablerEngaged({ permanent: true, permanentOptOut: true });
    expect(kinds(drop)).toContain('discardOutbox');
  });
});

describe('flush barrier', () => {
  it('un-evaluated refuses the snapshot until measurement clears it', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    expect(engine.requestState(FETCH)).toEqual([]);
    expect(engine.watermarkResult(engine.generation(), null))
      .toEqual([{ do: 'askForState', frame: FETCH }]);
  });

  it('does not clear from a probe in the lease-to-send window', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    const generation = engine.generation();
    engine.watermarkResult(generation, 7);
    engine.recordLeased(7, 'id', '{}');
    expect(engine.probeResult(generation, 0)).toEqual([]);
    expect(engine.barrierIsClear()).toBe(false);
    expect(engine.sendCompleted(generation))
      .toContainEqual({ do: 'probeQueue', watermark: 7 });
  });

  it('fallback probes notice deletions performed by another tab', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.watermarkResult(engine.generation(), 7);
    expect(engine.elapsed(PROBE_INTERVAL_MS))
      .toContainEqual({ do: 'probeQueue', watermark: 7 });
  });

  it('deadline covers a maxSeq measurement that never settles', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.requestState(FETCH);
    const decisions = engine.elapsed(BARRIER_DEADLINE_MS);
    expect(pick(decisions, 'log')[0].level).toBe('error');
    expect(decisions).toContainEqual({ do: 'askForState', frame: FETCH });
  });

  it('measurement failure opens loudly rather than hanging', () => {
    const engine = new DeliveryEngine();
    engine.connected();
    engine.requestState(FETCH);
    const decisions = engine.measurementFailed(engine.generation(), 'watermark');
    expect(pick(decisions, 'log')[0].level).toBe('error');
    expect(kinds(decisions)).toContain('askForState');
  });
});

describe('state snapshot', () => {
  it('starts the retry clock only after the direct send succeeds', () => {
    const engine = connectedEngine();
    expect(kinds(engine.requestState(FETCH))).toEqual(['askForState']);
    expect(engine.elapsed(SNAPSHOT_RETRY_MS * 2)).toEqual([]);

    engine.stateSendCompleted(engine.generation());
    expect(engine.elapsed(SNAPSHOT_RETRY_MS - 1)).toEqual([]);
    expect(kinds(engine.elapsed(1))).toEqual(['log', 'askForState']);
  });

  it('re-asks on reconnect, stops when fulfilled, and allows a new request', () => {
    const engine = connectedEngine();
    engine.requestState(FETCH);
    engine.stateSendCompleted(engine.generation());
    engine.disconnected();
    engine.connected();
    expect(engine.watermarkResult(engine.generation(), null))
      .toContainEqual({ do: 'askForState', frame: FETCH });

    engine.stateReceived();
    engine.disconnected();
    engine.connected();
    expect(engine.watermarkResult(engine.generation(), null)).toEqual([]);
    expect(engine.requestState(FETCH)).toContainEqual({ do: 'askForState', frame: FETCH });
  });

  it('accepts a response as a world fact even after its socket changed', () => {
    const engine = connectedEngine();
    engine.requestState(FETCH);
    engine.disconnected();
    engine.stateReceived();
    engine.connected();
    expect(engine.watermarkResult(engine.generation(), null)).toEqual([]);
  });
});

describe('annotated wire trace', () => {
  it('sends the crash backlog before the snapshot and resends unacked work', () => {
    const engine = new DeliveryEngine();
    engine.requestState(FETCH);
    engine.connected();
    const first = engine.generation();
    engine.watermarkResult(first, 2);

    engine.recordLeased(1, 'B.S1.1', '{}');
    engine.sendCompleted(first);
    engine.probeResult(first, 1);
    engine.recordLeased(2, 'B.S1.2', '{}');
    engine.sendCompleted(first);
    expect(engine.probeResult(first, 0))
      .toEqual([{ do: 'askForState', frame: FETCH }]);

    engine.stateSendCompleted(first);
    engine.recordLeased(3, 'B.S1.3', '{}');
    engine.sendCompleted(first);
    engine.disconnected();
    engine.connected();
    const second = engine.generation();
    engine.watermarkResult(second, 3);
    engine.recordLeased(3, 'B.S1.3', '{}');
    engine.sendCompleted(second);
    expect(engine.ackReceived('B.S1.3'))
      .toEqual([{ do: 'confirmIds', ids: [3] }, { do: 'probeQueue', watermark: 3 }]);
  });
});

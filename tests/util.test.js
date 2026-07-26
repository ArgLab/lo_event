// TODO:
// * Document
// * More test cases
// * Much better description strings

import { describe, it, expect, beforeEach } from 'vitest';
import * as util from '../src/util.js';

let someAsyncCondition;
global.document = {};

const DEBUG = false;

function debug_log(...args) {
  if(DEBUG) {
    console.log(...args);
  }
}

async function checkCondition () {
  debug_log('Util test: checking', someAsyncCondition);
  return someAsyncCondition;
}

describe.skip('Testing Backoff functionality', () => {
  beforeEach(() => {
    someAsyncCondition = false;
  });

  it('Check for generic backoff functionality', async () => {
    setTimeout(() => {
      someAsyncCondition = true;
    }, 1000);

    try {
      await util.backoff(checkCondition, 'This should not be seen in the console');
      expect(someAsyncCondition).toBe(true);
    } catch (error) {
      console.error(error.message);
    }
  }, 10000);

  it('Test max retry on backoff', async () => {
    try {
      await util.backoff(
        checkCondition,
        'Condition not met after max retries.',
        [1000, 1000, 1000],
        util.TERMINATION_POLICY.RETRY,
        5
      );
    } catch (error) {
      console.error(error.message);
    }
    expect(someAsyncCondition).toBe(false);
  }, 10000);
});

describe('util.js testing', () => {
  it('Test fullyQualifiedWebsocketURL', () => {
    // We need a function wrapper to check for thrown errors
    expect(function () {
      util.fullyQualifiedWebsocketURL();
    }).toThrow(new Error('Base server is not provided.'));

    global.document.location = 'http://www.example.com';
    expect(util.fullyQualifiedWebsocketURL()).toBe('ws://www.example.com/wsapi/in');
    expect(util.fullyQualifiedWebsocketURL('/ws')).toBe('ws://www.example.com/ws');
    expect(util.fullyQualifiedWebsocketURL('/ws', 'https://learning-observer.org')).toBe('wss://learning-observer.org/ws');
    expect(function () {
      util.fullyQualifiedWebsocketURL('/ws', 'fake://learning-observer.org');
    }).toThrow(new Error('Protocol mapping not found.'));
  });

  it('test deeply merging metadata', async () => {
    const obj1 = { a: 1, b: { c: 3 } };
    const func1 = function () {
      return { b: { d: 4 }, e: 5 };
    };
    expect(await util.mergeMetadata([obj1, func1])).toEqual({ a: 1, b: { c: 3, d: 4 }, e: 5 });
  });

  it('it should copy specified fields from the source object', () => {
    const source = { foo: 'bar', baz: 'qux' };
    const fields = ['foo', 'baz'];
    expect(util.copyFields(source, fields)).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('it should return an empty object if source is null', () => {
    expect(util.copyFields(null, ['foo', 'baz'])).toEqual({});
  });

  it('it should only copy fields that exist in the source object', () => {
    const source = { foo: 'bar' };
    const fields = ['foo', 'baz'];
    expect(util.copyFields(source, fields)).toEqual({ foo: 'bar' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event identity
// ─────────────────────────────────────────────────────────────────────────────
//
// eventId is what the ack protocol names, so these are protocol invariants
// rather than debugging conveniences: an ack that cannot be matched back to a
// record is an event that never gets deleted (resent forever) or, worse, the
// wrong record deleted.

describe('event identity', () => {
  it('stamps <browser>.<session>.<seq>, and the parts agree with the composite', () => {
    const e = { event: 'ADD' };
    util.timestampEvent(e);
    const m = e.metadata;

    expect(m.eventId).toBe(`${m.browserTag}.${m.sessionTag}.${m.sessionSeq}`);
    expect(typeof m.sessionSeq).toBe('number');
  });

  it('the sequence advances per event, and the session tag does not', () => {
    const a = { event: 'A' }; const b = { event: 'B' };
    util.timestampEvent(a);
    util.timestampEvent(b);

    expect(b.metadata.sessionSeq).toBe(a.metadata.sessionSeq + 1);
    expect(b.metadata.sessionTag).toBe(a.metadata.sessionTag);
    expect(b.metadata.eventId).not.toBe(a.metadata.eventId);
  });

  it('identity survives verboseEvents being off — it is not a debug extra', () => {
    // Turning off verbose logging must not turn off the ack protocol's ability
    // to name an event. Identity used to live inside this flag.
    util.setVerboseEvents(false);
    try {
      const e = { event: 'QUIET' };
      util.timestampEvent(e);
      expect(e.metadata.eventId).toBeTruthy();
      expect(e.metadata.human_ts).toBeUndefined();   // verbose extras gone
    } finally {
      util.setVerboseEvents(true);
    }
  });
});

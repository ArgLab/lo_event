/*
 * Test of basic functionality. This uses the redux logger, primarily.
 */

import { describe, it, expect } from 'vitest';
import * as loEvent from '../src/loEvent.js';
import * as reduxLogger from '../src/reduxLogger.js';
import { consoleLogger } from '../src/consoleLogger.js';
import * as debug from '../src/debugLog.js';
import { getBrowserInfo } from '../src/metadata/browserinfo.js';
import * as disabler from '../src/disabler.js';

const rl = reduxLogger.reduxLogger();

loEvent.init(
  'org.ets.lo_event.test',
  '1',
  [consoleLogger(), rl],
  {
    debugLevel: debug.LEVEL.SIMPLE,
    debugDest: [debug.LOG_OUTPUT.LOGGER(loEvent.logEvent)]
  }
);
loEvent.lockFields([{ preauth_type: 'test' }]);
loEvent.lockFields([{ postauth_type: 'test' }, getBrowserInfo()]);
loEvent.go();

loEvent.logEvent('test', { event_number: 1 });
loEvent.logEvent('test', { event_number: 2 });
loEvent.logEvent('test', { event_number: 3 });

describe('loEvent testing', () => {
  it('Check basic event handling', async () => {
    // TODO revisit why we need this additional awaitEvent call.
    // Spent some time poking, but didn't fully understand the
    // why so I'm leaving it as is now.
    // Are events coming in in the right order?
    expect((await reduxLogger.awaitEvent()).event_number).toBe(1);
    expect((await reduxLogger.awaitEvent()).event_number).toBe(2);
    const event3 = await reduxLogger.awaitEvent();
    expect(event3.event_number).toBe(3);
    // Are metadata being sent?
    const fields = rl.getLockFields();
    expect(fields).toBeDefined();
    expect(fields.source).toBe('org.ets.lo_event.test');
    expect(fields.version).toBe('1');
    expect(fields.preauth_type).toBe('test');
  });

  it('rejects application use of protocol-reserved frame names', () => {
    expect(() => loEvent.logEvent('lock_fields', {})).toThrow(/reserved/);
    expect(() => loEvent.logEvent('fetch_blob', {})).toThrow(/reserved/);
  });

  it('moves events through the front desk while transmission is blocked', async () => {
    disabler.handleBlockError(new disabler.BlockError(
      'retain locally',
      'PERMANENT',
      'MAINTAIN'
    ));
    loEvent.logEvent('blocked-admission', { marker: 99 });

    let received;
    do {
      received = await reduxLogger.awaitEvent();
    } while (received.event !== 'blocked-admission');
    expect(received.marker).toBe(99);
  });
});

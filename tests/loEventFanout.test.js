// The front desk's two contracts with the loggers, neither of which is visible
// from a logger's own tests: it tells them who the application is (so a durable
// logger can namespace its store — §2), and one logger throwing must not cost
// its siblings their copy of the event.
//
// Its own file because lo_event's init state is module-global: a second init()
// in a file would reach back into the tests declared before it.

import { describe, it, expect, vi } from 'vitest';
import * as loEvent from '../src/loEvent.js';

describe('loEvent fan-out', () => {
  it('configures each logger with the application identity, and isolates a thrower', async () => {
    const identities = [];
    const received = [];
    const broken = Object.assign(() => { throw new Error('expected logger failure'); },
      { lo_id: 'broken' });
    const healthy = Object.assign((event) => { received.push(JSON.parse(event)); }, {
      lo_id: 'healthy',
      configure: (identity) => { identities.push(identity); }
    });

    // `broken` is first, so the fan-out has to survive it to reach `healthy`.
    loEvent.init('fanout-test', '2', [broken, healthy], { useDisabler: false });
    loEvent.go();
    loEvent.logEvent('answer', { value: 42 });

    await vi.waitFor(() => {
      expect(received.some(event => event.event === 'answer')).toBe(true);
    });
    expect(identities).toEqual([{ source: 'fanout-test', version: '2' }]);
  });
});

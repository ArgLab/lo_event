import { describe, expect, it, vi } from 'vitest';
import * as loEvent from '../src/loEvent.js';

describe('loEvent front desk', () => {
  it('configures application identity and isolates throwing sibling loggers', async () => {
    const contexts = [];
    const received = [];
    const broken = Object.assign(() => { throw new Error('expected logger failure'); }, {
      lo_id: 'broken'
    });
    const healthy = Object.assign(event => { received.push(JSON.parse(event)); }, {
      configure: context => { contexts.push(context); },
      lo_id: 'healthy'
    });

    loEvent.init('fanout-test', '1', [broken, healthy], { useDisabler: false });
    loEvent.go();
    loEvent.logEvent('answer', { value: 42 });

    await vi.waitFor(() => {
      expect(received.some(event => event.event === 'answer')).toBe(true);
    });
    expect(contexts).toEqual([{ source: 'fanout-test' }]);
  });
});

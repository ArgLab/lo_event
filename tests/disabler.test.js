// The disabler's block state, and the one question everything else asks it.
//
// `retry()` is a sleep, and blocks can change while it sleeps: the server can
// extend one, or upgrade it to permanent. A sleep that started under the old
// deadline must not clear the newer block when it wakes — the client would
// resume sending straight through a block the server had just extended.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as disabler from '../src/disabler.js';

const block = (timeLimit, action) => new disabler.BlockError('test block', timeLimit, action);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  // Leave the module unblocked for the next test: the state is global.
  disabler.handleBlockError(block(0, 'TRANSMIT'));
  await disabler.retry();
  vi.useRealTimers();
});

describe('currentMode — one predicate for "what kind of block is this?"', () => {
  it('separates a permanent hold from a permanent opt-out', () => {
    disabler.handleBlockError(block('PERMANENT', 'MAINTAIN'));
    expect(disabler.currentMode()).toBe('permanent');
    expect(disabler.storeEvents()).toBe(true);      // keep holding the work

    disabler.handleBlockError(block('PERMANENT', 'DROP'));
    expect(disabler.currentMode()).toBe('opt-out');
    expect(disabler.storeEvents()).toBe(false);     // and only here, stop storing
  });

  it('reports a timed block as temporary, and no block as clear', () => {
    disabler.handleBlockError(block(60_000, 'MAINTAIN'));
    expect(disabler.currentMode()).toBe('temporary');

    disabler.handleBlockError(block(0, 'TRANSMIT'));
    expect(disabler.currentMode()).toBe('clear');
  });
});

describe('retry() re-reads the deadline it is sleeping against', () => {
  it('does not clear a block that was EXTENDED while it slept', async () => {
    disabler.handleBlockError(block(1000, 'MAINTAIN'));
    const waiting = disabler.retry();

    await vi.advanceTimersByTimeAsync(500);
    disabler.handleBlockError(block(5000, 'MAINTAIN'));   // the server extends it

    // Past the ORIGINAL deadline. A retry that snapshotted it on entry would
    // have woken here, cleared the state, and resumed sending.
    await vi.advanceTimersByTimeAsync(600);
    expect(disabler.currentMode()).toBe('temporary');

    await vi.advanceTimersByTimeAsync(5000);
    expect(await waiting).toBe(true);
    expect(disabler.currentMode()).toBe('clear');
  });

  it('reports a block UPGRADED to permanent while it slept', async () => {
    disabler.handleBlockError(block(1000, 'MAINTAIN'));
    const waiting = disabler.retry();

    await vi.advanceTimersByTimeAsync(500);
    disabler.handleBlockError(block('PERMANENT', 'MAINTAIN'));

    await vi.advanceTimersByTimeAsync(2000);
    expect(await waiting).toBe(false);              // never resume on your own
    expect(disabler.currentMode()).toBe('permanent');
  });

  it('returns immediately when nothing is blocking', async () => {
    expect(await disabler.retry()).toBe(true);
  });

  it('refuses to wait out a permanent block at all', async () => {
    disabler.handleBlockError(block('PERMANENT', 'DROP'));
    expect(await disabler.retry()).toBe(false);
  });
});

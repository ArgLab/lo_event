import type { Logger } from './types.js';

export function nullLogger (): Logger { return (() => null) as Logger; }

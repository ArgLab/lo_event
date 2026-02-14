/**
 * The debugLog handles formatting and routing debug statements to
 * different logging outputs.
 */

export type LogDestination = (messageType: string, message: string | undefined, stackTrace?: string) => void;

/**
 * Returns a function that will route debugLog events
 * through the `sendEvent` function. This is typically used
 * for sending events through to the current `lo_event` loggers.
 * Events are transmitted when the count of a specific event
 * type reaches a power of 10.
 */
function sendEventToLogger (sendEvent: (eventType: string, payload: object) => void): LogDestination {
  const counts: { [messageType: string]: number } = {};
  return function (messageType, message, stackTrace) {
    if (!Object.prototype.hasOwnProperty.call(counts, messageType)) {
      counts[messageType] = 0;
    }
    counts[messageType]++;
    // we confirmed that `Math.log10` does not produce any rounding errors on
    // Firefox and Chrome, but gives exact integer answers for powers of 10
    if (Math.log10(counts[messageType]) % 1 === 0) {
      const payload: { message_type: string; message: string | undefined; count: number; stack?: string } = { message_type: messageType, message, count: counts[messageType] };
      if (stackTrace) {
        payload.stack = stackTrace;
      }
      sendEvent('debug', payload);
    }
  };
}

/**
 * Send debugLog event to the browser console
 */
function sendToConsole (messageType: string, message: string | undefined, stackTrace?: string) {
  const stackOutput = stackTrace ? `\n  Stacktrace: ${stackTrace}` : '';
  console.log(`${messageType}, ${message} ${stackOutput}`);
}

/**
 * LOG_OUTPUT refer to where we route debug events
 * `CONSOLE`: routes events to the browser console
 * `LOGGER`: routes events to standard `lo_event` pipeline
 */
export const LOG_OUTPUT = {
  CONSOLE: sendToConsole,
  LOGGER: sendEventToLogger
} as const;

/**
 * LEVEL corresponds to how much information we include when we log something
 * `none`: does not log any information
 * `simple`: logs the data as is
 * `extended`: logs the data in conjuction with timestamp and stack trace
 */
export const LEVEL = {
  NONE: 'none',
  SIMPLE: 'simple',
  EXTENDED: 'extended'
} as const;

let debugLevel: string = LEVEL.SIMPLE;

let debugLogOutputs: LogDestination[] = [LOG_OUTPUT.CONSOLE];

export function setLevel (level: string) {
  if (![LEVEL.NONE, LEVEL.SIMPLE, LEVEL.EXTENDED].includes(level as typeof LEVEL[keyof typeof LEVEL])) {
    throw new Error(`Invalid debug log type ${level}`);
  }
  debugLevel = level;
}

export function setLogOutputs (outputs: LogDestination[]) {
  debugLogOutputs = outputs;
}

export function info (log: string, stack?: string) {
  const formattedLog = formatLog(log);
  for (const logDestination of debugLogOutputs) {
    logDestination('info', formattedLog, stack);
  }
}

export function error (log: string, error?: unknown) {
  const formattedLog = formatLog(log);
  const err = error as { name?: string; stack?: string } | undefined;
  const errorString = (typeof error === 'string' ? error : (err?.name ?? 'Error'));
  for (const logDestination of debugLogOutputs) {
    logDestination(errorString, formattedLog, err?.stack);
  }
}

/**
 * Format text of debugLog event based on our current LEVEL
 */
function formatLog (text: string) {
  if (debugLevel === LEVEL.NONE) {
    return undefined;
  } else if (debugLevel === LEVEL.SIMPLE) {
    return text;
  } else if (debugLevel === LEVEL.EXTENDED) {
    const stackTrace = getStackTrace();
    const time = new Date().toISOString();
    return `${time}: ${text}\n${stackTrace.padEnd(60)}`;
  }
  return text;
}

// helper function for generating a stack trace to use with `LEVEL.EXTENDED`
function getStackTrace () {
  const stack = new Error().stack?.split('\n') ?? [];
  return [stack[2], stack[3], stack[4], stack[5], stack[6]].join('\n');
}

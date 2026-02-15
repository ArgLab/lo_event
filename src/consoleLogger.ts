import type { Logger } from './types.js';

export function consoleLogger (): Logger {
  /*
  Log to browser JavaScript console
  */
  const logger = function (event: string) {
    console.log(event);
  } as Logger;
  logger.init = function () { console.log('Initializing console logger!'); };
  logger.setField = function (metadata: string) { console.log('setField:', metadata); };
  logger.lo_name = 'Console Logger';

  return logger;
}

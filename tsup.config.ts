import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    loEvent: 'src/loEvent.ts',
    queue: 'src/queue.ts',
    debugLog: 'src/debugLog.ts',
    consoleLogger: 'src/consoleLogger.ts',
    nullLogger: 'src/nullLogger.ts',
    websocketLogger: 'src/websocketLogger.ts',
    protocol: 'src/protocol.ts',
    reduxLogger: 'src/reduxLogger.ts',
    browserEvents: 'src/browserEvents.ts',
    browserStorage: 'src/browserStorage.ts',
    disabler: 'src/disabler.ts',
    util: 'src/util.ts',
    memoryQueue: 'src/memoryQueue.ts',
    indexeddbQueue: 'src/indexeddbQueue.ts',
    types: 'src/types.ts',
    hooks: 'src/hooks.ts',
    'metadata/browserinfo': 'src/metadata/browserinfo.ts',
    'metadata/chromeauth': 'src/metadata/chromeauth.ts',
    'metadata/storage': 'src/metadata/storage.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // splitting MUST stay true: several entry points (e.g. hooks.ts) re-export
  // stateful module-level singletons from reduxLogger.ts (save status, the
  // status-listener set, the redux store). With splitting:false, tsup inlines
  // a SEPARATE copy of reduxLogger into each entry, so e.g. useSaved() in
  // hooks.js reads a different _saveStatus than the store subscription in
  // reduxLogger.js updates — the indicator gets stuck. Sharing a chunk keeps
  // those singletons singular across entry points.
  splitting: true,
  target: 'es2022',
  external: ['ws', 'redux', 'redux-thunk', 'redux-state-sync', 'lodash', 'react'],
});

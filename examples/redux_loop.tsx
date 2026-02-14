/*
 * Redux Logger Demo
 *
 * This demonstrates lo-event's Redux integration. The reduxLogger
 * wraps a Redux store so that:
 *
 * 1. Every event sent via lo_event.logEvent flows through Redux
 *    as a dispatched action.
 * 2. Application code can register reducers for specific event types
 *    to update state in response to events.
 * 3. lock_fields events update the store's lock_fields slice,
 *    accessible via reduxLogger.store.getState().
 * 4. Redux DevTools shows the full event stream for debugging.
 *
 * This is useful for applications where event logging and UI state
 * need to share the same data flow (e.g. educational activities
 * where student actions are both logged and drive the UI).
 *
 * Run with: npm run browser
 */
import { createRoot } from "react-dom/client";
import * as lo_event from '../src/loEvent.ts';
import * as reduxLogger from '../src/reduxLogger.ts';
import { consoleLogger } from '../src/consoleLogger.ts';
import * as debug from '../src/debugLog.ts';

// Create the redux logger. Events will flow through this store.
const rl = reduxLogger.reduxLogger();

// Initialize lo-event with both console and redux loggers.
// Every logEvent call will:
//   1. Print to the browser console (consoleLogger)
//   2. Dispatch through the Redux store (reduxLogger)
lo_event.init(
  'org.ets.lo_event.redux_demo',
  '0.0.1',
  [consoleLogger(), rl],
  {
    debugLevel: debug.LEVEL.SIMPLE,
    debugDest: [debug.LOG_OUTPUT.CONSOLE]
  }
);
lo_event.go();

export function App() {
  return (
    <>
      <h1>Redux Logger Demo</h1>
      <p>
        Click the button to dispatch an event through lo-event.
        Open your browser console and Redux DevTools to see
        events flowing through.
      </p>
      <button onClick={() => lo_event.logEvent('click', { target: 'demo_button' })}>
        Log Event
      </button>
    </>
  );
}

const container = document.getElementById("app");
const root = createRoot(container!);
root.render(<App />);

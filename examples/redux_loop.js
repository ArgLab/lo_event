import { createRoot } from "react-dom/client";
import * as lo_event from '../src/loEvent.js';
import * as reduxLogger from '../src/reduxLogger.js';
import { consoleLogger } from '../src/consoleLogger.js';
import * as debug from '../src/debugLog.js';

const rl = reduxLogger.reduxLogger();

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
      <h1>Hello world!!</h1>
      <p>This demos the redux logger integration with lo_event.</p>
      <button onClick={() => lo_event.logEvent('click', { target: 'demo_button' })}>
        Log Event
      </button>
    </>
  );
}

const container = document.getElementById("app");
const root = createRoot(container);
root.render(<App />);

# Learning Observer Event Library

This is a module used to stream events into the Learning Observer (and, in the future, potentially other Learning Record Stores). This is in development. The requirements are:

- We would like to be able to stream events with multiple loggers.
  - In most cases, in practice, we use a websocket logger, with a persistent connection.
  - For occasional events, we support AJAX logging.
  - In addition, for ease-of-debugging, we can print events to the console
  - We are beginning to support a workflow with `react` integration, which provides for very good observability
- We follow the general format used in Caliper, xAPI, and Open edX of one JSON object per event
- We use a free-form JSON format, but encourage following Caliper / xAPI guidelines where convenient
- We currently support JavaScript, but would like to support other languages in the future

Examples of places where we intentionally diverge from standards:

- Good events are like onions -- they have layers. We don't assume we can e.g. trust timestamps or authentication from the system generating events, or that we will have all context up-front. Systems can add timestamps, authentication, and similar, much like e.g. SMTP messages being passed between systems.
- We do need to have a header for metadata + authentication
- We'd like to be at least sensitive to bandwidth. It's not worth resending data with each event that can be in a header or in update events. A lot of standards have large, cumbersome events (which are not human-friendly, and expensive to store and process)
- We're a lot more freeform in what we send and accept, since learning contexts can be pretty rich (and technology evolves) in ways which standards don't always keep up with.

Our goal is to simplify compatibility and to maintain compliance where reasonable, but to be more flexible than strict compliance with xAPI or Caliper.

## Installation

```bash
npm install
```

To use in a separate node project:

```bash
npm install
npm link
```

Then from the other project:

```bash
npm link lo-event
```

*Note:* you may need to rerun `npm link lo-event` after you run `npm install` at the target location.

If this runs into issues, a more robust way is to run `npm pack` to create a tarball npm package, and then to `npm install` that package. This has the downside of requiring a reinstall on every change, which is somewhat cumbersome.

## Usage

```js
import * as lo_event from 'lo-event';
import { consoleLogger } from 'lo-event/console';
import { websocketLogger } from 'lo-event/websocket';
import { reduxLogger } from 'lo-event/redux';
import * as debug from 'lo-event/debug';
import { subscribeToEvents } from 'lo-event/browser-events';
import * as util from 'lo-event/util';
```

## Exports

| Specifier | Module |
|---|---|
| `lo-event` | Main entry point (`loEvent.js`) |
| `lo-event/redux` | Redux logger integration |
| `lo-event/debug` | Debug logging utilities |
| `lo-event/console` | Console logger |
| `lo-event/websocket` | WebSocket logger |
| `lo-event/browser-events` | Browser event capture |
| `lo-event/queue` | Event queue |
| `lo-event/storage` | Browser storage abstraction |
| `lo-event/disabler` | Opt-in/opt-out handling |
| `lo-event/util` | Utility functions |
| `lo-event/null` | Null logger (no-op) |

## Examples

The `examples/` directory has interactive browser demos:

- **Browser Events** (`browser_events.html`) — Captures keystrokes, mouse, clipboard, and other DOM events using `subscribeToEvents`. Shows how metadata collectors work.
- **Redux Loop** (`redux_loop.html`) — Demonstrates the Redux logger, where events flow through a Redux store so application state and event logging share one data flow.

To run them:

```bash
npm run browser
```

This starts a Parcel dev server and opens the example index page.

## Testing

```bash
npm test
```

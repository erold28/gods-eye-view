/**
 * The map window's side of the /api/live relay (server/live/relay.js).
 *
 * Commands from the control panel or a chat bridge arrive as Server-Sent
 * Events and run against the live API; the map's state is posted back after
 * every change and once a second, so the panel's countdown stays current.
 * The browser's EventSource reconnects on its own after a server restart.
 */

const BASE = '/api/live';
const PUBLISH_EVERY_MS = 1000;

/**
 * Run one relayed command. `add` is a request typed in the panel: the place
 * becomes an "!ir" comment so aliases and the public-place filter apply, and
 * it is marked as the operator's. `flyNow` flies there outside the line.
 * `submit` is a viewer's chat comment.
 */
export function runLiveCommand(api, command) {
  switch (command?.type) {
    case 'add':
      return api.submit(
        { user: command.user, text: `!ir ${command.place}` },
        { operator: true, source: 'panel' },
      );
    case 'flyNow':
      return api.flyNow(command.place);
    case 'submit':
      return api.submit(
        { user: command.user, text: command.text },
        { source: 'chat' },
      );
    case 'remove':
    case 'promote':
      return api[command.type](command.id);
    case 'next':
    case 'skip':
    case 'extend':
    case 'toggleFlights':
    case 'pause':
    case 'resume':
    case 'togglePause':
    case 'clearLine':
    case 'clear':
      return api[command.type]();
    default:
      return undefined;
  }
}

/**
 * Connect the map to the relay. `getState()` returns what the panel shows.
 * @returns {{ publish: () => void, close: () => void }}
 */
export function connectLiveRelay({
  api,
  getState,
  EventSourceImpl = globalThis.EventSource,
  fetchImpl = (...args) => globalThis.fetch(...args),
  publishEveryMs = PUBLISH_EVERY_MS,
}) {
  if (typeof EventSourceImpl !== 'function')
    return { publish() {}, close() {} };
  const events = new EventSourceImpl(`${BASE}/events?role=map`);
  events.addEventListener('command', (event) => {
    let command;
    try {
      command = JSON.parse(event.data);
    } catch {
      return;
    }
    Promise.resolve(runLiveCommand(api, command)).catch((error) =>
      console.warn('[Live] Command failed:', error),
    );
  });

  // One post in flight at a time; changes during it send once more after.
  let sending = false;
  let dirty = false;
  let closed = false;
  const publish = () => {
    if (closed) return;
    if (sending) {
      dirty = true;
      return;
    }
    sending = true;
    dirty = false;
    Promise.resolve()
      .then(() =>
        fetchImpl(`${BASE}/state`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(getState()),
        }),
      )
      .catch(() => {
        // The relay is optional: the map keeps working without a panel.
      })
      .finally(() => {
        sending = false;
        if (dirty) publish();
      });
  };
  // Publish once the stream opens too, so a panel sees a reloaded map at once.
  events.addEventListener('open', publish);
  const timer = setInterval(publish, publishEveryMs);

  return {
    publish,
    close() {
      closed = true;
      clearInterval(timer);
      events.close();
    },
  };
}

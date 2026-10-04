import { LIVE_CONFIG } from '../config.js';
import {
  formatClock,
  formatTime,
  normalizeUser,
  placeWithCountry,
  rejectionText,
  remainingNow,
  shortcutFor,
  sourceText,
  tiktokStatus,
} from './panelModel.js';

/**
 * The live control panel (/live-control): opened in its own window, never on
 * stream. It reads the map's state from the /api/live relay and sends it
 * commands. Every viewer-written string is set with textContent.
 */

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const ui = {
  connection: $('connection'),
  tiktok: $('tiktok-status'),
  paused: $('paused-badge'),
  nowLabel: $('now-label'),
  nowPlace: $('now-place'),
  nowDetail: $('now-detail'),
  pauseButton: $('pause-button'),
  extendButton: $('extend-button'),
  flightsButton: $('flights-button'),
  form: $('add-form'),
  user: $('user-input'),
  place: $('place-input'),
  flyButton: $('fly-button'),
  feedback: $('feedback'),
  line: $('line'),
  lineCount: $('line-count'),
  lineEmpty: $('line-empty'),
  clearLine: $('clear-line-button'),
  rejected: $('rejected'),
  rejectedEmpty: $('rejected-empty'),
};

ui.extendButton.firstChild.textContent = `⏱ +${LIVE_CONFIG.extendSeconds} s `;
ui.extendButton.title = `Extender la ciudad en pantalla ${LIVE_CONFIG.extendSeconds} s`;

let mapConnected = false;
let mapWindows = 0;
let state = null;

async function send(command) {
  try {
    const response = await fetch('/api/live/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (response.status === 409) {
      say('El mapa no está abierto: abre la ventana del mapa primero.');
      return false;
    }
    if (!response.ok) {
      say(`No se pudo enviar (${response.status}).`);
      return false;
    }
    return true;
  } catch {
    say('Sin conexión con el servidor. ¿Está abierta la ventana del servidor?');
    return false;
  }
}

function say(message) {
  ui.feedback.textContent = message;
}

// Controles y atajos ---------------------------------------------------------

for (const button of document.querySelectorAll('[data-command]'))
  button.addEventListener('click', () =>
    send({ type: button.dataset.command }),
  );

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.activeElement !== document.body) {
    document.activeElement.blur();
    return;
  }
  const command = shortcutFor(event);
  if (!command || !mapConnected) return;
  event.preventDefault();
  send({ type: command });
});

// Agregar y volar ------------------------------------------------------------

function readForm() {
  return { user: normalizeUser(ui.user.value), place: ui.place.value.trim() };
}

/**
 * Clear the fields at once, before the request is answered, so the next
 * viewer can be typed straight away. Returns a function that puts the
 * values back if sending fails, unless something new was typed meanwhile.
 */
function takeForm() {
  const typed = { user: ui.user.value, place: ui.place.value };
  ui.user.value = '';
  ui.place.value = '';
  ui.user.focus();
  return () => {
    if (ui.user.value || ui.place.value) return;
    ui.user.value = typed.user;
    ui.place.value = typed.place;
    ui.place.focus();
  };
}

async function addToLine() {
  const { user, place } = readForm();
  if (!place) {
    ui.place.focus();
    return;
  }
  const restore = takeForm();
  if (await send({ type: 'add', user, place }))
    say(`Enviado: ${place} — ${user || LIVE_CONFIG.operatorName}`);
  else restore();
}

async function flyNow() {
  const { place } = readForm();
  if (!place) {
    ui.place.focus();
    return;
  }
  const restore = takeForm();
  if (await send({ type: 'flyNow', place }))
    say(
      `Volando a ${place} sin cartel. La fila queda en pausa: P para continuar.`,
    );
  else restore();
}

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  addToLine();
});

// Enter in Usuario with no city yet moves on to Ciudad instead of sending.
ui.user.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !ui.place.value.trim()) {
    event.preventDefault();
    ui.place.focus();
  }
});

ui.place.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault();
    flyNow();
  }
});

ui.flyButton.addEventListener('click', flyNow);

ui.clearLine.addEventListener('click', () => {
  const count = state?.upcoming?.length || 0;
  if (!count) return;
  const plural = count === 1 ? 'pedido' : 'pedidos';
  if (
    window.confirm(
      `¿Seguro que quieres vaciar la fila?\nSe borrarán ${count} ${plural}. La ciudad en pantalla se queda.`,
    )
  )
    send({ type: 'clearLine' });
});

// Fila y rechazados ----------------------------------------------------------

function renderLine(upcoming) {
  ui.lineCount.textContent = `(${upcoming.length})`;
  ui.lineEmpty.hidden = upcoming.length > 0;
  ui.clearLine.disabled = !mapConnected || upcoming.length === 0;
  ui.line.replaceChildren(
    ...upcoming.map((request, index) => {
      const pending = request.status === 'pending';
      const row = el('li');
      row.dataset.status = request.status || 'ready';
      const place = el('span', 'panel__place', placeWithCountry(request));
      place.append(el('span', 'panel__user', request.user));
      const promote = el('button', '', '⬆ 1º');
      promote.title = 'Subir al primer lugar';
      promote.disabled = !mapConnected || index === 0;
      promote.addEventListener('click', () =>
        send({ type: 'promote', id: request.id }),
      );
      const remove = el('button', 'panel__danger', '✕ Borrar');
      remove.disabled = !mapConnected;
      remove.addEventListener('click', () =>
        send({ type: 'remove', id: request.id }),
      );
      row.append(
        el('span', 'panel__pos', String(index + 1)),
        place,
        el('span', 'panel__state', pending ? 'buscando…' : 'listo'),
        promote,
        remove,
      );
      return row;
    }),
  );
}

function renderRejected(rejected) {
  ui.rejectedEmpty.hidden = rejected.length > 0;
  ui.rejected.replaceChildren(
    ...rejected.map((entry) => {
      const row = el('li');
      const who = entry.user
        ? normalizeUser(entry.user)
        : LIVE_CONFIG.operatorName;
      row.append(
        el('span', 'panel__time', formatTime(entry.at)),
        el(
          'span',
          'panel__said',
          `${who} · ${sourceText(entry.source)} · “${entry.text}”`,
        ),
        el('span', 'panel__reason', `rechazado: ${rejectionText(entry)}`),
      );
      return row;
    }),
  );
}

function renderNow() {
  const paused = Boolean(state?.paused);
  ui.paused.hidden = !paused;
  ui.pauseButton.firstChild.textContent = paused ? '▶ Continuar ' : '⏸ Pausa ';
  const current = state?.current;
  if (state?.freeFlight) {
    ui.nowLabel.textContent = 'VUELO LIBRE (SIN CARTEL)';
    ui.nowPlace.textContent = placeWithCountry(state.freeFlight);
    ui.nowDetail.textContent = 'La fila está en pausa: pulsa P para continuar.';
  } else if (current) {
    ui.nowLabel.textContent = 'EN PANTALLA';
    ui.nowPlace.textContent = placeWithCountry(current);
    ui.nowDetail.textContent = `${current.user} — quedan ${formatClock(remainingNow(state))}${paused ? ' (en pausa)' : ''}`;
  } else {
    ui.nowLabel.textContent = 'EN PANTALLA';
    ui.nowPlace.textContent = '—';
    ui.nowDetail.textContent = mapConnected
      ? 'Esperando pedidos (modo espera).'
      : '';
  }
  ui.flightsButton.firstChild.textContent = state?.flights
    ? '✈ Aviones: SÍ '
    : '✈ Aviones: NO ';
  ui.extendButton.disabled =
    !mapConnected || !current || Boolean(state?.freeFlight);
}

function render() {
  ui.connection.dataset.online = String(mapConnected);
  ui.connection.textContent = !mapConnected
    ? 'Mapa desconectado — abre la ventana del mapa (?embed=1&live=1)'
    : mapWindows > 1
      ? `Mapa conectado — ⚠ hay ${mapWindows} ventanas del mapa abiertas: el panel controla la última que se abrió. Cierra las demás.`
      : 'Mapa conectado';
  for (const button of document.querySelectorAll('[data-command]'))
    button.disabled = !mapConnected;
  ui.flyButton.disabled = !mapConnected;
  renderNow();
  renderLine(mapConnected ? state?.upcoming || [] : []);
  renderRejected(state?.rejected || []);
}

// Conexión -------------------------------------------------------------------

const events = new EventSource('/api/live/events?role=panel');
events.addEventListener('status', (event) => {
  const status = JSON.parse(event.data);
  mapConnected = Boolean(status.mapConnected);
  mapWindows = Number(status.maps) || 0;
  const tiktok = tiktokStatus(status.tiktok);
  ui.tiktok.textContent = tiktok.text;
  ui.tiktok.dataset.online = String(tiktok.online);
  if (!mapConnected)
    state = state
      ? { ...state, current: null, upcoming: [], freeFlight: null }
      : null;
  render();
});
events.addEventListener('state', (event) => {
  state = JSON.parse(event.data);
  render();
});
events.addEventListener('error', () => {
  mapConnected = false;
  ui.connection.dataset.online = 'false';
  ui.connection.textContent = 'Sin conexión con el servidor — reintentando…';
});

// The countdown moves between the map's once-a-second updates.
setInterval(renderNow, 250);
render();
ui.user.focus();

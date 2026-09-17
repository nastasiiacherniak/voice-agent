/* Browser voice layer: mic capture, Web Speech STT, speechSynthesis TTS,
 * turn-end detection and barge-in. Swapping in Deepgram/Cartesia replaces this
 * file and nothing on the server. */

import { AgentSpeechMemory, ECHO_TAIL_MS } from './echo.js';
import { MicMonitor } from './vad.js';
// Built from composer-beams.entry.jsx by `npm run build:web` - the
// `border-beam` ring around the composer and the `voice-glow` beam that
// answers the customer's voice.
import { mountComposerBeams, setComposerBeams } from './vendor/composer-beams.js';

const $ = (id) => document.getElementById(id);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Screen-level changes - greeting to conversation, opening the microphone,
 * revealing the state panel - move things that CSS cannot transition:
 * justify-content, and elements entering or leaving the flow. The View
 * Transitions API tweens between the two layouts instead of cutting.
 */
function withTransition(update) {
  if (reducedMotion.matches || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  document.startViewTransition(update);
}

const ui = {
  micBtn: $('mic-btn'),
  micLabel: $('mic-label'),
  statusLive: $('status-live'),
  transcript: $('transcript'),
  unsupported: $('unsupported'),
  typeForm: $('type-form'),
  typeInput: $('type-input'),
  sendBtn: $('send-btn'),
  stockBody: document.querySelector('#stock-table tbody'),
  resBody: document.querySelector('#res-table tbody'),
  toolLog: $('tool-log'),
  stateName: $('state-name'),
  heldLine: $('held-line'),
  bookingCard: $('booking-card'),
  bookingBody: $('booking-body'),
  latencyPill: $('latency-pill'),
  resetBtn: $('reset-btn'),
  panelBtn: $('panel-btn'),
  panelBtnLabel: $('panel-btn-label'),
};

let ws = null;
let vadSilenceMs = 600;
let listening = false;
let agentSpeaking = false;

// ---------------------------------------------------------------- transport

/* The socket drops for ordinary reasons - the dev server restarts, a laptop
 * sleeps, a proxy times out an idle connection. Telling the customer to reload
 * is not a design; reconnect, and while disconnected refuse to accept turns
 * rather than draw them into the transcript and silently discard them. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const KEEPALIVE_MS = 25000;

let reconnectAttempts = 0;
let reconnectTimer = null;
let keepaliveTimer = null;
let hasConnected = false;
let announcedDisconnect = false;
let wasListeningBeforeDrop = false;

/* The GitHub Pages build has no server to talk to, so it runs the same
 * Session in the page (src/browser/demo.ts) and hands us a socket-shaped
 * object in place of a WebSocket. The protocol across it is identical, which
 * is why this is the only branch in the file. */
const demoReady = window.__voiceBookingDemo ?? null;
let demo = null;

async function openSocket() {
  if (!demoReady) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return new WebSocket(`${proto}://${location.host}/ws`);
  }
  demo = await demoReady;
  return demo.connect();
}

async function connect() {
  clearTimeout(reconnectTimer);
  ws = await openSocket();

  ws.onopen = () => {
    reconnectAttempts = 0;
    setConnectionState('connected');
    // Clock sync, then a keepalive so an idle proxy does not close us.
    for (let i = 0; i < 5; i++) {
      setTimeout(() => send({ type: 'ping', t: Date.now() }), i * 120);
    }
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), KEEPALIVE_MS);

    if (hasConnected) {
      // The server builds a fresh Session per socket, so the conversation
      // starts over. Say so rather than let the agent seem to forget.
      addTurn('system', 'reconnected - starting a new conversation');
      agentBubble = null;
      turnAudioReported = new Set();
      if (wasListeningBeforeDrop) startListening();
    }
    hasConnected = true;
    wasListeningBeforeDrop = false;
  };

  ws.onclose = () => {
    clearInterval(keepaliveTimer);
    setConnectionState('reconnecting');
    if (listening) {
      wasListeningBeforeDrop = true;
      stopListening();
    }
    hardStopSpeech(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose always follows; the retry is driven from there */
  };

  ws.onmessage = (ev) => onServerMessage(JSON.parse(ev.data));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(connect, delay);
}

/** The arrow is live only when connected and the box has something in it. */
function updateSendEnabled() {
  ui.sendBtn.disabled = !isConnected() || ui.typeInput.value.trim() === '';
}

function isConnected() {
  return ws != null && ws.readyState === WebSocket.OPEN;
}

/** @returns false when the message could not be delivered. */
function send(msg) {
  if (!isConnected()) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function setConnectionState(state) {
  const disabled = state !== 'connected';
  ui.micBtn.disabled = disabled;
  ui.typeInput.disabled = disabled;
  updateSendEnabled();

  if (state === 'connected') {
    announcedDisconnect = false;
    return;
  }
  // A dropped socket has to be visible somewhere, or the desk just looks dead.
  // It goes in the transcript now that the panel no longer carries a status line.
  if (state === 'reconnecting' && !announcedDisconnect) {
    announcedDisconnect = true;
    addTurn('system', 'connection lost - reconnecting...');
  }
}

function onServerMessage(msg) {
  switch (msg.type) {
    case 'ready':
      vadSilenceMs = msg.vad_silence_ms ?? 600;
      // The session line is gone from the panel; keep the detail reachable in
      // the console rather than dropping it entirely.
      console.info(
        `session ${msg.session_id} - driver ${msg.driver}` +
          (msg.model && msg.model !== 'none' ? ` (${msg.model})` : '') +
          ` - end-of-turn silence ${vadSilenceMs} ms`,
      );
      break;
    case 'pong':
      send({
        type: 'clock_sample',
        client_sent: msg.client_sent,
        server_time: msg.server_time,
        client_received: Date.now(),
      });
      break;
    case 'speak':
      enqueueSpeech(msg.text, msg.turn_id);
      break;
    case 'stop_audio':
      hardStopSpeech(true);
      break;
    case 'agent_done':
      if (!speechQueue.length && !agentSpeaking) setMode(listening ? 'listening' : 'idle');
      break;
    case 'state':
      renderState(msg.payload);
      break;
    case 'error':
      addTurn('system', `error: ${msg.message}`);
      break;
  }
}

// -------------------------------------------------------------------- speech

const synth = window.speechSynthesis;
let speechQueue = [];
let currentUtterance = null;
let turnAudioReported = new Set();
let lastSpeechEndAt = null;

/* Echo rejection. The microphone hears the agent's own voice through the
 * speakers, and the recogniser transcribes it as if the customer had spoken.
 * Three things are needed to stop that reliably:
 *   - a record of what the agent said recently, not just the sentence in
 *     flight, because echo also arrives between sentences and after the last;
 *   - a window that stays open past the end of playback, for the speaker tail
 *     and the recogniser's own lag;
 *   - a word-overlap test rather than an exact substring, because STT drops
 *     punctuation and mishears words. */
const agentSpeech = new AgentSpeechMemory();
let agentAudioUntil = 0;

/**
 * The recogniser is switched off while the agent speaks, so its microphone
 * never captures the speaker in the first place. Barge-in comes instead from
 * micMonitor, which listens on an echo-cancelled stream.
 */
let suspendedForPlayback = false;
let resumeTimer = null;

const micMonitor = new MicMonitor({ onSpeech: onBargeInDetected });

/** Playback is audible, queued, or recently finished. */
function isAgentAudible() {
  return agentSpeaking || speechQueue.length > 0 || Date.now() < agentAudioUntil;
}

/**
 * Agent audio is starting. Abort the recogniser rather than try to filter what
 * it hears: Chrome returns final results seconds late, so echo captured now
 * would arrive long after any "is the agent talking" window had closed.
 */
function suspendForPlayback() {
  if (suspendedForPlayback) return;
  suspendedForPlayback = true;
  clearTimeout(resumeTimer);
  discardHeard();
  abortRecognition();
  if (micMonitor.available) micMonitor.arm();
}

/** Playback finished on its own. Let the speaker tail decay, then listen again. */
function scheduleResume() {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    suspendedForPlayback = false;
    micMonitor.disarm();
    discardHeard();
    startRecognition();
  }, ECHO_TAIL_MS);
}

/** The customer spoke over the agent, on the echo-cancelled stream. */
function onBargeInDetected() {
  if (!listening || !isAgentAudible()) return;
  hardStopSpeech(true);
  send({ type: 'barge_in', partial: '' });
  clearTimeout(resumeTimer);
  suspendedForPlayback = false;
  micMonitor.disarm();
  discardHeard();
  startRecognition();
  setMode('listening');
}

function pickVoice() {
  const voices = synth.getVoices();
  return (
    voices.find((v) => /^en[-_]GB/i.test(v.lang) && /female|zira|hazel|sonia/i.test(v.name)) ||
    voices.find((v) => /^en[-_]/i.test(v.lang)) ||
    voices[0] ||
    null
  );
}

function enqueueSpeech(text, turnId) {
  const item = { text, turnId, shown: false };
  speechQueue.push(item);
  // Some browsers have no voices installed, or block audio until a gesture.
  // The customer must still be able to read the answer.
  item.fallback = setTimeout(() => {
    if (!item.shown) {
      item.shown = true;
      appendAgentText(text, turnId);
    }
  }, 1500);
  drainSpeech();
}

function drainSpeech() {
  if (agentSpeaking || speechQueue.length === 0) return;
  const item = speechQueue.shift();

  const u = new SpeechSynthesisUtterance(item.text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.05;
  u.pitch = 1;

  u.onstart = () => {
    agentSpeaking = true;
    agentAudioUntil = Date.now() + ECHO_TAIL_MS;
    agentSpeech.remember(item.text);
    suspendForPlayback();
    setMode('speaking');
    // The transcript only shows what was actually spoken aloud, so an
    // interrupted sentence never appears as if the customer heard it.
    clearTimeout(item.fallback);
    if (!item.shown) {
      item.shown = true;
      appendAgentText(item.text, item.turnId);
    }

    if (!turnAudioReported.has(item.turnId)) {
      turnAudioReported.add(item.turnId);
      const t = Date.now();
      send({ type: 'audio_first_frame', turn_id: item.turnId, t_client: t });
      if (lastSpeechEndAt != null) {
        ui.latencyPill.textContent = `first answer: ${t - lastSpeechEndAt} ms`;
      }
    }
  };
  u.onend = () => {
    agentSpeaking = false;
    currentUtterance = null;
    agentAudioUntil = Date.now() + ECHO_TAIL_MS;
    if (speechQueue.length) drainSpeech();
    else {
      setMode(listening ? 'listening' : 'idle');
      scheduleResume();
    }
  };
  u.onerror = () => {
    agentSpeaking = false;
    currentUtterance = null;
    if (speechQueue.length) drainSpeech();
    else scheduleResume();
  };

  currentUtterance = u;
  synth.speak(u);
}

/** Barge-in: stop within one audio callback and drop everything queued. */
function hardStopSpeech(markInterrupted) {
  const hadPending = agentSpeaking || speechQueue.length > 0;
  for (const q of speechQueue) clearTimeout(q.fallback);
  speechQueue = [];
  // Audio is cancelled, so stop treating what follows as possible echo.
  agentAudioUntil = 0;
  clearTimeout(resumeTimer);
  currentUtterance = null;
  agentSpeaking = false;
  try {
    synth.cancel();
  } catch {
    /* ignore */
  }
  if (markInterrupted && hadPending) {
    const last = ui.transcript.querySelector('.turn.agent:last-child');
    if (last) last.classList.add('interrupted');
    addTurn('system', 'interrupted');
  }
}

// ----------------------------------------------------------------------- STT

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognitionRunning = false;
let finalBuffer = '';
let interimText = '';
let silenceTimer = null;
let lastVoiceAt = null;
let partialNode = null;

if (!SR) ui.unsupported.hidden = false;

function buildRecognition() {
  const r = new SR();
  r.lang = 'en-GB';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = (event) => {
    // Collect only what this event added, and judge it BEFORE it is allowed to
    // touch finalBuffer. Appending first and rejecting afterwards leaves the
    // echoed words in the buffer, where they resurface as part of the next
    // real turn - which is exactly the bug this guards against.
    let newFinal = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) newFinal += `${res[0].transcript.trim()} `;
      else interim += res[0].transcript;
    }

    const candidate = `${newFinal}${interim}`.trim();
    if (!candidate) return;

    // Backstop. The recogniser is suspended during playback so this should
    // never trigger, but a final result captured just before the abort can
    // still arrive afterwards - and it is not gated on "is the agent audible"
    // precisely because that arrives late.
    if (isEcho(candidate)) return;

    finalBuffer += newFinal;
    interimText = interim.trim();
    const heard = `${finalBuffer}${interimText}`.trim();
    if (!heard) return;

    lastVoiceAt = Date.now();
    showPartial(heard);

    if (isAgentAudible()) {
      hardStopSpeech(true);
      send({ type: 'barge_in', partial: heard });
    }

    restartSilenceTimer();
  };

  r.onstart = () => {
    recognitionRunning = true;
  };

  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addTurn('system', 'microphone permission denied');
      stopListening();
    }
  };

  r.onend = () => {
    recognitionRunning = false;
    // Chrome ends the session on its own periodically. Restart it - but never
    // while the agent is speaking, or we would capture our own output again.
    if (listening && !suspendedForPlayback) startRecognition();
  };

  return r;
}

function startRecognition() {
  if (!listening || suspendedForPlayback || recognitionRunning || !recognition) return;
  try {
    recognition.start();
    recognitionRunning = true;
  } catch {
    /* already starting; onstart/onend keep the flag honest */
  }
}

/** abort(), not stop(): stop() flushes pending results, abort() discards them. */
function abortRecognition() {
  if (!recognition || !recognitionRunning) return;
  try {
    recognition.abort();
  } catch {
    /* not running */
  }
  recognitionRunning = false;
}

/** Does this look like the agent hearing itself? Scoring lives in echo.js. */
function isEcho(candidate) {
  return agentSpeech.isEcho(candidate);
}

/** Throw away part-heard speech without emitting a turn. */
function discardHeard() {
  clearTimeout(silenceTimer);
  finalBuffer = '';
  interimText = '';
  clearPartial();
}

function restartSilenceTimer() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(emitTurn, vadSilenceMs);
}

/** End of user speech: silence has lasted longer than the VAD threshold. */
function emitTurn() {
  const text = `${finalBuffer}${interimText}`.trim();
  finalBuffer = '';
  interimText = '';
  clearPartial();
  if (!text) return;

  lastSpeechEndAt = lastVoiceAt ?? Date.now();
  agentBubble = null;
  const bubble = addTurn('user', text);
  setMode('thinking');
  const sent = send({
    type: 'user_turn',
    text,
    t_speech_end: lastSpeechEndAt,
    t_stt_final: Date.now(),
    speech_duration_ms: null,
    input_mode: 'voice',
  });
  if (!sent) markUndelivered(bubble);
}

async function startListening() {
  if (!SR) return;
  if (!recognition) recognition = buildRecognition();
  listening = true;
  withTransition(() => document.body.classList.add('listening'));
  ui.micBtn.setAttribute('aria-pressed', 'true');
  ui.micLabel.textContent = 'Stop talking';
  setMode('listening');
  startRecognition();

  // Second capture, echo-cancelled, used only as an interruption detector.
  // Without it the agent still cannot hear itself - you just cannot cut in
  // by voice while it is speaking.
  try {
    await micMonitor.start();
    // The beam reads the capture we already have rather than opening a third
    // microphone of its own. It is the echo-cancelled one, so while the agent
    // speaks the glow follows the customer and not the speakers.
    setComposerBeams({ stream: micMonitor.stream, active: true });
  } catch {
    addTurn(
      'system',
      'no echo-cancelled microphone available - you can still interrupt by pressing Stop or typing',
    );
  }
}

function stopListening() {
  listening = false;
  withTransition(() => document.body.classList.remove('listening'));
  clearTimeout(silenceTimer);
  clearTimeout(resumeTimer);
  suspendedForPlayback = false;
  // Drop the stream before the tracks are stopped, so the beam never holds a
  // dead capture.
  setComposerBeams({ stream: null, active: false });
  micMonitor.stop();
  ui.micBtn.setAttribute('aria-pressed', 'false');
  ui.micLabel.textContent = 'Start talking';
  setMode('idle');
  clearPartial();
  abortRecognition();
}

// ------------------------------------------------------------------ rendering

/* The composer says what the desk is doing. There is no separate status line
 * any more: the placeholder carries it, the glow around the composer carries
 * it, and a live region says it for a screen reader - the placeholder is only
 * announced while the field has focus. */
const STATUS_TEXT = {
  idle: 'Ask anything…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
};

function setMode(next) {
  document.body.dataset.mode = next;
  ui.typeInput.placeholder = STATUS_TEXT[next] ?? STATUS_TEXT.idle;
  ui.statusLive.textContent = next === 'idle' ? '' : STATUS_TEXT[next];
  // Thinking gathers the glow into one travelling beam; it needs the effect
  // lit to be visible, so a typed turn wakes it too.
  setComposerBeams({ processing: next === 'thinking', active: listening || next === 'thinking' });
  updateRing();
}

/* The ring is an invitation to start, so it runs only on the opening screen
 * and only while the field is untouched: clicking in, opening the microphone
 * or starting a conversation all put it away. */
function updateRing() {
  const open =
    !document.body.classList.contains('has-turns') &&
    !listening &&
    !ui.typeForm.contains(document.activeElement);
  setComposerBeams({ ring: open });
}

function addTurn(kind, text) {
  // Only the first turn changes the screen; the rest just append.
  if (!document.body.classList.contains('has-turns')) {
    withTransition(() => document.body.classList.add('has-turns'));
  }
  const div = document.createElement('div');
  div.className = `turn ${kind}`;
  div.textContent = text;
  ui.transcript.appendChild(div);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  updateRing();
  return div;
}

let agentBubble = null;
let agentBubbleTurn = null;

function appendAgentText(text, turnId) {
  if (!agentBubble || agentBubbleTurn !== turnId) {
    agentBubble = addTurn('agent', text);
    agentBubbleTurn = turnId;
  } else {
    agentBubble.textContent = `${agentBubble.textContent} ${text}`;
  }
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

/** A turn the server never received. Silently dropping it is how the app
 *  ends up looking dead while the transcript fills with unanswered messages. */
function markUndelivered(bubble) {
  bubble.classList.add('undelivered');
  bubble.title = 'not sent - no connection to the server';
  setMode(listening ? 'listening' : 'idle');
  addTurn('system', 'not sent - waiting for the connection to come back');
}

function showPartial(text) {
  if (!partialNode) partialNode = addTurn('user partial', text);
  else partialNode.textContent = text;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

function clearPartial() {
  partialNode?.remove();
  partialNode = null;
}

let knownReservationIds = new Set();

function renderState(payload) {
  const { conversation, inventory, tool_calls } = payload;

  ui.stockBody.innerHTML = '';
  for (const item of inventory) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.display_name}</td>
      <td>${item.total_stock}</td>
      <td class="${cls(item.remaining_today)}">${item.remaining_today}</td>
      <td class="${cls(item.min_remaining)}">${item.min_remaining}</td>`;
    ui.stockBody.appendChild(tr);
  }

  const rows = inventory.flatMap((i) =>
    i.reservations.map((r) => ({ ...r, display_name: i.display_name })),
  );
  ui.resBody.innerHTML = '';
  if (rows.length === 0) {
    ui.resBody.innerHTML = '<tr class="empty-row"><td colspan="4">none</td></tr>';
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (!knownReservationIds.has(r.id) && knownReservationIds.size) tr.className = 'fresh';
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.display_name}</td>
      <td>${r.start_date} &rarr; ${r.end_date}</td>
      <td>${r.quantity}</td>`;
    ui.resBody.appendChild(tr);
  }
  knownReservationIds = new Set(rows.map((r) => r.id));

  ui.toolLog.innerHTML = '';
  for (const call of tool_calls) {
    const li = document.createElement('li');
    if (call.discarded) li.className = 'dropped';
    const good = ['available', 'ready', 'confirmed'].includes(call.status);
    const warn = ['needs_clarification', 'unavailable'].includes(call.status);
    li.innerHTML = `${call.name} <span class="${good ? 'ok' : warn ? 'warn' : 'no'}">${call.status}</span>`;
    ui.toolLog.appendChild(li);
  }

  ui.stateName.textContent = conversation.state;
  ui.heldLine.textContent = conversation.held
    ? ` - holding ${conversation.held.quantity} x ${conversation.held.display_name}, ${conversation.held.start_date} to ${conversation.held.end_date}`
    : '';

  if (conversation.confirmed) {
    const c = conversation.confirmed;
    ui.bookingCard.hidden = false;
    ui.bookingBody.innerHTML = `
      <dt>Reservation</dt><dd>${c.id}</dd>
      <dt>Item</dt><dd>${c.display_name}</dd>
      <dt>Dates</dt><dd>${c.spoken_range}</dd>
      <dt>Quantity</dt><dd>${c.quantity}</dd>`;
  } else {
    ui.bookingCard.hidden = true;
  }
}

function cls(n) {
  return n === 0 ? 'zero' : n === 1 ? 'low' : '';
}

// -------------------------------------------------------------------- events

ui.micBtn.addEventListener('click', () => (listening ? stopListening() : startListening()));

ui.typeInput.addEventListener('input', updateSendEnabled);
ui.typeForm.addEventListener('focusin', updateRing);
// focusout runs before the focus has actually moved, so read it a frame later.
ui.typeForm.addEventListener('focusout', () => requestAnimationFrame(updateRing));

ui.typeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ui.typeInput.value.trim();
  if (!text) return;
  ui.typeInput.value = '';
  updateSendEnabled();
  if (agentSpeaking || speechQueue.length) {
    hardStopSpeech(true);
    send({ type: 'barge_in', partial: text });
  }
  lastSpeechEndAt = Date.now();
  agentBubble = null;
  const bubble = addTurn('user', text);
  setMode('thinking');
  const sent = send({
    type: 'user_turn',
    text,
    t_speech_end: lastSpeechEndAt,
    t_stt_final: Date.now(),
    input_mode: 'typed',
  });
  if (!sent) markUndelivered(bubble);
});

/** The state panel is revealed and hidden from the navbar. */
/**
 * Deliberately not a view transition. The panel is the only thing that moves,
 * and a view transition would cross-fade the whole page root around it - which
 * reads as the page flickering or reloading. It animates itself instead.
 */
function setPanelOpen(open) {
  document.body.classList.toggle('panel-open', open);
  ui.panelBtn.setAttribute('aria-pressed', String(open));
  ui.panelBtnLabel.textContent = open ? 'Hide the state panel' : 'Show the state panel';
}

ui.panelBtn.addEventListener('click', () => {
  setPanelOpen(!document.body.classList.contains('panel-open'));
});

// The composer carries a clip to match the reference layout, but this
// prototype has no attachment path - say so rather than fail silently.
$('clip-btn').addEventListener('click', () => {
  addTurn('system', 'attachments are not part of this prototype');
});

for (const chip of document.querySelectorAll('.chip[data-prompt]')) {
  chip.addEventListener('click', () => {
    if (!isConnected()) return;
    ui.typeInput.value = chip.dataset.prompt;
    updateSendEnabled();
    ui.typeForm.requestSubmit();
  });
}

ui.resetBtn.addEventListener('click', async () => {
  hardStopSpeech(false);
  // Reseeding the database is the server's job, or the demo backend's.
  if (demo) demo.resetData();
  else await fetch('/api/reset', { method: 'POST' });
  send({ type: 'reset' });
  withTransition(() => {
    ui.transcript.innerHTML = '';
    document.body.classList.remove('has-turns');
  });
  agentBubble = null;
  knownReservationIds = new Set();
  ui.latencyPill.textContent = 'first answer: —';
  addTurn('system', 'demo data reset');
  updateRing();
});

mountComposerBeams(ui.typeForm);
setMode('idle');

if (synth) synth.onvoiceschanged = pickVoice;

// Controls stay disabled until the socket is actually up.
setConnectionState('connecting');
connect();

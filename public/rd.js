'use strict';
// Ponte remote desktop client. One WebSocket to /api/rd on the page's own host
// (the home node relays to other nodes with ?node=), H.264 access units decoded
// by WebCodecs and drawn at once on a desynchronized canvas, raw keyboard and
// mouse back as small JSON messages (DESENHO.md §5 and §8).
const i18n = window.PonteI18n;
const t = i18n.t;
const $ = selector => document.querySelector(selector);

const TOKEN_KEY = 'ponte-pair-token';
const MODE_KEY = 'ponte-rd-mode';
const CHORD_KEY = 'ponte-rd-chord';
const FPS_KEY = 'ponte-rd-fps';
const CLIPBOARD_KEY = 'ponte-rd-clipboard';
const FOLLOW_KEY = 'ponte-rd-follow';
const FPS_CHOICES = [60, 30, 15];
// Controlling, the window title starts with this: a compositor rule (Hyprland
// submap, docs/rd-control.md) can hand Super to the page only while it is set.
const TITLE_MARK = '⌨ ';
const SWITCH_SHOW_MS = 1600;
const HEADER_BYTES = 16;
const MAX_DECODE_QUEUE = 2;
// Outside the LAN frames arrive in bursts and a dropped delta costs a new
// encoder run and a keyframe: only a second of frames waiting is late there.
const WAN_DECODE_QUEUE_SECONDS = 1;
const MAX_CONFIGURE_QUEUE = 30; // about a second at 30 fps while the decoder is being set up
const WHEEL_UNIT = 120;
const CLIP_LIMIT = 1024 * 1024;
const STATS_SPAN = 5000;
const ESC_HOLD_MS = 2000;
const RECONNECT_STEPS = [500, 1000, 2000, 4000, 8000];
// The server paces the encoder by these (a server that does not know them
// ignores them): the last frame that arrived, at most every 50 ms, and a
// keyframe when the decoder lost its reference, at most every 3 s.
const ACK_EVERY_MS = 50;
const KEYFRAME_ASK_MS = 3000;
const PROBE_PATCH = 24;
const PROBE_ROUNDS = 10;
// The lab source paints its capture time (ms epoch, 44 bits, MSB first, white =
// 1) as 16×16 cells from the top-left corner; y is the middle row of the cells.
const LAB_STRIPE = { x: 0, y: 8, cell: 16, bits: 44 };
const STRIPE_TRUST_MS = 60000;

// ---- pure helpers (unit-tested) -------------------------------------------

// The video keeps its aspect ratio inside the stage; the rest is black bars.
function fitRect(boxWidth, boxHeight, videoWidth, videoHeight) {
  if (!(boxWidth > 0 && boxHeight > 0 && videoWidth > 0 && videoHeight > 0)) return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const width = videoWidth * scale, height = videoHeight * scale;
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}

// Stage coordinates → fraction of the remote monitor. Points in the bars clamp
// to the nearest edge (so the edge is reachable); `inside` says whether the
// point was on the picture, which is what a button press needs.
function normalizedPoint(x, y, rect) {
  if (!rect.width || !rect.height) return null;
  const rawX = (x - rect.left) / rect.width, rawY = (y - rect.top) / rect.height;
  const clamp = value => Math.round(Math.min(1, Math.max(0, value)) * 1e6) / 1e6;
  return { x: clamp(rawX), y: clamp(rawY), inside: rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1 };
}

// Wheel in units of 120 per notch. Chrome's legacy wheelDelta already is that
// (fractional for high-resolution wheels and touchpads); otherwise scale the
// standard deltas by their mode: 3 lines or 100 px per notch, a page is one.
// Sign follows the DOM: positive dy scrolls down, positive dx scrolls right.
function wheelUnits(event) {
  if (typeof event.wheelDeltaY === 'number' && typeof event.wheelDeltaX === 'number' && (event.wheelDeltaY || event.wheelDeltaX)) {
    return { dx: -event.wheelDeltaX, dy: -event.wheelDeltaY };
  }
  const scale = event.deltaMode === 1 ? WHEEL_UNIT / 3 : event.deltaMode === 2 ? WHEEL_UNIT : WHEEL_UNIT / 100;
  return { dx: (event.deltaX || 0) * scale, dy: (event.deltaY || 0) * scale };
}

// Ctrl+X is reserved in either direction, but Ctrl+Shift/Alt/Super+X is not.
function isControlSwitch(event, held) {
  const has = (...codes) => codes.some(code => held.has(code));
  return event.type === 'keydown' && event.code === 'KeyX'
    && (event.ctrlKey || has('ControlLeft', 'ControlRight'))
    && !(event.shiftKey || has('ShiftLeft', 'ShiftRight'))
    && !(event.altKey || has('AltLeft', 'AltRight'))
    && !(event.metaKey || has('MetaLeft', 'MetaRight'));
}

// How the link feels, in words: good, unstable or bad and the main reason.
// `expectedFps` is what the session asked for (30 at most over the internet);
// p95 is the frame latency (send to draw) over the last 5 s.
function linkQuality({ fps, expectedFps = 60, rtt = null, p95 = null, drops = 0 } = {}) {
  const reasons = [];
  let level = 'good';
  const worse = next => { if (next === 'bad' || level === 'good') level = next; };
  if (rtt !== null && rtt > 150) { worse('bad'); reasons.push({ key: 'rtt', value: Math.round(rtt) }); }
  else if (rtt !== null && rtt > 60) { worse('unstable'); reasons.push({ key: 'rtt', value: Math.round(rtt) }); }
  if (p95 !== null && p95 > 250) { worse('bad'); reasons.push({ key: 'jitter', value: Math.round(p95) }); }
  else if (p95 !== null && p95 > 100) { worse('unstable'); reasons.push({ key: 'jitter', value: Math.round(p95) }); }
  if (typeof fps === 'number' && expectedFps > 0) {
    if (fps < expectedFps * 0.5) { worse('bad'); reasons.push({ key: 'fps', value: Math.round(fps) }); }
    else if (fps < expectedFps * 0.8) { worse('unstable'); reasons.push({ key: 'fps', value: Math.round(fps) }); }
  }
  if (drops > 2) { worse('unstable'); reasons.push({ key: 'drops', value: drops }); }
  return { level, reasons };
}

// The contract does not fix the byte order of the 16-byte header; network order
// (big-endian) is assumed, and a send time that is not a plausible epoch in big
// endian but is in little endian switches the connection to little endian.
const plausibleEpoch = (ms, now) => Number.isFinite(ms) && Math.abs(ms - now) < 864e5;
function detectLittleEndian(view, now) {
  return !plausibleEpoch(view.getFloat64(8, false), now) && plausibleEpoch(view.getFloat64(8, true), now);
}
function parseHeader(buffer, littleEndian = false) {
  if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1) return null;
  return {
    key: (view.getUint8(1) & 1) === 1,
    seq: view.getUint32(4, littleEndian),
    sendTime: view.getFloat64(8, littleEndian),
    data: new Uint8Array(buffer, HEADER_BYTES),
  };
}

// Mean and 95th percentile of the samples inside the last `span` ms.
function windowStats(samples, now, span = STATS_SPAN) {
  while (samples.length && samples[0].at < now - span) samples.shift();
  if (!samples.length) return null;
  const values = samples.map(sample => sample.value).sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)], count: values.length };
}

// Mean absolute difference between two RGBA patches, 0..255.
function patchDifference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let total = 0, count = 0;
  for (let i = 0; i < a.length; i += 4) { total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); count += 3; }
  return count ? total / count : 0;
}

// Capture-time stripe of the lab source (DESENHO §6): `bits` cells of `cell` px
// along a row starting at (x, y), most significant bit first, white = 1. With
// fewer bits than an epoch needs, the high bits come from the frame's send time.
function stripeTime(pixels, stripe, referenceMs) {
  let value = 0;
  for (let bit = 0; bit < stripe.bits; bit++) {
    const at = (bit * stripe.cell + (stripe.cell >> 1)) * 4;
    const luma = (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3;
    value = value * 2 + (luma > 127 ? 1 : 0);
  }
  const span = 2 ** stripe.bits;
  if (stripe.bits >= 48) return value;
  // Rebuild the full epoch from the reference: the candidate nearest to it.
  const base = referenceMs - (referenceMs % span);
  let best = base + value;
  for (const candidate of [best - span, best + span]) if (Math.abs(candidate - referenceMs) < Math.abs(best - referenceMs)) best = candidate;
  return best;
}

// ---- state -------------------------------------------------------------------

const params = new URLSearchParams(location.search);
let token = '';
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch {}
let nodeId = params.get('node') || '';
let wantedMonitor = params.get('monitor') || '';
const probeEnabled = params.get('probe') === '1';
if (location.hash.length > 1) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const paired = hash.get('pair');
  if (paired) { token = paired; try { localStorage.setItem(TOKEN_KEY, token); } catch {} }
  if (hash.has('node')) nodeId = hash.get('node') || '';
  if (hash.has('monitor')) wantedMonitor = hash.get('monitor') || '';
  history.replaceState(null, '', pageAddress());
}

let mode = 'abs';
try { if (localStorage.getItem(MODE_KEY) === 'rel') mode = 'rel'; } catch {}
let chordAction = 'window';     // 'window' | 'fullscreen': what Ctrl+X does when it takes control
try { if (localStorage.getItem(CHORD_KEY) === 'fullscreen') chordAction = 'fullscreen'; } catch {}
let fpsLimit = 60;
try { const stored = Number(localStorage.getItem(FPS_KEY)); if (FPS_CHOICES.includes(stored)) fpsLimit = stored; } catch {}
let clipboardOn = true;
try { if (localStorage.getItem(CLIPBOARD_KEY) === 'off') clipboardOn = false; } catch {}
// Super+N landing on another monitor brings that monitor here. On by default:
// without it a workspace on another screen just disappears from view.
let followOn = true;
try { if (localStorage.getItem(FOLLOW_KEY) === 'off') followOn = false; } catch {}
const linkLevels = [];          // the last few seconds' link levels, worst wins
let firstFrameAt = 0;           // when this stream's first picture was drawn; no verdict before it
let socket = null;
let session = null;            // the last `ready`
let littleEndian = null;       // header byte order, detected per connection
let reconnectAttempt = 0;
let reconnectTimer = 0;
let stopped = '';              // '' | 'taken' | 'auth' : no automatic reconnect
let stopMessage = '';
let engaged = false;           // the user is controlling (keys and buttons go out)
const pressed = new Set();     // key codes sent down
const buttonsDown = new Set(); // mouse buttons sent down
let escTimer = 0;
let pendingMove = null;
let lastMove = null;
const pendingRel = { dx: 0, dy: 0 };
const pendingWheel = { dx: 0, dy: 0 };
let inputFrame = false;
let lastClip = null;
let pendingClip = null;
let nodes = [];

let decoder = null;
let decoderConfig = null;
let configuring = null;
let queuedChunks = [];
let waitingKey = true;
let linkMode = 'lan', viewSent = null, viewTimer = 0;
let hardware = '';
let decoderFailures = 0;
let hardwareFailed = false;   // for the rest of the page's life
const inflight = new Map();    // seq → { sendTime, recvAt }
let catchingUp = false;       // the frames queued while configuring are being decoded
let ackSeq = 0, ackSent = 0, ackTimer = 0, lastAckAt = -Infinity, keyframeAskedAt = -Infinity;
let canvasContext = null;
let sampler = null;
let videoSize = { width: 0, height: 0 };
let videoRect = { left: 0, top: 0, width: 0, height: 0 };

let clockOffset = 0;           // server clock − client clock
let rtt = null;
const pingSamples = [];        // { rtt, offset }
const frameLatency = [];       // { at, value }
const glassLatency = [];
let framesDrawn = 0;
let framesDropped = 0;
let bytesReceived = 0;
let meters = { fps: 0, kbps: 0, drops: 0 };
let probe = null;
let lastProbe = null;
let keyboardLock = 'off';
let pointerLock = 'off';
const keyMetrics = { observed: 0, sent: 0, recent: [] };
let targetInput = null;

function rememberKey(event, outcome) {
  const code = /^[A-Za-z0-9_]{1,32}$/.test(event.code || '') ? event.code : 'Unidentified';
  keyMetrics.observed++;
  keyMetrics.recent.push({ code, down: event.type === 'keydown', outcome, ime: event.keyCode === 229 || event.isComposing === true });
  if (keyMetrics.recent.length > 12) keyMetrics.recent.shift();
  renderKeyDetails();
}

function renderKeyDetails() {
  $('#rd-key-stats').textContent = t('Teclado: {seen} eventos na página, {sent} enviados.', { seen: keyMetrics.observed, sent: keyMetrics.sent });
  if (targetInput) {
    const count = name => Number.isSafeInteger(targetInput[name]) && targetInput[name] >= 0 ? targetInput[name] : '?';
    $('#rd-key-stats').textContent += ` ${t('Destino: {received} recebidos, {injected} injetados, {pending} pendentes.', { received: count('received'), injected: count('injected'), pending: count('pending') })}`;
    if (targetInput.dryRun === true) $('#rd-key-stats').textContent += ' (dry-run)';
  }
  const labels = { sent: t('enviado'), local: t('local'), switch: t('alternou'), 'switch-release': t('atalho reservado'), deferred: t('Ctrl aguardando a próxima tecla'), repeat: t('repetição local'), 'missing-code': t('sem código físico'), 'no-session': t('sem sessão'), disabled: t('teclado indisponível'), 'not-held': t('soltura sem pressão enviada') };
  $('#rd-key-trace').textContent = keyMetrics.recent.map(key => `${key.down ? '↓' : '↑'} ${key.code}${key.ime ? ' [IME/229]' : ''}: ${labels[key.outcome] || key.outcome}`).join('\n');
}

const nowEpoch = () => performance.timeOrigin + performance.now();

function pageAddress() {
  const query = new URLSearchParams();
  if (nodeId) query.set('node', nodeId);
  if (wantedMonitor) query.set('monitor', wantedMonitor);
  if (probeEnabled) query.set('probe', '1');
  const text = query.toString();
  return location.pathname + (text ? `?${text}` : '');
}

// ---- status and notes ----------------------------------------------------------

let noteTimer = 0;
function note(message) {
  const element = $('#rd-note');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { element.hidden = true; }, 2600);
}
function overlay(message, retry = false) {
  const element = $('#rd-overlay');
  element.hidden = !message;
  if (message) $('#rd-message').textContent = message;
  $('#rd-retry').hidden = !retry;
}
function status(message) { $('#rd-status').textContent = message || ''; }

// ---- connection ----------------------------------------------------------------

function send(message) {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  if (message.t === 'key') {
    keyMetrics.sent++;
    const pending = keyMetrics.recent.slice().reverse().find(key => key.code === message.code && key.down === message.down && key.outcome === 'deferred');
    if (pending) pending.outcome = 'sent';
  }
  return true;
}

function socketAddress() {
  const query = new URLSearchParams();
  if (nodeId) query.set('node', nodeId);
  if (wantedMonitor) query.set('monitor', wantedMonitor);
  const text = query.toString();
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rd${text ? `?${text}` : ''}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  if (socket) { const old = socket; socket = null; try { old.close(1000); } catch {} }
  if (!token) { stopped = 'auth'; overlay(t('Abra pelo ./ponte rd ou por um link de pareamento: este navegador ainda não tem a chave.')); return; }
  stopped = ''; stopMessage = '';
  session = null; littleEndian = null; waitingKey = true; inflight.clear(); pingSamples.length = 0; linkMode = 'lan';
  keyMetrics.observed = keyMetrics.sent = 0; keyMetrics.recent.length = 0; targetInput = null;
  renderKeyDetails();
  clearTimeout(ackTimer); ackTimer = 0; ackSeq = 0; ackSent = 0; keyframeAskedAt = -Infinity;
  overlay(reconnectAttempt ? t('Reconectando…') : t('Conectando…'));
  const current = new WebSocket(socketAddress());
  current.binaryType = 'arraybuffer';
  socket = current;
  current.addEventListener('open', () => {
    if (socket !== current) return;
    const hello = { t: 'hello', v: 1, token, maxFps: fpsLimit, caps: { ack: true, key: true }, follow: followOn };
    if (wantedMonitor) hello.monitor = wantedMonitor;
    const view = stageView();
    if (view) hello.view = view;
    viewSent = view;
    current.send(JSON.stringify(hello));
  });
  current.addEventListener('message', event => { if (socket === current) receive(event.data); });
  current.addEventListener('close', event => { if (socket === current) closed(event); });
}

function closed(event) {
  socket = null; session = null;
  dropInput();
  closeDecoder();
  // `engaged` stays: an automatic reconnect keeps controlling, as before.
  renderLink();
  renderControl();
  if (event && (event.code === 4401 || event.code === 4403 || event.code === 1008)) { if (!stopped) stopped = 'auth'; }
  if (stopped === 'taken') { overlay(t('Outro aparelho assumiu o controle deste PC.'), true); return; }
  if (stopped === 'auth') { overlay(stopMessage || t('A chave foi recusada. Pareie de novo com ./ponte rd.'), true); return; }
  const delay = RECONNECT_STEPS[Math.min(reconnectAttempt, RECONNECT_STEPS.length - 1)];
  reconnectAttempt++;
  overlay(t('Sem conexão. Tentando de novo em {seconds} s…', { seconds: Math.ceil(delay / 1000) }));
  reconnectTimer = setTimeout(connect, delay);
}

// The stage in device pixels: a picture wider than this is only scaled down here.
function stageView() {
  const stage = $('#rd-stage');
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round((stage?.clientWidth || 0) * ratio), height = Math.round((stage?.clientHeight || 0) * ratio);
  return width >= 320 && height > 0 ? { width, height } : null;
}

// A stage that grew (full screen, a maximized window) lifts the width limit
// the hello set; the server restarts only when that limit really changes.
function sendView() {
  viewTimer = 0;
  const view = stageView();
  if (!view || !session || (viewSent && viewSent.width === view.width && viewSent.height === view.height)) return;
  viewSent = view;
  send({ t: 'view', ...view });
}
window.addEventListener('resize', () => { clearTimeout(viewTimer); viewTimer = setTimeout(sendView, 600); });

// On arrival, before decoding: the server reads the link's queue from it.
function acknowledge(seq) {
  if (!(seq > ackSeq)) return;
  ackSeq = seq;
  if (ackTimer) return;
  const wait = lastAckAt + ACK_EVERY_MS - performance.now();
  if (wait <= 0) sendAck(); else ackTimer = setTimeout(sendAck, wait);
}
function sendAck() {
  ackTimer = 0;
  if (ackSeq === ackSent) return;
  lastAckAt = performance.now();
  ackSent = ackSeq;
  send({ t: 'ack', seq: ackSeq });
}

// A delta was dropped: every frame up to the next keyframe is lost, and on a
// slow link the next one may be minutes away.
function askKeyframe() {
  const now = performance.now();
  if (now - keyframeAskedAt < KEYFRAME_ASK_MS) return;
  keyframeAskedAt = now;
  send({ t: 'keyframe' });
}

function receive(data) {
  if (typeof data !== 'string') { video(data); return; }
  let message;
  try { message = JSON.parse(data); } catch { return; }
  switch (message.t) {
    case 'ready': ready(message); break;
    case 'pong': pong(message); break;
    case 'link': linkMode = message.mode === 'wan' ? 'wan' : 'lan'; break;
    case 'clip': clipboardIn(message.text); break;
    case 'input-stats': targetInput = message.input && typeof message.input === 'object' ? message.input : null; renderKeyDetails(); break;
    case 'taken':
      // Another client took this target: no automatic reconnect, or the two
      // would keep taking it from each other.
      stopped = 'taken';
      releaseControl(false);
      try { socket.close(1000); } catch {}
      break;
    case 'error':
      stopMessage = errorText(message);
      if (['PAIRING_REQUIRED', 'UNAUTHORIZED', 'FORBIDDEN', 'PEER_REVOKED'].includes(message.code)) stopped = 'auth';
      else status(stopMessage);
      break;
  }
}

function errorText(message) {
  const known = {
    PAIRING_REQUIRED: t('A chave foi recusada. Pareie de novo com ./ponte rd.'),
    RD_UNAVAILABLE: t('O controle remoto não está disponível nesse aparelho (falta captura ou entrada).'),
    CAPTURE_FAILED: t('A captura de tela falhou no aparelho.'),
    MONITORS_UNAVAILABLE: t('O aparelho não informou nenhum monitor.'),
    INVALID_MONITOR: t('Esse monitor não existe mais.'),
    CLIPBOARD_UNAVAILABLE: t('O aparelho não aceitou a área de transferência.'),
  };
  return known[message.code] || i18n.apiMessage(message.code, message.parameters || {}, message.message || message.code || t('O PC recusou a sessão.'));
}

function ready(message) {
  const first = !session;
  const previous = session;
  session = message;
  firstFrameAt = 0;
  reconnectAttempt = 0;
  overlay('');
  status('');
  if (message.width && message.height) setVideoSize(message.width, message.height);
  // Not `wantedMonitor`: with nothing asked for, a reconnect lands on whatever
  // has the focus then, which is the point of following.
  if (typeof message.follow === 'boolean') followOn = message.follow;
  renderMonitors();
  renderNodes();
  renderMode();
  renderSettings();
  renderControl();
  inflight.clear();
  waitingKey = true;
  // A new codec or picture size starts a new decoder; a new stream on the same
  // one only waits for its keyframe.
  const resized = previous && (previous.width !== message.width || previous.height !== message.height);
  if (!decoder || !decoderConfig || decoderConfig.codec !== message.codec || resized) configureDecoder(message.codec || 'avc1.640034');
  if (first) { ping(); if (engaged && document.hasFocus()) clipboardOut(); }
}

// ---- clock -----------------------------------------------------------------------

function ping() { send({ t: 'ping', c: nowEpoch() }); }
function pong(message) {
  const now = nowEpoch();
  if (typeof message.c !== 'number' || typeof message.s !== 'number') return;
  const sample = { rtt: now - message.c, offset: message.s - (message.c + (now - message.c) / 2) };
  pingSamples.push(sample);
  if (pingSamples.length > 10) pingSamples.shift();
  rtt = sample.rtt;
  // The sample with the smallest round trip has the tightest offset bound.
  clockOffset = pingSamples.reduce((best, item) => item.rtt < best.rtt ? item : best).offset;
}

// ---- video -------------------------------------------------------------------------

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch {} }
  decoder = null; configuring = null; queuedChunks = []; waitingKey = true; catchingUp = false;
}

async function configureDecoder(codec) {
  closeDecoder();
  const base = { codec, optimizeForLatency: true };
  let config = { ...base, hardwareAcceleration: hardwareFailed ? 'prefer-software' : 'prefer-hardware' };
  const attempt = configuring = (async () => {
    try { if (!(await VideoDecoder.isConfigSupported(config)).supported) config = { ...base, hardwareAcceleration: 'prefer-software' }; }
    catch { config = { ...base, hardwareAcceleration: 'prefer-software' }; }
  })();
  await attempt;
  if (configuring !== attempt) return;
  decoderFailures = 0;
  startDecoder(config);
  configuring = null;
  // What arrived while configuring goes in as one burst, not as late frames:
  // dropping it would wait for the next keyframe, minutes away on a slow link.
  const queued = queuedChunks; queuedChunks = [];
  catchingUp = queued.length > 1;
  for (const chunk of queued) decode(chunk, true);
}

// A decoder that fails restarts and waits for the next keyframe. Hardware that
// fails (a GPU that claims H.264 and then errors) falls back to software for
// the rest of the session; "no-preference" would pick the same hardware again.
function startDecoder(config) {
  decoderConfig = config;
  hardware = config.hardwareAcceleration === 'prefer-hardware' ? 'hw' : 'sw';
  waitingKey = true;
  const current = new VideoDecoder({
    output: frame => { if (decoder === current) { decoderFailures = 0; draw(frame); } else frame.close(); },
    error: error => {
      if (decoder !== current) return;
      decoder = null;
      decoderFailures++;
      if (decoderConfig.hardwareAcceleration === 'prefer-hardware') { hardwareFailed = true; startDecoder({ ...decoderConfig, hardwareAcceleration: 'prefer-software' }); }
      else if (decoderFailures <= 3) startDecoder(decoderConfig);
      else status(t('O decodificador de vídeo falhou: {error}', { error: error?.message || error }));
    },
  });
  decoder = current;
  current.configure(config);
}

function video(buffer) {
  if (littleEndian === null && buffer?.byteLength >= HEADER_BYTES) littleEndian = detectLittleEndian(new DataView(buffer), nowEpoch() + clockOffset);
  const header = parseHeader(buffer, littleEndian);
  if (!header) return;
  bytesReceived += buffer.byteLength;
  acknowledge(header.seq);
  const chunk = { ...header, recvAt: nowEpoch() };
  if (configuring) {
    if (chunk.key) queuedChunks = [chunk]; else if (queuedChunks.length && queuedChunks.length < MAX_CONFIGURE_QUEUE) queuedChunks.push(chunk); else { framesDropped++; askKeyframe(); }
    return;
  }
  decode(chunk);
}

// A late frame is not worth drawing: with more than two frames waiting in the
// decoder, deltas are dropped until the next keyframe, which restarts clean.
function decode(chunk, burst = false) {
  // Until the decoder has worked through that burst, a full queue is expected.
  if (!burst && catchingUp && decoder && decoder.decodeQueueSize <= MAX_DECODE_QUEUE) catchingUp = false;
  const steady = linkMode === 'wan' ? Math.max(MAX_DECODE_QUEUE, Math.round((session?.fps || 30) * WAN_DECODE_QUEUE_SECONDS)) : MAX_DECODE_QUEUE;
  const late = !burst && decoder?.decodeQueueSize > (catchingUp ? MAX_CONFIGURE_QUEUE : steady);
  if (!decoder || decoder.state !== 'configured') { waitingKey = true; framesDropped++; if (!chunk.key) askKeyframe(); return; }
  if (!chunk.key) {
    if (waitingKey || late) { waitingKey = true; framesDropped++; askKeyframe(); return; }
  } else if (late) {
    framesDropped += decoder.decodeQueueSize;
    decoder.reset();
    decoder.configure(decoderConfig);
    inflight.clear();
  }
  waitingKey = false;
  inflight.set(chunk.seq, { sendTime: chunk.sendTime, recvAt: chunk.recvAt });
  if (inflight.size > 64) inflight.delete(inflight.keys().next().value);
  decoder.decode(new EncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: chunk.seq, data: chunk.data }));
}

function draw(frame) {
  const info = inflight.get(frame.timestamp);
  inflight.delete(frame.timestamp);
  const width = frame.displayWidth, height = frame.displayHeight;
  const canvas = $('#rd-canvas');
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; canvasContext = null; }
  if (videoSize.width !== width || videoSize.height !== height) setVideoSize(width, height);
  if (!canvasContext) canvasContext = canvas.getContext('2d', { desynchronized: true, alpha: false });
  canvasContext.drawImage(frame, 0, 0, width, height);
  const drawnAt = nowEpoch();
  framesDrawn++;
  if (!firstFrameAt) firstFrameAt = drawnAt;
  if (info) frameLatency.push({ at: drawnAt, value: drawnAt + clockOffset - info.sendTime });
  // Glass to glass, only where a capture-time stripe exists (the lab): the
  // page reads it with ?probe=1 and trusts it only near the frame's send time.
  const stripe = session?.lab?.stripe || (probeEnabled ? LAB_STRIPE : null);
  if (stripe && info && width >= stripe.x + stripe.bits * stripe.cell) {
    const pixels = sample(frame, stripe.x, stripe.y, stripe.bits * stripe.cell, 1);
    const captured = pixels && stripeTime(pixels, stripe, info.sendTime);
    if (captured && Math.abs(info.sendTime - captured) < STRIPE_TRUST_MS) glassLatency.push({ at: drawnAt, value: drawnAt + clockOffset - captured });
  }
  if (probe) probeFrame(frame, drawnAt);
  frame.close();
}

// Reads a small region of a decoded frame (lab stripe and probe only).
function sample(frame, x, y, width, height) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!sampler || sampler.canvas.width < width || sampler.canvas.height < height) {
    sampler = new OffscreenCanvas(Math.max(width, PROBE_PATCH * 2), Math.max(height, PROBE_PATCH * 2)).getContext('2d', { willReadFrequently: true });
  }
  sampler.drawImage(frame, x, y, width, height, 0, 0, width, height);
  return sampler.getImageData(0, 0, width, height).data;
}

function setVideoSize(width, height) { videoSize = { width, height }; layout(); }

function layout() {
  const stage = $('#rd-stage');
  videoRect = fitRect(stage.clientWidth, stage.clientHeight, videoSize.width, videoSize.height);
  const style = $('#rd-canvas').style;
  style.left = `${videoRect.left}px`; style.top = `${videoRect.top}px`;
  style.width = `${videoRect.width}px`; style.height = `${videoRect.height}px`;
}

// ---- stats ---------------------------------------------------------------------------

let lastMeter = 0;
function tick() {
  const now = nowEpoch();
  const elapsed = lastMeter ? (now - lastMeter) / 1000 : 1;
  lastMeter = now;
  meters = { fps: framesDrawn / elapsed, kbps: bytesReceived * 8 / 1000 / elapsed, drops: framesDropped };
  framesDrawn = 0; bytesReceived = 0; framesDropped = 0;
  if (!session) { renderStats(); return; }
  // The list follows the network (a node coming online, a pairing approved).
  if (performance.now() - devicesLoadedAt > DEVICES_REFRESH_MS) loadNodes();
  ping();
  const frame = windowStats(frameLatency, now), glass = windowStats(glassLatency, now);
  const report = { t: 'stats', fps: round(meters.fps), kbps: Math.round(meters.kbps), rtt: rtt === null ? null : round(rtt), queue: decoder?.decodeQueueSize || 0, drops: meters.drops };
  if (frame) { report.latency = round(frame.mean); report.p95 = round(frame.p95); }
  if (glass) { report.glass = round(glass.mean); report.glassP95 = round(glass.p95); }
  send(report);
  window.ponteRdStats = { ...report, hardware, keyboardLock, pointerLock, engaged, mode, monitor: session.monitor, probe: lastProbe };
  renderStats(frame, glass);
  renderLink(frame);
}
const round = value => Math.round(value * 10) / 10;
const ms = value => `${Math.round(value)} ms`;

function renderStats(frame = windowStats(frameLatency, nowEpoch()), glass = windowStats(glassLatency, nowEpoch())) {
  if (!session) { $('#rd-stats').textContent = ''; return; }
  const parts = [
    `${Math.round(meters.fps)} fps`,
    `${(meters.kbps / 1000).toFixed(1)} Mbps`,
    rtt === null ? 'RTT –' : `RTT ${rtt < 10 ? rtt.toFixed(1) : Math.round(rtt)} ms`,
    frame ? `${t('quadro')} ${ms(frame.mean)} (p95 ${ms(frame.p95)})` : `${t('quadro')} –`,
  ];
  if (glass) parts.push(`${t('vidro')} ${ms(glass.mean)} (p95 ${ms(glass.p95)})`);
  if (lastProbe) parts.push(`${t('sonda')} ${lastProbe}`);
  parts.push(hardware);
  $('#rd-stats').textContent = parts.filter(Boolean).join(' · ');
}

// The bar says good / unstable / bad and why, in words; the numbers live in the
// settings' technical details. The worst of the last 3 s, so one late second
// does not make it blink.
const LINK_TEXT = { good: 'Conexão boa', unstable: 'Conexão instável', bad: 'Conexão ruim' };
function reasonText(reason) {
  switch (reason.key) {
    case 'rtt': return t('ida e volta de {ms} ms', { ms: reason.value });
    case 'jitter': return t('imagem chegando com atraso (até {ms} ms)', { ms: reason.value });
    case 'fps': return t('só {fps} quadros por segundo', { fps: reason.value });
    case 'drops': return t('{count} quadros perdidos', { count: reason.value });
    default: return '';
  }
}
let lastLink = null;
function renderLink(frame = windowStats(frameLatency, nowEpoch())) {
  const chip = $('#rd-link');
  if (!session) { chip.hidden = true; lastLink = null; linkLevels.length = 0; $('#rd-link-reason').textContent = ''; return; }
  // Before the first picture (and for its first second) there is nothing to judge:
  // "0 frames per second" there is the stream starting, not a bad link.
  if (!firstFrameAt || nowEpoch() - firstFrameAt < 1000) { chip.hidden = true; linkLevels.length = 0; return; }
  const expectedFps = Math.min(session.fps || fpsLimit, fpsLimit, linkMode === 'wan' ? 30 : Infinity);
  const now = linkQuality({ fps: meters.fps, expectedFps, rtt, p95: frame ? frame.p95 : null, drops: meters.drops });
  linkLevels.push(now);
  if (linkLevels.length > 3) linkLevels.shift();
  const rank = { good: 0, unstable: 1, bad: 2 };
  const shown = linkLevels.reduce((worst, item) => rank[item.level] > rank[worst.level] ? item : worst);
  lastLink = shown;
  const reason = shown.reasons.length ? reasonText(shown.reasons[0]) : '';
  chip.hidden = false;
  chip.setAttribute('data-level', shown.level);
  $('#rd-link-text').textContent = reason ? `${t(LINK_TEXT[shown.level])} · ${reason}` : t(LINK_TEXT[shown.level]);
  $('#rd-link-reason').textContent = shown.reasons.length ? shown.reasons.map(reasonText).join(' · ') : t('Nada fora do normal agora.');
}

// ---- where the keyboard and mouse go ------------------------------------------------

// The device on the screen, by name: the one the server says it is, else the
// picker's label, else a plain word.
function targetName() {
  return session?.node?.name || currentDevice()?.name || t('o aparelho da tela');
}

const BASE_TITLE = 'Ponte — área de trabalho remota';
function renderTitle() {
  const base = t(BASE_TITLE);
  document.title = engaged && session ? `${TITLE_MARK}${targetName()} · ${base}` : base;
}

// The always-visible indicator: who gets the keys now, and how to switch.
function renderControl() {
  const button = $('#rd-control');
  const full = !!document.fullscreenElement;
  button.setAttribute('aria-pressed', String(engaged));
  button.disabled = !session;
  if (engaged && session) {
    $('#rd-control-target').textContent = t('Teclado e mouse → {name}', { name: targetName() });
    $('#rd-hint').textContent = full
      ? t('Tudo vai pro aparelho, até Super. Ctrl+X ou segure Esc pra voltar.')
      : t('Ctrl+X volta pra este aparelho. Super e Ctrl+T ficam aqui (a tela cheia leva tudo).');
  } else {
    $('#rd-control-target').textContent = t('Teclado e mouse → este aparelho');
    $('#rd-hint').textContent = session ? t('Ctrl+X ou clique na tela pra controlar {name}.', { name: targetName() }) : '';
  }
  renderTitle();
}

// A big, short notice in the middle of the screen on every switch.
let switchTimer = 0;
function showSwitch() {
  const element = $('#rd-switch');
  element.textContent = engaged ? t('Teclado e mouse → {name}', { name: targetName() }) : t('Teclado e mouse → este aparelho');
  element.setAttribute('data-to', engaged ? 'remote' : 'local');
  element.hidden = false;
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => { element.hidden = true; }, SWITCH_SHOW_MS);
}

// ---- control state -------------------------------------------------------------------

const inputAllows = kind => session?.input?.[kind] !== false;

function engage(mayPrompt = false) {
  if (!session) return;
  // A stage click prevents default mouse handling, so a previously focused
  // selector would otherwise keep every subsequent key (including Super).
  document.activeElement?.blur?.();
  $('#rd-stage').focus({ preventScroll: true });
  if (engaged) return;
  engaged = true;
  document.body.classList.add('controlling');
  renderControl();
  showSwitch();
  clipboardOut(mayPrompt);
}

// Drop everything held on the remote side: blur, hidden page, disconnect.
function dropInput() {
  clearTimeout(escTimer);
  const held = pressed.size || buttonsDown.size;
  pressed.clear(); buttonsDown.clear();
  pendingControl.clear();
  pendingMove = null; pendingRel.dx = pendingRel.dy = 0; pendingWheel.dx = pendingWheel.dy = 0;
  return held;
}
function releaseRemote() { dropInput(); send({ t: 'release' }); }

// Keys and buttons stop going out; full screen stays (the bar was clicked).
function disengage(tell = true) {
  if (tell) releaseRemote(); else dropInput();
  const was = engaged;
  engaged = false;
  document.body.classList.remove('controlling');
  renderControl();
  if (was) showSwitch();
}

// Ctrl+X (or the indicator) while this device has the keys: take them
// to the device on the screen, in the window or, if chosen, in full screen
// (the only place the browser hands over Super and its own shortcuts).
function takeControl() {
  if (!session || engaged) return;
  if (chordAction === 'fullscreen' && !document.fullscreenElement) { enterFullscreen(); return; }
  document.activeElement?.blur?.();
  engage();
  if (mode === 'rel' && inputAllows('rel') && !document.pointerLockElement) lockPointer();
}

// Release the control: leave full screen and pointer lock, and tell the target.
function releaseControl(tell = true) {
  disengage(tell);
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch {} }
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
  try { navigator.keyboard?.unlock(); } catch {}
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  if (mode === 'abs' && document.pointerLockElement) { try { document.exitPointerLock(); } catch {} }
  renderMode();
}
function renderMode() {
  $('#rd-mode-abs').setAttribute('aria-pressed', String(mode === 'abs'));
  $('#rd-mode-rel').setAttribute('aria-pressed', String(mode === 'rel'));
  $('#rd-mode-abs').disabled = session ? !inputAllows('abs') : false;
  $('#rd-mode-rel').disabled = session ? !inputAllows('rel') : false;
  document.body.classList.toggle('rel', mode === 'rel');
}

async function lockPointer() {
  const stage = $('#rd-stage');
  try { await stage.requestPointerLock({ unadjustedMovement: true }); pointerLock = 'raw'; }
  catch (error) {
    // Raw movement is not available everywhere (NotSupportedError): plain lock.
    try { await stage.requestPointerLock(); pointerLock = 'plain'; } catch { pointerLock = 'refused'; note(t('O navegador recusou travar o ponteiro.')); }
  }
}

async function enterFullscreen() {
  if (!session) return;
  document.activeElement?.blur?.();
  engage();
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { note(t('O navegador recusou a tela cheia.')); return; }
  // No key list: every key, including Super, Alt+Tab and Esc (held 2 s leaves).
  if (!navigator.keyboard?.lock) keyboardLock = 'unsupported';
  else try { await navigator.keyboard.lock(); keyboardLock = 'locked'; } catch { keyboardLock = 'refused'; note(t('Sem trava de teclado: atalhos do sistema continuam no seu PC.')); }
  if (mode === 'rel') lockPointer();
  renderControl();
}

// ---- keyboard ---------------------------------------------------------------------------

// Physical keys are separate from the keys actually sent to the other device.
// Ctrl waits for the next key so the reserved Ctrl+X never leaks a remote Ctrl.
const localPressed = new Set();
const pendingControl = new Set();
const switchKeys = new Set();

function flushControl() {
  for (const code of pendingControl) {
    if (send({ t: 'key', code, down: true })) pressed.add(code);
  }
  pendingControl.clear();
}

function keyEvent(event) {
  const sent = keyMetrics.sent;
  const outcome = routeKey(event);
  rememberKey(event, outcome || (keyMetrics.sent > sent ? 'sent' : 'not-held'));
}

function routeKey(event) {
  const code = event.code;
  if (event.type === 'keydown') localPressed.add(code);
  if (switchKeys.has(code)) {
    event.preventDefault(); event.stopPropagation?.();
    if (event.type === 'keyup') { switchKeys.delete(code); localPressed.delete(code); }
    return 'switch-release';
  }
  if (session && !$('#rd-settings').open && isControlSwitch(event, localPressed)) {
    event.preventDefault(); event.stopPropagation?.();
    if (event.repeat) return 'repeat';
    switchKeys.add('KeyX');
    for (const held of localPressed) if (held === 'ControlLeft' || held === 'ControlRight') switchKeys.add(held);
    if (engaged) releaseControl(); else takeControl();
    return 'switch';
  }
  if (event.type === 'keyup') localPressed.delete(code);
  if (!engaged) return 'local';
  if (!session) return 'no-session';
  if (!inputAllows('keys')) return 'disabled';
  // While controlling, even a stale bar focus must not eat the remote keys.
  event.preventDefault();
  event.stopPropagation?.();
  if (!code || code === 'Unidentified') return 'missing-code';
  if (event.type === 'keydown') {
    // The target repeats a held key by itself; the client's auto-repeat stays home.
    if (event.repeat) return 'repeat';
    if (code === 'ControlLeft' || code === 'ControlRight') { pendingControl.add(code); return 'deferred'; }
    flushControl();
    pressed.add(code);
    send({ t: 'key', code, down: true });
    if (code === 'Escape') { clearTimeout(escTimer); escTimer = setTimeout(() => releaseControl(), ESC_HOLD_MS); }
  } else {
    if (code === 'Escape') clearTimeout(escTimer);
    if (pendingControl.has(code)) flushControl();
    if (!pressed.delete(code)) return 'not-held';
    send({ t: 'key', code, down: false });
  }
}

// ---- mouse ---------------------------------------------------------------------------------

function stagePoint(event) {
  const box = $('#rd-stage').getBoundingClientRect();
  return normalizedPoint(event.clientX - box.left, event.clientY - box.top, videoRect);
}

function scheduleInput() {
  if (inputFrame) return;
  inputFrame = true;
  requestAnimationFrame(flushInput);
}

// Moves, relative motion and wheel coalesce to one message per frame each.
function flushInput() {
  inputFrame = false;
  if (pendingMove) { send({ t: 'move', x: pendingMove.x, y: pendingMove.y }); pendingMove = null; }
  const rel = { dx: Math.trunc(pendingRel.dx), dy: Math.trunc(pendingRel.dy) };
  if (rel.dx || rel.dy) { pendingRel.dx -= rel.dx; pendingRel.dy -= rel.dy; send({ t: 'rel', ...rel }); }
  const wheel = { dx: Math.trunc(pendingWheel.dx), dy: Math.trunc(pendingWheel.dy) };
  if (wheel.dx || wheel.dy) { pendingWheel.dx -= wheel.dx; pendingWheel.dy -= wheel.dy; send({ t: 'wheel', ...wheel }); }
}

function mouseMove(event) {
  if (!session) return;
  // In full screen the bar peeks when the pointer touches the top edge.
  if (document.body.classList.contains('fullscreen') && !document.pointerLockElement && event.clientY <= 3) document.body.classList.add('bar-peek');
  if (!engaged) return;
  if (mode === 'rel') {
    if (!document.pointerLockElement || !inputAllows('rel')) return;
    pendingRel.dx += event.movementX || 0; pendingRel.dy += event.movementY || 0;
    scheduleInput();
    return;
  }
  if (!inputAllows('abs') || event.target?.closest?.('.rd-bar')) return;
  const point = stagePoint(event);
  if (!point) return;
  lastMove = pendingMove = { x: point.x, y: point.y };
  scheduleInput();
}

function mouseDown(event) {
  if (!session || event.target?.closest?.('.rd-bar')) return;
  event.preventDefault();
  if (!engaged) engage(!document.fullscreenElement);
  flushControl();
  if (mode === 'rel' && inputAllows('rel') && !document.pointerLockElement) { lockPointer(); return; }
  if (event.button < 0 || event.button > 4) return;
  if (mode === 'abs') {
    const point = stagePoint(event);
    if (!point || !point.inside) return;
    // A button never waits for the frame: the latest position goes first.
    lastMove = { x: point.x, y: point.y };
    pendingMove = null;
    send({ t: 'move', x: point.x, y: point.y });
  }
  buttonsDown.add(event.button);
  send({ t: 'btn', b: event.button, down: true });
}

function mouseUp(event) {
  if (!buttonsDown.has(event.button)) return;
  event.preventDefault();
  buttonsDown.delete(event.button);
  if (mode === 'abs' && pendingMove) { send({ t: 'move', x: pendingMove.x, y: pendingMove.y }); pendingMove = null; }
  send({ t: 'btn', b: event.button, down: false });
}

function wheel(event) {
  if (!session || !engaged || event.target?.closest?.('.rd-bar')) return;
  event.preventDefault();
  flushControl();
  const units = wheelUnits(event);
  pendingWheel.dx += units.dx; pendingWheel.dy += units.dy;
  scheduleInput();
}

// Double click in the top-right corner of the picture toggles abs/rel.
function cornerToggle(event) {
  if (!session || mode !== 'abs') return;
  const box = $('#rd-stage').getBoundingClientRect();
  const x = event.clientX - box.left - videoRect.left, y = event.clientY - box.top - videoRect.top;
  if (x >= videoRect.width - 24 && x <= videoRect.width && y >= 0 && y <= 24) { setMode('rel'); lockPointer(); }
}

// ---- clipboard ---------------------------------------------------------------------------------

const utf8Length = text => new TextEncoder().encode(text).length;

// Chrome asks once before the page may read the clipboard, and that prompt
// takes the focus (which drops full screen). So the first read is only tried
// from a plain click on the picture; afterwards it runs on every focus.
async function clipboardReadable(mayPrompt) {
  try {
    const state = (await navigator.permissions?.query({ name: 'clipboard-read' }))?.state;
    return state === 'granted' || (state !== 'denied' && mayPrompt);
  } catch { return mayPrompt; }
}

async function clipboardOut(mayPrompt = false) {
  if (!session || !clipboardOn || !inputAllows('clipboard') || !navigator.clipboard?.readText) return;
  if (!(await clipboardReadable(mayPrompt))) { if (pendingClip !== null) await clipboardWrite(); return; }
  if (pendingClip !== null) await clipboardWrite();
  let text;
  try { text = await navigator.clipboard.readText(); } catch { return; }
  if (typeof text !== 'string' || !text || text === lastClip) return;
  if (utf8Length(text) > CLIP_LIMIT) { note(t('Área de transferência grande demais para enviar (máx. 1 MiB).')); return; }
  lastClip = text;
  if (send({ t: 'clip', text })) note(t('Área de transferência enviada ({count} caracteres).', { count: text.length }));
}

async function clipboardIn(text) {
  if (!clipboardOn || typeof text !== 'string' || text === lastClip) return;
  pendingClip = text;
  if (document.hasFocus()) await clipboardWrite();
}

async function clipboardWrite() {
  const text = pendingClip;
  if (text === null || !navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(text);
    pendingClip = null; lastClip = text;
    note(t('Área de transferência recebida ({count} caracteres).', { count: text.length }));
  } catch {}
}

// ---- selectors --------------------------------------------------------------------------------

const option = (value, label, selected, disabled = false) => `<option value="${i18n.escape(value)}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}>${i18n.escape(label)}</option>`;

function renderMonitors() {
  const select = $('#rd-monitor');
  const monitors = session?.monitors || [];
  select.innerHTML = monitors.map(monitor => option(monitor.name, monitor.width && monitor.height ? `${monitor.name} · ${monitor.width}×${monitor.height}` : monitor.name, monitor.name === session.monitor)).join('');
  select.value = session?.monitor || '';
  select.disabled = monitors.length < 2;
}

// The devices come from the home node's one list (GET /api/devices, docs/devices.md):
// the server decides what can be controlled (`can.control`) and why not; this page
// only draws it, in words (PonteI18n.deviceWord). A server without /api/devices
// answers 404, and then /api/mesh is read into the same shape.
const DEVICES_REFRESH_MS = 30000;
let devicesLoadedAt = 0;

const headers = () => ({ Authorization: `Bearer ${token}`, 'Accept-Language': i18n.locale });

function fromDevices(body) {
  return body.devices.filter(device => device && device.id).map(device => ({
    id: device.id, ids: Array.isArray(device.ids) ? device.ids : [device.id], name: device.name || device.id,
    kind: device.kind, status: device.status, self: !!device.self,
    control: device.can?.control?.ok ? { ok: true } : { ok: false, why: device.can?.control?.why },
  }));
}

// The old answer, for a server that predates /api/devices: paired and online is
// the only way to control, as before.
function fromMesh(body) {
  const mesh = body?.mesh || body || {};
  const list = [];
  if (mesh.self) list.push({ id: mesh.self.id || '', ids: [mesh.self.id || '', 'self'], name: mesh.self.name, status: 'online', self: true, control: { ok: true } });
  for (const peer of Array.isArray(mesh.peers) ? mesh.peers : []) {
    if (!peer?.id) continue;
    const online = peer.online !== false, paired = peer.paired !== false;
    list.push({ id: peer.id, ids: [peer.id], name: peer.name || peer.id, status: online ? 'online' : 'offline', self: false,
      control: paired && online ? { ok: true } : { ok: false, why: paired ? 'OFFLINE' : 'NOT_PAIRED' } });
  }
  return list;
}

async function loadNodes({ discover = false } = {}) {
  devicesLoadedAt = performance.now();
  try {
    const response = await fetch(`/api/devices${discover ? '?discover=1' : ''}`, { headers: headers(), cache: 'no-store' });
    const body = response.ok ? await response.json() : null;
    if (body?.v === 1 && Array.isArray(body.devices)) nodes = fromDevices(body);
    else if (response.ok || response.status === 404) {
      const old = await fetch('/api/mesh', { headers: headers(), cache: 'no-store' });
      if (!old.ok) throw new Error(String(old.status));
      nodes = fromMesh(await old.json());
    } else throw new Error(String(response.status));
  } catch { nodes = []; }
  renderNodes();
}

// The device the page shows: `node=` may be an id, any of the device's ids or its
// name (the server's resolver takes all of them), and empty means this one.
function currentDevice() {
  if (!nodeId || nodeId === 'self') return nodes.find(device => device.self) || null;
  const wanted = nodeId.toLowerCase();
  return nodes.find(device => device.ids.includes(nodeId) || device.name.toLowerCase() === wanted)
    || (session?.node?.id ? nodes.find(device => device.id === session.node.id) : null) || null;
}

// One line per device: name, kind, state and, when it cannot be controlled, why.
function deviceLabel(device) {
  if (device.self) return t('{name} · este aparelho', { name: device.name });
  const why = device.control.ok ? '' : i18n.deviceWord('why', device.control.why);
  const parts = [device.name, i18n.deviceWord('kind', device.kind)];
  if (device.control.ok || device.control.why !== 'OFFLINE') parts.push(i18n.deviceWord('status', device.status));
  parts.push(why);
  return parts.filter(Boolean).join(' · ');
}

function renderNodes() {
  const select = $('#rd-node');
  const current = currentDevice();
  let entries, choices = 1;
  if (!nodes.some(device => device.self)) {
    // Without a list the only entry is the device this page talks to.
    entries = [option(nodeId, session?.node?.name || t('Este aparelho'), true)];
    select.title = '';
  } else {
    const entry = device => option(device.self ? '' : device.id, deviceLabel(device), device === current, !device.control.ok && device !== current);
    const can = nodes.filter(device => device.control.ok || device === current);
    const cannot = nodes.filter(device => !can.includes(device));
    entries = can.map(entry);
    choices = can.length;
    if (nodeId && !current) entries.push(option(nodeId, session?.node?.name || nodeId, true));
    if (cannot.length) entries.push(`<optgroup label="${i18n.escape(t('Sem controle daqui'))}">${cannot.map(entry).join('')}</optgroup>`);
    select.title = current ? deviceLabel(current) : '';
  }
  select.innerHTML = entries.join('');
  select.value = current ? (current.self ? '' : current.id) : nodeId;
  select.disabled = choices < 2;
}

function chooseNode(value) {
  if (value === nodeId) return;
  releaseControl();
  nodeId = value; wantedMonitor = '';
  history.replaceState(null, '', pageAddress());
  reconnectAttempt = 0;
  connect();
}

function chooseMonitor(name) {
  if (!session || !name || name === session.monitor) return;
  wantedMonitor = name;
  history.replaceState(null, '', pageAddress());
  waitingKey = true;
  send({ t: 'monitor', name });
}

// ---- input-to-photon probe (?probe=1, lab and notebook only) -----------------------------------

// Moves the absolute pointer 2 px and times the first decoded frame where the
// 24×24 patch around it changes; the pointer then goes back. Ten rounds.
function startProbe() {
  if (!session || probe) return;
  if (mode !== 'abs') setMode('abs');
  const point = lastMove || { x: 0.5, y: 0.5 };
  probe = { point, round: 0, results: [], phase: 'quiet', quiet: [], baseline: null, sentAt: 0 };
  send({ t: 'move', x: point.x, y: point.y });
  note(t('Sonda: medindo…'));
}

function probePatch(frame) {
  const width = frame.displayWidth, height = frame.displayHeight;
  const cx = Math.round(probe.point.x * width), cy = Math.round(probe.point.y * height);
  const x = Math.max(0, Math.min(width - PROBE_PATCH, cx - PROBE_PATCH / 2)), y = Math.max(0, Math.min(height - PROBE_PATCH, cy - PROBE_PATCH / 2));
  return sample(frame, x, y, PROBE_PATCH, PROBE_PATCH);
}

function probeFrame(frame, drawnAt) {
  const patch = probePatch(frame);
  if (!patch) { probe = null; lastProbe = t('indisponível'); return; }
  if (probe.phase === 'quiet') {
    // A few still frames tell how much the patch changes on its own.
    if (probe.baseline) probe.quiet.push(patchDifference(probe.baseline, patch));
    probe.baseline = patch;
    if (probe.quiet.length < 8) return;
    probe.noise = Math.max(...probe.quiet);
    if (probe.noise > 20) { finishProbe(t('fundo animado demais')); return; }
    probe.phase = 'wait';
    probe.moved = { x: Math.min(1, probe.point.x + 2 / frame.displayWidth), y: probe.point.y };
    probe.sentAt = nowEpoch();
    send({ t: 'move', x: probe.moved.x, y: probe.moved.y });
    return;
  }
  if (probe.phase === 'wait') {
    if (patchDifference(probe.baseline, patch) > Math.max(probe.noise * 3, 2)) {
      probe.results.push(drawnAt - probe.sentAt);
      send({ t: 'move', x: probe.point.x, y: probe.point.y });
      probe.round++;
      probe.phase = probe.round >= PROBE_ROUNDS ? 'done' : 'settle';
      probe.settleUntil = drawnAt + 150;
      if (probe.phase === 'done') finishProbe();
    } else if (drawnAt - probe.sentAt > 2000) finishProbe(t('nenhuma mudança em 2 s'));
    return;
  }
  if (probe.phase === 'settle' && drawnAt >= probe.settleUntil) { probe.phase = 'quiet'; probe.quiet = []; probe.baseline = null; }
}

function finishProbe(failure) {
  const results = probe.results.slice().sort((a, b) => a - b);
  // A failed run says so, even with a few rounds done: on a moving picture
  // (the lab pattern) those rounds timed the pattern, not the pointer.
  if (failure) lastProbe = results.length ? `${failure} (n=${results.length})` : failure;
  else if (results.length) {
    const mean = results.reduce((sum, value) => sum + value, 0) / results.length;
    lastProbe = `${ms(mean)} (p95 ${ms(results[Math.min(results.length - 1, Math.ceil(results.length * 0.95) - 1)])}, n=${results.length})`;
  } else lastProbe = t('sem resultado');
  window.ponteProbe = { results, failure: failure || null };
  probe = null;
  note(`${t('Sonda')}: ${lastProbe}`);
  renderStats();
}

// ---- settings --------------------------------------------------------------------------------------

// One place for what was spread over the bar: pointer, the switch shortcut,
// frame limit, clipboard, language and the technical numbers.
function openSettings(details = false) {
  if (engaged) disengage();
  renderSettings();
  const dialog = $('#rd-settings');
  if (!dialog.open) dialog.showModal();
  if (details) $('#rd-details').scrollIntoView?.({ block: 'start' });
}
function renderSettings() {
  renderKeyDetails();
  $('#rd-chord-action').value = chordAction;
  $('#rd-fps').value = String(fpsLimit);
  $('#rd-clipboard').checked = clipboardOn;
  $('#rd-clipboard').disabled = session ? !inputAllows('clipboard') : false;
  $('#rd-follow').checked = followOn;
}
function setChordAction(value) {
  chordAction = value === 'fullscreen' ? 'fullscreen' : 'window';
  try { localStorage.setItem(CHORD_KEY, chordAction); } catch {}
}
// The server reads maxFps only from the hello, so a new limit reconnects.
function setFpsLimit(value) {
  if (!FPS_CHOICES.includes(value) || value === fpsLimit) return;
  fpsLimit = value;
  try { localStorage.setItem(FPS_KEY, String(fpsLimit)); } catch {}
  if (socket) { reconnectAttempt = 0; connect(); }
}
function setClipboard(on) {
  clipboardOn = !!on;
  try { localStorage.setItem(CLIPBOARD_KEY, clipboardOn ? 'on' : 'off'); } catch {}
  if (!clipboardOn) pendingClip = null;
}
// The target decides when the focus moves, so this only tells it; the switch
// itself arrives as the next `ready`.
function setFollow(on) {
  followOn = !!on;
  try { localStorage.setItem(FOLLOW_KEY, followOn ? 'on' : 'off'); } catch {}
  if (session) send({ t: 'follow', on: followOn });
}

// ---- wiring -----------------------------------------------------------------------------------------

function start() {
  const stage = $('#rd-stage');
  stage.addEventListener('mousedown', mouseDown);
  stage.addEventListener('wheel', wheel, { passive: false });
  stage.addEventListener('dblclick', cornerToggle);
  window.addEventListener('mousemove', mouseMove);
  window.addEventListener('mouseup', mouseUp);
  // No context menu, no middle-click autoscroll, no back/forward from the side buttons.
  for (const name of ['contextmenu', 'auxclick']) window.addEventListener(name, event => { if (!event.target?.closest?.('.rd-bar')) event.preventDefault(); });
  window.addEventListener('keydown', keyEvent, true);
  window.addEventListener('keyup', keyEvent, true);
  window.addEventListener('blur', () => { localPressed.clear(); switchKeys.clear(); if (session) releaseControl(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && session) { localPressed.clear(); switchKeys.clear(); releaseControl(); } });
  window.addEventListener('focus', () => { if (engaged) clipboardOut(); });
  window.addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', () => {
    const full = !!document.fullscreenElement;
    document.body.classList.toggle('fullscreen', full);
    document.body.classList.remove('bar-peek');
    // Leaving full screen (Esc held 2 s with the keyboard lock) releases.
    if (!full && engaged) releaseControl();
    renderControl();
    layout();
  });
  document.addEventListener('pointerlockchange', () => {
    // Esc drops the pointer lock outside full screen: that is a release too.
    if (!document.pointerLockElement && engaged && mode === 'rel' && !document.fullscreenElement) releaseControl();
  });
  $('#rd-bar').addEventListener('mouseleave', () => document.body.classList.remove('bar-peek'));
  // A click on the bar gives the keys back to this device, except on the
  // indicator, whose own click is the switch.
  $('#rd-bar').addEventListener('mousedown', event => { if (engaged && !event.target?.closest?.('#rd-control')) disengage(); });
  $('#rd-control').addEventListener('click', () => { if (engaged) releaseControl(); else takeControl(); });
  $('#rd-link').addEventListener('click', () => openSettings(true));
  $('#rd-settings-open').addEventListener('click', () => openSettings());
  $('#rd-settings-close').addEventListener('click', () => $('#rd-settings').close());
  $('#rd-chord-action').addEventListener('change', event => setChordAction(event.target.value));
  $('#rd-fps').addEventListener('change', event => setFpsLimit(Number(event.target.value)));
  $('#rd-clipboard').addEventListener('change', event => setClipboard(event.target.checked));
  $('#rd-follow').addEventListener('change', event => setFollow(event.target.checked));
  $('#rd-mode-abs').addEventListener('click', () => setMode('abs'));
  $('#rd-mode-rel').addEventListener('click', () => setMode('rel'));
  $('#rd-fullscreen').addEventListener('click', enterFullscreen);
  $('#rd-monitor').addEventListener('change', event => { event.target.blur(); chooseMonitor(event.target.value); });
  $('#rd-node').addEventListener('change', event => { event.target.blur(); chooseNode(event.target.value); });
  $('#rd-retry').addEventListener('click', () => { reconnectAttempt = 0; connect(); });
  $('#rd-probe').hidden = !probeEnabled;
  $('#rd-probe').addEventListener('click', startProbe);
  document.addEventListener('ponte-language-change', () => { renderStats(); renderKeyDetails(); renderControl(); renderNodes(); if (session) renderLink(); });
  renderMode();
  renderSettings();
  renderControl();
  renderNodes();
  layout();
  setInterval(tick, 1000);
  connect();
  loadNodes({ discover: true });
}

start();

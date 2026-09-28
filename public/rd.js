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
const HEADER_BYTES = 16;
const MAX_DECODE_QUEUE = 2;
const WHEEL_UNIT = 120;
const CLIP_LIMIT = 1024 * 1024;
const STATS_SPAN = 5000;
const ESC_HOLD_MS = 2000;
const RECONNECT_STEPS = [500, 1000, 2000, 4000, 8000];
const PROBE_PATCH = 24;
const PROBE_ROUNDS = 10;
const MODIFIER_KIND = { ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt', ShiftLeft: 'shift', ShiftRight: 'shift' };

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

// Ctrl+Alt+Shift together and nothing else releases the control.
function isReleaseChord(pressed) {
  const kinds = new Set();
  for (const code of pressed) {
    const kind = MODIFIER_KIND[code];
    if (!kind) return false;
    kinds.add(kind);
  }
  return kinds.size === 3;
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
// along the top row starting at (x, y), most significant bit first, white = 1.
// It carries the low bits of the wall clock in ms; the high bits come from the
// frame's own send time. The lab server describes it in ready.lab.stripe.
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
let hardware = '';
const inflight = new Map();    // seq → { sendTime, recvAt }
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
  session = null; littleEndian = null; waitingKey = true; inflight.clear(); pingSamples.length = 0;
  overlay(reconnectAttempt ? t('Reconectando…') : t('Conectando…'));
  const current = new WebSocket(socketAddress());
  current.binaryType = 'arraybuffer';
  socket = current;
  current.addEventListener('open', () => {
    if (socket !== current) return;
    const hello = { t: 'hello', v: 1, token, maxFps: 60 };
    if (wantedMonitor) hello.monitor = wantedMonitor;
    current.send(JSON.stringify(hello));
  });
  current.addEventListener('message', event => { if (socket === current) receive(event.data); });
  current.addEventListener('close', event => { if (socket === current) closed(event); });
}

function closed(event) {
  socket = null; session = null;
  dropInput();
  closeDecoder();
  if (event && (event.code === 4401 || event.code === 4403 || event.code === 1008)) stopped ||= 'auth';
  if (stopped === 'taken') { overlay(t('Outro aparelho assumiu o controle deste PC.'), true); return; }
  if (stopped === 'auth') { overlay(stopMessage || t('A chave foi recusada. Pareie de novo com ./ponte rd.'), true); return; }
  const delay = RECONNECT_STEPS[Math.min(reconnectAttempt, RECONNECT_STEPS.length - 1)];
  reconnectAttempt++;
  overlay(t('Sem conexão. Tentando de novo em {seconds} s…', { seconds: Math.ceil(delay / 1000) }));
  reconnectTimer = setTimeout(connect, delay);
}

function receive(data) {
  if (typeof data !== 'string') { video(data); return; }
  let message;
  try { message = JSON.parse(data); } catch { return; }
  switch (message.t) {
    case 'ready': ready(message); break;
    case 'pong': pong(message); break;
    case 'clip': clipboardIn(message.text); break;
    case 'taken':
      // Another client took this target: no automatic reconnect, or the two
      // would keep taking it from each other.
      stopped = 'taken';
      releaseControl(false);
      try { socket.close(1000); } catch {}
      break;
    case 'error':
      stopMessage = i18n.apiMessage(message.code, message.parameters || {}, message.message || message.code || t('O PC recusou a sessão.'));
      if (['PAIRING_REQUIRED', 'UNAUTHORIZED', 'FORBIDDEN', 'PEER_REVOKED'].includes(message.code)) stopped = 'auth';
      else status(stopMessage);
      break;
  }
}

function ready(message) {
  const first = !session;
  const previous = session;
  session = message;
  reconnectAttempt = 0;
  overlay('');
  status('');
  if (message.width && message.height) setVideoSize(message.width, message.height);
  renderMonitors();
  renderNodes();
  renderMode();
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
  decoder = null; configuring = null; queuedChunks = []; waitingKey = true;
}

async function configureDecoder(codec) {
  closeDecoder();
  const base = { codec, optimizeForLatency: true };
  let config = { ...base, hardwareAcceleration: 'prefer-hardware' };
  const attempt = configuring = (async () => {
    try { if (!(await VideoDecoder.isConfigSupported(config)).supported) config = base; } catch { config = base; }
  })();
  await attempt;
  if (configuring !== attempt) return;
  startDecoder(config);
  configuring = null;
  const queued = queuedChunks; queuedChunks = [];
  for (const chunk of queued) decode(chunk);
}

function startDecoder(config) {
  decoderConfig = config;
  hardware = config.hardwareAcceleration ? 'hw' : 'sw';
  waitingKey = true;
  const current = new VideoDecoder({
    output: frame => { if (decoder === current) draw(frame); else frame.close(); },
    error: error => {
      if (decoder !== current) return;
      decoder = null;
      // A hardware decoder that fails at run time falls back to software; the
      // next keyframe restarts the picture.
      if (decoderConfig?.hardwareAcceleration) { const { hardwareAcceleration, ...rest } = decoderConfig; startDecoder(rest); }
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
  const chunk = { ...header, recvAt: nowEpoch() };
  if (configuring) {
    if (chunk.key) queuedChunks = [chunk]; else if (queuedChunks.length && queuedChunks.length < 8) queuedChunks.push(chunk); else framesDropped++;
    return;
  }
  decode(chunk);
}

// A late frame is not worth drawing: with more than two frames waiting in the
// decoder, deltas are dropped until the next keyframe, which restarts clean.
function decode(chunk) {
  if (!decoder || decoder.state !== 'configured') { waitingKey = true; framesDropped++; return; }
  if (!chunk.key) {
    if (waitingKey || decoder.decodeQueueSize > MAX_DECODE_QUEUE) { waitingKey = true; framesDropped++; return; }
  } else if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
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
  canvasContext ||= canvas.getContext('2d', { desynchronized: true, alpha: false });
  canvasContext.drawImage(frame, 0, 0, width, height);
  const drawnAt = nowEpoch();
  framesDrawn++;
  if (info) frameLatency.push({ at: drawnAt, value: drawnAt + clockOffset - info.sendTime });
  const stripe = session?.lab?.stripe;
  if (stripe && info) {
    const pixels = sample(frame, stripe.x || 0, stripe.y || 0, stripe.bits * stripe.cell, 1);
    if (pixels) glassLatency.push({ at: drawnAt, value: drawnAt + clockOffset - stripeTime(pixels, stripe, info.sendTime) });
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
  ping();
  const frame = windowStats(frameLatency, now), glass = windowStats(glassLatency, now);
  const report = { t: 'stats', fps: round(meters.fps), kbps: Math.round(meters.kbps), rtt: rtt === null ? null : round(rtt), queue: decoder?.decodeQueueSize || 0, drops: meters.drops };
  if (frame) { report.latency = round(frame.mean); report.p95 = round(frame.p95); }
  if (glass) { report.glass = round(glass.mean); report.glassP95 = round(glass.p95); }
  send(report);
  window.ponteRdStats = { ...report, hardware, keyboardLock, engaged, mode, monitor: session.monitor, probe: lastProbe };
  renderStats(frame, glass);
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

// ---- control state -------------------------------------------------------------------

const inputAllows = kind => session?.input?.[kind] !== false;

function engage() {
  if (engaged || !session) return;
  engaged = true;
  document.body.classList.add('controlling');
  clipboardOut();
}

// Drop everything held on the remote side: blur, hidden page, disconnect.
function dropInput() {
  clearTimeout(escTimer);
  const held = pressed.size || buttonsDown.size;
  pressed.clear(); buttonsDown.clear();
  pendingMove = null; pendingRel.dx = pendingRel.dy = 0; pendingWheel.dx = pendingWheel.dy = 0;
  return held;
}
function releaseRemote() { dropInput(); send({ t: 'release' }); }

// Keys and buttons stop going out; full screen stays (the bar was clicked).
function disengage(tell = true) {
  if (tell) releaseRemote(); else dropInput();
  engaged = false;
  document.body.classList.remove('controlling');
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
  try { await stage.requestPointerLock({ unadjustedMovement: true }); }
  catch (error) {
    // Raw movement is not available everywhere (NotSupportedError): plain lock.
    try { await stage.requestPointerLock(); } catch { note(t('O navegador recusou travar o ponteiro.')); }
  }
}

async function enterFullscreen() {
  if (!session) return;
  engage();
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { note(t('O navegador recusou a tela cheia.')); return; }
  // No key list: every key, including Super, Alt+Tab and Esc (held 2 s leaves).
  if (!navigator.keyboard?.lock) keyboardLock = 'unsupported';
  else try { await navigator.keyboard.lock(); keyboardLock = 'locked'; } catch { keyboardLock = 'refused'; note(t('Sem trava de teclado: atalhos do sistema continuam no seu PC.')); }
  if (mode === 'rel') lockPointer();
}

// ---- keyboard ---------------------------------------------------------------------------

function keyEvent(event) {
  if (!engaged || !session || !inputAllows('keys')) return;
  if (event.target?.closest?.('.rd-bar')) return;
  event.preventDefault();
  event.stopPropagation?.();
  const code = event.code;
  if (!code || code === 'Unidentified') return;
  if (event.type === 'keydown') {
    // The target repeats a held key by itself; the client's auto-repeat stays home.
    if (event.repeat) return;
    pressed.add(code);
    send({ t: 'key', code, down: true });
    if (isReleaseChord(pressed)) { releaseControl(); note(t('Controle solto.')); return; }
    if (code === 'Escape') { clearTimeout(escTimer); escTimer = setTimeout(() => { releaseControl(); note(t('Controle solto.')); }, ESC_HOLD_MS); }
  } else {
    if (code === 'Escape') clearTimeout(escTimer);
    if (!pressed.delete(code)) return;
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
  if (!engaged) engage();
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

async function clipboardOut() {
  if (!session || !inputAllows('clipboard') || !navigator.clipboard?.readText) return;
  if (pendingClip !== null) await clipboardWrite();
  let text;
  try { text = await navigator.clipboard.readText(); } catch { return; }
  if (typeof text !== 'string' || !text || text === lastClip) return;
  if (utf8Length(text) > CLIP_LIMIT) { note(t('Área de transferência grande demais para enviar (máx. 1 MiB).')); return; }
  lastClip = text;
  if (send({ t: 'clip', text })) note(t('Área de transferência enviada ({count} caracteres).', { count: text.length }));
}

async function clipboardIn(text) {
  if (typeof text !== 'string' || text === lastClip) return;
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

// Other nodes come from the home node (DESENHO §4). Until /api/mesh exists the
// list is just this node.
async function loadNodes() {
  try {
    const response = await fetch('/api/mesh', { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': i18n.locale }, cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    const mesh = body?.mesh || body || {};
    const self = mesh.self ? { id: mesh.self.id || '', name: mesh.self.name, os: mesh.self.os, online: true, self: true } : null;
    const peers = Array.isArray(mesh.peers) ? mesh.peers.filter(peer => peer && peer.id && peer.paired !== false) : [];
    nodes = [...(self ? [self] : []), ...peers.map(peer => ({ id: peer.id, name: peer.name || peer.id, os: peer.os, online: peer.online !== false }))];
  } catch { nodes = []; }
  renderNodes();
}

function renderNodes() {
  const select = $('#rd-node');
  const selfNode = nodes.find(node => node.self);
  const target = session?.node;
  let entries;
  if (!selfNode) {
    // Without the mesh the only entry is the node this page talks to.
    entries = [option(nodeId, target?.name || t('Este aparelho'), true)];
  } else {
    entries = nodes.map(node => {
      const label = node.self ? t('{name} (este)', { name: node.name }) : node.online ? node.name : t('{name} (offline)', { name: node.name });
      return option(node.self ? '' : node.id, label, node.self ? !nodeId || nodeId === node.id : nodeId === node.id, !node.self && !node.online);
    });
    if (nodeId && !nodes.some(node => node.id === nodeId)) entries.push(option(nodeId, target?.name || nodeId, true));
  }
  select.innerHTML = entries.join('');
  select.value = selfNode && nodeId === selfNode.id ? '' : nodeId;
  select.disabled = select.querySelectorAll('option').length < 2;
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
    if (probe.quiet.length < 4) return;
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
  if (results.length) {
    const mean = results.reduce((sum, value) => sum + value, 0) / results.length;
    lastProbe = `${ms(mean)} (p95 ${ms(results[Math.min(results.length - 1, Math.ceil(results.length * 0.95) - 1)])}, n=${results.length})`;
  } else lastProbe = failure || t('sem resultado');
  window.ponteProbe = { results, failure: failure || null };
  probe = null;
  note(`${t('Sonda')}: ${lastProbe}`);
  renderStats();
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
  window.addEventListener('blur', () => { if (session) releaseRemote(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && session) releaseRemote(); });
  window.addEventListener('focus', () => { if (engaged) clipboardOut(); });
  window.addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', () => {
    const full = !!document.fullscreenElement;
    document.body.classList.toggle('fullscreen', full);
    document.body.classList.remove('bar-peek');
    // Leaving full screen (Esc held 2 s with the keyboard lock) releases.
    if (!full && engaged) releaseControl();
    layout();
  });
  document.addEventListener('pointerlockchange', () => {
    // Esc drops the pointer lock outside full screen: that is a release too.
    if (!document.pointerLockElement && engaged && mode === 'rel' && !document.fullscreenElement) releaseControl();
  });
  $('#rd-bar').addEventListener('mouseleave', () => document.body.classList.remove('bar-peek'));
  $('#rd-bar').addEventListener('mousedown', () => { if (engaged) disengage(); });
  $('#rd-mode-abs').addEventListener('click', () => setMode('abs'));
  $('#rd-mode-rel').addEventListener('click', () => setMode('rel'));
  $('#rd-fullscreen').addEventListener('click', enterFullscreen);
  $('#rd-monitor').addEventListener('change', event => chooseMonitor(event.target.value));
  $('#rd-node').addEventListener('change', event => chooseNode(event.target.value));
  $('#rd-retry').addEventListener('click', () => { reconnectAttempt = 0; connect(); });
  $('#rd-probe').hidden = !probeEnabled;
  $('#rd-probe').addEventListener('click', startProbe);
  document.addEventListener('ponte-language-change', () => renderStats());
  renderMode();
  renderNodes();
  layout();
  setInterval(tick, 1000);
  connect();
  loadNodes();
}

start();

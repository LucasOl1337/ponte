import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';
import { startFakeRd, accessUnits, videoMessage } from './helpers/rd-fake-server.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, client] = await Promise.all(['rd.html', 'i18n.js', 'rd.js'].map(read));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const TOKEN = 'synthetic-test-token';

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; this.listeners = {}; FakeSocket.all.push(this); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  emit(name, event = {}) { for (const callback of this.listeners[name] || []) callback(event); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code }); }
  open() { this.readyState = 1; this.emit('open'); }
  message(data) { this.emit('message', { data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) }); }
}

class FakeDecoder {
  static all = [];
  static hardware = true;
  static isConfigSupported = async config => ({ supported: !config.hardwareAcceleration || FakeDecoder.hardware, config });
  constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; this.resets = 0; FakeDecoder.all.push(this); }
  configure(config) { this.config = config; this.state = 'configured'; }
  decode(chunk) { this.chunks.push(chunk); }
  reset() { this.resets++; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
  close() { this.state = 'closed'; }
}
class FakeChunk { constructor(init) { Object.assign(this, init); } }

const readyMessage = (extra = {}) => ({ t: 'ready', v: 1, node: { id: '0123456789abcdef', name: 'notebook-teste', os: 'linux' }, monitors: [{ name: 'LAB-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, focused: true }, { name: 'LAB-2', x: 1920, y: 0, width: 2560, height: 1440, scale: 1, focused: false }], monitor: 'LAB-1', width: 1920, height: 1080, fps: 60, codec: 'avc1.640034', input: { abs: true, rel: true, keys: true, clipboard: true }, ...extra });

function harness({ hash = `#pair=${TOKEN}&node=feedfacecafebeef`, search = '', stored = {}, mesh = null, clipboard = '', focused = true, permission = 'granted' } = {}) {
  FakeSocket.all = []; FakeDecoder.all = [];
  const document = makeDocument(html), window = makeWindow();
  const saved = new Map(Object.entries(stored));
  const timers = [], frames = [], history = [];
  const clip = { text: clipboard, writes: [] };
  const keyboard = { locks: [], lock(...args) { this.locks.push(args); return Promise.resolve(); }, unlock() { this.unlocked = true; } };
  const stage = document.querySelector('#rd-stage');
  stage.clientWidth = 1000; stage.clientHeight = 500; stage._left = 0; stage._top = 44;
  const canvas = document.querySelector('#rd-canvas');
  const drawn = [];
  canvas.getContext = (kind, options) => { canvas.contextOptions = options; return { drawImage: (...args) => drawn.push(args) }; };
  stage.requestPointerLock = options => { stage.lockRequests = [...(stage.lockRequests || []), options]; document.pointerLockElement = stage; return Promise.resolve(); };
  document.hasFocus = () => focused;
  document.pointerLockElement = null; document.fullscreenElement = null;
  document.documentElement.requestFullscreen = options => { document.fullscreenElement = document.documentElement; document.fullscreenOptions = options; document.dispatchEvent({ type: 'fullscreenchange' }); return Promise.resolve(); };
  document.exitFullscreen = () => { document.fullscreenElement = null; document.dispatchEvent({ type: 'fullscreenchange' }); return Promise.resolve(); };
  document.exitPointerLock = () => { document.pointerLockElement = null; document.dispatchEvent({ type: 'pointerlockchange' }); };
  const fetches = [];
  let clock = 1_000_000;
  const context = vm.createContext({
    document, window, history: { replaceState: (_, __, url) => history.push(url) },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser', keyboard, permissions: { query: async ({ name }) => ({ state: name === 'clipboard-read' ? h.permission : 'denied' }) }, clipboard: { readText: async () => clip.text, writeText: async text => { clip.writes.push(text); clip.text = text; } } },
    location: { protocol: 'http:', host: '127.0.0.1:8787', pathname: '/rd.html', search, hash },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    performance: { timeOrigin: 1_700_000_000_000, now: () => clock },
    WebSocket: FakeSocket, VideoDecoder: FakeDecoder, EncodedVideoChunk: FakeChunk,
    URLSearchParams, Intl, Date, Error, TypeError, TextEncoder, Uint8Array, DataView, ArrayBuffer, Map, Set, JSON, Math, Number, String, Promise, Array, Object,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: (callback, ms) => { timers.push({ callback, ms, interval: true }); return timers.length; }, clearInterval() {},
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    fetch: async (url, options) => { fetches.push({ url, options }); return mesh ? { ok: true, json: async () => mesh } : { ok: false, status: 404, json: async () => ({}) }; },
  });
  vm.runInContext(runtime, context); vm.runInContext(client, context);
  const h = {
    permission,
    document, window, saved, timers, frames, history, clip, keyboard, stage, canvas, drawn, fetches, context,
    el: selector => document.querySelector(selector),
    run: source => vm.runInContext(source, context),
    get socket() { return FakeSocket.all.at(-1); },
    get decoder() { return FakeDecoder.all.at(-1); },
    advance: ms => { clock += ms; },
    sent: type => h.socket.sent.filter(message => !type || message.t === type),
    input: () => h.socket.sent.filter(message => !['hello', 'ping', 'stats'].includes(message.t)),
    raf: () => { const due = frames.splice(0); due.forEach(callback => callback()); },
    timer: ms => timers.find(timer => timer.ms === ms && !timer.cleared && !timer.interval),
    async connect(extra) { h.socket.open(); h.socket.message(readyMessage(extra)); await flush(); return h; },
    mouse: (type, target, fields) => { const event = { type, target, button: 0, clientX: 0, clientY: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields }; target.dispatchEvent(event); if (target !== window && ['mousemove', 'mouseup', 'contextmenu', 'auxclick'].includes(type)) window.dispatchEvent(event); return event; },
    key: (type, code, fields = {}) => { const event = { type, code, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...fields }; window.dispatchEvent(event); return event; },
  };
  return h;
}

// Stage 1000×500 at y=44; a 1920×1080 picture fits at 888.9×500, left 55.6.
const videoLeft = (1000 - 1920 * 500 / 1080) / 2;

test('the pairing hash is saved and stripped, and hello goes to /api/rd on the page host with the token and node', async () => {
  const h = harness({ search: '?probe=1' });
  assert.equal(h.saved.get('ponte-pair-token'), TOKEN);
  assert.equal(h.history[0], '/rd.html?node=feedfacecafebeef&probe=1');
  assert.equal(h.socket.url, 'ws://127.0.0.1:8787/api/rd?node=feedfacecafebeef');
  h.socket.open();
  assert.deepEqual(h.socket.sent[0], { t: 'hello', v: 1, token: TOKEN, maxFps: 60 });
  assert.equal(h.el('#rd-probe').hidden, false);
  const again = harness({ hash: '', search: '?monitor=LAB-2', stored: { 'ponte-pair-token': 'stored-token-0123456789abcdef0123456789' } });
  again.socket.open();
  assert.deepEqual(again.socket.sent[0], { t: 'hello', v: 1, token: 'stored-token-0123456789abcdef0123456789', maxFps: 60, monitor: 'LAB-2' });
  assert.equal(again.el('#rd-probe').hidden, true);
  const none = harness({ hash: '' });
  assert.equal(FakeSocket.all.length, 0);
  assert.match(none.el('#rd-message').textContent, /no key yet/);
});

test('letterbox: pointer maps into the picture, clamps in the bars, and a click in the bars is not sent', async () => {
  const h = await harness().connect();
  const box = JSON.parse(JSON.stringify(h.run('fitRect(1000, 500, 1920, 1080)')));
  assert.equal(box.top, 0); assert.equal(box.height, 500); assert.ok(Math.abs(box.left - videoLeft) < 1e-9);
  const tall = h.run('fitRect(1000, 1000, 1920, 1080)');
  for (const [name, value] of Object.entries({ left: 0, top: 218.75, width: 1000, height: 562.5 })) assert.ok(Math.abs(tall[name] - value) < 1e-9, name);
  assert.equal(h.canvas.style.left, `${videoLeft}px`);
  // Engage with a click in the middle of the picture: move first, then the button.
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 44 + 250, button: 0 });
  h.mouse('mouseup', h.stage, { clientX: 500, clientY: 44 + 250, button: 0 });
  assert.deepEqual(h.input(), [{ t: 'move', x: 0.5, y: 0.5 }, { t: 'btn', b: 0, down: true }, { t: 'btn', b: 0, down: false }]);
  // The corner of the picture, and a point in the left bar clamps to x = 0.
  h.mouse('mousemove', h.stage, { clientX: videoLeft + 888.8888888888889, clientY: 44 });
  h.raf();
  h.mouse('mousemove', h.stage, { clientX: 10, clientY: 44 + 125 });
  h.raf();
  assert.deepEqual(h.input().slice(3), [{ t: 'move', x: 1, y: 0 }, { t: 'move', x: 0, y: 0.25 }]);
  // A press in the bar is ignored, and so is its release.
  h.mouse('mousedown', h.stage, { clientX: 10, clientY: 100, button: 0 });
  h.mouse('mouseup', h.stage, { clientX: 10, clientY: 100, button: 0 });
  assert.equal(h.input().length, 5);
});

test('moves coalesce to one per animation frame, but a button is never delayed and follows the latest position', async () => {
  const h = await harness().connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 });
  h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  const before = h.input().length;
  for (const x of [300, 310, 320, 330]) h.mouse('mousemove', h.stage, { clientX: x, clientY: 294 });
  assert.equal(h.input().length, before, 'nothing before the frame');
  assert.equal(h.frames.length, 1, 'one frame requested');
  h.mouse('mousemove', h.stage, { clientX: 340, clientY: 294 });
  h.mouse('mousedown', h.stage, { clientX: 340, clientY: 294, button: 2 });
  const sent = h.input().slice(before);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].t, 'move'); assert.ok(Math.abs(sent[0].x - (340 - videoLeft) / (1920 * 500 / 1080)) < 1e-5);
  assert.deepEqual(sent[1], { t: 'btn', b: 2, down: true });
  h.raf();
  assert.equal(h.input().length, before + 2, 'the frame has nothing left to send');
});

test('buttons 0–4 go out, side buttons and the context menu never reach the browser, and other buttons are ignored', async () => {
  const h = await harness().connect();
  for (const button of [0, 1, 2, 3, 4, 5]) {
    const down = h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294, button });
    const up = h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294, button });
    assert.equal(down.defaultPrevented, true);
    assert.equal(up.defaultPrevented, button <= 4, `button ${button} mouseup`);
  }
  assert.deepEqual(h.sent('btn').map(message => `${message.b}${message.down ? 'v' : '^'}`), ['0v', '0^', '1v', '1^', '2v', '2^', '3v', '3^', '4v', '4^']);
  assert.equal(h.mouse('contextmenu', h.stage, {}).defaultPrevented, true);
  assert.equal(h.mouse('auxclick', h.stage, { button: 3 }).defaultPrevented, true);
});

test('wheel: 120 per notch for pixel, line and page deltas and for wheelDelta, high resolution accumulates', async () => {
  const h = await harness().connect();
  const units = event => JSON.parse(JSON.stringify(h.run(`wheelUnits(${JSON.stringify(event)})`)));
  assert.deepEqual(units({ deltaMode: 0, deltaX: 0, deltaY: 100 }), { dx: 0, dy: 120 });
  assert.deepEqual(units({ deltaMode: 1, deltaX: 0, deltaY: -3 }), { dx: 0, dy: -120 });
  assert.deepEqual(units({ deltaMode: 2, deltaX: 1, deltaY: 0 }), { dx: 120, dy: 0 });
  assert.deepEqual(units({ deltaMode: 0, deltaX: 0, deltaY: 53, wheelDeltaX: 0, wheelDeltaY: -120 }), { dx: 0, dy: 120 });
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 });
  h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  const wheel = fields => { const event = { type: 'wheel', target: h.stage, deltaMode: 0, deltaX: 0, deltaY: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields }; h.stage.dispatchEvent(event); return event; };
  assert.equal(wheel({ deltaY: 100 }).defaultPrevented, true);
  wheel({ deltaMode: 1, deltaY: 3 });
  h.raf();
  // Touchpad-sized steps: 12.5 px → 15 units each, sent whole, remainder kept.
  wheel({ deltaY: 12.5 }); h.raf();
  wheel({ deltaY: 12.5 }); h.raf();
  wheel({ deltaY: 1 }); h.raf();
  wheel({ deltaY: -0.5 }); h.raf();
  assert.deepEqual(h.sent('wheel'), [{ t: 'wheel', dx: 0, dy: 240 }, { t: 'wheel', dx: 0, dy: 15 }, { t: 'wheel', dx: 0, dy: 15 }, { t: 'wheel', dx: 0, dy: 1 }]);
});

test('keys: physical code up and down, no client auto-repeat, everything prevented while controlling, nothing before', async () => {
  const h = await harness().connect();
  const early = h.key('keydown', 'KeyA');
  assert.equal(early.defaultPrevented, false, 'not controlling yet');
  assert.equal(h.sent('key').length, 0);
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 });
  h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  for (const code of ['Tab', 'F5', 'MetaLeft']) { assert.equal(h.key('keydown', code).defaultPrevented, true); h.key('keyup', code); }
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyW'); h.key('keyup', 'KeyW'); h.key('keyup', 'ControlLeft');
  h.key('keydown', 'KeyQ');
  const repeat = h.key('keydown', 'KeyQ', { repeat: true });
  assert.equal(repeat.defaultPrevented, true);
  h.key('keyup', 'KeyQ');
  h.key('keyup', 'KeyZ'); // never sent down: not sent up either
  assert.deepEqual(h.sent('key').map(message => `${message.code}${message.down ? 'v' : '^'}`), ['Tabv', 'Tab^', 'F5v', 'F5^', 'MetaLeftv', 'MetaLeft^', 'ControlLeftv', 'KeyWv', 'KeyW^', 'ControlLeft^', 'KeyQv', 'KeyQ^']);
});

test('Ctrl+Alt+Shift alone releases the control; with another key held it is just a shortcut', async () => {
  const h = await harness().connect();
  assert.equal(h.run(`isReleaseChord(new Set(['ControlLeft','AltRight','ShiftLeft']))`), true);
  assert.equal(h.run(`isReleaseChord(new Set(['ControlLeft','AltLeft','ShiftLeft','KeyT']))`), false);
  assert.equal(h.run(`isReleaseChord(new Set(['ControlLeft','ShiftLeft']))`), false);
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'KeyT'); h.key('keydown', 'ControlLeft'); h.key('keydown', 'AltLeft'); h.key('keydown', 'ShiftLeft');
  assert.equal(h.sent('release').length, 0);
  for (const code of ['ShiftLeft', 'AltLeft', 'ControlLeft', 'KeyT']) h.key('keyup', code);
  h.key('keydown', 'ControlRight'); h.key('keydown', 'AltLeft'); h.key('keydown', 'ShiftRight');
  assert.equal(h.sent('release').length, 1);
  assert.equal(h.run('engaged'), false);
  assert.equal(h.document.body.classList.contains('controlling'), false);
  // Once released, keys stay in this browser.
  const after = h.key('keydown', 'KeyA');
  assert.equal(after.defaultPrevented, false);
  assert.equal(h.sent('key').filter(message => message.code === 'KeyA').length, 0);
});

test('holding Esc for 2 s releases; a short Esc is just a key', async () => {
  const h = await harness().connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'Escape'); h.key('keyup', 'Escape');
  assert.equal(h.timers.filter(timer => timer.ms === 2000 && !timer.cleared).length, 0);
  h.key('keydown', 'Escape');
  h.timer(2000).callback();
  assert.equal(h.sent('release').length, 1);
  assert.equal(h.run('engaged'), false);
});

test('losing focus or hiding the page sends release; control resumes on focus and the clipboard goes out if it changed', async () => {
  const h = await harness({ clipboard: 'first copy' }).connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); await flush();
  assert.deepEqual(h.sent('clip'), [{ t: 'clip', text: 'first copy' }]);
  h.key('keydown', 'ShiftLeft');
  h.window.dispatchEvent({ type: 'blur' });
  assert.equal(h.sent('release').length, 1);
  h.document.hidden = true; h.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.sent('release').length, 2);
  // Nothing held after the release: the Shift keyup is not sent.
  h.key('keyup', 'ShiftLeft');
  assert.equal(h.sent('key').filter(message => !message.down).length, 0);
  h.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(h.sent('clip').length, 1, 'same clipboard is not sent twice');
  h.clip.text = 'second copy';
  h.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.deepEqual(h.sent('clip').at(-1), { t: 'clip', text: 'second copy' });
  // From the target: written with focus, and not echoed back.
  h.socket.message({ t: 'clip', text: 'from the target' }); await flush();
  assert.deepEqual(h.clip.writes, ['from the target']);
  h.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(h.sent('clip').length, 2);
  assert.match(h.el('#rd-note').textContent, /Clipboard received \(15 characters\)/);
});

test('the clipboard permission prompt only comes from a plain click, never on entering full screen', async () => {
  const h = await harness({ clipboard: 'copied', permission: 'prompt' }).connect();
  await h.run('enterFullscreen()'); await flush();
  assert.equal(h.sent('clip').length, 0, 'no prompt in full screen (it would take the focus and drop it)');
  h.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(h.sent('clip').length, 0);
  h.run('releaseControl()');
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); await flush();
  assert.deepEqual(h.sent('clip'), [{ t: 'clip', text: 'copied' }]);
  const denied = await harness({ clipboard: 'copied', permission: 'denied' }).connect();
  denied.mouse('mousedown', denied.stage, { clientX: 500, clientY: 294 }); await flush();
  assert.equal(denied.sent('clip').length, 0);
});

test('a clipboard from the target waits for focus before being written', async () => {
  const h = await harness({ focused: false }).connect();
  h.socket.message({ t: 'clip', text: 'later' }); await flush();
  assert.deepEqual(h.clip.writes, []);
  h.document.hasFocus = () => true;
  h.run('engage()'); await flush();
  assert.deepEqual(h.clip.writes, ['later']);
  assert.equal(h.sent('clip').length, 0);
});

test('the decoder: annex B without description, hardware preferred with fallback, late deltas dropped until a keyframe', async () => {
  FakeDecoder.hardware = false;
  const soft = await harness().connect();
  assert.deepEqual({ ...soft.decoder.config }, { codec: 'avc1.640034', optimizeForLatency: true, hardwareAcceleration: 'prefer-software' });
  FakeDecoder.hardware = true;
  const h = await harness().connect();
  assert.deepEqual({ ...h.decoder.config }, { codec: 'avc1.640034', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  assert.equal('description' in h.decoder.config, false);
  const now = 1_700_000_000_000 + 1_000_000;
  const unit = (key, seq) => { const buffer = videoMessage({ key, data: Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, seq]) }, seq, now - 5); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length); };
  h.socket.message(unit(false, 0));
  assert.equal(h.decoder.chunks.length, 0, 'a delta before any keyframe is useless');
  h.socket.message(unit(true, 1)); h.socket.message(unit(false, 2));
  assert.deepEqual(h.decoder.chunks.map(chunk => [chunk.type, chunk.timestamp]), [['key', 1], ['delta', 2]]);
  assert.deepEqual([...h.decoder.chunks[0].data], [0, 0, 0, 1, 0x65, 1]);
  h.decoder.decodeQueueSize = 3;
  h.socket.message(unit(false, 3));
  h.decoder.decodeQueueSize = 0;
  h.socket.message(unit(false, 4));
  assert.equal(h.decoder.chunks.length, 2, 'dropped the late delta and the ones after it');
  h.decoder.decodeQueueSize = 3;
  h.socket.message(unit(true, 5));
  assert.equal(h.decoder.resets, 1, 'a keyframe behind a full queue flushes the stale work');
  h.socket.message(unit(false, 6));
  assert.deepEqual(h.decoder.chunks.slice(2).map(chunk => chunk.timestamp), [5, 6]);
  // A decoded frame is drawn at once on the desynchronized canvas and timed.
  const frame = { timestamp: 5, displayWidth: 1920, displayHeight: 1080, close() { this.closed = true; } };
  h.decoder.output(frame);
  assert.equal(frame.closed, true);
  assert.equal(h.drawn.length, 1);
  assert.deepEqual({ ...h.canvas.contextOptions }, { desynchronized: true, alpha: false });
  assert.equal(h.canvas.width, 1920);
  assert.equal(h.run('frameLatency.length'), 1);
  assert.equal(h.run('frameLatency[0].value'), 5);
  // Hardware that errors at run time falls back to software, not to "no preference".
  h.decoder.error(new Error('Decoding error.'));
  assert.equal(h.decoder.config.hardwareAcceleration, 'prefer-software');
  assert.equal(h.run('hardware'), 'sw');
  h.run("configureDecoder('avc1.640034')"); await flush();
  assert.equal(h.decoder.config.hardwareAcceleration, 'prefer-software', 'a new stream does not retry the broken hardware');
  h.socket.message(unit(false, 7));
  assert.equal(h.decoder.chunks.length, 0, 'waits for a keyframe');
  h.socket.message(unit(true, 8));
  assert.equal(h.decoder.chunks.length, 1);
  // Software errors restart the decoder a few times before giving up.
  for (let i = 0; i < 3; i++) h.decoder.error(new Error('Decoding error.'));
  assert.equal(FakeDecoder.all.length, 6, 'three restarts without a decoded frame');
  assert.equal(h.el('#rd-status').textContent, '');
  h.decoder.error(new Error('Decoding error.'));
  assert.equal(FakeDecoder.all.length, 6);
  assert.match(h.el('#rd-status').textContent, /video decoder failed: Decoding error/);
});

test('the header byte order: big endian by default, little endian detected from an implausible send time', async () => {
  const h = harness();
  const make = little => { const b = videoMessage({ key: true, data: Buffer.from([9]) }, 7, 1_700_001_000_000, little); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  for (const little of [false, true]) {
    const buffer = make(little);
    const detected = h.run(`detectLittleEndian(new DataView(${JSON.stringify([...new Uint8Array(buffer)])}.reduce((v,x,i)=>(v[i]=x,v),new Uint8Array(${buffer.byteLength})).buffer), 1_700_001_000_000)`);
    assert.equal(detected, little);
  }
  h.context.buf = make(false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('(({key,seq,sendTime}) => ({key,seq,sendTime}))(parseHeader(buf, false))'))), { key: true, seq: 7, sendTime: 1_700_001_000_000 });
});

test('glass to glass: with ?probe=1 the lab band (44 bits of 16 px, MSB first) is read from each decoded frame', async () => {
  const h = await harness({ search: '?probe=1' }).connect();
  const captured = 1_700_000_999_950;
  const row = new Uint8ClampedArray(44 * 16 * 4);
  for (let bit = 0; bit < 44; bit++) {
    const one = Math.floor(captured / 2 ** (43 - bit)) % 2;
    for (let x = 0; x < 16; x++) row.fill(one ? 235 : 16, (bit * 16 + x) * 4, (bit * 16 + x) * 4 + 3);
  }
  h.context.row = row;
  assert.equal(h.run('stripeTime(row, LAB_STRIPE, 1_700_001_000_000)'), captured);
  const reads = [];
  h.context.OffscreenCanvas = class { constructor(width, height) { this.width = width; this.height = height; } getContext() { return { canvas: this, drawImage: (...args) => reads.push(args.slice(1, 5)), getImageData: () => ({ data: row }) }; } };
  h.run('inflight.set(9, { sendTime: 1_700_001_000_000, recvAt: 0 })');
  h.decoder.output({ timestamp: 9, displayWidth: 1920, displayHeight: 1080, close() {} });
  assert.deepEqual(reads[0], [0, 8, 704, 1]);
  // Drawn at timeOrigin + 1 000 000 = 1 700 001 000 000: 50 ms after capture.
  assert.equal(h.run('glassLatency[0].value'), 50);
  // A real desktop has no band: a value far from the send time is ignored.
  row.fill(0);
  h.run('inflight.set(10, { sendTime: 1_700_001_000_000, recvAt: 0 })');
  h.decoder.output({ timestamp: 10, displayWidth: 1920, displayHeight: 1080, close() {} });
  assert.equal(h.run('glassLatency.length'), 1);
});

test('ping syncs the clock with the lowest round trip; stats go to the server every second with mean and p95 over 5 s', async () => {
  const h = await harness().connect();
  const pings = h.sent('ping');
  assert.equal(pings.length, 1);
  h.advance(4);
  h.socket.message({ t: 'pong', c: pings[0].c, s: pings[0].c + 2 + 250 });
  assert.equal(h.run('rtt'), 4);
  assert.equal(h.run('clockOffset'), 250);
  for (let i = 0; i < 20; i++) h.run(`frameLatency.push({ at: nowEpoch(), value: ${i < 19 ? 10 : 50} })`);
  const tick = h.timers.find(timer => timer.interval && timer.ms === 1000);
  tick.callback();
  const stats = h.sent('stats').at(-1);
  assert.equal(stats.latency, 12); assert.equal(stats.p95, 10); assert.equal(stats.rtt, 4);
  assert.match(h.el('#rd-stats').textContent, /RTT 4\.0 ms · frame 12 ms \(p95 10 ms\)/);
  assert.equal(h.sent('ping').length, 2);
  // A second sample with a longer trip does not move the offset.
  const second = h.sent('ping').at(-1);
  h.advance(40);
  h.socket.message({ t: 'pong', c: second.c, s: second.c + 999 });
  assert.equal(h.run('clockOffset'), 250);
});

test('monitor and device selectors: monitors from ready, nodes from /api/mesh, a change reconnects with node=', async () => {
  const mesh = { self: { id: 'aaaaaaaaaaaaaaaa', name: 'pc-teste', os: 'linux' }, peers: [{ id: 'feedfacecafebeef', name: 'notebook-teste', os: 'linux', online: true, paired: true }, { id: 'bbbbbbbbbbbbbbbb', name: 'pc-windows', os: 'windows', online: false, paired: true }, { id: 'cccccccccccccccc', name: 'stranger', online: true, paired: false }] };
  const h = await harness({ mesh }).connect();
  await flush();
  assert.equal(h.fetches[0].url, '/api/mesh');
  assert.equal(h.fetches[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(h.el('#rd-monitor').querySelectorAll('option').map(option => option.getAttribute('value')), ['LAB-1', 'LAB-2']);
  h.el('#rd-monitor').value = 'LAB-2';
  h.el('#rd-monitor').dispatchEvent({ type: 'change', target: h.el('#rd-monitor') });
  assert.deepEqual(h.sent('monitor'), [{ t: 'monitor', name: 'LAB-2' }]);
  const options = h.el('#rd-node').querySelectorAll('option');
  assert.deepEqual(options.map(option => [option.getAttribute('value'), option.textContent, 'disabled' in option.attrs]), [['', 'pc-teste (this one)', false], ['feedfacecafebeef', 'notebook-teste', false], ['bbbbbbbbbbbbbbbb', 'pc-windows (offline)', true]]);
  const first = h.socket;
  h.el('#rd-node').value = '';
  h.el('#rd-node').dispatchEvent({ type: 'change', target: h.el('#rd-node') });
  assert.equal(first.readyState, 3);
  assert.equal(h.socket.url, 'ws://127.0.0.1:8787/api/rd');
  assert.equal(h.history.at(-1), '/rd.html');
  // Without /api/mesh the list is only the node the page talks to.
  const alone = await harness().connect();
  await flush();
  assert.deepEqual(alone.el('#rd-node').querySelectorAll('option').map(option => option.textContent), ['notebook-teste']);
  assert.equal(alone.el('#rd-node').disabled, true);
});

test('reconnects with backoff after a drop, but not after `taken` or a refused key', async () => {
  const h = await harness().connect();
  h.socket.close(1006);
  assert.ok(h.timer(500));
  assert.match(h.el('#rd-message').textContent, /Trying again in 1 s/);
  h.timer(500).callback();
  h.socket.close(1006);
  assert.ok(h.timer(1000));
  h.timer(1000).callback();
  await h.connect();
  h.socket.close(1006);
  assert.equal(h.timers.at(-1).ms, 500, 'ready resets the backoff');
  const taken = await harness().connect();
  taken.run('engage()');
  taken.socket.message({ t: 'taken' });
  assert.equal(taken.socket.readyState, 3);
  assert.equal(taken.timers.filter(timer => timer.ms === 500).length, 0);
  assert.match(taken.el('#rd-message').textContent, /Another device took control/);
  assert.equal(taken.el('#rd-retry').hidden, false);
  assert.equal(taken.run('engaged'), false);
  taken.el('#rd-retry').dispatchEvent({ type: 'click' });
  assert.equal(FakeSocket.all.at(-1).url, 'ws://127.0.0.1:8787/api/rd?node=feedfacecafebeef');
  const refused = harness();
  refused.socket.open();
  refused.socket.message({ t: 'error', code: 'PAIRING_REQUIRED' });
  refused.socket.close(4401);
  assert.equal(refused.timers.filter(timer => timer.ms === 500).length, 0);
  assert.equal(refused.el('#rd-retry').hidden, false);
});

test('full screen locks every key (no list), relative mode asks for raw pointer lock, and leaving full screen releases', async () => {
  const h = await harness().connect();
  h.el('#rd-mode-rel').dispatchEvent({ type: 'click' });
  assert.equal(h.saved.get('ponte-rd-mode'), 'rel');
  await h.run('enterFullscreen()'); await flush();
  assert.deepEqual({ ...h.document.fullscreenOptions }, { navigationUI: 'hide' });
  assert.deepEqual(h.keyboard.locks, [[]]);
  assert.deepEqual({ ...h.stage.lockRequests[0] }, { unadjustedMovement: true });
  assert.equal(h.document.body.classList.contains('fullscreen'), true);
  // The Full screen button keeps the focus after the click: its keys still go out.
  assert.equal(h.key('keydown', 'MetaLeft', { target: h.el('#rd-fullscreen') }).defaultPrevented, true);
  h.key('keyup', 'MetaLeft', { target: h.el('#rd-fullscreen') });
  assert.deepEqual(h.sent('key').map(message => message.code), ['MetaLeft', 'MetaLeft']);
  h.mouse('mousemove', h.stage, { movementX: 3.5, movementY: -1 });
  h.mouse('mousemove', h.stage, { movementX: 1, movementY: -1 });
  h.raf();
  assert.deepEqual(h.sent('rel'), [{ t: 'rel', dx: 4, dy: -2 }]);
  h.mouse('mousemove', h.stage, { movementX: 0.5, movementY: 0 }); h.raf();
  assert.deepEqual(h.sent('rel').at(-1), { t: 'rel', dx: 1, dy: 0 }, 'fractions carry over');
  // Chrome leaves full screen after Esc is held with the keyboard lock.
  h.document.exitFullscreen(); await flush();
  assert.equal(h.sent('release').length, 1);
  assert.equal(h.run('engaged'), false);
  assert.equal(h.document.pointerLockElement, null);
  assert.equal(h.keyboard.unlocked, true);
});

test('every rd string has an English translation and the page has no inline script', async () => {
  const h = harness();
  const messages = h.window.PonteI18n.messages;
  for (const match of client.matchAll(/\bt\((['"])(.*?)\1/g)) assert.ok(Object.hasOwn(messages, match[2]), match[2]);
  for (const match of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]*)"/g)) assert.ok(Object.hasOwn(messages, match[1]), match[1]);
  assert.doesNotMatch(html, /<script>(?!<)/);
  assert.equal(h.el('#rd-hint').textContent, 'Release: Ctrl+Alt+Shift or hold Esc');
  h.window.PonteI18n.setLanguage('pt');
  assert.equal(h.el('#rd-hint').textContent, 'Soltar: Ctrl+Alt+Shift ou segure Esc');
});

// ---- against the fake server, over a real WebSocket, with ffmpeg's H.264 ----

const hasFfmpeg = await promisify(execFile)('ffmpeg', ['-hide_banner', '-version']).then(() => true, () => false);

test('end to end with the fake /api/rd: the ffmpeg stream reaches the decoder keyframe first, input reaches the server', { skip: !hasFfmpeg && 'ffmpeg missing' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ponte-rd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clip = path.join(directory, 'clip.h264');
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-pix_fmt', 'yuv420p', '-f', 'h264', clip]);
  const units = accessUnits(await readFile(clip));
  assert.equal(units.length, 30);
  assert.equal(units.filter(unit => unit.key).length, 2);
  const fake = await startFakeRd({ h264: clip, token: TOKEN, fps: 60 });
  t.after(() => fake.close());
  const h = harness({ hash: `#pair=${TOKEN}` });
  // Swap the fake socket for Node's real WebSocket against the fake server.
  h.context.location.host = `127.0.0.1:${fake.port}`;
  h.context.WebSocket = WebSocket;
  h.context.setTimeout = setTimeout; h.context.clearTimeout = clearTimeout;
  h.run('connect()');
  const until = async (check, what) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check(), what); };
  await until(() => h.run('session !== null'), 'ready');
  assert.equal(h.run('session.monitor'), 'LAB-1');
  await until(() => h.decoder?.chunks.length >= 5, 'units decoded');
  const chunks = h.decoder.chunks;
  assert.equal(h.decoder.config.codec, fake.codec);
  assert.equal(chunks[0].type, 'key');
  assert.equal(chunks[0].data[4] & 0x1f, 7, 'the keyframe unit carries its SPS');
  assert.deepEqual(chunks.slice(0, 5).map(chunk => chunk.timestamp), [0, 1, 2, 3, 4]);
  h.run('engage()');
  h.key('keydown', 'KeyA'); h.key('keyup', 'KeyA');
  h.run("chooseMonitor('LAB-2')");
  await until(() => fake.received.some(message => message.t === 'monitor'), 'monitor');
  await until(() => h.run('session.monitor') === 'LAB-2', 'ready for LAB-2');
  assert.deepEqual(fake.received.filter(message => message.t !== 'ping' && message.t !== 'clip').map(message => message.t === 'key' ? `${message.code}${message.down ? 'v' : '^'}` : message.t), ['hello', 'KeyAv', 'KeyA^', 'monitor']);
  assert.equal(fake.received[0].token, TOKEN);
  // A second client takes the target: the first one hears `taken` and stays down.
  const other = new WebSocket(`ws://127.0.0.1:${fake.port}/api/rd`);
  await new Promise(resolve => other.addEventListener('open', resolve));
  other.send(JSON.stringify({ t: 'hello', v: 1, token: TOKEN }));
  await until(() => h.run('stopped') === 'taken', 'taken');
  await until(() => h.run('socket') === null, 'closed');
  other.close();
  h.run('clearInterval = () => {}');
});

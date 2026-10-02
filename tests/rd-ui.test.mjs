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

function harness({ hash = `#pair=${TOKEN}&node=feedfacecafebeef`, search = '', stored = {}, mesh = null, devices = null, clipboard = '', focused = true, permission = 'granted' } = {}) {
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
    fetch: async (url, options) => {
      fetches.push({ url, options });
      const body = url.startsWith('/api/devices') ? devices : url === '/api/mesh' ? mesh : null;
      if (body?.status) return { ok: false, status: body.status, json: async () => ({}) };
      return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
    },
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
    input: () => h.socket.sent.filter(message => !['hello', 'ping', 'stats', 'ack', 'keyframe'].includes(message.t)),
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
  // caps and view go to every server: one that does not know them ignores them.
  assert.deepEqual(h.socket.sent[0], { t: 'hello', v: 1, token: TOKEN, maxFps: 60, caps: { ack: true, key: true }, follow: true, view: { width: 1000, height: 500 } });
  assert.equal(h.el('#rd-probe').hidden, false);
  const again = harness({ hash: '', search: '?monitor=LAB-2', stored: { 'ponte-pair-token': 'stored-token-0123456789abcdef0123456789' } });
  again.window.devicePixelRatio = 2;
  again.socket.open();
  assert.deepEqual(again.socket.sent.at(-1), { t: 'hello', v: 1, token: 'stored-token-0123456789abcdef0123456789', maxFps: 60, caps: { ack: true, key: true }, follow: true, monitor: 'LAB-2', view: { width: 2000, height: 1000 } });
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

test('clicking the screen after choosing a device moves focus off the selector and sends keys', async () => {
  const h = await harness().connect();
  const select = h.el('#rd-node');
  select.focus();
  assert.equal(h.document.activeElement, select);
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 });
  assert.equal(h.document.activeElement, h.stage);
  h.key('keydown', 'KeyZ', { target: select });
  h.key('keyup', 'KeyZ', { target: select });
  h.key('keydown', 'MetaLeft', { target: select });
  h.key('keyup', 'MetaLeft', { target: select });
  assert.deepEqual(h.sent('key').map(m => m.code), ['KeyZ', 'KeyZ', 'MetaLeft', 'MetaLeft']);
  assert.equal(h.run('engaged'), true);
});

test('Ctrl+X releases before forwarding either key, even with another remote key held', async () => {
  const h = await harness().connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'KeyT');
  const before = h.input().length;
  assert.equal(h.key('keydown', 'ControlLeft', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(h.input().length, before, 'Control waits to see whether X follows');
  assert.equal(h.key('keydown', 'KeyX', { ctrlKey: true }).defaultPrevented, true);
  assert.deepEqual(h.input().slice(before), [{ t: 'release' }], 'no remote Ctrl down or X down before release');
  assert.equal(h.sent('release').length, 1);
  assert.equal(h.run('engaged'), false);
  assert.equal(h.document.body.classList.contains('controlling'), false);
  for (const code of ['KeyX', 'ControlLeft', 'KeyT']) h.key('keyup', code);
  assert.deepEqual(h.sent('key'), [{ t: 'key', code: 'KeyT', down: true }], 'release clears the held remote key without leaking chord keyups');
  // Once released, keys stay in this browser.
  const after = h.key('keydown', 'KeyA');
  assert.equal(after.defaultPrevented, false);
  assert.equal(h.sent('key').filter(message => message.code === 'KeyA').length, 0);
});

test('Ctrl+X with either Control key switches once per press, suppresses repeats and both keyup orders', async () => {
  for (const control of ['ControlLeft', 'ControlRight']) {
    for (const remote of [false, true]) {
      for (const order of [[control, 'KeyX'], ['KeyX', control]]) {
        const h = await harness().connect();
        if (remote) {
          h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 });
          h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
        }
        const label = `${control}, from ${remote ? 'remote' : 'local'}, ${order.join(' then ')} up`;
        h.key('keydown', control, { ctrlKey: true });
        h.key('keydown', control, { ctrlKey: true, repeat: true });
        h.key('keydown', 'KeyX', { ctrlKey: true });
        assert.equal(h.run('engaged'), !remote, label);
        for (const code of ['KeyX', control]) {
          assert.equal(h.key('keydown', code, { ctrlKey: true, repeat: true }).defaultPrevented, true, label);
        }
        assert.equal(h.run('engaged'), !remote, 'auto-repeat cannot switch back');
        assert.deepEqual(h.sent('key'), [], label);
        assert.equal(h.sent('release').length, remote ? 1 : 0, label);
        let ctrlKey = true;
        for (const code of order) {
          if (code === control) ctrlKey = false;
          assert.equal(h.key('keyup', code, { ctrlKey }).defaultPrevented, true, label);
          const other = order.find(key => key !== code);
          if (code === order[0]) {
            assert.equal(h.key('keydown', other, { ctrlKey, repeat: true }).defaultPrevented, true, label);
          }
        }
        assert.deepEqual(h.sent('key'), [], 'neither release order leaves a standalone Ctrl or X');
        h.key('keydown', control, { ctrlKey: true });
        h.key('keydown', 'KeyX', { ctrlKey: true });
        h.key('keyup', 'KeyX', { ctrlKey: true });
        h.key('keyup', control);
        assert.equal(h.run('engaged'), remote, 'a fresh press can switch again');
        assert.equal(h.sent('release').length, 1, label);
        assert.deepEqual(h.sent('key'), [], label);
      }
    }
  }
});

test('Ctrl+X accepts the DOM Control flag and physical Control held before taking control', async () => {
  const h = await harness().connect();
  assert.equal(h.key('keydown', 'KeyX', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(h.run('engaged'), true, 'the browser can report Ctrl without a Control keydown');
  assert.equal(h.key('keyup', 'KeyX', { ctrlKey: true }).defaultPrevented, true);
  assert.deepEqual(h.sent('key'), []);
  h.el('#rd-control').dispatchEvent({ type: 'click' });
  h.key('keydown', 'ControlRight');
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 });
  h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'KeyX');
  assert.equal(h.run('engaged'), false, 'physical Control is tracked even while input stays local');
  h.key('keyup', 'ControlRight'); h.key('keyup', 'KeyX');
  assert.deepEqual(h.sent('key'), [], 'a Control held locally is not lost or forwarded with the switch');
});

test('Ctrl+Shift/Alt/Meta+X and the old Ctrl+Alt+Shift stay ordinary shortcuts', async () => {
  for (const [modifier, flag] of [['ShiftRight', 'shiftKey'], ['AltLeft', 'altKey'], ['MetaRight', 'metaKey']]) {
    for (const physical of [false, true]) {
      const h = await harness().connect();
      const fields = { ctrlKey: true, ...(physical ? {} : { [flag]: true }) };
      h.key('keydown', 'ControlLeft', { ctrlKey: true });
      if (physical) h.key('keydown', modifier);
      assert.equal(h.key('keydown', 'KeyX', fields).defaultPrevented, false);
      h.key('keyup', 'KeyX', fields);
      if (physical) h.key('keyup', modifier);
      h.key('keyup', 'ControlLeft');
      assert.equal(h.run('engaged'), false, `${modifier} does not take control`);
      assert.deepEqual(h.input(), []);
      h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
      h.key('keydown', 'ControlLeft', { ctrlKey: true });
      if (physical) h.key('keydown', modifier);
      h.key('keydown', 'KeyX', fields); h.key('keyup', 'KeyX', fields);
      if (physical) h.key('keyup', modifier);
      h.key('keyup', 'ControlLeft');
      const codes = physical ? ['ControlLeft', modifier, 'KeyX'] : ['ControlLeft', 'KeyX'];
      assert.deepEqual(h.sent('key'), [
        ...codes.map(code => ({ t: 'key', code, down: true })),
        ...codes.toReversed().map(code => ({ t: 'key', code, down: false })),
      ], `${modifier} remains a remote shortcut (${physical ? 'physical' : 'DOM flag'})`);
      assert.equal(h.run('engaged'), true);
      assert.deepEqual(h.sent('release'), []);
    }
  }
  const h = await harness().connect();
  for (const remote of [false, true]) {
    if (remote) { h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 }); }
    for (const code of ['ControlRight', 'AltLeft', 'ShiftRight']) h.key('keydown', code);
    assert.equal(h.run('engaged'), remote, 'the retired chord never toggles');
    for (const code of ['ShiftRight', 'AltLeft', 'ControlRight']) h.key('keyup', code);
  }
  assert.deepEqual(h.sent('key').map(message => `${message.code}${message.down ? 'v' : '^'}`), ['ControlRightv', 'AltLeftv', 'ShiftRightv', 'ShiftRight^', 'AltLeft^', 'ControlRight^']);
  assert.deepEqual(h.sent('release'), []);
});

test('Ctrl+C flushes pending Control in order and plain X is not a switch', async () => {
  const h = await harness().connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'ControlLeft', { ctrlKey: true });
  assert.deepEqual(h.sent('key'), []);
  h.key('keydown', 'KeyC', { ctrlKey: true }); h.key('keyup', 'KeyC', { ctrlKey: true }); h.key('keyup', 'ControlLeft');
  h.key('keydown', 'KeyX'); h.key('keyup', 'KeyX');
  assert.deepEqual(h.sent('key').map(message => `${message.code}${message.down ? 'v' : '^'}`), ['ControlLeftv', 'KeyCv', 'KeyC^', 'ControlLeft^', 'KeyXv', 'KeyX^']);
  assert.equal(h.run('engaged'), true);
  assert.deepEqual(h.sent('release'), []);
});

test('pending Control is a mouse modifier and a standalone press still sends down before up', async () => {
  for (const control of ['ControlLeft', 'ControlRight']) {
    const h = await harness().connect();
    h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
    const before = h.input().length;
    h.key('keydown', control, { ctrlKey: true });
    assert.equal(h.input().length, before);
    h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294, ctrlKey: true });
    h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294, ctrlKey: true });
    h.key('keyup', control);
    assert.deepEqual(h.input().slice(before), [
      { t: 'key', code: control, down: true },
      { t: 'move', x: 0.5, y: 0.5 },
      { t: 'btn', b: 0, down: true },
      { t: 'btn', b: 0, down: false },
      { t: 'key', code: control, down: false },
    ], `${control} reaches the remote before the mouse press`);
    const keysBefore = h.sent('key').length;
    h.key('keydown', control); h.key('keyup', control);
    assert.deepEqual(h.sent('key').slice(keysBefore), [{ t: 'key', code: control, down: true }, { t: 'key', code: control, down: false }]);
  }
});

test('pending Control reaches the remote before wheel and does not flush on the local bar', async () => {
  for (const control of ['ControlLeft', 'ControlRight']) {
    const h = await harness().connect();
    h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
    const before = h.input().length;
    h.key('keydown', control, { ctrlKey: true });
    const local = h.mouse('wheel', h.stage, { target: h.el('#rd-control'), deltaMode: 0, deltaX: 0, deltaY: 100, ctrlKey: true });
    assert.equal(local.defaultPrevented, false, 'the bar keeps its own wheel');
    assert.equal(h.input().length, before, 'a bar wheel cannot flush pending Control');
    const remote = h.mouse('wheel', h.stage, { deltaMode: 0, deltaX: 0, deltaY: 100, ctrlKey: true });
    assert.equal(remote.defaultPrevented, true);
    assert.deepEqual(h.input().slice(before), [{ t: 'key', code: control, down: true }], 'Control goes out immediately, before the coalesced wheel');
    h.raf();
    h.key('keyup', control);
    assert.deepEqual(h.input().slice(before), [
      { t: 'key', code: control, down: true },
      { t: 'wheel', dx: 0, dy: 120 },
      { t: 'key', code: control, down: false },
    ]);
    assert.equal(h.run('engaged'), true);
  }
});

test('keyboard details separate local events from sent keys and update deferred Control after Ctrl+C', async () => {
  const h = await harness().connect();
  h.key('keydown', 'KeyA'); h.key('keyup', 'KeyA');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 2 page events, 0 sent.');
  assert.equal(h.el('#rd-key-trace').textContent, '↓ KeyA: local\n↑ KeyA: local');
  assert.deepEqual(h.sent('key'), []);
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'ControlLeft');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 3 page events, 0 sent.');
  assert.match(h.el('#rd-key-trace').textContent, /↓ ControlLeft: Ctrl awaiting the next key$/);
  h.key('keydown', 'KeyC', { ctrlKey: true });
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 4 page events, 2 sent.');
  assert.match(h.el('#rd-key-trace').textContent, /↓ ControlLeft: sent\n↓ KeyC: sent$/);
  h.key('keyup', 'KeyC'); h.key('keyup', 'ControlLeft');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 6 page events, 4 sent.');
  assert.equal(h.run('keyMetrics.sent'), h.sent('key').length);
  h.key('keydown', 'ControlRight'); h.key('keydown', 'KeyX');
  h.key('keyup', 'ControlRight'); h.key('keyup', 'KeyX');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 10 page events, 4 sent.');
  assert.match(h.el('#rd-key-trace').textContent, /↓ KeyX: switched\n↑ ControlRight: reserved shortcut\n↑ KeyX: reserved shortcut$/);
  assert.equal(h.sent('key').length, 4, 'reserved Ctrl+X is observed, never counted as sent');
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyX');
  h.key('keyup', 'KeyX'); h.key('keyup', 'ControlLeft');
  assert.equal(h.run('engaged'), true);
  assert.equal(h.run('keyMetrics.sent'), 4, 'taking control also keeps the reserved chord local');
});

test('keyboard trace marks repeats, missing physical codes and IME without keeping event.key text', async () => {
  const h = await harness().connect();
  const privateText = 'private composed text never recorded';
  h.key('keydown', '<unsafe-code>', { key: privateText });
  assert.equal(h.el('#rd-key-trace').textContent, '↓ Unidentified: local');
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'KeyA', { key: privateText });
  h.key('keydown', 'KeyA', { repeat: true, key: privateText });
  h.key('keyup', 'KeyA', { key: privateText });
  h.key('keydown', 'Unidentified', { isComposing: true, key: privateText });
  h.key('keydown', '', { keyCode: 229, key: privateText });
  h.key('keydown', undefined, { key: privateText });
  h.key('keyup', 'KeyZ');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 8 page events, 2 sent.');
  assert.equal(h.el('#rd-key-trace').textContent, [
    '↓ Unidentified: local', '↓ KeyA: sent', '↓ KeyA: local repeat', '↑ KeyA: sent',
    '↓ Unidentified [IME/229]: no physical code', '↓ Unidentified [IME/229]: no physical code',
    '↓ Unidentified: no physical code', '↑ KeyZ: release without a sent press',
  ].join('\n'));
  assert.deepEqual(h.sent('key'), [{ t: 'key', code: 'KeyA', down: true }, { t: 'key', code: 'KeyA', down: false }]);
  for (const text of [h.run('JSON.stringify(keyMetrics)'), h.el('#rd-key-trace').textContent, JSON.stringify(h.socket.sent), JSON.stringify([...h.saved])]) {
    assert.ok(!text.includes(privateText), 'typed or composed text stays out of diagnostics, messages and storage');
    assert.ok(!text.includes('<unsafe-code>'), 'diagnostic codes are sanitized');
  }
});

test('keyboard trace keeps only the last 12 events, while counts cover the whole session', async () => {
  const h = await harness().connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  for (const code of ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG']) {
    h.key('keydown', code); h.key('keyup', code);
  }
  assert.equal(h.run('keyMetrics.observed'), 14);
  assert.equal(h.run('keyMetrics.sent'), 14);
  assert.equal(h.run('keyMetrics.recent.length'), 12);
  const lines = h.el('#rd-key-trace').textContent.split('\n');
  assert.equal(lines.length, 12);
  assert.equal(lines[0], '↓ KeyB: sent');
  assert.equal(lines.at(-1), '↑ KeyG: sent');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 14 page events, 14 sent.');
  assert.ok(h.socket.sent.every(message => !('recent' in message) && !('keyMetrics' in message)), 'the trace is not transmitted');
  assert.ok([...h.saved.keys()].every(key => !/trace|metrics/i.test(key)), 'the trace is not persisted');
});

test('keyboard details reset page and target counters on a new connection and an automatic reconnect', async () => {
  const h = await harness().connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'KeyA'); h.key('keyup', 'KeyA');
  h.socket.message({ t: 'input-stats', input: { received: 2, injected: 2, pending: 0 } });
  const previous = h.socket;
  h.el('#rd-retry').dispatchEvent({ type: 'click' });
  assert.notEqual(h.socket, previous);
  assert.equal(h.run('keyMetrics.observed'), 0);
  assert.equal(h.run('keyMetrics.sent'), 0);
  assert.equal(h.run('keyMetrics.recent.length'), 0);
  assert.equal(h.run('targetInput'), null);
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 0 page events, 0 sent.');
  assert.equal(h.el('#rd-key-trace').textContent, '');
  await h.connect();
  h.key('keydown', 'KeyB'); h.key('keyup', 'KeyB');
  h.socket.message({ t: 'input-stats', input: { received: 8, injected: 6, pending: 2, dryRun: true } });
  h.socket.close(1006);
  h.timer(500).callback();
  assert.equal(h.run('keyMetrics.observed'), 0);
  assert.equal(h.run('keyMetrics.sent'), 0);
  assert.equal(h.run('targetInput'), null);
  assert.equal(h.el('#rd-key-trace').textContent, '');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 0 page events, 0 sent.');
  await h.connect();
  h.key('keydown', 'KeyC'); h.key('keyup', 'KeyC');
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 2 page events, 2 sent.');
});

test('target keyboard counts, dry-run and trace labels update in English and Portuguese', async () => {
  const h = await harness().connect();
  h.key('keydown', 'KeyA'); h.key('keyup', 'KeyA');
  h.socket.message({ t: 'input-stats', input: { received: 7, injected: 5, pending: 2, dryRun: true } });
  assert.equal(h.el('#rd-key-stats').textContent, 'Keyboard: 2 page events, 0 sent. Target: 7 received, 5 injected, 2 pending. (dry-run)');
  h.window.PonteI18n.setLanguage('pt');
  assert.equal(h.el('#rd-key-stats').textContent, 'Teclado: 2 eventos na página, 0 enviados. Destino: 7 recebidos, 5 injetados, 2 pendentes. (dry-run)');
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); h.mouse('mouseup', h.stage, { clientX: 500, clientY: 294 });
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyC');
  h.key('keydown', 'KeyC', { repeat: true });
  assert.match(h.el('#rd-key-trace').textContent, /↓ ControlLeft: enviado\n↓ KeyC: enviado\n↓ KeyC: repetição local$/);
  h.window.PonteI18n.setLanguage('en');
  assert.match(h.el('#rd-key-trace').textContent, /↓ ControlLeft: sent\n↓ KeyC: sent\n↓ KeyC: local repeat$/);
  h.socket.message({ t: 'input-stats', input: { received: -1, injected: '5', pending: 1.5, dryRun: 'true' } });
  assert.match(h.el('#rd-key-stats').textContent, /Target: \? received, \? injected, \? pending\.$/);
  assert.doesNotMatch(h.el('#rd-key-stats').textContent, /dry-run/);
  h.socket.message({ t: 'input-stats', input: null });
  assert.equal(h.run('targetInput'), null);
  assert.doesNotMatch(h.el('#rd-key-stats').textContent, /Target:/);
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

test('losing focus or hiding the page releases control; only explicit retaking resumes clipboard sync', async () => {
  const h = await harness({ clipboard: 'first copy' }).connect();
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); await flush();
  assert.deepEqual(h.sent('clip'), [{ t: 'clip', text: 'first copy' }]);
  h.key('keydown', 'ShiftLeft');
  h.window.dispatchEvent({ type: 'blur' });
  assert.equal(h.sent('release').length, 1);
  assert.equal(h.run('engaged'), false);
  assert.equal(h.document.title, 'Ponte — remote desktop');
  h.document.hidden = true; h.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.sent('release').length, 2);
  // Nothing held after the release: the Shift keyup is not sent.
  h.key('keyup', 'ShiftLeft');
  assert.equal(h.sent('key').filter(message => !message.down).length, 0);
  h.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(h.sent('clip').length, 1, 'same clipboard is not sent twice');
  h.clip.text = 'second copy';
  h.window.dispatchEvent({ type: 'focus' }); await flush();
  assert.equal(h.run('engaged'), false, 'focus alone does not take control again');
  assert.equal(h.sent('clip').length, 1, 'no clipboard sent while control stays local');
  h.document.hidden = false;
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyX');
  h.key('keyup', 'KeyX'); h.key('keyup', 'ControlLeft'); await flush();
  assert.equal(h.run('engaged'), true);
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

test('acks: the last frame that arrived, on arrival, at most every 50 ms; a dropped delta asks for a keyframe at most every 3 s', async () => {
  const h = await harness().connect();
  const now = 1_700_000_000_000 + 1_000_000;
  const unit = (key, seq) => { const buffer = videoMessage({ key, data: Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, seq]) }, seq, now - 5); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length); };
  h.socket.message(unit(true, 1));
  // The ack carries when the frame landed, in the page's own clock: the server
  // reads the link's capacity from the gradient between consecutive arrivals,
  // where the offset between the two clocks cancels.
  assert.equal(h.sent('ack').length, 1, 'the first one goes at once');
  const [opened] = h.sent('ack');
  assert.equal(opened.seq, 1);
  assert.ok(Number.isFinite(opened.rx), `an arrival time rides along: ${JSON.stringify(opened)}`);
  h.advance(10); h.socket.message(unit(false, 2));
  h.advance(10); h.socket.message(unit(false, 3));
  assert.equal(h.sent('ack').length, 1, 'batched');
  const timer = h.timer(40); // armed by the second frame, 10 ms after the first ack
  assert.ok(timer, 'sent when 50 ms have passed since the last one');
  h.advance(30); timer.callback();
  const batched = h.sent('ack').at(-1);
  assert.equal(batched.seq, 3);
  // Frame 3 landed 20 ms after frame 1, and the ack went 30 ms later still:
  // the time reported is that frame's arrival, not the ack's departure.
  assert.equal(batched.rx - opened.rx, 20, JSON.stringify(batched));
  h.socket.message(unit(false, 2));
  h.advance(100); h.socket.message(unit(false, 2));
  assert.equal(h.sent('ack').length, 2, 'never an older seq');
  // A delta the decoder cannot take any more: a keyframe request, not repeated for 3 s.
  assert.deepEqual(h.sent('keyframe'), []);
  h.decoder.decodeQueueSize = 3;
  h.socket.message(unit(false, 4));
  h.decoder.decodeQueueSize = 0;
  h.advance(1000); h.socket.message(unit(false, 5));
  assert.deepEqual(h.sent('keyframe'), [{ t: 'keyframe' }]);
  h.advance(2100); h.socket.message(unit(false, 6));
  assert.equal(h.sent('keyframe').length, 2, 'still waiting after 3 s: asks again');
  h.socket.message(unit(true, 7)); h.advance(4000); h.socket.message(unit(false, 8));
  assert.equal(h.sent('keyframe').length, 2, 'the keyframe came');
  // Outside the LAN frames arrive in bursts: a few waiting is not late, a second of them (60 at 60 fps) is.
  h.socket.message(JSON.stringify({ t: 'link', mode: 'wan' }));
  h.advance(4000); h.decoder.decodeQueueSize = 12; h.socket.message(unit(false, 9));
  h.decoder.decodeQueueSize = 0; h.socket.message(unit(false, 10));
  assert.equal(h.sent('keyframe').length, 2, 'a burst of 12 is decoded, no new run asked');
  h.decoder.decodeQueueSize = 61; h.socket.message(unit(false, 11));
  assert.equal(h.sent('keyframe').length, 3, 'over a second behind: a keyframe after all');
  // A new connection starts counting seqs again.
  h.socket.close(1006);
  h.timer(500).callback();
  await h.connect();
  h.advance(100); h.socket.message(unit(true, 1));
  const reopened = h.sent('ack');
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].seq, 1);
  assert.ok(Number.isFinite(reopened[0].rx));
});

test('frames that arrive while the decoder is being set up go in as one burst, and live frames wait for it instead of breaking the stream', async () => {
  const h = await harness().connect();
  const now = 1_700_000_000_000 + 1_000_000;
  const unit = (key, seq) => { const buffer = videoMessage({ key, data: Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, seq]) }, seq, now - 5); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length); };
  h.run("configureDecoder('avc1.640034')");
  for (let seq = 1; seq <= 12; seq++) h.socket.message(unit(seq === 1, seq));
  await flush();
  const decoder = h.decoder;
  assert.equal(decoder.chunks.length, 12, 'a keyframe and 11 deltas, none dropped');
  decoder.decodeQueueSize = 12;
  h.socket.message(unit(false, 13));
  assert.equal(decoder.chunks.length, 13, 'the decoder is still on the burst');
  decoder.decodeQueueSize = 1;
  h.socket.message(unit(false, 14));
  decoder.decodeQueueSize = 3;
  h.socket.message(unit(false, 15));
  assert.equal(decoder.chunks.length, 14, 'caught up: a late delta is dropped again');
  assert.deepEqual(h.sent('keyframe'), [{ t: 'keyframe' }]);
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

test('the probe times the first frame whose patch changes after a 2 px move, and refuses a moving picture', async () => {
  const h = await harness({ search: '?probe=1' }).connect();
  let pixels = new Uint8ClampedArray(24 * 24 * 4);
  h.context.OffscreenCanvas = class { constructor(width, height) { this.width = width; this.height = height; } getContext() { return { canvas: this, drawImage() {}, getImageData: (x, y, w, hgt) => ({ data: w === 24 ? pixels : new Uint8ClampedArray(w * hgt * 4) }) }; } };
  const frame = () => h.decoder.output({ timestamp: 0, displayWidth: 1920, displayHeight: 1080, close() {} });
  h.run('lastMove = { x: 0.25, y: 0.5 }; startProbe()');
  for (let round = 0; round < 10; round++) {
    pixels = new Uint8ClampedArray(24 * 24 * 4);
    for (let i = 0; i < 9; i++) frame();
    assert.equal(h.run('probe.phase'), 'wait', `round ${round} waits after a still patch`);
    const moved = h.sent('move').at(-1);
    assert.ok(Math.abs(moved.x - (0.25 + 2 / 1920)) < 1e-9);
    h.advance(30); frame();
    h.advance(12); pixels = new Uint8ClampedArray(24 * 24 * 4).fill(200); frame();
    assert.deepEqual(h.sent('move').at(-1), { t: 'move', x: 0.25, y: 0.5 }, 'the pointer goes back');
    h.advance(200); frame();
  }
  assert.deepEqual([...h.run('window.ponteProbe.results')], Array(10).fill(42));
  assert.match(h.run('lastProbe'), /^42 ms \(p95 42 ms, n=10\)$/);
  // A picture that keeps changing under the patch is not a measurement.
  h.run('startProbe()');
  for (let i = 0; i < 9; i++) { pixels = new Uint8ClampedArray(24 * 24 * 4).fill(i * 25); frame(); }
  assert.equal(h.run('lastProbe'), 'background moves too much');
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

test('monitor and device selectors: monitors from ready; on a server without /api/devices the nodes come from /api/mesh; a change reconnects with node=', async () => {
  const mesh = { self: { id: 'aaaaaaaaaaaaaaaa', name: 'pc-teste', os: 'linux' }, peers: [{ id: 'feedfacecafebeef', name: 'notebook-teste', os: 'linux', online: true, paired: true }, { id: 'bbbbbbbbbbbbbbbb', name: 'pc-windows', os: 'windows', online: false, paired: true }, { id: 'cccccccccccccccc', name: 'stranger', online: true, paired: false }] };
  const h = await harness({ mesh }).connect();
  await flush();
  assert.equal(h.fetches[0].url, '/api/devices?discover=1');
  assert.equal(h.fetches[1].url, '/api/mesh');
  assert.equal(h.fetches[1].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(h.el('#rd-monitor').querySelectorAll('option').map(option => option.getAttribute('value')), ['LAB-1', 'LAB-2']);
  h.el('#rd-monitor').value = 'LAB-2';
  h.el('#rd-monitor').dispatchEvent({ type: 'change', target: h.el('#rd-monitor') });
  assert.deepEqual(h.sent('monitor'), [{ t: 'monitor', name: 'LAB-2' }]);
  const options = h.el('#rd-node').querySelectorAll('option');
  assert.deepEqual(options.map(option => [option.getAttribute('value'), option.textContent, 'disabled' in option.attrs]), [['', 'pc-teste · this device', false], ['feedfacecafebeef', 'notebook-teste · online', false], ['bbbbbbbbbbbbbbbb', 'pc-windows · It is offline.', true], ['cccccccccccccccc', 'stranger · online · Not paired yet.', true]]);
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

// The shape GET /api/devices answers (docs/devices.md), as the two-node lab serves it.
const can = (control, extra = {}) => ({ screen: control, control, terminal: { ok: false, why: 'NO_ROUTE' }, info: { ok: true, via: 'ponte' }, ...extra });
const devicesAnswer = () => ({
  v: 1, home: { id: 'aaaaaaaaaaaaaaaa', name: 'pc-teste' }, requests: [], tailnet: { state: 'Running' }, checkedAt: 1,
  devices: [
    { id: 'aaaaaaaaaaaaaaaa', ids: ['aaaaaaaaaaaaaaaa', 'self'], name: 'pc-teste', kind: 'pc', self: true, status: 'online', can: can({ ok: true, via: 'ponte' }) },
    { id: 'feedfacecafebeef', ids: ['feedfacecafebeef', 'ssh:notebook-teste', 'tail:notebook-teste'], name: 'notebook-teste', kind: 'notebook', self: false, status: 'online', can: can({ ok: true, via: 'ponte' }) },
    { id: 'ssh:servidor-teste', ids: ['ssh:servidor-teste'], name: 'servidor-teste', kind: 'server', self: false, status: 'online', can: can({ ok: false, why: 'NO_PONTE' }) },
    { id: 'dddddddddddddddd', ids: ['dddddddddddddddd'], name: 'pc-sala', kind: 'pc', self: false, status: 'online', can: can({ ok: false, why: 'NOT_PAIRED' }) },
    { id: 'bbbbbbbbbbbbbbbb', ids: ['bbbbbbbbbbbbbbbb'], name: 'pc-windows', kind: 'pc', self: false, status: 'offline', can: can({ ok: false, why: 'OFFLINE' }) },
    { id: 'tail:tablet-teste', ids: ['tail:tablet-teste'], name: 'tablet-teste', kind: 'phone', self: false, status: 'unknown', can: can({ ok: false, why: 'SOMETHING_NEW' }) },
  ],
});

test('the device picker draws the one device list: kind, state and why in words, control only where can.control is ok', async () => {
  const h = await harness({ devices: devicesAnswer(), mesh: { self: { id: 'x', name: 'never read' } } }).connect();
  await flush();
  assert.deepEqual(h.fetches.map(item => item.url), ['/api/devices?discover=1'], '/api/mesh is not read when /api/devices answers');
  assert.equal(h.fetches[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  const select = h.el('#rd-node');
  const rows = () => select.querySelectorAll('option').map(option => [option.getAttribute('value'), option.textContent, 'disabled' in option.attrs, option.parentElement.tagName]);
  assert.deepEqual(rows(), [
    ['', 'pc-teste · this device', false, 'SELECT'],
    ['feedfacecafebeef', 'notebook-teste · Notebook · online', false, 'SELECT'],
    ['ssh:servidor-teste', 'servidor-teste · Server · online · Does not run Ponte.', true, 'OPTGROUP'],
    ['dddddddddddddddd', 'pc-sala · PC · online · Not paired yet.', true, 'OPTGROUP'],
    ['bbbbbbbbbbbbbbbb', 'pc-windows · PC · It is offline.', true, 'OPTGROUP'],
    ['tail:tablet-teste', 'tablet-teste · Phone · not checked', true, 'OPTGROUP'],
  ]);
  assert.equal(select.querySelector('optgroup').getAttribute('label'), 'Cannot be controlled from here');
  assert.equal(select.value, 'feedfacecafebeef');
  assert.equal(select.disabled, false);
  assert.equal(select.title, 'notebook-teste · Notebook · online');
  // No code ever reaches the page, in either language.
  const codes = /NO_PONTE|NOT_PAIRED|OFFLINE|SOMETHING_NEW|\bnotebook\b(?!-)|\bserver\b/;
  assert.doesNotMatch(select.textContent, codes);
  h.window.PonteI18n.setLanguage('pt');
  assert.deepEqual(rows().map(row => row[1]), [
    'pc-teste · este aparelho', 'notebook-teste · Notebook · online', 'servidor-teste · Servidor · online · Não roda a Ponte.',
    'pc-sala · PC · online · Ainda não está pareado.', 'pc-windows · PC · Está offline.', 'tablet-teste · Celular · sem conferir',
  ]);
  assert.equal(select.querySelector('optgroup').getAttribute('label'), 'Sem controle daqui');
  // The indicator names the device by the same name.
  assert.equal(h.el('#rd-control-target').textContent, 'Teclado e mouse → este aparelho');
  h.run('engage()');
  assert.equal(h.el('#rd-control-target').textContent, 'Teclado e mouse → notebook-teste');
  h.run('disengage()');
  // Choosing this device reconnects without node=; choosing the notebook again with its id.
  h.el('#rd-node').value = '';
  h.el('#rd-node').dispatchEvent({ type: 'change', target: h.el('#rd-node') });
  assert.equal(h.socket.url, 'ws://127.0.0.1:8787/api/rd');
  h.el('#rd-node').value = 'feedfacecafebeef';
  h.el('#rd-node').dispatchEvent({ type: 'change', target: h.el('#rd-node') });
  assert.equal(h.socket.url, 'ws://127.0.0.1:8787/api/rd?node=feedfacecafebeef');
});

test('node= by name or any id picks the same device (the resolver does the rest); a list that cannot be read leaves the page as it was', async () => {
  for (const node of ['notebook-teste', 'NOTEBOOK-teste', 'ssh:notebook-teste', 'tail:notebook-teste']) {
    const h = await harness({ hash: `#pair=${TOKEN}&node=${encodeURIComponent(node)}`, devices: devicesAnswer() }).connect();
    await flush();
    assert.equal(h.socket.url, `ws://127.0.0.1:8787/api/rd?node=${encodeURIComponent(node)}`, 'the page passes what it got; the server resolves it');
    const selected = h.el('#rd-node').querySelectorAll('option').filter(option => 'selected' in option.attrs).map(option => option.textContent);
    assert.deepEqual(selected, ['notebook-teste · Notebook · online'], node);
    assert.equal(h.el('#rd-node').querySelectorAll('option').length, 6, 'no extra entry for a name');
  }
  // node=self is this device.
  const self = await harness({ hash: `#pair=${TOKEN}&node=self`, devices: devicesAnswer() }).connect();
  await flush();
  assert.deepEqual(self.el('#rd-node').querySelectorAll('option').filter(option => 'selected' in option.attrs).map(option => option.textContent), ['pc-teste · this device']);
  // The device on the screen stays selectable even when the list says it cannot be controlled (it went offline).
  const gone = devicesAnswer();
  gone.devices[1] = { ...gone.devices[1], status: 'offline', can: can({ ok: false, why: 'OFFLINE' }) };
  const h = await harness({ devices: gone }).connect();
  await flush();
  const notebook = h.el('#rd-node').querySelectorAll('option').find(option => option.getAttribute('value') === 'feedfacecafebeef');
  assert.equal('disabled' in notebook.attrs, false);
  assert.equal(notebook.textContent, 'notebook-teste · Notebook · It is offline.');
  // A server error (not a missing route) does not fall back to /api/mesh nor invent a list.
  const broken = harness({ devices: { status: 500 }, mesh: { self: { id: 'x', name: 'never read' } } });
  await flush();
  assert.deepEqual(broken.fetches.map(item => item.url), ['/api/devices?discover=1']);
  assert.deepEqual(broken.el('#rd-node').querySelectorAll('option').map(option => option.textContent), ['This device']);
});

test('the list follows the network: read again every 30 s while a session runs', async () => {
  const h = await harness({ devices: devicesAnswer() }).connect();
  await flush();
  const tick = h.timers.find(timer => timer.interval && timer.ms === 1000);
  tick.callback();
  assert.equal(h.fetches.length, 1, 'not before 30 s');
  h.advance(30001);
  tick.callback();
  await flush();
  assert.deepEqual(h.fetches.map(item => item.url), ['/api/devices?discover=1', '/api/devices']);
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
  // Nothing connected: the indicator says the keys are here and offers no hint yet.
  assert.equal(h.el('#rd-control-target').textContent, 'Keyboard and mouse → this device');
  assert.equal(h.el('#rd-hint').textContent, '');
  h.window.PonteI18n.setLanguage('pt');
  assert.equal(h.el('#rd-control-target').textContent, 'Teclado e mouse → este aparelho');
  assert.equal(h.el('#rd-mode-abs').textContent, 'Direto');
  assert.equal(h.el('#rd-mode-rel').textContent, 'Travado (jogos e 3D)');
  for (const old of ['>Abs<', '>Rel<', 'rd-stats" aria-live="off"></span>']) assert.ok(!html.includes(old), old);
});

test('Ctrl+X switches both ways without full screen; the indicator, the frame and the window title follow', async () => {
  const h = await harness().connect();
  assert.equal(h.el('#rd-control').getAttribute('aria-pressed'), 'false');
  assert.match(h.el('#rd-hint').textContent, /Ctrl\+X or click the screen to control notebook-teste/);
  assert.equal(h.document.title, 'Ponte — remote desktop');
  // Plain keys on this device stay here and nothing goes out.
  assert.equal(h.key('keydown', 'ControlLeft').defaultPrevented, false);
  h.key('keyup', 'ControlLeft');
  // The chord takes the keys to the device on the screen: no full screen, no modifier sent.
  h.key('keydown', 'ControlLeft');
  const chord = h.key('keydown', 'KeyX');
  assert.equal(chord.defaultPrevented, true);
  assert.equal(h.run('engaged'), true);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.sent('key').length, 0, 'the chord itself never reaches the device');
  assert.equal(h.document.body.classList.contains('controlling'), true);
  assert.equal(h.el('#rd-control').getAttribute('aria-pressed'), 'true');
  assert.equal(h.el('#rd-control-target').textContent, 'Keyboard and mouse → notebook-teste');
  assert.match(h.el('#rd-hint').textContent, /Ctrl\+X comes back.*Super and Ctrl\+T stay here/);
  assert.equal(h.el('#rd-switch').hidden, false);
  assert.equal(h.el('#rd-switch').textContent, 'Keyboard and mouse → notebook-teste');
  assert.equal(h.document.title, '⌨ notebook-teste · Ponte — remote desktop');
  // Releasing the chord sends nothing (those keys were never sent down).
  for (const code of ['KeyX', 'ControlLeft']) h.key('keyup', code);
  assert.equal(h.sent('key').length, 0);
  h.key('keydown', 'KeyA'); h.key('keyup', 'KeyA');
  assert.deepEqual(h.sent('key').map(message => message.code), ['KeyA', 'KeyA']);
  // The same chord comes back.
  h.key('keydown', 'ControlRight'); h.key('keydown', 'KeyX');
  assert.equal(h.run('engaged'), false);
  assert.equal(h.sent('release').length, 1);
  assert.equal(h.el('#rd-control-target').textContent, 'Keyboard and mouse → this device');
  assert.equal(h.el('#rd-switch').textContent, 'Keyboard and mouse → this device');
  assert.equal(h.document.title, 'Ponte — remote desktop');
  for (const code of ['ControlRight', 'KeyX']) h.key('keyup', code);
  // Ctrl+Shift+X stays a shortcut on this device.
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'ShiftLeft'); h.key('keydown', 'KeyX');
  assert.equal(h.run('engaged'), false);
  for (const code of ['KeyX', 'ShiftLeft', 'ControlLeft']) h.key('keyup', code);
  // The indicator is a switch too.
  h.el('#rd-control').dispatchEvent({ type: 'click' });
  assert.equal(h.run('engaged'), true);
  h.el('#rd-control').dispatchEvent({ type: 'click' });
  assert.equal(h.run('engaged'), false);
});

test('Ctrl+X can enter full screen instead, from the settings, and it is remembered', async () => {
  const h = await harness().connect();
  h.el('#rd-chord-action').value = 'fullscreen';
  h.el('#rd-chord-action').dispatchEvent({ type: 'change', target: h.el('#rd-chord-action') });
  assert.equal(h.saved.get('ponte-rd-chord'), 'fullscreen');
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyX');
  await flush();
  assert.equal(h.run('engaged'), true);
  assert.ok(h.document.fullscreenElement);
  assert.deepEqual(h.keyboard.locks, [[]]);
  assert.match(h.el('#rd-hint').textContent, /Everything goes to the device, Super included/);
  h.key('keyup', 'KeyX'); h.key('keyup', 'ControlLeft');
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyX');
  h.key('keyup', 'ControlLeft'); h.key('keyup', 'KeyX');
  assert.equal(h.run('engaged'), false);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.keyboard.unlocked, true);
  assert.deepEqual(h.sent('key'), [], 'fullscreen switches also keep Ctrl and X local');
  const again = await harness({ stored: { 'ponte-rd-chord': 'fullscreen' } }).connect();
  assert.equal(again.el('#rd-chord-action').value, 'fullscreen');
});

test('Ctrl+X stays local without a session and while settings are open, without poisoning the next switch', async () => {
  const idle = harness();
  for (const [type, code, ctrlKey] of [['keydown', 'ControlLeft', true], ['keydown', 'KeyX', true], ['keyup', 'KeyX', true], ['keyup', 'ControlLeft', false]]) {
    assert.equal(idle.key(type, code, { ctrlKey }).defaultPrevented, false, 'no session does not reserve the local shortcut');
  }
  assert.equal(idle.run('engaged'), false);
  assert.deepEqual(idle.input(), []);
  await idle.connect();
  idle.key('keydown', 'ControlLeft'); idle.key('keydown', 'KeyX');
  idle.key('keyup', 'KeyX'); idle.key('keyup', 'ControlLeft');
  assert.equal(idle.run('engaged'), true, 'the shortcut works when a session arrives');
  idle.el('#rd-settings-open').dispatchEvent({ type: 'click' });
  const before = idle.input().length;
  for (const [type, code, ctrlKey] of [['keydown', 'ControlRight', true], ['keydown', 'KeyX', true], ['keyup', 'ControlRight', false], ['keyup', 'KeyX', false]]) {
    assert.equal(idle.key(type, code, { ctrlKey, target: idle.el('#rd-chord-action') }).defaultPrevented, false, 'the dialog owns its keyboard');
  }
  assert.equal(idle.run('engaged'), false);
  assert.equal(idle.input().length, before);
  idle.el('#rd-settings-close').dispatchEvent({ type: 'click' });
  idle.key('keydown', 'ControlRight'); idle.key('keydown', 'KeyX');
  idle.key('keyup', 'ControlRight'); idle.key('keyup', 'KeyX');
  assert.equal(idle.run('engaged'), true, 'closing the dialog allows a fresh switch');
  assert.deepEqual(idle.sent('key'), []);
});

test('the settings: pointer mode, frame limit (reconnects with maxFps), clipboard off, details with the numbers', async () => {
  const h = await harness({ clipboard: 'copied' }).connect();
  h.run('engage()');
  h.el('#rd-settings-open').dispatchEvent({ type: 'click' });
  assert.equal(h.el('#rd-settings').open, true);
  assert.equal(h.run('engaged'), false, 'opening the settings gives the keys back');
  // Inside the settings the chord does nothing (the dialog has the keyboard).
  h.key('keydown', 'ControlLeft'); h.key('keydown', 'KeyX');
  assert.equal(h.run('engaged'), false);
  for (const code of ['KeyX', 'ControlLeft']) h.key('keyup', code);
  h.el('#rd-mode-rel').dispatchEvent({ type: 'click' });
  assert.equal(h.saved.get('ponte-rd-mode'), 'rel');
  assert.equal(h.el('#rd-mode-rel').getAttribute('aria-pressed'), 'true');
  const first = h.socket;
  h.el('#rd-fps').value = '30';
  h.el('#rd-fps').dispatchEvent({ type: 'change', target: h.el('#rd-fps') });
  assert.equal(h.saved.get('ponte-rd-fps'), '30');
  assert.equal(first.readyState, 3);
  h.socket.open();
  assert.equal(h.sent('hello')[0].maxFps, 30);
  h.socket.message(readyMessage({ fps: 30 })); await flush();
  h.el('#rd-clipboard').checked = false;
  h.el('#rd-clipboard').dispatchEvent({ type: 'change', target: h.el('#rd-clipboard') });
  assert.equal(h.saved.get('ponte-rd-clipboard'), 'off');
  const clipsBefore = h.sent('clip').length;
  h.clip.text = 'copied again';
  h.el('#rd-settings-close').dispatchEvent({ type: 'click' });
  assert.equal(h.el('#rd-settings').open, false);
  h.mouse('mousedown', h.stage, { clientX: 500, clientY: 294 }); await flush();
  assert.equal(h.sent('clip').length, clipsBefore, 'clipboard off: nothing goes out');
  h.socket.message({ t: 'clip', text: 'from the target' }); await flush();
  assert.deepEqual(h.clip.writes, [], 'and nothing comes in');
  // Stored choices come back on the next page.
  const again = await harness({ stored: { 'ponte-rd-fps': '15', 'ponte-rd-clipboard': 'off' } }).connect();
  assert.equal(again.sent('hello')[0].maxFps, 15);
  assert.equal(again.el('#rd-fps').value, '15');
  assert.equal(again.el('#rd-clipboard').checked, false);
  // A stored value that is not a choice falls back to 60.
  assert.equal(harness({ stored: { 'ponte-rd-fps': '999' } }).run('fpsLimit'), 60);
});

test('the bar shows the connection in words (good, unstable, bad and why); the numbers stay in the details', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(harness().run(`linkQuality({ fps: 60, expectedFps: 60, rtt: 4, p95: 9, drops: 0 })`))), { level: 'good', reasons: [] });
  const h = await harness().connect();
  const level = source => h.run(`linkQuality(${source}).level`);
  assert.equal(level('{ fps: 47, expectedFps: 60, rtt: 39, p95: 106 }'), 'unstable');
  assert.equal(level('{ fps: 60, expectedFps: 60, rtt: 200, p95: 10 }'), 'bad');
  assert.equal(level('{ fps: 20, expectedFps: 60, rtt: 5, p95: 10 }'), 'bad');
  assert.equal(level('{ fps: 29, expectedFps: 30, rtt: 5, p95: 10 }'), 'good', 'over the internet 30 fps is the target');
  assert.equal(level('{ fps: 60, expectedFps: 60, rtt: 5, p95: 10, drops: 2 }'), 'good', 'a couple of drops is not instability');
  const tick = h.timers.find(timer => timer.interval && timer.ms === 1000);
  // Connected but no picture yet (seen in the lab: "Bad connection · only 0 frames per
  // second" right after opening): no verdict until a frame is drawn and a second has passed.
  h.run('framesDrawn = 0');
  tick.callback();
  assert.equal(h.el('#rd-link').hidden, true, 'no verdict before the first picture');
  h.run('firstFrameAt = nowEpoch()');
  h.run('framesDrawn = 1');
  tick.callback();
  assert.equal(h.el('#rd-link').hidden, true, 'nor in its first second');
  h.advance(1001);
  // The print of 2026-10-01: 47 fps, RTT 39 ms, frame p95 106 ms.
  h.run('rtt = 39');
  for (let i = 0; i < 20; i++) h.run(`frameLatency.push({ at: nowEpoch(), value: ${i < 18 ? 9 : 106} })`);
  h.run('framesDrawn = 47');
  tick.callback();
  assert.equal(h.el('#rd-link').hidden, false);
  assert.equal(h.el('#rd-link').getAttribute('data-level'), 'unstable');
  assert.equal(h.el('#rd-link-text').textContent, 'Unstable connection · picture arriving late (up to 106 ms)');
  assert.match(h.el('#rd-link-reason').textContent, /picture arriving late \(up to 106 ms\) · only 47 frames per second/);
  // The raw numbers live in the settings' details, not on the bar.
  assert.match(h.el('#rd-stats').textContent, /RTT 39 ms/);
  assert.equal(h.el('#rd-stats').closest('.rd-bar'), null);
  assert.ok(h.el('#rd-stats').closest('#rd-settings'));
  // Calm again: the worst of the last 3 s holds, then it turns good.
  h.run('frameLatency.length = 0; rtt = 4');
  for (let i = 0; i < 3; i++) { h.run('framesDrawn = 60'); tick.callback(); }
  assert.equal(h.el('#rd-link').getAttribute('data-level'), 'good');
  assert.equal(h.el('#rd-link-text').textContent, 'Good connection');
  h.window.PonteI18n.setLanguage('pt');
  assert.equal(h.el('#rd-link-text').textContent, 'Conexão boa');
  // A click on it opens the details.
  h.el('#rd-link').dispatchEvent({ type: 'click' });
  assert.equal(h.el('#rd-settings').open, true);
  // Disconnected: no verdict.
  h.socket.close(1006);
  assert.equal(h.el('#rd-link').hidden, true);
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
  assert.deepEqual(fake.received.filter(message => !['ping', 'clip', 'ack', 'keyframe'].includes(message.t)).map(message => message.t === 'key' ? `${message.code}${message.down ? 'v' : '^'}` : message.t), ['hello', 'KeyAv', 'KeyA^', 'monitor']);
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

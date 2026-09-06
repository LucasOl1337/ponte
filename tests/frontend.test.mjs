import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

// Evaluate the production parser alone: no DOM initialization, network access,
// actual monitor capture or microphone permission is involved in these tests.
const [source, htmlSource, i18nSource] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/i18n.js', import.meta.url), 'utf8'),
]);
const parserSource = source.slice(source.indexOf('const MAX_FRAME_BYTES ='), source.indexOf('\nfunction screenIsVisible()'));
const MAX_FRAME = 8 * 1024 * 1024;
const timestamp = 1770000000000;

function harness(onFrame = () => {}) {
  let allocated = 0;
  let copied = 0;
  const TrackedArray = new Proxy(Uint8Array, {
    construct(target, args) {
      const array = Reflect.construct(target, args);
      allocated += array.byteLength;
      Object.defineProperty(array, 'set', { value(input, offset) {
        copied += input.byteLength;
        return Uint8Array.prototype.set.call(this, input, offset);
      } });
      return array;
    },
  });
  const context = vm.createContext({ Uint8Array: TrackedArray, TextDecoder, Date, t: key => key });
  vm.runInContext(`${parserSource}\nglobalThis.Parser = MjpegParser;`, context);
  return { parser: new context.Parser(onFrame), allocated: () => allocated, copied: () => copied };
}

function packet(size = 32, frameTimestamp = timestamp) {
  const bytes = Buffer.alloc(size, 0x61);
  bytes[0] = 255; bytes[1] = 216; bytes[size - 2] = 255; bytes[size - 1] = 217;
  return Buffer.concat([
    Buffer.from(`--ponte-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${size}\r\nX-Frame-Timestamp: ${frameTimestamp}\r\n\r\n`),
    bytes, Buffer.from('\r\n'),
  ]);
}

test('MJPEG reconstructs headers, timestamps and multiple frames at every split boundary', () => {
  const input = Buffer.concat([packet(32), packet(64, timestamp + 100)]);
  for (let split = 0; split <= input.length; split++) {
    const frames = [];
    const { parser } = harness((bytes, at) => frames.push({ length: bytes.length, at }));
    parser.push(input.subarray(0, split));
    parser.push(input.subarray(split));
    assert.deepEqual(frames, [{ length: 32, at: timestamp }, { length: 64, at: timestamp + 100 }], `split ${split}`);
  }
});

test('MJPEG accepts one-byte fragments and does not emit a partial image', () => {
  const frames = [];
  const { parser } = harness(bytes => frames.push(bytes.length));
  const input = packet(128);
  for (let index = 0; index < input.length - 3; index++) parser.push(input.subarray(index, index + 1));
  assert.equal(frames.length, 0);
  parser.push(input.subarray(input.length - 3));
  assert.deepEqual(frames, [128]);
});

test('MJPEG accepts valid frames whose combined transport chunk exceeds the per-frame cap', () => {
  const size = 4 * 1024 * 1024 + 40000;
  const frames = [];
  const h = harness(bytes => frames.push(bytes.length));
  h.parser.push(Buffer.concat([packet(size), packet(size)]));
  assert.deepEqual(frames, [size, size]);
  assert.ok(h.allocated() <= size * 2 + 8192);
  assert.ok(h.copied() <= size * 2);
});

test('MJPEG accepts an 8 MiB frame tail coalesced with the next frame', () => {
  const frames = [];
  const { parser } = harness(bytes => frames.push(bytes.length));
  const first = packet(MAX_FRAME);
  parser.push(first.subarray(0, first.length - 64));
  parser.push(Buffer.concat([first.subarray(first.length - 64), packet(128 * 1024 - 300)]));
  assert.deepEqual(frames, [MAX_FRAME, 128 * 1024 - 300]);
});

test('MJPEG allocates and copies linearly for a large frame split into 4 KiB chunks', () => {
  const size = 2 * 1024 * 1024;
  const frames = [];
  const h = harness(bytes => frames.push(bytes.length));
  const input = packet(size);
  for (let offset = 0; offset < input.length; offset += 4096) h.parser.push(input.subarray(offset, offset + 4096));
  assert.deepEqual(frames, [size]);
  assert.ok(h.allocated() <= size + 8192, `allocated ${h.allocated()} for ${size} image bytes`);
  assert.ok(h.copied() <= size, `copied ${h.copied()} for ${size} image bytes`);
});

test('MJPEG rejects malformed or oversized frame headers before allocating a body', () => {
  for (const length of ['0', '3', '8388609', '9007199254740992', 'nope']) {
    const h = harness(() => assert.fail('must not emit'));
    assert.throws(() => h.parser.push(Buffer.from(`--ponte-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`)), /Tamanho/);
    assert.ok(h.allocated() <= 8192);
  }
  assert.throws(() => harness().parser.push(Buffer.from('x'.repeat(8193))), /Cabeçalho/);
  assert.throws(() => harness().parser.push(Buffer.from('--wrong\r\nContent-Type: image/jpeg\r\nContent-Length: 32\r\n\r\n')), /Formato/);
  assert.throws(() => harness().parser.push(Buffer.from('--ponte-frame\r\nContent-Type: text/html\r\nContent-Length: 32\r\n\r\n')), /Formato/);
});

test('MJPEG rejects a body without JPEG markers', () => {
  const input = packet(32);
  input[input.length - 3] = 0;
  assert.throws(() => harness().parser.push(input), /JPEG/);
});


test('Android permission dialog keeps the pending microphone request, while background closes it', () => {
  const handlerSource = source.slice(source.indexOf("window.addEventListener('ponte-native-pause'"), source.indexOf("window.addEventListener('hashchange'"));
  let listener;
  const calls = [];
  const context = vm.createContext({
    window: {addEventListener: (_event, callback) => { listener = callback; }},
    nativePaused: false, terminalTimer: null, terminalGeneration: 0, clearTimeout() {},
    leaveScreen: () => calls.push('screen'), stopDrag: () => calls.push('drag'),
    cancelPendingRecording: () => calls.push('pending'), stopRecording: () => calls.push('recording'), closeMicrophone: () => calls.push('microphone'),
  });
  vm.runInContext(handlerSource, context);
  listener({detail: {awaitingMicrophonePermission: true}});
  assert.deepEqual(calls, ['screen', 'drag']);
  calls.length = 0;
  listener({});
  assert.deepEqual(calls, ['screen', 'drag', 'pending', 'recording', 'microphone']);
});

const powerFixture = {
  hostname: 'test-desktop',
  uptime: 3600,
  windows: [],
  activeWindow: null,
  workspaces: [{ id: 1, name: '1', windows: 0 }],
  monitors: [
    { name: 'HDMI-A-1', width: 1920, height: 1080, focused: true, dpmsStatus: true, description: 'Samsung 1080p' },
    { name: 'DP-1', width: 2560, height: 1440, focused: false, dpmsStatus: false, description: 'ASUS 1440p' },
  ],
  volume: { value: 0.5, muted: false },
  capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true },
  warnings: [],
  wakeOnLan: {
    mac: 'd8:43:ae:8b:e8:a8',
    interface: 'enp12s0',
    instructions: 'Enable Wake-on-LAN in BIOS',
  },
};

function powerUiHarness({ stored = { 'ponte-pair-token': 'synthetic-token' }, state = powerFixture } = {}) {
  const document = makeDocument(htmlSource);
  const window = makeWindow();
  const saved = new Map(Object.entries(stored));
  const calls = [];
  let timer = 0;
  const context = vm.createContext({
    document,
    window,
    localStorage: {
      getItem: key => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: key => saved.delete(key),
    },
    navigator: { language: 'en', languages: ['en'], userAgent: 'Test browser' },
    location: { hash: '#inicio', pathname: '/', search: '' },
    history: { replaceState() {} },
    CustomEvent: class {
      constructor(type, { detail } = {}) {
        this.type = type;
        this.detail = detail;
      }
    },
    Intl,
    Date,
    Error,
    TypeError,
    TextDecoder,
    Uint8Array,
    AbortController,
    URL,
    Blob,
    performance,
    setTimeout: () => ++timer,
    clearTimeout() {},
    setInterval: () => ++timer,
    clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === '/api/state') return { ok: true, json: async () => state };
      if (path === '/api/action') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    },
  });
  vm.runInContext(i18nSource, context);
  vm.runInContext(source, context);
  return {
    context,
    window,
    document,
    calls,
    i18n: window.PonteI18n,
    el: sel => document.querySelector(sel),
    all: sel => document.querySelectorAll(sel),
    run: src => vm.runInContext(src, context),
  };
}

const flushTicks = async (n = 15) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('Power section renders monitor toggles with current DPMS state, names, and superbuttons', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('inicio')");
  assert.equal(h.el('#page-inicio').hidden, false);

  const rows = h.el('#power-monitors').querySelectorAll('.power-monitor-row');
  assert.equal(rows.length, 2);

  const first = rows[0];
  assert.equal(first.querySelector('.power-monitor-name').textContent, 'HDMI-A-1');
  assert.match(first.querySelector('.power-monitor-details').textContent, /1920×1080/);
  const toggle1 = first.querySelector('[data-monitor-toggle]');
  assert.equal(toggle1.getAttribute('data-monitor-toggle'), 'HDMI-A-1');
  assert.equal(toggle1.getAttribute('data-next-state'), 'off');
  assert.equal(toggle1.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle1.classList.contains('on'), true);
  assert.equal(toggle1.classList.contains('off'), false);
  assert.match(toggle1.textContent, /On/);

  const second = rows[1];
  assert.equal(second.querySelector('.power-monitor-name').textContent, 'DP-1');
  assert.match(second.querySelector('.power-monitor-details').textContent, /2560×1440/);
  const toggle2 = second.querySelector('[data-monitor-toggle]');
  assert.equal(toggle2.getAttribute('data-monitor-toggle'), 'DP-1');
  assert.equal(toggle2.getAttribute('data-next-state'), 'on');
  assert.equal(toggle2.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle2.classList.contains('off'), true);
  assert.equal(toggle2.classList.contains('on'), false);
  assert.match(toggle2.textContent, /Off/);

  assert.ok(h.el('#btn-smart-sleep'));
  assert.ok(h.el('#btn-wake'));
  assert.ok(h.el('#btn-poweroff'));
});

test('Monitor toggle button dispatches power.dpms action with expected monitor and state', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('inicio')");

  const toggle1 = h.el('[data-monitor-toggle="HDMI-A-1"]');
  h.calls.length = 0;
  toggle1.click();
  await flushTicks();

  const actionCall1 = h.calls.find(c => c.path === '/api/action');
  assert.ok(actionCall1, 'expected /api/action call');
  assert.deepEqual(actionCall1.body, { type: 'power.dpms', monitor: 'HDMI-A-1', state: 'off' });

  const toggle2 = h.el('[data-monitor-toggle="DP-1"]');
  h.calls.length = 0;
  toggle2.click();
  await flushTicks();

  const actionCall2 = h.calls.find(c => c.path === '/api/action');
  assert.ok(actionCall2, 'expected /api/action call');
  assert.deepEqual(actionCall2.body, { type: 'power.dpms', monitor: 'DP-1', state: 'on' });
});

test('Superbuttons trigger smart sleep and wake actions', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('inicio')");

  h.calls.length = 0;
  h.el('#btn-smart-sleep').click();
  await flushTicks();

  const sleepCall = h.calls.find(c => c.path === '/api/action');
  assert.ok(sleepCall, 'expected sleep call');
  assert.deepEqual(sleepCall.body, { type: 'power.sleep' });

  h.calls.length = 0;
  h.el('#btn-wake').click();
  await flushTicks();

  const wakeCall = h.calls.find(c => c.path === '/api/action');
  assert.ok(wakeCall, 'expected wake call');
  assert.deepEqual(wakeCall.body, { type: 'power.wake' });
});

test('Power off button requires double confirmation dialog before dispatching poweroff', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('inicio')");

  const dialog = h.el('#poweroff-dialog');
  assert.equal(Boolean(dialog.open), false);

  h.calls.length = 0;
  h.el('#btn-poweroff').click();
  assert.equal(dialog.open, true);
  assert.equal(h.calls.filter(c => c.path === '/api/action').length, 0);

  h.el('#poweroff-cancel').click();
  assert.equal(dialog.open, false);
  assert.equal(h.calls.filter(c => c.path === '/api/action').length, 0);

  h.el('#btn-poweroff').click();
  assert.equal(dialog.open, true);

  h.el('#poweroff-confirm').click();
  await flushTicks();
  assert.equal(dialog.open, false);

  const poweroffCall = h.calls.find(c => c.path === '/api/action');
  assert.ok(poweroffCall, 'expected poweroff action call');
  assert.deepEqual(poweroffCall.body, { type: 'power.poweroff' });
});

test('Portuguese translation updates power controls, monitor states, and dialog', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.i18n.setLanguage('pt');
  await flushTicks();
  h.run("navigate('inicio')");

  const toggle1 = h.el('[data-monitor-toggle="HDMI-A-1"]');
  assert.match(toggle1.textContent, /Ligado/);
  assert.equal(toggle1.getAttribute('aria-label'), 'Desligar monitor HDMI-A-1');

  const toggle2 = h.el('[data-monitor-toggle="DP-1"]');
  assert.match(toggle2.textContent, /Desligado/);
  assert.equal(toggle2.getAttribute('aria-label'), 'Ligar monitor DP-1');

  assert.match(h.el('#btn-smart-sleep').textContent, /Dormir inteligente/);
  assert.match(h.el('#btn-wake').textContent, /Acordar/);
  assert.match(h.el('#btn-poweroff').textContent, /Desligar computador/);
  assert.match(h.el('#poweroff-dialog').textContent, /Desligar o computador\?/);
});

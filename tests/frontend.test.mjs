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

function mappingContext() {
  const context = vm.createContext({ Uint8Array, TextDecoder, Date, t: key => key, Number, Math, URL, encodeURIComponent });
  vm.runInContext(`${parserSource}
    globalThis.mapTouchToMonitorPixel = mapTouchToMonitorPixel;
    globalThis.visibleMonitorRegion = visibleMonitorRegion;
    globalThis.isFullMonitorRegion = isFullMonitorRegion;
    globalThis.liveStreamPath = liveStreamPath;
    globalThis.classifyScreenGesture = classifyScreenGesture;
    globalThis.workspaceDropTargetIds = workspaceDropTargetIds;
    globalThis.scaleMonitorRegion = scaleMonitorRegion;
    globalThis.regionsClose = regionsClose;
    globalThis.nativePreviewRegion = nativePreviewRegion;
  `, context);
  return context;
}

test('touch mapping converts zoom and pan into monitor pixels', () => {
  const m = mappingContext();
  const plain = value => value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  assert.deepEqual(plain(m.mapTouchToMonitorPixel(480, 270, { imageWidth: 960, imageHeight: 540, monitorWidth: 1920, monitorHeight: 1080 })), { x: 960, y: 540 });
  assert.deepEqual(plain(m.mapTouchToMonitorPixel(0, 0, { imageWidth: 960, imageHeight: 540, monitorWidth: 1920, monitorHeight: 1080 })), { x: 0, y: 0 });
  assert.deepEqual(plain(m.mapTouchToMonitorPixel(200, 150, {
    imageWidth: 400, imageHeight: 300, monitorWidth: 1920, monitorHeight: 1080, region: { x: 100, y: 100, w: 800, h: 600 },
  })), { x: 500, y: 400 });
  assert.equal(m.mapTouchToMonitorPixel(-1, 0, { imageWidth: 400, imageHeight: 300, monitorWidth: 1920, monitorHeight: 1080 }), null);
  assert.deepEqual(plain(m.visibleMonitorRegion({
    previewWidth: 960, previewHeight: 540, scrollLeft: 0, scrollTop: 0, imageWidth: 1920, imageHeight: 1080, monitorWidth: 1920, monitorHeight: 1080,
  })), { x: 0, y: 0, w: 960, h: 540 });
  assert.deepEqual(plain(m.visibleMonitorRegion({
    previewWidth: 400, previewHeight: 300, scrollLeft: 200, scrollTop: 150, imageWidth: 800, imageHeight: 600,
    monitorWidth: 1920, monitorHeight: 1080, region: { x: 100, y: 100, w: 800, h: 600 },
  })), { x: 300, y: 250, w: 400, h: 300 });
  assert.equal(m.isFullMonitorRegion({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080), true);
  assert.equal(m.isFullMonitorRegion({ x: 100, y: 80, w: 640, h: 360 }, 1920, 1080), false);
  assert.equal(m.liveStreamPath({ monitor: 'DP-1', fps: 10, scale: 0.5 }), '/stream?monitor=DP-1&fps=10&scale=0.5');
  assert.equal(m.liveStreamPath({ monitor: 'DP-1', fps: 6, scale: 0.65, region: { x: 10, y: 20, w: 30, h: 40 } }), '/stream?monitor=DP-1&fps=6&scale=0.65&x=10&y=20&w=30&h=40');
  assert.equal(m.classifyScreenGesture({ pointerCount: 1, moved: false, durationMs: 20 }), 'tap');
  assert.equal(m.classifyScreenGesture({ pointerCount: 1, moved: false, durationMs: 500 }), 'longpress');
  assert.equal(m.classifyScreenGesture({ pointerCount: 1, moved: true, durationMs: 20 }), 'pan');
  assert.equal(m.classifyScreenGesture({ pointerCount: 2, moved: false, durationMs: 20 }), 'pinch');
  assert.deepEqual(plain(m.workspaceDropTargetIds([{ id: 8 }, { id: 3 }, { id: -1 }, { id: 101 }], 7)), [1, 2, 3, 4, 5, 7, 8]);
  assert.equal(m.scaleMonitorRegion({ x: 100, y: 100, w: 800, h: 600 }, 4, null, 1920, 1080), null);
  assert.equal(m.regionsClose({ x: 10, y: 10, w: 100, h: 100 }, { x: 12, y: 11, w: 101, h: 99 }), true);
  const oneToOne = plain(m.nativePreviewRegion(390, 220, 1920, 1080, { x: 960, y: 540 }));
  assert.deepEqual(oneToOne, { x: 765, y: 430, w: 390, h: 220 });
  assert.equal(m.isFullMonitorRegion(oneToOne, 1920, 1080), false);
  assert.ok(Math.abs(oneToOne.w / oneToOne.h - 390 / 220) < 0.02);
  assert.equal(m.nativePreviewRegion(1920, 1080, 1920, 1080, { x: 960, y: 540 }), null);
  const fitted = plain(m.nativePreviewRegion(2000, 2000, 1920, 1080, { x: 960, y: 540 }));
  assert.deepEqual(fitted, { x: 420, y: 0, w: 1080, h: 1080 });
  const pinched = plain(m.scaleMonitorRegion(null, 0.5, { x: 960, y: 540 }, 1920, 1080));
  assert.deepEqual(pinched, { x: 480, y: 270, w: 960, h: 540 });
});


test('Android permission dialog keeps the pending microphone request, while background closes it', () => {
  const handlerSource = source.slice(source.indexOf("window.addEventListener('ponte-native-pause'"), source.indexOf("window.addEventListener('hashchange'"));
  let listener;
  const calls = [];
  const context = vm.createContext({
    window: {addEventListener: (_event, callback) => { listener = callback; }},
    nativePaused: false, terminalTimer: null, terminalGeneration: 0, clearTimeout() {},
    leaveScreen: () => calls.push('screen'), stopDrag: () => calls.push('drag'),
    cancelPendingRecording: () => calls.push('pending'), stopRecording: () => calls.push('recording'), closeMicrophone: () => calls.push('microphone'), abortDictation: () => calls.push('dictation'),
  });
  vm.runInContext(handlerSource, context);
  listener({detail: {awaitingMicrophonePermission: true}});
  assert.deepEqual(calls, ['screen', 'drag']);
  calls.length = 0;
  listener({});
  assert.deepEqual(calls, ['screen', 'drag', 'pending', 'recording', 'microphone', 'dictation']);
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

function powerUiHarness({ stored = { 'ponte-pair-token': 'synthetic-token' }, state = powerFixture, actionResult = () => ({ ok: true }), textInput = {}, userAgent = 'Test browser' } = {}) {
  const document = makeDocument(htmlSource);
  const window = makeWindow();
  const saved = new Map(Object.entries(stored));
  const calls = [];
  let timer = 0;
  const timers = new Map();
  const context = vm.createContext({
    document,
    window,
    localStorage: {
      getItem: key => saved.get(key) || null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: key => saved.delete(key),
    },
    navigator: { language: 'en', languages: ['en'], userAgent },
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
    setTimeout: (callback, delay = 0) => { const id = ++timer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++timer,
    clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === '/api/state') return { ok: true, json: async () => state };
      if (path === '/api/action') return { ok: true, json: async () => actionResult(options.body ? JSON.parse(options.body) : {}) };
      if (path === '/api/textinput') return { ok: true, json: async () => typeof textInput === 'function' ? textInput() : textInput };
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
    runTimer: async id => {
      const entry = timers.get(id);
      assert.ok(entry, `timer ${id} is scheduled`);
      timers.delete(id);
      await entry.callback();
      await flushTicks();
      return entry.delay;
    },
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

test('Smart sleep names a keyboard it could not find and shows lights a partial sleep left on', async () => {
  const lightsState = { ...powerFixture, capabilities: { ...powerFixture.capabilities, lights: true }, lights: { preset: 'lava', sleeping: true, brightness: 100, incomplete: ['GPU'], presets: ['lava'] } };
  const h = powerUiHarness({ state: lightsState, actionResult: () => ({ ok: true, lights: { ok: true, devices: [{ device: 'RAM ENE', status: 'ok' }, { device: 'G515', status: 'absent' }, { device: 'MSI (fans)', status: 'ok' }] } }) });
  await flushTicks();
  h.run("navigate('inicio')");
  h.el('#btn-smart-sleep').click();
  await flushTicks(40);
  assert.equal(h.el('#toast').textContent, 'Smart sleep: monitors and lights turned off. Not found (turned off?): G515.');
  assert.equal(h.el('#toast').classList.contains('error'), false);
  h.run('renderLights && renderLights()');
  assert.match(h.el('#lights-status').textContent, /Lights are off except: GPU\./);
});

test('A pending sleep says the lights are still changing and later names the ones that did not respond', async () => {
  const lightsState = { ...powerFixture, capabilities: { ...powerFixture.capabilities, lights: true }, lights: { preset: 'lava', sleeping: false, brightness: 100, incomplete: [], presets: ['lava'], last: null } };
  const h = powerUiHarness({ state: lightsState, actionResult: () => ({ ok: true, lights: { pending: true, job: 7 } }) });
  await flushTicks();
  h.run("navigate('inicio')");
  h.el('#btn-smart-sleep').click();
  await flushTicks(40);
  assert.equal(h.el('#toast').textContent, 'The lights are still changing on the PC. The result will show here.');
  lightsState.lights = { ...lightsState.lights, sleeping: true, incomplete: ['GPU'], last: { job: 6, ok: true, devices: [] } };
  h.run('navigate("tela")');
  await h.run('pollState()'); await flushTicks(40);
  assert.equal(h.el('#toast').textContent, 'The lights are still changing on the PC. The result will show here.', 'another job does not settle this one');
  lightsState.lights = { ...lightsState.lights, last: { job: 7, action: 'power.sleep', ok: false, devices: [{ device: 'GPU', status: 'failed' }, { device: 'G515', status: 'absent' }] } };
  await h.run('pollState()'); await flushTicks(40);
  assert.equal(h.el('#toast').textContent, 'These lights did not respond: GPU.');
  assert.equal(h.el('#toast').classList.contains('error'), true);
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

test('direct touch: a tap clicks the mapped pixel, a held move starts a semantic drag, and a hold right-clicks', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';screenMode='live';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;applyScreenZoom();$('#screen-image').clientWidth=390;$('#screen-image').clientHeight=219;$('#monitor-select').value='HDMI-A-1'");
  const preview = h.el('#screen-preview');
  const evt = (type, id, x, y) => ({ type, pointerId: id, clientX: x, clientY: y, button: 0, target: preview, preventDefault(){}, closest: () => null });
  const actions = () => h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));
  // Tap at the image centre -> left click at the monitor centre; no move requests.
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 1, 195, 109.5));
  preview.dispatchEvent(evt('pointerup', 1, 195, 109.5));
  await flushTicks();
  assert.deepEqual(actions(), [{ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 960, y: 540, button: 'left', textBaseline: true }]);
  h.calls.length = 0;
  // A held move starts a captured drag and releases it, but never emits a click.
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 2, 100, 100));
  h.run('hold.held=true');
  preview.dispatchEvent(evt('pointermove', 2, 180, 150));
  await flushTicks();
  preview.dispatchEvent(evt('pointerup', 2, 180, 150));
  await flushTicks();
  assert.deepEqual(actions().map(item => item.type), ['mouse.dragStartAt', 'mouse.drag']);
  assert.equal(actions()[1].pressed, false);
  h.calls.length = 0;
  // A held press (no move) then lift -> right click at the press point.
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 3, 39, 22));
  h.run('hold.held=true');
  preview.dispatchEvent(evt('pointerup', 3, 39, 22));
  await flushTicks();
  assert.deepEqual(actions(), [{ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 192, y: 108, button: 'right' }]);
});

test('direct touch tolerates finger jitter and a deliberate one-finger move drags like a mouse', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';screenMode='live';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;applyScreenZoom();$('#screen-image').clientWidth=390;$('#screen-image').clientHeight=219;$('#monitor-select').value='HDMI-A-1'");
  const preview = h.el('#screen-preview');
  const evt = (type, id, x, y) => ({ type, pointerId: id, clientX: x, clientY: y, button: 0, target: preview, preventDefault(){}, closest: () => null });
  const actions = () => h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));

  // A real fingertip rarely lifts at the exact down coordinate. This 15 px
  // wobble is still a tap and must click once, not disappear as a fake pan.
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 31, 100, 100));
  preview.dispatchEvent(evt('pointermove', 31, 112, 109));
  preview.dispatchEvent(evt('pointerup', 31, 112, 109));
  await flushTicks();
  assert.deepEqual(actions(), [{ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 492, y: 493, button: 'left', textBaseline: true }]);

  h.calls.length = 0;
  // At fitted 1×, a deliberate one-finger move should hold the left button so
  // desktop text, list rows and sliders can be selected without a long press.
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 32, 100, 100));
  preview.dispatchEvent(evt('pointermove', 32, 145, 100));
  await flushTicks();
  preview.dispatchEvent(evt('pointermove', 32, 175, 100));
  await flushTicks();
  preview.dispatchEvent(evt('pointerup', 32, 175, 100));
  await flushTicks(30);
  assert.deepEqual(actions().map(item => item.type), ['mouse.dragStartAt', 'mouse.moveTo', 'mouse.drag']);
  assert.equal(actions().at(-1).pressed, false);
});

async function scrollScreenHarness() {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';screenMode='live';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;applyScreenZoom();$('#screen-image').clientWidth=390;$('#screen-image').clientHeight=219;$('#monitor-select').value='HDMI-A-1'");
  const preview = h.el('#screen-preview');
  const evt = (type, id, x, y) => ({ type, pointerId: id, clientX: x, clientY: y, button: 0, target: preview, preventDefault(){}, closest: () => null });
  const actions = () => h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));
  const send = async (type, id, x, y) => { if (type === 'pointerdown') h.run("screenMode='live'"); preview.dispatchEvent(evt(type, id, x, y)); await h.run('flushMovement()'); await flushTicks(); };
  // The first finger has been resting on the glass for a while.
  const rest = id => h.run(`screenPointers.get(${id}).started-=1000`);
  return { h, preview, actions, send, rest };
}

test('hold one finger and drag another: the PC scrolls under the held finger, and it never clicks or drags', async () => {
  const { h, actions, send, rest } = await scrollScreenHarness();
  await flushTicks();
  await send('pointerdown', 1, 100, 100);
  rest(1);
  await send('pointerdown', 2, 260, 180);
  await send('pointermove', 2, 262, 110);
  await send('pointermove', 1, 104, 97); // the resting finger wobbles: ignored
  await send('pointermove', 2, 262, 40);
  await send('pointerup', 2, 262, 40);
  await send('pointerdown', 3, 260, 60); // flick again with the finger still resting
  await send('pointermove', 3, 260, 130);
  await send('pointerup', 3, 260, 130);
  await send('pointerup', 1, 104, 97);
  await flushTicks(30);
  const sent = actions();
  assert.ok(sent.length >= 2, JSON.stringify(sent));
  assert.deepEqual([...new Set(sent.map(item => item.type))], ['mouse.scroll'], 'only wheel, no click or drag');
  assert.deepEqual(sent[0], { type: 'mouse.scroll', dy: -10, monitor: 'HDMI-A-1', x: 492, y: 493 }, 'the first scroll carries the held finger\'s pixel; finger up = wheel down (later text)');
  assert.ok(sent.slice(1).every(item => item.monitor === undefined), 'the pointer is placed once per gesture');
  const total = sent.reduce((sum, item) => sum + item.dy, 0);
  assert.equal(total, -20 + 10, '140 px up (later text) then 70 px down (earlier text) at 7 px per wheel step');
  assert.equal(h.run('screenScale'), 1, 'no zoom');
  assert.equal(h.el('#tap-marker').getAttribute('data-kind'), 'scroll');
});

test('hold-and-drag scrolls while zoomed instead of panning, and pinch and two-finger pan stay as before', async () => {
  const { h, actions, send, rest } = await scrollScreenHarness();
  await flushTicks();
  h.run('zoomScreenAround(3, 195, 110)');
  const pan = h.run('JSON.stringify([screenPanX, screenPanY])');
  await send('pointerdown', 1, 100, 100);
  rest(1);
  const pixel = h.run('JSON.stringify(monitorPixelAt(100, 100))');
  await send('pointerdown', 2, 260, 180);
  await send('pointermove', 2, 250, 110);
  await send('pointerup', 2, 250, 110);
  await send('pointerup', 1, 100, 100);
  await flushTicks(30);
  let sent = actions();
  assert.deepEqual(sent.map(item => item.type), ['mouse.scroll']);
  assert.deepEqual({ x: sent[0].x, y: sent[0].y }, JSON.parse(pixel), 'zoomed pixel under the held finger');
  assert.equal(sent[0].dy, -10, 'content follows the finger while zoomed too');
  assert.equal(h.run('screenScale'), 3, 'zoom untouched');
  assert.equal(h.run('JSON.stringify([screenPanX, screenPanY])'), pan, 'view did not pan');

  // Two fingers landing together while zoomed still pan the view, never scroll.
  h.calls.length = 0;
  await send('pointerdown', 4, 100, 100);
  await send('pointerdown', 5, 200, 100);
  await send('pointermove', 4, 100, 60);
  await send('pointermove', 5, 200, 60);
  await send('pointerup', 4, 100, 60);
  await send('pointerup', 5, 200, 60);
  await flushTicks(30);
  assert.deepEqual(actions(), [], 'zoomed two-finger drag is a local pan');
  assert.notEqual(h.run('JSON.stringify([screenPanX, screenPanY])'), pan);

  // A pinch lands both fingers together; even with one of them nearly still it zooms.
  h.calls.length = 0;
  h.run('screenScale=1;applyScreenZoom()');
  await send('pointerdown', 6, 150, 110);
  await send('pointerdown', 7, 200, 110);
  await send('pointermove', 7, 260, 110);
  await send('pointermove', 7, 300, 110);
  await send('pointerup', 7, 300, 110);
  await send('pointerup', 6, 150, 110);
  await flushTicks(30);
  assert.deepEqual(actions(), [], 'a pinch never scrolls or clicks');
  assert.ok(h.run('screenScale') > 2, 'the pinch zoomed');
});

test('two fingers together at 1x scroll at their midpoint, so the wheel reaches the window between them', async () => {
  const { h, actions, send } = await scrollScreenHarness();
  await flushTicks();
  await send('pointerdown', 1, 100, 100);
  await send('pointerdown', 2, 140, 100);
  // Real fingers report small interleaved steps; the spacing barely changes.
  for (let y = 95; y >= 50; y -= 5) { await send('pointermove', 1, 100, y); await send('pointermove', 2, 140, y); }
  await send('pointerup', 1, 100, 50);
  await send('pointerup', 2, 140, 50);
  await flushTicks(30);
  const sent = actions();
  assert.deepEqual([...new Set(sent.map(item => item.type))], ['mouse.scroll']);
  assert.equal(sent[0].monitor, 'HDMI-A-1');
  assert.deepEqual({ x: sent[0].x, y: sent[0].y }, JSON.parse(h.run('JSON.stringify(monitorPixelAt(120, 100))')));
  assert.equal(sent.reduce((sum, item) => sum + item.dy, 0), -7, 'two fingers 50 px up show later text (wheel down)');
  assert.equal(h.run('screenScale'), 1);
});

test('scroll buttons step the wheel at the last touch (or the view centre), repeat while held, and never click', async () => {
  const { h, actions, send } = await scrollScreenHarness();
  const up = h.all('[data-scroll-step]').find(button => button.dataset.scrollStep === '1');
  const down = h.all('[data-scroll-step]').find(button => button.dataset.scrollStep === '-1');
  assert.ok(up && down, 'both buttons are in the screen FABs');
  assert.equal(h.el('.screen-fabs').querySelector('#screen-scroll').querySelectorAll('[data-scroll-step]').length, 2, 'they live with the floating buttons, outside the monitor');
  const press = button => button.dispatchEvent({ type: 'pointerdown', pointerId: 9, button: 0, target: button, preventDefault(){} });
  const lift = button => button.dispatchEvent({ type: 'pointerup', pointerId: 9, button: 0, target: button, preventDefault(){} });
  // No touch yet: the centre of what the phone shows.
  const centre = JSON.parse(h.run("(() => { const r = screenPreview.getBoundingClientRect(); return JSON.stringify(monitorPixelAt(r.left + (r.width || screenPreview.clientWidth) / 2, r.top + (r.height || screenPreview.clientHeight) / 2)); })()"));
  press(up); await flushTicks(); lift(up); await flushTicks();
  assert.deepEqual(actions(), [{ type: 'mouse.scroll', dy: 3, monitor: 'HDMI-A-1', x: centre.x, y: centre.y }]);
  // After a tap, the wheel goes where the finger was. Holding repeats without re-placing.
  await send('pointerdown', 1, 100, 100); await send('pointerup', 1, 100, 100);
  h.calls.length = 0;
  press(down); await flushTicks();
  const repeat = h.run('scrollButtonTimer');
  await h.runTimer(repeat);
  await h.runTimer(h.run('scrollButtonTimer'));
  lift(down); await flushTicks();
  assert.equal(h.run('scrollButtonTimer'), 0, 'lifting stops the repeat');
  const sent = actions();
  assert.deepEqual(sent[0], { type: 'mouse.scroll', dy: -3, monitor: 'HDMI-A-1', x: 492, y: 493 });
  assert.deepEqual(sent.slice(1), [{ type: 'mouse.scroll', dy: -3 }, { type: 'mouse.scroll', dy: -3 }]);
  // Leaving the screen cancels a held button.
  press(up); await flushTicks();
  h.run("navigate('inicio')");
  assert.equal(h.run('scrollButtonTimer'), 0);
});

test('dragging a window onto the workspace shelf moves the captured window without switching view', async () => {
  const state = { ...powerFixture, activeWindow: { address: '0xabc', workspace: { id: 1 } }, workspaces: [{ id: 1, name: '1', windows: 1 }, { id: 3, name: '3', windows: 0 }] };
  const h = powerUiHarness({ state, actionResult: body => body.type === 'mouse.dragStartAt' ? { ok: true, window: { address: '0xabc', workspace: { id: 1 } } } : { ok: true } });
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';screenMode='live';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;applyScreenZoom();$('#screen-image').clientWidth=390;$('#screen-image').clientHeight=219;$('#monitor-select').value='HDMI-A-1'");
  const preview = h.el('#screen-preview');
  const evt = (type, id, x, y) => ({ type, pointerId: id, clientX: x, clientY: y, button: 0, target: preview, preventDefault(){}, closest: () => null });
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 9, 100, 70));
  h.run('hold.held=true');
  preview.dispatchEvent(evt('pointermove', 9, 125, 80));
  await flushTicks();
  const target = h.all('[data-drop-workspace]').find(item => item.dataset.dropWorkspace === '3');
  assert.ok(target, 'workspace 3 is offered as a drop target');
  target._left = 200; target._top = 160; target.clientWidth = 46; target.clientHeight = 46;
  preview.dispatchEvent(evt('pointermove', 9, 220, 180));
  preview.dispatchEvent(evt('pointerup', 9, 220, 180));
  await flushTicks(30);
  const actions = h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));
  assert.deepEqual(actions.map(item => item.type), ['mouse.dragStartAt', 'mouse.drag', 'window.moveToWorkspace']);
  assert.deepEqual(actions.at(-1), { type: 'window.moveToWorkspace', address: '0xabc', id: 3 });
  assert.equal(h.el('#workspace-drop-shelf').hidden, true);

  h.calls.length = 0;
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 10, 100, 70));
  h.run('hold.held=true');
  preview.dispatchEvent(evt('pointermove', 10, 125, 80));
  await flushTicks();
  const cancelTarget = h.all('[data-drop-workspace]').find(item => item.dataset.dropWorkspace === '3');
  cancelTarget._left = 200; cancelTarget._top = 160; cancelTarget.clientWidth = 46; cancelTarget.clientHeight = 46;
  preview.dispatchEvent(evt('pointermove', 10, 220, 180));
  preview.dispatchEvent(evt('pointercancel', 10, 220, 180));
  await flushTicks(30);
  const cancelled = h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));
  assert.deepEqual(cancelled.map(item => item.type), ['mouse.dragStartAt', 'mouse.drag'], 'pointer cancellation only releases input');
});

test('a tap on a frame that is not live never clicks: it brings the stream back and says so', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;applyScreenZoom();$('#screen-image').clientWidth=390;$('#screen-image').clientHeight=219;$('#monitor-select').value='HDMI-A-1';stopLive();liveWanted=false;screenMode='paused'");
  const preview = h.el('#screen-preview');
  const evt = (type, id, x, y) => ({ type, pointerId: id, clientX: x, clientY: y, button: 0, target: preview, preventDefault(){}, closest: () => null });
  const actions = () => h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));
  h.calls.length = 0;
  preview.dispatchEvent(evt('pointerdown', 1, 195, 109.5));
  preview.dispatchEvent(evt('pointerup', 1, 195, 109.5));
  await flushTicks();
  assert.deepEqual(actions(), [], 'a still frame is not a click target');
  assert.equal(h.run('liveWanted'), true);
  assert.ok(h.run('!!liveSession'), 'the tap restarted the stream');
  assert.match(h.el('#toast')?.textContent || h.document.body.textContent, /still|parada/i);
  // Once frames flow again the same tap clicks and leaves a marker under the finger.
  h.run("screenMode='live'");
  preview.dispatchEvent(evt('pointerdown', 2, 195, 109.5));
  preview.dispatchEvent(evt('pointerup', 2, 195, 109.5));
  await flushTicks();
  assert.deepEqual(actions(), [{ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 960, y: 540, button: 'left', textBaseline: true }]);
  const marker = h.el('#tap-marker');
  assert.equal(marker.hidden, false);
  assert.equal(marker.getAttribute('data-kind'), 'left');
  assert.equal(marker.style.left, '195px');
});

test('sharp streams native pixels (no CPU downscale in grim) at a bandwidth-capped JPEG quality', async () => {
  const h = powerUiHarness();
  await flushTicks();
  const sharp = JSON.parse(h.run('JSON.stringify(LIVE_PROFILES.sharp)'));
  assert.equal(sharp.scale, 1);
  assert.ok(sharp.quality <= 40 && sharp.quality >= 30, `quality ${sharp.quality}`);
  h.run("var probe={monitor:'DP-3',region:null};applyLiveProfile(probe,'sharp')");
  assert.equal(h.run('liveStreamPath(probe)'), '/stream?monitor=DP-3&fps=15&scale=1&q=40');
});

test('a pinch survives the auto quality profile changing the frame resolution, and resets for another shape', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';screenMode='live';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=672;$('#screen-image').naturalHeight=378;screenSourceSize='';$('#screen-image').dispatchEvent({type:'load'});");
  assert.equal(h.run('screenScale'), 1);
  assert.ok(h.run('screenMaxScale') >= 4, 'a light frame still allows 4x for precise taps');
  h.run('zoomScreenAround(3, 100, 100)');
  assert.equal(h.run('screenScale'), 3);
  const pan = h.run('[screenPanX, screenPanY]');
  // Auto quality climbs to native pixels: same monitor, sharper frame.
  h.run("$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;$('#screen-image').dispatchEvent({type:'load'});");
  assert.equal(h.run('screenScale'), 3, 'zoom kept across the resolution change');
  assert.deepEqual(h.run('[screenPanX, screenPanY]'), pan, 'pan kept too');
  // A different shape is another monitor: back to fitted 1x.
  h.run("$('#screen-image').naturalWidth=2560;$('#screen-image').naturalHeight=1440;$('#screen-image').dispatchEvent({type:'load'});");
  assert.equal(h.run('screenScale'), 3, 'same 16:9 shape from another size keeps zoom');
  h.run("$('#screen-image').naturalWidth=3440;$('#screen-image').naturalHeight=1440;$('#screen-image').dispatchEvent({type:'load'});");
  assert.equal(h.run('screenScale'), 1, 'ultrawide is a different monitor: zoom resets');
});

test('the screen shows Omarchy workspaces, lights the one on the streamed monitor, and a tap is Super+N that follows the workspace to its monitor', async () => {
  const fixture = { ...powerFixture,
    workspaces: [{ id: 1, name: '1', windows: 2, monitor: 'HDMI-A-1' }, { id: 3, name: '3', windows: 1, monitor: 'DP-1' }, { id: 7, name: '7', windows: 0, monitor: 'HDMI-A-1' }],
    monitors: powerFixture.monitors.map((m, i) => ({ ...m, activeWorkspace: i === 0 ? 1 : 3 })) };
  const h = powerUiHarness({ state: fixture });
  await flushTicks();
  h.run("navigate('tela');connected=true;$('#monitor-select').value='HDMI-A-1';screenWorkspaceSignature='';renderScreenWorkspaces()");
  const strip = h.el('#screen-workspaces');
  const chips = [...h.all('[data-screen-workspace]')];
  assert.deepEqual(chips.map(c => c.getAttribute('data-screen-workspace')), ['1', '2', '3', '4', '5', '7'], 'the familiar first five plus every live workspace');
  assert.equal(chips[0].classList.contains('active'), true, 'workspace 1 is what HDMI-A-1 shows');
  assert.equal(chips.filter(c => c.classList.contains('active')).length, 1);
  assert.ok(chips[0].querySelector('i'), 'a dot marks workspaces with windows');
  assert.ok(!chips[1].querySelector('i'));
  h.calls.length = 0;
  // Workspace 4 does not exist yet: focus it on the streamed monitor.
  strip.dispatchEvent({ type: 'click', target: chips[3] });
  await flushTicks();
  const actions = () => h.calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.options.body));
  assert.deepEqual(actions(), [{ type: 'workspace.focus', id: 4, monitor: 'HDMI-A-1' }]);
  // Workspace 3 lives on DP-1: the stream follows it there before focusing.
  h.calls.length = 0;
  strip.dispatchEvent({ type: 'click', target: chips[2] });
  await flushTicks();
  assert.equal(h.el('#monitor-select').value, 'DP-1');
  assert.deepEqual(actions().filter(a => a.type === 'workspace.focus'), [{ type: 'workspace.focus', id: 3, monitor: 'DP-1' }]);
});

// Synthetic fcitx input contexts. The canvas app keeps its IC focused whatever
// is clicked (measured on Maestri: same id and cap before and after every
// click on its canvas); a page field shows up as a new IC or a new cap.
const CANVAS_IC = { id: 'ic-canvas', program: 'canvas-app', cap: '90072', typeable: true };
const FIELD_IC = { id: 'ic-page', program: 'browser', cap: '90072', typeable: true };
const URL_IC = { id: 'ic-page', program: 'browser', cap: '1072', typeable: true };
const TERMINAL_IC = { id: 'ic-term', program: 'terminal', cap: '100000072', typeable: true };
const focusedOn = context => ({ available: true, focused: Boolean(context), context: context || null });
const NATIVE_UA = 'Android PonteAndroid/0.1.0-alpha.17';

function nativeTapHarness({ textInput, tapResult }) {
  const h = powerUiHarness({ textInput, userAgent: NATIVE_UA, actionResult: body => body.type === 'mouse.clickAt' ? (typeof tapResult === 'function' ? tapResult(body) : tapResult) : { ok: true } });
  h.bridge = 0;
  h.window.PonteNative = { showKeyboard: () => { h.bridge++; }, hideKeyboard() {} };
  return h;
}
async function openStream(h) {
  await flushTicks();
  h.run("navigate('tela');connected=true;state.capabilities={mouse:true,keyboard:true,screenshot:true,live:true,audio:true};screenshotURL='blob:screen';screenMode='live';$('#screen-preview').clientWidth=390;$('#screen-preview').clientHeight=220;$('#screen-image').naturalWidth=1920;$('#screen-image').naturalHeight=1080;applyScreenZoom();$('#screen-image').clientWidth=390;$('#screen-image').clientHeight=219;$('#monitor-select').value='HDMI-A-1'");
}
async function tapStream(h, { x = 195, y = 109.5, id = 27 } = {}) {
  // The fake stream ends at once and drops the screen out of live; a tap on a
  // still frame never clicks, so each tap starts from a live screen.
  h.run("screenMode='live'");
  const preview = h.el('#screen-preview');
  const event = type => ({ type, pointerId: id, clientX: x, clientY: y, button: 0, target: preview, preventDefault(){}, closest: () => null });
  preview.dispatchEvent(event('pointerdown'));
  preview.dispatchEvent(event('pointerup'));
  await flushTicks();
}
// Runs the tap's probe and every retry it schedules.
async function settleKeyboard(h) {
  for (let i = 0; i < 8 && h.run('keyboardCheckTimer'); i++) await h.runTimer(h.run('keyboardCheckTimer'));
}

test('native Android opens the phone keyboard when the tap focused a PC text field (none -> field)', async () => {
  const h = nativeTapHarness({ textInput: focusedOn(FIELD_IC), tapResult: { ok: true, textBefore: null, windowChanged: false } });
  await openStream(h);
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, false);
  assert.equal(h.document.activeElement, h.el('#screen-input'));
  assert.equal(h.bridge, 1);
  assert.equal(h.run('screenComposerAutomatic'), true);
});

test('a tap on a canvas whose input context was already focused never opens the keyboard (Maestri)', async () => {
  const h = nativeTapHarness({ textInput: focusedOn(CANVAS_IC), tapResult: { ok: true, textBefore: CANVAS_IC, windowChanged: false } });
  await openStream(h);
  for (let i = 0; i < 3; i++) { await tapStream(h, { id: 30 + i }); await settleKeyboard(h); }
  assert.equal(h.el('#screen-composer').hidden, true);
  assert.equal(h.bridge, 0);
  assert.equal(h.el('#screen-keyboard').getAttribute('data-text-focused'), 'true', 'the keyboard button still shows the PC has a focused IC');
  assert.equal(h.calls.filter(call => call.path === '/api/textinput').length, 3, 'one probe per tap, no retries for a focus that already existed');
});

test('a terminal already focused plus a tap elsewhere in it does not open the keyboard', async () => {
  const h = nativeTapHarness({ textInput: focusedOn(TERMINAL_IC), tapResult: { ok: true, textBefore: TERMINAL_IC, windowChanged: false } });
  await openStream(h);
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, true);
  assert.equal(h.bridge, 0);
});

test('a tap that also activates another window is no proof of a text field: the keyboard stays closed', async () => {
  // Maestri focuses its hidden textarea on the click that activates it: fcitx
  // shows none -> IC exactly like a real field, so the safe answer is no.
  const h = nativeTapHarness({ textInput: focusedOn(CANVAS_IC), tapResult: { ok: true, textBefore: null, windowChanged: true } });
  await openStream(h);
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, true);
  assert.equal(h.bridge, 0);
  h.el('#screen-keyboard').dispatchEvent({ type: 'click' });
  assert.equal(h.el('#screen-composer').hidden, false, 'the manual keyboard button always works');
});

test('the same window going from its address bar to a page field (new cap) counts as the tap focusing a field', async () => {
  const h = nativeTapHarness({ textInput: focusedOn(FIELD_IC), tapResult: { ok: true, textBefore: URL_IC, windowChanged: false } });
  await openStream(h);
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, false);
});

test('an older server without a baseline never opens the keyboard by itself', async () => {
  const h = nativeTapHarness({ textInput: { available: true, focused: true }, tapResult: { ok: true } });
  await openStream(h);
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, true);
  assert.equal(h.el('#screen-keyboard').getAttribute('data-text-focused'), 'true');
});

test('native tap retries a transient unfocused probe and uses the Android keyboard bridge', async () => {
  const probes = [focusedOn(null), focusedOn(FIELD_IC)];
  const h = nativeTapHarness({ textInput: () => probes.shift() ?? probes.at(-1), tapResult: { ok: true, textBefore: null, windowChanged: false } });
  await openStream(h);
  await tapStream(h);
  await h.runTimer(h.run('keyboardCheckTimer'));
  assert.equal(h.el('#screen-composer').hidden, true, 'first transient false does not open the composer');
  await h.runTimer(h.run('keyboardCheckTimer'));
  assert.equal(h.el('#screen-composer').hidden, false);
  assert.equal(h.document.activeElement, h.el('#screen-input'));
  assert.equal(h.bridge, 1);
  assert.equal(h.calls.filter(call => call.path === '/api/textinput').length, 2);
});

test('an automatic bar closes when a later tap leaves its field; a bar opened by hand stays', async () => {
  let current = FIELD_IC;
  let before = null;
  const h = nativeTapHarness({ textInput: () => focusedOn(current), tapResult: () => ({ ok: true, textBefore: before, windowChanged: false }) });
  await openStream(h);
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, false);
  // Tap on the canvas app: its IC is focused now, not the field the bar was for.
  before = FIELD_IC; current = CANVAS_IC;
  await tapStream(h, { id: 41 });
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, true, 'the automatic bar followed the focus out');
  // Opened by hand: taps that do not focus a field leave it alone.
  h.el('#screen-keyboard').dispatchEvent({ type: 'click' });
  assert.equal(h.run('screenComposerAutomatic'), false);
  before = CANVAS_IC;
  await tapStream(h, { id: 42 });
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, false);
});

test('the auto keyboard can be turned off and stays off; the button still opens the bar', async () => {
  const h = nativeTapHarness({ textInput: focusedOn(FIELD_IC), tapResult: { ok: true, textBefore: null, windowChanged: false } });
  await openStream(h);
  h.el('#screen-auto-keyboard').dispatchEvent({ type: 'click' });
  assert.equal(h.el('#screen-auto-keyboard').getAttribute('aria-pressed'), 'false');
  assert.equal(h.run("localStorage.getItem('ponte-auto-keyboard')"), 'off');
  await tapStream(h);
  await settleKeyboard(h);
  assert.equal(h.el('#screen-composer').hidden, true);
  h.el('#screen-keyboard').dispatchEvent({ type: 'click' });
  assert.equal(h.el('#screen-composer').hidden, false);
});

test('a drag on the stream never probes for a text field', async () => {
  const h = nativeTapHarness({ textInput: focusedOn(FIELD_IC), tapResult: { ok: true, textBefore: null, windowChanged: false } });
  await openStream(h);
  const preview = h.el('#screen-preview');
  const event = (type, x) => ({ type, pointerId: 50, clientX: x, clientY: 100, button: 0, target: preview, preventDefault(){}, closest: () => null });
  preview.dispatchEvent(event('pointerdown', 100));
  preview.dispatchEvent(event('pointermove', 160));
  preview.dispatchEvent(event('pointerup', 160));
  await flushTicks();
  await settleKeyboard(h);
  assert.equal(h.calls.filter(call => call.path === '/api/textinput').length, 0);
  assert.equal(h.el('#screen-composer').hidden, true);
});

test('floating buttons cycle the streamed monitor and toggle a forced landscape', async () => {
  const h = powerUiHarness();
  await flushTicks();
  h.run("navigate('tela');connected=true");
  h.el('#monitor-select').value = 'HDMI-A-1';
  h.calls.length = 0;
  h.el('#screen-switch-monitor').click();
  await flushTicks();
  assert.equal(h.el('#monitor-select').value, 'DP-1');
  assert.ok(h.calls.some(call => call.path.startsWith('/api/stream?monitor=DP-1')), 'the stream restarts on the next monitor');
  assert.match(h.el('#toast').textContent, /DP-1 · 2560 × 1440/);
  h.el('#screen-switch-monitor').click();
  assert.equal(h.el('#monitor-select').value, 'HDMI-A-1', 'cycles back around');
  const rotate = h.el('#screen-rotate');
  assert.equal(rotate.getAttribute('aria-pressed'), 'false');
  rotate.click();
  assert.equal(rotate.getAttribute('aria-pressed'), 'true');
  assert.equal(h.run('landscapeForced'), true);
  h.run("navigate('inicio')");
  assert.equal(h.run('landscapeForced'), false, 'leaving the screen releases the orientation');
  assert.equal(rotate.getAttribute('aria-pressed'), 'false');
});

// The adapter is pure: evaluate it with a fake clock, no DOM or stream.
function adapterHarness(options = {}) {
  const adapterSource = source.slice(source.indexOf('const LIVE_LADDER ='), source.indexOf('\nfunction applyLiveProfile('));
  const clock = { at: 0 };
  const context = vm.createContext({ Math });
  vm.runInContext(`${adapterSource}\nglobalThis.create = createLiveAdapter;`, context);
  const adapter = context.create({ ...options, now: () => clock.at });
  // Deliver frames at `fps` for one window, then evaluate once.
  const window = (fps, requested) => { for (let i = 0; i < fps * 3; i++) adapter.frame(); clock.at += 3000; return adapter.evaluate(requested); };
  return { adapter, clock, window };
}

test('auto quality starts light, climbs only after consecutive healthy windows and stops at sharp', () => {
  const { adapter, window } = adapterHarness();
  assert.equal(adapter.profile, 'light');
  assert.equal(window(8, 8), null, 'one healthy window is not enough');
  assert.equal(window(8, 8), 'balanced', 'two healthy windows climb one rung');
  assert.equal(window(10, 10), null);
  assert.equal(window(10, 10), 'sharp');
  assert.equal(window(15, 15), null);
  assert.equal(window(15, 15), null, 'sharp is the top rung');
  assert.equal(adapter.profile, 'sharp');
});

test('auto quality steps down as soon as frames lag and holds before climbing again, longer after each fall', () => {
  const { adapter, clock, window } = adapterHarness({ start: 'sharp' });
  assert.equal(window(6, 15), 'balanced', 'under 60% of the requested rate drops a rung');
  for (let i = 0; i < 6; i++) assert.equal(window(10, 10), null, 'healthy again, but inside the 20 s hold');
  assert.equal(window(10, 10), 'sharp', 'climbs back once the hold has passed');
  assert.equal(window(5, 15), 'balanced', 'lags again');
  for (let i = 0; i < 13; i++) assert.equal(window(10, 10), null, 'the second hold is twice as long');
  assert.equal(window(10, 10), 'sharp');
  assert.equal(window(7, 10), null, 'between 60% and 90% neither drops nor counts as healthy');
  clock.at += 60000;
  assert.equal(window(2, 15), null, 'a window stretched by a pause is discarded, not judged');
  assert.equal(adapter.stall(), 'balanced', 'a broken stream drops a rung');
  assert.equal(adapter.stall(), 'light');
  assert.equal(adapter.stall(), null, 'light is the floor');
});

test('auto quality judges the link against what the PC can capture, not the requested rate', () => {
  const { adapter, clock } = adapterHarness();
  // Balanced on a 3440×1440 monitor: grim scales for ~140 ms, so 10 fps is ~7 on any link.
  const window = (fps, requested, captureMs) => { for (let i = 0; i < fps * 3; i++) adapter.frame(captureMs); clock.at += 3000; return adapter.evaluate(requested); };
  assert.equal(window(7, 8, 134), null);
  assert.equal(window(7, 8, 134), 'balanced');
  assert.equal(window(7, 10, 141), null, 'capture-bound, not lagging');
  assert.equal(window(7, 10, 141), 'sharp', 'reaches Sharp, the cheapest capture');
  assert.equal(window(6, 15, 18), 'balanced', 'a fast capture that still arrives late is the link');
  const old = adapterHarness({ start: 'balanced' });
  assert.equal(old.window(7, 10), null, 'without the header the requested rate is still the yardstick');
});

test('auto quality opens where the last session settled, or at sharp without recent history', () => {
  const adapterSource = source.slice(source.indexOf('const LIVE_LADDER ='), source.indexOf('\nfunction applyLiveProfile('));
  const context = vm.createContext({ Math, Number, String });
  vm.runInContext(`${adapterSource}\nglobalThis.start = liveStartRung;`, context);
  const at = 1_800_000_000_000;
  assert.equal(context.start('', at), 'sharp', 'no history opens readable');
  assert.equal(context.start(`balanced|${at - 60000}`, at), 'balanced', 'a slow link from a minute ago is remembered');
  assert.equal(context.start(`light|${at - 29 * 60000}`, at), 'light');
  assert.equal(context.start(`light|${at - 31 * 60000}`, at), 'sharp', 'an old answer is forgotten');
  assert.equal(context.start(`light|${at + 60000}`, at), 'sharp', 'a clock that went back is not trusted');
  assert.equal(context.start('huge|1', at), 'sharp');
  assert.equal(context.start('light', at), 'sharp', 'no time, no memory');
});

test('auto quality ignores partial windows', () => {
  const { adapter, clock } = adapterHarness();
  for (let i = 0; i < 20; i++) adapter.frame();
  clock.at += 1000;
  assert.equal(adapter.evaluate(8), null);
});

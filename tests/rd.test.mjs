import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { createDesktop } from '../backend/desktop.mjs';
import { connect } from '../backend/ws.mjs';
import { createAdaptation, createRemoteDesktop, parseVideoHeader, videoHeader } from '../backend/rd.mjs';

const TOKEN = 'test_token_with_at_least_thirty_two_characters';
const canRun = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('python3', ['--version']).status === 0;
const MONITORS = [
  { name: 'LAB-1', x: 0, y: 0, width: 960, height: 540, scale: 1, transform: 0, focused: true },
  { name: 'LAB-2', x: 960, y: 0, width: 800, height: 600, scale: 1, transform: 0, focused: false },
];

function fakeClipboard() {
  const clip = { written: [], watchers: 0, stopped: 0, emit: null };
  clip.watch = onText => { clip.watchers++; clip.emit = onText; return () => { clip.stopped++; }; };
  clip.write = async text => { clip.written.push(text); };
  return clip;
}

async function rdApp(t, rdOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-rd-'));
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Ponte</title>');
  const inputLog = path.join(root, 'events.jsonl');
  const clipboard = fakeClipboard();
  const runner = async (command, args) => command === 'hyprctl' && args[1] === 'monitors' ? JSON.stringify(MONITORS) : '[]';
  const desktop = createDesktop({ runner, exists: async () => true });
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN, desktop, trustedHosts: ['pc.tailnet.test'],
    rdOptions: { captureMode: 'lab', inputMode: 'dry-run', inputLog, readMonitors: async () => MONITORS, clipboard, kbps: 600, log: { info() {}, error() {} }, ...rdOverrides },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, port, url: `ws://127.0.0.1:${port}/api/rd`, inputLog, clipboard };
}

// A client that records text messages and video frames.
async function client(url, hello = {}) {
  const ws = await connect(url);
  const texts = [], frames = [], framesBefore = [];
  let closed = null;
  ws.on('message', (data, binary) => {
    if (binary) frames.push({ ...parseVideoHeader(data), bytes: data.length - 16, at: Date.now() });
    else { texts.push(JSON.parse(data)); framesBefore.push(frames.length); }
  });
  ws.on('close', (code, reason) => { closed = { code, reason }; });
  ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKEN, maxFps: 30, ...hello }));
  const until = async (predicate, what, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { ws, texts, frames, framesBefore, until, get closed() { return closed; }, send: value => ws.send(JSON.stringify(value)) };
}
const logEvents = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  .flatMap(line => { const { dev, events } = JSON.parse(line); return events.map(([, code, value]) => `${dev}:${code}=${value}`); });

test('video header: 16 bytes, big-endian, type 1, keyframe bit, seq and send time', () => {
  const header = videoHeader(258, true, 1790000000123.25);
  assert.equal(header.length, 16);
  assert.deepEqual([...header.subarray(0, 8)], [1, 1, 0, 0, 0, 0, 1, 2]);
  assert.deepEqual(parseVideoHeader(header), { type: 1, keyframe: true, seq: 258, sentAt: 1790000000123.25 });
  // What a browser reads with DataView defaults.
  const view = new DataView(header.buffer, header.byteOffset, 16);
  assert.equal(view.getUint32(4), 258); assert.equal(view.getFloat64(8), 1790000000123.25);
});

test('lab session end to end: hello → ready → keyframe first → a key reaches the dry-run log; ping/pong; release on disconnect', { skip: !canRun }, async t => {
  const { url, inputLog } = await rdApp(t);
  const c = await client(url);
  const ready = await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  assert.equal(ready.v, 1);
  assert.equal(ready.monitor, 'LAB-1');
  assert.equal(ready.width, 960); assert.equal(ready.height, 540);
  assert.equal(ready.fps, 30);
  assert.match(ready.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.deepEqual(ready.monitors.map(m => m.name), ['LAB-1', 'LAB-2']);
  assert.deepEqual(ready.input, { abs: true, rel: true, keys: true, clipboard: true });
  assert.equal(typeof ready.node.name, 'string');
  await c.until(() => c.frames.length >= 5, 'frames');
  assert.equal(c.frames[0].keyframe, true);
  assert.equal(c.frames[0].type, 1);
  assert.deepEqual(c.frames.slice(0, 5).map(f => f.seq), [1, 2, 3, 4, 5]);
  assert.ok(Math.abs(c.frames[0].sentAt - Date.now()) < 5000);
  // Input: a key, a click at the centre, a wheel notch.
  c.send({ t: 'key', code: 'KeyA', down: true });
  c.send({ t: 'move', x: 0.5, y: 0.5 });
  c.send({ t: 'btn', b: 0, down: true });
  c.send({ t: 'wheel', dx: 0, dy: 120 });
  c.send({ t: 'ping', c: 12.5 });
  const pong = await c.until(() => c.texts.find(m => m.t === 'pong'), 'pong');
  assert.equal(pong.c, 12.5); assert.ok(Math.abs(pong.s - Date.now()) < 1000);
  let seen = [];
  for (let i = 0; i < 100 && !seen.includes('ponte-rd-keys:REL_WHEEL=-1'); i++) { seen = await logEvents(inputLog); await new Promise(r => setTimeout(r, 30)); }
  assert.ok(seen.includes('ponte-rd-keys:KEY_A=1'), seen.join(' '));
  // 960x540 centre in a 1760x600 layout box.
  assert.ok(seen.includes(`ponte-rd-abs:ABS_X=${Math.round(480.5 / 1760 * 65536)}`), seen.join(' '));
  assert.ok(seen.includes('ponte-rd-abs:BTN_LEFT=1'));
  assert.ok(seen.includes('ponte-rd-keys:REL_WHEEL_HI_RES=-120'));
  // The client vanishes with the key and the button held: both are released.
  c.ws.terminate();
  for (let i = 0; i < 100 && !(seen.includes('ponte-rd-keys:KEY_A=0') && seen.includes('ponte-rd-abs:BTN_LEFT=0')); i++) { seen = await logEvents(inputLog); await new Promise(r => setTimeout(r, 30)); }
  assert.ok(seen.includes('ponte-rd-keys:KEY_A=0'));
  assert.ok(seen.includes('ponte-rd-abs:BTN_LEFT=0'));
});

test('a second session takes over: the first gets taken and is closed with 4001; input then follows the new one', { skip: !canRun }, async t => {
  const { url, app } = await rdApp(t);
  const first = await client(url);
  await first.until(() => first.frames.length > 0, 'first frames');
  const second = await client(url);
  await first.until(() => first.texts.find(m => m.t === 'taken'), 'taken');
  await first.until(() => first.closed, 'close');
  assert.equal(first.closed.code, 4001);
  await second.until(() => second.frames.length > 0 && second.texts.find(m => m.t === 'ready'), 'second ready');
  await second.until(() => app.rd.sessions.length === 1, 'one session');
  assert.ok(app.rd.holder && app.rd.sessions[0] === app.rd.holder);
});

test('the hello is required and checked: wrong token → PAIRING_REQUIRED and 1008; bad Origin → 403 before any upgrade', { skip: !canRun }, async t => {
  const { url, port } = await rdApp(t);
  const wrong = await client(url, { token: 'x'.repeat(46) });
  await wrong.until(() => wrong.closed, 'close');
  assert.deepEqual(wrong.texts, [{ t: 'error', code: 'PAIRING_REQUIRED' }]);
  assert.equal(wrong.closed.code, 1008);
  const garbage = await connect(url);
  const closed = new Promise(resolve => garbage.once('close', code => resolve(code)));
  garbage.send('not json');
  assert.equal(await closed, 1002);
  await assert.rejects(connect(url, { headers: { Origin: 'https://evil.example' } }), error => error.status === 403);
  await assert.rejects(connect(`ws://127.0.0.1:${port}/api/other`), error => error.status === 404);
  // A trusted origin on the same host is fine.
  const ok = await connect(url, { headers: { Origin: `http://127.0.0.1:${port}` } });
  ok.close();
});

test('clipboard both ways, only while the session lives, text up to 1 MiB', { skip: !canRun }, async t => {
  const { url, clipboard } = await rdApp(t);
  const c = await client(url);
  await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  assert.equal(clipboard.watchers, 1);
  clipboard.emit('copiado no PC');
  await c.until(() => c.texts.find(m => m.t === 'clip'), 'clip');
  assert.equal(c.texts.find(m => m.t === 'clip').text, 'copiado no PC');
  const big = 'é'.repeat(400000); // 800 kB of UTF-8: over the 64 KiB pre-hello limit, under 1 MiB
  c.send({ t: 'clip', text: big });
  c.send({ t: 'clip', text: 'x'.repeat(1024 * 1024 + 1) }); // over 1 MiB: ignored
  await c.until(() => clipboard.written.length === 1, 'write');
  assert.equal(clipboard.written[0], big);
  // Our own write coming back through the watcher is not echoed to the client.
  clipboard.emit(big);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(c.texts.filter(m => m.t === 'clip').length, 1);
  c.ws.close();
  await c.until(() => clipboard.stopped === 1, 'watch stopped');
});

test('switching monitors restarts the capture and announces a new ready before the new keyframe', { skip: !canRun }, async t => {
  const { url } = await rdApp(t);
  const c = await client(url);
  await c.until(() => c.frames.length > 2, 'frames');
  c.send({ t: 'monitor', name: 'NOPE' });
  await c.until(() => c.texts.find(m => m.t === 'error' && m.code === 'INVALID_MONITOR'), 'invalid monitor');
  c.send({ t: 'monitor', name: 'LAB-2' });
  const second = await c.until(() => c.texts.filter(m => m.t === 'ready')[1], 'second ready');
  assert.equal(second.monitor, 'LAB-2');
  assert.equal(second.width, 800); assert.equal(second.height, 600);
  const index = c.framesBefore[c.texts.indexOf(second)];
  await c.until(() => c.frames.length > index, 'new frames');
  assert.equal(c.frames[index].keyframe, true);
});

test('over the tailnet TLS listener: wss with the pinned CA reaches a session; an unknown CA is refused', { skip: !canRun || spawnSync('openssl', ['version']).status !== 0 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-rd-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/index.html'), '<title>Ponte</title>');
  const certFile = path.join(root, 'server.crt'), keyFile = path.join(root, 'server.key');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-subj', '/CN=Ponte test', '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' }).status, 0);
  const cert = await readFile(certFile);
  const seen = [];
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN, env: {}, nativeTls: { cert, key: await readFile(keyFile) },
    desktop: { getState: async () => ({}), close: async () => {} }, audio: { close: async () => {} },
    rdOptions: { captureMode: 'lab', inputMode: 'off', readMonitors: async () => MONITORS, clipboard: fakeClipboard(), kbps: 300, log: { info() {}, error() {} } },
  });
  t.after(() => app.close());
  const original = app.rd.accept;
  app.rd.accept = (ws, req, options) => { seen.push(req.ponteNative === true); original(ws, req, options); };
  await new Promise(resolve => app.nativeServer.listen(0, '127.0.0.1', resolve));
  const url = `wss://127.0.0.1:${app.nativeServer.address().port}/api/rd`;
  await assert.rejects(connect(url), /self-signed|certificate/i);
  const ws = await connect(url, { ca: cert });
  const texts = [];
  ws.on('message', (data, binary) => { if (!binary) texts.push(JSON.parse(data)); });
  ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKEN }));
  for (let i = 0; i < 300 && !texts.some(m => m.t === 'ready'); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(texts.find(m => m.t === 'ready')?.monitor, 'LAB-1');
  assert.deepEqual(texts.find(m => m.t === 'ready').input, { abs: false, rel: false, keys: false, clipboard: true }); // input off: view only
  assert.deepEqual(seen, [true]);
  ws.close();
});

test('health and state report the rd capability', { skip: !canRun }, async t => {
  const { port } = await rdApp(t);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.rd, true);
  const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(state.capabilities.rd, true);
  const off = await rdApp(t, { inputMode: 'off' });
  assert.equal((await (await fetch(`http://127.0.0.1:${off.port}/api/health`)).json()).rd, false);
});

// A session over fake parts: a capture that emits what the test says and a
// socket whose queue the test fills.
function fakeSession({ buffered = 0 } = {}) {
  const sent = [];
  const ws = new EventEmitter();
  ws.readyState = 'open';
  ws.bufferedAmount = buffered;
  ws.send = (...parts) => { sent.push(parts.length > 1 ? { header: parseVideoHeader(parts[0]), bytes: parts[1].length } : JSON.parse(parts[0])); return true; };
  ws.close = () => { ws.readyState = 'closed'; ws.emit('close', 1000, ''); };
  let emit, restarts = [];
  const makeCapture = ({ onUnit }) => {
    emit = onUnit;
    return { start(p) { this.params = p; }, restart(p) { restarts.push(p); this.params = { ...this.params, ...p }; }, stop() {}, running: true };
  };
  const rd = createRemoteDesktop({ readMonitors: async () => MONITORS, makeCapture, inputMode: 'off', clipboard: fakeClipboard(), exists: async () => true, log: { info() {}, error() {} } });
  rd.accept(ws, {}, { authorize: async token => token === TOKEN ? { kind: 'owner' } : null });
  ws.emit('message', JSON.stringify({ t: 'hello', v: 1, token: TOKEN }), false);
  const sps = { codec: 'avc1.640034', width: 960, height: 540 };
  const unit = (keyframe, params = { monitor: 'LAB-1', fps: 60, kbps: 12000 }) => emit({ data: Buffer.alloc(keyframe ? 5000 : 1000), keyframe, sps: keyframe ? sps : null, params, firstAt: performance.now(), lastAt: performance.now() });
  return { ws, sent, unit, restarts, rd, ready: async () => { while (!emit) await new Promise(r => setTimeout(r, 5)); } };
}

test('backpressure: a delta over the queue ceiling is dropped and so is every delta until the next keyframe', async () => {
  const s = fakeSession();
  await s.ready();
  s.unit(false); // before any keyframe: nothing can be decoded yet
  assert.equal(s.sent.length, 0);
  s.unit(true); s.unit(false);
  assert.deepEqual(s.sent.map(m => m.t || (m.header.keyframe ? 'K' : 'D')), ['ready', 'K', 'D']);
  s.ws.bufferedAmount = 400 * 1024; // over 100 ms of 12 Mbps
  s.unit(false);
  s.ws.bufferedAmount = 0;
  s.unit(false); s.unit(false); // the chain is broken: still dropped
  s.unit(true); s.unit(false);
  assert.deepEqual(s.sent.slice(1).map(m => (m.header.keyframe ? 'K' : 'D') + m.header.seq), ['K1', 'D2', 'K3', 'D4']);
  s.ws.bufferedAmount = 5 * 1024 * 1024; // a whole second queued: even a keyframe waits
  s.unit(true);
  assert.equal(s.sent.length, 5);
  s.rd.close();
});

test('adaptation: lasting congestion steps bitrate and fps down, a long calm steps back up, a slow round trip caps at 30 fps / 6 Mbps', () => {
  let clock = 0;
  const a = createAdaptation({ fps: 60, kbps: 12000, now: () => clock });
  clock = 4000;
  assert.equal(a.tick(), null);
  a.congestion(); a.congestion();
  assert.equal(a.tick(), null, 'two drops are not a trend');
  a.congestion();
  assert.deepEqual(a.tick(), { fps: 60, kbps: 7200 });
  clock += 1000; a.congestion(); a.congestion(); a.congestion();
  assert.equal(a.tick(), null, 'no second change within 3 s');
  clock += 2500; a.congestion(); a.congestion(); a.congestion();
  assert.deepEqual(a.tick(), { fps: 30, kbps: 4320 });
  clock += 11000;
  assert.deepEqual(a.tick(0), { fps: 30, kbps: 5400 });
  clock += 11000;
  assert.deepEqual(a.tick(0), { fps: 60, kbps: 6750 });
  clock += 11000;
  assert.equal(a.tick(10 * 1024 * 1024), null, 'not while the socket still has a queue');
  a.stats({ rtt: 80 });
  assert.deepEqual(a.tick(0), { fps: 30, kbps: 6000 });
  a.stats({ rtt: 30 }); // hysteresis: still outside the LAN until under 20 ms
  clock += 11000;
  assert.equal(a.tick(0), null);
  a.stats({ rtt: 3 });
  clock += 11000;
  assert.deepEqual(a.tick(0), { fps: 60, kbps: 7500 });
  // The client saying its decoder is behind counts as congestion.
  clock += 4000;
  a.stats({ queue: 6 }); a.stats({ queue: 5 }); a.stats({ fps: 20 });
  assert.deepEqual(a.tick(0), { fps: 30, kbps: 4500 });
});

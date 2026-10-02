// Following the focused monitor: Super+N that lands on another monitor brings
// that monitor to the remote screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { connect } from '../backend/ws.mjs';
import { parseVideoHeader } from '../backend/rd.mjs';
import { createFocusWatcher, parseEvent, socketPath } from '../backend/hypr-focus.mjs';

const TOKEN = 'test_token_with_at_least_thirty_two_characters';
const canRun = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('python3', ['--version']).status === 0;
const MONITORS = [
  { name: 'LAB-1', x: 0, y: 0, width: 960, height: 540, scale: 1, transform: 0, focused: true },
  { name: 'LAB-2', x: 960, y: 0, width: 800, height: 600, scale: 1, transform: 0, focused: false },
];

test('parseEvent: focusedmon carries the monitor, the layout events only invalidate the list, anything else is ignored', () => {
  assert.deepEqual(parseEvent('focusedmon>>DP-3,3'), { event: 'focusedmon', monitor: 'DP-3' });
  // A workspace name may be a word; the monitor still ends at the first comma.
  assert.deepEqual(parseEvent('focusedmon>>HDMI-A-1,special:scratchpad'), { event: 'focusedmon', monitor: 'HDMI-A-1' });
  assert.deepEqual(parseEvent('monitoradded>>DP-2'), { event: 'monitoradded', monitor: null });
  assert.deepEqual(parseEvent('monitorlayoutchanged>>'), { event: 'monitorlayoutchanged', monitor: null });
  // Not ours: a workspace inside the same monitor needs no switch.
  assert.equal(parseEvent('workspace>>3'), null);
  assert.equal(parseEvent('activewindow>>foot,shell'), null);
  assert.equal(parseEvent('garbage without a separator'), null);
});

test('socketPath: the runtime dir when Hyprland says who it is, /tmp for older builds, nothing without a signature', () => {
  assert.equal(socketPath({ HYPRLAND_INSTANCE_SIGNATURE: 'abc', XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/hypr/abc/.socket2.sock');
  assert.equal(socketPath({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }), '/tmp/hypr/abc/.socket2.sock');
  assert.equal(socketPath({}), null);
});

function fakeSocket() {
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.unref = () => {};
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  return socket;
}

test('focus watcher: one connection for every watcher, lines split across chunks, and it closes with the last watcher', () => {
  const opened = [];
  let socket = null;
  const watcher = createFocusWatcher({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_RUNTIME_DIR: '/run/user/1000' },
    connect: options => { opened.push(options.path); socket = fakeSocket(); return socket; },
  });
  const a = [], b = [];
  const stopA = watcher.watch(event => a.push(event));
  const stopB = watcher.watch(event => b.push(event));
  assert.deepEqual(opened, ['/run/user/1000/hypr/sig/.socket2.sock'], 'the second watcher reuses the connection');

  // Hyprland writes whole lines, but a socket may hand them over in pieces.
  socket.emit('data', 'workspace>>2\nfocusedmon>>LAB-2');
  assert.deepEqual(a, [], 'a line without its newline is not an event yet');
  socket.emit('data', ',2\nmonitoradded>>LAB-3\n');
  assert.deepEqual(a, [{ event: 'focusedmon', monitor: 'LAB-2' }, { event: 'monitoradded', monitor: null }]);
  assert.deepEqual(b, a, 'every watcher sees every event');

  stopA();
  socket.emit('data', 'focusedmon>>LAB-1,1\n');
  assert.equal(a.length, 2, 'a stopped watcher hears nothing more');
  assert.equal(b.length, 3);
  stopB();
  assert.equal(socket.destroyed, true, 'the last watcher takes the connection with it');
  assert.equal(watcher.watching, 0);
});

test('focus watcher: a thrown listener does not stop the others, and a dead socket is retried', async () => {
  const sockets = [];
  const watcher = createFocusWatcher({
    env: { HYPRLAND_INSTANCE_SIGNATURE: 'sig', XDG_RUNTIME_DIR: '/run/user/1000' },
    connect: () => { const socket = fakeSocket(); sockets.push(socket); return socket; },
    log: { error() {} },
    retryMs: 5,
  });
  const seen = [];
  watcher.watch(() => { throw new Error('bad listener'); });
  watcher.watch(event => seen.push(event));
  sockets[0].emit('data', 'focusedmon>>LAB-2,2\n');
  assert.deepEqual(seen, [{ event: 'focusedmon', monitor: 'LAB-2' }]);

  // Hyprland went away: the sessions that outlive it keep following once it is back.
  sockets[0].emit('error', new Error('ECONNRESET'));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(sockets.length, 2, 'reconnected');
  sockets[1].emit('data', 'focusedmon>>LAB-1,1\n');
  assert.deepEqual(seen.at(-1), { event: 'focusedmon', monitor: 'LAB-1' });
  watcher.close();
});

// A session against a fake watcher: the test drives the focus by hand.
async function followApp(t, { monitors = MONITORS } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-follow-'));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>Ponte</title>');
  const listeners = new Set();
  const focusWatcher = { watch(onEvent) { listeners.add(onEvent); return () => listeners.delete(onEvent); }, get watching() { return listeners.size; } };
  let current = monitors;
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN,
    rdOptions: {
      captureMode: 'lab', inputMode: 'dry-run', focusWatcher, followSettleMs: 10,
      readMonitors: async () => current,
      clipboard: { watch: () => () => {}, write: async () => {} },
      log: { info() {}, error() {} },
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return {
    url: `ws://127.0.0.1:${port}/api/rd`,
    focus(name) {
      current = current.map(m => ({ ...m, focused: m.name === name }));
      for (const listener of [...listeners]) listener({ event: 'focusedmon', monitor: name });
    },
    get watching() { return listeners.size; },
  };
}

async function client(url, hello = {}) {
  const ws = await connect(url);
  const texts = [], frames = [];
  ws.on('message', (data, binary) => { if (binary) frames.push(parseVideoHeader(data)); else texts.push(JSON.parse(data)); });
  ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKEN, maxFps: 30, ...hello }));
  const until = async (predicate, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { ws, texts, frames, until, send: value => ws.send(JSON.stringify(value)) };
}

test('the focus moves to another monitor and the screen follows: a fresh ready names it', { skip: !canRun }, async t => {
  const app = await followApp(t);
  const c = await client(app.url);
  const first = await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  assert.equal(first.monitor, 'LAB-1');
  assert.equal(first.follow, true, 'a page that says nothing follows');
  await c.until(() => app.watching === 1, 'the session watches the focus');

  app.focus('LAB-2');
  const second = await c.until(() => c.texts.filter(m => m.t === 'ready').find(m => m.monitor === 'LAB-2'), 'ready for LAB-2');
  assert.equal(second.width, 800, 'the new monitor brings its own size');
  assert.equal(second.height, 600);

  // The focus coming back brings the first monitor back.
  app.focus('LAB-1');
  const third = await c.until(() => c.texts.filter(m => m.t === 'ready').slice(-1).find(m => m.monitor === 'LAB-1'), 'ready for LAB-1');
  assert.equal(third.width, 960);
  c.ws.close();
});

test('the same monitor taking the focus again changes nothing: no second ready, no encoder restart', { skip: !canRun }, async t => {
  const app = await followApp(t);
  const c = await client(app.url);
  await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  const readies = () => c.texts.filter(m => m.t === 'ready').length;
  const before = readies();
  app.focus('LAB-1');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(readies(), before, 'already showing it');
  c.ws.close();
});

test('follow off: hello says so and the screen stays put; {t:"follow"} turns it on and catches up with the focus', { skip: !canRun }, async t => {
  const app = await followApp(t);
  const c = await client(app.url, { follow: false });
  const first = await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  assert.equal(first.follow, false);

  app.focus('LAB-2');
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!c.texts.some(m => m.t === 'ready' && m.monitor === 'LAB-2'), 'stayed on LAB-1');

  // Turning it on catches up with wherever the focus is now, without a new event.
  c.send({ t: 'follow', on: true });
  const caught = await c.until(() => c.texts.find(m => m.t === 'ready' && m.monitor === 'LAB-2'), 'ready for LAB-2');
  assert.equal(caught.follow, true);
  c.ws.close();
});

test('picking a monitor by hand only moves the view: the next focus change still follows', { skip: !canRun }, async t => {
  const app = await followApp(t);
  const c = await client(app.url);
  await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');

  c.send({ t: 'monitor', name: 'LAB-2' });
  const picked = await c.until(() => c.texts.find(m => m.t === 'ready' && m.monitor === 'LAB-2'), 'ready for LAB-2');
  assert.equal(picked.follow, true, 'a hand-picked monitor does not turn following off');

  app.focus('LAB-1');
  await c.until(() => c.texts.filter(m => m.t === 'ready').slice(-1).find(m => m.monitor === 'LAB-1'), 'ready for LAB-1');
  c.ws.close();
});

test('walking through workspaces restarts the encoder once: only where the focus comes to rest', { skip: !canRun }, async t => {
  const app = await followApp(t);
  const c = await client(app.url);
  await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  const before = c.texts.filter(m => m.t === 'ready').length;

  // Super+2, Super+3, Super+1, Super+2 in a row: one settled monitor.
  app.focus('LAB-2'); app.focus('LAB-1'); app.focus('LAB-2');
  await c.until(() => c.texts.find(m => m.t === 'ready' && m.monitor === 'LAB-2'), 'ready for LAB-2');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(c.texts.filter(m => m.t === 'ready').length, before + 1, 'one switch, not three');
  c.ws.close();
});

test('the session lets go of the focus watcher when it ends', { skip: !canRun }, async t => {
  const app = await followApp(t);
  const c = await client(app.url);
  await c.until(() => c.texts.find(m => m.t === 'ready'), 'ready');
  assert.equal(app.watching, 1);
  c.ws.close();
  const end = Date.now() + 4000;
  while (app.watching !== 0 && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.equal(app.watching, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, symlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createApp } from '../server.mjs';
import { createDesktop, resolveLiveCapture } from '../backend/desktop.mjs';
import { createAudioStore, MAX_AUDIO_BYTES } from '../backend/audio.mjs';
import { ApiError, runCommand } from '../backend/process.mjs';
import { createLiveStreaming, parseLiveOptions, writeLiveFrame } from '../backend/live.mjs';
import { message, messages } from '../backend/i18n.mjs';

const TOKEN = 'test_token_with_at_least_thirty_two_characters';
const window = { address: '0xabc', title: 'Editor', class: 'Editor', workspace: { id: 3, name: '3' } };
function mockRunner() {
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'hyprctl') {
      if (args[1] === 'clients') return JSON.stringify([window]);
      if (args[1] === 'activewindow') return JSON.stringify(window);
      if (args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, focused: true, dpmsStatus: true }]);
      if (args[1] === 'workspaces') return JSON.stringify([{ id: 3, name: '3', windows: 1 }]);
    }
    if (command === 'wpctl' && args[0] === 'get-volume') return 'Volume: 0.67 [MUTED]\n';
    if (command === 'grim') return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    if (command === 'ffprobe') return JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '1.2' } });
    return 'ok';
  };
  return { runner, calls };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-test-'));
  const publicDir = path.join(root, 'public');
  const dataDir = path.join(root, 'private');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Ponte</title>');
  await writeFile(path.join(publicDir, 'app.js'), 'export const safe=true;');
  await writeFile(path.join(publicDir, 'progress.json'), '{"status":"building"}');
  const mock = mockRunner();
  const desktop = createDesktop({ runner: mock.runner, exists: async () => true, dragTimeout: 45 });
  await mkdir(dataDir);
  const children = [];
  const playback = (file, onExit) => {
    const child = new EventEmitter();
    child.file = file; child.killed = false;
    child.kill = () => { child.killed = true; onExit(); return true; };
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const audio = await createAudioStore(dataDir, { runner: mock.runner, playback });
  const app = await createApp({ rootDir: root, dataDir, token: TOKEN, desktop, audio, trustedHosts: ['phone.tailnet.test'], ...overrides });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const request = (url, options = {}) => {
    const headers = { Authorization: `Bearer ${TOKEN}`, ...options.headers };
    // fetch intentionally controls Host itself; raw HTTP is necessary to
    // exercise rebinding/forwarded Host attacks and trusted remote authorities.
    if (options.headers?.Host) return new Promise((resolve, reject) => {
      const req = http.request(`${base}${url}`, { method: options.method || 'GET', headers }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject); req.end(options.body);
    });
    return fetch(`${base}${url}`, { ...options, headers });
  };
  const action = (value) => request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { root, dataDir, publicDir, app, base, request, action, desktop, audio, children, ...mock };
}

test('pairing protects state and audio; health never reveals token; token persists privately', async t => {
  const f = await fixture(t);
  const health = await fetch(`${f.base}/api/health`);
  assert.deepEqual(await health.json(), { name: 'Ponte', requiresPairing: true, version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, autoPair: false });
  for (const url of ['/api/state', '/api/audio', '/api/screenshot', '/api/stream']) {
    const response = await fetch(`${f.base}${url}`);
    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(await response.json()), ['errorCode', 'errorParameters', 'error']);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.request('/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await stat(path.join(f.dataDir, 'token'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
  assert.equal((await readFile(path.join(f.dataDir, 'token'), 'utf8')).trim(), TOKEN);
  assert.equal(f.calls.length, 0, 'unauthenticated routes must not touch the desktop');
});

test('Host and browser Origin validation block rebinding and cross-site requests', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { Origin: 'http://127.0.0.1:1' },
    { Host: 'phone.tailnet.test', Origin: 'http://phone.tailnet.test' },
    { Host: 'phone.tailnet.test', Origin: 'https://phone.tailnet.test:80' },
    { Host: 'phone.tailnet.test', Origin: 'https://attacker@phone.tailnet.test' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await f.request('/api/health', { headers })).status, 403, JSON.stringify(headers));
  assert.equal((await f.request('/api/health', { headers: { Origin: f.base } })).status, 200);
  assert.equal((await f.request('/api/health', { headers: { Host: 'phone.tailnet.test', Origin: 'https://phone.tailnet.test' } })).status, 200);
  assert.equal((await f.request('/api/health', { headers: { Host: 'phone.tailnet.test:443', Origin: 'https://phone.tailnet.test' } })).status, 200);
  assert.equal((await f.request('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'a pairing link from another site must open the public app');
});

test('static allowlist blocks traversal, dotfiles, source, tokens, and symlink escapes', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.publicDir, '.env'), 'secret');
  await writeFile(path.join(f.publicDir, 'server.mjs'), 'secret');
  await symlink(path.join(f.dataDir, 'token'), path.join(f.publicDir, 'escape.json'));
  for (const url of ['/token', '/private/token', '/%2e%2e%2fprivate/token', '/.%65nv', '/server.mjs', '/escape.json', '/%00', '/%5cprivate%5ctoken', '/app.js/']) {
    assert.equal((await f.request(url)).status, 404, url);
  }
  const page = await f.request('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await f.request('/progress.json')).status, 200);
  assert.equal((await f.request('/app.js', { method: 'POST' })).status, 405);
  const head = await f.request('/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('static files revalidate by ETag and are compressed only when accepted', async t => {
  const f = await fixture(t);
  const source = `${'const ponte = "compressible";\n'.repeat(200)}`;
  await writeFile(path.join(f.publicDir, 'app.js'), source);
  const raw = (url, headers = {}) => new Promise((resolve, reject) => {
    // fetch always asks for and silently decodes gzip/br; raw HTTP shows the wire.
    const req = http.request(`${f.base}${url}`, { method: headers.method || 'GET', headers: { 'Accept-Encoding': 'identity', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const plain = await raw('/app.js');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), source);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.match(plain.headers.vary, /Accept-Encoding/);
  assert.match(plain.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(plain.headers['x-content-type-options'], 'nosniff');
  const etag = plain.headers.etag;
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);
  const gz = await raw('/app.js', { 'Accept-Encoding': 'gzip, deflate' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(Number(gz.headers['content-length']), gz.body.length);
  assert.ok(gz.body.length < source.length / 4);
  assert.equal(gunzipSync(gz.body).toString(), source);
  assert.equal(gz.headers.etag, etag);
  const br = await raw('/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(brotliDecompressSync(br.body).toString(), source);
  assert.equal((await raw('/app.js', { 'Accept-Encoding': 'br;q=0, gzip' })).headers['content-encoding'], 'gzip');
  assert.equal((await raw('/app.js', { 'Accept-Encoding': 'gzip;q=0' })).headers['content-encoding'], undefined);
  const head = await raw('/app.js', { method: 'HEAD', 'Accept-Encoding': 'gzip' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), gz.body.length);
  for (const validator of [etag, etag.slice(2), `"other", ${etag}`, '*']) {
    const cached = await raw('/app.js', { 'If-None-Match': validator });
    assert.equal(cached.status, 304, validator); assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, etag); assert.equal(cached.headers['cache-control'], 'no-cache');
  }
  assert.equal((await raw('/app.js', { 'If-None-Match': 'W/"other"' })).status, 200);
  // A deploy (new content) must reach a phone that reloads for a new version.
  await writeFile(path.join(f.publicDir, 'app.js'), `${source}// next version\n`);
  const next = await raw('/app.js', { 'If-None-Match': etag });
  assert.equal(next.status, 200);
  assert.notEqual(next.headers.etag, etag);
  assert.match(next.body.toString(), /next version/);
  // Tiny files are not worth compressing; API responses keep no-store.
  assert.equal((await raw('/progress.json', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined);
  assert.equal((await f.request('/api/state')).headers.get('cache-control'), 'no-store');
});

test('state normalizes live desktop output and marks degraded integrations', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.activeWindow, {...window,monitor:null});
  assert.deepEqual(state.volume, { value: 0.67, muted: true });
  assert.deepEqual(state.monitors, [{ name: 'DP-1', width: 1920, height: 1080, focused: true, dpmsStatus: true, activeWorkspace: null }]);
  assert.deepEqual(state.workspaces, [{ id: 3, name: '3', windows: 1, monitor: null }]);
  assert.ok(state.wakeOnLan && typeof state.wakeOnLan.instructions === 'string');
  const degraded = createDesktop({ runner: async () => { throw new Error('private internal failure'); }, exists: async () => false });
  const degradedState = await degraded.getState();
  assert.equal(degradedState.activeWindow, null);
  assert.ok(degradedState.warnings.length >= 4);
  assert.equal(JSON.stringify(degradedState).includes('private internal failure'), false);
});

test('actions reject shell injection and bounds before launching any process', async t => {
  const f = await fixture(t);
  for (const value of [
    null, [], {}, { type: 'exec', command: 'touch /tmp/never' },
    { type: 'mouse.move', dx: '--help', dy: 0 }, { type: 'mouse.move', dx: 1001, dy: 0 },
    { type: 'mouse.scroll', dy: 31 }, { type: 'mouse.click', button: '__proto__' },
    { type: 'mouse.clickAt', button: 'left', x: -1, y: 0, monitor: 'DP-1' },
    { type: 'mouse.clickAt', button: 'left', x: 1.5, y: 0, monitor: 'DP-1' },
    { type: 'mouse.clickAt', button: '__proto__', x: 0, y: 0, monitor: 'DP-1' },
    { type: 'mouse.dragStartAt', x: -1, y: 0, monitor: 'DP-1' },
    { type: 'mouse.drag', pressed: 'true' }, { type: 'keyboard.key', key: 'Enter; touch /tmp/never' },
    { type: 'keyboard.text', text: 'a\0b' }, { type: 'keyboard.text', text: 'a'.repeat(4001) },
    { type: 'workspace.focus', id: '1;exec sh' }, { type: 'workspace.focus', id: -1 }, { type: 'workspace.focus', id: 1.1 },
    { type: 'window.focus', address: '0xabc;dispatch exec true' },
    { type: 'window.moveToWorkspace', address: '0xabc;dispatch exec true', id: 4 },
    { type: 'window.moveToWorkspace', address: '0xabc', id: 0 },
    { type: 'volume.set', value: 1.1 }, { type: 'volume.set', value: '0.5' },
    { type: 'app.launch', app: 'terminal; touch /tmp/never' }, { type: 'app.launch', app: '__proto__' },
    { type: 'power.dpms', monitor: 'DP-1; reboot', state: 'off' }, { type: 'power.dpms', monitor: 'DP-1', state: 'standby' }, { type: 'power.dpms', monitor: 'DP-1") os.execute("x', state: 'off' },
    { type: 'power.dpms', monitor: '', state: 'off' }, { type: 'power.dpms', monitor: 'DP-1', state: 123 },
  ]) {
    assert.equal((await f.action(value)).status, 400, JSON.stringify(value));
  }
  assert.equal(f.calls.length, 0);
  const text = '--help; $(touch /tmp/never) `true` Olá, coração!';
  assert.equal((await f.action({ type: 'keyboard.text', text })).status, 200);
  assert.equal(f.calls.at(-1).command, 'wtype');
  assert.deepEqual(f.calls.at(-1).args, ['-']);
  assert.equal(f.calls.at(-1).options.input, text);
  assert.equal((await f.action({ type: 'mouse.move', dx: 3.2, dy: -6.8 })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['mousemove', '--', '3', '-7']);
  assert.match(f.calls.at(-1).options.env.YDOTOOL_SOCKET, /ponte-input\.sock$/);
});

test('focus and screenshot require a monitor/window in live state', async t => {
  const f = await fixture(t);
  assert.equal((await f.action({ type: 'window.focus', address: '0xdead' })).status, 404);
  assert.equal(f.calls.filter(call => call.args[0] === 'dispatch').length, 0);
  assert.equal((await f.action({ type: 'window.focus', address: '0xabc' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'hl.dsp.focus({ window = "address:0xabc" })']);
  assert.equal((await f.action({ type: 'workspace.focus', id: 3 })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'hl.dsp.focus({ workspace = "3" })']);
  const screenshot = await f.request('/api/screenshot?monitor=DP-1');
  assert.equal(screenshot.status, 200); assert.equal(screenshot.headers.get('content-type'), 'image/jpeg');
  assert.equal(screenshot.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls.at(-1).args, ['-c', '-t', 'jpeg', '-q', '72', '-s', '0.65', '-o', 'DP-1', '-']);
  assert.equal((await f.request('/api/screenshot?monitor=DP-1%3Bexec%20sh')).status, 400);
  assert.equal(f.calls.filter(call => call.command === 'grim').length, 1);
});

test('reading at original resolution uses a bounded full-size screenshot without increasing live-stream limits', async t => {
  const f = await fixture(t);
  for (const query of ['scale=1.01', 'scale=0', 'scale=', 'scale=NaN', 'scale=1&scale=0.5']) {
    assert.equal((await f.request(`/api/screenshot?monitor=DP-1&${query}`)).status, 400, query);
  }
  assert.equal(f.calls.filter(call => call.command === 'grim').length, 0);
  assert.equal((await f.request('/api/screenshot?monitor=DP-1&scale=1')).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['-c', '-t', 'jpeg', '-q', '90', '-s', '1', '-o', 'DP-1', '-']);
  assert.equal((await f.request('/api/stream?monitor=DP-1&scale=1.5')).status, 400);
  assert.equal((await f.request('/api/stream?monitor=DP-1&scale=1&q=95')).status, 400);
  assert.equal(f.calls.filter(call => call.command === 'grim').length, 1);
});

test('power actions control monitors, smart sleep, wake, and poweroff with validation', async t => {
  const f = await fixture(t);
  // Invalid monitor name (not in live state)
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'UNKNOWN-1', state: 'off' })).status, 400);
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1; reboot', state: 'off' })).status, 400);
  // The dpms dispatcher only toggles, so a monitor already in the requested
  // state is left alone and one that differs is toggled exactly once.
  const before = f.calls.filter(call => call.command === 'hyprctl' && String(call.args[1]).includes('dpms')).length;
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1', state: 'on' })).status, 200);
  assert.equal(f.calls.filter(call => call.command === 'hyprctl' && String(call.args[1]).includes('dpms')).length, before, 'already-on monitor is not toggled');
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1', state: 'off' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'hl.dsp.dpms({ monitor = "DP-1" })']);
  assert.equal(f.calls.at(-1).command, 'hyprctl');
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1', enabled: false })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'hl.dsp.dpms({ monitor = "DP-1" })']);

  // Smart sleep turns each on monitor off, then sleeps the lights.
  assert.equal((await f.action({ type: 'power.sleep' })).status, 200);
  const sleepCalls = f.calls.slice(-2);
  assert.deepEqual(sleepCalls[0].args, ['dispatch', 'hl.dsp.dpms({ monitor = "DP-1" })']);
  assert.equal(sleepCalls[1].command, 'python');
  assert.match(sleepCalls[1].args[0], /controller\.py$/);
  assert.equal(sleepCalls[1].args[1], 'sleep');

  // Wake: DP-1 already reads on in the mock, so only the lights are restored.
  assert.equal((await f.action({ type: 'power.wake' })).status, 200);
  assert.equal(f.calls.at(-1).command, 'python');
  assert.match(f.calls.at(-1).args[0], /controller\.py$/);
  assert.equal(f.calls.at(-1).args[1], 'restore');

  // Poweroff
  assert.equal((await f.action({ type: 'power.poweroff' })).status, 200);
  assert.equal(f.calls.at(-1).command, 'systemctl');
  assert.deepEqual(f.calls.at(-1).args, ['poweroff']);

  // Dedicated /api/power endpoint
  const getPower = await f.request('/api/power');
  assert.equal(getPower.status, 200);
  const powerData = await getPower.json();
  assert.ok(Array.isArray(powerData.monitors));
  assert.ok(powerData.wakeOnLan);

  const postPower = await f.request('/api/power', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'power.dpms', monitor: 'DP-1', state: 'off' }),
  });
  assert.equal(postPower.status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'hl.dsp.dpms({ monitor = "DP-1" })']);
});

test('drag renews its lease and auto-releases; shortcut keys release modifiers', async t => {
  const f = await fixture(t);
  await f.desktop.action({ type: 'mouse.drag', pressed: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  await f.desktop.action({ type: 'mouse.drag', pressed: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.calls.filter(call => call.args.includes('0x80')).length, 0);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.calls.filter(call => call.args.includes('0x40')).length, 1);
  assert.equal(f.calls.filter(call => call.args.includes('0x80')).length, 1);
  await f.desktop.action({ type: 'keyboard.key', key: 'Copy' });
  assert.deepEqual(f.calls.at(-1).args, ['key', '--key-delay', '1', '29:1', '46:1', '46:0', '29:0']);
  await f.desktop.action({ type: 'mouse.drag', pressed: true });
  await f.desktop.close();
  assert.equal(f.calls.filter(call => call.args.includes('0x80')).length, 2);
});

test('failed drag release retains held state until a later release succeeds', async () => {
  const calls = [];
  let failures = 1;
  const desktop = createDesktop({ runner: async (command, args) => {
    calls.push(args);
    if (args.includes('0x80') && failures-- > 0) throw new ApiError(503, 'COMMAND_FAILED', { command: 'ydotool' });
    return 'ok';
  }, exists: async () => true });
  await desktop.action({ type: 'mouse.drag', pressed: true });
  await assert.rejects(desktop.action({ type: 'mouse.drag', pressed: false }), error => error.status === 503);
  await desktop.action({ type: 'mouse.drag', pressed: false });
  assert.equal(calls.filter(args => args.includes('0x80')).length, 2);
  await desktop.close();
});

test('token initialization rejects state beneath public and token symlinks', async t => {
  const f = await fixture(t);
  await assert.rejects(createApp({ rootDir: f.root, dataDir: path.join(f.publicDir, 'secrets') }), /outside public/);
  const linkedDir = path.join(f.root, 'linked-private'); await mkdir(linkedDir);
  await symlink(path.join(f.dataDir, 'token'), path.join(linkedDir, 'token'));
  await assert.rejects(createApp({ rootDir: f.root, dataDir: linkedDir }), /Invalid token file/);
});

test('JSON/body size validation and action serialization prevent unbounded work', async t => {
  const f = await fixture(t);
  const invalid = await f.request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalid.status, 400);
  assert.equal((await f.request('/api/action', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await f.action({ type: 'keyboard.text', text: 'a'.repeat(26000) })).status, 413);
  assert.equal(f.calls.length, 0);
  let release; let active = 0, peak = 0;
  const fake = { getState: async () => ({}), close: async () => {}, action: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => { release = resolve; }); active--; return { ok: true };
  } };
  const queued = await fixture(t, { desktop: fake });
  const first = queued.action({ type: 'mouse.click', button: 'left' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 2));
  const second = queued.action({ type: 'mouse.click', button: 'left' });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(peak, 1);
  release(); await first;
  await new Promise(resolve => setTimeout(resolve, 10)); release(); await second;
  assert.equal(peak, 1);
});

test('shutdown cancels queued actions and releases held input only after the active action finishes', async t => {
  const events = [];
  let release;
  const desktop = { getState: async () => ({}), action: async value => {
    events.push(value.type);
    await new Promise(resolve => { release = resolve; });
    events.push('finished'); return { ok: true };
  }, close: async () => { events.push('released'); } };
  const f = await fixture(t, { desktop });
  const first = f.action({ type: 'mouse.move', dx: 1, dy: 1 }).catch(() => {});
  while (!release) await new Promise(resolve => setTimeout(resolve, 2));
  const second = f.action({ type: 'mouse.drag', pressed: true }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  const close = f.app.close();
  assert.deepEqual(events, ['mouse.move']);
  release(); await close; await first; await second;
  assert.deepEqual(events, ['mouse.move', 'finished', 'released']);
});

test('audio validates format, stores private files, lists and downloads authenticated, and stops only owned playback', async t => {
  const f = await fixture(t);
  const body = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
  assert.equal((await f.request('/api/audio', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await f.request('/api/audio', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: 'this is not audio' })).status, 415);
  const upload = await f.request('/api/audio', { method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus' }, body });
  assert.equal(upload.status, 201);
  const { recording } = await upload.json();
  assert.equal(recording.mime, 'audio/webm');
  assert.equal(recording.size, body.length);
  const file = path.join(f.dataDir, 'audio', `${recording.id}.webm`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await (await f.request('/api/audio')).json()).recordings, [recording]);
  assert.deepEqual(Buffer.from(await (await f.request(`/api/audio/${recording.id}`)).arrayBuffer()), body);
  assert.equal((await fetch(`${f.base}/api/audio/${recording.id}`)).status, 401);
  assert.equal((await f.request(`/audio/${recording.id}.webm`)).status, 404);
  assert.equal((await f.request(`/api/audio/${recording.id}/play`, { method: 'POST' })).status, 200);
  assert.equal(f.children[0].file, file);
  assert.equal((await f.request('/api/audio/stop', { method: 'POST' })).status, 200);
  assert.equal(f.children[0].killed, true);
  assert.equal((await f.request('/api/audio/invalid%3Bexec/play', { method: 'POST' })).status, 404);
  assert.equal((await f.request('/api/audio/invalid')).status, 404);
  await assert.rejects(f.audio.upload(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/webm'), error => error.status === 413);
});

test('rejected audio leaves no file; recording metadata cannot traverse or follow symlinks', async t => {
  const f = await fixture(t);
  const invalidAudio = await createAudioStore(f.dataDir, { runner: async () => JSON.stringify({ streams: [{ codec_type: 'video' }] }) });
  const wav = Buffer.alloc(40); wav.write('RIFF'); wav.write('WAVE', 8);
  await assert.rejects(invalidAudio.upload(wav, 'audio/wav'), error => error.status === 415);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'audio')), []);
  const id = '6e8ce130-2d2d-4c74-97e9-78457345bbf9';
  await symlink(path.join(f.dataDir, 'token'), path.join(f.dataDir, 'audio', `${id}.json`));
  await assert.rejects(f.audio.get(id), error => error.status === 404);
  assert.deepEqual(await f.audio.list(), { recordings: [] });
  await assert.rejects(f.audio.get('../../token'), error => error.status === 404);
});

test('request-scoped command runner bounds execution and treats arguments literally', async () => {
  const text = '; $(touch /tmp/ponte-should-never-exist) `id`';
  assert.equal(await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', text]), text);
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 40 }), error => error instanceof ApiError && error.status === 503);
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBuffer: 100 }), error => error.status === 503);
});

test('live stream authenticates, validates query/live monitor, then sends continuous length-delimited JPEG frames', async t => {
  const f = await fixture(t);
  for (const query of ['fps=21', 'fps=0', 'fps=1.5', 'scale=1.5', 'scale=NaN', 'scale=0.1', 'q=29', 'q=91', 'q=50.5', 'q=60&q=61', 'fps=5&fps=6', 'monitor=DP-1%3Bexec%20sh']) {
    assert.equal((await f.request(`/api/stream?${query}`)).status, 400, query);
  }
  assert.equal(f.calls.filter(call => call.command === 'grim').length, 0);
  const controller = new AbortController();
  const response = await f.request('/api/stream?monitor=DP-1&fps=10&scale=0.5', { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'multipart/x-mixed-replace; boundary=ponte-frame');
  assert.equal(response.headers.get('x-live-max-fps'), '10');
  assert.match(response.headers.get('cache-control'), /no-store/);
  const reader = response.body.getReader();
  let received = Buffer.alloc(0);
  while ((received.toString('latin1').match(/--ponte-frame/g) || []).length < 3) {
    const { value, done } = await reader.read(); assert.equal(done, false);
    received = Buffer.concat([received, value]);
  }
  assert.match(received.toString('latin1'), /Content-Length: 4\r\nX-Frame-Timestamp: \d{13}\r\n\r\n/);
  const callsBeforeAbort = f.calls.filter(call => call.command === 'grim').length;
  assert.ok(callsBeforeAbort >= 3);
  assert.deepEqual(f.calls.filter(call => call.command === 'grim')[0].args, ['-c', '-t', 'jpeg', '-q', '65', '-s', '0.50', '-o', 'DP-1', '-']);
  controller.abort(); await reader.cancel().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(f.calls.filter(call => call.command === 'grim').length, callsBeforeAbort, 'capture must stop after disconnect');
  const monitorReads = f.calls.filter(call => call.command === 'hyprctl' && call.args[1] === 'monitors').length;
  assert.equal(monitorReads, 2, 'one read for invalid live monitor and one when the valid stream starts; none per frame');
});

test('live region is validated, clamped to the monitor, and captured at scale 1', async t => {
  const monitor = { name: 'HDMI-A-1', x: 2560, y: 1080, width: 1920, height: 1080 };
  assert.deepEqual(resolveLiveCapture(monitor, 0.5, null), { scale: 0.5, output: 'HDMI-A-1', geometry: null, region: null });
  assert.deepEqual(resolveLiveCapture(monitor, 0.5, { x: 100, y: 80, w: 640, h: 360 }), {
    scale: 1, output: null, geometry: '2660,1160 640x360', region: { x: 100, y: 80, w: 640, h: 360 },
  });
  assert.equal(resolveLiveCapture(monitor, 0.65, { x: 0, y: 0, w: 1920, h: 1080 }).geometry, null);
  assert.equal(resolveLiveCapture(monitor, 0.5, { x: 10, y: 10, w: 1900, h: 1060 }).geometry, null, 'near-full region falls back to the scaled monitor');
  assert.equal(resolveLiveCapture(monitor, 0.5, { x: 1915, y: 1075, w: 400, h: 400 }).geometry, null, 'a sliver after clamping falls back');
  const clamped = resolveLiveCapture(monitor, 0.5, { x: 1800, y: 900, w: 400, h: 400 });
  assert.deepEqual(clamped.region, { x: 1800, y: 900, w: 120, h: 180 });
  assert.equal(clamped.geometry, '4360,1980 120x180');
  assert.equal(clamped.scale, 1);
  assert.throws(() => resolveLiveCapture(monitor, 0.5, { x: -1, y: 0, w: 10, h: 10 }), error => error.status === 400 && error.code === 'INVALID_REGION');
  assert.throws(() => resolveLiveCapture(monitor, 0.5, { x: 0, y: 0, w: 0, h: 10 }), error => error.status === 400 && error.code === 'INVALID_REGION');
  assert.throws(() => parseLiveOptions(new URLSearchParams('monitor=DP-1&x=10')), error => error.status === 400 && error.code === 'INVALID_REGION');
  assert.throws(() => parseLiveOptions(new URLSearchParams('monitor=DP-1&x=-1&y=0&w=10&h=10')), error => error.code === 'INVALID_REGION');
  assert.throws(() => parseLiveOptions(new URLSearchParams('monitor=DP-1&x=1&y=1&w=10&h=10&x=2')), error => error.code === 'REPEATED_PARAMETER');
  assert.throws(() => parseLiveOptions(new URLSearchParams('monitor=DP-1&x=1&y=1&w=10&h=10&scale=1.5')), error => error.code === 'INVALID_SCALE');
  assert.deepEqual(parseLiveOptions(new URLSearchParams('monitor=DP-1&fps=20&scale=1&q=45')), { monitor: 'DP-1', fps: 20, scale: 1, quality: 45, region: undefined });
  assert.deepEqual(parseLiveOptions(new URLSearchParams('monitor=DP-1&fps=6&scale=0.65&x=100&y=80&w=640&h=360')), {
    monitor: 'DP-1', fps: 6, scale: 0.65, quality: 65, region: { x: 100, y: 80, w: 640, h: 360 },
  });

  const f = await fixture(t);
  for (const query of ['x=10', 'x=-1&y=0&w=10&h=10', 'x=1&y=1&w=0&h=10', 'x=1&y=1&w=10&h=10&x=2', 'x=1.5&y=1&w=10&h=10']) {
    assert.equal((await f.request(`/api/stream?monitor=DP-1&${query}`)).status, 400, query);
  }
  assert.equal(f.calls.filter(call => call.command === 'grim').length, 0);

  const controller = new AbortController();
  const response = await f.request('/api/stream?monitor=DP-1&fps=10&scale=0.5&x=100&y=80&w=640&h=360', { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-live-max-fps'), '10');
  const reader = response.body.getReader();
  let received = Buffer.alloc(0);
  while ((received.toString('latin1').match(/--ponte-frame/g) || []).length < 2) {
    const { value, done } = await reader.read(); assert.equal(done, false);
    received = Buffer.concat([received, value]);
  }
  const grim = f.calls.filter(call => call.command === 'grim');
  assert.ok(grim.length >= 2);
  assert.deepEqual(grim[0].args, ['-c', '-t', 'jpeg', '-q', '65', '-s', '1', '-g', '100,80 640x360', '-']);
  assert.equal(grim[0].options.maxBuffer, 8 * 1024 * 1024);
  controller.abort(); await reader.cancel().catch(() => {});

  const fallback = new AbortController();
  const full = await f.request('/api/stream?monitor=DP-1&fps=8&scale=0.5&x=0&y=0&w=1920&h=1080', { signal: fallback.signal });
  assert.equal(full.status, 200);
  const fullReader = full.body.getReader();
  let fullBytes = Buffer.alloc(0);
  while ((fullBytes.toString('latin1').match(/--ponte-frame/g) || []).length < 1) {
    const { value, done } = await fullReader.read(); assert.equal(done, false);
    fullBytes = Buffer.concat([fullBytes, value]);
  }
  assert.deepEqual(f.calls.filter(call => call.command === 'grim').at(-1).args, ['-c', '-t', 'jpeg', '-q', '65', '-s', '0.50', '-o', 'DP-1', '-']);
  fallback.abort(); await fullReader.cancel().catch(() => {});
});

test('a scroll with a point lands the pointer there first so the wheel reaches that window, and never clicks', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'HDMI-A-1', x: 2560, y: 0, width: 1920, height: 1080, focused: true }]);
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true });
  const ydotool = () => calls.filter(call => call.command === 'ydotool').map(call => call.args);
  await desktop.action({ type: 'mouse.scroll', dy: -4, monitor: 'HDMI-A-1', x: 300, y: 500 });
  assert.deepEqual(ydotool().at(-2), ['mousemove', '--absolute', '--', '2860', '500']);
  assert.deepEqual(ydotool().at(-1), ['mousemove', '--wheel', '--', '0', '-4']);
  // Without a point the wheel stays where the pointer is (CLI and older phones).
  calls.length = 0;
  await desktop.action({ type: 'mouse.scroll', dy: 3 });
  assert.deepEqual(ydotool(), [['mousemove', '--wheel', '--', '0', '3']]);
  calls.length = 0;
  for (const value of [{ type: 'mouse.scroll', dy: 1, monitor: 'HDMI-A-1', x: 1920, y: 0 }, { type: 'mouse.scroll', dy: 1, monitor: 'missing', x: 0, y: 0 }, { type: 'mouse.scroll', dy: 1, monitor: 'HDMI-A-1', x: 1.5, y: 0 }]) {
    await assert.rejects(desktop.action(value), error => error.status === 400, JSON.stringify(value));
  }
  assert.deepEqual(ydotool(), [], 'an invalid point never scrolls elsewhere');
  assert.equal(calls.some(call => call.command === 'ydotool' && call.args[0] === 'click'), false);
  await desktop.close();
});

test('absolute clicks map monitor pixels through the output origin without shell interpolation', async t => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'HDMI-A-1', x: 2560, y: 0, width: 1920, height: 1080, focused: true }]);
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true });
  await desktop.action({ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 100, y: 40, button: 'left' });
  const ydotoolCalls = () => calls.filter(call => call.command === 'ydotool');
  assert.deepEqual(ydotoolCalls().at(-2).args, ['mousemove', '--absolute', '--', '2660', '40']);
  assert.deepEqual(calls.at(-1).args, ['click', '0xC0']);
  await desktop.action({ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 8, y: 9, button: 'right' });
  assert.deepEqual(calls.at(-1).args, ['click', '0xC1']);
  await assert.rejects(desktop.action({ type: 'mouse.clickAt', monitor: 'HDMI-A-1', x: 1920, y: 0, button: 'left' }), error => error.status === 400);
  await assert.rejects(desktop.action({ type: 'mouse.clickAt', monitor: 'missing', x: 0, y: 0, button: 'left' }), error => error.status === 400);
  await desktop.close();

  const f = await fixture(t);
  const response = await f.action({ type: 'mouse.clickAt', monitor: 'DP-1', x: 15, y: 20, button: 'left' });
  assert.equal(response.status, 200);
  const ydotool = f.calls.filter(call => call.command === 'ydotool');
  assert.deepEqual(ydotool.at(-2).args, ['mousemove', '--absolute', '--', '15', '20']);
  assert.deepEqual(ydotool.at(-1).args, ['click', '0xC0']);
});

test('semantic drag captures the touched window and moves that exact window to a workspace', async () => {
  const calls = [];
  const touchedWindow = { ...window, at: [2560, 40], size: [900, 700] };
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'HDMI-A-1', x: 2560, y: 40, width: 1920, height: 1080 }]);
    if (command === 'hyprctl' && args[1] === 'activewindow') return JSON.stringify(touchedWindow);
    if (command === 'hyprctl' && args[1] === 'clients') return JSON.stringify([touchedWindow]);
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true });
  const started = await desktop.action({ type: 'mouse.dragStartAt', monitor: 'HDMI-A-1', x: 100, y: 60 });
  assert.equal(started.window.address, '0xabc');
  assert.deepEqual(calls.filter(call => call.command === 'ydotool').map(call => call.args), [
    ['mousemove', '--absolute', '--', '2660', '100'],
    ['click', '0x40'],
  ]);

  const moved = await desktop.action({ type: 'window.moveToWorkspace', address: '0xabc', id: 4 });
  assert.deepEqual(moved, { ok: true, moved: true, workspace: 4 });
  assert.deepEqual(calls.filter(call => call.command === 'ydotool').at(-1).args, ['click', '0x80']);
  assert.deepEqual(calls.at(-1).args, ['dispatch', 'hl.dsp.window.move({ workspace = "4", follow = false, window = "address:0xabc" })']);

  const unchanged = await desktop.action({ type: 'window.moveToWorkspace', address: '0xabc', id: 3 });
  assert.deepEqual(unchanged, { ok: true, moved: false, workspace: 3 });
  await assert.rejects(desktop.action({ type: 'window.moveToWorkspace', address: '0xdead', id: 4 }), error => error.status === 404);
  await desktop.close();
});

test('semantic drag never captures the previously active window when the gesture starts on wallpaper', async () => {
  const runner = async (command, args) => {
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 }]);
    if (command === 'hyprctl' && args[1] === 'activewindow') return JSON.stringify({ ...window, at: [800, 500], size: [500, 400] });
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true });
  const started = await desktop.action({ type: 'mouse.dragStartAt', monitor: 'DP-1', x: 20, y: 20 });
  assert.deepEqual(started, { ok: true, window: null });
  await desktop.close();
});

test('a reopening device replaces its own oldest live view when the cap is reached, instead of a 429', async t => {
  const f = await fixture(t);
  const controllers = [new AbortController(), new AbortController(), new AbortController(), new AbortController()];
  const responses = await Promise.all(controllers.map(controller => f.request('/api/stream?monitor=DP-1', { signal: controller.signal })));
  assert.ok(responses.every(response => response.status === 200));
  // A fifth view from the same peer is accepted; its own oldest connection is dropped.
  const fifth = new AbortController();
  const extra = await f.request('/api/stream?monitor=DP-1', { signal: fifth.signal });
  assert.equal(extra.status, 200);
  await new Promise(resolve => setTimeout(resolve, 20));
  // The oldest stream's body ends once it is aborted server-side.
  const firstEnded = await responses[0].body.getReader().read().then(() => true, () => true);
  assert.equal(firstEnded, true);
  controllers.forEach(controller => controller.abort()); fifth.abort();
  await Promise.all([...responses, extra].map(response => response.body.cancel().catch(() => {})));
  await new Promise(resolve => setTimeout(resolve, 20));
  const replacement = new AbortController();
  const response = await f.request('/api/stream?monitor=DP-1', { signal: replacement.signal });
  assert.equal(response.status, 200); replacement.abort(); await response.body.cancel().catch(() => {});
});

class FakeStreamResponse extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writes = [];
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  flushHeaders() {}
  write(bytes) { this.writes.push(bytes); return false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
}

test('live frame backpressure waits for drain and times out a stalled receiver with listener cleanup', async () => {
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const res = new FakeStreamResponse();
  const controller = new AbortController();
  let completed = false;
  const writing = writeLiveFrame(res, frame, controller.signal, { timeout: 100 }).then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(completed, false);
  assert.equal(res.writes.length, 1);
  res.emit('drain'); await writing; assert.equal(res.listenerCount('close'), 0);
  await assert.rejects(writeLiveFrame(res, frame, controller.signal, { timeout: 15 }), error => error.status === 408);
  assert.equal(res.listenerCount('close'), 0); assert.equal(res.listenerCount('drain'), 0);
});

test('aggregate live capture concurrency is capped and shutdown aborts active capture signals', async () => {
  const signals = [];
  let active = 0, peak = 0, completed = 0;
  const desktop = { prepareLive: async ({ monitor }) => ({ monitor, capture: signal => new Promise((resolve, reject) => {
    signals.push(signal); active++; peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; completed++; reject(new Error('aborted')); }, { once: true });
  }) }) };
  const live = createLiveStreaming(desktop);
  const responses = [new FakeStreamResponse(), new FakeStreamResponse(), new FakeStreamResponse()];
  // Three monitors: three capture loops (the same monitor would share one).
  const streams = responses.map((res, index) => live.stream({}, res, new URLSearchParams(`monitor=DP-${index + 1}`)));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(peak, 2); assert.equal(signals.length, 2);
  live.close(); await Promise.all(streams);
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(completed, 2); assert.equal(active, 0);
});

test('viewers of the same monitor and profile share one capture loop; the last one leaving stops it', async () => {
  const jpeg = n => Buffer.from([0xff, 0xd8, n & 0xff, 0xff, 0xd9]);
  const captures = [], signals = [];
  const desktop = { prepareLive: async ({ monitor }) => ({ monitor, region: null, capture: async signal => {
    signals.push(signal); captures.push(monitor);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (signal.aborted) throw new Error('aborted');
    return jpeg(captures.length);
  } }) };
  class FastResponse extends FakeStreamResponse { write(bytes) { this.writes.push(bytes); return true; } }
  const live = createLiveStreaming(desktop, { maxStreams: 4, maxPerPeer: 4 });
  const open = query => { const res = new FastResponse(); const done = live.stream({ socket: { remoteAddress: '100.1.1.1' } }, res, new URLSearchParams(query)); done.catch(() => {}); return { res, done }; };
  const a = open('monitor=DP-1&fps=20&scale=1&q=40'), b = open('monitor=DP-1&fps=20&scale=1&q=40');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(live.feeds, 1, 'one capture loop for two viewers');
  const shared = captures.length;
  assert.ok(a.res.writes.length >= 4 && b.res.writes.length >= 4, `both viewers get frames (${a.res.writes.length}, ${b.res.writes.length})`);
  assert.ok(shared <= Math.max(a.res.writes.length, b.res.writes.length) + 1, `${shared} captures for ${a.res.writes.length}+${b.res.writes.length} frames`);
  assert.ok(shared < a.res.writes.length + b.res.writes.length - 2, 'frames are fanned out, not captured twice');
  // Another quality is another picture: its own loop.
  const c = open('monitor=DP-1&fps=20&scale=1&q=65');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(live.feeds, 2);
  // One viewer leaving keeps the shared loop running for the other.
  a.res.destroy(); await a.done;
  const before = b.res.writes.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(b.res.writes.length > before, 'the remaining viewer keeps streaming');
  assert.equal(signals.filter(signal => signal.aborted).length, 0);
  b.res.destroy(); c.res.destroy(); await Promise.all([b.done, c.done]);
  assert.equal(live.feeds, 0);
  assert.ok(signals.at(-1).aborted, 'the capture is aborted once nobody watches');
});

test('live slots: a device replaces only its own stream, a PC-local preview yields to a remote device, and remote devices never evict each other', async () => {
  const desktop = { prepareLive: async () => ({ capture: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }) };
  const live = createLiveStreaming(desktop, { maxStreams: 3 });
  const open = peer => { const res = new FakeStreamResponse(); const done = live.stream({ socket: { remoteAddress: peer } }, res, new URLSearchParams('monitor=DP-1')); done.catch(() => {}); return { res, done }; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  const local = open('127.0.0.1'), phone = open('100.111.221.82'), other = open('100.88.0.9');
  await settle();
  // The cap is full. A new remote device takes the PC-local slot, never a remote one.
  const third = open('100.77.0.1');
  await settle();
  assert.equal(local.res.destroyed, true, 'the loopback preview yields');
  assert.equal(phone.res.destroyed, false); assert.equal(other.res.destroyed, false); assert.equal(third.res.destroyed, false);
  // Three remote devices fill the cap: a fourth is refused and nobody is dropped.
  await assert.rejects(open('100.66.0.1').done, error => error.status === 429);
  assert.equal(phone.res.destroyed, false); assert.equal(other.res.destroyed, false); assert.equal(third.res.destroyed, false);
  // The phone reopening its screen replaces only its own earlier stream.
  const phoneAgain = open('100.111.221.82');
  await settle();
  assert.equal(phone.res.destroyed, true); assert.equal(other.res.destroyed, false); assert.equal(third.res.destroyed, false); assert.equal(phoneAgain.res.destroyed, false);
  live.close(); await Promise.allSettled([local.done, phone.done, other.done, third.done, phoneAgain.done]);
});

test('no single peer can monopolize the live slots: a third stream from one device replaces its own oldest', async () => {
  const desktop = { prepareLive: async () => ({ capture: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }) };
  const live = createLiveStreaming(desktop, { maxStreams: 4, maxPerPeer: 2 });
  const open = peer => { const res = new FakeStreamResponse(); const done = live.stream({ socket: { remoteAddress: peer } }, res, new URLSearchParams('monitor=DP-1')); done.catch(() => {}); return { res, done }; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  const a1 = open('100.1.1.1'), a2 = open('100.1.1.1');
  await settle();
  const a3 = open('100.1.1.1'); // same peer's 3rd → drops its own oldest, never a slot war
  await settle();
  assert.equal(a1.res.destroyed, true, 'the peer replaced its own oldest');
  assert.equal(a2.res.destroyed, false); assert.equal(a3.res.destroyed, false);
  // A second device still has room even though the first keeps reopening.
  const b1 = open('100.2.2.2'), b2 = open('100.2.2.2');
  await settle();
  assert.equal(b1.res.destroyed, false); assert.equal(b2.res.destroyed, false);
  assert.equal(a2.res.destroyed, false); assert.equal(a3.res.destroyed, false, 'the second device did not evict the first');
  live.close(); await Promise.allSettled([a1.done, a2.done, a3.done, b1.done, b2.done]);
});

test('runCommand abort signal kills a capture-like child promptly', async () => {
  const controller = new AbortController();
  const start = performance.now();
  const running = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 4000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(running, error => error.status === 503);
  assert.ok(performance.now() - start < 1000);
});

test('API uses stable error codes, English by default, and explicit Portuguese language negotiation', async t => {
  const f = await fixture(t);
  const cases = [
    { url: '/api/state', headers: {}, language: 'en' },
    { url: '/api/state', headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }, language: 'pt' },
    { url: '/api/state', headers: { 'Accept-Language': 'pt;q=0.1,en;q=0.9' }, language: 'en' },
    { url: '/api/state', headers: { 'Accept-Language': 'fr-FR,de;q=0.8' }, language: 'en' },
    { url: '/api/state', headers: { 'Accept-Language': 'pt;q=0,en;q=0.1' }, language: 'en' },
    { url: '/api/state?lang=pt', headers: { 'Accept-Language': 'en' }, language: 'pt' },
    { url: '/api/state?lang=en', headers: { 'Accept-Language': 'pt' }, language: 'en' },
  ];
  for (const { url, headers, language } of cases) {
    const response = await fetch(`${f.base}${url}`, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('content-language'), language);
    assert.equal(response.headers.get('vary'), 'Accept-Language');
    assert.deepEqual(await response.json(), { errorCode: 'PAIRING_REQUIRED', errorParameters: {}, error: messages.PAIRING_REQUIRED[language] });
  }
  const invalidNumber = await f.request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'pt' }, body: JSON.stringify({ type: 'volume.set', value: 2 }) });
  assert.deepEqual(await invalidNumber.json(), { errorCode: 'NUMBER_OUT_OF_RANGE', errorParameters: { min: 0, max: 1 }, error: 'Valor numérico deve estar entre 0 e 1.' });
  const invalidStream = await f.request('/api/stream?fps=25', { headers: { 'Accept-Language': 'pt-BR' } });
  assert.deepEqual(await invalidStream.json(), { errorCode: 'INVALID_FRAME_RATE', errorParameters: {}, error: messages.INVALID_FRAME_RATE.pt });
});

test('state warnings and unexpected API failures follow the selected language without leaking internal errors', async t => {
  const desktop = createDesktop({ runner: async () => { throw new Error('private internals'); }, exists: async () => false });
  const f = await fixture(t, { desktop });
  const english = await (await f.request('/api/state')).json();
  const portuguese = await (await f.request('/api/state', { headers: { 'Accept-Language': 'pt' } })).json();
  assert.ok(english.warnings.includes(messages.INPUT_UNAVAILABLE.en));
  assert.ok(portuguese.warnings.includes(messages.INPUT_UNAVAILABLE.pt));
  assert.deepEqual(english.warningCodes, portuguese.warningCodes);
  assert.deepEqual(english.warnings, english.warningCodes.map(code => messages[code].en));
  assert.deepEqual(portuguese.warnings, portuguese.warningCodes.map(code => messages[code].pt));
  assert.equal(JSON.stringify(english).includes('private internals'), false);
  const broken = await fixture(t, { desktop: { getState: async () => { throw new Error('sensitive private detail'); }, close: async () => {} } });
  const failed = await broken.request('/api/state', { headers: { 'Accept-Language': 'pt' } });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { errorCode: 'INTERNAL_ERROR', errorParameters: {}, error: messages.INTERNAL_ERROR.pt });
  for (const entry of Object.values(messages)) {
    assert.equal(typeof entry.en, 'string'); assert.equal(typeof entry.pt, 'string');
    assert.ok(entry.en.length > 0 && entry.pt.length > 0);
  }
  assert.equal(message('__proto__'), messages.INTERNAL_ERROR.en);
});

test('API error parameters expose only public scalar placeholders already used by the error message', async t => {
  const f = await fixture(t, { desktop: { getState: async () => {
    throw new ApiError(400, 'NUMBER_OUT_OF_RANGE', { min: 1, max: 10, token: 'must-remain-private', debug: { internal: true } });
  }, close: async () => {} } });
  const response = await f.request('/api/state');
  const body = await response.json();
  assert.deepEqual(body, { errorCode: 'NUMBER_OUT_OF_RANGE', errorParameters: { min: 1, max: 10 }, error: 'The number must be between 1 and 10.' });
  assert.equal(JSON.stringify(body).includes('must-remain-private'), false);
});

test('lights, all-monitor DPMS, reboot and suspend map to the Magma controller, hyprctl and systemctl with validation', async t => {
  const base = await fixture(t);
  const controller = path.join(base.root, 'controller.py');
  await writeFile(controller, '# fake Magma controller\n');
  const withEnv = async (env, dataDir) => {
    const desktop = createDesktop({ runner: base.runner, exists: async () => true, env: { ...process.env, ...env } });
    const app = await createApp({ rootDir: base.root, dataDir: path.join(base.root, dataDir), token: TOKEN, desktop, audio: base.audio, trustedHosts: ['phone.tailnet.test'] });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => app.close());
    const url = `http://127.0.0.1:${app.server.address().port}`;
    return {
      action: value => fetch(`${url}/api/action`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
      state: async () => (await fetch(`${url}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json(),
    };
  };
  const f = { ...base, ...(await withEnv({ MAGMA_LIGHTS_CONTROLLER: controller }, 'private-lights')) };
  for (const value of [
    { type: 'lights.preset', preset: 'lava; rm -rf /' }, { type: 'lights.preset', preset: '__proto__' }, { type: 'lights.preset' },
    { type: 'lights.screen', enabled: 'on' }, { type: 'power.dpms_all', state: 'standby' }, { type: 'power.dpms_all' },
  ]) {
    assert.equal((await f.action(value)).status, 400, JSON.stringify(value));
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.action({ type: 'lights.preset', preset: 'oceano' })).status, 200);
  assert.equal(f.calls.at(-1).command, 'python');
  assert.match(f.calls.at(-1).args[0], /controller\.py$/);
  assert.deepEqual(f.calls.at(-1).args.slice(1), ['preset', 'oceano', '--json']);
  for (const [type, expected] of [['lights.sleep', 'sleep'], ['lights.restore', 'restore'], ['lights.reapply', 'reapply']]) {
    assert.equal((await f.action({ type })).status, 200);
    assert.deepEqual(f.calls.at(-1).args.slice(1), [expected, '--json']);
  }
  assert.equal((await f.action({ type: 'lights.screen', enabled: false })).status, 200);
  assert.deepEqual(f.calls.at(-1).args.slice(1), ['screen_off']);
  assert.equal((await f.action({ type: 'power.dpms_all', state: 'off' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'hl.dsp.dpms({ monitor = "DP-1" })']);
  const allOnBefore = f.calls.filter(call => call.command === 'hyprctl' && String(call.args[1]).includes('dpms')).length;
  assert.equal((await f.action({ type: 'power.dpms_all', enabled: true })).status, 200);
  assert.equal(f.calls.filter(call => call.command === 'hyprctl' && String(call.args[1]).includes('dpms')).length, allOnBefore, 'monitors already on are not toggled');
  assert.equal((await f.action({ type: 'power.reboot' })).status, 200);
  assert.deepEqual([f.calls.at(-1).command, f.calls.at(-1).args], ['systemctl', ['reboot']]);
  assert.equal((await f.action({ type: 'power.suspend' })).status, 200);
  assert.deepEqual([f.calls.at(-1).command, f.calls.at(-1).args], ['systemctl', ['suspend']]);
  const state = await f.state();
  assert.equal(state.capabilities.lights, true);
  assert.equal(state.lights, null, 'a controller answer that is not JSON degrades to no light status');
  assert.equal(state.session.lockAvailable, true);
  const missing = await withEnv({ MAGMA_LIGHTS_CONTROLLER: path.join(base.root, 'absent.py') }, 'private-nolights');
  assert.equal((await missing.state()).capabilities.lights, false);
  const denied = await missing.action({ type: 'lights.preset', preset: 'lua' });
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).errorCode, 'LIGHTS_UNAVAILABLE');
});

test('session lock runs the Omarchy locker and unlock types the password only while the lock is up', async t => {
  const f = await fixture(t);
  let locked = 'false';
  const base = f.runner;
  f.desktop = createDesktop({ runner: async (command, args, options) => { if (command === 'omarchy-shell') { f.calls.push({ command, args, options }); return `${locked}\n`; } return base(command, args, options); }, exists: async () => true });
  const app = await createApp({ rootDir: f.root, dataDir: path.join(f.root, 'private2'), token: TOKEN, desktop: f.desktop, audio: f.audio, trustedHosts: ['phone.tailnet.test'] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const act = value => fetch(`http://127.0.0.1:${app.server.address().port}/api/action`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  for (const value of [{ type: 'session.unlock' }, { type: 'session.unlock', password: '' }, { type: 'session.unlock', password: 'a'.repeat(257) }, { type: 'session.unlock', password: 'x\ny' }]) {
    assert.equal((await act(value)).status, 400, JSON.stringify(value));
  }
  const notLocked = await act({ type: 'session.unlock', password: 'segredo' });
  assert.equal(notLocked.status, 409);
  assert.equal((await notLocked.json()).errorCode, 'SESSION_NOT_LOCKED');
  assert.equal(f.calls.filter(call => call.command === 'ydotool').length, 0, 'no keystrokes while unlocked');
  assert.equal((await act({ type: 'session.lock' })).status, 200);
  assert.deepEqual([f.calls.at(-1).command, f.calls.at(-1).args], ['omarchy-system-lock', []]);
  locked = 'true';
  assert.equal((await act({ type: 'session.unlock', password: 'seg redo!' })).status, 200);
  const typed = f.calls.filter(call => call.command === 'ydotool');
  assert.deepEqual(typed[0].args, ['type', '--file', '-', '--key-delay', '12']);
  assert.equal(typed[0].options.input, 'seg redo!');
  assert.deepEqual(typed[1].args, ['key', '--key-delay', '1', '28:1', '28:0']);
  const state = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.deepEqual(state.session, { locked: true, lockAvailable: true });
});

test('state caches capabilities and the displayed lock flag, but unlock always asks the lock itself', async t => {
  const f = await fixture(t);
  let locked = 'true', existsCalls = 0;
  const base = f.runner;
  const desktop = createDesktop({ runner: async (command, args, options) => { if (command === 'omarchy-shell') { f.calls.push({ command, args, options }); return `${locked}\n`; } return base(command, args, options); }, exists: async () => { existsCalls++; return true; } });
  const lockReads = () => f.calls.filter(call => call.command === 'omarchy-shell').length;
  assert.equal((await desktop.getState()).session.locked, true);
  const afterFirst = { lock: lockReads(), exists: existsCalls };
  assert.equal(afterFirst.lock, 1);
  locked = 'false';
  assert.equal((await desktop.getState()).session.locked, true, 'a poll within 5 s reuses the lock flag');
  assert.deepEqual({ lock: lockReads(), exists: existsCalls }, afterFirst, 'no lock spawn and no capability probe on a cached poll');
  // The display may be stale; the password is still never typed into an unlocked session.
  await assert.rejects(desktop.action({ type: 'session.unlock', password: 'segredo' }), { code: 'SESSION_NOT_LOCKED' });
  assert.equal(f.calls.filter(call => call.command === 'ydotool').length, 0);
  await desktop.action({ type: 'session.lock' });
  locked = 'true';
  assert.equal((await desktop.getState()).session.locked, true, 'a lock from the phone is read fresh');
  locked = 'false';
  assert.equal((await desktop.getState()).session.locked, false, 'and keeps being read fresh while it settles');
});

test('dictation transcribes on the PC, types into the chosen terminal, and presses Enter unless disabled', async t => {
  const inputs = [];
  const terminals = {
    list: async () => ({ available: true, sessions: [], limit: 4 }), create: async () => { throw new Error('unused'); },
    read: async () => { throw new Error('unused'); }, resize: async () => ({ ok: true }), remove: async () => ({ ok: true }),
    input: async (id, value) => { inputs.push([id, value]); return { ok: true }; }, close: () => {},
  };
  const transcripts = [];
  const transcriber = { available: async () => true, transcribe: async (body, contentType) => { transcripts.push({ size: body.length, contentType }); return { text: 'echo oi', provider: 'fake', duration: 1 }; } };
  const f = await fixture(t, { terminals, transcriber });
  const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 3)]);
  const id = 'abcdefabcdefabcdefabcdef';
  const sent = await f.request(`/api/terminals/${id}/dictate`, { method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus' }, body: audio });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { ok: true, text: 'echo oi', entered: true, provider: 'fake' });
  assert.deepEqual(inputs, [[id, { text: 'echo oi' }], [id, { key: 'Enter' }]]);
  assert.deepEqual(transcripts, [{ size: audio.length, contentType: 'audio/webm;codecs=opus' }]);
  const typedOnly = await f.request(`/api/terminals/${id}/dictate?enter=0`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio });
  assert.deepEqual(await typedOnly.json(), { ok: true, text: 'echo oi', entered: false, provider: 'fake' });
  assert.deepEqual(inputs.slice(2), [[id, { text: 'echo oi' }]]);
  const plain = await f.request('/api/dictate', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio });
  assert.deepEqual(await plain.json(), { ok: true, text: 'echo oi', provider: 'fake' });
  assert.equal(inputs.length, 3, 'plain dictation types nothing');
  const unauthenticated = await fetch(`${f.base}/api/dictate`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio });
  assert.equal(unauthenticated.status, 401);
  assert.equal(transcripts.length, 3);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.capabilities.stt, true);
});

test('absolute pointer moves and the text-input probe back the phone screen without clicking', async t => {
  const base = mockRunner();
  let debug = 'Group [wayland:] has 2 InputContext(s)\n  IC [a] program:foot frontend:wayland_v2 cap:1 focus:0\n  IC [b] program:chromium frontend:wayland_v2 cap:1 focus:1\n';
  const runner = async (command, args, options) => { base.calls.push({ command, args, options }); if (command === 'busctl') return debug; return base.runner(command, args, options); };
  const desktop = createDesktop({ runner, exists: async () => true });
  const f = await fixture(t, { desktop });
  assert.equal((await f.action({ type: 'mouse.moveTo', monitor: 'DP-1', x: 10, y: 20 })).status, 200);
  const lastYdotool = base.calls.filter(call => call.command === 'ydotool').at(-1);
  assert.deepEqual([lastYdotool.command, lastYdotool.args], ['ydotool', ['mousemove', '--absolute', '--', '10', '20']]);
  assert.equal(base.calls.filter(call => call.command === 'ydotool' && call.args[0] === 'click').length, 0, 'moveTo never clicks');
  for (const value of [{ type: 'mouse.moveTo', monitor: 'DP-1', x: 1920, y: 0 }, { type: 'mouse.moveTo', monitor: 'NOPE', x: 0, y: 0 }, { type: 'mouse.moveTo', monitor: 'DP-1', x: 1.5, y: 0 }]) {
    assert.equal((await f.action(value)).status, 400, JSON.stringify(value));
  }
  assert.deepEqual(await (await f.request('/api/textinput')).json(), { available: true, focused: true });
  debug = debug.replace('focus:1', 'focus:0');
  assert.deepEqual(await (await f.request('/api/textinput')).json(), { available: true, focused: false });
  const state = await (await f.request('/api/state')).json();
  assert.deepEqual(state.textInput, { available: true, focused: false });
  assert.equal((await fetch(`${f.base}/api/textinput`)).status, 401);
});

test('the virtual pointer is set to a flat profile and every placement is verified against the compositor cursor', async () => {
  const calls = [];
  let cursor = { x: 0, y: 0 };
  let accel = 2; // Hyprland's adaptive profile doubled ydotool's relative "absolute" moves on a real desktop.
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'DP-3', x: 1920, y: 0, width: 3440, height: 1440, focused: true }]);
    if (command === 'hyprctl' && args[1] === 'devices') return JSON.stringify({ mice: [{ name: 'ydotoold-virtual-device-1' }, { name: 'logitech-g515' }] });
    if (command === 'hyprctl' && args[0] === 'eval') { accel = 1; return 'ok\n'; }
    if (command === 'hyprctl' && args[0] === 'cursorpos') return `${cursor.x}, ${cursor.y}\n`;
    if (command === 'ydotool' && args[0] === 'mousemove') {
      const [dx, dy] = args.at(-2) === '--' || args.at(-3) === '--' ? [Number(args.at(-2)), Number(args.at(-1))] : [0, 0];
      if (args.includes('--absolute')) cursor = { x: dx * accel, y: dy * accel };
      else cursor = { x: cursor.x + dx * accel, y: cursor.y + dy * accel };
    }
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true });
  await desktop.action({ type: 'mouse.clickAt', monitor: 'DP-3', x: 1000, y: 700, button: 'left' });
  const evals = calls.filter(call => call.command === 'hyprctl' && call.args[0] === 'eval');
  assert.equal(evals.length, 1, 'the profile is applied once per calibration');
  assert.match(evals[0].args[1], /hl\.device\(\{ name = "ydotoold-virtual-device-1", accel_profile = "flat", sensitivity = 0 \}\)/);
  assert.ok(!evals[0].args[1].includes('logitech'), 'physical mice keep the user profile');
  assert.deepEqual(cursor, { x: 2920, y: 700 });
  assert.deepEqual(calls.at(-1).args, ['click', '0xC0']);
  // The daemon restarts: a new device with the default profile again. The
  // verification catches the miss, recalibrates and lands on the pixel.
  accel = 2;
  await desktop.action({ type: 'mouse.moveTo', monitor: 'DP-3', x: 10, y: 20 });
  assert.deepEqual(cursor, { x: 1930, y: 20 });
  assert.equal(calls.filter(call => call.command === 'hyprctl' && call.args[0] === 'eval').length, 2);
  const state0 = await desktop.getState();
  assert.ok(!state0.warningCodes.includes('POINTER_INACCURATE'));
  await desktop.close();
});

test('an unfixable pointer scale is corrected with a relative nudge and reported in the state', async () => {
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, focused: true }]);
    if (command === 'hyprctl' && args[1] === 'devices') return JSON.stringify({ mice: [{ name: 'ydotoold-virtual-device-1' }] });
    if (command === 'hyprctl' && args[0] === 'eval') return 'error: attempt to call nil\n';
    if (command === 'hyprctl' && args[0] === 'cursorpos') return `${cursor.x}, ${cursor.y}\n`;
    if (command === 'ydotool' && args[0] === 'mousemove') {
      const dx = Number(args.at(-2)), dy = Number(args.at(-1));
      // Small relative nudges pass through unscaled; the long leg is doubled.
      const factor = Math.hypot(dx, dy) > 50 ? 2 : 1;
      cursor = args.includes('--absolute') ? { x: dx * factor, y: dy * factor } : { x: cursor.x + dx * factor, y: cursor.y + dy * factor };
    }
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true });
  await desktop.action({ type: 'mouse.moveTo', monitor: 'DP-1', x: 100, y: 40 });
  assert.deepEqual(cursor, { x: 100, y: 40 });
  assert.ok(calls.some(call => call.command === 'hyprctl' && call.args[0] === 'keyword' && call.args[1] === 'device[ydotoold-virtual-device-1]:accel_profile'), 'legacy keyword fallback is attempted');
  const relative = calls.filter(call => call.command === 'ydotool' && call.args[0] === 'mousemove' && !call.args.includes('--absolute'));
  assert.deepEqual(relative.at(-1).args, ['mousemove', '--', '-50', '-20'], 'the nudge is divided by the observed scale');
  const state = await desktop.getState();
  assert.ok(!state.warningCodes.includes('POINTER_INACCURATE'), 'the nudge landed, so no warning');
  await desktop.close();
});

test('a line with enter is typed and confirmed in one action, and a Super drag holds the modifier until release', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, focused: true }]);
    if (command === 'hyprctl' && args[1] === 'activewindow') return JSON.stringify({ address: '0xabc', title: 'Editor', class: 'Editor', workspace: { id: 3, name: '3' }, at: [0, 0], size: [1920, 1080] });
    if (command === 'hyprctl' && args[0] === 'cursorpos') return '100, 40\n';
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true, dragTimeout: 30 });
  await desktop.action({ type: 'keyboard.text', text: 'olá mundo', enter: true });
  const typed = calls.filter(call => ['wtype', 'ydotool'].includes(call.command));
  assert.deepEqual(typed.at(-2).args, ['-']);
  assert.deepEqual(typed.at(-1).args, ['key', '--key-delay', '1', '28:1', '28:0']);
  calls.length = 0;
  const started = await desktop.action({ type: 'mouse.dragStartAt', monitor: 'DP-1', x: 100, y: 40, modifier: 'super' });
  assert.equal(started.window.address, '0xabc');
  const keys = () => calls.filter(call => call.command === 'ydotool' && ['key', 'click'].includes(call.args[0])).map(call => call.args.slice(-1)[0]);
  assert.deepEqual(keys(), ['125:1', '0x40'], 'Super goes down before the button');
  await desktop.action({ type: 'mouse.drag', pressed: false });
  assert.deepEqual(keys().slice(2), ['0x80', '125:0'], 'button up, then Super up');
  calls.length = 0;
  await assert.rejects(desktop.action({ type: 'mouse.dragStartAt', monitor: 'DP-1', x: 1, y: 1, modifier: 'alt' }), error => error.status === 400);
  // The auto-release after a lost phone also lets go of Super.
  await desktop.action({ type: 'mouse.dragStartAt', monitor: 'DP-1', x: 100, y: 40, modifier: 'super' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(keys().slice(-2), ['0x80', '125:0']);
  await desktop.close();
});

// Magma controller with --json: one entry per device, printed also before a non-zero exit.
const magmaReport = (ok, statuses) => JSON.stringify({ action: 'sleep', ok, devices: Object.entries(statuses).map(([device, status]) => ({ device, status, ...(status === 'failed' ? { error: 'i2c timeout' } : {}) })) });
const commandFailure = detail => Object.assign(new ApiError(503, 'COMMAND_FAILED', { command: 'python' }), { detail: { exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: '', ...detail } });
function sleepDesktop({ python, hyprFails = false, controller = '/nonexistent/controller.py', lightsAnswerMs }) {
  const calls = []; const logs = [];
  const log = { log: line => logs.push(['log', line]), error: line => logs.push(['error', line]) };
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl') {
      if (hyprFails) throw commandFailure({ stderr: 'HYPRLAND_INSTANCE_SIGNATURE not set' });
      if (args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, focused: true, dpmsStatus: true }]);
      return 'ok';
    }
    if (command === 'python') return python(args);
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true, env: { ...process.env, MAGMA_LIGHTS_CONTROLLER: controller }, log, lightsAnswerMs });
  return { desktop, calls, logs };
}

test('smart sleep reports an absent keyboard as skipped and logs every device to the journal', async () => {
  const { desktop, calls, logs } = sleepDesktop({ python: () => magmaReport(true, { 'ENE DRAM': 'ok', 'Corsair Vengeance RGB DDR5': 'ok', 'ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC': 'ok', 'G515 LS TKL': 'absent', 'MSI B650M': 'ok', telinha: 'ok' }) });
  const result = await desktop.action({ type: 'power.sleep' });
  assert.deepEqual(calls.at(-1).args.slice(1), ['sleep', '--json']);
  assert.equal(calls.at(-1).command, 'python');
  assert.deepEqual(result.lights.devices.map(item => [item.device, item.status]), [['RAM ENE', 'ok'], ['RAM Corsair', 'ok'], ['GPU', 'ok'], ['G515', 'absent'], ['MSI (fans)', 'ok'], ['LCD', 'ok']]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'log');
  assert.match(logs[0][1], /^\[lights\] power\.sleep ok .*"G515","status":"absent"/);
});

test('smart sleep names the lights that stayed on, in the phone language, without leaking controller output', async t => {
  const { desktop, logs } = sleepDesktop({ python: () => { throw commandFailure({ stdout: magmaReport(false, { 'ENE DRAM': 'ok', 'Corsair Vengeance RGB DDR5': 'ok', 'ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC': 'failed', 'G515 LS TKL': 'absent', 'MSI B650M': 'ok', telinha: 'ok' }), stderr: 'RGB: ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC: i2c timeout' }); } });
  await assert.rejects(desktop.action({ type: 'power.sleep' }), error => error.code === 'SLEEP_LIGHTS_FAILED' && error.parameters.devices === 'GPU');
  assert.equal(logs.at(-1)[0], 'error');
  assert.match(logs.at(-1)[1], /\[lights\] power\.sleep failed: exit=1 .*"GPU","status":"failed".* i2c timeout/);
  const f = await fixture(t, { desktop: { action: value => desktop.action(value), getState: async () => ({}), close: async () => {} } });
  for (const [lang, text] of [['en', 'Monitors are off, but these lights stayed on: GPU. Details are in the PC journal.'], ['pt', 'Monitores apagados, mas estas luzes ficaram acesas: GPU. Detalhes no journal do PC.']]) {
    const response = await f.request(`/api/action?lang=${lang}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'power.sleep' }) });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { errorCode: 'SLEEP_LIGHTS_FAILED', errorParameters: { devices: 'GPU' }, error: text });
  }
});

test('lights still sleep when Hyprland fails, and the monitor error is the one reported', async () => {
  const { desktop, calls, logs } = sleepDesktop({ hyprFails: true, python: () => magmaReport(true, { 'ENE DRAM': 'ok', 'MSI B650M': 'ok' }) });
  await assert.rejects(desktop.action({ type: 'power.sleep' }), error => error.code === 'HYPRLAND_UNAVAILABLE');
  assert.deepEqual(calls.filter(call => call.command === 'python').map(call => call.args.slice(1)), [['sleep', '--json']]);
  assert.match(logs[0][1], /\[power\] power\.sleep monitors failed: HYPRLAND_UNAVAILABLE/);
  // Lights off alone reports its own failure code; wake restores lights even with Hyprland down.
  const failing = sleepDesktop({ python: () => { throw commandFailure({ stdout: magmaReport(false, { 'ENE DRAM': 'failed', 'MSI B650M': 'ok' }) }); } });
  await assert.rejects(failing.desktop.action({ type: 'power.wake' }), error => error.code === 'LIGHTS_FAILED' && error.parameters.devices === 'RAM ENE');
  const woke = sleepDesktop({ hyprFails: true, python: () => magmaReport(true, {}) });
  await assert.rejects(woke.desktop.action({ type: 'power.wake' }), error => error.code === 'HYPRLAND_UNAVAILABLE');
  assert.deepEqual(woke.calls.filter(call => call.command === 'python').map(call => call.args.slice(1)), [['restore', '--json']]);
});

test('an older Magma controller without --json degrades to its exit code', async () => {
  let attempt = 0;
  const { desktop, calls } = sleepDesktop({ python: args => {
    attempt++;
    if (args.includes('--json')) throw commandFailure({ exitCode: 2, stderr: 'controller.py: error: unrecognized arguments: --json' });
    if (attempt === 2) return 'Gabinete e telinha apagados.';
    throw commandFailure({ stderr: 'RGB: Error: Cannot find device "G515 LS TKL"' });
  } });
  assert.deepEqual(await desktop.action({ type: 'power.sleep' }), { ok: true, lights: null });
  assert.deepEqual(calls.filter(call => call.command === 'python').map(call => call.args.slice(1)), [['sleep', '--json'], ['sleep']]);
  await assert.rejects(desktop.action({ type: 'power.sleep' }), error => error.code === 'SLEEP_LIGHTS_FAILED' && error.parameters.devices === 'RGB');
});

test('lights status lists what a partial sleep left on', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-lights-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = path.join(root, 'controller.py');
  await writeFile(controller, '# fake Magma controller\n');
  const { desktop } = sleepDesktop({ controller, python: args => args[1] === 'status' ? JSON.stringify({ last_applied: { preset: 'lava', sleeping: true, brightness: 100, incomplete: ['ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC', 7] } }) : 'ok' });
  const { lights } = await desktop.getState();
  assert.deepEqual(lights.incomplete, ['GPU']);
  assert.equal(lights.sleeping, true);
});

test('a failed command keeps its exit code, stdout and a redacted stderr tail off the public error', async () => {
  const secret = 'a'.repeat(48);
  await assert.rejects(runCommand(process.execPath, ['-e', `process.stdout.write('{"ok":false}'); process.stderr.write('noise '.repeat(150) + ' token=${secret} Error: Cannot find device'); process.exit(3)`], { timeout: 5000 }), error => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.deepEqual(error.parameters, { command: path.basename(process.execPath) });
    assert.equal(error.detail.exitCode, 3);
    assert.equal(error.detail.stdout, '{"ok":false}');
    assert.ok(error.detail.stderr.length <= 600);
    assert.match(error.detail.stderr, /token=\[redacted\] Error: Cannot find device$/);
    assert.equal(error.detail.stderr.includes(secret), false);
    return true;
  });
});

test('a sleep longer than the phone proxy allows answers pending, then reports through state.lights.last', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-lights-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = path.join(root, 'controller.py');
  await writeFile(controller, '# fake Magma controller\n');
  let finish;
  const { desktop, logs } = sleepDesktop({ controller, lightsAnswerMs: 20, python: args => args[1] === 'status'
    ? JSON.stringify({ last_applied: { preset: 'lava', sleeping: true, brightness: 100, incomplete: ['ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC'] } })
    : new Promise((resolve, reject) => { finish = () => reject(commandFailure({ stdout: magmaReport(false, { 'ENE DRAM': 'ok', 'ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC': 'failed', 'G515 LS TKL': 'absent', 'MSI B650M': 'ok' }) })); }) });
  assert.deepEqual(await desktop.action({ type: 'power.sleep' }), { ok: true, lights: { pending: true, job: 1 } });
  assert.equal((await desktop.getState()).lights.last, null, 'nothing reported while the controller runs');
  await assert.rejects(desktop.action({ type: 'power.wake' }), error => error.code === 'OPERATION_BUSY', 'a second lights job waits for the first');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  const { lights } = await desktop.getState();
  assert.deepEqual(lights.last, { job: 1, action: 'power.sleep', ok: false, devices: [{ device: 'RAM ENE', status: 'ok' }, { device: 'GPU', status: 'failed' }, { device: 'G515', status: 'absent' }, { device: 'MSI (fans)', status: 'ok' }] });
  assert.deepEqual(lights.incomplete, ['GPU']);
  assert.match(logs.at(-1)[1], /\[lights\] power\.sleep failed/);
  // A quick answer still comes back inline, with the next job number recorded.
  const quick = sleepDesktop({ lightsAnswerMs: 1000, python: () => magmaReport(true, { 'ENE DRAM': 'ok' }) });
  assert.deepEqual((await quick.desktop.action({ type: 'power.wake' })).lights, { ok: true, devices: [{ device: 'RAM ENE', status: 'ok' }] });
});

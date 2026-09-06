import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, symlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { createDesktop } from '../backend/desktop.mjs';
import { createAudioStore, MAX_AUDIO_BYTES } from '../backend/audio.mjs';
import { ApiError, runCommand } from '../backend/process.mjs';
import { createLiveStreaming, writeLiveFrame } from '../backend/live.mjs';
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
      if (args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, focused: true }]);
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
  assert.deepEqual(await health.json(), { name: 'Ponte', requiresPairing: true });
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
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await f.request('/progress.json')).status, 200);
  assert.equal((await f.request('/app.js', { method: 'POST' })).status, 405);
  const head = await f.request('/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('state normalizes live desktop output and marks degraded integrations', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.activeWindow, {...window,monitor:null});
  assert.deepEqual(state.volume, { value: 0.67, muted: true });
  assert.deepEqual(state.monitors, [{ name: 'DP-1', width: 1920, height: 1080, focused: true, dpmsStatus: true }]);
  assert.deepEqual(state.workspaces, [{ id: 3, name: '3', windows: 1 }]);
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
    { type: 'mouse.drag', pressed: 'true' }, { type: 'keyboard.key', key: 'Enter; touch /tmp/never' },
    { type: 'keyboard.text', text: 'a\0b' }, { type: 'keyboard.text', text: 'a'.repeat(4001) },
    { type: 'workspace.focus', id: '1;exec sh' }, { type: 'workspace.focus', id: -1 }, { type: 'workspace.focus', id: 1.1 },
    { type: 'window.focus', address: '0xabc;dispatch exec true' },
    { type: 'volume.set', value: 1.1 }, { type: 'volume.set', value: '0.5' },
    { type: 'app.launch', app: 'terminal; touch /tmp/never' }, { type: 'app.launch', app: '__proto__' },
    { type: 'power.dpms', monitor: 'DP-1; reboot', state: 'off' }, { type: 'power.dpms', monitor: 'DP-1', state: 'standby' },
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
  assert.equal((await f.request('/api/stream?monitor=DP-1&scale=1')).status, 400);
  assert.equal(f.calls.filter(call => call.command === 'grim').length, 1);
});

test('power actions control monitors, smart sleep, wake, and poweroff with validation', async t => {
  const f = await fixture(t);
  // Invalid monitor name (not in live state)
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'UNKNOWN-1', state: 'off' })).status, 400);
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1; reboot', state: 'off' })).status, 400);
  // Valid monitor DPMS off and on
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1', state: 'off' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'dpms', 'off', 'DP-1']);
  assert.equal(f.calls.at(-1).command, 'hyprctl');

  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1', state: 'on' })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'dpms', 'on', 'DP-1']);

  // Boolean enabled form
  assert.equal((await f.action({ type: 'power.dpms', monitor: 'DP-1', enabled: false })).status, 200);
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'dpms', 'off', 'DP-1']);

  // Smart sleep
  assert.equal((await f.action({ type: 'power.sleep' })).status, 200);
  const sleepCalls = f.calls.slice(-2);
  assert.deepEqual(sleepCalls[0].args, ['dispatch', 'dpms', 'off']);
  assert.equal(sleepCalls[1].command, 'python');
  assert.match(sleepCalls[1].args[0], /controller\.py$/);
  assert.equal(sleepCalls[1].args[1], 'sleep');

  // Wake
  assert.equal((await f.action({ type: 'power.wake' })).status, 200);
  const wakeCalls = f.calls.slice(-2);
  assert.deepEqual(wakeCalls[0].args, ['dispatch', 'dpms', 'on']);
  assert.equal(wakeCalls[1].command, 'python');
  assert.match(wakeCalls[1].args[0], /controller\.py$/);
  assert.equal(wakeCalls[1].args[1], 'restore');

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
  assert.deepEqual(f.calls.at(-1).args, ['dispatch', 'dpms', 'off', 'DP-1']);
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
  for (const query of ['fps=11', 'fps=0', 'fps=1.5', 'scale=1', 'scale=NaN', 'scale=0.1', 'fps=5&fps=6', 'monitor=DP-1%3Bexec%20sh']) {
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

test('live streaming allows three sessions, rejects a fourth, and frees slots after cancellation', async t => {
  const f = await fixture(t);
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const responses = await Promise.all(controllers.map(controller => f.request('/api/stream?monitor=DP-1', { signal: controller.signal })));
  assert.ok(responses.every(response => response.status === 200));
  const extra = await f.request('/api/stream?monitor=DP-1');
  assert.equal(extra.status, 429);
  assert.equal((await extra.json()).errorCode, 'STREAM_LIMIT_REACHED');
  controllers.forEach(controller => controller.abort());
  await Promise.all(responses.map(response => response.body.cancel().catch(() => {})));
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
  const desktop = { prepareLive: async () => ({ capture: signal => new Promise((resolve, reject) => {
    signals.push(signal); active++; peak = Math.max(peak, active);
    signal.addEventListener('abort', () => { active--; completed++; reject(new Error('aborted')); }, { once: true });
  }) }) };
  const live = createLiveStreaming(desktop);
  const responses = [new FakeStreamResponse(), new FakeStreamResponse(), new FakeStreamResponse()];
  const streams = responses.map(res => live.stream({}, res, new URLSearchParams('monitor=DP-1')));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(peak, 2); assert.equal(signals.length, 2);
  live.close(); await Promise.all(streams);
  assert.ok(signals.every(signal => signal.aborted)); assert.equal(completed, 2); assert.equal(active, 0);
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
  const invalidStream = await f.request('/api/stream?fps=20', { headers: { 'Accept-Language': 'pt-BR' } });
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

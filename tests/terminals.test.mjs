import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, access, symlink } from 'node:fs/promises';
import { createTerminals, TERMINAL_TEXT_LIMIT } from '../backend/terminals.mjs';
import { createApp } from '../server.mjs';
import { ApiError, commandExists, runCommand } from '../backend/process.mjs';

async function temporary(t, autoClean = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-terminal-'));
  if (autoClean) t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function mockedTmux() {
  const calls = [], panes = [];
  let next = 0, capture = 'Synthetic terminal output\n';
  const line = pane => [pane.name, pane.windowId, pane.paneId, pane.cols, pane.rows, pane.inMode ? '1' : '0'].join('\t');
  const runner = async (command, argv, options) => {
    assert.equal(command, 'tmux');
    const args = argv.slice(5);
    calls.push({ command, argv, args, options });
    if (args[0] === 'if-shell') {
      if (panes.find(pane => pane.paneId === args[3])?.inMode) return 'PONTE_INPUT_BLOCKED\n';
      return runner(command, [...argv.slice(0, 5), ...args.at(-1).split(' ')], options);
    }
    if (args.includes('list-panes')) return panes.map(line).join('\n');
    if (args.includes('new-session')) {
      const pane = { name: args[args.indexOf('-s') + 1], windowId: `@${next}`, paneId: `%${next++}`, cols: +args[args.indexOf('-x') + 1], rows: +args[args.indexOf('-y') + 1] };
      panes.push(pane); return line(pane);
    }
    if (args[0] === 'capture-pane') return capture;
    if (args[0] === 'kill-session') { const index = panes.findIndex(pane => pane.name === args[2].slice(1)); if (index >= 0) panes.splice(index, 1); }
    if (args[0] === 'resize-window') { const pane = panes.find(pane => pane.windowId === args[2]); pane.cols = +args[4]; pane.rows = +args[6]; }
    return '';
  };
  return { calls, panes, runner, exists: async () => true, probe: async () => panes.length > 0, setCapture: text => { capture = text; } };
}

async function fixture(t) {
  const root = await temporary(t), mock = mockedTmux();
  const terminals = createTerminals(root, mock);
  t.after(() => terminals.close());
  return { root, mock, terminals };
}

test('listing never starts a shell and reports a missing tmux without commands', async t => {
  const { root, mock, terminals } = await fixture(t);
  assert.deepEqual(await terminals.list(), { available: true, sessions: [], limit: 4 });
  assert.equal(mock.calls.length, 0);
  const absent = createTerminals(root, { ...mock, exists: async () => false });
  assert.deepEqual(await absent.list(), { available: false, sessions: [], limit: 4 });
  await assert.rejects(absent.create({ cols: 80, rows: 24 }), { code: 'TERMINAL_UNAVAILABLE' });
  assert.equal(mock.calls.length, 0);
});

test('dimensions, opaque targets, text controls and non-allowlisted keys fail before commands', async t => {
  const { mock, terminals } = await fixture(t);
  for (const value of [null, [], {}, { cols: 19, rows: 24 }, { cols: 241, rows: 24 }, { cols: 80, rows: 7 }, { cols: 80, rows: 101 }, { cols: '80', rows: 24 }, { cols: 80.1, rows: 24 }, { cols: 80, rows: 24, command: 'sh' }]) {
    assert.throws(() => terminals.create(value), { code: 'INVALID_TERMINAL_SIZE' });
  }
  const id = 'a'.repeat(24);
  for (const value of [null, [], {}, { text: 'a', key: 'Enter' }, { text: 'a', enter: 'yes' }, { key: 'Enter', enter: true }, { enter: true }, { text: 'x', target: '%0' }, { text: '' }, { text: 'x'.repeat(4001) }, { text: 'a\nb' }, { text: 'a\rb' }, { text: '\x1b' }, { text: '\x7f' }, { text: '\x85' }, { text: '\u2028' }, { text: '\ud800' }, { key: '__proto__' }, { key: '-F' }, { key: 'Enter; run-shell true' }]) {
    assert.throws(() => terminals.input(id, value), ApiError);
  }
  for (const id of ['%0', '@1', '-a', 'ponte_abc', 'a'.repeat(24) + '; kill-server', '../token']) {
    assert.throws(() => terminals.read(id), { code: 'TERMINAL_NOT_FOUND' });
    assert.throws(() => terminals.remove(id), { code: 'TERMINAL_NOT_FOUND' });
  }
  assert.equal(mock.calls.length, 0);
});

test('explicit create is serialized, limited to four, uses a private socket and persists identities', async t => {
  const { root, mock, terminals } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => terminals.create({ cols: 80, rows: 24 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(results.at(-1).reason.code, 'TERMINAL_LIMIT_REACHED');
  const list = await terminals.list();
  assert.equal(list.sessions.length, 4);
  assert.deepEqual(Object.keys(list.sessions[0]), ['id', 'title', 'cols', 'rows', 'inMode', 'attachCommand']);
  assert.match(list.sessions[0].id, /^[a-f0-9]{24}$/);
  for (const call of mock.calls) {
    assert.deepEqual(call.argv.slice(0, 5), ['-u', '-S', path.join(root, 'terminals', 'tmux.sock'), '-f', '/dev/null']);
    assert.equal(call.options.timeout, 2500);
    assert.equal(call.options.maxBuffer, 512 * 1024);
    assert.equal(call.options.env.TMUX, undefined);
  }
  assert.equal((await stat(path.join(root, 'terminals'))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, 'terminals', 'sessions.json'))).mode & 0o777, 0o600);
  await terminals.close();
  assert.equal(mock.calls.some(call => call.args.includes('kill-server')), false);
  const restored = createTerminals(root, mock);
  assert.deepEqual(await restored.list(), list);
  await restored.close();
});

test('literal input goes through stdin and isolated tmux buffer, with no implicit Enter', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  mock.calls.length = 0;
  const text = "ação; $(printf injected) `echo x` #{pane_id} -- -t %999";
  assert.deepEqual(await terminals.input(session.id, { text }), { ok: true });
  assert.equal(mock.calls.filter(call => call.args[0] === 'load-buffer')[0].options.input, text);
  assert.equal(mock.calls.some(call => call.argv.some(arg => arg.includes('injected'))), false);
  assert.equal(mock.calls.some(call => call.args[0] === 'send-keys'), false);
  const paste = mock.calls.find(call => call.args[0] === 'paste-buffer');
  assert.deepEqual(paste.args.slice(0, 4), ['paste-buffer', '-d', '-p', '-r']);
  assert.equal(paste.args.at(-1), '%0');
  for (const key of ['Enter', 'Tab', 'Escape', 'BackSpace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Interrupt']) await terminals.input(session.id, { key });
  assert.deepEqual(mock.calls.filter(call => call.args[0] === 'send-keys').map(call => call.args.at(-1)), ['Enter', 'Tab', 'Escape', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'C-c']);
});

test('text with enter pastes then runs the command in one serialized operation', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  mock.calls.length = 0;
  assert.deepEqual(await terminals.input(session.id, { text: 'npm test', enter: true }), { ok: true });
  const order = mock.calls.filter(call => ['load-buffer', 'paste-buffer', 'send-keys'].includes(call.args[0]) || call.args.includes('paste-buffer') || call.args.includes('send-keys'));
  // load-buffer feeds the text, paste-buffer types it, send-keys Enter runs it — in that order.
  assert.equal(mock.calls.find(call => call.args[0] === 'load-buffer').options.input, 'npm test');
  const pasteIndex = mock.calls.findIndex(call => call.argv.includes('paste-buffer'));
  const enterIndex = mock.calls.findIndex(call => call.argv.includes('send-keys') && call.argv.includes('Enter'));
  assert.ok(pasteIndex >= 0 && enterIndex > pasteIndex, 'Enter is sent after the paste');
  void order;
});

test('capture is plain and bounded; resize and deletion only target the verified managed pane/session', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  mock.setCapture('x'.repeat(100000) + '\x00\x1b\x7f\x85END\n');
  const capture = await terminals.read(session.id);
  assert.equal(Buffer.byteLength(capture.text), TERMINAL_TEXT_LIMIT);
  assert.ok(capture.text.endsWith('END\n'));
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(capture.text), false);
  mock.setCapture('😀'.repeat(30000) + 'a');
  const unicode = (await terminals.read(session.id)).text;
  assert.ok(Buffer.byteLength(unicode) <= TERMINAL_TEXT_LIMIT);
  assert.ok(unicode.isWellFormed()); assert.equal(unicode.includes('\ufffd'), false);
  await terminals.resize(session.id, { cols: 120, rows: 40 });
  assert.equal((await terminals.read(session.id)).cols, 120);
  const before = mock.calls.length;
  mock.panes[0].paneId = '%999';
  await assert.rejects(terminals.input(session.id, { key: 'Enter' }), { code: 'TERMINAL_CHANGED' });
  await assert.rejects(terminals.remove(session.id), { code: 'TERMINAL_CHANGED' });
  assert.ok(mock.calls.slice(before).every(call => call.args.includes('list-panes')));
  mock.panes[0].paneId = '%0';
  await terminals.remove(session.id);
  assert.deepEqual((await terminals.list()).sessions, []);
  await assert.rejects(terminals.read(session.id), { code: 'TERMINAL_NOT_FOUND' });
});

test('a symlinked socket is rejected without connecting or running tmux', async t => {
  const { root, mock, terminals } = await fixture(t);
  await mkdir(path.join(root, 'terminals'), { mode: 0o700 });
  await symlink('/tmp/other-user-tmux', path.join(root, 'terminals', 'tmux.sock'));
  await assert.rejects(terminals.list(), { code: 'TERMINAL_UNAVAILABLE' });
  assert.equal(mock.calls.length, 0);
});

test('terminal environment excludes backend variables and attachment text quotes private paths literally', async t => {
  const root = await temporary(t), mock = mockedTmux();
  const dataDir = path.join(root, "quoted' space$(false)");
  const env = { HOME: root, PATH: process.env.PATH, OMARCHY_REMOTE_TEST_ONLY: 'synthetic', OMARCHY_REMOTE_TLS_TEST: 'synthetic', KEEP_ME: 'yes', TMUX: 'other', TMUX_PANE: '%999' };
  const terminals = createTerminals(dataDir, { ...mock, env });
  const session = await terminals.create({ cols: 80, rows: 24 });
  for (const call of mock.calls) {
    assert.equal(Object.keys(call.options.env).some(key => key.startsWith('OMARCHY_REMOTE_')), false);
    assert.equal(call.options.env.TMUX, undefined); assert.equal(call.options.env.TMUX_PANE, undefined);
    assert.equal(call.options.env.KEEP_ME, 'yes');
  }
  assert.equal(env.OMARCHY_REMOTE_TEST_ONLY, 'synthetic', 'the caller environment stays unchanged');
  // Parse the generated shell words without executing the attachment command.
  const words = await runCommand('/bin/sh', ['-c', `set -- ${session.attachCommand}; printf '%s\\n' "$@"`], { env: { PATH: process.env.PATH } });
  assert.deepEqual(words.trimEnd().split('\n'), ['env', '-u', 'TMUX', '-u', 'TMUX_PANE', 'tmux', '-u', '-S', path.join(dataDir, 'terminals', 'tmux.sock'), '-f', '/dev/null', 'attach-session', '-t', `=ponte_${session.id}`]);
  assert.equal((await terminals.list()).sessions[0].attachCommand, session.attachCommand);
  assert.equal((await terminals.read(session.id)).attachCommand, session.attachCommand);
  assert.equal(mock.calls.some(call => call.argv.includes(session.attachCommand)), false);
  await terminals.close();
});

test('copy mode rejects both text and keys and a mode change before paste cannot falsely acknowledge input', async t => {
  const { root, mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  mock.panes[0].inMode = true;
  assert.equal((await terminals.list()).sessions[0].inMode, true);
  assert.equal((await terminals.read(session.id)).inMode, true);
  let before = mock.calls.length;
  await assert.rejects(terminals.input(session.id, { key: 'Enter' }), { status: 409, code: 'TERMINAL_IN_COPY_MODE' });
  await assert.rejects(terminals.input(session.id, { text: 'literal' }), { status: 409, code: 'TERMINAL_IN_COPY_MODE' });
  assert.ok(mock.calls.slice(before).every(call => call.args.includes('list-panes')));
  mock.panes[0].inMode = false;
  await terminals.close();
  const changed = createTerminals(root, { ...mock, runner: async (...args) => {
    const output = await mock.runner(...args);
    if (args[1].includes('load-buffer')) mock.panes[0].inMode = true;
    return output;
  } });
  before = mock.calls.length;
  await assert.rejects(changed.input(session.id, { text: 'literal' }), { status: 409, code: 'TERMINAL_IN_COPY_MODE' });
  assert.equal(mock.calls.slice(before).some(call => call.args[0] === 'paste-buffer'), false);
  assert.equal(mock.calls.at(-1).args[0], 'delete-buffer');
  await changed.close();
});

test('failed creation cleans up only its generated session and hidden sessions still count toward the cap', async t => {
  const root = await temporary(t), mock = mockedTmux();
  const terminals = createTerminals(root, { ...mock, runner: async (...args) => {
    const output = await mock.runner(...args);
    if (args[1].includes('new-session')) throw new Error('synthetic response failure');
    return output;
  } });
  await assert.rejects(terminals.create({ cols: 80, rows: 24 }), { code: 'TERMINAL_UNAVAILABLE' });
  assert.deepEqual(mock.panes, []);
  const killed = mock.calls.find(call => call.args[0] === 'kill-session');
  assert.match(killed.args[2], /^=ponte_[a-f0-9]{24}$/);
  for (let i = 0; i < 4; i++) mock.panes.push({ name: `unmanaged-${i}`, paneId: `%${i}`, windowId: `@${i}`, cols: 80, rows: 24 });
  assert.deepEqual((await terminals.list()).sessions, []);
  await assert.rejects(terminals.create({ cols: 80, rows: 24 }), { code: 'TERMINAL_LIMIT_REACHED' });
  assert.equal(mock.calls.filter(call => call.args.includes('new-session')).length, 1);
  await terminals.close();
});

test('shutdown aborts the active command, rejects queued input, and preserves terminal sessions', async t => {
  const { root, mock } = await fixture(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const terminals = createTerminals(root, { ...mock, runner: async (...args) => {
    if (args[1].includes('capture-pane')) {
      started();
      return new Promise((resolve, reject) => { release = resolve; args[2].signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    }
    return mock.runner(...args);
  } });
  const session = await terminals.create({ cols: 80, rows: 24 });
  const active = terminals.read(session.id);
  await entered;
  const checks = [assert.rejects(active, { code: 'SERVER_RESTARTING' }), ...Array.from({ length: 11 }, () => assert.rejects(terminals.input(session.id, { key: 'Enter' }), { code: 'SERVER_RESTARTING' }))];
  await assert.rejects(terminals.input(session.id, { key: 'Enter' }), { code: 'OPERATION_BUSY' });
  await terminals.close(); await Promise.all(checks); release();
  assert.equal(mock.panes.length, 1);
  assert.equal(mock.calls.some(call => call.args[0] === 'send-keys' || call.args[0] === 'kill-session'), false);
});

test('shutdown during creation waits for isolated cleanup of the newly created unregistered shell', async t => {
  const root = await temporary(t), mock = mockedTmux();
  let creationStarted, cleanupStarted, releaseCleanup;
  const entered = new Promise(resolve => { creationStarted = resolve; });
  const cleaning = new Promise(resolve => { cleanupStarted = resolve; });
  const cleanupAllowed = new Promise(resolve => { releaseCleanup = resolve; });
  const terminals = createTerminals(root, { ...mock, runner: async (command, argv, options) => {
    if (argv.includes('new-session')) {
      await mock.runner(command, argv, options);
      creationStarted();
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('interrupted response')), { once: true }));
    }
    if (argv.includes('kill-session')) {
      assert.equal(options.signal, undefined, 'cleanup is independent of the aborted request');
      assert.equal(options.timeout, 2500);
      assert.equal(options.maxBuffer, 16 * 1024);
      assert.equal(argv.at(-1), `=${mock.panes[0].name}`);
      cleanupStarted(); await cleanupAllowed;
    }
    return mock.runner(command, argv, options);
  } });
  const creation = assert.rejects(terminals.create({ cols: 80, rows: 24 }), { code: 'SERVER_RESTARTING' });
  await entered;
  let closed = false;
  const closing = terminals.close().then(() => { closed = true; });
  await cleaning;
  assert.equal(closed, false, 'close waits until its cleanup finishes');
  releaseCleanup(); await closing; await creation;
  assert.deepEqual(mock.panes, []);
  const reopened = createTerminals(root, mock);
  assert.deepEqual((await reopened.list()).sessions, []);
  await reopened.close();
});

test('terminal HTTP endpoints inherit authentication, origin, content bounds and localized errors', async t => {
  const { root, terminals, mock } = await fixture(t);
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'index.html'), '<title>Test</title>');
  const token = 'synthetic_terminal_token_abcdefghijklmnopqrstuvwxyz';
  const app = await createApp({ rootDir: root, dataDir: path.join(root, 'state'), token, terminals, desktop: { close() {} }, audio: { close() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, method = 'GET', value, extraHeaders = {}) => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders };
    const body = value === undefined ? undefined : JSON.stringify(value);
    if (extraHeaders.Host) return new Promise((resolve, reject) => {
      const req = http.request(`${base}${route}`, { method, headers }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject); req.end(body);
    });
    return fetch(`${base}${route}`, { method, headers, body });
  };
  const id = 'a'.repeat(24);
  for (const [route, method, value] of [['/api/terminals', 'GET'], ['/api/terminals', 'POST', { cols: 80, rows: 24 }], [`/api/terminals/${id}`, 'GET'], [`/api/terminals/${id}`, 'DELETE'], [`/api/terminals/${id}/input`, 'POST', { key: 'Enter' }], [`/api/terminals/${id}/resize`, 'POST', { cols: 80, rows: 24 }]]) {
    assert.equal((await request(route, method, value, { Authorization: '' })).status, 401);
    assert.equal((await request(route, method, value, { Origin: 'https://attacker.test' })).status, 403);
    assert.equal((await request(route, method, value, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request(route, method, value, { Host: 'attacker.test' })).status, 403);
  }
  assert.equal(mock.calls.length, 0);
  const invalid = await request('/api/terminals', 'POST', { cols: 1, rows: 2 }, { 'Accept-Language': 'pt-BR' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { errorCode: 'INVALID_TERMINAL_SIZE', errorParameters: {}, error: 'O terminal deve ter de 20 a 240 colunas e de 8 a 100 linhas.' });
  assert.equal((await request('/api/terminals', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('/api/terminals', 'POST', { text: 'x'.repeat(30000) })).status, 413);
  const created = await request('/api/terminals', 'POST', { cols: 80, rows: 24 });
  assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal((await request(`/api/terminals/${session.id}`)).status, 200);
  mock.panes[0].inMode = true;
  const inMode = await request(`/api/terminals/${session.id}/input`, 'POST', { key: 'Enter' }, { 'Accept-Language': 'pt' });
  assert.equal(inMode.status, 409);
  assert.deepEqual(await inMode.json(), { errorCode: 'TERMINAL_IN_COPY_MODE', errorParameters: {}, error: 'Este terminal está no modo de cópia. Saia desse modo no terminal do PC antes de enviar comandos.' });
  mock.panes[0].inMode = false;
  assert.deepEqual(await (await request(`/api/terminals/${session.id}/input`, 'POST', { text: 'hello' })).json(), { ok: true });
  assert.equal((await request(`/api/terminals/${session.id}/resize`, 'POST', { cols: 40, rows: 16 })).status, 200);
  assert.equal((await request(`/api/terminals/${session.id}`, 'DELETE')).status, 200);
});

test('real isolated tmux proves Unicode, no implicit execution, resize, reopen and cleanup', async t => {
  if (!await commandExists('tmux')) { t.skip('tmux is not installed'); return; }
  const root = await temporary(t, false);
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_STATE_HOME: path.join(root, 'state'), XDG_RUNTIME_DIR: root, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8', OMARCHY_REMOTE_TEST_ONLY: 'synthetic' };
  const socketPath = path.join(root, 'terminals', 'tmux.sock');
  const terminals = createTerminals(root, { env });
  t.after(async () => {
    await terminals.close();
    await runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', 'kill-server'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(await terminals.list(), { available: true, sessions: [], limit: 4 });
  const session = await terminals.create({ cols: 80, rows: 24 });
  assert.equal(session.inMode, false);
  const saved = JSON.parse(await readFile(path.join(root, 'terminals', 'sessions.json'), 'utf8'));
  const pane = saved.sessions[0].paneId;
  const tmux = args => runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', ...args], { env: { PATH: process.env.PATH, HOME: root } });
  await tmux(['copy-mode', '-t', pane]);
  assert.equal((await terminals.read(session.id)).inMode, true);
  await assert.rejects(terminals.input(session.id, { key: 'Enter' }), { code: 'TERMINAL_IN_COPY_MODE' });
  await tmux(['send-keys', '-X', '-t', pane, 'cancel']);
  assert.equal((await terminals.read(session.id)).inMode, false);
  const inherited = await tmux(['show-environment', '-g']);
  assert.equal(inherited.includes('OMARCHY_REMOTE_TEST_ONLY='), false);
  const marker = path.join(root, 'submitted');
  const text = `printf '%s' 'ação; $literal' > '${marker}'`;
  await terminals.input(session.id, { text });
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.ok((await terminals.read(session.id)).text.includes('ação; $literal'));
  await terminals.input(session.id, { key: 'Enter' });
  for (let tries = 0; tries < 40; tries++) {
    try { if (await readFile(marker, 'utf8') === 'ação; $literal') break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await readFile(marker, 'utf8'), 'ação; $literal');
  await terminals.resize(session.id, { cols: 42, rows: 16 });
  const resized = await terminals.read(session.id);
  assert.equal(resized.cols, 42); assert.equal(resized.rows, 16);
  await terminals.close();
  const reopened = createTerminals(root, { env });
  t.after(() => reopened.close());
  assert.equal((await reopened.list()).sessions[0].id, session.id);
  await reopened.remove(session.id);
  assert.deepEqual((await reopened.list()).sessions, []);
  const replacement = await reopened.create({ cols: 60, rows: 20 });
  assert.notEqual(replacement.id, session.id);
  await reopened.remove(replacement.id);
});

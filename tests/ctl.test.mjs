import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { ApiError, commandExists, runCommand } from '../backend/process.mjs';
import { createTerminals } from '../backend/terminals.mjs';
import { COMMANDS, ACTIONS } from '../bin/ctl-catalog.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'ctl_test_token_with_at_least_thirty_two_characters';
const TERMINAL_ID = 'abcdefabcdefabcdefabcdef';
const AUDIO_ID = '01234567-89ab-4def-8123-456789abcdef';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const AUDIO = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(36, 7)]);
const STATE = {
  hostname: 'isolated-ctl', uptime: 42,
  activeWindow: { address: '0xabc', title: 'Synthetic editor', class: 'editor', monitor: 1, workspace: { id: 6, name: '6' } },
  monitors: [{ id: 1, name: 'TEST-1', width: 800, height: 600, focused: true, activeWorkspace: 6, dpmsStatus: true }],
  workspaces: [{ id: 6, name: '6', monitor: 'TEST-1', windows: 1 }],
  windows: [{ address: '0xabc', title: 'Synthetic editor', class: 'editor', monitor: 1, workspace: { id: 6, name: '6' } }],
  volume: { value: 0.5, muted: false },
  capabilities: { mouse: true, keyboard: true, screenshot: true, audio: true, live: true, lights: true, lock: true },
  warningCodes: [], warnings: [],
  wakeOnLan: { mac: '02:00:00:00:00:01', interface: 'test0', enabled: true },
  power: { wakeOnLan: { mac: '02:00:00:00:00:01', interface: 'test0', enabled: true } },
  session: { locked: true, lockAvailable: true },
  textInput: { available: true, focused: true },
  lights: { preset: 'lava', sleeping: false, presets: ['lava', 'brasa', 'oceano', 'aurora', 'floresta', 'lua'] },
};

// Never inherit the user's config, compositor, ADB serial, token, or runtime
// directory. The subprocess only has a loopback URL and a test-owned token.
async function environment(t, autoClean = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ponte-ctl-test-'));
  const home = path.join(directory, 'home');
  await mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    PONTE_CONFIG: path.join(home, 'missing-config.json'),
    PONTE_NODE: process.execPath,
    LANG: 'C.UTF-8',
  };
  if (autoClean) t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, env };
}

// Async spawn is intentional: a synchronous child would prevent createApp's
// HTTP server in this process from answering any request.
function subprocess(env, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(ROOT, 'ponte'), 'ctl', ...args], {
      cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`ctl killed by ${signal}: ${stderr}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function envelope(result, success = true) {
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { assert.fail(`Expected one JSON document, exit=${result.code}, stdout=${result.stdout}, stderr=${result.stderr}`); }
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.ok, success, result.stdout + result.stderr);
  assert.equal(result.code === 0, success, result.stdout + result.stderr);
  if (success) {
    assert.ok(Object.hasOwn(value, 'data'));
    assert.equal(Object.hasOwn(value, 'error'), false);
  } else {
    assert.equal(typeof value.error.code, 'string');
    assert.ok(value.error.code.length > 0);
    assert.equal(typeof value.error.message, 'string');
    assert.equal(Object.hasOwn(value, 'data'), false);
  }
  return value;
}

async function fixture(t, { realTerminals = false } = {}) {
  const { directory, env } = await environment(t, false);
  const dataDir = path.join(directory, 'data');
  const socketPath = path.join(dataDir, 'terminals', 'tmux.sock');
  const terminalEnv = {
    PATH: process.env.PATH, HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8',
  };
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      // Never use the default tmux server or a session name guessed elsewhere.
      if (realTerminals) await runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', 'kill-server'], { env: terminalEnv }).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
  await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const calls = [], requests = [];
  const audioFile = path.join(directory, 'fixture.ogg');
  await writeFile(audioFile, AUDIO, { mode: 0o600 });
  const recording = { id: AUDIO_ID, name: 'Synthetic recording', createdAt: '2026-01-01T00:00:00Z', size: AUDIO.length, mime: 'audio/ogg' };
  let session = { id: TERMINAL_ID, title: 'Terminal 1', cols: 80, rows: 24, inMode: false, attachCommand: 'synthetic attach command' };
  let text = 'synthetic terminal output\n';
  const controls = { failState: false, missingField: null, actionDelay: 0, actionFinished: Promise.resolve(), actionResult: { ok: true } };
  const record = (kind, value) => calls.push({ kind, value });
  // Desktop/audio/STT/Tailscale always stay synthetic. A single opt-in test
  // below replaces only terminals with a real private tmux socket and shell.
  const desktop = {
    async getState() {
      if (controls.failState) throw new ApiError(503, 'HYPRLAND_UNAVAILABLE');
      const state = structuredClone(STATE);
      if (controls.missingField) delete state[controls.missingField];
      return state;
    },
    async textInputFocused() { return { available: true, focused: true }; },
    async action(value) {
      record('action', value);
      if (controls.actionDelay) {
        controls.actionFinished = new Promise(resolve => setTimeout(resolve, controls.actionDelay));
        await controls.actionFinished;
      }
      return structuredClone(controls.actionResult);
    },
    async screenshot(monitor, scale) { record('screenshot', { monitor, scale }); return JPEG; },
    async prepareLive(options) { record('stream', { monitor: options.monitor, fps: options.fps, scale: options.scale, quality: options.quality, region: options.region }); return { monitor: 'TEST-1', region: null, capture: async () => JPEG }; },
    async close() {},
  };
  const terminals = realTerminals ? createTerminals(dataDir, { env: terminalEnv }) : {
    async list() { return { available: true, sessions: session ? [session] : [], limit: 4 }; },
    async create(value) { record('terminal.create', value); session = { ...session, id: TERMINAL_ID, ...value }; return session; },
    async read(id) { record('terminal.read', { id }); return { ...session, text }; },
    async input(id, value) { record('terminal.input', { id, ...value }); if (value.text) text += value.text; return { ok: true }; },
    async resize(id, value) { record('terminal.resize', { id, ...value }); session = { ...session, ...value }; return { ok: true }; },
    async remove(id) { record('terminal.remove', { id }); session = null; return { ok: true }; },
    async close() {},
  };
  const audio = {
    async list() { return { recordings: [recording] }; },
    async upload(bytes, mime) { record('audio.upload', { bytes: Buffer.from(bytes), mime }); return { ok: true, recording }; },
    async get(id) { record('audio.get', { id }); return { file: audioFile, recording }; },
    async play(id) { record('audio.play', { id }); return { ok: true }; },
    async stop() { record('audio.stop', {}); return { ok: true }; },
    async close() {},
  };
  const transcriber = {
    async available() { return true; },
    async transcribe(bytes, mime) { record('dictate', { bytes: Buffer.from(bytes), mime }); return { text: 'echo olá', provider: 'synthetic' }; },
  };
  app = await createApp({
    dataDir, token: TOKEN, env: {},
    desktop, terminals, audio, transcriber,
    tailnetIdentity: { available: false, authorize: async () => false },
  });
  app.server.on('request', req => requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const tokenFile = path.join(app.dataDir, 'token');
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  const cli = (args, input) => subprocess(env, ['--url', url, '--token-file', tokenFile, '--timeout', '2500', ...args], input);
  return { directory, env, calls, requests, controls, cli, url, tokenFile, audioFile };
}

const ACTION_CASES = [
  ['mouse move', 'mouse.move', { dx: -10, dy: 20 }],
  ['mouse click', 'mouse.click', { button: 'right' }],
  ['mouse click-at', 'mouse.clickAt', { monitor: 'TEST-1', x: 10, y: 20, button: 'left' }],
  ['mouse move-to', 'mouse.moveTo', { monitor: 'TEST-1', x: 10, y: 20 }],
  ['mouse scroll', 'mouse.scroll', { dy: -3 }],
  ['mouse drag', 'mouse.drag', { pressed: false }],
  ['mouse drag-start', 'mouse.dragStartAt', { monitor: 'TEST-1', x: 10, y: 20, modifier: 'super' }],
  ['keyboard text', 'keyboard.text', { text: 'olá 漢字 👋', enter: true }],
  ['keyboard key', 'keyboard.key', { key: 'Copy' }],
  ['workspace focus', 'workspace.focus', { id: 6, monitor: 'TEST-1' }],
  ['window focus', 'window.focus', { address: '0xabc' }],
  ['window move', 'window.moveToWorkspace', { address: '0xabc', id: 7 }],
  ['volume set', 'volume.set', { value: 0.25 }],
  ['volume mute', 'volume.mute', {}],
  ['media toggle', 'media.toggle', {}],
  ['media next', 'media.next', {}],
  ['media previous', 'media.previous', {}],
  ['app launch', 'app.launch', { app: 'terminal' }],
  ['monitors set', 'power.dpms', { monitor: 'TEST-1', state: 'off' }],
  ['monitors all', 'power.dpms_all', { enabled: false }],
  ['power sleep', 'power.sleep', {}],
  ['power wake', 'power.wake', {}],
  ['power suspend', 'power.suspend', {}],
  ['power reboot', 'power.reboot', {}],
  ['power off', 'power.off', {}],
  ['lights preset', 'lights.preset', { preset: 'aurora' }],
  ['lights sleep', 'lights.sleep', {}],
  ['lights restore', 'lights.restore', {}],
  ['lights reapply', 'lights.reapply', {}],
  ['lights screen', 'lights.screen', { enabled: false }],
  ['session lock', 'session.lock', {}],
  ['session unlock', 'session.unlock', { password: 'synthetic password!' }],
];
const flags = params => Object.entries(params).flatMap(([name, value]) => [`--${name}`, String(value)]);
const redact = body => Object.fromEntries(Object.entries(body).map(([key, value]) => [key, ['text', 'password'].includes(key) ? '[REDACTED]' : value]));

test('ctl help, schema and version work offline without private configuration or credentials', async t => {
  const { env } = await environment(t);
  const help = await subprocess(env, ['help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /Usage: ponte ctl/); assert.equal(help.stderr, '');
  assert.match(help.stdout, /--dry-run/); assert.match(help.stdout, /--yes/);
  const schema = envelope(await subprocess(env, ['schema'])).data;
  assert.ok(schema.legacy.includes('desktop'), 'agent discovery must include the companion entry point');
  assert.deepEqual(schema.commands.map(c => c.name), COMMANDS.map(c => c.name));
  assert.deepEqual(envelope(await subprocess(env, ['schema', 'mouse', 'click-at'])).data.commands.map(c => c.name), ['mouse click-at']);
  const jsonHelp = envelope(await subprocess(env, ['help', '--json'])).data;
  assert.equal(jsonHelp.commands.length, schema.commands.length);
  const actionHelp = await subprocess(env, ['help', 'action', 'power.off']);
  assert.equal(actionHelp.code, 0); assert.match(actionHelp.stdout, /power\.off/);
  const actionSchema = envelope(await subprocess(env, ['schema', 'action', 'power.off'])).data;
  assert.ok(JSON.stringify(actionSchema).includes('power.off'));
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(envelope(await subprocess(env, ['version'])).data.version, pkg.version);
  const pretty = await subprocess(env, ['--pretty', 'version']);
  envelope(pretty); assert.match(pretty.stdout, /\n  "schemaVersion": 1,/);
  envelope(await subprocess(env, ['definitely-not-a-command']), false);
});

test('ctl config exposes only allowlisted settings and never includes private key paths or unknown secrets', async t => {
  const { directory, env } = await environment(t);
  const password = 'private-config-password-must-not-appear';
  const privateKey = path.join(directory, 'private-signing-key.pem');
  const certificate = path.join(directory, 'server-certificate.pem');
  const ca = path.join(directory, 'installation-ca.pem');
  const dataDir = path.join(directory, 'private-data');
  await writeFile(env.PONTE_CONFIG, JSON.stringify({
    schemaVersion: 1, dataDir, http: { host: '127.0.0.1', port: 9876 },
    trustedHosts: ['not-exposed.example.test'],
    nativeTls: { host: '100.80.90.100', port: 9877, certFile: certificate, keyFile: privateKey, caFile: ca },
    password, unknown: { password, token: TOKEN },
  }), { mode: 0o600 });
  const result = await subprocess(env, ['config']);
  assert.deepEqual(envelope(result).data, {
    configFile: env.PONTE_CONFIG, dataDir, http: { host: '127.0.0.1', port: 9876 },
    nativeTls: { host: '100.80.90.100', port: 9877, caFile: ca },
  });
  for (const secret of [password, privateKey, certificate, TOKEN, 'keyFile', 'password', 'unknown', 'not-exposed.example.test']) {
    assert.equal((result.stdout + result.stderr).includes(secret), false, secret);
  }
});

test('ctl malformed config returns CONFIG_ERROR exit 2 without echoing JSON secret contents', async t => {
  const { env } = await environment(t);
  const secret = 'CONFIG_SECRET_MUST_NEVER_ESCAPE';
  // JSON.parse's own diagnostic includes the input near the failure. ctl must
  // replace that diagnostic rather than reflecting private config contents.
  await writeFile(env.PONTE_CONFIG, secret, { mode: 0o600 });
  const result = await subprocess(env, ['config']);
  const error = envelope(result, false).error;
  assert.equal(result.code, 2); assert.equal(error.code, 'CONFIG_ERROR');
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  assert.equal(Object.hasOwn(error, 'status'), false);
});

test('ctl catalog and explicit test cases cover every desktop action and alias', async () => {
  const source = await readFile(path.join(ROOT, 'backend/desktop.mjs'), 'utf8');
  const actions = [...source.matchAll(/case '([^']+)'\s*:/g)].map(match => match[1]);
  assert.deepEqual([...ACTIONS.keys()].sort(), actions.sort());
  assert.deepEqual(ACTION_CASES.map(([, type]) => type).sort(), COMMANDS.filter(c => c.action).map(c => c.action).sort());
  assert.equal(new Set(COMMANDS.map(c => c.name)).size, COMMANDS.length);
});

test('ctl dry-run validates every named action and all server aliases without network or credentials', async t => {
  const { env } = await environment(t);
  for (const [name, type, params] of ACTION_CASES) {
    const unlock = type === 'session.unlock';
    const args = ['--url', 'http://127.0.0.1:1', '--token-file', '/missing/token', '--ca-file', '/missing/ca', '--dry-run', ...name.split(' '), ...(unlock ? ['--stdin'] : flags(params))];
    const result = await subprocess(env, args, unlock ? params.password : '');
    const plan = envelope(result).data;
    assert.equal(plan.method, 'POST', name); assert.equal(plan.path, '/api/action', name);
    assert.equal(plan.dryRun, true); assert.deepEqual(plan.body, redact({ type, ...params }), name);
    assert.equal(plan.requiresConfirmation, !!ACTIONS.get(type).confirm, name);
    if (unlock) assert.equal((result.stdout + result.stderr).includes(params.password), false);
    for (const alias of ACTIONS.get(type).aliases || []) {
      const generic = envelope(await subprocess(env, ['--dry-run', 'action', alias, '--data', JSON.stringify(params)])).data;
      assert.deepEqual(generic.body, { type: alias, ...params });
      assert.equal(generic.requiresConfirmation, !!ACTIONS.get(alias).confirm);
    }
  }
});

test('ctl authenticated queries return the selected JSON fields and unauthenticated health omits the token', async t => {
  const f = await fixture(t);
  const health = envelope(await f.cli(['health'])).data;
  assert.equal(health.name, 'Ponte'); assert.equal(f.requests.at(-1).authorization, undefined);
  assert.equal(envelope(await f.cli(['state'])).data.hostname, STATE.hostname);
  for (const name of ['windows', 'workspaces', 'monitors', 'volume', 'lights', 'session']) {
    assert.deepEqual(envelope(await f.cli([name])).data, STATE[name], name);
  }
  const capabilities = envelope(await f.cli(['capabilities'])).data;
  assert.equal(typeof capabilities.rd, 'boolean');
  assert.deepEqual(capabilities, { ...STATE.capabilities, stt: true, rd: capabilities.rd });
  assert.deepEqual(envelope(await f.cli(['textinput'])).data, STATE.textInput);
  assert.deepEqual(envelope(await f.cli(['power'])).data, { monitors: STATE.monitors, power: STATE.power, wakeOnLan: STATE.wakeOnLan });
  assert.equal(envelope(await f.cli(['terminals', 'list'])).data.sessions[0].id, TERMINAL_ID);
  assert.equal(envelope(await f.cli(['audio', 'list'])).data.recordings[0].id, AUDIO_ID);
  assert.ok(f.requests.slice(1).every(req => req.authorization === `Bearer ${TOKEN}`));
});

test('ctl sends every named action to the real router with only synthetic effects', async t => {
  const f = await fixture(t);
  for (const [name, type, params] of ACTION_CASES) {
    const unlock = type === 'session.unlock';
    const args = [...name.split(' '), ...(unlock ? ['--stdin'] : flags(params)), ...(ACTIONS.get(type).confirm ? ['--yes'] : [])];
    const result = await f.cli(args, unlock ? params.password : '');
    assert.deepEqual(envelope(result).data, { ok: true }, name);
    assert.deepEqual(f.calls.at(-1), { kind: 'action', value: { type, ...params } }, name);
    assert.equal(result.stdout.includes(TOKEN), false);
    if (unlock) assert.equal((result.stdout + result.stderr).includes(params.password), false);
  }
  for (const [alias, descriptor] of ACTIONS) {
    if (alias === descriptor.action) continue;
    const params = ACTION_CASES.find(([, type]) => type === descriptor.action)[2];
    envelope(await f.cli(['action', alias, '--data', JSON.stringify(params), ...(descriptor.confirm ? ['--yes'] : [])]));
    assert.deepEqual(f.calls.at(-1), { kind: 'action', value: { type: alias, ...params } });
  }
});

test('ctl confirmation blocks destructive named and generic commands before requests', async t => {
  const f = await fixture(t);
  const commands = [
    ['power', 'off'], ['power', 'reboot'], ['power', 'suspend'], ['terminals', 'remove', '--id', TERMINAL_ID],
    ...['power.off', 'power.poweroff', 'power.reboot', 'power.suspend'].map(type => ['action', type, '--data', '{}']),
  ];
  for (const args of commands) {
    const result = await f.cli(args);
    assert.equal(envelope(result, false).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(result.code, 2);
    const plan = envelope(await f.cli(['--dry-run', ...args])).data;
    assert.equal(plan.requiresConfirmation, true);
  }
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
  envelope(await f.cli(['terminals', 'remove', '--id', TERMINAL_ID, '--yes']));
  assert.deepEqual(f.calls, [{ kind: 'terminal.remove', value: { id: TERMINAL_ID } }]);
});

test('ctl generic safety rejects confirmation and secret sources before reading missing files', async t => {
  const { directory, env } = await environment(t);
  const missing = path.join(directory, 'file-must-not-be-read.json');
  const off = await subprocess(env, ['action', 'power.off', '--file', missing]);
  assert.equal(envelope(off, false).error.code, 'CONFIRMATION_REQUIRED'); assert.equal(off.code, 2);
  const unlock = await subprocess(env, ['action', 'session.unlock', '--file', missing, '--dry-run']);
  const error = envelope(unlock, false).error;
  assert.equal(error.code, 'USAGE'); assert.equal(unlock.code, 2);
  assert.match(error.message, /stdin/i);
});

test('ctl rejects unknown fields, mismatched JSON types, ambiguous input and invalid bounds before I/O', async t => {
  const f = await fixture(t);
  const invalid = [
    ['mouse', 'move', '--dx', '1001', '--dy', '0'],
    ['mouse', 'click-at', '--monitor', 'TEST-1', '--x', '1.5', '--y', '2', '--button', 'left'],
    ['keyboard', 'key', '--key', 'F24'],
    ['workspace', 'focus', '--id', '0'],
    ['window', 'focus', '--address', '0xabc;bad'],
    ['media', 'next', '--unexpected', '1'],
    ['volume', 'set', '--value', 'NaN'],
    ['monitors', 'set', '--monitor', 'TEST-1'],
    ['monitors', 'all', '--enabled', 'false', '--state', 'on'],
    ['mouse', 'drag', '--pressed', 'maybe'],
    ['state', '--timeout', '0'],
    ['state', '--pretty', '--pretty'],
    ['stream', '--output', path.join(f.directory, 'never.mjpeg'), '--x', '0'],
    ['screenshot', '--output', '-'],
    ['action', 'media.next', '--data', '{'],
    ['action', 'media.next', '--data', '[]'],
    ['action', 'media.next', '--data', '{"type":"media.previous"}'],
    ['action', 'media.next', '--data', '{"extra":true}'],
    ['action', 'mouse.move', '--data', '{"dx":"1","dy":0}'],
    ['action', 'keyboard.text', '--data', '{"text":"hello","enter":"true"}'],
    ['action', 'keyboard.text', '--stdin', '--data', '{}'],
    ['keyboard', 'text', '--text', 'hello', '--stdin'],
    ['session', 'unlock', '--password', 'never-echo-this'],
    ['action', 'session.unlock', '--data', '{"password":"never-echo-this"}'],
  ];
  for (const args of invalid) {
    const result = await f.cli(args);
    envelope(result, false);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal((result.stdout + result.stderr).includes('never-echo-this'), false);
  }
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
});

test('ctl text sources preserve Unicode, default to no Enter, redact dry-run, and keep passwords off output', async t => {
  const f = await fixture(t);
  const text = '-n olá 漢字 👋';
  const file = path.join(f.directory, 'line.txt');
  await writeFile(file, text, { mode: 0o600 });
  for (const source of [['--stdin'], ['--file', file]]) {
    envelope(await f.cli(['keyboard', 'text', ...source], text));
    assert.deepEqual(f.calls.at(-1).value, { type: 'keyboard.text', text, enter: false });
    envelope(await f.cli(['terminals', 'input', '--id', TERMINAL_ID, ...source], text));
    assert.deepEqual(f.calls.at(-1), { kind: 'terminal.input', value: { id: TERMINAL_ID, text, enter: false } });
  }
  envelope(await f.cli(['keyboard', 'text', `--text=${text}`, '--enter']));
  assert.equal(f.calls.at(-1).value.enter, true);
  envelope(await f.cli(['terminals', 'input', '--id', TERMINAL_ID, '--stdin', '--enter'], `${text}\n`));
  assert.deepEqual(f.calls.at(-1).value, { id: TERMINAL_ID, text, enter: true });
  const before = f.requests.length;
  const plan = await f.cli(['--dry-run', 'keyboard', 'text', '--stdin'], text);
  assert.equal(envelope(plan).data.body.text, '[REDACTED]'); assert.equal(plan.stdout.includes(text), false);
  const secret = 'local fake password';
  const secretPlan = await f.cli(['--dry-run', 'action', 'session.unlock', '--stdin'], JSON.stringify({ password: secret }));
  assert.equal(envelope(secretPlan).data.body.password, '[REDACTED]'); assert.equal(secretPlan.stdout.includes(secret), false);
  assert.equal(f.requests.length, before);
  const unlock = await f.cli(['action', 'session.unlock', '--stdin'], JSON.stringify({ password: secret }));
  envelope(unlock); assert.equal((unlock.stdout + unlock.stderr).includes(secret), false);
  assert.deepEqual(f.calls.at(-1).value, { type: 'session.unlock', password: secret });
  const jsonFile = path.join(f.directory, 'action.json');
  await writeFile(jsonFile, '{"type":"volume.set","value":0.75}');
  envelope(await f.cli(['action', 'volume.set', '--file', jsonFile]));
  assert.deepEqual(f.calls.at(-1).value, { type: 'volume.set', value: 0.75 });
});

test('ctl terminal lifecycle uses opaque IDs, expected paths and explicit key or execution flags', async t => {
  const f = await fixture(t);
  const created = envelope(await f.cli(['terminals', 'create'])).data;
  assert.equal(created.id, TERMINAL_ID);
  assert.deepEqual(f.calls.at(-1), { kind: 'terminal.create', value: { cols: 80, rows: 24 } });
  assert.equal(envelope(await f.cli(['terminals', 'read', '--id', TERMINAL_ID])).data.text, 'synthetic terminal output\n');
  envelope(await f.cli(['terminals', 'key', '--id', TERMINAL_ID, '--key', 'Interrupt']));
  assert.deepEqual(f.calls.at(-1), { kind: 'terminal.input', value: { id: TERMINAL_ID, key: 'Interrupt' } });
  envelope(await f.cli(['terminals', 'resize', '--id', TERMINAL_ID, '--cols', '120', '--rows', '40']));
  assert.deepEqual(f.calls.at(-1), { kind: 'terminal.resize', value: { id: TERMINAL_ID, cols: 120, rows: 40 } });
  const before = f.requests.length;
  envelope(await f.cli(['terminals', 'read', '--id', '../other']), false);
  envelope(await f.cli(['terminals', 'input', '--id', TERMINAL_ID, '--stdin'], 'first\nsecond'), false);
  assert.equal(f.requests.length, before);
});

test('ctl uploads audio and transcribes safely, with terminal Enter disabled unless explicitly requested', async t => {
  const f = await fixture(t);
  const uploaded = envelope(await f.cli(['audio', 'upload', '--file', f.audioFile])).data;
  assert.equal(uploaded.recording.id, AUDIO_ID);
  assert.deepEqual(f.calls.at(-1), { kind: 'audio.upload', value: { bytes: AUDIO, mime: 'audio/ogg' } });
  const transcript = envelope(await f.cli(['dictate', '--file', f.audioFile, '--mime', 'audio/ogg'])).data;
  assert.equal(transcript.text, 'echo olá'); assert.equal(transcript.provider, 'synthetic');
  assert.equal(f.calls.some(call => call.kind === 'terminal.input'), false);
  const typed = envelope(await f.cli(['terminals', 'dictate', '--id', TERMINAL_ID, '--file', f.audioFile])).data;
  assert.equal(typed.entered, false); assert.match(f.requests.at(-1).path, /\?enter=0$/);
  assert.deepEqual(f.calls.at(-1), { kind: 'terminal.input', value: { id: TERMINAL_ID, text: 'echo olá' } });
  const entered = envelope(await f.cli(['terminals', 'dictate', '--id', TERMINAL_ID, '--file', f.audioFile, '--enter'])).data;
  assert.equal(entered.entered, true); assert.match(f.requests.at(-1).path, /\?enter=1$/);
  assert.deepEqual(f.calls.at(-1), { kind: 'terminal.input', value: { id: TERMINAL_ID, key: 'Enter' } });
  envelope(await f.cli(['audio', 'play', '--id', AUDIO_ID]));
  assert.deepEqual(f.calls.at(-1), { kind: 'audio.play', value: { id: AUDIO_ID } });
  envelope(await f.cli(['audio', 'stop']));
  assert.equal(f.calls.at(-1).kind, 'audio.stop');
  const before = f.requests.length;
  const missing = path.join(f.directory, 'nonexistent.ogg');
  assert.equal(envelope(await f.cli(['--dry-run', 'audio', 'upload', '--file', missing])).data.body.file, missing);
  await writeFile(path.join(f.directory, 'invalid.ogg'), 'not audio');
  envelope(await f.cli(['audio', 'upload', '--file', path.join(f.directory, 'invalid.ogg')]), false);
  assert.equal(f.requests.length, before);
});

test('ctl screenshot, audio download and bounded MJPEG stream keep stdout JSON and artifacts private', async t => {
  const f = await fixture(t);
  const screenshot = path.join(f.directory, 'shot.jpg');
  const shot = envelope(await f.cli(['screenshot', '--monitor', 'TEST-1', '--scale', '1', '--output', screenshot])).data;
  assert.equal(shot.output, screenshot); assert.equal(shot.bytes, JPEG.length); assert.equal(shot.contentType, 'image/jpeg');
  assert.deepEqual(await readFile(screenshot), JPEG);
  assert.deepEqual(f.calls.at(-1), { kind: 'screenshot', value: { monitor: 'TEST-1', scale: 1 } });
  const audioPath = path.join(f.directory, 'download.ogg');
  const audio = envelope(await f.cli(['audio', 'download', '--id', AUDIO_ID, '--output', audioPath])).data;
  assert.equal(audio.bytes, AUDIO.length); assert.equal(audio.contentType, 'audio/ogg');
  assert.deepEqual(await readFile(audioPath), AUDIO);
  const streamPath = path.join(f.directory, 'stream.mjpeg');
  const stream = envelope(await f.cli(['stream', '--monitor', 'TEST-1', '--fps', '20', '--quality', '70', '--scale', '1', '--x', '10', '--y', '20', '--w', '40', '--h', '30', '--seconds', '0.15', '--output', streamPath])).data;
  const bytes = await readFile(streamPath);
  assert.equal(stream.durationMs, 150); assert.equal(stream.bytes, bytes.length);
  assert.match(stream.contentType, /^multipart\/x-mixed-replace/);
  assert.ok(bytes.includes(JPEG)); assert.match(bytes.toString('latin1'), /--ponte-frame\r\nContent-Type: image\/jpeg/);
  assert.deepEqual(f.calls.at(-1), { kind: 'stream', value: { monitor: 'TEST-1', fps: 20, scale: 1, quality: 70, region: { x: 10, y: 20, w: 40, h: 30 } } });
  for (const file of [screenshot, audioPath, streamPath]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  const existing = envelope(await f.cli(['screenshot', '--output', screenshot]), false);
  assert.equal(existing.error.code, 'OUTPUT_EXISTS'); assert.deepEqual(await readFile(screenshot), JPEG);
});

test('ctl exposes stable API errors and authentication failures without leaking credentials', async t => {
  const f = await fixture(t);
  f.controls.failState = true;
  const failed = await f.cli(['state']);
  const error = envelope(failed, false).error;
  assert.equal(error.code, 'HYPRLAND_UNAVAILABLE'); assert.equal(error.status, 503); assert.equal(failed.code, 6);
  const wrongFile = path.join(f.directory, 'wrong-token');
  const wrongToken = 'this_is_not_the_expected_token_but_is_valid';
  await writeFile(wrongFile, wrongToken, { mode: 0o600 });
  const unauthenticated = await subprocess(f.env, ['--url', f.url, '--token-file', wrongFile, 'state']);
  const auth = envelope(unauthenticated, false).error;
  assert.equal(auth.code, 'PAIRING_REQUIRED'); assert.equal(auth.status, 401); assert.equal(unauthenticated.code, 5);
  assert.equal((unauthenticated.stdout + unauthenticated.stderr).includes(wrongToken), false);
  const health = await subprocess(f.env, ['--url', f.url, '--token-file', '/missing/ignored-token', 'health']);
  assert.equal(envelope(health).data.name, 'Ponte');
});

test('ctl mutation timeout reports an uncertain outcome and never retries the action', async t => {
  const f = await fixture(t);
  f.controls.actionDelay = 350;
  const result = await subprocess(f.env, ['--url', f.url, '--token-file', f.tokenFile, '--timeout', '100', 'volume', 'set', '--value', '0.5']);
  const error = envelope(result, false).error;
  assert.equal(error.code, 'TIMEOUT'); assert.equal(result.code, 4);
  assert.match(error.message, /may have reached the server/);
  assert.match(error.message, /Inspect state before retrying/);
  await f.controls.actionFinished;
  assert.deepEqual(f.calls, [{ kind: 'action', value: { type: 'volume.set', value: 0.5 } }]);
  assert.equal(f.requests.filter(request => request.path === '/api/action').length, 1);
});

test('ctl missing selected response field is INVALID_RESPONSE instead of a success without data', async t => {
  const f = await fixture(t);
  f.controls.missingField = 'volume';
  const result = await f.cli(['volume']);
  const error = envelope(result, false).error;
  assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(result.code, 6);
});

test('ctl preserves action-specific response fields instead of reducing replies to ok', async t => {
  const f = await fixture(t);
  for (const [args, data] of [
    [['mouse', 'drag-start', '--monitor', 'TEST-1', '--x', '10', '--y', '20'], { ok: true, window: { address: '0xabc', title: 'Synthetic window' } }],
    [['mouse', 'drag-start', '--monitor', 'TEST-1', '--x', '10', '--y', '20'], { ok: true, window: null }],
    [['window', 'move', '--address', '0xabc', '--id', '7'], { ok: true, moved: true, workspace: 7 }],
    [['action', 'window.moveToWorkspace', '--data', '{"address":"0xabc","id":7}'], { ok: true, moved: false, workspace: 7 }],
  ]) {
    f.controls.actionResult = data;
    assert.deepEqual(envelope(await f.cli(args)).data, data);
  }
});

test('ctl real isolated tmux completes create, execute, observe, resize and remove without the human desktop', async t => {
  if (!await commandExists('tmux')) { t.skip('tmux is not installed'); return; }
  const f = await fixture(t, { realTerminals: true });
  assert.deepEqual(envelope(await f.cli(['terminals', 'list'])).data.sessions, []);
  const session = envelope(await f.cli(['terminals', 'create', '--cols', '80', '--rows', '24'])).data;
  assert.match(session.id, /^[a-f0-9]{24}$/);
  const privateSocket = path.join(f.directory, 'data', 'terminals', 'tmux.sock');
  assert.ok(session.attachCommand.includes(privateSocket));
  assert.ok((await stat(privateSocket)).isSocket());
  // The complete sentinel is absent from the command text, so seeing it in
  // capture-pane proves execution, not merely terminal echo of pasted input.
  const sentinel = 'CTL_REAL_TMUX_ação_漢字';
  const command = "printf '%s%s\\n' 'CTL_REAL_' 'TMUX_ação_漢字'";
  assert.equal(command.includes(sentinel), false);
  envelope(await f.cli(['terminals', 'input', '--id', session.id, '--stdin', '--enter'], command));
  let view;
  for (let attempt = 0; attempt < 20; attempt++) {
    view = envelope(await f.cli(['terminals', 'read', '--id', session.id])).data;
    if (view.text.split('\n').some(line => line.trim() === sentinel)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(view.text.split('\n').some(line => line.trim() === sentinel), view.text);
  envelope(await f.cli(['terminals', 'resize', '--id', session.id, '--cols', '100', '--rows', '30']));
  const resized = envelope(await f.cli(['terminals', 'read', '--id', session.id])).data;
  assert.equal(resized.cols, 100); assert.equal(resized.rows, 30);
  envelope(await f.cli(['terminals', 'remove', '--id', session.id, '--yes']));
  assert.deepEqual(envelope(await f.cli(['terminals', 'list'])).data.sessions, []);
  const registry = JSON.parse(await readFile(path.join(f.directory, 'data', 'terminals', 'sessions.json'), 'utf8'));
  assert.deepEqual(registry.sessions, []);
  assert.equal(f.calls.length, 0, 'no desktop, audio, transcription or synthetic terminal action was used');
});

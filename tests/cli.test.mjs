import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir, chmod, symlink } from 'node:fs/promises';
import { defaultPaths, loadSettings, runtimeSettings } from '../backend/config.mjs';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ponte-cli-test-'));
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  await mkdir(home); await mkdir(bin);
  const log = path.join(directory, 'commands.log');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), PATH: `${bin}:${process.env.PATH}`, PONTE_TEST_LOG: log };
  const stub = `#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ['PONTE_TEST_LOG'],'a') as f: f.write(json.dumps([os.path.basename(sys.argv[0])]+sys.argv[1:])+'\\n')\nif os.path.basename(sys.argv[0])=='tailscale':\n if sys.argv[1:]==['ip','-4']: print('100.80.90.100')\n elif sys.argv[1:]==['status','--json']: print(json.dumps({'Self':{'DNSName':'test-pc.example.ts.net.'}}))\nif os.environ.get('PONTE_TEST_FAIL_SYSTEMCTL') and os.path.basename(sys.argv[0])=='systemctl': sys.exit(1)\n`;
  for (const name of ['tailscale', 'systemctl', 'ydotoold']) await writeFile(path.join(bin, name), stub, { mode: 0o755 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = (args, extraEnv = {}) => run('python3', [path.join(root, 'ponte'), ...args], { env: { ...env, ...extraEnv }, timeout: 15000 });
  const configFile = path.join(env.XDG_CONFIG_HOME, 'ponte/config.json');
  const dataDir = path.join(env.XDG_STATE_HOME, 'ponte');
  return { directory, home, bin, env, log, cli, configFile, dataDir };
}

test('local-only setup is private, idempotent, uses XDG paths and starts no service', async t => {
  const f = await fixture(t);
  const output = await f.cli(['setup', '--local-only', '--http-port', '9876']);
  const configText = await readFile(f.configFile, 'utf8');
  const config = JSON.parse(configText);
  const token = await readFile(path.join(f.dataDir, 'token'), 'utf8');
  assert.equal(config.schemaVersion, 1); assert.equal(config.dataDir, f.dataDir);
  assert.deepEqual(config.http, { host: '127.0.0.1', port: 9876 }); assert.equal(config.nativeTls, null);
  assert.match(token.trim(), /^[a-zA-Z0-9_-]{43}$/); assert.equal(output.stdout.includes(token.trim()), false);
  for (const file of [f.configFile, path.join(f.dataDir, 'token')]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700);
  await assert.rejects(readFile(f.log), error => error.code === 'ENOENT');
  await f.cli(['setup', '--local-only']);
  assert.equal(await readFile(f.configFile, 'utf8'), configText);
  assert.equal(await readFile(path.join(f.dataDir, 'token'), 'utf8'), token);
  const settings = await loadSettings(f.env);
  assert.deepEqual(settings.http, config.http); assert.equal(settings.nativeTls, null);
  assert.equal(settings.dataDir, f.dataDir);
  const paired = await f.cli(['pair']); assert.equal(paired.stdout.trim(), token.trim());
  const link = await f.cli(['pair', '--url', 'http://127.0.0.1:9876']);
  assert.equal(link.stdout.trim(), `http://127.0.0.1:9876/#pair=${token.trim()}`);
  await assert.rejects(f.cli(['pair', '--url', 'http://remote.example']), error => /require HTTPS/.test(error.stderr));
});

test('setup detects a mock Tailscale IP and generates an installation-specific CA and SAN leaf outside the repo', async t => {
  const f = await fixture(t);
  await f.cli(['setup']);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(config.nativeTls.host, '100.80.90.100'); assert.equal(config.nativeTls.port, 8788);
  assert.deepEqual(config.trustedHosts, ['100.80.90.100:8788', 'test-pc.example.ts.net']);
  for (const name of ['certFile', 'keyFile', 'caFile']) {
    assert.equal(config.nativeTls[name].startsWith(`${f.env.XDG_CONFIG_HOME}/ponte/tls/`), true);
    assert.equal((await stat(config.nativeTls[name])).mode & 0o777, 0o600);
  }
  const ca = await readFile(config.nativeTls.caFile, 'utf8');
  const leaf = await readFile(config.nativeTls.certFile, 'utf8'); assert.notEqual(ca, leaf);
  await run('openssl', ['verify', '-CAfile', config.nativeTls.caFile, '-verify_ip', '100.80.90.100', config.nativeTls.certFile]);
  await assert.rejects(run('openssl', ['verify', '-CAfile', config.nativeTls.caFile, '-verify_ip', '100.80.90.101', config.nativeTls.certFile]));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['tailscale', 'ip', '-4'], ['tailscale', 'status', '--json']]);
  const settings = await loadSettings(f.env); assert.deepEqual(settings.nativeTls, config.nativeTls);
  const sanitized = JSON.parse((await f.cli(['android-config'])).stdout);
  assert.deepEqual(sanitized, { schemaVersion: 1, upstream: 'https://100.80.90.100:8788', certificatePath: config.nativeTls.certFile, caPath: config.nativeTls.caFile });
  assert.equal(JSON.stringify(sanitized).includes('keyFile'), false);
  await f.cli(['setup']); assert.equal(await readFile(config.nativeTls.certFile, 'utf8'), leaf);
});

test('CLI rejects ambiguous/outside Tailscale IPs before creating credentials', async t => {
  const f = await fixture(t);
  for (const address of ['100.064.1.2', '127.0.0.1', '0.0.0.0', '100.128.1.2', '100.64.0.1; touch anything']) {
    await assert.rejects(f.cli(['setup', '--tailscale-ip', address]));
  }
  await assert.rejects(readFile(path.join(f.dataDir, 'token')), error => error.code === 'ENOENT');
  await assert.rejects(readFile(f.log), error => error.code === 'ENOENT');
});

test('install resolves tools from PATH; uninstall only removes managed units and preserves private state', async t => {
  const f = await fixture(t); await f.cli(['setup', '--local-only']);
  const token = await readFile(path.join(f.dataDir, 'token'), 'utf8');
  await f.cli(['install']);
  const units = path.join(f.env.XDG_CONFIG_HOME, 'systemd/user');
  const remote = path.join(units, 'ponte-remote.service');
  const input = path.join(units, 'ponte-input.service');
  const content = await readFile(remote, 'utf8');
  assert.match(content, /^# Managed by Ponte/); assert.ok(content.includes(f.configFile)); assert.match(content, /TimeoutStopSec=20/);
  assert.ok((await readFile(input, 'utf8')).includes(path.join(f.bin, 'ydotoold')));
  await assert.rejects(f.cli(['uninstall'], { PONTE_TEST_FAIL_SYSTEMCTL: '1' }));
  assert.equal(await readFile(remote, 'utf8'), content, 'failed stop must preserve unit files');
  await f.cli(['uninstall']); assert.deepEqual(await readdir(units), []);
  assert.equal(await readFile(path.join(f.dataDir, 'token'), 'utf8'), token);
  await f.cli(['uninstall']);
  await writeFile(remote, '[Service]\nExecStart=/bin/false\n');
  await assert.rejects(f.cli(['uninstall']), error => /unmanaged/.test(error.stderr));
  assert.match(await readFile(remote, 'utf8'), /ExecStart/);
});

test('configuration rejects public permissions, symlinks, relative paths and plaintext remote binds', async t => {
  const f = await fixture(t); await f.cli(['setup', '--local-only']);
  await chmod(f.configFile, 0o644);
  await assert.rejects(loadSettings(f.env), /private/);
  await assert.rejects(f.cli(['setup', '--local-only']), error => /private/.test(error.stderr));
  await chmod(f.configFile, 0o600);
  const alias = path.join(f.directory, 'config-alias'); await symlink(f.configFile, alias);
  await assert.rejects(loadSettings({ ...f.env, PONTE_CONFIG: alias }), /private/);
  assert.throws(() => defaultPaths({ HOME: f.home, XDG_STATE_HOME: 'relative' }), /absolute/);
  assert.throws(() => runtimeSettings({ http: { host: '0.0.0.0' } }, f.env), /loopback/);
  for (const value of [0, -1, 65536, '8787', true]) assert.throws(() => runtimeSettings({ http: { port: value } }, f.env), /port/);
  assert.throws(() => runtimeSettings({}, { ...f.env, OMARCHY_REMOTE_BIND: '0.0.0.0' }), /loopback/);
  const defaults = defaultPaths({ HOME: f.home });
  assert.equal(defaults.configFile, path.join(f.home, '.config/ponte/config.json'));
  assert.equal(defaults.dataDir, path.join(f.home, '.local/state/ponte'));
});

const python3 = (await run('/bin/sh', ['-c', 'command -v python3'])).stdout.trim();
const phoneStub = `#!${python3}
import json, os, sys
name = os.path.basename(sys.argv[0])
with open(os.environ['PONTE_TEST_LOG'], 'a') as f:
    f.write(json.dumps([name] + sys.argv[1:]) + '\\n')
fail = os.environ.get('PONTE_TEST_ADB_FAIL')
if name == 'adb':
    if sys.argv[1:2] == ['connect']:
        if fail == 'connect':
            sys.stderr.write("failed to connect to '%s'\\n" % sys.argv[2]); sys.exit(1)
        print('connected to ' + sys.argv[2])
    elif sys.argv[1:2] == ['pair']:
        if fail == 'pair':
            sys.stderr.write('Failed: Wrong pairing code.\\n'); sys.exit(1)
        print('Successfully paired to ' + sys.argv[2])
    elif sys.argv[1] == 'devices':
        print('List of devices attached')
        serial = os.environ.get('PONTE_TEST_ADB_DEVICE')
        if serial:
            print(serial + '\\tdevice')
elif name == 'scrcpy':
    if fail == 'scrcpy':
        sys.exit(1)
elif name == 'tailscale':
    if sys.argv[1:] == ['status', '--json']:
        online = os.environ.get('PONTE_TEST_TS_ONLINE', '1') == '1'
        print(json.dumps({'Peer': {'phone': {'Online': online, 'TailscaleIPs': ['100.111.221.82']}}}))
`;

async function phoneFixture(t, { tools = ['adb', 'scrcpy', 'tailscale'] } = {}) {
  const f = await fixture(t);
  for (const name of tools) await writeFile(path.join(f.bin, name), phoneStub, { mode: 0o755 });
  const cli = (args, extraEnv = {}) => run(python3, [path.join(root, 'ponte'), ...args], {
    env: { ...f.env, PATH: f.bin, ...extraEnv }, timeout: 15000,
  });
  return { ...f, cli };
}

test('phone status reports missing adb and scrcpy without launching them', async t => {
  const f = await phoneFixture(t, { tools: ['tailscale'] });
  const result = await f.cli(['phone', 'status']);
  assert.match(result.stdout, /adb: no — install with: pacman -S android-tools/);
  assert.match(result.stdout, /scrcpy: no — install with: pacman -S scrcpy/);
  assert.match(result.stdout, /100\.111\.221\.82:5555/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['tailscale', 'status', '--json']]);
});

test('phone connect uses the default Tailscale address, saves it, and fails clearly when the phone is offline', async t => {
  const f = await phoneFixture(t);
  await f.cli(['setup', '--local-only']);
  const ok = await f.cli(['phone', 'connect']);
  assert.match(ok.stdout, /Connected to 100\.111\.221\.82:5555/);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(config.phone.address, '100.111.221.82:5555');
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'phone.json'), 'utf8')).address, '100.111.221.82:5555');
  await assert.rejects(f.cli(['phone', 'connect', '100.111.221.82:44875'], { PONTE_TEST_ADB_FAIL: 'connect' }), error => /Wireless debugging/.test(error.stderr));
  await assert.rejects(f.cli(['phone', 'connect', '8.8.8.8:5555']), error => /canonical Tailscale IPv4/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(call => call[0] === 'adb'), [
    ['adb', 'connect', '100.111.221.82:5555'],
    ['adb', 'connect', '100.111.221.82:44875'],
  ]);
});

test('phone pair records adb pair and rejects a non-numeric code before any process', async t => {
  const f = await phoneFixture(t);
  const ok = await f.cli(['phone', 'pair', '100.111.221.82:37123', '123456']);
  assert.match(ok.stdout, /Paired with 100\.111\.221\.82:37123/);
  await assert.rejects(f.cli(['phone', 'pair', '100.111.221.82:37123', '12a456']), error => /6-digit/.test(error.stderr));
  await assert.rejects(f.cli(['phone', 'pair', '100.111.221.82:37123', '123456'], { PONTE_TEST_ADB_FAIL: 'pair' }), error => /Pair device with pairing code/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    ['adb', 'pair', '100.111.221.82:37123', '123456'],
    ['adb', 'pair', '100.111.221.82:37123', '123456'],
  ]);
});

test('phone view launches scrcpy with Ponte title, stay-awake, and optional screen-off', async t => {
  const f = await phoneFixture(t);
  await f.cli(['phone', 'connect', '100.111.221.82:5555']);
  await f.cli(['phone', 'view']);
  await f.cli(['phone', 'view', '--screen-off']);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    ['adb', 'connect', '100.111.221.82:5555'],
    ['scrcpy', '--window-title', 'Ponte', '--stay-awake', '--video-codec=h264', '--no-audio', '-s', '100.111.221.82:5555'],
    ['scrcpy', '--window-title', 'Ponte', '--stay-awake', '--video-codec=h264', '--no-audio', '-s', '100.111.221.82:5555', '--turn-screen-off'],
  ]);
  await assert.rejects(f.cli(['phone', 'view'], { PONTE_TEST_ADB_FAIL: 'scrcpy' }), error => /scrcpy could not open/.test(error.stderr));
});

test('phone status reports installed tools, online peer and connected device through the synthetic adapter', async t => {
  const f = await phoneFixture(t);
  const result = await f.cli(['phone', 'status'], { PONTE_TEST_ADB_DEVICE: '100.111.221.82:5555' });
  assert.match(result.stdout, /adb: yes —/);
  assert.match(result.stdout, /scrcpy: yes —/);
  assert.match(result.stdout, /Tailscale: 100\.111\.221\.82 is online/);
  assert.match(result.stdout, /ADB: connected \(100\.111\.221\.82:5555\)/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['tailscale', 'status', '--json'], ['adb', 'devices']]);
});

const notebookStub = `#!${python3}
import json, os, sys
name = os.path.basename(sys.argv[0])
with open(os.environ['PONTE_TEST_LOG'], 'a') as f:
    f.write(json.dumps([name] + sys.argv[1:]) + '\\n')
fail = os.environ.get('PONTE_TEST_NOTEBOOK_FAIL')
if name == 'moonlight':
    if sys.argv[1] == 'list':
        if fail == 'list':
            sys.stderr.write('Computer lol has not been paired. Please open Moonlight to pair before retrieving games list.\\n')
            sys.exit(1)
        print('Desktop')
        print('Low Res Desktop')
    elif sys.argv[1] == 'pair':
        if fail == 'pair':
            sys.stderr.write('Pairing failed\\n'); sys.exit(1)
        print('Paired')
    elif sys.argv[1] == 'stream':
        if fail == 'stream':
            sys.exit(1)
elif name == 'curl':
    if fail == 'pin':
        print('{"status":false}')
        sys.exit(0)
    print('{"status":true}')
elif name == 'systemctl':
    print('active')
elif name == 'tailscale':
    if sys.argv[1:] == ['status', '--json']:
        online = os.environ.get('PONTE_TEST_TS_ONLINE', '1') == '1'
        print(json.dumps({'Peer': {'nb': {'Online': online, 'TailscaleIPs': ['100.91.100.95']}}}))
`;

async function notebookFixture(t, { tools = ['moonlight', 'curl', 'tailscale', 'systemctl', 'sunshine'] } = {}) {
  const f = await fixture(t);
  for (const name of tools) await writeFile(path.join(f.bin, name), notebookStub, { mode: 0o755 });
  const cli = (args, extraEnv = {}) => run(python3, [path.join(root, 'ponte'), ...args], {
    env: { ...f.env, PATH: f.bin, ...extraEnv }, timeout: 15000,
  });
  return { ...f, cli };
}

test('notebook status reports missing moonlight without launching a stream', async t => {
  const f = await notebookFixture(t, { tools: ['tailscale', 'systemctl'] });
  const result = await f.cli(['notebook', 'status']);
  assert.match(result.stdout, /moonlight: no — install with: pacman -S moonlight-qt/);
  assert.match(result.stdout, /100\.91\.100\.95/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['systemctl', '--user', 'is-active', 'sunshine.service'], ['tailscale', 'status', '--json']]);
});

test('notebook status reports Sunshine, online peer and Moonlight Desktop list', async t => {
  const f = await notebookFixture(t);
  const result = await f.cli(['notebook', 'status']);
  assert.match(result.stdout, /moonlight: yes —/);
  assert.match(result.stdout, /Sunshine service: active/);
  assert.match(result.stdout, /Tailscale: 100\.91\.100\.95 is online/);
  assert.match(result.stdout, /Moonlight pairing: yes — Desktop is available/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'is-active', 'sunshine.service'],
    ['tailscale', 'status', '--json'],
    ['moonlight', 'list', '100.91.100.95'],
  ]);
});

test('notebook pair uses PIN 7391 and view launches windowed 1080p Desktop', async t => {
  const f = await notebookFixture(t);
  const paired = await f.cli(['notebook', 'pair']);
  assert.match(paired.stdout, /PIN 7391/);
  await f.cli(['notebook', 'view']);
  await assert.rejects(f.cli(['notebook', 'pair'], { PONTE_TEST_NOTEBOOK_FAIL: 'pair' }), error => /confirm PIN 7391/.test(error.stderr));
  await assert.rejects(f.cli(['notebook', 'view'], { PONTE_TEST_NOTEBOOK_FAIL: 'stream' }), error => /could not stream/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(call => call[0] === 'moonlight'), [
    ['moonlight', 'pair', '--pin', '7391', '100.91.100.95'],
    ['moonlight', 'stream', '--1080', '--display-mode', 'windowed', '100.91.100.95', 'Desktop'],
    ['moonlight', 'pair', '--pin', '7391', '100.91.100.95'],
    ['moonlight', 'stream', '--1080', '--display-mode', 'windowed', '100.91.100.95', 'Desktop'],
  ]);
});

test('notebook accept posts PIN 4826 to local Sunshine', async t => {
  const f = await notebookFixture(t);
  const ok = await f.cli(['notebook', 'accept']);
  assert.match(ok.stdout, /Confirmed PIN 4826/);
  await assert.rejects(f.cli(['notebook', 'accept'], { PONTE_TEST_NOTEBOOK_FAIL: 'pin' }), error => /did not accept PIN 4826/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse).filter(call => call[0] === 'curl');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].slice(0, 4), ['curl', '-sk', '-u', 'grok:tela-entre-nos']);
  assert.ok(calls[0].includes('https://localhost:47990/api/pin'));
  assert.ok(calls[0].some(part => part.includes('"pin":"4826"')));
  assert.ok(calls[1].includes('https://localhost:47990/api/clients/list'));
});

test('portable start.sh reads the generated private config and serves health only on its configured loopback port', async t => {
  const f = await fixture(t);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await f.cli(['setup', '--local-only', '--http-port', String(port)]);
  const child = spawn('bash', [path.join(root, 'start.sh')], { env: { ...f.env, PONTE_NODE: process.execPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const deadline = Date.now() + 3000;
  while (!output.includes('listening') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(output, new RegExp(`127\\.0\\.0\\.1:${port}`), errors);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  const token = (await readFile(path.join(f.dataDir, 'token'), 'utf8')).trim();
  assert.equal(output.includes(token), false); assert.equal(errors.includes(token), false);
  child.kill('SIGTERM'); assert.deepEqual(await exited, { code: 0, signal: null });
  await assert.rejects(readFile(f.log), error => error.code === 'ENOENT', 'no desktop/service commands should have run');
});

test('pc subcommand shows help, rejects unknown commands, and requires a password on stdin for unlock', async t => {
  const f = await fixture(t);
  const help = await f.cli(['pc', '--help']);
  assert.match(help.stdout, /ponte pc <lock\|unlock/);
  await assert.rejects(f.cli(['pc']), error => error.code === 2);
  await assert.rejects(f.cli(['pc', 'definitely-not-a-command']), error => error.code === 2);
  await assert.rejects(f.cli(['pc', 'monitors', 'sideways']), error => error.code === 2);
  // unlock with no stdin exits 2 before any desktop command runs.
  await assert.rejects(run('bash', ['-c', `printf '' | python3 ${JSON.stringify(path.join(root, 'ponte'))} pc unlock`], { env: f.env, timeout: 15000 }), error => error.code === 2);
});

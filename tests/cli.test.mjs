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

test('renew-cert reissues only the server leaf under the same CA and restarts a running service', async t => {
  const f = await fixture(t);
  await f.cli(['setup']);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  const ca = await readFile(config.nativeTls.caFile, 'utf8');
  const leaf = await readFile(config.nativeTls.certFile, 'utf8');
  const key = await readFile(config.nativeTls.keyFile, 'utf8');
  // The stub systemctl exits 0 for is-active, so the renewal restarts the service.
  const output = await f.cli(['renew-cert']);
  assert.match(output.stdout, /renewed for 365 days/);
  assert.equal(await readFile(config.nativeTls.caFile, 'utf8'), ca, 'the CA the app pins is untouched');
  const renewed = await readFile(config.nativeTls.certFile, 'utf8');
  assert.notEqual(renewed, leaf);
  assert.notEqual(await readFile(config.nativeTls.keyFile, 'utf8'), key);
  for (const name of ['certFile', 'keyFile']) assert.equal((await stat(config.nativeTls[name])).mode & 0o777, 0o600);
  await run('openssl', ['verify', '-CAfile', config.nativeTls.caFile, '-verify_ip', '100.80.90.100', config.nativeTls.certFile]);
  const leftovers = (await readdir(path.dirname(config.nativeTls.certFile))).sort();
  assert.deepEqual(leftovers, ['ca.crt', 'ca.key', 'server.crt', 'server.key'], 'no request or temporary files remain');
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(([command]) => command === 'systemctl'), [
    ['systemctl', '--user', 'is-active', '--quiet', 'ponte-remote.service'],
    ['systemctl', '--user', 'restart', 'ponte-remote.service'],
  ]);
  const local = await fixture(t); await local.cli(['setup', '--local-only']);
  await assert.rejects(local.cli(['renew-cert']), error => /local-only/.test(error.stderr));
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
  assert.doesNotMatch(await readFile(input, 'utf8'), /PartOf=ponte-remote\.service/);
  for (const unit of [content, await readFile(input, 'utf8')]) {
    assert.match(unit, /StartLimitIntervalSec=60/);
    assert.match(unit, /StartLimitBurst=3/);
  }
  assert.match(content, /ExecCondition=.*check-config\.mjs/);
  await assert.rejects(f.cli(['uninstall'], { PONTE_TEST_FAIL_SYSTEMCTL: '1' }));
  assert.equal(await readFile(remote, 'utf8'), content, 'failed stop must preserve unit files');
  await f.cli(['uninstall']); assert.deepEqual(await readdir(units), []);
  assert.equal(await readFile(path.join(f.dataDir, 'token'), 'utf8'), token);
  await f.cli(['uninstall']);
  await writeFile(remote, '[Service]\nExecStart=/bin/false\n');
  await assert.rejects(f.cli(['uninstall']), error => /unmanaged/.test(error.stderr));
  assert.match(await readFile(remote, 'utf8'), /ExecStart/);
});

test('startup preflight rejects missing, malformed and mismatched TLS without modifying private state', async t => {
  const f = await fixture(t); await f.cli(['setup']);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  const cert = await readFile(config.nativeTls.certFile);
  const key = await readFile(config.nativeTls.keyFile);
  const token = await readFile(path.join(f.dataDir, 'token'));
  const check = () => run(process.execPath, [path.join(root, 'bin/check-config.mjs')], { env: f.env });
  await check();
  await rm(config.nativeTls.certFile);
  await assert.rejects(check(), error => error.code === 1 && /startup blocked.*ENOENT/s.test(error.stderr));
  await writeFile(config.nativeTls.certFile, 'not a certificate');
  await assert.rejects(check(), error => error.code === 1 && /startup blocked/.test(error.stderr));
  await writeFile(config.nativeTls.certFile, cert);
  const other = await fixture(t); await other.cli(['setup']);
  const otherConfig = JSON.parse(await readFile(other.configFile, 'utf8'));
  await writeFile(config.nativeTls.keyFile, await readFile(otherConfig.nativeTls.keyFile));
  await assert.rejects(check(), error => error.code === 1 && /startup blocked/.test(error.stderr));
  await writeFile(config.nativeTls.keyFile, key);
  await check();
  assert.deepEqual(await readFile(path.join(f.dataDir, 'token')), token);
});

test('startup preflight supports local-only mode and rejects invalid or explicitly missing config', async t => {
  const f = await fixture(t); await f.cli(['setup', '--local-only']);
  const check = () => run(process.execPath, [path.join(root, 'bin/check-config.mjs')], { env: { ...f.env, PONTE_CONFIG: f.configFile } });
  await check();
  await writeFile(f.configFile, '{');
  await assert.rejects(check(), error => error.code === 1 && /startup blocked/.test(error.stderr));
  await rm(f.configFile);
  await assert.rejects(check(), error => error.code === 1 && /startup blocked.*ENOENT/s.test(error.stderr));
});

test('explicit stop shuts down the server before the input daemon', async t => {
  const f = await fixture(t);
  await f.cli(['stop']);
  assert.deepEqual((await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse), [
    ['systemctl', '--user', 'stop', 'ponte-remote.service'],
    ['systemctl', '--user', 'stop', 'ponte-input.service'],
  ]);
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
        for entry in os.environ.get('PONTE_TEST_ADB_DEVICES', '').split(','):
            if entry: print(entry.replace('=', '\\t'))
        state = os.environ.get('PONTE_TEST_PHONE_STATE')
        if state and os.path.exists(state) and 'tcp' in open(state).read():
            print('100.111.221.82:5555\\tdevice')
    elif sys.argv[1] == '-s':
        serial, rest = sys.argv[2], sys.argv[3:]
        state = os.environ.get('PONTE_TEST_PHONE_STATE')
        tcp_up = bool(state and os.path.exists(state) and 'tcp' in open(state).read())
        if serial.count(':') == 1 and not tcp_up and not os.environ.get('PONTE_TEST_ADB_DEVICE'):
            sys.stderr.write('error: device offline\\n'); sys.exit(1)
        if rest[:2] == ['shell', 'echo']: print(rest[2])
        elif rest[:1] == ['tcpip']:
            if state: open(state, 'w').write('tcp')
            print('restarting in TCP mode port: ' + rest[1])
        elif rest[:2] == ['shell', 'dumpsys'] and rest[2:3] == ['window']:
            print('  mCurrentFocus=Window{1 u0 ' + os.environ.get('PONTE_TEST_FOCUS', 'app.ponte.omarchy/app.ponte.omarchy.MainActivity') + '}')
            print('    mShowingDream=false mDreamingLockscreen=' + os.environ.get('PONTE_TEST_LOCKED', 'false'))
        elif rest[:2] == ['shell', 'dumpsys'] and rest[2:3] == ['power']:
            print('  mWakefulness=' + os.environ.get('PONTE_TEST_WAKEFULNESS', 'Awake'))
        elif rest[:2] == ['shell', 'dumpsys'] and rest[2:3] == ['package']:
            print('    versionName=' + os.environ.get('PONTE_TEST_PHONE_VERSION', '0.1.0-alpha.19'))
        elif rest[:1] == ['install']:
            if fail == 'install': print('Failure [INSTALL_FAILED_USER_RESTRICTED]'); sys.exit(1)
            print('Success')
elif name == 'scrcpy':
    if fail == 'scrcpy':
        sys.exit(1)
elif name == 'tailscale':
    if sys.argv[1:] == ['status', '--json']:
        online = os.environ.get('PONTE_TEST_TS_ONLINE', '1') == '1'
        print(json.dumps({'Peer': {'phone': {'Online': online, 'TailscaleIPs': ['100.111.221.82']}}}))
`;

async function phoneFixture(t, { tools = ['adb', 'scrcpy', 'tailscale', 'systemctl'] } = {}) {
  const f = await fixture(t);
  for (const name of tools) await writeFile(path.join(f.bin, name), phoneStub, { mode: 0o755 });
  const cli = (args, extraEnv = {}) => run(python3, [path.join(root, 'ponte'), ...args], {
    env: { ...f.env, PATH: f.bin, PONTE_TEST_FAST: '1', ...extraEnv }, timeout: 15000,
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

test('phone ensure reaches the phone over Tailscale, or switches adbd to the fixed port through USB, or says the one step left', async t => {
  const f = await phoneFixture(t);
  const state = path.join(f.directory, 'phone-state');
  // TCP already up: nothing to do.
  const ready = await f.cli(['phone', 'ensure'], { PONTE_TEST_ADB_DEVICE: '100.111.221.82:5555' });
  assert.match(ready.stdout, /reachable over Tailscale at 100\.111\.221\.82:5555/);
  await writeFile(f.log, '');
  // Listener gone after a reboot, USB plugged: adbd is switched to 5555 and Tailscale takes over.
  const healed = await f.cli(['phone', 'ensure'], { PONTE_TEST_PHONE_STATE: state, PONTE_TEST_ADB_DEVICES: 'US554HTK89BI8TPF=device', PONTE_TEST_ADB_FAIL: 'connect' });
  assert.match(healed.stdout, /switched to TCP port 5555 through US554HTK89BI8TPF/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call[0] === 'adb' && call[1] === '-s' && call[2] === 'US554HTK89BI8TPF' && call[3] === 'tcpip' && call[4] === '5555'));
  assert.equal(calls.filter(call => call[0] === 'adb' && call[1] === 'connect').length >= 2, true, 'connects again after switching');
  // Nothing reachable at all: the exact manual step, no silent retry loop.
  await assert.rejects(f.cli(['phone', 'ensure'], { PONTE_TEST_ADB_FAIL: 'connect' }), error => /plug the phone in once, or on Wi-Fi turn on Wireless debugging/.test(error.stderr));
  await assert.rejects(f.cli(['phone', 'ensure'], { PONTE_TEST_ADB_FAIL: 'connect', PONTE_TEST_ADB_DEVICES: 'US554HTK89BI8TPF=unauthorized' }), error => /accept the USB debugging prompt/.test(error.stderr));
});

test('phone app launches the agent session above the lock screen, dismissing the HyperOS proximity guide, and install reports the version', async t => {
  const f = await phoneFixture(t);
  const env = { PONTE_TEST_ADB_DEVICE: '100.111.221.82:5555' };
  const launched = await f.cli(['phone', 'app'], env);
  assert.match(launched.stdout, /Ponte is in front on 100\.111\.221\.82:5555/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call.slice(0, 5).join(' ') === 'adb -s 100.111.221.82:5555 shell appops' && call.includes('10020')), 'MIUI show-on-lock-screen op is granted');
  assert.ok(calls.some(call => call.includes('am') && call.includes('--ez') && call.includes('ponte.agent')), 'started with the agent extra');
  await assert.rejects(f.cli(['phone', 'app'], { ...env, PONTE_TEST_FOCUS: 'NotificationShade' }), error => /did not come to the front/.test(error.stderr));
  await writeFile(f.log, '');
  const guided = await f.cli(['phone', 'app'], { ...env, PONTE_TEST_FOCUS: 'ScreenOnProximitySensorGuide' }).catch(error => error);
  const guideCalls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(guideCalls.some(call => call.includes('KEYCODE_VOLUME_UP')), 'Volume Up dismisses the earpiece guide');
  const apk = path.join(f.directory, 'Ponte.apk');
  await writeFile(apk, 'PK');
  const installed = await f.cli(['phone', 'install', apk], env);
  assert.match(installed.stdout, /the phone now reports Ponte 0\.1\.0-alpha\.19/);
  await assert.rejects(f.cli(['phone', 'install', apk], { ...env, PONTE_TEST_ADB_FAIL: 'install' }), error => /INSTALL_FAILED_USER_RESTRICTED/.test(error.stderr));
  await assert.rejects(f.cli(['phone', 'install', path.join(f.directory, 'missing.apk')], env), error => /not found/.test(error.stderr));
});

test('phone wake presses power only while dozing, types the private PIN when present, and refuses a world-readable one', async t => {
  const f = await phoneFixture(t);
  const env = { PONTE_TEST_ADB_DEVICE: '100.111.221.82:5555' };
  const awake = await f.cli(['phone', 'wake'], { ...env, PONTE_TEST_LOCKED: 'false' });
  assert.match(awake.stdout, /awake and unlocked/);
  let calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!calls.some(call => call.includes('KEYCODE_POWER')), 'an awake phone gets no power press');
  await assert.rejects(f.cli(['phone', 'wake'], { ...env, PONTE_TEST_LOCKED: 'true', PONTE_TEST_WAKEFULNESS: 'Dozing' }), error => /still locked/.test(error.stderr));
  calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call.includes('KEYCODE_POWER')), 'a dozing phone is woken with the power key');
  await mkdir(f.dataDir, { recursive: true });
  const secret = path.join(f.dataDir, 'phone-unlock');
  await writeFile(secret, '1234\n', { mode: 0o644 });
  await assert.rejects(f.cli(['phone', 'wake'], { ...env, PONTE_TEST_LOCKED: 'true' }), error => /must be private/.test(error.stderr));
  await chmod(secret, 0o600);
  await writeFile(f.log, '');
  await f.cli(['phone', 'wake'], { ...env, PONTE_TEST_LOCKED: 'true' }).catch(() => {});
  calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call.includes('text') && call.includes('1234')), 'the PIN is typed after the swipe');
});

test('phone timer installs and removes a managed user timer that keeps the adb link alive', async t => {
  const f = await phoneFixture(t);
  const on = await f.cli(['phone', 'timer', 'on']);
  assert.match(on.stdout, /keepalive timer installed/);
  const units = path.join(f.env.XDG_CONFIG_HOME, 'systemd/user');
  const timer = await readFile(path.join(units, 'ponte-phone.timer'), 'utf8');
  const service = await readFile(path.join(units, 'ponte-phone.service'), 'utf8');
  assert.match(timer, /OnUnitActiveSec=2min/);
  assert.match(service, /phone ensure --quiet/);
  assert.match(service, /^# Managed by Ponte/);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call.join(' ') === 'systemctl --user enable --now ponte-phone.timer'));
  await writeFile(path.join(units, 'ponte-phone.timer'), 'not ours');
  await assert.rejects(f.cli(['phone', 'timer', 'off']), error => /unmanaged unit/.test(error.stderr));
  await writeFile(path.join(units, 'ponte-phone.timer'), timer);
  const off = await f.cli(['phone', 'timer', 'off']);
  assert.match(off.stdout, /removed/);
  await assert.rejects(stat(path.join(units, 'ponte-phone.service')));
});

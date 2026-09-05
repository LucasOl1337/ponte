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

// Opt in on Linux with a user systemd manager. All units have unique names;
// the input daemon is replaced by sleep and never opens /dev/uinput.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('systemd skips invalid configuration, bounds crashes and keeps input alive across server restarts', {
  skip: process.env.PONTE_SYSTEMD_TEST !== '1', timeout: 40000,
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ponte-lifecycle-'));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  const configHome = path.join(directory, 'config');
  const env = { HOME: directory, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: path.join(directory, 'state'), PATH: `${bin}:${process.env.PATH}` };
  // Installation generates the real units, but never starts production services.
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(path.join(bin, 'ydotoold'), '#!/bin/sh\nexec /usr/bin/sleep infinity\n', { mode: 0o755 });
  const cli = (...args) => run('python3', [path.join(root, 'ponte'), ...args], { env });
  const ctl = (...args) => run('/usr/bin/systemctl', ['--user', ...args]);
  const prefix = path.basename(directory);
  const remote = `${prefix}-remote.service`, input = `${prefix}-input.service`;
  const units = path.join(process.env.XDG_RUNTIME_DIR, 'systemd/user');
  await mkdir(units, { recursive: true });
  t.after(async () => {
    await ctl('stop', remote, input).catch(() => {});
    await rm(path.join(units, remote), { force: true });
    await rm(path.join(units, input), { force: true });
    await ctl('daemon-reload');
    await ctl('reset-failed', remote, input).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await cli('setup', '--local-only');
  await cli('install');
  for (const [original, renamed] of [['ponte-remote.service', remote], ['ponte-input.service', input]]) {
    let unit = await readFile(path.join(configHome, 'systemd/user', original), 'utf8');
    unit = unit.replaceAll('ponte-remote.service', remote).replaceAll('ponte-input.service', input);
    if (renamed === remote) unit = unit.replace(/^ExecStart=.*$/m, 'ExecStart=/usr/bin/false');
    await writeFile(path.join(units, renamed), unit);
  }
  const properties = async name => Object.fromEntries((await ctl('show', name,
    '-p', 'MainPID', '-p', 'NRestarts', '-p', 'ActiveState', '-p', 'Result')).stdout.trim().split('\n').map(line => line.split('=')));
  const until = async predicate => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(100);
    }
    assert.fail(`Timed out: ${JSON.stringify(await properties(remote))}`);
  };
  const configFile = path.join(configHome, 'ponte/config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeFile(configFile, JSON.stringify({ ...config, nativeTls: {
    host: '100.80.90.100', port: 8788,
    certFile: path.join(directory, 'missing.crt'), keyFile: path.join(directory, 'missing.key'),
  } }));
  await ctl('daemon-reload');
  await ctl('start', remote);
  const blocked = await properties(remote);
  assert.equal(blocked.ActiveState, 'inactive');
  const journal = await run('/usr/bin/journalctl', ['--user', '-u', remote, '--no-pager']);
  assert.match(journal.stdout, /startup blocked:.*missing\.crt/);
  assert.equal(blocked.MainPID, '0');
  assert.equal(blocked.NRestarts, '0');
  const inputPid = (await properties(input)).MainPID;
  assert.notEqual(inputPid, '0');
  await delay(3500);
  assert.equal((await properties(remote)).NRestarts, '0');
  // Once configuration is repaired, an unrelated server crash is retried only
  // three times per minute, without cycling the input process even once.
  await writeFile(configFile, JSON.stringify(config));
  await ctl('start', remote).catch(() => {});
  await until(async () => (await properties(remote)).Result === 'start-limit-hit');
  assert.equal((await properties(input)).MainPID, inputPid);
  const restarts = (await properties(remote)).NRestarts;
  assert.ok(Number(restarts) > 0 && Number(restarts) <= 3);
  await delay(3500);
  assert.equal((await properties(remote)).NRestarts, restarts);
  // A deliberate server restart also preserves the input device.
  await ctl('reset-failed', remote);
  await ctl('restart', remote).catch(() => {});
  assert.equal((await properties(input)).MainPID, inputPid);
});

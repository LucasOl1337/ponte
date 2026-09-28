import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';

const run = promisify(execFile);
const script = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'tools/node-install.sh');
const TOOLS = ['git', 'openssl', 'tailscale', 'grim', 'ydotool', 'ydotoold', 'gpu-screen-recorder', 'tmux', 'wtype', 'hyprctl'];

// A HOME and a PATH with only what the test hands the script: the real tools
// of this machine never count, and the stubs log every call.
async function sandbox(t, { present = TOOLS, node = 'v26.1.0', evdev = true, groups = 'lol wheel input' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-node-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), bin = path.join(root, 'bin'), log = path.join(root, 'calls.log');
  await mkdir(home); await mkdir(bin);
  for (const name of ['sed', 'head', 'tr', 'grep', 'sort', 'dirname', 'uname', 'cat']) await symlink(`/usr/bin/${name}`, path.join(bin, name));
  const stub = body => `#!/bin/bash\necho "$(basename "$0") $*" >> ${JSON.stringify(log)}\n${body}\n`;
  for (const name of present) {
    const body = name === 'tailscale' ? `[ "$1 $2" = "ip -4" ] && echo 100.100.100.7; [ "$1" = status ] && echo '{"Self":{"HostName":"notebook-teste"}}'; exit 0` : 'exit 0';
    await writeFile(path.join(bin, name), stub(body), { mode: 0o755 });
  }
  if (node) await writeFile(path.join(bin, 'node'), stub(`echo ${node}`), { mode: 0o755 });
  await writeFile(path.join(bin, 'python3'), stub(`case "$*" in *evdev*) exit ${evdev ? 0 : 1};; *) exec /usr/bin/python3 "$@";; esac`), { mode: 0o755 });
  await writeFile(path.join(bin, 'id'), stub(`[ "$1" = -u ] && echo 1000 || echo "${groups}"`), { mode: 0o755 });
  const exec = args => run('/usr/bin/bash', [script, ...args], { env: { HOME: home, PATH: bin }, timeout: 15000 }).catch(error => error);
  return { home, bin, log, exec };
}

test('dry run on a fresh machine lists the clone, setup and install without touching anything', async t => {
  const box = await sandbox(t);
  const result = await box.exec(['--dry-run']);
  assert.equal(result.code ?? 0, 0, result.stderr);
  const target = path.join(box.home, 'Projects/ponte');
  assert.match(result.stdout, new RegExp(`would: clone https://github.com/LucasOl1337/ponte.git \\(main\\) into ${target}`));
  assert.match(result.stdout, new RegExp(`would run: ${target}/ponte setup`));
  assert.match(result.stdout, new RegExp(`would run: ${target}/ponte install`));
  assert.match(result.stdout, /Tailscale address 100\.100\.100\.7/);
  assert.match(result.stdout, /Ponte node notebook-teste at https:\/\/100\.100\.100\.7:8788/);
  assert.match(result.stdout, /Dry run: nothing was changed/);
  assert.doesNotMatch(result.stdout, /Missing/);
  assert.deepEqual(await readdir(box.home), [], 'the dry run created nothing');
});

test('missing dependencies come with the pacman line, and a real run stops before changing anything', async t => {
  const box = await sandbox(t, { present: ['git', 'openssl', 'tailscale', 'tmux', 'wtype', 'hyprctl'], node: 'v20.11.0', evdev: false, groups: 'lol wheel' });
  const dry = await box.exec(['--dry-run']);
  assert.match(dry.stdout, /Missing: grim ydotool ydotoold gpu-screen-recorder node>=22 \(found v20\.11\.0\) python-evdev/);
  assert.match(dry.stdout, /Install with: sudo pacman -S --needed gpu-screen-recorder grim nodejs python-evdev ydotool$/m);
  assert.match(dry.stdout, /not in the 'input' group.*usermod -aG input/);
  const real = await box.exec([]);
  assert.equal(real.code, 1);
  assert.match(real.stderr, /Nothing was changed/);
  assert.deepEqual(await readdir(box.home), []);
});

test('an existing checkout is fast-forwarded, not cloned again', async t => {
  const box = await sandbox(t);
  await mkdir(path.join(box.home, 'Projects/ponte/.git'), { recursive: true });
  const result = await box.exec(['--dry-run', '--branch=rodada/malha']);
  assert.match(result.stdout, /would: update .*Projects\/ponte \(git pull --ff-only, branch rodada\/malha\)/);
  assert.match(result.stdout, /would run: git -C .* pull --quiet --ff-only origin rodada\/malha/);
  assert.doesNotMatch(result.stdout, /clone/);
  assert.equal((await box.exec(['--bogus'])).code, 2);
});

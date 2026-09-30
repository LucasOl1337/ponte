import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { createFleet, parseSshConfig, parseSshG, routeKind, classifySshFailure, shellQuote, resumeCommand } from '../backend/fleet.mjs';
import { message, messages } from '../backend/i18n.mjs';
import { runCommand } from '../backend/process.mjs';

// Two "machines" in temporary folders: this one (HOME=<root>/self) and a
// notebook reached through a fake ssh that runs the remote command locally
// with HOME=<root>/<alias>, joining the argv the way the real ssh does (so
// the quoting the fleet applies is exercised exactly as over the network).
async function world(t, { mesh, runner } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-fleet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const self = path.join(root, 'self'), notebook = path.join(root, 'notebook');
  for (const dir of [self, notebook, path.join(root, 'bin'), path.join(root, 'data')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const ssh = path.join(root, 'bin', 'ssh');
  await writeFile(ssh, `#!/bin/sh
# Fake ssh for tests: -G prints config, -O check succeeds, else run locally.
if [ "$1" = "-G" ]; then printf 'hostname %s.example.test\\nport 22\\nuser tester\\n' "$2"; exit 0; fi
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    -O) exit 0 ;;
    *) break ;;
  esac
done
alias="$1"; shift
[ -d "${root}/$alias" ] || { echo "ssh: Could not resolve hostname $alias: Name or service not known" >&2; exit 255; }
HOME="${root}/$alias" exec sh -c "$*"
`);
  await chmod(ssh, 0o755);
  const tailscale = path.join(root, 'bin', 'tailscale');
  await writeFile(tailscale, '#!/bin/sh\nexit 1\n');
  await chmod(tailscale, 0o755);
  await mkdir(path.join(self, '.ssh'), { recursive: true });
  await writeFile(path.join(self, '.ssh', 'config'), 'Host notebook nb\n  HostName notebook.example.test\nHost *.wild\n  User x\nHost ghost\n  HostName ghost.example.test\n');
  const env = { ...process.env, HOME: self, PONTE_SSH_BIN: ssh, PONTE_TAILSCALE_BIN: tailscale, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const created = [];
  const terminals = { createInternal: async value => { created.push(value); return { id: 'a'.repeat(24), title: value.title }; } };
  const fleet = createFleet({ env, home: self, dataDir: path.join(root, 'data'), terminals, mesh, runner });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: { ...env, HOME: cwd.startsWith(notebook) ? notebook : self }, encoding: 'utf8' }).trim();
  return { root, self, notebook, fleet, created, git, env };
}

// A Claude Code transcript as Claude files it: under the folder of its cwd.
async function claudeSession(home, cwd, id, text) {
  const folder = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const rows = [
    { type: 'user', sessionId: id, cwd, gitBranch: 'main', uuid: 'u1', parentUuid: null, timestamp: '2026-09-30T19:00:00.000Z', message: { role: 'user', content: text } },
    { type: 'assistant', sessionId: id, cwd, uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-30T19:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'ai-title', sessionId: id, aiTitle: 'Fleet test' },
  ];
  // Real transcripts are never this small; the listing skips stubs under 2 KB.
  rows.push({ type: 'system', sessionId: id, cwd, content: 'x'.repeat(2500) });
  await writeFile(path.join(folder, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return folder;
}

// The same repository on both machines: the notebook clones the PC's copy
// and both point origin at the same (fake) URL, as two real checkouts would.
async function sharedRepo({ self, notebook, git }) {
  const here = path.join(self, 'Projects', 'demo'), there = path.join(notebook, 'Projects', 'demo');
  await mkdir(here, { recursive: true });
  git(here, 'init', '-q', '-b', 'main');
  await writeFile(path.join(here, 'a.txt'), 'base\n');
  git(here, 'add', 'a.txt'); git(here, 'commit', '-qm', 'base');
  await mkdir(path.dirname(there), { recursive: true });
  execFileSync('git', ['clone', '-q', here, there]);
  for (const dir of [here, there]) git(dir, 'remote', 'add', 'upstream-fake', 'x'), git(dir, 'config', 'remote.origin.url', 'git@example.test:me/demo.git');
  return { here, there };
}

const CLAUDE_ID = '5e5e5e5e-0000-4000-8000-00000000f1ee';

// assemble associates mesh peers through the tailnet, then merges SSH aliases.
// All other commands still use world's fake SSH and temporary HOME.
async function notebookTailnetRunner(command, args, options) {
  if (command === options.env.PONTE_TAILSCALE_BIN) {
    assert.deepEqual(args, ['status', '--json']);
    return JSON.stringify({
      Self: { HostName: 'pc' },
      Peer: { notebook: { HostName: 'notebook', DNSName: 'notebook.example.test.', Online: true } },
    });
  }
  return runCommand(command, args, options);
}

function notebookMesh(call, paired = true) {
  return {
    list: async () => ({ peers: [{ id: '0123456789abcdef', name: 'notebook', paired, online: true }] }),
    call,
  };
}

test('ssh config and failure helpers keep only concrete hosts and stable codes', () => {
  assert.deepEqual(parseSshConfig('Host a b\nHost *.x\nhost c # note\nHost !neg\n'), [{ alias: 'a', names: ['a', 'b'] }, { alias: 'c', names: ['c'] }]);
  assert.deepEqual(parseSshG('hostname h\nport 2222\nport 1\n'), { hostname: 'h', port: '2222' });
  assert.equal(routeKind({}), 'key');
  assert.equal(routeKind({ remotecommand: 'ssh -t other' }), 'hop');
  assert.equal(routeKind({ preferredauthentications: 'none' }), 'tailscale-ssh');
  assert.equal(classifySshFailure('ssh: connect to host x port 22: Connection refused'), 'REFUSED');
  assert.equal(classifySshFailure('Permission denied (publickey).'), 'AUTH');
  assert.equal(classifySshFailure('', true), 'TIMEOUT');
  assert.equal(classifySshFailure('ssh: Could not resolve hostname q'), 'DNS');
  assert.equal(shellQuote("it's; rm -rf ~"), `'it'\\''s; rm -rf ~'`);
  assert.deepEqual(resumeCommand('codex', CLAUDE_ID), ['codex', 'resume', CLAUDE_ID]);
  assert.throws(() => resumeCommand('claude', '--dangerously-skip-permissions'), /Invalid fleet request/);
});

test('every job error code a probe can report has an en and pt message', () => {
  for (const code of ['HANDOFF_FAILED', 'NO_ROUTE', 'NO_CHECKOUT', 'DEST_DIRTY', 'DIVERGED', 'HEAD_MISMATCH', 'UNTRACKED_EXISTS', 'PATCH_FAILED', 'DEST_NEWER', 'SESSION_NOT_FOUND', 'SESSION_LIVE', 'CLONE_FAILED', 'TIMEOUT', 'AUTH', 'UNREACHABLE', 'TAILSCALE_CHECK']) {
    assert.ok(messages[`FLEET_${code}`]?.en && messages[`FLEET_${code}`]?.pt, code);
  }
  assert.match(message('FLEET_DIVERGED', 'pt', { branch: 'main' }), /main divergiu/);
});

test('the fleet lists this machine and SSH machines, checks routes and reports unreachable ones by code', async t => {
  const { fleet } = await world(t);
  const listing = await fleet.overview({ deep: true, fresh: true });
  const byId = Object.fromEntries(listing.machines.map(machine => [machine.id, machine]));
  assert.ok(byId['ssh:notebook'], 'the notebook alias is a machine');
  assert.deepEqual(byId['ssh:notebook'].routes[0].names, ['notebook', 'nb']);
  assert.equal(byId['ssh:notebook'].health, 'ok');
  assert.equal(byId['ssh:notebook'].routes[0].check.ok, true);
  assert.equal(byId['ssh:notebook'].probe.ok, true);
  assert.equal(byId['ssh:ghost'].health, 'unreachable');
  assert.equal(byId['ssh:ghost'].routes[0].check.code, 'DNS');
  assert.ok(!listing.machines.some(machine => machine.routes.some(route => route.alias.includes('*'))), 'patterns are not machines');
});

test('a Claude session continues here: fast-forward, uncommitted changes, paths rewritten, resumed in a terminal', async t => {
  const w = await world(t);
  const { here, there } = await sharedRepo(w);
  // New work on the notebook: a commit, an edit and a new file.
  await writeFile(path.join(there, 'a.txt'), 'base\nnotebook\n');
  w.git(there, 'commit', '-qam', 'notebook work');
  await writeFile(path.join(there, 'a.txt'), 'base\nnotebook\nwip\n');
  await writeFile(path.join(there, 'new.txt'), 'new\n');
  await claudeSession(w.notebook, there, CLAUDE_ID, 'remember PINEAPPLE');

  const sessions = await w.fleet.sessions({ fresh: true });
  const listed = sessions.sessions.find(item => item.id === CLAUDE_ID);
  assert.equal(listed.machine, 'ssh:notebook');
  assert.equal(listed.cwd, '~/Projects/demo');

  const job = w.fleet.handoff({ from: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID, git: 'changes' });
  const done = await w.fleet.wait(job.id, 60000);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.deepEqual(done.steps.map(step => step.name), ['session', 'project', 'git', 'changes', 'copy', 'resume']);
  assert.equal(w.git(here, 'log', '-1', '--format=%s'), 'notebook work');
  assert.equal(await readFile(path.join(here, 'a.txt'), 'utf8'), 'base\nnotebook\nwip\n');
  assert.equal(await readFile(path.join(here, 'new.txt'), 'utf8'), 'new\n');
  const copied = path.join(w.self, '.claude', 'projects', here.replace(/[^A-Za-z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`);
  const text = await readFile(copied, 'utf8');
  assert.match(text, /PINEAPPLE/);
  assert.ok(text.includes(JSON.stringify(here)) && !text.includes(w.notebook), 'cwd points at this machine');
  assert.deepEqual(w.created, [{ title: 'Claude', directory: here, argv: ['claude', '--resume', CLAUDE_ID] }]);
  assert.match(done.result.note, /git status/);
});

for (const status of [200, 201]) {
  test(`self → paired notebook resumes through mesh and returns the remote terminal (${status})`, async t => {
    const calls = [];
    const terminal = { id: 'b'.repeat(24), title: 'Claude' };
    const mesh = notebookMesh(async (...args) => { calls.push(args); return { status, body: terminal }; });
    const w = await world(t, { mesh, runner: notebookTailnetRunner });
    const { here, there } = await sharedRepo(w);
    await claudeSession(w.self, here, CLAUDE_ID, 'REMOTE MESH');

    const done = await w.fleet.wait(w.fleet.handoff({ from: 'self', to: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID }).id, 60000);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
    assert.deepEqual(calls, [['0123456789abcdef', {
      method: 'POST', target: '/api/fleet/resume',
      body: { kind: 'claude', session: CLAUDE_ID, directory: there },
    }]]);
    assert.equal(done.result.destination, there);
    assert.deepEqual(done.result.command, ['claude', '--resume', CLAUDE_ID]);
    assert.deepEqual(done.result.terminal, { ...terminal, node: '0123456789abcdef' });
    assert.deepEqual(done.steps.map(step => step.name), ['session', 'project', 'git', 'copy', 'resume']);
    const { at, ...resume } = done.steps.at(-1);
    assert.deepEqual(resume, { name: 'resume', terminal: terminal.id, title: terminal.title, node: '0123456789abcdef' });
    const copied = await readFile(path.join(w.notebook, '.claude', 'projects', there.replace(/[^A-Za-z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`), 'utf8');
    assert.match(copied, /REMOTE MESH/);
    assert.ok(copied.includes(JSON.stringify(there)) && !copied.includes(w.self), 'the remote copy has its cwd rewritten');
    assert.deepEqual(w.created, [], 'no local terminal is created');
  });
}

for (const failure of [
  { name: 'non-success status', answer: { status: 503, body: { errorCode: 'TERMINAL_UNAVAILABLE' } }, code: 'TERMINAL_UNAVAILABLE' },
  { name: 'exception', error: new Error('mesh offline'), code: 'FLEET_RESUME_FAILED' },
]) {
  test(`remote resume falls back to manual without losing the copy on ${failure.name}`, async t => {
    const calls = [];
    const mesh = notebookMesh(async (...args) => {
      calls.push(args);
      if (failure.error) throw failure.error;
      return failure.answer;
    });
    const w = await world(t, { mesh, runner: notebookTailnetRunner });
    const { here, there } = await sharedRepo(w);
    const source = path.join(await claudeSession(w.self, here, CLAUDE_ID, 'COPY SURVIVES'), `${CLAUDE_ID}.jsonl`);
    const original = await readFile(source, 'utf8');

    const done = await w.fleet.wait(w.fleet.handoff({ from: 'self', to: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID }).id, 60000);
    assert.equal(done.status, 'done', JSON.stringify(done.error));
    assert.equal(done.error, null, 'resume failure does not fail the completed handoff');
    assert.equal(calls.length, 1);
    assert.equal(done.result.destination, there);
    assert.equal(done.result.terminal, null);
    assert.deepEqual(done.result.command, ['claude', '--resume', CLAUDE_ID]);
    const { at, ...resume } = done.steps.at(-1);
    assert.deepEqual(resume, { name: 'resume', manual: true, error: failure.code });
    assert.ok(done.steps.some(step => step.name === 'copy' && step.files > 0));
    const copied = await readFile(path.join(w.notebook, '.claude', 'projects', there.replace(/[^A-Za-z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`), 'utf8');
    assert.match(copied, /COPY SURVIVES/);
    assert.ok(copied.includes(JSON.stringify(there)) && !copied.includes(w.self));
    assert.equal(await readFile(source, 'utf8'), original, 'the source is also untouched');
    assert.deepEqual(w.created, []);
  });
}

test('an unpaired notebook keeps the manual resume command and never calls mesh', async t => {
  const calls = [];
  const mesh = notebookMesh(async (...args) => { calls.push(args); return { status: 201, body: { id: 'unexpected' } }; }, false);
  const w = await world(t, { mesh, runner: notebookTailnetRunner });
  const { here, there } = await sharedRepo(w);
  await claudeSession(w.self, here, CLAUDE_ID, 'UNPAIRED COPY');
  const listing = await w.fleet.inventory();
  assert.deepEqual(listing.machines.find(machine => machine.id === 'ssh:notebook').mesh, {
    id: '0123456789abcdef', paired: false, online: true, version: null, controlsMe: false,
  }, 'the destination is mapped to the mesh peer but is not paired');

  const done = await w.fleet.wait(w.fleet.handoff({ from: 'self', to: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID }).id, 60000);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.deepEqual(calls, []);
  assert.equal(done.result.terminal, null);
  assert.equal(done.result.destination, there);
  assert.deepEqual(done.result.command, ['claude', '--resume', CLAUDE_ID]);
  const { at, ...resume } = done.steps.at(-1);
  assert.deepEqual(resume, { name: 'resume', manual: true });
  assert.match(await readFile(path.join(w.notebook, '.claude', 'projects', there.replace(/[^A-Za-z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`), 'utf8'), /UNPAIRED COPY/);
  assert.deepEqual(w.created, []);
});

test('a dirty or diverged destination stops the transfer with a clear code and nothing is lost', async t => {
  const w = await world(t);
  const { here, there } = await sharedRepo(w);
  await writeFile(path.join(there, 'a.txt'), 'notebook\n');
  w.git(there, 'commit', '-qam', 'notebook');
  await claudeSession(w.notebook, there, CLAUDE_ID, 'hello');

  await writeFile(path.join(here, 'a.txt'), 'local edit\n');
  let done = await w.fleet.wait(w.fleet.handoff({ from: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID, resume: false }).id, 60000);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'FLEET_DEST_DIRTY');
  assert.equal(done.error.stage, 'git');
  assert.match(done.error.text.pt, /mudanças sem commit/);
  assert.equal(await readFile(path.join(here, 'a.txt'), 'utf8'), 'local edit\n', 'the local edit survives');

  w.git(here, 'commit', '-qam', 'pc');
  done = await w.fleet.wait(w.fleet.handoff({ from: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID, resume: false }).id, 60000);
  assert.equal(done.error.code, 'FLEET_DIVERGED');
  assert.equal(w.git(here, 'log', '-1', '--format=%s'), 'pc', 'the local commit stays');
  assert.equal(w.created.length, 0);
});

test('a newer copy at the destination needs force and keeps a backup', async t => {
  const w = await world(t);
  const { here, there } = await sharedRepo(w);
  await claudeSession(w.notebook, there, CLAUDE_ID, 'from the notebook');
  const request = { from: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID, git: 'none', resume: false };
  assert.equal((await w.fleet.wait(w.fleet.handoff(request).id, 60000)).status, 'done');
  // Work continued here: the local copy is now newer than the notebook's.
  const folder = path.join(w.self, '.claude', 'projects', here.replace(/[^A-Za-z0-9]/g, '-'));
  const file = path.join(folder, `${CLAUDE_ID}.jsonl`);
  await writeFile(file, (await readFile(file, 'utf8')) + JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, cwd: here, message: { role: 'user', content: 'continued here' } }) + '\n');
  const future = new Date(Date.now() + 60000);
  execFileSync('touch', ['-d', future.toISOString(), file]);

  const refused = await w.fleet.wait(w.fleet.handoff(request).id, 60000);
  assert.equal(refused.error.code, 'FLEET_DEST_NEWER');
  assert.match(await readFile(file, 'utf8'), /continued here/);

  const forced = await w.fleet.wait(w.fleet.handoff({ ...request, force: true }).id, 60000);
  assert.equal(forced.status, 'done');
  const backups = (await readdir(folder)).filter(name => name.includes('.ponte-bak'));
  assert.equal(backups.length, 1);
  assert.match(await readFile(path.join(folder, backups[0]), 'utf8'), /continued here/);
});

test('Codex and Jcode sessions copy with their folder rewritten and resume with their own command', async t => {
  const w = await world(t);
  const { here, there } = await sharedRepo(w);
  const codexId = '01a0db30-48dc-7122-9bc0-e56e67dd9513';
  const rollout = path.join(w.notebook, '.codex', 'sessions', '2026', '09', '30', `rollout-2026-09-30T10-00-00-${codexId}.jsonl`);
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: codexId, cwd: there } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { message: 'KIWI' } }) + '\n');
  const jcodeId = 'session_fox_1790703994139_1d27c7ec3fcf8ff7';
  const jcodeDir = path.join(w.notebook, '.jcode', 'sessions');
  await mkdir(jcodeDir, { recursive: true });
  await writeFile(path.join(jcodeDir, `${jcodeId}.json`), JSON.stringify({ id: jcodeId, working_dir: there, status: 'Active', last_pid: 4242, messages: [{ text: 'MANGO' }] }));
  await writeFile(path.join(jcodeDir, `${jcodeId}.journal.jsonl`), JSON.stringify({ cwd: there }) + '\n');

  for (const [kind, session] of [['codex', codexId], ['jcode', jcodeId]]) {
    const done = await w.fleet.wait(w.fleet.handoff({ from: 'ssh:notebook', kind, session, git: 'none' }).id, 60000);
    assert.equal(done.status, 'done', `${kind}: ${JSON.stringify(done.error)}`);
  }
  const copiedRollout = await readFile(rollout.replace(w.notebook, w.self), 'utf8');
  assert.match(copiedRollout, /KIWI/);
  assert.ok(copiedRollout.includes(JSON.stringify(here)) && !copiedRollout.includes(w.notebook));
  const jcode = JSON.parse(await readFile(path.join(w.self, '.jcode', 'sessions', `${jcodeId}.json`), 'utf8'));
  assert.equal(jcode.working_dir, here);
  assert.equal(jcode.status, 'Closed', 'an open session on the source is closed in the copy');
  assert.equal(jcode.last_pid, null);
  assert.deepEqual(w.created.map(item => item.argv), [['codex', 'resume', codexId], ['jcode', '--resume', jcodeId]]);
  assert.ok(w.created.every(item => item.directory === here));
});

test('handoff requests are validated before anything runs', async t => {
  const { fleet } = await world(t);
  for (const bad of [
    { from: 'ssh:notebook', kind: 'claude', session: '../../etc/passwd' },
    { from: 'ssh:note book', kind: 'claude', session: CLAUDE_ID },
    { from: 'self', to: 'self', kind: 'claude', session: CLAUDE_ID },
    { from: 'ssh:notebook', kind: 'bash', session: CLAUDE_ID },
    { from: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID, git: 'reset' },
    { from: 'ssh:notebook', kind: 'claude', session: CLAUDE_ID, extra: 1 },
  ]) assert.throws(() => fleet.handoff(bad), /Invalid fleet request/, JSON.stringify(bad));
});

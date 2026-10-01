import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rm, utimes, stat } from 'node:fs/promises';
import { createAgents, parseStat, agentKind, agentServer, modelFromArgv, claudeMessages, codexMessages, lastMessages } from '../backend/agents.mjs';
import { createApp } from '../server.mjs';

const BOOT = 1790000000;
const SESSION = '00000000-0000-4000-8000-000000000001';
const CODEX = '0190a000-0000-7000-8000-000000000003';
const MAESTRI_WS = '00000000-0000-4000-8000-0000000000a1';
const MAESTRI_TERM = '00000000-0000-4000-8000-0000000000a2';
const JCODE_A = 'session_fixture_alpha';
const JCODE_B = 'session_fixture_beta';
const AGENT_START = 10000;
const AGENT_STARTED_AT = BOOT * 1000 + AGENT_START * 10;
const AGENT_WRITTEN_AT = AGENT_STARTED_AT + 20000;
const TOKEN = 'test_token_with_at_least_thirty_two_characters';

// A fake /proc and home: processes with stat/cmdline/cwd/environ/fd, plus the
// Claude, Codex, JCode and Maestri files the scanner reads.
async function world(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = path.join(root, 'proc'), home = path.join(root, 'home');
  await mkdir(proc, { recursive: true });
  await writeFile(path.join(proc, 'stat'), `cpu 1 2 3\nbtime ${BOOT}\n`);
  const ticks = new Map();
  const add = async (pid, comm, ppid, { argv = [comm], cwd = home, start = pid * 10, environ = [], fds = [], cpu = 0 } = {}) => {
    const dir = path.join(proc, String(pid));
    await mkdir(path.join(dir, 'fd'), { recursive: true });
    ticks.set(pid, { comm, ppid, start, cpu });
    await writeStat(pid);
    await writeFile(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    await writeFile(path.join(dir, 'environ'), `${['PATH=/usr/bin', 'SECRET=nope', ...environ].join('\0')}\0`);
    await mkdir(cwd, { recursive: true });
    await symlink(cwd, path.join(dir, 'cwd'));
    for (const [index, target] of fds.entries()) await symlink(target, path.join(dir, 'fd', String(index + 3)));
  };
  const writeStat = pid => {
    const p = ticks.get(pid);
    return writeFile(path.join(proc, String(pid), 'stat'), `${pid} (${p.comm}) S ${p.ppid} 1 1 0 -1 4194304 0 0 0 0 ${p.cpu} 0 0 0 20 0 1 0 ${p.start} 1 1 18446744073709551615\n`);
  };
  const burn = async (pid, amount) => { ticks.get(pid).cpu += amount; await writeStat(pid); };
  const file = async (relative, content) => { const target = path.join(home, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return target; };
  return { root, proc, home, add, burn, file };
}

function hypr(clients, active = { value: null }) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[1] === 'clients') return JSON.stringify(clients);
    if (command === 'hyprctl' && args[1] === 'activewindow') return JSON.stringify(active.value ? { address: active.value } : {});
    if (command === 'omarchy-shell') return 'false\n';
    throw new Error(`unexpected ${command}`);
  };
  return { runner, calls, active };
}

const foot = (pid, address, title, ws = 2) => ({ pid, address, title, class: 'foot', monitor: 0, workspace: { id: ws, name: String(ws) } });
const line = value => JSON.stringify(value);
const jcodeMessage = (id, role, content, second = 0) => ({ id: `message_${id.replace(/-/g, '')}`, role, content, timestamp: `2026-09-28T10:00:${String(second).padStart(2, '0')}Z` });

async function jcodeFiles(w, pid, session, { meta = {}, messages = [], snapshot = null, journal = true, writtenAt = AGENT_WRITTEN_AT } = {}) {
  const mapping = await w.file(`.jcode/client_sessions/${pid}`, `${session}\n`);
  await utimes(mapping, writtenAt / 1000, writtenAt / 1000);
  let journalFile = null, snapshotFile = null;
  if (journal) {
    journalFile = await w.file(`.jcode/sessions/${session}.journal.jsonl`, line({ meta, append_messages: messages }));
    await utimes(journalFile, writtenAt / 1000, writtenAt / 1000);
  }
  if (snapshot !== null) {
    snapshotFile = await w.file(`.jcode/sessions/${session}.json`, line({ id: session, ...meta, messages: snapshot }));
    await utimes(snapshotFile, writtenAt / 1000, writtenAt / 1000);
  }
  return { mapping, journalFile, snapshotFile };
}

test('parseStat survives spaces and parentheses in comm; agentKind sees through node wrappers', () => {
  const stat = parseStat('42 (tmux: server (x)) S 7 1 1 0 -1 0 0 0 0 0 30 12 0 0 20 0 1 0 555 1 1\n');
  assert.deepEqual(stat, { pid: 42, comm: 'tmux: server (x)', ppid: 7, ticks: 42, start: 555 });
  assert.equal(agentKind('claude'), 'claude');
  assert.equal(agentKind('node', ['node', '/usr/lib/node_modules/@openai/codex/bin/codex.js']), 'codex');
  assert.equal(agentKind('node', ['node', 'server.mjs']), null);
  assert.equal(agentKind('bash', ['bash']), null);
});

test('JCode native/truncated names and Hermes native/Python wrappers are detected in the process scan', async t => {
  const w = await world(t);
  const cases = [
    { pid: 100, comm: 'jcode', argv: [path.join(w.home, 'bin', 'jcode')], kind: 'jcode' },
    { pid: 200, comm: 'jcode-linux-x86', argv: [path.join(w.home, 'bin', 'jcode-linux-x86_64.bin')], kind: 'jcode' },
    { pid: 300, comm: 'hermes', argv: [path.join(w.home, 'bin', 'hermes')], kind: 'hermes' },
    { pid: 400, comm: 'python3', argv: ['python3', path.join(w.home, 'bin', 'hermes.py')], kind: 'hermes' },
    { pid: 500, comm: 'node', argv: ['node', path.join(w.home, 'bin', 'jcode.js')], kind: 'jcode' },
  ];
  for (const { pid, comm, argv, kind } of cases) {
    assert.equal(agentKind(comm, argv), kind);
    await w.add(pid, comm, 1, { argv });
  }
  const { items, counts } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 }).list();
  assert.deepEqual(items.map(item => [item.pid, item.kind]).sort((a, b) => a[0] - b[0]), cases.map(({ pid, kind }) => [pid, kind]));
  assert.deepEqual(counts, { agents: 5, automated: 0, working: 0, waiting: 0, terminals: 0, maestri: 0, byKind: { jcode: 3, hermes: 2 } });
});

test('Codex app-server and JCode serve/sandbox/code-mode daemons are excluded even with inherited Maestri ids', async t => {
  const w = await world(t);
  const environ = [`MAESTRI_WORKSPACE_ID=${MAESTRI_WS}`, `MAESTRI_TERMINAL_ID=${MAESTRI_TERM}`];
  await w.add(100, 'maestri-app', 1);
  await w.add(101, 'bash', 100, { environ });
  await w.add(102, 'jcode', 101, { environ });
  const modes = [
    ['codex', 'codex', 'app-server'],
    ['jcode', 'jcode', 'serve'],
    ['jcode', 'jcode', 'sandbox'],
    ['jcode-linux-x86', 'jcode-sandbox'],
    ['jcode-linux-x86', 'jcode-code-mode'],
    ['codex', 'codex-linux-sandbox'],
    ['codex', 'codex-code-mode'],
  ];
  for (const [index, [comm, binary, ...args]] of modes.entries()) {
    const argv = [path.join(w.home, 'bin', binary), ...args];
    assert.equal(agentServer(argv), true, binary + ' ' + args.join(' '));
    // A shared daemon can retain ids from the shell that originally launched it.
    await w.add(200 + index * 2, comm, 1, { argv, environ });
    await w.add(201 + index * 2, 'jcode', 200 + index * 2, { environ });
  }
  assert.equal(agentServer([path.join(w.home, 'bin', 'jcode'), '--model', 'fixture-model']), false);
  assert.equal(agentServer([path.join(w.home, 'bin', 'codex'), 'exec', '--json']), false);
  const { items, counts } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 }).list();
  assert.deepEqual(items.map(item => [item.pid, item.kind, item.where.type]), [[102, 'jcode', 'maestri']]);
  assert.deepEqual(counts, { agents: 1, automated: 0, working: 0, waiting: 0, terminals: 0, maestri: 1, byKind: { jcode: 1 } });
});

test('one JCode client with a server child and nested helper remains one interactive terminal', async t => {
  const w = await world(t);
  await w.add(100, 'foot', 1);
  await w.add(101, 'bash', 100);
  await w.add(102, 'jcode-linux-x86', 101, { start: AGENT_START });
  await w.add(103, 'jcode-linux-x86', 102, { argv: [path.join(w.home, 'bin', 'jcode'), 'serve'] });
  await w.add(104, 'node', 103, { argv: ['node', path.join(w.home, 'bin', 'jcode.js')] });
  await w.add(105, 'systemd-inhibit', 102);
  const { items, counts } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([foot(100, '0xa1', 'JCode fixture')]).runner, bootMs: BOOT * 1000 }).list();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].id, items[0].kind, items[0].where.type, items[0].state, items[0].canReply], [`p-102-${AGENT_START}`, 'jcode', 'terminal', 'working', true]);
  assert.deepEqual(counts, { agents: 1, automated: 0, working: 1, waiting: 0, terminals: 0, maestri: 0, byKind: { jcode: 1 } });
});

test('a literal Claude print prompt named serve is not a daemon and remains an automated agent', async t => {
  assert.equal(agentServer(['claude', '-p', 'serve']), false);
  const w = await world(t);
  await w.add(102, 'claude', 1, { argv: ['claude', '-p', 'serve'] });
  const { items, counts } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 }).list();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].pid, items[0].kind, items[0].headless, items[0].where.type], [102, 'claude', true, 'none']);
  assert.deepEqual(counts, { agents: 0, automated: 1, working: 0, waiting: 0, terminals: 0, maestri: 0, byKind: {} });
});

test('after a Maestri restart the live app client wins over an orphan with the same workspace and terminal ids', async t => {
  const w = await world(t);
  const cwd = path.join(w.home, 'work', 'restart-fixture');
  const environ = [`MAESTRI_WORKSPACE_ID=${MAESTRI_WS}`, `MAESTRI_TERMINAL_ID=${MAESTRI_TERM}`];
  // The old app is gone, but its shell and client still retain both ids.
  await w.add(101, 'bash', 1, { environ });
  await w.add(102, 'jcode', 101, { cwd, environ, start: AGENT_START - 1000 });
  await w.add(200, 'maestri-app', 1);
  await w.add(201, 'bash', 200, { environ });
  await w.add(202, 'jcode', 201, { cwd, environ, start: AGENT_START });
  await w.file(`.maestri/workspaces/${MAESTRI_WS}/workspace.json`, line({ payload: {
    name: 'Equipe restart fixture', nodes: [{ content: { terminal: { _0: { id: MAESTRI_TERM, name: 'Cliente novo fixture', agentType: 'jcode' } } } }],
  } }));
  await jcodeFiles(w, 102, JCODE_A, {
    meta: { model: 'fixture-orphan-model' },
    messages: [jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'assistant', [{ type: 'text', text: 'Atividade do órfão.' }])],
  });
  await jcodeFiles(w, 202, JCODE_B, {
    meta: { model: 'fixture-live-model' },
    messages: [jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'assistant', [{ type: 'text', text: 'Atividade do cliente novo.' }], 1)],
  });
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const { items, counts } = await agents.list();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].pid, items[0].id, items[0].title, items[0].where.type], [202, `p-202-${AGENT_START}`, 'Cliente novo fixture', 'maestri']);
  assert.equal(items[0].model.name, 'fixture-live-model');
  assert.equal(items[0].activity.text, 'Atividade do cliente novo.');
  assert.deepEqual(counts, { agents: 1, automated: 0, working: 0, waiting: 0, terminals: 0, maestri: 1, byKind: { jcode: 1 } });
  assert.deepEqual((await agents.transcript(items[0].id)).messages.map(message => message.text), ['Atividade do cliente novo.']);
  await assert.rejects(agents.transcript(`p-102-${AGENT_START - 1000}`), { code: 'AGENT_NOT_FOUND' });
});

test('two JCode clients in the same cwd get distinct models and activity from their PID session mappings', async t => {
  const w = await world(t);
  const cwd = path.join(w.home, 'work', 'shared-fixture');
  await w.add(100, 'foot', 1);
  await w.add(101, 'bash', 100);
  await w.add(102, 'jcode', 101, { cwd, start: AGENT_START });
  // Without a sleep inhibitor, a pending journal tool call is the busy signal.
  await w.add(200, 'foot', 1);
  await w.add(201, 'bash', 200);
  await w.add(202, 'jcode', 201, { cwd, start: AGENT_START });
  await jcodeFiles(w, 102, JCODE_A, {
    meta: { working_dir: cwd, provider_key: 'fixture-alpha-provider', model: 'fixture-alpha-model', reasoning_effort: 'high' },
    messages: [jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'assistant', [{ type: 'tool_use', id: 'fixture-alpha-tool', name: 'read', input: { path: path.join(cwd, 'alpha.mjs'), description: 'Conferir fluxo alfa' } }], 1)],
  });
  await jcodeFiles(w, 202, JCODE_B, {
    writtenAt: AGENT_WRITTEN_AT + 1000,
    meta: { working_dir: cwd, provider_key: 'fixture-beta-provider', model: 'fixture-beta-model', reasoning_effort: 'low' },
    messages: [jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'assistant', [{ type: 'text', text: 'Fluxo beta pronto.' }], 2)],
  });
  const { items, counts } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([foot(100, '0xa1', 'JCode'), foot(200, '0xa2', 'JCode')]).runner, bootMs: BOOT * 1000, now: () => AGENT_WRITTEN_AT + 60000 }).list();
  const alpha = items.find(item => item.pid === 102), beta = items.find(item => item.pid === 202);
  assert.equal(items.length, 2);
  assert.equal(alpha.cwd, beta.cwd);
  assert.notEqual(alpha.id, beta.id);
  assert.deepEqual([alpha.model, beta.model], [
    { name: 'fixture-alpha-model', effort: 'high', provider: 'fixture-alpha-provider' },
    { name: 'fixture-beta-model', effort: 'low', provider: 'fixture-beta-provider' },
  ]);
  assert.deepEqual([alpha.activity, beta.activity], [
    { role: 'tool', text: 'read: Conferir fluxo alfa', at: Date.parse('2026-09-28T10:00:01Z') },
    { role: 'assistant', text: 'Fluxo beta pronto.', at: Date.parse('2026-09-28T10:00:02Z') },
  ]);
  assert.deepEqual([alpha.state, beta.state, alpha.transcript, beta.transcript], ['working', 'ready', true, true]);
  assert.deepEqual(counts, { agents: 2, automated: 0, working: 1, waiting: 0, terminals: 0, maestri: 0, byKind: { jcode: 2 } });
  assert.ok(!JSON.stringify(items).includes('client_sessions') && !JSON.stringify(items).includes('.journal.jsonl'));
});

test('a JCode journal transcript uses the JCode parser and does not expose reminders, thoughts or tool results', async t => {
  const w = await world(t);
  await w.add(102, 'jcode', 1, { start: AGENT_START });
  await jcodeFiles(w, 102, JCODE_A, { messages: [
    jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'user', [{ type: 'text', text: '<system-reminder>fixture context</system-reminder>' }]),
    jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'user', [{ type: 'text', text: 'Confere o fluxo da fixture.' }], 1),
    jcodeMessage('00000000-0000-4000-8000-0000000000e3', 'assistant', [{ type: 'tool_use', id: 'fixture-read', name: 'read', input: { path: path.join(w.home, 'work', 'fixture.mjs'), description: 'Ler fixture' } }], 2),
    jcodeMessage('00000000-0000-4000-8000-0000000000e4', 'user', [{ type: 'tool_result', tool_use_id: 'fixture-read', content: 'fixture result should stay private' }], 3),
    jcodeMessage('00000000-0000-4000-8000-0000000000e5', 'assistant', [{ type: 'text', text: '<think>fixture thought should stay private</think>Fluxo conferido.' }], 4),
  ] });
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000, now: () => AGENT_WRITTEN_AT + 60000 });
  const [item] = (await agents.list()).items;
  const transcript = await agents.transcript(item.id);
  assert.equal(transcript.available, true);
  assert.equal(transcript.kind, 'jcode');
  assert.deepEqual(transcript.messages.map(message => [message.role, message.text]), [
    ['user', 'Confere o fluxo da fixture.'], ['tool', 'read: Ler fixture'], ['assistant', 'Fluxo conferido.'],
  ]);
  assert.equal(transcript.updatedAt, AGENT_WRITTEN_AT);
  assert.ok(!JSON.stringify(transcript).includes('should stay private'));
  assert.ok(!JSON.stringify(transcript).includes('system-reminder'));
});

test('JCode transcript combines a compacted JSON snapshot with its journal without duplicate message ids', async t => {
  const w = await world(t);
  await w.add(102, 'jcode', 1, { start: AGENT_START });
  const first = jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'user', [{ type: 'text', text: 'Primeiro pedido da fixture.' }]);
  const shared = jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'assistant', [{ type: 'text', text: 'Primeira resposta.' }], 1);
  await jcodeFiles(w, 102, JCODE_A, {
    snapshot: [first, shared],
    messages: [shared,
      jcodeMessage('00000000-0000-4000-8000-0000000000e3', 'user', [{ type: 'text', text: 'Segundo pedido da fixture.' }], 2),
      jcodeMessage('00000000-0000-4000-8000-0000000000e4', 'assistant', [{ type: 'text', text: 'Resposta nova.' }], 3),
    ],
  });
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  const transcript = await agents.transcript(item.id);
  assert.equal(transcript.available, true);
  assert.deepEqual(transcript.messages.map(message => message.text), ['Primeiro pedido da fixture.', 'Primeira resposta.', 'Segundo pedido da fixture.', 'Resposta nova.']);
  assert.equal(transcript.truncated, false);
});

test('a mapped JCode session remains readable after the journal is folded entirely into its JSON snapshot', async t => {
  const w = await world(t);
  await w.add(102, 'jcode', 1, { start: AGENT_START });
  await jcodeFiles(w, 102, JCODE_A, {
    journal: false,
    meta: { provider_key: 'fixture-json-provider', model: 'fixture-json-model' },
    snapshot: [
      jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'user', [{ type: 'text', text: 'Pedido compactado da fixture.' }]),
      jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'assistant', [{ type: 'text', text: 'Resposta compactada.' }], 1),
    ],
  });
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  assert.deepEqual([item.transcript, item.state, item.model], [true, 'ready', { name: 'fixture-json-model', effort: null, provider: 'fixture-json-provider' }]);
  assert.deepEqual(item.activity, { role: 'assistant', text: 'Resposta compactada.', at: Date.parse('2026-09-28T10:00:01Z') });
  const transcript = await agents.transcript(item.id);
  assert.equal(transcript.available, true);
  assert.deepEqual(transcript.messages.map(message => message.text), ['Pedido compactado da fixture.', 'Resposta compactada.']);
  assert.equal(transcript.updatedAt, AGENT_WRITTEN_AT);
});

test('JCode ignores missing, stale or invalid PID mappings instead of guessing another session in the same cwd', async t => {
  for (const mode of ['missing', 'stale', 'invalid']) await t.test(mode, async t => {
    const w = await world(t);
    const cwd = path.join(w.home, 'work', 'shared-fixture');
    await w.add(102, 'jcode', 1, { cwd, start: AGENT_START });
    // A recent unrelated session is not evidence of this client's identity.
    await jcodeFiles(w, 999, JCODE_B, { meta: { working_dir: cwd, provider_key: 'fixture-provider', model: 'fixture-unrelated-model' }, messages: [jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'assistant', [{ type: 'text', text: 'Outra sessão.' }])] });
    if (mode !== 'missing') {
      const mapping = await w.file('.jcode/client_sessions/102', mode === 'invalid' ? '../session_fixture_beta\n' : `${JCODE_B}\n`);
      const at = mode === 'stale' ? AGENT_STARTED_AT - 10000 : AGENT_WRITTEN_AT;
      await utimes(mapping, at / 1000, at / 1000);
    }
    const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
    const [item] = (await agents.list()).items;
    assert.deepEqual([item.transcript, item.model, item.activity], [false, null, null]);
    assert.deepEqual(await agents.transcript(item.id), { id: item.id, available: false, messages: [], truncated: false, updatedAt: null });
  });
});

test('Maestri identity includes workspace, lead, reportsTo, role, live model, branch and latest tool activity', async t => {
  const w = await world(t);
  const recruitId = '00000000-0000-4000-8000-0000000000a3';
  const roleId = '00000000-0000-4000-8000-0000000000a4';
  const otherWorkspace = '00000000-0000-4000-8000-0000000000b1';
  const otherTerminal = '00000000-0000-4000-8000-0000000000b2';
  const leaderRepo = path.join(w.home, 'work', 'leader-fixture');
  const recruitRepo = path.join(w.home, '.maestri', 'roles', roleId, 'project');
  const otherRepo = path.join(w.home, 'work', 'other-fixture');
  const environ = (workspace, terminal) => [`MAESTRI_WORKSPACE_ID=${workspace}`, `MAESTRI_TERMINAL_ID=${terminal}`];
  const node = (id, name, agentType, isManager = false) => ({ content: { terminal: { _0: { id, name, agentType, isManager } } } });
  await w.add(100, 'maestri-app', 1);
  await w.add(101, 'bash', 100, { environ: environ(MAESTRI_WS, MAESTRI_TERM) });
  await w.add(102, 'jcode', 101, { cwd: path.join(leaderRepo, 'src'), start: AGENT_START, argv: [path.join(w.home, 'bin', 'jcode'), '--model=fixture-launch-model', '--effort', 'high', '--provider-profile', 'fixture-launch-provider'] });
  await w.add(103, 'systemd-inhibit', 102);
  await w.add(201, 'bash', 100, { environ: environ(MAESTRI_WS, recruitId) });
  await w.add(202, 'python3', 201, { cwd: path.join(recruitRepo, 'src'), start: AGENT_START, argv: ['python3', path.join(w.home, 'bin', 'hermes.py'), '-m', 'fixture-hermes-model', '--reasoning-effort=low'] });
  await w.add(301, 'bash', 100, { environ: environ(otherWorkspace, otherTerminal) });
  await w.add(302, 'codex', 301, { cwd: otherRepo, start: AGENT_START, argv: [path.join(w.home, 'bin', 'codex'), '--model', 'fixture-codex-model', '-c', 'model_reasoning_effort="medium"'] });
  await w.file(`.maestri/workspaces/${MAESTRI_WS}/workspace.json`, line({ payload: {
    name: ' Equipe \n fixture ', nodes: [node(MAESTRI_TERM, 'Regente fixture', 'jcode', true), node(recruitId, 'Revisor fixture', 'hermes')],
    connections: [
      { terminalIdA: MAESTRI_TERM, terminalIdB: recruitId },
      { terminalIdA: MAESTRI_TERM, terminalIdB: MAESTRI_TERM },
      { terminalIdA: MAESTRI_TERM, terminalIdB: otherTerminal },
    ],
  } }));
  await w.file(`.maestri/workspaces/${otherWorkspace}/workspace.json`, line({ payload: { name: 'Outra equipe fixture', nodes: [node(otherTerminal, 'Regente fixture', 'codex')], connections: [] } }));
  await w.file(`.maestri/roles/${roleId}/role.json`, line({ name: ' Revisor \n de testes ' }));
  await w.file('work/leader-fixture/.git/HEAD', 'ref: refs/heads/fixture/leader\n');
  const gitdir = path.join(w.home, 'git-fixture', 'worktrees', 'recruit');
  await w.file(`.maestri/roles/${roleId}/project/.git`, `gitdir: ${path.relative(recruitRepo, gitdir)}\n`);
  await w.file('git-fixture/worktrees/recruit/HEAD', 'ref: refs/heads/fixture/recruit\n');
  await w.file('work/other-fixture/.git/HEAD', `${'a'.repeat(40)}\n`);
  await jcodeFiles(w, 102, JCODE_A, {
    meta: { provider_key: 'fixture-live-provider', model: 'fixture-live-model', reasoning_effort: 'low' },
    messages: [
      jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'assistant', [{ type: 'text', text: 'Conferindo a contagem.' }], 1),
      jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'assistant', [{ type: 'tool_use', id: 'fixture-edit', name: 'apply_patch', input: { path: path.join(leaderRepo, 'src', 'fixture.mjs'), description: 'Ajustar contagem' } }], 2),
    ],
  });
  const { items, counts } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 }).list();
  const leader = items.find(item => item.pid === 102), recruit = items.find(item => item.pid === 202), other = items.find(item => item.pid === 302);
  assert.equal(items.length, 3);
  assert.deepEqual(leader.maestri, { workspaceId: MAESTRI_WS, workspace: 'Equipe fixture', name: 'Regente fixture', maestro: true, lead: true, team: 1, reportsTo: null, role: null });
  assert.deepEqual(recruit.maestri, { workspaceId: MAESTRI_WS, workspace: 'Equipe fixture', name: 'Revisor fixture', maestro: false, lead: false, team: 0, reportsTo: 'Regente fixture', role: 'Revisor de testes' });
  assert.deepEqual(other.maestri, { workspaceId: otherWorkspace, workspace: 'Outra equipe fixture', name: 'Regente fixture', maestro: false, lead: false, team: 0, reportsTo: null, role: null });
  assert.deepEqual([leader.title, recruit.title, other.title], ['Regente fixture', 'Revisor fixture', 'Regente fixture']);
  assert.deepEqual([leader.branch, recruit.branch, other.branch], ['fixture/leader', 'fixture/recruit', 'aaaaaaaa']);
  assert.deepEqual([leader.model, recruit.model, other.model], [
    { name: 'fixture-live-model', effort: 'high', provider: 'fixture-launch-provider' },
    { name: 'fixture-hermes-model', effort: 'low', provider: null },
    { name: 'fixture-codex-model', effort: 'medium', provider: null },
  ]);
  assert.deepEqual(leader.activity, { role: 'tool', text: 'apply_patch: Ajustar contagem', at: Date.parse('2026-09-28T10:00:02Z') });
  assert.deepEqual([recruit.activity, other.activity], [null, null]);
  assert.ok(items.every(item => item.where.type === 'maestri' && !item.canReply));
  assert.equal(counts.maestri, 3);
});

test('model options come from argv or the Maestri launch command when a transcript has no model', async t => {
  const w = await world(t);
  const jcode = path.join(w.home, 'bin', 'jcode');
  assert.deepEqual(modelFromArgv([jcode, '--provider', 'fixture-provider', '--provider-profile=fixture-profile', '--model=fixture-model', '--reasoning-effort=high']), { provider: 'fixture-profile', model: 'fixture-model', effort: 'high' });
  assert.deepEqual(modelFromArgv([path.join(w.home, 'bin', 'codex'), '-c', 'model="fixture-codex-model"', '-c', 'model_reasoning_effort="low"']), { model: 'fixture-codex-model', effort: 'low' });
  assert.deepEqual(modelFromArgv([jcode, '--model']), {});
  await w.add(100, 'maestri-app', 1);
  await w.add(101, 'bash', 100, { environ: [`MAESTRI_WORKSPACE_ID=${MAESTRI_WS}`, `MAESTRI_TERMINAL_ID=${MAESTRI_TERM}`] });
  await w.add(102, 'jcode', 101, { argv: [jcode] });
  await w.file(`.maestri/workspaces/${MAESTRI_WS}/workspace.json`, line({ payload: {
    name: 'Equipe fixture', nodes: [{ content: { terminal: { _0: { id: MAESTRI_TERM, name: 'Modelo fixture', command: `"${jcode}" --model "fixture-canvas-model" --effort high --provider-profile fixture-canvas-profile` } } } }],
  } }));
  const { items } = await createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 }).list();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].model, { name: 'fixture-canvas-model', effort: 'high', provider: 'fixture-canvas-profile' });
  assert.equal(items[0].transcript, false);
});

test('a Claude Code in a foot window is matched by pid ancestry, its session file and its transcript', async t => {
  const w = await world(t);
  const cwd = path.join(w.home, 'work', 'demo');
  await w.add(47630, 'foot', 1);
  await w.add(47656, 'bash', 47630);
  await w.add(50773, 'claude', 47656, { cwd, start: 54394 });
  await w.add(56258, 'foot', 1);
  await w.add(56286, 'bash', 56258);
  await w.add(99001, 'foot', 1);
  await w.add(99002, 'bash', 99001);
  await w.file('.claude/sessions/50773.json', line({ pid: 50773, sessionId: SESSION, cwd, procStart: '54394', status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1790592874114, name: 'demo-26' }));
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  await w.file(`.claude/projects/${encoded}/${SESSION}.jsonl`, [
    line({ type: 'user', message: { role: 'user', content: 'Caveat: meta' }, isMeta: true, timestamp: '2026-09-28T10:00:00Z' }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, timestamp: '2026-09-28T10:00:01Z' }),
    line({ type: 'user', message: { role: 'user', content: 'quais pendências ficaram?' }, timestamp: '2026-09-28T10:00:02Z' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] }, timestamp: '2026-09-28T10:00:03Z' }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(50000) }] }, timestamp: '2026-09-28T10:00:04Z' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ficaram duas.' }] }, isSidechain: true, timestamp: '2026-09-28T10:00:05Z' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ficaram três pendências.' }] }, timestamp: '2026-09-28T10:00:06Z' }),
    'not json',
  ].join('\n'));
  const { runner } = hypr([foot(47630, '0xa1', '✳ Demo project work'), foot(56258, '0xa2', '~'), foot(99001, '0xa3', 'lol@lol:~')]);
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner, bootMs: BOOT * 1000 });
  const { items, scanMs } = await agents.list();
  assert.ok(Number.isFinite(scanMs));
  const claude = items.find(item => item.kind === 'claude');
  assert.equal(claude.id, 'p-50773-54394');
  assert.equal(claude.state, 'waiting');
  assert.equal(claude.waitingFor, 'input needed');
  assert.equal(claude.since, 1790592874114);
  assert.equal(claude.title, 'Demo project work');
  assert.equal(claude.cwd, '~/work/demo');
  assert.deepEqual({ type: claude.where.type, address: claude.where.address, workspace: claude.where.workspace.id }, { type: 'terminal', address: '0xa1', workspace: 2 });
  assert.equal(claude.canReply, true);
  assert.equal(claude.transcript, true);
  assert.equal(claude.startedAt, BOOT * 1000 + 543940);
  // Windows without an agent stay listed as plain terminals, after the agents.
  assert.deepEqual(items.slice(1).map(item => [item.kind, item.id, item.state, item.canReply]), [['terminal', 'w-a2', 'terminal', false], ['terminal', 'w-a3', 'terminal', false]]);
  const transcript = await agents.transcript(claude.id);
  assert.equal(transcript.available, true);
  assert.deepEqual(transcript.messages.map(item => [item.role, item.text]), [['user', 'quais pendências ficaram?'], ['tool', 'Bash: List files'], ['assistant', 'Ficaram três pendências.']]);
  assert.ok(!JSON.stringify(transcript).includes('secret thoughts'));
  assert.ok(!JSON.stringify(items).includes('SECRET') && !JSON.stringify(items).includes('.jsonl'));
  await assert.rejects(agents.transcript('p-1-1'), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(agents.transcript('../../etc/passwd'), { code: 'AGENT_NOT_FOUND' });
});

test('an idle Claude that already worked in this process is ready; a fresh one stays idle; order is waiting, working, ready, idle, terminal', async t => {
  const w = await world(t);
  // Every process starts 100 s after boot (10000 ticks), so startedAt = BOOT + 100 s.
  const start = 10000, startedAt = BOOT * 1000 + 100000;
  const cwd = path.join(w.home, 'work', 'sample');
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const ids = { fresh: '00000000-0000-4000-8000-0000000000f1', done: '00000000-0000-4000-8000-0000000000f2', resumed: '00000000-0000-4000-8000-0000000000f3', stale: '00000000-0000-4000-8000-0000000000f4', busy: '00000000-0000-4000-8000-0000000000f5', asks: '00000000-0000-4000-8000-0000000000f6' };
  const claude = async (pid, key, status, { statusUpdatedAt = startedAt + 1000, writtenAt = null } = {}) => {
    await w.add(pid, 'foot', 1);
    await w.add(pid + 1, 'bash', pid);
    await w.add(pid + 2, 'claude', pid + 1, { cwd, start });
    await w.file(`.claude/sessions/${pid + 2}.json`, line({ pid: pid + 2, sessionId: ids[key], cwd, procStart: String(start), status, statusUpdatedAt, ...(status === 'waiting' ? { waitingFor: 'input needed' } : {}) }));
    if (writtenAt !== null) {
      const file = await w.file(`.claude/projects/${encoded}/${ids[key]}.jsonl`, line({ type: 'user', message: { role: 'user', content: 'sample request' } }));
      await utimes(file, writtenAt / 1000, writtenAt / 1000);
    }
  };
  // Idle, never asked anything: Claude has not created a transcript yet.
  await claude(1000, 'fresh', 'idle', { statusUpdatedAt: startedAt + 200000 });
  // Idle after a turn: the transcript was written after the process started.
  await claude(1100, 'done', 'idle', { statusUpdatedAt: startedAt + 60000, writtenAt: startedAt + 59000 });
  // Resumed: the transcript is older than the process, but the status moved after the start.
  await claude(1200, 'resumed', 'idle', { statusUpdatedAt: startedAt + 30000, writtenAt: startedAt - 86400000 });
  // Old transcript and no status change since the start: nothing done here.
  await claude(1300, 'stale', 'idle', { statusUpdatedAt: startedAt - 5000, writtenAt: startedAt - 86400000 });
  await claude(1400, 'busy', 'busy', { writtenAt: startedAt + 1000 });
  await claude(1500, 'asks', 'waiting', { writtenAt: startedAt + 1000 });
  // Only Claude has a real idle signal: a quiet Codex with a transcript stays idle.
  const rolloutDir = '.codex/sessions/2026/09/28';
  const rollout = await w.file(`${rolloutDir}/rollout-2026-09-28T08-00-00-${CODEX}.jsonl`, line({ type: 'session_meta', payload: { cwd } }));
  await utimes(rollout, (startedAt + 5000) / 1000, (startedAt + 5000) / 1000);
  await w.add(1600, 'foot', 1);
  await w.add(1601, 'bash', 1600);
  await w.add(1602, 'codex', 1601, { cwd, start, fds: [rollout] });
  await w.add(1700, 'foot', 1);
  const clients = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700].map((pid, index) => foot(pid, `0xe${index}`, pid === 1700 ? 'shell' : 'sample'));
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr(clients).runner, bootMs: BOOT * 1000, now: () => startedAt + 400000 });
  const { items } = await agents.list();
  const byPid = pid => items.find(item => item.pid === pid).state;
  assert.deepEqual([1002, 1102, 1202, 1302, 1402, 1502, 1602].map(byPid), ['idle', 'ready', 'ready', 'idle', 'working', 'waiting', 'idle']);
  assert.deepEqual(items.map(item => item.state), ['waiting', 'working', 'ready', 'ready', 'idle', 'idle', 'idle', 'terminal']);
  assert.equal(items.find(item => item.pid === 1102).since, startedAt + 60000);
});

test('a recycled pid ignores the stale session file; title glyphs then CPU and transcript writes decide the state', async t => {
  const w = await world(t);
  await w.add(100, 'foot', 1);
  await w.add(101, 'bash', 100);
  await w.add(102, 'claude', 101, { start: 777 });
  await w.file('.claude/sessions/102.json', line({ pid: 102, sessionId: SESSION, cwd: w.home, procStart: '12', status: 'idle' }));
  await w.add(200, 'foot', 1);
  await w.add(201, 'bash', 200);
  await w.add(202, 'claude', 201);
  await w.add(300, 'foot', 1);
  await w.add(301, 'bash', 300);
  await w.add(302, 'opencode', 301);
  const clients = [foot(100, '0xb1', '◑ Trabalhando'), foot(200, '0xb2', '✳ Parado'), foot(300, '0xb3', 'opencode')];
  let clock = 1790600000000;
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr(clients).runner, bootMs: BOOT * 1000, now: () => clock, cacheMs: 0 });
  let items = (await agents.list()).items;
  assert.equal(items.find(item => item.pid === 102).state, 'working');
  assert.equal(items.find(item => item.pid === 102).transcript, false);
  assert.equal(items.find(item => item.pid === 202).state, 'idle');
  assert.equal(items.find(item => item.pid === 302).state, 'idle');
  // 30 ticks of CPU in 2 s is 15% of a core.
  await w.burn(302, 30); clock += 2000;
  items = (await agents.list()).items;
  assert.equal(items.find(item => item.pid === 302).state, 'working');
  assert.equal(items.find(item => item.pid === 302).kind, 'opencode');
});

test('Maestri, headless Codex and nested agents: canvas name, open rollout or cwd match, only the top agent', async t => {
  const w = await world(t);
  const project = path.join(w.home, 'Projects', 'DailyWork');
  await w.add(114066, 'maestri-app', 1);
  await w.add(335119, 'bash', 114066, { environ: [`MAESTRI_WORKSPACE_ID=${MAESTRI_WS}`, `MAESTRI_TERMINAL_ID=${MAESTRI_TERM}`] });
  await w.add(336172, 'claude', 335119, { environ: [`MAESTRI_WORKSPACE_ID=${MAESTRI_WS}`, `MAESTRI_TERMINAL_ID=${MAESTRI_TERM}`] });
  await w.file(`.maestri/workspaces/${MAESTRI_WS}/workspace.json`, line({ payload: { nodes: [{ content: { terminal: { _0: { id: MAESTRI_TERM, name: 'Trilho' } } } }, { content: { note: {} } }] } }));
  // Codex started by an app, holding its rollout open.
  const rollout = await w.file(`.codex/sessions/2026/09/28/rollout-2026-09-28T08-01-58-${CODEX}.jsonl`, [
    line({ timestamp: '2026-09-28T11:01:58Z', type: 'session_meta', payload: { id: CODEX, cwd: project } }),
    line({ timestamp: '2026-09-28T11:01:59Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] } }),
    line({ timestamp: '2026-09-28T11:02:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
    line({ timestamp: '2026-09-28T11:02:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'resolve a pendência' }] } }),
    line({ timestamp: '2026-09-28T11:02:02Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' } }),
    line({ timestamp: '2026-09-28T11:02:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Continua incerta.' }] } }),
  ].join('\n'));
  await w.add(2034, 'dailywork', 1);
  await w.add(445116, 'codex', 2034, { argv: ['codex', 'exec', '--json'], cwd: project, fds: [rollout] });
  // A node wrapper that starts the codex binary is one agent, not two.
  await w.add(500, 'node', 2034, { argv: ['node', '/opt/codex/bin/codex.js'], cwd: project });
  await w.add(501, 'codex', 500, { cwd: project });
  // A claude -p with no window, no Maestri, nothing: listed, read-only.
  await w.add(600, 'claude', 1, { argv: ['claude', '-p', 'x'] });
  const clients = [{ pid: 114066, address: '0xm', title: 'DailyWork - Maestri', class: 'maestri-app', workspace: { id: -98, name: 'special:maestri' } }, { pid: 2034, address: '0xd', title: 'DailyWork', class: 'dailywork', workspace: { id: 3, name: '3' } }];
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr(clients).runner, bootMs: BOOT * 1000 });
  const { items } = await agents.list();
  const byPid = pid => items.find(item => item.pid === pid);
  assert.deepEqual([byPid(336172).title, byPid(336172).where.type, byPid(336172).canReply], ['Trilho', 'maestri', false]);
  assert.deepEqual([byPid(445116).kind, byPid(445116).where.type, byPid(445116).where.app, byPid(445116).headless, byPid(445116).transcript], ['codex', 'app', 'DailyWork', true, true]);
  assert.equal(byPid(501), undefined);
  assert.equal(byPid(500).kind, 'codex');
  assert.deepEqual([byPid(600).where.type, byPid(600).headless, byPid(600).canReply], ['none', true, false]);
  const read = await agents.transcript(byPid(445116).id);
  assert.deepEqual(read.messages.map(item => [item.role, item.text]), [['user', 'resolve a pendência'], ['tool', 'exec_command'], ['assistant', 'Continua incerta.']]);
  // Without an open fd, the rollout created in the same cwd after the start is used.
  const fallback = createAgents({ procRoot: w.proc, home: w.home, runner: hypr(clients).runner, bootMs: new Date(2026, 8, 28, 8, 1, 50).getTime() - 50000 }); // pid 500 starts 5000 ticks after boot: 08:01:50
  const wrapper = (await fallback.list()).items.find(item => item.pid === 500);
  assert.equal(wrapper.transcript, true);
});

test('an agent inside a Ponte tmux session is tied to that session through the pane pid', async t => {
  const w = await world(t);
  const dataDir = path.join(w.root, 'data');
  const socket = path.join(dataDir, 'terminals', 'tmux.sock');
  await w.add(700, 'tmux: server', 1, { argv: ['tmux', '-u', '-S', socket, '-f', '/dev/null', 'new-session'] });
  await w.add(701, 'bash', 700);
  await w.add(702, 'codex', 701);
  const base = hypr([]);
  const runner = async (command, args, options) => {
    if (command === 'tmux') {
      assert.deepEqual(args.slice(0, 3), ['-S', socket, '-N']);
      assert.equal(options.env.TMUX, undefined);
      return `ponte_${'a'.repeat(24)}\t701\nother\t9\n`;
    }
    return base.runner(command, args);
  };
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner, dataDir, env: { TMUX: '/tmp/x', PATH: '/usr/bin' }, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  assert.deepEqual([item.kind, item.where, item.canReply], ['codex', { type: 'ponte', session: 'a'.repeat(24) }, true]);
  const inputs = [];
  const result = await agents.reply(item.id, { text: 'continua' }, { terminals: { input: async (id, value) => inputs.push([id, value]) }, desktop: { action: async () => assert.fail('no desktop input for a Ponte session') } });
  assert.deepEqual(result, { ok: true, via: 'session' });
  assert.deepEqual(inputs, [['a'.repeat(24), { text: 'continua', enter: true }]]);
});

test('reply focuses the agent window, verifies focus before typing, and refuses when focus, lock or target fail', async t => {
  const w = await world(t);
  await w.add(100, 'foot', 1);
  await w.add(101, 'bash', 100);
  await w.add(102, 'claude', 101);
  await w.add(114066, 'maestri-app', 1);
  await w.add(114067, 'claude', 114066);
  const env = hypr([foot(100, '0xf1', '✳ agente'), { pid: 114066, address: '0xm', title: 'Maestri', class: 'maestri-app', workspace: { id: -98, name: 'm' } }]);
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: env.runner, bootMs: BOOT * 1000 });
  const { items } = await agents.list();
  const target = items.find(item => item.pid === 102);
  const actions = [];
  const desktop = { action: async value => { actions.push(value); if (value.type === 'window.focus') env.active.value = value.address; return { ok: true }; } };
  const noDelay = async () => {};
  assert.deepEqual(await agents.reply(target.id, { text: 'sim, pode seguir' }, { desktop, delay: noDelay }), { ok: true, via: 'window' });
  assert.deepEqual(actions, [{ type: 'window.focus', address: '0xf1' }, { type: 'keyboard.text', text: 'sim, pode seguir', enter: true }]);

  actions.length = 0; env.active.value = null;
  const stubborn = { action: async value => { actions.push(value); return { ok: true }; } };
  await assert.rejects(agents.reply(target.id, { text: 'x' }, { desktop: stubborn, delay: noDelay }), { code: 'AGENT_FOCUS_FAILED' });
  assert.deepEqual(actions.map(item => item.type), ['window.focus']);

  await assert.rejects(agents.reply(items.find(item => item.pid === 114067).id, { text: 'x' }, { desktop, delay: noDelay }), { code: 'AGENT_NOT_INTERACTIVE' });
  for (const value of [{ text: '' }, { text: 'a\nb' }, { text: 'x'.repeat(4001) }, { text: 'x', enter: false }, null]) await assert.rejects(agents.reply(target.id, value, { desktop }), { code: 'INVALID_TEXT' });

  const locked = createAgents({ procRoot: w.proc, home: w.home, bootMs: BOOT * 1000, runner: async (command, args) => command === 'omarchy-shell' ? 'true\n' : env.runner(command, args) });
  const lockedTarget = (await locked.list()).items.find(item => item.pid === 102);
  actions.length = 0;
  await assert.rejects(locked.reply(lockedTarget.id, { text: 'x' }, { desktop, delay: noDelay }), { code: 'AGENT_PC_LOCKED' });
  assert.equal(actions.length, 0);
});

test('transcript reading is a bounded tail: a partial first line is dropped and the byte cap keeps the newest messages', async t => {
  const big = [];
  for (let index = 0; index < 200; index++) big.push({ role: 'assistant', text: `m${index} ${'x'.repeat(2000)}`, at: index });
  const capped = lastMessages(big, 40, 20000);
  assert.ok(capped.messages.length < 40 && capped.truncated);
  assert.equal(capped.messages.at(-1).text.slice(0, 4), 'm199');
  assert.deepEqual(claudeMessages(['{"type":"assistant","message":{"content":[{"type":"text","text":"' + 'y'.repeat(5000) + '"}]}}']).map(item => item.text.length), [3000]);
  assert.deepEqual(codexMessages(['{"type":"event_msg","payload":{"type":"task_complete"}}', 'garbage']), []);

  const w = await world(t);
  await w.add(100, 'foot', 1);
  await w.add(101, 'bash', 100);
  await w.add(102, 'claude', 101, { start: 5 });
  await w.file('.claude/sessions/102.json', line({ pid: 102, sessionId: SESSION, cwd: w.home, procStart: '5', status: 'busy' }));
  const filler = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'z'.repeat(1000) }] } });
  const lines = [];
  for (let index = 0; index < 700; index++) lines.push(filler);
  lines.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a última' }] } }));
  await w.file(`.claude/projects/${w.home.replace(/[^a-zA-Z0-9]/g, '-')}/${SESSION}.jsonl`, lines.join('\n'));
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([foot(100, '0xc1', 'x')]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  const read = await agents.transcript(item.id);
  assert.equal(read.truncated, true);
  assert.equal(read.messages.at(-1).text, 'a última');
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 120 * 1024);
});

test('agent routes require pairing, validate ids and JSON, and serialize replies through the action queue', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-agents-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  const calls = [];
  const agents = {
    list: async () => ({ items: [{ id: 'p-1-2', kind: 'claude' }], scannedAt: 1, scanMs: 3 }),
    transcript: async id => { if (id !== 'p-1-2') { const { ApiError } = await import('../backend/process.mjs'); throw new ApiError(404, 'AGENT_NOT_FOUND'); } return { id, available: true, messages: [] }; },
    reply: async (id, value, deps) => { calls.push([id, value, typeof deps.desktop.action, typeof deps.terminals.input]); return { ok: true, via: 'window' }; },
  };
  const app = await createApp({ rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN, agents, desktop: { action: async () => ({}), getState: async () => ({}) }, terminals: { input: async () => ({}), list: async () => ({}) }, trustedHosts: [] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers } });
  assert.equal((await fetch(`${base}/api/agents`)).status, 401);
  assert.deepEqual(await (await request('/api/agents')).json(), { items: [{ id: 'p-1-2', kind: 'claude' }], scannedAt: 1, scanMs: 3 });
  assert.equal((await request('/api/agents/p-1-2/transcript')).status, 200);
  for (const suffix of ['?since=../../etc/passwd','?wait=-1','?wait=1&wait=2','?since='+ 'a'.repeat(32)+'&since='+ 'b'.repeat(32)]) assert.equal((await request('/api/agents/p-1-2/transcript'+suffix)).status,400);
  const missing = await request('/api/agents/p-9-9/transcript', { headers: { 'Accept-Language': 'pt-BR' } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Este agente ou terminal não está mais rodando.');
  assert.equal((await request('/api/agents/p-1-2/reply', { method: 'POST', body: '{"text":"oi"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/agents/p-1-2/reply', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await request('/api/agents/p-1-2/reply', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(30000) }), headers: { 'Content-Type': 'application/json' } })).status, 413);
  assert.deepEqual(await (await request('/api/agents/p-1-2/reply', { method: 'POST', body: '{"text":"oi"}', headers: { 'Content-Type': 'application/json' } })).json(), { ok: true, via: 'window' });
  assert.deepEqual(calls, [['p-1-2', { text: 'oi' }, 'function', 'function']]);
  assert.equal((await request('/api/agents/p-1-2/reply')).status, 404);
  assert.equal((await request('/api/agents/p-1-2/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});

test('a known live agent without a transcript discovers the session and file created later on the next transcript read', async t => {
  const w = await world(t);
  const cwd = path.join(w.home, 'work', 'late-transcript-fixture');
  await w.add(102, 'claude', 1, { cwd, start: AGENT_START });
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  assert.equal(item.id, `p-102-${AGENT_START}`);
  assert.equal(item.transcript, false);
  const unavailable = await agents.transcript(item.id);
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.messages, []);

  await w.file('.claude/sessions/102.json', line({ pid: 102, sessionId: SESSION, cwd, procStart: String(AGENT_START), status: 'idle' }));
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  await w.file(`.claude/projects/${encoded}/${SESSION}.jsonl`, `${line({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z', message: { content: [{ type: 'text', text: 'Transcrição criada depois.' }] } })}\n`);
  // Do not refresh list: the next read of this exact id must rediscover it.
  const available = await agents.transcript(item.id);
  assert.equal(available.id, item.id);
  assert.equal(available.available, true);
  assert.deepEqual(available.messages.map(message => [message.role, message.text]), [['assistant', 'Transcrição criada depois.']]);
});

test('transcript cursor sends only appended messages, unchanged is small, partial records survive and rotation resets', async t => {
  const w = await world(t);
  await w.add(100,'foot',1);
  await w.add(101,'bash',100);
  await w.add(102,'claude',101,{start:5});
  await w.file('.claude/sessions/102.json',line({sessionId:SESSION,procStart:'5',status:'busy'}));
  const message = (text,at) => line({type:'assistant',timestamp:at,message:{content:[{type:'text',text}]}});
  const file = await w.file(`.claude/projects/${w.home.replace(/[^a-zA-Z0-9]/g,'-')}/${SESSION}.jsonl`,message('first','2026-09-28T10:00:00Z')+'\n');
  const agents = createAgents({procRoot:w.proc,home:w.home,runner:hypr([foot(100,'0xc1','sample')]).runner,bootMs:BOOT*1000});
  const item = (await agents.list()).items[0];
  const initial = await agents.transcript(item.id);
  assert.match(initial.cursor,/^[a-f0-9]{32}$/);
  assert.equal(initial.reset,true);
  assert.equal(initial.messages.length,1);
  const idle = await agents.transcript(item.id,{since:initial.cursor});
  assert.equal(idle.unchanged,true);
  assert.deepEqual(idle.messages,[]);
  assert.ok(Buffer.byteLength(JSON.stringify(idle))<400);
  const second = message('ação nova','2026-09-28T10:00:01Z');
  const bytes = Buffer.from(second);
  const split = bytes.indexOf(Buffer.from('ç'))+1;
  await appendFile(file,bytes.subarray(0,split));
  const partial = await agents.transcript(item.id,{since:initial.cursor});
  assert.equal(partial.reset,false);
  assert.deepEqual(partial.messages,[]);
  await appendFile(file,Buffer.concat([bytes.subarray(split),Buffer.from('\n')]));
  const delta = await agents.transcript(item.id,{since:partial.cursor});
  assert.equal(delta.reset,false);
  assert.deepEqual(delta.messages.map(m=>m.text),['ação nova']);
  assert.notEqual(delta.cursor,partial.cursor);
  assert.ok(!JSON.stringify(delta).includes('.jsonl'));
  await writeFile(file,message('rotated','2026-09-28T10:00:02Z')+'\n');
  const rotated = await agents.transcript(item.id,{since:delta.cursor});
  assert.equal(rotated.reset,true);
  assert.deepEqual(rotated.messages.map(m=>m.text),['rotated']);
  const unknown = await agents.transcript(item.id,{since:'f'.repeat(32)});
  assert.equal(unknown.reset,true);
  assert.deepEqual(unknown.messages.map(m=>m.text),['rotated']);
});

test('JCode transcript cursor follows journal appends and resets safely when journal folds into snapshot',async t=>{
  const w=await world(t);
  await w.add(200,'jcode',1,{start:5});
  const sid='session_lab_cursor_0001';
  await w.file('.jcode/client_sessions/200',sid);
  const m=(id,text)=>({id,role:'assistant',timestamp:'2026-09-28T10:00:00Z',content:[{type:'text',text}]});
  const first=m('message_1_1','first');
  const snapshot=await w.file(`.jcode/sessions/${sid}.json`,line({messages:[first],provider_key:'lab',model:'lab-model'}));
  const journal=await w.file(`.jcode/sessions/${sid}.journal.jsonl`,line({meta:{model:'lab-model'},append_messages:[m('message_2_2','second')]})+'\n');
  const agents=createAgents({procRoot:w.proc,home:w.home,runner:hypr([]).runner,bootMs:BOOT*1000});
  const item=(await agents.list()).items[0];
  const initial=await agents.transcript(item.id);
  assert.deepEqual(initial.messages.map(m=>m.text),['first','second']);
  await appendFile(journal,line({append_messages:[m('message_3_3','third')]})+'\n');
  const delta=await agents.transcript(item.id,{since:initial.cursor});
  assert.equal(delta.reset,false);
  assert.deepEqual(delta.messages.map(m=>m.text),['third']);
  await writeFile(snapshot,line({messages:[first,m('message_2_2','second'),m('message_3_3','third')],provider_key:'lab',model:'lab-model'}));
  await writeFile(journal,'');
  const folded=await agents.transcript(item.id,{since:delta.cursor});
  assert.deepEqual(folded.messages,[]);
  const full=await agents.transcript(item.id);
  assert.deepEqual(full.messages.map(m=>m.text),['first','second','third']);
});

test('the same live JCode pid discovers a changed client session mapping without a list refresh', async t => {
  const w = await world(t);
  await w.add(102, 'jcode', 1, { start: AGENT_START });
  await jcodeFiles(w, 102, JCODE_A, { messages: [
    jcodeMessage('00000000-0000-4000-8000-0000000000e1', 'assistant', [{ type: 'text', text: 'Sessão alfa da fixture.' }]),
  ] });
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  const initial = await agents.transcript(item.id);
  assert.deepEqual(initial.messages.map(message => message.text), ['Sessão alfa da fixture.']);
  await jcodeFiles(w, 102, JCODE_B, { writtenAt: AGENT_WRITTEN_AT + 1000, messages: [
    jcodeMessage('00000000-0000-4000-8000-0000000000e2', 'assistant', [{ type: 'text', text: 'Sessão beta da fixture.' }], 1),
  ] });
  const changed = await agents.transcript(item.id, { since: initial.cursor });
  assert.equal(changed.id, item.id);
  assert.equal(changed.available, true);
  assert.notEqual(changed.cursor, initial.cursor);
  assert.equal(changed.reset, true);
  assert.deepEqual(changed.messages.map(message => message.text), ['Sessão beta da fixture.']);
  assert.deepEqual((await agents.transcript(item.id)).messages.map(message => message.text), ['Sessão beta da fixture.']);
});

test('truncate and regrow of the same transcript inode resets rewritten text even when the last 64 cached bytes match', async t => {
  const w = await world(t);
  await w.add(102, 'claude', 1, { start: AGENT_START });
  await w.file('.claude/sessions/102.json', line({ sessionId: SESSION, procStart: String(AGENT_START), status: 'busy' }));
  const message = text => `${line({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z', message: { content: [{ type: 'text', text }] } })}\n`;
  const suffix = ' checkpoint fixture '.repeat(8);
  const before = message(`Texto antigo.${suffix}`), rewritten = message(`Texto refeito${suffix}`);
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(rewritten), 'rewrite keeps the old record boundary');
  assert.ok(Buffer.from(before).subarray(-64).equals(Buffer.from(rewritten).subarray(-64)), 'same checkpoint at the old EOF');
  const file = await w.file(`.claude/projects/${w.home.replace(/[^a-zA-Z0-9]/g, '-')}/${SESSION}.jsonl`, before);
  await utimes(file, AGENT_WRITTEN_AT / 1000, AGENT_WRITTEN_AT / 1000);
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  const initial = await agents.transcript(item.id);
  assert.deepEqual(initial.messages.map(entry => entry.text), [`Texto antigo.${suffix}`.trim()]);
  const oldStat = await stat(file);
  // writeFile truncates in place, then the new record grows past the old EOF.
  await writeFile(file, rewritten + message('Mensagem nova após rewrite.'));
  await utimes(file, (AGENT_WRITTEN_AT + 1000) / 1000, (AGENT_WRITTEN_AT + 1000) / 1000);
  const newStat = await stat(file);
  assert.equal(newStat.ino, oldStat.ino);
  assert.equal(newStat.dev, oldStat.dev);
  assert.ok(newStat.size > oldStat.size);
  const changed = await agents.transcript(item.id, { since: initial.cursor });
  assert.equal(changed.reset, true);
  assert.deepEqual(changed.messages.map(entry => entry.text), [`Texto refeito${suffix}`.trim(), 'Mensagem nova após rewrite.']);
  assert.deepEqual((await agents.transcript(item.id)).messages.map(entry => entry.text), changed.messages.map(entry => entry.text));
});

test('a removed transcript stays unavailable when subsequent reads reuse the missing-file cursor', async t => {
  const w = await world(t);
  await w.add(102, 'claude', 1, { start: AGENT_START });
  await w.file('.claude/sessions/102.json', line({ sessionId: SESSION, procStart: String(AGENT_START), status: 'busy' }));
  const file = await w.file(`.claude/projects/${w.home.replace(/[^a-zA-Z0-9]/g, '-')}/${SESSION}.jsonl`, `${line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Mensagem antes de remover.' }] } })}\n`);
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  const initial = await agents.transcript(item.id);
  assert.equal(initial.available, true);
  await rm(file);
  const missing = await agents.transcript(item.id, { since: initial.cursor });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.messages, []);
  assert.match(missing.cursor, /^[a-f0-9]{32}$/);
  const again = await agents.transcript(item.id, { since: missing.cursor });
  assert.equal(again.available, false);
  assert.deepEqual(again.messages, []);
  assert.equal((await agents.transcript(item.id)).available, false);
});

test('Claude replaces its newest-file fallback when a valid PID session mapping appears without a list refresh', async t => {
  const w = await world(t);
  const cwd = path.join(w.home, 'work', 'claude-fallback-fixture');
  const sessionB = '00000000-0000-4000-8000-000000000002';
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const message = text => `${line({ type: 'assistant', timestamp: '2026-09-28T10:00:00Z', message: { content: [{ type: 'text', text }] } })}\n`;
  await w.add(102, 'claude', 1, { cwd, start: AGENT_START });
  // No sessions/102.json yet, so the single live Claude uses newestClaudeFile.
  const fallback = await w.file(`.claude/projects/${encoded}/${SESSION}.jsonl`, message('Transcript alfa por fallback.'));
  await utimes(fallback, (AGENT_WRITTEN_AT + 2000) / 1000, (AGENT_WRITTEN_AT + 2000) / 1000);
  const agents = createAgents({ procRoot: w.proc, home: w.home, runner: hypr([]).runner, bootMs: BOOT * 1000 });
  const [item] = (await agents.list()).items;
  assert.equal(item.transcript, true);
  const initial = await agents.transcript(item.id);
  assert.deepEqual(initial.messages.map(entry => entry.text), ['Transcript alfa por fallback.']);

  const mapped = await w.file(`.claude/projects/${encoded}/${sessionB}.jsonl`, message('Transcript beta mapeado.'));
  await utimes(mapped, AGENT_WRITTEN_AT / 1000, AGENT_WRITTEN_AT / 1000);
  await w.file('.claude/sessions/102.json', line({ pid: 102, sessionId: sessionB, cwd, procStart: String(AGENT_START), status: 'idle' }));
  // Alfa stays newer than beta, proving that the mapping must override fallback.
  const changed = await agents.transcript(item.id, { since: initial.cursor });
  assert.equal(changed.id, item.id);
  assert.equal(changed.available, true);
  assert.notEqual(changed.cursor, initial.cursor);
  assert.notEqual(changed.unchanged, true);
  assert.equal(changed.reset, true);
  assert.deepEqual(changed.messages.map(entry => entry.text), ['Transcript beta mapeado.']);
  assert.deepEqual((await agents.transcript(item.id)).messages.map(entry => entry.text), ['Transcript beta mapeado.']);
});

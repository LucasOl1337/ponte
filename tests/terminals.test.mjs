import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, access, symlink, realpath, chmod } from 'node:fs/promises';
import { createTerminals, sanitizeAnsi, TERMINAL_ANSI_LIMIT, TERMINAL_TEXT_LIMIT } from '../backend/terminals.mjs';
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
    if (args[0] === 'display-message') {
      const pane = panes.find(pane => pane.paneId === args[3]);
      if (!pane) throw new Error("can't find pane");
      const cursor = args[4].includes('cursor_x') ? `\t${pane.cursor || '0\t0\t1\t0'}` : '';
      return `${line(pane)}${cursor}\n${args[5] === ';' && args[6] === 'capture-pane' ? capture : ''}`;
    }
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

test('a session can start an allowlisted agent with the request as one argv word, never shell text', async t => {
  const { root, mock, terminals } = await fixture(t);
  const looked = [];
  const agentTerminals = createTerminals(root, { ...mock, exists: async (name, env) => { looked.push(name); assert.equal(env.TMUX, undefined); return true; } });
  t.after(() => agentTerminals.close());
  const prompt = "revisa o README; $(touch /tmp/pwned) `id` #{pane_id} -- -t %9\nsegunda linha";
  const claude = await agentTerminals.create({ cols: 80, rows: 24, agent: 'claude', prompt });
  const codex = await agentTerminals.create({ cols: 80, rows: 24, agent: 'codex' });
  const shell = await agentTerminals.create({ cols: 80, rows: 24, agent: 'shell' });
  assert.deepEqual([claude.title, codex.title, shell.title], ['Claude 1', 'Codex 2', 'Terminal 3']);
  assert.deepEqual(looked, ['tmux', 'claude', 'tmux', 'codex', 'tmux']);
  const launches = mock.calls.filter(call => call.args.includes('new-session')).map(call => call.args.slice(call.args.indexOf('-y') + 2));
  assert.deepEqual(launches, [
    ['--', '/bin/sh', '-c', '"$@"; exec "${SHELL:-/bin/sh}" -l', 'ponte-agent', 'claude', prompt],
    ['--', '/bin/sh', '-c', '"$@"; exec "${SHELL:-/bin/sh}" -l', 'ponte-agent', 'codex'],
    [],
  ]);
  // The request is only ever the last argv word; nothing is typed or buffered.
  assert.equal(mock.calls.some(call => ['load-buffer', 'paste-buffer', 'send-keys'].some(word => call.argv.includes(word))), false);
  await agentTerminals.remove(claude.id);
  assert.equal((await agentTerminals.create({ cols: 80, rows: 24, agent: 'codex' })).title, 'Codex 1');
  await agentTerminals.close();
  const restored = createTerminals(root, mock);
  t.after(() => restored.close());
  assert.deepEqual((await restored.list()).sessions.map(item => item.title), ['Codex 2', 'Terminal 3', 'Codex 1']);
});

test('agents, requests and projects outside the allowlist fail before any command', async t => {
  const { mock, terminals } = await fixture(t);
  const base = { cols: 80, rows: 24 };
  for (const agent of ['bash', 'sh', 'Claude', 'claude ', 'claude; rm -rf ~', '__proto__', 'toString', '', 1, null, ['claude']]) {
    assert.throws(() => terminals.create({ ...base, agent }), { code: 'AGENT_NOT_ALLOWED' });
  }
  for (const [agent, prompt] of [['claude', ''], ['claude', '   '], ['claude', '-p leak'], ['codex', ' --yolo'], ['claude', 'a\rb'], ['claude', '\x1b[2J'], ['claude', 'x'.repeat(4001)], ['claude', '\ud800'], ['claude', 42], ['shell', 'a\nb'], ['shell', ''], [undefined, null]]) {
    assert.throws(() => terminals.create({ ...base, ...(agent ? { agent } : {}), prompt }), { code: 'INVALID_PROMPT' }, `${agent} ${JSON.stringify(prompt)}`);
  }
  for (const project of ['', '.', '..', '../etc', 'a/b', '.ssh', '-x', 'x'.repeat(65), 5, null]) {
    assert.throws(() => terminals.create({ ...base, agent: 'claude', project }), { code: 'PROJECT_NOT_ALLOWED' });
  }
  assert.throws(() => terminals.create({ ...base, agent: 'claude', command: 'sh' }), { code: 'INVALID_TERMINAL_SIZE' });
  assert.equal(mock.calls.length, 0);
});

test('a missing agent or project starts nothing, and a project resolves inside ~/Projects only', async t => {
  const root = await temporary(t), mock = mockedTmux();
  const projects = path.join(root, 'Projects');
  await mkdir(path.join(projects, 'ponte'), { recursive: true });
  await mkdir(path.join(root, 'outside'));
  await symlink(path.join(root, 'outside'), path.join(projects, 'escape'));
  await writeFile(path.join(projects, 'notes.txt'), '');
  const terminals = createTerminals(root, { ...mock, projectsDir: projects, exists: async name => name === 'tmux' });
  t.after(() => terminals.close());
  await assert.rejects(terminals.create({ cols: 80, rows: 24, agent: 'codex' }), { code: 'AGENT_UNAVAILABLE', message: 'Codex is not installed on the PC.' });
  for (const project of ['escape', 'notes.txt', 'missing']) await assert.rejects(terminals.create({ cols: 80, rows: 24, project }), { code: 'PROJECT_NOT_ALLOWED' });
  assert.equal(mock.calls.some(call => call.args.includes('new-session')), false);
  await terminals.create({ cols: 80, rows: 24, project: 'ponte' });
  const created = mock.calls.find(call => call.args.includes('new-session')).args;
  assert.equal(created[created.indexOf('-c') + 1], path.join(await realpath(projects), 'ponte'));
});

test('a shell started with a first line types it through the buffer and runs it', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24, agent: 'shell', prompt: 'git status; $(echo x)' });
  assert.equal(session.title, 'Terminal 1');
  assert.equal(mock.calls.find(call => call.args[0] === 'load-buffer').options.input, 'git status; $(echo x)');
  assert.equal(mock.calls.some(call => call.argv.some(arg => arg.includes('echo x'))), false);
  const pasteIndex = mock.calls.findIndex(call => call.argv.includes('paste-buffer'));
  const enterIndex = mock.calls.findIndex(call => call.argv.includes('send-keys') && call.argv.includes('Enter'));
  assert.ok(pasteIndex >= 0 && enterIndex > pasteIndex);
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
  assert.deepEqual(mock.calls.filter(call => call.args.includes('capture-pane')).at(-1).args.slice(-2), ['-S', '-1000'], 'the reader gets the whole tmux history');
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
  const readBefore = mock.calls.length;
  await assert.rejects(terminals.read(session.id), { code: 'TERMINAL_CHANGED' }, 'a replaced pane is never read');
  assert.equal(mock.calls.slice(readBefore).some(call => call.args[0] === 'capture-pane'), false);
  mock.panes[0].paneId = '%0';
  await terminals.remove(session.id);
  assert.deepEqual((await terminals.list()).sessions, []);
  await assert.rejects(terminals.read(session.id), { code: 'TERMINAL_NOT_FOUND' });
});

test('a read is one tmux call, and given the hash of what the phone shows it answers unchanged without the text', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  mock.setCapture('prompt $ ls\nfile.txt\n');
  let before = mock.calls.length;
  const first = await terminals.read(session.id);
  assert.equal(mock.calls.length - before, 1, 'pane check and capture share one spawn');
  assert.deepEqual(mock.calls.at(-1).args.slice(0, 4), ['display-message', '-p', '-t', session.paneId || mock.panes[0].paneId]);
  assert.equal(first.text, 'prompt $ ls\nfile.txt\n');
  assert.match(first.hash, /^[A-Za-z0-9_-]{22}$/);
  const same = await terminals.read(session.id, { since: first.hash });
  assert.deepEqual({ unchanged: same.unchanged, hash: same.hash, text: same.text, inMode: same.inMode }, { unchanged: true, hash: first.hash, text: undefined, inMode: false });
  mock.setCapture('prompt $ ls\nfile.txt\nprompt $ \n');
  const changed = await terminals.read(session.id, { since: first.hash });
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.text, 'prompt $ ls\nfile.txt\nprompt $ \n');
  assert.notEqual(changed.hash, first.hash);
  // A malformed hash is ignored, never echoed as unchanged.
  for (const since of ['', 'x'.repeat(65), 'a/b', 42]) assert.equal(typeof (await terminals.read(session.id, { since })).text, 'string');
  // The listing and the read never rewrite the registry, even when a session vanished.
  before = mock.calls.length;
  mock.panes.length = 0;
  assert.deepEqual((await terminals.list()).sessions, []);
  await assert.rejects(terminals.read(session.id), { code: 'TERMINAL_NOT_FOUND' });
});

test('the ANSI sanitizer keeps SGR colours and drops every other escape, string command and control whole', () => {
  const sgr = '\x1b[0m\x1b[1;31mred\x1b[38;5;208m256\x1b[38;2;10;20;30mtrue\x1b[48:2::1:2:3mcolon\x1b[39;49m';
  assert.equal(sanitizeAnsi(sgr), sgr);
  const cases = [
    ['\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['\x1b]0;title\x07after', 'after'],
    ['\x1b]52;c;ZXZpbA==\x07clip', 'clip'],
    ['\x1bPq#0;2;0;0;0\x1b\\dcs', 'dcs'],
    ['\x1b_apc\x1b\\x', 'x'],
    ['a\x1b[2Jb\x1b[10;5Hc\x1b[?25ld\x1b[?1049he\x1b[Kf\x1b[3Ag', 'abcdefg'],
    ['\x1b7save\x1b8\x1b(Bcharset\x1bM', 'savecharset'],
    ['c1\x9b31mcsi\x9d0;t\x9cosc\x90dcs\x9cend\x85', 'c1csioscend'],
    ['nul\x00bel\x07bs\x08cr\rdel\x7f\ttab\nline', 'nulbelbscrdel\ttab\nline'],
    ['long\x1b[' + '1;'.repeat(40) + 'm!', 'long!'],
    ['cut \x1b]8;;http://x', 'cut '],
    ['trail\x1b', 'trail'],
    ['\x1b[31m😀 ação\x1b[0m', '\x1b[31m😀 ação\x1b[0m'],
  ];
  for (const [input, output] of cases) assert.equal(sanitizeAnsi(input), output, JSON.stringify(input));
  // Whatever survives is printable text, newlines, tabs and well-formed SGR only.
  const noise = Array.from({ length: 4000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join('');
  assert.equal(sanitizeAnsi(noise).replace(/\x1b\[[0-9;:]{0,64}m/g, '').match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/), null);
});

test('format=ansi reads colours, cursor and alternate screen in one tmux call; the plain read is unchanged', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  mock.setCapture('\x1b[31mred\x1b[39m\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\n\x1b[1m> \x1b[0m\n');
  mock.panes[0].cursor = '2\t1\t0\t1';
  let before = mock.calls.length;
  const ansi = await terminals.read(session.id, { format: 'ansi' });
  assert.equal(mock.calls.length - before, 1, 'pane check, cursor and capture share one spawn');
  const args = mock.calls.at(-1).args;
  assert.deepEqual(args.slice(0, 3), ['display-message', '-p', '-t']);
  assert.match(args[4], /#\{cursor_x\}\t#\{cursor_y\}\t#\{cursor_flag\}\t#\{alternate_on\}$/);
  assert.deepEqual(args.slice(5), [';', 'capture-pane', '-p', '-e', '-t', mock.panes[0].paneId, '-S', '-1000']);
  assert.equal(ansi.text, '\x1b[31mred\x1b[39mlink\n\x1b[1m> \x1b[0m\n');
  assert.deepEqual(ansi.cursor, { x: 2, y: 1, visible: false });
  assert.equal(ansi.alternate, true);
  assert.deepEqual(Object.keys(ansi).sort(), ['alternate', 'attachCommand', 'cols', 'cursor', 'hash', 'id', 'inMode', 'rows', 'text', 'title']);
  const same = await terminals.read(session.id, { format: 'ansi', since: ansi.hash });
  assert.equal(same.unchanged, true); assert.equal(same.text, undefined); assert.deepEqual(same.cursor, ansi.cursor);
  mock.panes[0].cursor = '3\t1\t0\t1';
  const moved = await terminals.read(session.id, { format: 'ansi', since: ansi.hash });
  assert.equal(moved.unchanged, undefined, 'a moved cursor is a change'); assert.equal(moved.cursor.x, 3);
  // Without format=ansi the answer keeps today's exact shape and plain text.
  before = mock.calls.length;
  for (const format of [undefined, 'plain', 'ANSI', '']) {
    const plain = await terminals.read(session.id, { format });
    assert.deepEqual(Object.keys(plain).sort(), ['attachCommand', 'cols', 'hash', 'id', 'inMode', 'rows', 'text', 'title']);
    assert.equal(plain.text, '[31mred[39m]8;;http://x\\link]8;;\\\n[1m> [0m\n');
  }
  assert.equal(mock.calls.slice(before).some(call => call.args.includes('-e')), false);
  // A malformed cursor line is never trusted.
  mock.panes[0].cursor = '2\tx\t0\t1';
  await assert.rejects(terminals.read(session.id, { format: 'ansi' }), { code: 'TERMINAL_UNAVAILABLE' });
});

test('format=ansi is bounded at a line boundary and a replaced pane is never read', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  const line = i => `\x1b[38;2;1;2;3mlinha ${String(i).padStart(5, '0')} ${'😀'.repeat(20)}\x1b[0m`;
  mock.setCapture(Array.from({ length: 3000 }, (_, i) => line(i)).join('\n') + '\nFIM\n');
  const read = await terminals.read(session.id, { format: 'ansi' });
  assert.ok(Buffer.byteLength(read.text) <= TERMINAL_ANSI_LIMIT);
  assert.ok(Buffer.byteLength(read.text) > TERMINAL_ANSI_LIMIT - 200);
  assert.ok(read.text.startsWith('\x1b[38;2;1;2;3mlinha '), 'the cut starts a whole line, never mid-SGR');
  assert.ok(read.text.endsWith('\nFIM\n'));
  assert.ok(read.text.isWellFormed());
  assert.equal(mock.calls.at(-1).options.maxBuffer, 4 * 1024 * 1024);
  mock.panes[0].paneId = '%999';
  const before = mock.calls.length;
  await assert.rejects(terminals.read(session.id, { format: 'ansi' }), { code: 'TERMINAL_CHANGED' });
  assert.equal(mock.calls.slice(before).some(call => call.args.includes('capture-pane') && call.args.includes('%999')), false);
});

test('phone key names map to fixed tmux keys, and one typed character is sent as a key, never pasted', async t => {
  const { mock, terminals } = await fixture(t);
  const session = await terminals.create({ cols: 80, rows: 24 });
  const expected = {
    Enter: 'Enter', Tab: 'Tab', ShiftTab: 'BTab', Escape: 'Escape', BackSpace: 'BSpace', Delete: 'DC',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
    PageUp: 'PPage', PageDown: 'NPage', Interrupt: 'C-c', 'Ctrl+A': 'C-a', 'Ctrl+D': 'C-d', 'Ctrl+E': 'C-e',
    'Ctrl+L': 'C-l', 'Ctrl+O': 'C-o', 'Ctrl+R': 'C-r', 'Ctrl+T': 'C-t', 'Ctrl+U': 'C-u', 'Ctrl+W': 'C-w', 'Ctrl+Z': 'C-z',
  };
  for (const [key, tmuxKey] of Object.entries(expected)) {
    await terminals.input(session.id, { key });
    const call = mock.calls.at(-1);
    assert.deepEqual(call.args, ['send-keys', '-t', mock.panes[0].paneId, tmuxKey], key);
    assert.equal(mock.calls.at(-2).args[0], 'if-shell', `${key} goes through the copy-mode guard`);
  }
  const before = mock.calls.length;
  for (const key of ['Ctrl+C', 'Ctrl+B', 'C-a', 'BTab', 'F1', 'Ctrl+a', 'ctrl+a', 'Ctrl+A ', 'Shift+Tab']) assert.throws(() => terminals.input(session.id, { key }), { code: 'KEY_NOT_ALLOWED' }, key);
  assert.equal(mock.calls.length, before);
  // One character: its UTF-8 bytes as hex words, then Enter when asked; no buffer is loaded.
  for (const [text, hex] of [['1', ['31']], ['/', ['2f']], [';', ['3b']], ['ç', ['c3', 'a7']], ['😀', ['f0', '9f', '98', '80']]]) {
    const start = mock.calls.length;
    await terminals.input(session.id, { text });
    const sent = mock.calls.slice(start);
    assert.equal(sent.some(call => call.args[0] === 'load-buffer' || call.args.includes('paste-buffer')), false, text);
    assert.deepEqual(sent.at(-1).args, ['send-keys', '-H', '-t', mock.panes[0].paneId, ...hex], text);
    assert.ok(/^[0-9a-f ]+$/.test(sent.at(-2).args.at(-1).split(' ').slice(4).join(' ')), 'the tmux command string holds only hex words');
  }
  let start = mock.calls.length;
  await terminals.input(session.id, { text: '2', enter: true });
  assert.deepEqual(mock.calls.slice(start).filter(call => call.args[0] === 'send-keys').map(call => call.args.slice(-1)[0]), ['32', 'Enter']);
  start = mock.calls.length;
  await terminals.input(session.id, { text: 'ok' });
  assert.equal(mock.calls.slice(start).find(call => call.args[0] === 'load-buffer').options.input, 'ok', 'two characters are still pasted');
});

test('typed input never waits behind an output read that is still running', async t => {
  const { root, mock } = await fixture(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const order = [];
  const terminals = createTerminals(root, { ...mock, runner: async (...args) => {
    if (args[1].includes('capture-pane')) {
      started(); order.push('read started');
      await new Promise(resolve => { release = resolve; });
      order.push('read finished');
    }
    return mock.runner(...args);
  } });
  const session = await terminals.create({ cols: 80, rows: 24 });
  const reading = terminals.read(session.id);
  await entered;
  await terminals.input(session.id, { text: 'ls', enter: true });
  order.push('input done');
  await terminals.input(session.id, { key: 'Interrupt' });
  order.push('key done');
  release();
  assert.equal(typeof (await reading).text, 'string');
  assert.deepEqual(order, ['read started', 'input done', 'key done', 'read finished']);
  assert.ok(mock.calls.some(call => call.args[0] === 'paste-buffer'), 'the text was pasted while the read was blocked');
  await terminals.close();
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
  const full = await (await request(`/api/terminals/${session.id}`)).json();
  assert.equal(typeof full.text, 'string');
  const same = await (await request(`/api/terminals/${session.id}?since=${full.hash}`)).json();
  assert.deepEqual([same.unchanged, same.text, same.hash], [true, undefined, full.hash], 'HTTP passes the shown hash through');
  const ansi = await (await request(`/api/terminals/${session.id}?format=ansi`)).json();
  assert.deepEqual([typeof ansi.text, ansi.cursor, ansi.alternate], ['string', { x: 0, y: 0, visible: true }, false], 'HTTP passes format=ansi through');
  const ansiSame = await (await request(`/api/terminals/${session.id}?format=ansi&since=${ansi.hash}`)).json();
  assert.deepEqual([ansiSame.unchanged, ansiSame.text], [true, undefined]);
  mock.panes[0].inMode = true;
  const inMode = await request(`/api/terminals/${session.id}/input`, 'POST', { key: 'Enter' }, { 'Accept-Language': 'pt' });
  assert.equal(inMode.status, 409);
  assert.deepEqual(await inMode.json(), { errorCode: 'TERMINAL_IN_COPY_MODE', errorParameters: {}, error: 'Este terminal está no modo de cópia. Saia desse modo no terminal do PC antes de enviar comandos.' });
  mock.panes[0].inMode = false;
  assert.deepEqual(await (await request(`/api/terminals/${session.id}/input`, 'POST', { text: 'hello' })).json(), { ok: true });
  assert.equal((await request(`/api/terminals/${session.id}/resize`, 'POST', { cols: 40, rows: 16 })).status, 200);
  assert.equal((await request(`/api/terminals/${session.id}`, 'DELETE')).status, 200);
  const agent = await request('/api/terminals', 'POST', { cols: 40, rows: 24, agent: 'codex', prompt: 'olá' });
  assert.equal(agent.status, 201);
  assert.equal((await agent.json()).title, 'Codex 1');
  const refused = await request('/api/terminals', 'POST', { cols: 40, rows: 24, agent: 'bash' }, { 'Accept-Language': 'pt' });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { errorCode: 'AGENT_NOT_ALLOWED', errorParameters: {}, error: 'Escolha Claude, Codex ou Terminal para começar uma sessão.' });
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

test('real isolated tmux runs a fake agent with the literal request in its project, then keeps a shell', async t => {
  if (!await commandExists('tmux')) { t.skip('tmux is not installed'); return; }
  const root = await temporary(t, false);
  const bin = path.join(root, 'bin');
  await mkdir(bin); await mkdir(path.join(root, 'Projects', 'demo'), { recursive: true });
  // A stand-in for the agent CLI: records its argv and folder, then exits.
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s" "$PWD" > "$HOME/agent-cwd"\nfor word in "$@"; do printf "[%s]" "$word"; done > "$HOME/agent-argv"\n');
  await chmod(path.join(bin, 'claude'), 0o700);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_RUNTIME_DIR: root, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8' };
  const socketPath = path.join(root, 'terminals', 'tmux.sock');
  const terminals = createTerminals(root, { env });
  t.after(async () => {
    await terminals.close();
    await runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', 'kill-server'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const marker = path.join(root, 'pwned');
  const prompt = `corrige o bug; $(touch '${marker}') \`touch '${marker}'\` "aspas" 'simples' $HOME\ncom quebra`;
  const session = await terminals.create({ cols: 80, rows: 24, agent: 'claude', prompt, project: 'demo' });
  assert.equal(session.title, 'Claude 1');
  let argv;
  for (let tries = 0; tries < 80 && argv === undefined; tries++) {
    try { argv = await readFile(path.join(root, 'agent-argv'), 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.equal(argv, `[${prompt}]`);
  assert.equal(await readFile(path.join(root, 'agent-cwd'), 'utf8'), path.join(await realpath(root), 'Projects', 'demo'));
  await assert.rejects(access(marker), { code: 'ENOENT' });
  // The agent exited; the session is still there with a usable shell.
  const after = await terminals.list();
  assert.deepEqual(after.sessions.map(item => item.id), [session.id]);
  const done = path.join(root, 'shell-ok');
  await terminals.input(session.id, { text: `touch '${done}'`, enter: true });
  for (let tries = 0; tries < 80; tries++) { try { await access(done); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  await access(done);
  await terminals.remove(session.id);
});

test('real isolated tmux gives format=ansi colours, the visible cursor and the alternate screen', async t => {
  if (!await commandExists('tmux')) { t.skip('tmux is not installed'); return; }
  const root = await temporary(t, false);
  const env = { PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: root, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8' };
  const socketPath = path.join(root, 'terminals', 'tmux.sock');
  const terminals = createTerminals(root, { env });
  t.after(async () => {
    await terminals.close();
    await runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', 'kill-server'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const session = await terminals.create({ cols: 40, rows: 10 });
  const script = path.join(root, 'draw.sh');
  // Colours, a hyperlink, a title and a cursor move, then (on a signal file) the alternate screen.
  await writeFile(script, "printf '\\033[1;31mred\\033[0m \\033[38;2;10;20;30mtrue\\033[0m\\n\\033]8;;http://x.test\\033\\\\link\\033]8;;\\033\\\\\\n\\033]0;title\\007\\033[4;7Hcur'; while [ ! -e go ]; do sleep 0.05; done; printf '\\033[?1049h\\033[?25l\\033[2;3Halt'; sleep 5\n");
  await terminals.input(session.id, { text: `clear; cd '${root}'; sh draw.sh`, enter: true });
  const until = async check => { for (let i = 0; i < 80; i++) { const read = await terminals.read(session.id, { format: 'ansi' }); if (check(read)) return read; await new Promise(resolve => setTimeout(resolve, 25)); } return terminals.read(session.id, { format: 'ansi' }); };
  const drawn = await until(read => read.text.includes('cur'));
  assert.match(drawn.text, /\x1b\[1;31mred|\x1b\[1m\x1b\[31mred/);
  assert.match(drawn.text, /\x1b\[38;2;10;20;30mtrue/);
  assert.ok(drawn.text.includes('link'));
  assert.equal(/\x1b\]|\x07|title/.test(drawn.text), false, 'OSC 8 and titles never reach the phone');
  assert.equal(drawn.text.replace(/\x1b\[[0-9;:]*m/g, '').match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/), null);
  const visible = drawn.text.replace(/\n$/, '').split('\n').slice(-drawn.rows);
  assert.equal(visible.length, 10, 'the last rows lines are the visible pane, blank lines included');
  assert.deepEqual(drawn.cursor, { x: 9, y: 3, visible: true });
  assert.equal(visible[3].replace(/\x1b\[[0-9;:]*m/g, '').slice(6, 9), 'cur');
  assert.equal(drawn.alternate, false);
  const plain = await terminals.read(session.id);
  assert.equal(plain.cursor, undefined); assert.equal(plain.text.includes('\x1b'), false);
  await writeFile(path.join(root, 'go'), '');
  const alternate = await until(read => read.alternate);
  assert.equal(alternate.alternate, true);
  assert.deepEqual(alternate.cursor, { x: 5, y: 1, visible: false });
  await terminals.input(session.id, { key: 'Interrupt' });
  await terminals.remove(session.id);
});

test('projects lists recent ~/Projects folders by name only, without tmux, and HTTP serves them on request', async t => {
  const root = await temporary(t), mock = mockedTmux();
  const projects = path.join(root, 'Projects');
  await mkdir(projects);
  const { utimes } = await import('node:fs/promises');
  for (const [index, name] of ['old', 'ponte', 'new-one', '.hidden', 'com espaço'].entries()) {
    await mkdir(path.join(projects, name));
    await utimes(path.join(projects, name), 1000 + index, 1000 + index);
  }
  await writeFile(path.join(projects, 'notes.txt'), '');
  await mkdir(path.join(root, 'outside'));
  await symlink(path.join(root, 'outside'), path.join(projects, 'link'));
  const terminals = createTerminals(root, { ...mock, projectsDir: projects });
  t.after(() => terminals.close());
  assert.deepEqual(await terminals.projects(), { projects: ['new-one', 'ponte', 'old'] });
  assert.equal(mock.calls.length, 0);
  const missing = createTerminals(root, { ...mock, projectsDir: path.join(root, 'none') });
  assert.deepEqual(await missing.projects(), { projects: [] });
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'index.html'), '<title>Test</title>');
  const token = 'synthetic_terminal_token_abcdefghijklmnopqrstuvwxyz';
  const app = await createApp({ rootDir: root, dataDir: path.join(root, 'state'), token, terminals, desktop: { close() {} }, audio: { close() {} } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/api/terminals?projects=1`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/api/terminals?projects=1`, { headers: { Authorization: `Bearer ${token}` } })).json(), { projects: ['new-one', 'ponte', 'old'] });
  assert.deepEqual(await (await fetch(`${base}/api/terminals`, { headers: { Authorization: `Bearer ${token}` } })).json(), { available: true, sessions: [], limit: 4 });
});

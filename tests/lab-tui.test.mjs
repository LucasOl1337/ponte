import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createTerminals } from '../backend/terminals.mjs';
import { commandExists, runCommand } from '../backend/process.mjs';

const labBin = fileURLToPath(new URL('../tools/lab/bin', import.meta.url));
const plain = text => text.replace(/\x1b\[[0-9;:]*m/g, '');

// The lab's fake Claude Code TUI, driven through the real terminals backend in
// a private tmux: what the Dev tab will show and type into, with no model.
async function labTui(t, prompt = 'corrige o bug') {
  if (!await commandExists('tmux') || !await commandExists('python3')) { t.skip('tmux or python3 is not installed'); return null; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-tui-'));
  const env = { PATH: `${labBin}:${process.env.PATH}`, HOME: root, XDG_RUNTIME_DIR: root, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8', PONTE_LAB_DIR: root };
  const socketPath = path.join(root, 'terminals', 'tmux.sock');
  const terminals = createTerminals(root, { env });
  t.after(async () => {
    await terminals.close();
    await runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', 'kill-server'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const session = await terminals.create({ cols: 70, rows: 24, agent: 'claude', prompt });
  const events = async () => { try { return (await readFile(path.join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const until = async (check, what) => {
    for (let i = 0; i < 120; i++) {
      const read = await terminals.read(session.id, { format: 'ansi' });
      if (await check(read)) return read;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${what}: ${JSON.stringify(plain((await terminals.read(session.id)).text).slice(-600))}`);
  };
  const tmux = args => runCommand('tmux', ['-S', socketPath, '-f', '/dev/null', ...args], { env });
  return { root, terminals, session, events, until, tmux };
}

test('the lab fake Claude TUI draws in colour with a hidden cursor, asks for bracketed paste and shows the permission menu', async t => {
  const lab = await labTui(t);
  if (!lab) return;
  const read = await lab.until(read => plain(read.text).includes('Do you want to proceed?'), 'the permission menu');
  assert.ok(read.text.includes('\x1b[38;2;215;119;87m'), 'Claude orange survives as truecolour SGR');
  assert.match(plain(read.text), /> corrige o bug/);
  assert.match(plain(read.text), /❯ 1\. Yes/);
  assert.equal(read.cursor.visible, false, 'like Claude Code, the fake hides the terminal cursor');
  assert.equal(read.alternate, false, 'it draws in the normal screen, so the conversation has scrollback');
  const pane = (await lab.terminals.list()).sessions[0];
  assert.equal(pane.id, lab.session.id);
  const flag = await lab.tmux(['display-message', '-p', '-t', `=ponte_${lab.session.id}:`, '#{bracket_paste_flag}']);
  assert.equal(flag.trim(), '1');
  const request = (await lab.events()).find(event => event.event === 'request');
  assert.deepEqual([request.text, request.mode], ['corrige o bug', 'default']);
});

test('keys and one-character answers reach the fake Claude TUI as the keys Claude Code expects', async t => {
  const lab = await labTui(t);
  if (!lab) return;
  const { terminals, session, until, events } = lab;
  await until(read => plain(read.text).includes('Do you want to proceed?'), 'the permission menu');
  // "1" typed through the text path answers the menu (a pasted "1" would not).
  await terminals.input(session.id, { text: '1' });
  await until(read => plain(read.text).includes('Bash(npm test)') && plain(read.text).includes('? for shortcuts'), 'the menu answered');
  assert.deepEqual((await events()).filter(event => event.event === 'permission').map(event => event.choice), [1]);
  await terminals.input(session.id, { key: 'ShiftTab' });
  await until(read => plain(read.text).includes('accept edits on'), 'accept edits mode');
  await terminals.input(session.id, { key: 'ShiftTab' });
  await until(read => plain(read.text).includes('plan mode on'), 'plan mode');
  // Every contract key arrives as the key the program recognises.
  const keys = ['Tab', 'Escape', 'BackSpace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Ctrl+A', 'Ctrl+E', 'Ctrl+L', 'Ctrl+O', 'Ctrl+R', 'Ctrl+T', 'Ctrl+U', 'Ctrl+W'];
  // One at a time, like a thumb: an Escape followed within milliseconds by
  // another key reads as Alt+key in any terminal program.
  const seen = async () => (await events()).filter(event => event.key).map(event => event.key);
  for (const key of keys) {
    const count = (await seen()).length;
    await terminals.input(session.id, { key });
    for (let i = 0; i < 80 && (await seen()).length === count; i++) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await seen(), ['1', 'ShiftTab', 'ShiftTab', ...keys]);
  // In a second menu, the arrows and Enter choose too; Escape answers No.
  await terminals.input(session.id, { key: 'ShiftTab' });
  await terminals.input(session.id, { text: 'roda de novo', enter: true });
  await until(read => plain(read.text).includes('Do you want to proceed?'), 'a second menu');
  await terminals.input(session.id, { key: 'ArrowDown' });
  await terminals.input(session.id, { key: 'ArrowDown' });
  await terminals.input(session.id, { key: 'Enter' });
  await until(read => plain(read.text).includes('recusado'), 'No chosen with the arrows');
  assert.deepEqual((await events()).filter(event => event.event === 'permission').map(event => event.choice), [1, 3]);
});

test('a request of several lines reaches the fake Claude TUI as one bracketed paste and is sent with Enter', async t => {
  const lab = await labTui(t, 'oi');
  if (!lab) return;
  const { terminals, session, until, events } = lab;
  await until(read => plain(read.text).includes('Do you want to proceed?'), 'the first menu');
  await terminals.input(session.id, { key: 'Escape' });
  await until(read => plain(read.text).includes('? for shortcuts'), 'the input box');
  const request = 'refatora o login\n- mantém a API\n- roda os testes';
  await terminals.input(session.id, { text: request, enter: true });
  await until(read => plain(read.text).includes('bracketed paste recebido'), 'the paste echo');
  const log = await events();
  assert.deepEqual(log.filter(event => event.event === 'paste').map(event => event.lines), [3]);
  assert.deepEqual(log.filter(event => event.event === 'request').map(event => event.text), ['oi', request]);
  assert.equal(log.some(event => event.key === 'Enter' && log.indexOf(event) < log.findIndex(item => item.event === 'paste')), false, 'no line break reached it as Enter before the paste ended');
});

test('Ctrl+J gives the fake Claude TUI a new line without sending, like Claude Code, and Enter sends both lines', async t => {
  const lab = await labTui(t, 'oi');
  if (!lab) return;
  const { terminals, session, until, events } = lab;
  await until(read => plain(read.text).includes('Do you want to proceed?'), 'the first menu');
  await terminals.input(session.id, { key: 'Escape' });
  await until(read => plain(read.text).includes('? for shortcuts'), 'the input box');
  await terminals.input(session.id, { text: 'primeira' });
  await terminals.input(session.id, { key: 'Ctrl+J' });
  await terminals.input(session.id, { text: 'segunda' });
  await until(read => /> primeira[\s\S]*segunda/.test(plain(read.text)), 'two lines in the input box');
  assert.deepEqual((await events()).filter(event => event.event === 'request').map(event => event.text), ['oi'], 'Ctrl+J sent nothing');
  await terminals.input(session.id, { key: 'Enter' });
  await until(async () => (await events()).filter(event => event.event === 'request').length === 2, 'the request');
  const request = (await events()).filter(event => event.event === 'request').at(-1);
  assert.deepEqual([request.text, request.lines], ['primeira\nsegunda', 2]);
  assert.ok((await events()).some(event => event.key === 'Ctrl+J'));
});

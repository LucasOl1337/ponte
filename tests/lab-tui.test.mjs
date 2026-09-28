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

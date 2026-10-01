import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';
import { DESKTOP_KEYS } from '../backend/desktop.mjs';
import { TERMINAL_KEYS } from '../backend/terminals.mjs';
import { COMMANDS } from '../bin/ctl-catalog.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const state = { hostname: 'test-desktop', windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: 'TEST-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true, stt: true }, warnings: [] };
const claude = { id: '0123456789abcdef01234567', title: 'Claude 1', cols: 51, rows: 41, inMode: false, attachCommand: 'x' };
const shell = { id: 'fedcba9876543210fedcba98', title: 'Terminal 2', cols: 40, rows: 24, inMode: false, attachCommand: 'y' };
const MENU = '⏺ Vou rodar os testes do projeto.\n╭──────╮\n Bash command\n   npm test\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again\n   3. No (esc)\n╰──────╯';
const PROMPT = '╭──────╮\n│ > │\n╰──────╯\n  ? for shortcuts';

function harness({ sessions = [claude, shell], screen = () => PROMPT, stored = {}, onFetch = () => {} } = {}) {
  const document = makeDocument(html), window = makeWindow();
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token'], ...Object.entries(stored)]);
  const calls = [];
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser' }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance,
    // Only the gap between the keys of a sequence runs (at once); polling never does.
    setTimeout: (callback, ms) => { if (ms === 150) Promise.resolve().then(callback); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      onFetch(path, options);
      if (path === '/api/terminals' && (options.method || 'GET') === 'GET') return ok({ available: true, sessions: sessions.map(session => ({ ...session })), limit: 4 });
      if (path === '/api/terminals?projects=1') return ok({ projects: [] });
      if (/^\/api\/terminals\/[a-f0-9]{24}\?format=ansi/.test(path)) return ok({ ...claude, hash: `h${calls.length}`, text: screen(path), cursor: { x: 0, y: 0, visible: false }, alternate: false });
      if (/^\/api\/terminals\/[a-f0-9]{24}(\?since=.*)?$/.test(path)) return ok({ ...shell, hash: `t${calls.length}`, text: screen(path) });
      if (path === '/api/state') return ok(state);
      return ok({ ok: true });
    },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  // The test DOM has no descendant combinator: 'a b c' is resolved step by step.
  const el = selector => selector.split(/\s+(?![^\[]*\])/).reduce((root, part) => root && root.querySelector(part), document);
  return { document, calls, saved, el, run: source => vm.runInContext(source, context),
    inputs: id => calls.filter(call => call.path === `/api/terminals/${id}/input`).map(call => JSON.parse(call.body)),
    actions: () => calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.body)) };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const ids = (root, part) => root.querySelector(part).querySelectorAll('[data-shortcut]').map(button => button.dataset.shortcut);

test('every shortcut sends only names the server allows, on the surface it targets', async () => {
  const h = harness();
  const catalog = JSON.parse(JSON.stringify(h.run('KEY_CATALOG')));
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length, 'ids are unique');
  for (const item of catalog) {
    assert.ok(item.term || item.desk, item.id);
    for (const body of [item.term].flat().filter(Boolean)) {
      if (body.key) assert.ok(TERMINAL_KEYS.includes(body.key), `${item.id}: terminal key ${body.key}`);
      else assert.ok(typeof body.text === 'string' && body.text.length, item.id);
    }
    if (item.desk) assert.ok(DESKTOP_KEYS.includes(item.desk), `${item.id}: desktop key ${item.desk}`);
  }
  // Every order list and the head only name shortcuts of the catalog.
  const known = new Set(catalog.map(item => item.id));
  for (const id of [...JSON.parse(JSON.stringify(h.run('KEY_HEAD'))), ...Object.values(JSON.parse(JSON.stringify(h.run('KEY_ORDER')))).flat()]) assert.ok(known.has(id), id);
  // The CLI offers the same keys as the server.
  const command = name => COMMANDS.find(item => item.name === name);
  assert.deepEqual(command('keyboard key').params.key.enum, [...DESKTOP_KEYS]);
  assert.deepEqual(command('terminals key').params.key.enum, [...TERMINAL_KEYS]);
});

test('the three pages share one bar: Enter, Esc and Ctrl+C in a head that never scrolls', async () => {
  const h = harness();
  await flush();
  for (const selector of ['#dev-keys', '#terminal-keys', '#screen-key-row']) {
    const bar = h.el(selector);
    assert.ok(bar.getAttribute('data-key-bar'), selector);
    assert.deepEqual(ids(bar, '.key-head'), ['enter', 'esc', 'ctrl-c'], selector);
    assert.ok(bar.querySelector('[data-key-sheet]'), `${selector} has the sheet button`);
    assert.equal(ids(bar, '.key-tail').some(id => ['enter', 'esc', 'ctrl-c'].includes(id)), false, 'the head keys are not repeated');
  }
  // The screen bar only offers keys the PC keyboard can press.
  assert.equal(ids(h.el('#screen-key-row'), '.key-tail').includes('menu-1'), false);
  assert.equal(h.el('#screen-key-row [data-shortcut="ctrl-c"]').getAttribute('aria-label'), 'Copy (Ctrl+C)');
  assert.equal(h.el('#dev-keys [data-shortcut="ctrl-c"]').getAttribute('aria-label'), 'Interrupt (Ctrl+C)');
});

test('Dev puts the menu answers first while the agent asks, and its normal order back after', async () => {
  let menu = true;
  const h = harness({ screen: () => menu ? MENU : PROMPT });
  await flush();
  h.run("navigate('dev')"); await flush();
  const bar = h.el('#dev-keys');
  assert.equal(bar.getAttribute('data-key-menu'), '3');
  assert.deepEqual(ids(bar, '.key-tail').slice(0, 5), ['menu-1', 'menu-2', 'menu-3', 'up', 'down']);
  h.el('#dev-keys [data-shortcut="menu-2"]').click(); await flush();
  assert.deepEqual(h.inputs(claude.id).at(-1), { text: '2' });
  menu = false;
  h.run('devRead(devGeneration)'); await flush();
  assert.equal(bar.getAttribute('data-key-menu'), '0');
  assert.deepEqual(ids(bar, '.key-tail').slice(0, 3), ['shift-tab', 'up', 'down']);
});

test('menu detection needs the selection pointer and two options, so a numbered list is not a menu', () => {
  const h = harness();
  const options = text => h.run(`keyMenuOptions(${JSON.stringify(text)})`);
  assert.equal(options(MENU), 3);
  assert.equal(options(`${MENU}\nDone\n${PROMPT}`), 0, 'choices in scrollback followed by a prompt are not an active menu');
  assert.equal(options(`${MENU}\n› `), 0, 'a Codex prompt ends the old choice menu');
  assert.equal(options(`${'\n'.repeat(30)}${MENU}${'\n'.repeat(20)}`), 3, 'a tall pane ends in blank rows, as tmux sends it');
  assert.equal(options('Select model\n › 1. gpt-5 (current)\n   2. gpt-5-mini\n   3. o3\n   4. o4-mini\n   5. other'), 4, 'Codex pointer; at most four answer keys');
  assert.equal(options('Plano:\n1. ler o código\n2. rodar os testes\n3. corrigir\n> '), 0);
  assert.equal(options('❯ 1. Yes'), 0);
  assert.equal(options(''), 0);
});

test('sequences go one key at a time and a shell session gets shell keys first', async () => {
  const h = harness({ sessions: [shell] });
  await flush();
  h.run("navigate('dev')"); await flush();
  const bar = h.el('#dev-keys');
  assert.equal(bar.getAttribute('data-key-context'), 'shell');
  assert.deepEqual(ids(bar, '.key-tail').slice(0, 4), ['up', 'tab', 'ctrl-r', 'repeat']);
  h.el('#dev-keys [data-shortcut="repeat"]').click(); await flush();
  assert.deepEqual(h.inputs(shell.id), [{ key: 'ArrowUp' }, { key: 'Enter' }]);
  h.el('#dev-keys [data-key-sheet]').click(); await flush();
  assert.equal(h.el('#dev-keys .key-sheet').hidden, false);
  h.el('#dev-keys .key-sheet [data-shortcut="fg"]').click(); await flush();
  h.el('#dev-keys .key-sheet [data-shortcut="ctrl-c-twice"]').click(); await flush();
  assert.deepEqual(h.inputs(shell.id).slice(2), [{ text: 'fg', enter: true }, { key: 'Interrupt' }, { key: 'Interrupt' }]);
});

test('Terminals use the same bar with the session context, and the screen bar presses PC keys', async () => {
  const h = harness();
  await flush();
  h.run("navigate('terminais')"); await flush();
  h.run(`selectTerminal(${JSON.stringify(claude.id)}); updateTerminalNavigation()`); await flush();
  const bar = h.el('#terminal-keys');
  assert.equal(bar.getAttribute('data-key-context'), 'agent');
  h.el('#terminal-keys [data-shortcut="shift-tab"]').click(); await flush();
  h.el('#terminal-keys [data-shortcut="enter"]').click(); await flush();
  assert.deepEqual(h.inputs(claude.id), [{ key: 'ShiftTab' }, { key: 'Enter' }]);
  h.run("navigate('tela')"); await flush();
  h.calls.length = 0;
  for (const id of ['enter', 'ctrl-c', 'term-paste', 'shift-tab', 'newline']) { h.el(`#screen-key-row [data-shortcut="${id}"]`).click(); await flush(); await h.run('keyQueue'); await flush(); }
  assert.deepEqual(h.actions(), ['Enter', 'Copy', 'Ctrl+Shift+V', 'ShiftTab', 'ShiftEnter'].map(key => ({ type: 'keyboard.key', key })));
});

test('pinned keys and saved commands come first, the most used ones rise, and the head never moves', async () => {
  const h = harness({ sessions: [shell] });
  await flush();
  h.run("navigate('dev')"); await flush();
  const bar = h.el('#dev-keys');
  // Pin Ctrl+L from the sheet.
  h.el('#dev-keys [data-key-sheet]').click(); await flush();
  h.el('#dev-keys [data-key-pin]').click(); await flush();
  h.el('#dev-keys .key-sheet [data-shortcut="ctrl-l"]').click(); await flush();
  h.el('#dev-keys .key-head [data-shortcut="enter"]').click(); await flush();
  assert.deepEqual(JSON.parse(h.saved.get('ponte-keys-pinned')), { shell: ['ctrl-l'] }, 'the head cannot be pinned');
  assert.deepEqual(h.inputs(shell.id), [], 'pinning sends nothing');
  // Save a command; it shows in the row and runs with Enter.
  h.el('#dev-keys [data-key-command-input]').value = 'npm test';
  h.el('#dev-keys [data-key-command-save]').click(); await flush();
  h.el('#dev-keys [data-key-pin]').click(); await flush();
  assert.equal(ids(bar, '.key-tail')[0], 'ctrl-l');
  const command = bar.querySelector('.key-tail').querySelector('[data-key-command]');
  assert.equal(command.textContent, 'npm test');
  command.click(); await flush();
  assert.deepEqual(h.inputs(shell.id), [{ text: 'npm test', enter: true }]);
  // The same command list is in every bar.
  assert.equal(h.el('#screen-key-row .key-tail').querySelector('[data-key-command]').textContent, 'npm test');
  // Three taps on PgDn promote it, but only on the next context change.
  for (let i = 0; i < 3; i++) { h.el('#dev-keys [data-shortcut="pgdn"]').click(); await flush(); }
  assert.notEqual(ids(bar, '.key-tail')[1], 'pgdn', 'the row does not move under the finger');
  h.run("navigate('janelas'); navigate('dev')"); await flush();
  assert.deepEqual(ids(bar, '.key-tail').slice(0, 2), ['ctrl-l', 'pgdn']);
  assert.deepEqual(ids(bar, '.key-head'), ['enter', 'esc', 'ctrl-c']);
  // Deleting a saved command from the sheet.
  h.el('#dev-keys [data-key-sheet]').click(); await flush();
  h.el('#dev-keys [data-key-pin]').click(); await flush();
  h.el('#dev-keys .key-sheet [data-key-command="0"]').click(); await flush();
  assert.deepEqual(JSON.parse(h.saved.get('ponte-keys-commands')), []);
});

test('a shortcut sequence stops if the session, node or page changes after its first key', async () => {
  for (const bar of ['dev', 'term']) {
    for (const change of [bar === 'dev' ? `devSelect('${claude.id}')` : `selectTerminal('${claude.id}')`, "targetNode = 'test-other-node'", "navigate('janelas')"]) {
      let mutate = false, h;
      h = harness({ sessions: [shell, claude], onFetch: path => {
        if (mutate && path === `/api/terminals/${shell.id}/input`) { mutate = false; h.run(change); }
      }});
      await flush();
      h.run(bar === 'dev' ? "navigate('dev')" : "navigate('terminais')"); await flush();
      h.run(bar === 'dev' ? `devSelect('${shell.id}')` : `selectTerminal('${shell.id}')`); await flush();
      const selector = bar === 'dev' ? '#dev-keys' : '#terminal-keys';
      mutate = true;
      h.el(`${selector} [data-shortcut="repeat"]`).click(); await flush();
      assert.deepEqual(h.inputs(shell.id), [{key:'ArrowUp'}], `${bar}: ${change}`);
      assert.deepEqual(h.inputs(claude.id), [], 'Enter never reaches the replacement session');
      assert.equal(h.calls.filter(call => call.path.includes('/input')).length, 1);
    }
  }
});

test('a command draft and its focus survive a menu update, and saving clears only that draft', async () => {
  const h = harness(); await flush();
  h.run("navigate('dev')"); await flush();
  h.el('#dev-keys [data-key-sheet]').click();
  const input = h.el('#dev-keys [data-key-command-input]');
  input.value = 'npm run build'; input.focus();
  h.run(`keyBarUpdate('dev', 'agent', ${JSON.stringify(MENU)})`);
  const rebuilt = h.el('#dev-keys [data-key-command-input]');
  assert.equal(rebuilt.value, 'npm run build');
  assert.equal(h.document.activeElement, rebuilt);
  h.el('#terminal-keys [data-key-command-input]').value = 'other draft';
  h.el('#dev-keys [data-key-command-save]').click();
  assert.equal(h.el('#dev-keys [data-key-command-input]').value, '');
  assert.equal(h.el('#terminal-keys [data-key-command-input]').value, 'other draft');
  assert.deepEqual(JSON.parse(h.saved.get('ponte-keys-commands')), ['npm run build']);
});

test('the bar keys are disabled without a session and enabled with one', async () => {
  const h = harness({ sessions: [] });
  await flush();
  h.run("navigate('dev')"); await flush();
  assert.equal(h.el('#dev-keys [data-shortcut="enter"]').disabled, true);
  h.el('#dev-keys [data-shortcut="enter"]').click(); await flush();
  assert.equal(h.calls.some(call => call.path.endsWith('/input')), false);
});

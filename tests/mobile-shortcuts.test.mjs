// Mobile Omarchy shortcuts: the `keyboard.combo` desktop action, the `pi`
// terminal preset, and the phone palette (public/mobile-shortcuts.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDesktop, comboCodes, COMBO_KEYS, COMBO_MODIFIERS } from '../backend/desktop.mjs';
import { makeDocument } from './helpers/dom.mjs';

const root = path.resolve(import.meta.dirname, '..');

function recorder({ fail = () => false } = {}) {
  const calls = [];
  const runner = async (command, args = []) => {
    calls.push({ command, args });
    if (fail(command, args)) throw Object.assign(new Error('ydotool failed'), { code: 'COMMAND_FAILED' });
    if (command === 'hyprctl') return args.includes('monitors') ? JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, focused: true }]) : '[]';
    return 'ok';
  };
  return { calls, desktop: createDesktop({ runner, exists: async () => true, dragTimeout: 45 }) };
}
const keyCalls = calls => calls.filter(call => call.command === 'ydotool' && call.args[0] === 'key');

async function loadShortcuts() {
  const sandbox = {};
  vm.runInNewContext(await readFile(path.join(root, 'public/mobile-shortcuts.js'), 'utf8'), sandbox);
  return sandbox.PonteShortcuts;
}

test('keyboard.combo presses Super first and releases every key in reverse within one ydotool call', async () => {
  const { calls, desktop } = recorder();
  // evdev: 125 LEFTMETA, 29 LEFTCTRL, 56 LEFTALT, 42 LEFTSHIFT, 33 F, 2 '1', 15 TAB, 57 SPACE, 28 ENTER.
  const expected = {
    'Super+F': [125, 33], 'Super+W': [125, 17], 'Super+Shift+1': [125, 42, 2], 'Super+Ctrl+Tab': [125, 29, 15],
    'Super+Space': [125, 57], 'Super+Return': [125, 28], 'Super+Ctrl+Alt+Shift+0': [125, 29, 56, 42, 11], 'Super+F12': [125, 88],
  };
  for (const [combo, codes] of Object.entries(expected)) {
    assert.deepEqual(await desktop.action({ type: 'keyboard.combo', combo }), { ok: true, combo });
    assert.deepEqual(calls.at(-1).args, ['key', '--key-delay', '1', ...codes.map(code => `${code}:1`), ...codes.toReversed().map(code => `${code}:0`)], combo);
  }
  // Every call leaves nothing held: each pressed code is released in the same call.
  for (const call of keyCalls(calls)) {
    const down = new Set();
    for (const word of call.args.slice(3)) { const [code, state] = word.split(':'); state === '1' ? down.add(code) : down.delete(code); }
    assert.equal(down.size, 0, call.args.join(' '));
  }
  await desktop.close();
});

test('keyboard.combo rejects anything outside the canonical Super allowlist before ydotool runs', async () => {
  const { calls, desktop } = recorder();
  const bad = [
    'Ctrl+Alt+Delete', 'Super', 'Super+', 'super+f', 'Super+f', 'Super+Shift+Ctrl+1', 'Super+Super+F', 'Super+Alt+Ctrl+T',
    'Super+F13', 'Super+Enter', 'Super+F;rm -rf ~', 'Super+125', 'Super+__proto__', 'Super+toString', 'Super+constructor',
    ' Super+F', 'Super+F\n', 'Super+Ctrl+Alt+Shift+Ctrl+F', 42, null, undefined, ['Super', 'F'], { combo: 'Super+F' },
  ];
  for (const combo of bad) await assert.rejects(desktop.action({ type: 'keyboard.combo', combo }), { code: 'KEY_NOT_ALLOWED' }, String(combo));
  assert.equal(calls.length, 0);
  assert.deepEqual(COMBO_MODIFIERS, ['Super', 'Ctrl', 'Alt', 'Shift']);
  assert.equal(new Set(COMBO_KEYS.map(key => comboCodes(`Super+${key}`)[1])).size, COMBO_KEYS.length, 'one evdev code per key name');
  await desktop.close();
});

test('a failed combo releases every key again, and a held drag is let go before the combo', async () => {
  const failing = recorder({ fail: (command, args) => command === 'ydotool' && args[1] === '--key-delay' });
  await assert.rejects(failing.desktop.action({ type: 'keyboard.combo', combo: 'Super+Shift+2' }));
  assert.deepEqual(keyCalls(failing.calls).at(-1).args, ['key', '3:0', '42:0', '125:0']);
  await failing.desktop.close();

  const { calls, desktop } = recorder();
  await desktop.action({ type: 'mouse.drag', pressed: true });
  await desktop.action({ type: 'keyboard.combo', combo: 'Super+F' });
  const release = calls.findIndex(call => call.args.includes('0x80'));
  const combo = calls.findIndex(call => call.args.includes('125:1'));
  assert.ok(release >= 0 && release < combo, 'drag released before the combo');
  await desktop.close();
});

test('palette catalog: defaults are canonical, custom combos are validated and persisted without junk', async () => {
  const S = await loadShortcuts();
  const plain = value => JSON.parse(JSON.stringify(value));
  const { COMBO_KEYS: serverKeys } = await import('../backend/desktop.mjs');
  assert.deepEqual([...S.KEYS].sort(), [...serverKeys].sort(), 'client and server key allowlists match');
  for (const item of S.DEFAULT_SHORTCUTS) { assert.ok(S.isCombo(item.combo), item.combo); assert.doesNotThrow(() => comboCodes(item.combo), item.combo); }
  assert.deepEqual(plain(S.DEFAULT_SHORTCUTS.slice(0, 5).map(item => item.combo)), ['Super+F', 'Super+W', 'Super+Shift+1', 'Super+Shift+2', 'Super+Space']);
  assert.equal(S.comboOf(['Shift', 'Ctrl'], '1'), 'Super+Ctrl+Shift+1');
  assert.throws(() => S.comboOf(['Super'], 'F'));
  assert.throws(() => S.comboOf([], 'f'));
  assert.equal(S.comboLabel('Super+Shift+Return'), 'Super + Shift + ⏎');

  const catalog = S.createCatalog({ hidden: ['close', 'nope'], custom: [{ combo: 'Super+Alt+Q', label: 'Meu\u0007 atalho' }, { combo: 'Ctrl+Alt+Delete' }, { combo: 'Super+Alt+Q' }, null] });
  assert.equal(catalog.items().some(item => item.id === 'close'), false);
  assert.deepEqual(plain(catalog.config.custom.map(item => [item.combo, item.label])), [['Super+Alt+Q', 'Meu atalho']]);
  assert.throws(() => catalog.add('Super+Shift+Ctrl+1'), /COMBO_NOT_ALLOWED/);
  catalog.add('Super+Ctrl+L', '');
  assert.deepEqual(JSON.parse(catalog.serialize()), { hidden: ['close'], custom: [{ combo: 'Super+Alt+Q', label: 'Meu atalho' }, { combo: 'Super+Ctrl+L', label: 'Super + Ctrl + L' }] });
  assert.deepEqual(plain(S.comboAction('Super+F')), { type: 'keyboard.combo', combo: 'Super+F' });
  assert.throws(() => S.comboAction('Super+F; id'));
});

test('the Pi preset needs an explicit machine and sends only the fixed agent id', async () => {
  const S = await loadShortcuts();
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.throws(() => S.presetRequest('open-pi', null), /TARGET_REQUIRED/);
  assert.throws(() => S.presetRequest('open-pi', { id: 'x' }), /TARGET_REQUIRED/);
  assert.throws(() => S.presetRequest('open-shell', { id: '', name: 'PC' }), /ACTION_NOT_ALLOWED/);
  assert.throws(() => S.presetRequest('__proto__', { id: '', name: 'PC' }), /ACTION_NOT_ALLOWED/);
  assert.deepEqual(JSON.parse(JSON.stringify(S.presetRequest('open-pi', { id: 'notebook', name: 'Notebook' }, { cols: 40, rows: 20 }))),
    { method: 'POST', path: '/terminals', node: 'notebook', body: { cols: 40, rows: 20, agent: 'pi' } });
});

test('Super button opens a palette; a tap sends one keyboard.combo and never types the word Super', async () => {
  const S = await loadShortcuts();
  const plain = value => JSON.parse(JSON.stringify(value));
  const document = makeDocument('<html><body><div id="host"></div></body></html>');
  const host = document.getElementById('host');
  const sent = [], opened = [], store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  let target = null;
  S.mountShortcuts(host, { send: async action => sent.push(action), openPreset: async request => opened.push(request), target: () => target, storage });
  const superButton = host.querySelector('[data-shortcut-super]');
  assert.equal(superButton.textContent.includes('Super'), false);
  assert.equal(host.querySelector('.shortcut-palette').hidden, true);
  superButton.click();
  assert.equal(host.querySelector('.shortcut-palette').hidden, false);
  assert.equal(host.querySelector('[data-shortcut-super]').getAttribute('aria-expanded'), 'true');

  host.querySelector('[data-combo="Super+Shift+1"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(sent), [{ type: 'keyboard.combo', combo: 'Super+Shift+1' }]);
  assert.match(host.querySelector('[data-shortcut-status]').textContent, /Enviado: Super \+ Shift \+ 1/);

  // No machine chosen: the Pi action is disabled and nothing is opened.
  const pi = host.querySelector('[data-preset="open-pi"]');
  assert.equal(pi.disabled, true);
  pi.click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, []);

  target = { id: 'notebook', name: 'Notebook' };
  host.querySelector('[data-shortcut-super]').click(); host.querySelector('[data-shortcut-super]').click();
  host.querySelector('[data-preset="open-pi"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(opened[0].body)), { cols: 80, rows: 24, agent: 'pi' });
  assert.equal(opened[0].node, 'notebook');

  // Compose and save a custom combo; it survives a remount from storage.
  host.querySelector('[data-mod="Alt"]').click();
  host.querySelector('[data-shortcut-key]').value = 'Q';
  host.querySelector('[data-shortcut-save]').click();
  assert.deepEqual(JSON.parse(store.get(S.STORAGE_KEY)).custom, [{ combo: 'Super+Alt+Q', label: 'Super + Alt + Q' }]);
  const again = makeDocument('<html><body><div id="host"></div></body></html>').getElementById('host');
  S.mountShortcuts(again, { send: async () => {}, target: () => null, storage });
  assert.ok(again.querySelector('[data-combo="Super+Alt+Q"]'));
  // Every sent payload is a combo action; no text/type action ever leaves.
  assert.ok(sent.every(action => action.type === 'keyboard.combo'));
});

test('palette tap targets are at least 44px', async () => {
  const css = await readFile(path.join(root, 'public/mobile-shortcuts.css'), 'utf8');
  for (const selector of ['.shortcut-super', '.shortcut-item', '.shortcut-mod', '.shortcut-palette select', '.shortcut-compose summary']) {
    const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])[^{]*\\{([^}]*)\\}`).exec(css);
    assert.ok(block, selector);
    assert.ok(Number(/min-height:\s*(\d+)px/.exec(block[1])?.[1]) >= 44, selector);
  }
});

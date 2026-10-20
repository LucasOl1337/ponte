// The three phone changes of 20/10/2026 loaded together, the way index.html
// loads them: i18n, the shortcuts palette, the layout editor, then app.js.
// Fill must keep its no-Enter contract with the other two mounted, a Super
// combo leaves as one keyboard.combo, the Pi preset opens a bare `pi` terminal
// on the chosen machine, and the arrange entry stays a deliberate tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, shortcutsScript, layoutScript, app] = await Promise.all(['index.html', 'i18n.js', 'mobile-shortcuts.js', 'mobile-control-layout.js', 'app.js'].map(read));
const state = { hostname: 'test-desktop', windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: 'TEST-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true, stt: true }, warnings: [] };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, status: 200, json: async () => value });

function harness({ phone = true } = {}) {
  const document = makeDocument(html), window = makeWindow();
  // A phone: coarse pointer and a narrow screen enable the layout editor.
  window.matchMedia = query => ({ matches: phone && /pointer: coarse|max-width: 700px/.test(query) });
  window.innerWidth = 390; window.innerHeight = 844;
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token']]);
  const calls = [], sessions = [], form = { text: '', submitted: null };
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser' }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance, requestAnimationFrame: callback => { Promise.resolve().then(callback); return 1; }, cancelAnimationFrame() {},
    setTimeout: (callback, ms) => { if (ms === 150) Promise.resolve().then(callback); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      if (path === '/api/action') {
        const action = JSON.parse(options.body);
        if (action.type === 'keyboard.text') { form.text += action.text; if (action.enter) form.submitted ??= form.text; }
        if (action.type === 'keyboard.key' && action.key === 'Tab') form.text += '<Tab>';
        if (action.type === 'keyboard.key' && action.key === 'Enter') form.submitted ??= form.text;
        return ok({ ok: true });
      }
      if (path === '/api/textinput') return ok({ available: true, focused: true });
      if (path === '/api/state') return ok(state);
      if (path === '/api/terminals' && options.method === 'POST') { const session = { id: 'pi-1', title: 'Pi 1', agent: 'pi', cols: 40, rows: 20 }; sessions.push(session); return ok(session); }
      if (path === '/api/terminals') return ok({ available: true, sessions, limit: 4 });
      return ok({ ok: true });
    },
  });
  vm.runInContext(runtime, context);
  vm.runInContext(shortcutsScript, context);
  vm.runInContext(layoutScript, context);
  // In a browser window is the global object; this VM keeps them apart.
  window.PonteControlLayout = context.PonteControlLayout;
  vm.runInContext(app, context);
  const el = selector => selector.split(/\s+(?![^\[]*\])/).reduce((root, part) => root && root.querySelector(part), document);
  const h = { document, window, calls, saved, form, el, run: source => vm.runInContext(source, context),
    actions: () => calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.body)) };
  h.settle = async () => { await flush(); await h.run('keyQueue'); await flush(); };
  h.type = value => { const box = el('#screen-input'); box.value = value; box.dispatchEvent({ type: 'input', inputType: 'insertText' }); };
  h.key = async id => { el(`#screen-key-row [data-shortcut="${id}"]`).click(); await h.settle(); };
  return h;
}

async function openScreen(h) {
  await flush();
  h.run("navigate('tela')"); await flush();
}

test('all three modules mount from index.html: palette on the floating rail, arrange entry in the bar options', async () => {
  const h = harness();
  await openScreen(h);
  assert.equal(typeof h.window.PonteShortcuts?.mountShortcuts, 'function');
  assert.equal(typeof h.window.PonteControlLayout?.mount, 'function');
  assert.ok(h.el('.screen-fabs #shortcut-host [data-shortcut-super]'), 'the Super button lives on the floating rail');
  assert.equal(h.el('#shortcut-palette').hidden, true, 'the palette starts closed');
  assert.ok(h.el('#screen-composer-tools #screen-arrange'), 'arranging is reached only through the bar options');
  const scripts = h.document.querySelectorAll('script[src]').map(node => node.getAttribute('src').split('?')[0]);
  assert.deepEqual(scripts.slice(-4), ['/i18n.js', '/mobile-shortcuts.js', '/mobile-control-layout.js', '/app.js'], 'modules load before app.js');
  assert.equal(h.document.body.getAttribute('data-control-layout-editing'), null, 'no edit mode without the deliberate tap');
});

test('with the palette and layout mounted, Fill still never presses Enter: user, Tab, password, then the explicit ⏎', async () => {
  const h = harness();
  await openScreen(h);
  h.el('#screen-keyboard').click(); await flush();
  h.type('lucas'); h.el('#screen-input-fill').click(); await h.settle();
  await h.key('tab');
  h.type('S3nha-falsa!'); h.el('#screen-input').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} }); await h.settle();
  assert.equal(h.form.submitted, null, 'neither Fill nor the IME action key submitted');
  assert.equal(h.form.text, 'lucas<Tab>S3nha-falsa!');
  await h.key('enter');
  assert.equal(h.form.submitted, 'lucas<Tab>S3nha-falsa!');
  assert.equal(h.actions().filter(action => action.type === 'keyboard.combo').length, 0, 'typing never goes through the Super palette');
  for (const value of h.saved.values()) assert.equal(String(value).includes('S3nha-falsa!'), false, 'the password is not stored');
});

test('a Super shortcut leaves as one keyboard.combo with the pairing token, never as typed text', async () => {
  const h = harness();
  await openScreen(h);
  h.el('[data-shortcut-super]').click(); await flush();
  assert.equal(h.el('#shortcut-palette').hidden, false);
  h.el('#shortcut-palette [data-combo="Super+F"]').click(); await h.settle();
  h.el('#shortcut-palette [data-combo="Super+Shift+1"]').click(); await h.settle();
  const sent = h.calls.filter(call => call.path === '/api/action');
  assert.deepEqual(sent.map(call => JSON.parse(call.body)), [{ type: 'keyboard.combo', combo: 'Super+F' }, { type: 'keyboard.combo', combo: 'Super+Shift+1' }]);
  assert.equal(h.actions().some(action => action.type === 'keyboard.text'), false, 'the word Super is never typed');
});

test('"Abrir terminal com Pi" opens a bare pi session on this PC and shows it', async () => {
  const h = harness();
  await openScreen(h);
  h.el('[data-shortcut-super]').click(); await flush();
  const preset = h.el('#shortcut-palette [data-preset="open-pi"]');
  assert.equal(preset.getAttribute('disabled'), null, 'enabled once connected');
  preset.click(); await h.settle();
  const post = h.calls.find(call => call.path === '/api/terminals' && call.method === 'POST');
  const body = JSON.parse(post.body);
  assert.equal(body.agent, 'pi');
  assert.equal('prompt' in body, false, 'no text from the phone reaches Pi');
  assert.equal(h.run('terminalId'), 'pi-1');
  assert.equal(h.el('#page-terminais').hidden, false, 'the new terminal is shown');
});

test('arrange mode: only the deliberate tap enters it, Cancel leaves it, and leaving the screen cancels it', async () => {
  const h = harness();
  await openScreen(h);
  h.el('#screen-keyboard').click(); await flush();
  h.el('#screen-input-more').click();
  h.el('#screen-arrange').click(); await flush();
  assert.equal(h.document.body.getAttribute('data-control-layout-editing'), 'true');
  assert.equal(h.el('#screen-composer-tools').hidden, true, 'the options sheet closes behind the edit bar');
  assert.equal(h.actions().length, 0, 'entering the mode sends nothing to the PC');
  h.el('[data-pcl="cancel"]').click(); await flush();
  assert.equal(h.document.body.getAttribute('data-control-layout-editing'), null);
  h.el('#screen-input-more').click(); h.el('#screen-arrange').click(); await flush();
  h.run("navigate('terminais')"); await flush();
  assert.equal(h.document.body.getAttribute('data-control-layout-editing'), null, 'navigating away cancels the edit');
  assert.equal(h.actions().length, 0);
});

test('on a wide screen without touch the arrange entry only explains itself', async () => {
  const h = harness({ phone: false });
  await openScreen(h);
  h.el('#screen-keyboard').click(); await flush();
  h.el('#screen-input-more').click(); h.el('#screen-arrange').click(); await flush();
  assert.equal(h.document.body.getAttribute('data-control-layout-editing'), null);
  assert.equal(h.el('#toast').textContent, 'Arrange the buttons on your phone.');
});

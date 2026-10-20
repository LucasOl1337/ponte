// Regression for Lucas's HTTP auth form (Username, Password) that the phone
// submitted half filled: the screen typing bar must never press Enter on the
// PC unless the user asked for it with Send or the ⏎ key.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const state = { hostname: 'test-desktop', windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: 'TEST-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true, stt: true }, warnings: [] };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, status: 200, json: async () => value });

// The PC side: an auth dialog with two fields. It applies keyboard actions the
// way wtype does on the real desktop: text goes into the focused field, a line
// break or Enter submits, Tab and Shift+Tab move focus.
function authForm() {
  const form = { fields: { username: '', password: '' }, order: ['username', 'password'], focus: 0, submitted: null };
  const submit = () => { form.submitted ??= { ...form.fields }; };
  const type = text => {
    for (const char of text) {
      if (char === '\n' || char === '\r') submit();
      else if (char === '\t') form.focus = Math.min(form.focus + 1, form.order.length - 1);
      else form.fields[form.order[form.focus]] += char;
    }
  };
  form.apply = action => {
    if (action.type === 'keyboard.text') { type(action.text); if (action.enter) submit(); }
    else if (action.type === 'keyboard.key' && action.key === 'Enter') submit();
    else if (action.type === 'keyboard.key' && action.key === 'Tab') form.focus = Math.min(form.focus + 1, form.order.length - 1);
    else if (action.type === 'keyboard.key' && action.key === 'ShiftTab') form.focus = Math.max(form.focus - 1, 0);
  };
  return form;
}

function harness({ form = authForm(), gate = null, stored = {} } = {}) {
  const document = makeDocument(html), window = makeWindow();
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token'], ...Object.entries(stored)]);
  const calls = [];
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser' }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance,
    setTimeout: (callback, ms) => { if (ms === 150) Promise.resolve().then(callback); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body });
      if (path === '/api/action') {
        const action = JSON.parse(options.body);
        if (gate) await gate.promise;
        form.apply(action);
        return ok({ ok: true });
      }
      if (path === '/api/textinput') return ok({ available: true, focused: true });
      if (path === '/api/state') return ok(state);
      if (path === '/api/terminals') return ok({ available: true, sessions: [], limit: 4 });
      return ok({ ok: true });
    },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  const el = selector => selector.split(/\s+(?![^\[]*\])/).reduce((root, part) => root && root.querySelector(part), document);
  const h = { document, window, calls, saved, form, el, run: source => vm.runInContext(source, context),
    actions: () => calls.filter(call => call.path === '/api/action').map(call => JSON.parse(call.body)) };
  h.settle = async () => { await flush(); await h.run('keyQueue'); await flush(); };
  h.type = value => { const box = el('#screen-input'); box.value = value; box.dispatchEvent({ type: 'input', inputType: 'insertText' }); };
  h.key = async id => { el(`#screen-key-row [data-shortcut="${id}"]`).click(); await h.settle(); };
  return h;
}

async function openBar(h) {
  await flush();
  h.run("navigate('tela')"); await flush();
  h.window.innerWidth = 390; h.window.innerHeight = 844;
  h.el('#screen-keyboard').click(); await flush();
  assert.equal(h.el('#screen-composer').hidden, false);
}

test('user name, Tab, password: the form is submitted only by the explicit Enter', async () => {
  const h = harness();
  await openBar(h);
  // Each field is filled with the visible primary button; the bar stays open.
  h.type('lucas'); h.el('#screen-input-fill').click(); await h.settle();
  assert.equal(h.form.submitted, null, 'Fill never submits');
  assert.equal(h.el('#screen-composer').hidden, false);
  await h.key('tab');
  // The phone keyboard's action key on the password: still only types.
  h.type('s3nh@-forte'); h.el('#screen-input').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} }); await h.settle();
  assert.equal(h.form.submitted, null, 'the action key never submits');
  assert.deepEqual(h.form.fields, { username: 'lucas', password: 's3nh@-forte' });
  // Shift+Tab goes back and Tab returns without touching the text.
  await h.key('shift-tab'); assert.equal(h.form.focus, 0);
  await h.key('tab'); assert.equal(h.form.focus, 1);
  assert.equal(h.form.submitted, null);
  // Only the ⏎ key (or Send) submits.
  await h.key('enter');
  assert.deepEqual(h.form.submitted, { username: 'lucas', password: 's3nh@-forte' });
  assert.deepEqual(h.actions(), [
    { type: 'keyboard.text', text: 'lucas' },
    { type: 'keyboard.key', key: 'Tab' },
    { type: 'keyboard.text', text: 's3nh@-forte' },
    { type: 'keyboard.key', key: 'ShiftTab' },
    { type: 'keyboard.key', key: 'Tab' },
    { type: 'keyboard.key', key: 'Enter' },
  ]);
  // Nothing typed in the bar is kept on the phone.
  assert.equal(h.run('cmdHistory.length'), 0);
  for (const value of h.saved.values()) assert.equal(String(value).includes('s3nh@-forte'), false, 'the password is not stored');
});

test('Send is the one-tap way to type a line and press Enter', async () => {
  const h = harness();
  await openBar(h);
  h.type('lucas'); h.el('#screen-input-fill').click(); await h.settle();
  await h.key('tab');
  h.type('s3nh@-forte'); h.el('#screen-input-send').click(); await h.settle();
  assert.deepEqual(h.form.submitted, { username: 'lucas', password: 's3nh@-forte' });
  assert.deepEqual(h.actions().at(-1), { type: 'keyboard.text', text: 's3nh@-forte', enter: true });
});

test('an IME that reports the action key only as a line break fills without Enter', async () => {
  const h = harness();
  await openBar(h);
  const box = h.el('#screen-input');
  // Chrome/WebView with keyCode 229: no usable keydown, only beforeinput.
  h.type('lucas');
  box.dispatchEvent({ type: 'keydown', key: 'Unidentified', keyCode: 229, preventDefault() {} });
  let prevented = false;
  box.dispatchEvent({ type: 'beforeinput', inputType: 'insertLineBreak', preventDefault() { prevented = true; } });
  await h.settle();
  assert.equal(prevented, true, 'the line break never lands in the draft');
  assert.deepEqual(h.actions(), [{ type: 'keyboard.text', text: 'lucas' }]);
  assert.equal(h.form.submitted, null);
  // A WebView that ignores preventDefault leaves the break in the draft: it is
  // stripped before anything is typed, so wtype never turns it into Return.
  h.calls.length = 0;
  box.value = 's3nh@\n'; box.dispatchEvent({ type: 'input', inputType: 'insertLineBreak' }); await h.settle();
  assert.deepEqual(h.actions(), [{ type: 'keyboard.text', text: 's3nh@' }]);
  assert.equal(h.form.submitted, null);
  assert.equal(box.value, '');
});

test('Fill refuses a draft that still has a line break, which the PC would type as Enter', async () => {
  const h = harness();
  await openBar(h);
  h.type('lucas\ns3nh@'); h.el('#screen-input-fill').click(); await h.settle();
  assert.deepEqual(h.actions(), [], 'nothing typed');
  assert.equal(h.form.submitted, null);
  assert.equal(h.el('#screen-input').value, 'lucas\ns3nh@', 'the draft stays to be fixed');
  assert.ok(h.el('#screen-input-hint').classList.contains('warn'));
});

test('a double tap while the PC is still typing does not type the line twice', async () => {
  let release;
  const gate = { promise: new Promise(resolve => { release = resolve; }) };
  const h = harness({ gate });
  await openBar(h);
  h.type('lucas');
  h.el('#screen-input-fill').click(); await flush();
  h.el('#screen-input-fill').click(); await flush();
  h.el('#screen-input-send').click(); await flush();
  release(); await h.settle();
  assert.deepEqual(h.actions(), [{ type: 'keyboard.text', text: 'lucas' }]);
  assert.deepEqual(h.form.fields, { username: 'lucas', password: '' });
  assert.equal(h.form.submitted, null);
});

test('a line typed at a password prompt in a terminal is not kept in the command history', async () => {
  const h = harness();
  await flush();
  h.run("terminalText = 'lucas@omarchy ~ $ sudo pacman -Syu\\n[sudo] password for lucas: '");
  h.run("rememberCommand('s3nh@-forte')");
  assert.equal(h.run('cmdHistory.length'), 0);
  assert.equal(h.saved.has('ponte-cmd-history'), false);
  h.run("terminalText = 'lucas@omarchy ~ $ '");
  h.run("rememberCommand('ls -la')");
  assert.deepEqual(JSON.parse(h.saved.get('ponte-cmd-history')), ['ls -la']);
});

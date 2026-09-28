import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

// The page side of the native agent alerts, against a fake PonteNative.
// Synthetic agents, ids and token only.
const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const TOKEN = 'synthetic-test-token';
const state = {
  hostname: 'test-desktop', windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: 'TEST-1', width: 1920, height: 1080, focused: true }],
  volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true }, warnings: [],
};
const sample = (id, status, extra = {}) => ({ id, kind: 'claude', title: `Sample ${id}`, cwd: '~/work/sample', state: status, waitingFor: null, since: Date.now(), where: { type: 'none' }, headless: false, transcript: true, canReply: false, ...extra });
const ok = value => ({ ok: true, json: async () => value });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// What the Android shell would do, minus Android: it records every call and
// answers agentAlerts() with whatever the test set.
function fakeBridge(initial = 'unset') {
  const bridge = {
    native: initial, calls: [], open: [],
    agentAlerts() { bridge.calls.push(['state']); return bridge.native; },
    setAgentAlerts(on, token, ask) { bridge.calls.push(['set', on, token, ask]); },
    forgetAgentAlerts() { bridge.calls.push(['forget']); },
    takeAgentToOpen() { bridge.calls.push(['take']); return bridge.open.shift() || ''; },
  };
  bridge.sets = () => bridge.calls.filter(call => call[0] === 'set');
  return bridge;
}

function harness({ bridge = null, stored = {}, items = [sample('p-30-1', 'working')] } = {}) {
  const document = makeDocument(html), window = makeWindow();
  if (bridge) window.PonteNative = bridge;
  const saved = new Map([['ponte-pair-token', TOKEN], ...Object.entries(stored)]);
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test PonteAndroid/0', vibrate: () => true }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async path => {
      if (path === '/api/agents') return ok({ items, scannedAt: Date.now(), scanMs: 5 });
      if (path === '/api/terminals') return ok({ available: true, sessions: [], limit: 4 });
      if (path.startsWith('/api/agents/') && path.endsWith('/transcript')) return ok({ id: path.split('/')[3], available: true, messages: [] });
      if (path === '/api/pair') return { ok: false, status: 403, json: async () => ({}) };
      return ok(state);
    },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  const run = source => vm.runInContext(source, context);
  return { document, saved, run, el: selector => document.querySelector(selector), i18n: window.PonteI18n, emit: (type, detail) => run(`window.dispatchEvent(new CustomEvent(${JSON.stringify(type)},{detail:${JSON.stringify(detail)}}))`) };
}

test('first load in the app: the switch (on by default) is handed to the shell with the key, asking for the permission once', async () => {
  const bridge = fakeBridge('unset');
  const h = harness({ bridge });
  await flush();
  assert.deepEqual(bridge.sets(), [['set', true, TOKEN, true]]);
  h.emit('ponte-native-alerts', 'on');
  assert.equal(h.el('#agent-notices').getAttribute('aria-pressed'), 'true');
  assert.equal(h.el('#agent-notices-hint').hidden, true);
  // Every later load and resume reports it again, without asking.
  bridge.native = 'on';
  h.run("window.dispatchEvent({type:'ponte-native-resume'})"); await flush();
  assert.deepEqual(bridge.sets().at(-1), ['set', true, TOKEN, false]);
  // Switched off: the shell gets off and never the key.
  h.run("navigate('terminais')"); await flush();
  h.el('#agent-notices').click(); await flush();
  assert.deepEqual(bridge.sets().at(-1), ['set', false, '', false]);
  assert.equal(h.saved.get('ponte-agent-notices'), 'off');
  // Back on by hand: this tap may ask Android again.
  h.el('#agent-notices').click(); await flush();
  assert.deepEqual(bridge.sets().at(-1), ['set', true, TOKEN, true]);
});

test('a switch already off in the page is recorded as off in the shell, without the key', async () => {
  const bridge = fakeBridge('unset');
  harness({ bridge, stored: { 'ponte-agent-notices': 'off' } });
  await flush();
  assert.deepEqual(bridge.sets(), [['set', false, '', false]]);
});

test('"Turn off" on the notification wins over the page on the next load and on resume', async () => {
  const bridge = fakeBridge('off');
  const h = harness({ bridge });
  await flush();
  assert.equal(h.el('#agent-notices').getAttribute('aria-pressed'), 'false');
  assert.equal(h.saved.get('ponte-agent-notices'), 'off');
  assert.deepEqual(bridge.sets(), [], 'nothing to send: the shell is already off');
  // The page's in-app notice follows: off means off.
  h.run("agentNoticeCheck([{id:'p-30-1',title:'Sample',headless:false,state:'working'}])");
  h.run("agentNoticeCheck([{id:'p-30-1',title:'Sample',headless:false,state:'waiting'}])");
  assert.equal(h.el('#agent-notice').hidden, true);
  // On again from the switch, then turned off from the notification while in the background.
  h.run("navigate('terminais')"); await flush();
  h.el('#agent-notices').click(); await flush();
  assert.equal(h.el('#agent-notices').getAttribute('aria-pressed'), 'true');
  bridge.native = 'off';
  h.run("window.dispatchEvent({type:'ponte-native-resume'})"); await flush();
  assert.equal(h.el('#agent-notices').getAttribute('aria-pressed'), 'false');
  assert.equal(h.saved.get('ponte-agent-notices'), 'off');
  // A shell that is on while the page thought off turns the page on, without asking.
  const other = fakeBridge('on');
  const again = harness({ bridge: other, stored: { 'ponte-agent-notices': 'off' } });
  await flush();
  assert.equal(again.el('#agent-notices').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(other.sets(), [['set', true, TOKEN, false]]);
});

test('notifications denied: the page says how to allow them, and the in-app notice keeps working', async () => {
  const bridge = fakeBridge('unset');
  const h = harness({ bridge });
  await flush();
  h.emit('ponte-native-alerts', 'blocked');
  assert.equal(h.el('#agent-notices').getAttribute('aria-pressed'), 'true', 'the switch stays on');
  assert.equal(h.el('#agent-notices-hint').hidden, false);
  assert.equal(h.el('#agent-notices-hint').textContent, 'Allow Ponte notifications in Settings to get alerts with the app closed');
  h.i18n.setLanguage('pt'); await flush();
  assert.equal(h.el('#agent-notices-hint').textContent, 'Permita notificações do Ponte nas configurações pra avisar com o app fechado');
  h.run("agentNoticeCheck([{id:'p-30-1',title:'Amostra',headless:false,state:'working'}])");
  h.run("agentNoticeCheck([{id:'p-30-1',title:'Amostra',headless:false,state:'waiting'}])");
  assert.equal(h.el('#agent-notice').hidden, false);
  assert.equal(h.el('#agent-notice-title').textContent, 'Amostra precisa de você');
  // A later load with the permission still missing shows it without asking again.
  const later = fakeBridge('blocked');
  const reloaded = harness({ bridge: later });
  await flush();
  assert.deepEqual(later.sets(), [['set', true, TOKEN, false]]);
  assert.equal(reloaded.el('#agent-notices-hint').hidden, false);
  // Switching off hides the hint.
  reloaded.run("navigate('terminais')"); await flush();
  reloaded.el('#agent-notices').click(); await flush();
  assert.equal(reloaded.el('#agent-notices-hint').hidden, true);
});

test('a tapped alert opens that agent\'s conversation on load and while open; anything else is ignored', async () => {
  const bridge = fakeBridge('on');
  bridge.open.push('p-30-1');
  const h = harness({ bridge, items: [sample('p-30-1', 'waiting', { waitingFor: 'input needed' }), sample('p-31-1', 'ready')] });
  await flush(); await flush();
  assert.equal(h.el('#agent-dialog').open, true);
  assert.equal(h.el('#agent-dialog-title').textContent, 'Sample p-30-1');
  assert.equal(h.run('currentPage'), 'terminais');
  h.run('closeAgent()');
  bridge.open.push('p-31-1');
  h.run("window.dispatchEvent({type:'ponte-native-agent'})"); await flush(); await flush();
  assert.equal(h.el('#agent-dialog').open, true);
  assert.equal(h.el('#agent-dialog-title').textContent, 'Sample p-31-1');
  h.run('closeAgent()');
  bridge.open.push('../../etc/passwd');
  h.run("window.dispatchEvent({type:'ponte-native-agent'})"); await flush();
  assert.equal(h.el('#agent-dialog').open, false, 'an id outside the agent pattern is dropped');
  bridge.open.push('w-0a1b');
  h.run("window.dispatchEvent({type:'ponte-native-resume'})"); await flush();
  assert.equal(h.el('#agent-dialog').open, true, 'resume also takes a pending id');
});

test('unpairing drops the shell\'s key; a browser without the bridge is unchanged', async () => {
  const bridge = fakeBridge('on');
  const h = harness({ bridge });
  await flush();
  const unpair = h.el('#unpair-button');
  unpair.dispatchEvent({ type: 'click', target: unpair, currentTarget: unpair }); await flush();
  assert.ok(bridge.calls.some(call => call[0] === 'forget'));
  assert.ok(!bridge.sets().some(call => call[1] === false), 'unpairing is not the owner turning alerts off');
  const plain = harness();
  await flush();
  plain.run("navigate('terminais')"); await flush();
  plain.el('#agent-notices').click(); await flush();
  assert.equal(plain.el('#agent-notices').getAttribute('aria-pressed'), 'false');
  assert.equal(plain.el('#agent-notices-hint').hidden, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const SELF = 'aaaaaaaaaaaaaaaa', NOTEBOOK = 'bbbbbbbbbbbbbbbb', OTHER = 'cccccccccccccccc';
const mesh = () => ({
  self: { id: SELF, name: 'pc-teste', os: 'linux' },
  peers: [
    { id: NOTEBOOK, name: 'notebook-teste', online: true, paired: true },
    { id: OTHER, name: 'outro-teste', online: true, paired: false },
  ],
  requests: [{ id: 'dddddddddddddddd', code: '123456', nodeId: 'eeeeeeeeeeeeeeee', name: 'tablet-teste', ip: '100.100.100.9' }],
  controllers: [{ id: 'eeeeeeeeeeeeeeee', name: 'tablet-teste', ip: '100.100.100.9' }],
});
const baseState = hostname => ({ hostname, windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: hostname === 'pc-teste' ? 'DP-3' : 'eDP-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true }, warnings: [] });

function harness({ respond = () => null } = {}) {
  const document = makeDocument(html), window = makeWindow();
  const saved = new Map([['ponte-pair-token', 'synthetic-test-token']]);
  const calls = [];
  const context = vm.createContext({
    document, window, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'Test browser' }, location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
      const custom = await respond(path, options);
      if (custom) return custom;
      if (path === '/api/state') return ok({ ...baseState('pc-teste'), mesh: mesh() });
      if (path === `/api/state?node=${NOTEBOOK}`) return ok({ ...baseState('notebook-teste'), node: { id: NOTEBOOK, name: 'notebook-teste' }, mesh: { ...mesh(), target: NOTEBOOK } });
      return ok({ ok: true });
    },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  return { document, calls, el: selector => document.querySelector(selector), run: source => vm.runInContext(source, context) };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

test('the device selector lists this device and paired ones, and the devices card offers the right action for each', async () => {
  const h = harness();
  await flush();
  assert.equal(h.el('#node-choice').hidden, false);
  const options = h.el('#node-select').querySelectorAll('option');
  assert.deepEqual(options.map(option => [option.getAttribute('value'), option.textContent]), [['', 'pc-teste · this device'], [NOTEBOOK, 'notebook-teste']]);
  assert.equal(h.el('#node-badge').hidden, true, 'no badge while this device is the target');
  assert.equal(h.el('#mesh-card').hidden, false);
  assert.match(h.el('#mesh-requests').textContent, /tablet-teste asks to control this device/);
  assert.match(h.el('#mesh-requests').textContent, /Code 123456/);
  assert.ok(h.el('[data-mesh-approve="123456"]')); assert.ok(h.el('[data-mesh-deny="123456"]'));
  assert.ok(h.el(`[data-mesh-control="${NOTEBOOK}"]`)); assert.ok(h.el('#mesh-peers').querySelector(`[data-mesh-revoke="${NOTEBOOK}"]`));
  assert.ok(h.el(`[data-mesh-pair="${OTHER}"]`)); assert.equal(h.el(`[data-mesh-control="${OTHER}"]`), null, 'an unpaired device cannot be controlled yet');
  assert.match(h.el('#mesh-controllers').textContent, /WHO CONTROLS THIS DEVICE/);
  assert.ok(h.el('#mesh-controllers').querySelector('[data-mesh-revoke="eeeeeeeeeeeeeeee"]'));
});

test('choosing a device routes every API call through node= while mesh actions stay on this node', async () => {
  const h = harness();
  await flush();
  const select = h.el('#node-select');
  select.value = NOTEBOOK; select.dispatchEvent({ type: 'change', target: select });
  await flush();
  assert.equal(h.calls.at(-1).path, `/api/state?node=${NOTEBOOK}`);
  assert.equal(h.el('#hostname').textContent, 'notebook-teste');
  assert.equal(h.el('#node-badge').hidden, false);
  assert.equal(h.el('#node-badge').textContent, 'notebook-teste');
  assert.equal(h.el('#node-badge').getAttribute('aria-label'), 'Controlling notebook-teste. Switch device');
  // Every transport: the fetch wrapper and the screen stream.
  await h.run("api('/terminals')");
  assert.equal(h.calls.at(-1).path, `/api/terminals?node=${NOTEBOOK}`);
  await h.run("api('/terminals?projects=1')");
  assert.equal(h.calls.at(-1).path, `/api/terminals?projects=1&node=${NOTEBOOK}`);
  await h.run("screenResponse('/stream?monitor=eDP-1&fps=10&scale=0.5',new AbortController())");
  assert.equal(h.calls.at(-1).path, `/api/stream?monitor=eDP-1&fps=10&scale=0.5&node=${NOTEBOOK}`);
  await h.run("action('workspace.focus',{id:2})");
  assert.equal(h.calls.at(-1).path, `/api/action?node=${NOTEBOOK}`);
  // The monitor preference is kept per device.
  assert.equal(h.run('monitorKey()'), `ponte-monitor:${NOTEBOOK}`);
  // Approving a request for this device never goes to the controlled one.
  h.el('[data-mesh-approve="123456"]').click();
  await flush();
  const approve = h.calls.find(call => call.body?.type === 'mesh.approve');
  assert.equal(approve.path, '/api/action');
  assert.deepEqual(approve.body, { type: 'mesh.approve', code: '123456' });
  h.el(`[data-mesh-pair="${OTHER}"]`).click();
  await flush();
  const pair = h.calls.find(call => call.body?.type === 'mesh.pair');
  assert.equal(pair.path, '/api/action'); assert.equal(pair.body.peer, OTHER);
  // Back to this device: no more node=.
  select.value = ''; select.dispatchEvent({ type: 'change', target: select });
  await flush();
  assert.equal(h.calls.at(-1).path, '/api/state');
  assert.equal(h.el('#node-badge').hidden, true);
  assert.equal(h.el('#hostname').textContent, 'pc-teste');
});

test('a device that refused the link sends the app back to this device', async () => {
  let refuse = false;
  const h = harness({ respond: path => refuse && path.includes('node=') ? fail(403, { errorCode: 'PEER_REVOKED', errorParameters: { name: 'notebook-teste' }, error: 'notebook-teste no longer accepts this device. Pair again.' }) : null });
  await flush();
  h.el(`[data-mesh-control="${NOTEBOOK}"]`).click();
  await flush();
  assert.equal(h.run('targetNode'), NOTEBOOK);
  assert.equal(h.run('currentPage'), 'tela');
  refuse = true;
  await h.run('pollState()');
  await flush();
  assert.equal(h.run('targetNode'), '');
  assert.match(h.el('#toast').textContent, /no longer accepts this device/);
  await h.run('pollState()');
  assert.equal(h.calls.filter(call => call.path.startsWith('/api/state')).at(-1).path, '/api/state');
});

test('without mesh data (an older server) the selector and the card stay hidden', async () => {
  const h = harness({ respond: path => path === '/api/state' ? ok(baseState('pc-teste')) : null });
  await flush();
  assert.equal(h.el('#node-choice').hidden, true);
  assert.equal(h.el('#mesh-card').hidden, true);
  assert.equal(h.el('#node-badge').hidden, true);
});

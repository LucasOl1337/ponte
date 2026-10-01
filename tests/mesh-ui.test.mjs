import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeDocument, makeWindow } from './helpers/dom.mjs';
import { composeDevices } from '../backend/devices.mjs';

const read = name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const [html, runtime, app] = await Promise.all(['index.html', 'i18n.js', 'app.js'].map(read));
const SELF = 'aaaaaaaaaaaaaaaa', NOTEBOOK = 'bbbbbbbbbbbbbbbb', OTHER = 'cccccccccccccccc', TABLET = 'eeeeeeeeeeeeeeee', PENDING = 'ffffffffffffffff', SLEEPY = '1111111111111111';
const mesh = () => ({
  self: { id: SELF, name: 'pc-teste', os: 'linux' },
  peers: [
    { id: NOTEBOOK, name: 'notebook-teste', online: true, paired: true },
    { id: OTHER, name: 'outro-teste', online: true, paired: false },
  ],
  requests: [{ id: 'dddddddddddddddd', code: '123456', nodeId: TABLET, name: 'tablet-teste', ip: '192.0.2.9' }],
  controllers: [{ id: TABLET, name: 'tablet-teste', ip: '192.0.2.9' }],
});

// The list the server would serve for that mesh plus a tailnet and SSH
// config: built by the real composer, so the UI is tested on the real shape.
// Addresses are documentation ranges, names are made up.
const tail = (name, ip, extra = {}) => ({ key: name, name, ip, lanIp: null, os: 'linux', online: true, self: false, lastSeen: '2026-10-01T09:00:00Z', link: 'direct', relay: null, ...extra });
const sshRoute = (alias, check, extra = {}) => ({ alias, kind: 'key', configured: false, label: null, check, ...extra });
const machine = (id, name, kind, tailnet, routes = [], extra = {}) => ({ id, name, kind, tailnet, routes, sshAlias: routes.find(route => route.kind === 'key')?.alias || null, probe: null, ...extra });
function listing({ peers } = {}) {
  const view = mesh();
  return composeDevices({
    mesh: { ...view, peers: peers || [
      ...view.peers,
      { id: PENDING, name: 'pc-novo', online: true, paired: false, pairing: { status: 'pending', code: '654321' } },
      { id: SLEEPY, name: 'pc-dormindo', online: false, paired: true },
    ] },
    nodes: { self: { ...view.self, kind: 'pc' }, nodes: [{ id: NOTEBOOK, ip: '192.0.2.2', kind: 'notebook' }, { id: TABLET, ip: '192.0.2.9', kind: null }] },
    fleet: { tailnet: { state: 'Running' }, checkedAt: 1, machines: [
      machine('self', 'pc-teste', 'this', tail('pc-teste', '192.0.2.1', { self: true, link: 'self' })),
      machine('ssh:notebook-teste', 'notebook-teste', 'computer', tail('notebook-teste', '192.0.2.2', { link: 'relay', relay: 'gru' }), [sshRoute('notebook-teste', { ok: false, code: 'DNS', ms: null, checkedAt: 1 })]),
      machine('ssh:servidor-teste', 'servidor-teste', 'server', tail('servidor-teste', '192.0.2.5'), [sshRoute('servidor-teste', { ok: true, ms: 23, code: null, checkedAt: 1 }, { configured: true })],
        { probe: { ok: true, tools: { claude: true, codex: true }, agents: [{}, {}], sessions: [] } }),
      machine('tail:celular-teste', 'celular-teste', 'phone', tail('celular-teste', '192.0.2.3', { os: 'android' })),
      machine('tail:velho-teste', 'velho-teste', 'computer', tail('velho-teste', '192.0.2.8', { online: false, lastSeen: '2026-09-20T09:00:00Z' })),
    ] },
    adb: [{ serial: '192.0.2.3:5555', state: 'device', model: null, ip: '192.0.2.3' }],
    now: 1790000000000,
  });
}
const baseState = hostname => ({ hostname, windows: [], activeWindow: null, workspaces: [], monitors: [{ id: 0, name: hostname === 'pc-teste' ? 'DP-3' : 'eDP-1', width: 1920, height: 1080, focused: true }], volume: { value: 0.3, muted: false }, capabilities: { keyboard: true, mouse: true, screenshot: true, live: true, audio: true }, warnings: [] });

function harness({ respond = () => null, devices = listing } = {}) {
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
      const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method || 'GET', body });
      const custom = await respond(path, options, body);
      if (custom) return custom;
      if (path === '/api/action' && body?.type === 'devices.list') return ok(devices());
      if (path === '/api/state') return ok({ ...baseState('pc-teste'), mesh: mesh() });
      if (path === `/api/state?node=${NOTEBOOK}`) return ok({ ...baseState('notebook-teste'), node: { id: NOTEBOOK, name: 'notebook-teste' }, mesh: { ...mesh(), target: NOTEBOOK } });
      if (path.startsWith('/api/terminals') && options.method === 'POST') return ok({ id: 'ponte-ssh-1', title: 'SSH servidor-teste' });
      return ok({ ok: true });
    },
  });
  vm.runInContext(runtime, context); vm.runInContext(app, context);
  const row = name => document.querySelectorAll('.device-row').find(item => item.querySelector('.device-name')?.textContent === name) || null;
  return { document, calls, row, el: selector => document.querySelector(selector), run: source => vm.runInContext(source, context) };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const ok = value => ({ ok: true, status: 200, json: async () => value });
const fail = (status, body) => ({ ok: false, status, json: async () => body });
const buttons = row => (row.querySelector('.device-actions')?.querySelectorAll('button') || []).map(button => [button.textContent, button.getAttribute('class').includes('primary')]);

test('"Your devices" draws devices.list: one row per device, main action by the rule, one line of why, pending requests on top', async () => {
  const h = harness();
  await flush();
  // The list is the home node's, asked through /api/action (the route every APK forwards).
  const ask = h.calls.find(call => call.body?.type === 'devices.list');
  assert.equal(ask.path, '/api/action');
  assert.equal(ask.method, 'POST');
  assert.equal(h.calls.some(call => call.path.startsWith('/api/devices')), false, 'never a route the old APK proxy refuses');
  assert.equal(h.el('#devices-card').hidden, false);
  assert.equal(h.el('#devices-card').querySelector('h2').textContent, 'Your devices');
  // Requests first, approved or denied here.
  assert.match(h.el('#devices-requests').textContent, /tablet-teste asks to control this device/);
  assert.match(h.el('#devices-requests').textContent, /Code 123456/);
  assert.ok(h.el('[data-mesh-approve="123456"]')); assert.ok(h.el('[data-mesh-deny="123456"]'));

  const self = h.row('pc-teste');
  assert.match(self.getAttribute('class'), /current/);
  assert.match(self.textContent, /this device/);
  assert.deepEqual(buttons(self), [['View screen', true], ['Terminal', false], ['Agents', false]]);

  // Paired over Ponte while SSH fails: online, controllable, SSH only a detail.
  const notebook = h.row('notebook-teste');
  assert.match(notebook.querySelector('.device-head').textContent, /Notebook/);
  assert.match(notebook.querySelector('.device-tag').textContent, /^online$/);
  assert.match(notebook.querySelector('.device-routes').textContent, /Ponte · paired/);
  assert.match(notebook.querySelector('.device-routes').textContent, /Tailscale via relay gru/);
  assert.match(notebook.querySelector('.device-routes').textContent, /SSH: DNS/);
  assert.deepEqual(buttons(notebook).slice(0, 3), [['Control', true], ['Terminal', false], ['Agents', false]]);
  assert.ok(notebook.querySelector(`[data-mesh-control="${NOTEBOOK}"]`));
  assert.equal(notebook.querySelector('.device-why'), null);
  // Revoke is behind ⋯, never a main button.
  assert.equal(notebook.querySelector('[data-mesh-revoke]'), null);
  notebook.querySelector('[data-device-more]').click();
  await flush();
  assert.ok(h.row('notebook-teste').querySelector(`[data-mesh-revoke="${NOTEBOOK}"]`));

  // SSH-only server: Terminal first, then Sessions; no Ponte, no why needed.
  const server = h.row('servidor-teste');
  assert.match(server.querySelector('.device-head').textContent, /Server/);
  assert.match(server.querySelector('.device-routes').textContent, /SSH 23 ms/);
  assert.match(server.querySelector('.device-routes').textContent, /2 open agents/);
  assert.match(server.querySelector('.device-routes').textContent, /Claude Code, Codex/);
  assert.deepEqual(buttons(server), [['Terminal', true], ['Sessions', false]]);

  // Ponte but not paired: Ask for access, and the why in one line.
  const other = h.row('outro-teste');
  assert.deepEqual(buttons(other), [['Ask for access', true]]);
  assert.equal(other.querySelector('.device-why').textContent, 'Not paired yet.');
  // Pending: no button, the why carries the code to approve over there.
  const pending = h.row('pc-novo');
  assert.equal(pending.querySelector('.device-actions'), null);
  assert.equal(pending.querySelector('.device-why').textContent, 'Waiting for approval on the other device. Code 654321');
  // Paired but asleep: still listed, offline, with its reason.
  const sleepy = h.row('pc-dormindo');
  assert.match(sleepy.getAttribute('class'), /offline/);
  // The phone: no Ponte, nothing to do from here, says why in one line.
  const phone = h.row('celular-teste');
  assert.match(phone.querySelector('.device-head').textContent, /Phone/);
  assert.match(phone.querySelector('.device-routes').textContent, /ADB · connected/);
  assert.equal(phone.querySelector('.device-actions'), null);
  assert.equal(phone.querySelector('.device-why').textContent, 'No way to reach it: neither Ponte nor SSH.');
  // The device that controls this one shows it, with Revoke behind ⋯.
  assert.match(h.row('tablet-teste').querySelector('.device-routes').textContent, /controls this device/);
  assert.ok(h.row('tablet-teste').querySelector(`[data-device-more="${TABLET}"]`));
  // An unpaired device offline for days folds into one line.
  assert.equal(h.row('velho-teste'), null);
  const fold = h.el('[data-devices-fold]');
  assert.equal(fold.textContent, 'Show 1 offline device');
  fold.click();
  await flush();
  assert.match(h.row('velho-teste').querySelector('.device-tag').textContent, /^offline · /);
  // No raw code, ever.
  assert.doesNotMatch(h.el('#devices-list').textContent, /NO_PONTE|NOT_PAIRED|PAIRING_PENDING|NO_ROUTE|undefined/);
});

test('the header selector is fed by the same list: this device plus every device with can.control', async () => {
  const h = harness();
  await flush();
  assert.equal(h.el('#node-choice').hidden, false);
  const options = h.el('#node-select').querySelectorAll('option');
  // pc-dormindo is paired but offline: can.control says no, so it is not offered.
  assert.deepEqual(options.map(option => [option.getAttribute('value'), option.textContent]), [['', 'pc-teste · this device'], [NOTEBOOK, 'notebook-teste']]);
  assert.equal(h.el('#node-badge').hidden, true, 'no badge while this device is the target');
});

test('choosing a device routes every API call through node= while the device list and mesh actions stay on this node', async () => {
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
  // The card marks the controlled one and offers View screen there.
  const notebook = h.row('notebook-teste');
  assert.match(notebook.getAttribute('class'), /current/);
  assert.match(notebook.querySelector('.device-tag').textContent, /controlling now/);
  assert.equal(buttons(notebook)[0][0], 'View screen');
  assert.doesNotMatch(h.row('pc-teste').getAttribute('class'), /current/);
  // Every transport: the fetch wrapper and the screen stream.
  await h.run("api('/terminals')");
  assert.equal(h.calls.at(-1).path, `/api/terminals?node=${NOTEBOOK}`);
  await h.run("api('/terminals?projects=1')");
  assert.equal(h.calls.at(-1).path, `/api/terminals?projects=1&node=${NOTEBOOK}`);
  await h.run("screenResponse('/stream?monitor=eDP-1&fps=10&scale=0.5',new AbortController())");
  assert.equal(h.calls.at(-1).path, `/api/stream?monitor=eDP-1&fps=10&scale=0.5&node=${NOTEBOOK}`);
  await h.run("action('workspace.focus',{id:2})");
  assert.equal(h.calls.at(-1).path, `/api/action?node=${NOTEBOOK}`);
  // The list is always the home node's view, never relayed.
  await h.run('loadDevices({force:true})');
  const ask = h.calls.filter(call => call.body?.type === 'devices.list').at(-1);
  assert.equal(ask.path, '/api/action');
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
  // A pairing action refreshes the list right away.
  assert.equal(h.calls.slice(h.calls.indexOf(pair)).some(call => call.body?.type === 'devices.list'), true);
  // Back to this device: no more node=.
  select.value = ''; select.dispatchEvent({ type: 'change', target: select });
  await flush();
  assert.equal(h.calls.at(-1).path, '/api/state');
  assert.equal(h.el('#node-badge').hidden, true);
  assert.equal(h.el('#hostname').textContent, 'pc-teste');
});

test('row actions go where the list says: View screen, Terminal over Ponte or SSH, Agents', async () => {
  const h = harness();
  await flush();
  h.row('notebook-teste').querySelector('[data-device-go="terminal"]').click();
  await flush();
  assert.equal(h.run('targetNode'), NOTEBOOK);
  assert.equal(h.run('currentPage'), 'terminais');
  // SSH terminal: a session on this node for the configured alias, never relayed.
  h.row('servidor-teste').querySelector('[data-device-go="terminal"]').click();
  await flush();
  assert.equal(h.run('targetNode'), '');
  const open = h.calls.find(call => call.method === 'POST' && call.path.startsWith('/api/terminals'));
  assert.equal(open.path, '/api/terminals');
  assert.equal(open.body.agent, 'ssh'); assert.equal(open.body.host, 'servidor-teste');
  assert.equal(h.run('currentPage'), 'terminais');
  h.run("navigate('inicio')");
  h.row('pc-teste').querySelector('[data-device-go="screen"]').click();
  await flush();
  assert.equal(h.run('currentPage'), 'tela');
  assert.equal(h.run('targetNode'), '');
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

test('a server without devices.list (it answers {ok:true}) keeps the selector and the requests on state.mesh', async () => {
  const h = harness({ devices: () => ({ ok: true }) });
  await flush();
  assert.equal(h.el('#devices-card').hidden, false);
  assert.deepEqual(h.el('#node-select').querySelectorAll('option').map(option => option.getAttribute('value')), ['', NOTEBOOK]);
  assert.equal(h.el('#devices-list').querySelectorAll('.device-row').length, 0);
  assert.match(h.el('#devices-requests').textContent, /tablet-teste asks to control this device/);
});

test('in Portuguese the card speaks the ADR vocabulary', async () => {
  const h = harness();
  h.run("i18n.setLanguage('pt')");
  await flush();
  h.run('meshSignature = ""; renderMesh()');
  assert.equal(h.el('#devices-card').querySelector('h2').textContent, 'Seus aparelhos');
  assert.match(h.row('notebook-teste').querySelector('.device-routes').textContent, /Ponte · pareado/);
  assert.deepEqual(buttons(h.row('notebook-teste')).slice(0, 1), [['Controlar', true]]);
  assert.deepEqual(buttons(h.row('pc-teste'))[0], ['Ver tela', true]);
  assert.equal(h.row('outro-teste').querySelector('.device-why').textContent, 'Ainda não está pareado.');
  assert.match(h.row('pc-teste').textContent, /este aparelho/);
  assert.doesNotMatch(h.el('#devices-list').textContent, /Emparelhado|máquina/i);
});

test('without mesh data (an older server) the selector and the card stay hidden and the list is never asked', async () => {
  const h = harness({ respond: path => path === '/api/state' ? ok(baseState('pc-teste')) : null });
  await flush();
  assert.equal(h.el('#node-choice').hidden, true);
  assert.equal(h.el('#devices-card').hidden, true);
  assert.equal(h.el('#node-badge').hidden, true);
  assert.equal(h.calls.some(call => call.body?.type === 'devices.list'), false);
});

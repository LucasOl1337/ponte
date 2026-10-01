import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { detectNodeKind } from '../backend/mesh.mjs';
import { composeDevices, findDevice, parseAdbDevices, createDevices, CAPABILITIES, DEVICE_KINDS } from '../backend/devices.mjs';

// Fixtures in the shapes mesh.list(), mesh.nodes() and fleet.overview()
// return. Addresses are documentation ranges (RFC 5737), names are made up.
const HOME = { id: 'a1a1a1a1a1a1a1a1', name: 'pc-teste', os: 'linux', version: '0.1.0-alpha.33' };
const NOTE = { id: 'b2b2b2b2b2b2b2b2', name: 'notebook-teste' };

const tail = (name, ip, extra = {}) => ({ key: name, name, dns: `${name}.exemplo.ts.net`, ip, lanIp: null, os: 'linux', online: true, self: false, lastSeen: '2026-10-01T09:00:00Z', link: 'relay', relay: 'gru', tagged: false, sshServer: true, ...extra });
const sshRoute = (alias, check, extra = {}) => ({ alias, names: [alias], hostname: `${alias}.exemplo.ts.net`, port: 22, user: 'eu', kind: 'key', configured: false, label: null, check, ...extra });
const machine = (id, name, kind, tailnet, routes = [], extra = {}) => ({ id, name, kind, tailnet, routes, mesh: null, sshAlias: routes.find(route => route.kind === 'key')?.alias || null, reachable: false, probe: null, health: 'unknown', ...extra });
const selfMachine = machine('self', 'pc-teste', 'this', tail('pc-teste', '192.0.2.1', { self: true, link: 'self', relay: null }));

function world({ peers = [], machines = [], nodes = [], requests = [], controllers = [], selfKind = 'pc' } = {}) {
  return {
    mesh: { self: HOME, peers, requests, controllers },
    nodes: { self: { ...HOME, kind: selfKind }, nodes },
    fleet: { tailnet: { state: 'Running', suffix: 'exemplo.ts.net' }, machines: [selfMachine, ...machines], checkedAt: 1 },
    now: 1790000000000,
  };
}
const byName = (listing, name) => listing.devices.find(item => item.name === name);

test('the home node is "this device": first, online, everything over Ponte, its own mesh id', () => {
  const listing = composeDevices(world());
  assert.equal(listing.v, 1);
  assert.deepEqual(listing.home, { id: HOME.id, name: 'pc-teste' });
  const self = listing.devices[0];
  assert.equal(self.self, true);
  assert.equal(self.id, HOME.id);
  assert.deepEqual(self.ids, [HOME.id, 'self']);
  assert.equal(self.kind, 'pc');
  assert.equal(self.status, 'online');
  assert.deepEqual(self.routes.map(route => route.via), ['ponte', 'tailscale']);
  for (const name of ['screen', 'control', 'terminal', 'agents']) assert.deepEqual(self.can[name], { ok: true, via: 'ponte' }, name);
  assert.deepEqual(self.can.pair, { ok: false, why: 'SELF' });
  assert.deepEqual(self.can.sessions, { ok: false, why: 'SELF' });
  assert.deepEqual(Object.keys(self.can), CAPABILITIES);
});

test('case 1: paired and online over Ponte while SSH fails is online and controllable (the two-card contradiction)', () => {
  const notebook = machine('ssh:notebook-teste', 'notebook-teste', 'computer', tail('notebook-teste', '192.0.2.2'),
    [sshRoute('notebook-teste', { ok: false, code: 'DNS', ms: null, checkedAt: 5 })], { health: 'unreachable' });
  const listing = composeDevices(world({
    peers: [{ id: NOTE.id, name: NOTE.name, os: 'linux', version: '0.1.0-alpha.33', online: true, paired: true, controlsMe: false }],
    nodes: [{ id: NOTE.id, ip: '192.0.2.2', kind: 'notebook' }],
    machines: [notebook],
  }));
  assert.equal(listing.devices.length, 2, 'the mesh node and the fleet machine are one device');
  const device = byName(listing, 'notebook-teste');
  assert.equal(device.id, NOTE.id, 'a Ponte node keeps the id ?node= takes');
  assert.deepEqual(device.ids, [NOTE.id, 'ssh:notebook-teste', 'tail:notebook-teste']);
  assert.equal(device.kind, 'notebook');
  assert.equal(device.status, 'online');
  assert.deepEqual(device.routes.find(route => route.via === 'ponte'), { via: 'ponte', state: 'paired', online: true, controlsMe: false });
  assert.deepEqual(device.routes.find(route => route.via === 'ssh').check, { ok: false, ms: null, code: 'DNS', checkedAt: 5 });
  assert.deepEqual(device.can.control, { ok: true, via: 'ponte' });
  assert.deepEqual(device.can.terminal, { ok: true, via: 'ponte' });
  assert.deepEqual(device.can.sessions, { ok: false, why: 'SSH_UNREACHABLE' });
  assert.deepEqual(device.can.pair, { ok: false, why: 'ALREADY_PAIRED' });
  assert.deepEqual(device.can.revoke, { ok: true, via: 'ponte' });
  assert.equal(device.ponte.version, '0.1.0-alpha.33');
});

test('the mesh joins the fleet by tailnet address before name: a node whose name differs still lands on its machine', () => {
  const box = machine('ssh:box', 'box', 'computer', tail('box', '192.0.2.9'), [sshRoute('box', null)]);
  const listing = composeDevices(world({
    peers: [{ id: NOTE.id, name: 'nome-do-no', os: 'linux', version: 'x', online: true, paired: false, controlsMe: false }],
    nodes: [{ id: NOTE.id, ip: '192.0.2.9', kind: null }],
    machines: [box],
  }));
  assert.equal(listing.devices.length, 2);
  const device = listing.devices.find(item => item.id === NOTE.id);
  assert.equal(device.name, 'nome-do-no');
  assert.ok(device.ids.includes('ssh:box'));
  assert.deepEqual(device.can.pair, { ok: true, via: 'ponte' });
  assert.deepEqual(device.can.control, { ok: false, why: 'NOT_PAIRED' });
});

test('case 2: an SSH-only server is a server with a terminal through its configured alias and sessions from the probe', () => {
  const probe = { ok: true, tools: { claude: true, codex: true, jcode: false }, agents: [{ kind: 'claude' }, { kind: 'codex' }], sessions: [] };
  const vm = machine('ssh:vm-trabalho', 'VM trabalho', 'server', null,
    [sshRoute('vm-trabalho', { ok: true, ms: 23, code: null, checkedAt: 7 }, { configured: true, label: 'VM trabalho' })], { probe, reachable: true, health: 'ok' });
  const device = byName(composeDevices(world({ machines: [vm] })), 'VM trabalho');
  assert.equal(device.id, 'ssh:vm-trabalho');
  assert.equal(device.kind, 'server');
  assert.equal(device.status, 'online');
  assert.equal(device.ponte, null);
  assert.deepEqual(device.routes.map(route => route.via), ['ssh']);
  assert.deepEqual(device.can.terminal, { ok: true, via: 'ssh', host: 'vm-trabalho' });
  assert.deepEqual(device.can.sessions, { ok: true, via: 'ssh', machine: 'ssh:vm-trabalho' });
  assert.deepEqual(device.can.control, { ok: false, why: 'NO_PONTE' });
  assert.deepEqual(device.can.pair, { ok: false, why: 'NO_PONTE' });
  assert.deepEqual(device.can.info, { ok: true, via: 'ssh' });
  assert.deepEqual(device.summary, { agents: 2, tools: ['claude', 'codex'] });
  // An alias outside ssh.hosts gives no terminal: the phone may only open listed ones.
  const unlisted = machine('ssh:outra', 'outra', 'server', null, [sshRoute('outra', { ok: true, ms: 9, checkedAt: 1 })]);
  assert.deepEqual(byName(composeDevices(world({ machines: [unlisted] })), 'outra').can.terminal, { ok: false, why: 'NO_ROUTE' });
});

test('case 3: a phone on the tailnet is a phone; with this node\'s adb it can be mirrored', () => {
  const phone = machine('tail:celular-teste', 'celular-teste', 'phone', tail('celular-teste', '192.0.2.3', { os: 'android', sshServer: false }));
  const adb = parseAdbDevices('List of devices attached\n192.0.2.3:5555         device product:x model:Telefone_Teste device:y transport_id:2\nemulator-5554          offline\n\n');
  assert.deepEqual(adb, [
    { serial: '192.0.2.3:5555', state: 'device', model: 'Telefone Teste', ip: '192.0.2.3' },
    { serial: 'emulator-5554', state: 'offline', model: null, ip: null },
  ]);
  const listing = composeDevices({ ...world({ machines: [phone] }), adb });
  const device = byName(listing, 'celular-teste');
  assert.equal(device.kind, 'phone');
  assert.equal(device.os, 'android');
  assert.deepEqual(device.routes.map(route => route.via), ['tailscale', 'adb']);
  assert.deepEqual(device.ids, ['tail:celular-teste', 'adb:192.0.2.3:5555']);
  assert.deepEqual(device.can.mirror, { ok: true, via: 'adb' });
  assert.deepEqual(device.can.control, { ok: false, why: 'NO_PONTE' });
  assert.deepEqual(device.can.terminal, { ok: false, why: 'NO_ROUTE' });
  assert.deepEqual(device.can.sessions, { ok: false, why: 'NO_SSH' });
  // An adb device with no tailnet match stands on its own.
  const emulator = listing.devices.find(item => item.id === 'adb:emulator-5554');
  assert.equal(emulator.kind, 'phone');
  assert.equal(emulator.status, 'unknown');
  assert.deepEqual(emulator.can.mirror, { ok: false, why: 'NO_ADB' });
});

test('case 4: an old remote node (no kind in its hello) is a PC, keeps its version and is controlled over the mesh', () => {
  const listing = composeDevices(world({
    peers: [{ id: NOTE.id, name: 'pc-antigo', os: 'linux', version: '0.1.0-alpha.25', online: true, paired: true, controlsMe: true }],
    nodes: [{ id: NOTE.id, ip: '192.0.2.7', kind: null }],
  }));
  const device = byName(listing, 'pc-antigo');
  assert.equal(device.kind, 'pc');
  assert.deepEqual(device.ponte, { version: '0.1.0-alpha.25' });
  assert.deepEqual(device.routes, [{ via: 'ponte', state: 'paired', online: true, controlsMe: true }]);
  assert.deepEqual(device.can.control, { ok: true, via: 'ponte' });
});

test('case 5: an offline device stays listed, last, with the reason for every missing action', () => {
  const tablet = machine('tail:tablet-teste', 'tablet-teste', 'phone', tail('tablet-teste', '192.0.2.5', { os: 'android', online: false }));
  const listing = composeDevices(world({
    peers: [{ id: NOTE.id, name: NOTE.name, os: 'linux', version: 'x', online: false, paired: true, controlsMe: false }],
    nodes: [{ id: NOTE.id, ip: '192.0.2.2', kind: 'notebook' }],
    machines: [tablet],
  }));
  assert.deepEqual(listing.devices.map(item => [item.name, item.status]), [['pc-teste', 'online'], ['notebook-teste', 'offline'], ['tablet-teste', 'offline']]);
  const notebook = byName(listing, 'notebook-teste');
  assert.deepEqual(notebook.can.control, { ok: false, why: 'OFFLINE' });
  assert.deepEqual(notebook.can.terminal, { ok: false, why: 'OFFLINE' });
  assert.deepEqual(notebook.can.revoke, { ok: true, via: 'ponte' }, 'a link can be cut while the other side is off');
  const offline = byName(listing, 'tablet-teste');
  assert.equal(offline.lastSeen, '2026-10-01T09:00:00Z');
  assert.deepEqual(offline.can.info, { ok: true, via: 'tailscale' });
});

test('pairing in progress and requests to control this node travel with the list', () => {
  const listing = composeDevices(world({
    peers: [{ id: NOTE.id, name: NOTE.name, os: 'linux', version: 'x', online: true, paired: false, controlsMe: false, pairing: { status: 'pending', code: '123456' } }],
    requests: [{ id: 'c'.repeat(16), code: '654321', nodeId: 'd'.repeat(16), name: 'outro-pc', ip: '192.0.2.8', expiresAt: 99 }],
  }));
  const device = byName(listing, 'notebook-teste');
  assert.deepEqual(device.pairing, { status: 'pending', code: '123456' });
  assert.deepEqual(device.routes[0], { via: 'ponte', state: 'pending', online: true, controlsMe: false, code: '123456' });
  assert.deepEqual(device.can.pair, { ok: false, why: 'PAIRING_PENDING' });
  assert.deepEqual(device.can.control, { ok: false, why: 'PAIRING_PENDING' });
  assert.deepEqual(listing.requests, [{ code: '654321', from: 'd'.repeat(16), name: 'outro-pc', expiresAt: 99 }]);
});

test('a node that only controls this one shows up with revoke, even when discovery no longer sees it', () => {
  const listing = composeDevices(world({ controllers: [{ id: NOTE.id, name: 'quem-controla', ip: '192.0.2.6', approvedAt: 'x', lastSeen: '2026-10-01T08:00:00Z' }] }));
  const device = byName(listing, 'quem-controla');
  assert.equal(device.routes[0].controlsMe, true);
  assert.equal(device.lastSeen, '2026-10-01T08:00:00Z');
  assert.deepEqual(device.can.revoke, { ok: true, via: 'ponte' });
});

test('every device has a known kind, status and a full set of capabilities', () => {
  const listing = composeDevices({ ...world({ machines: [machine('tail:x', 'x', 'computer', tail('x', '192.0.2.40', { os: 'windows' }))] }), adb: parseAdbDevices('List\nR5CT00000 device model:A\n') });
  for (const device of listing.devices) {
    assert.ok(DEVICE_KINDS.includes(device.kind), device.kind);
    assert.ok(['online', 'offline', 'unknown'].includes(device.status));
    assert.deepEqual(Object.keys(device.can), CAPABILITIES);
    for (const value of Object.values(device.can)) assert.ok(value.ok ? typeof value.via === 'string' : typeof value.why === 'string');
  }
  assert.equal(byName(listing, 'x').kind, 'other');
});

test('findDevice takes any id a device answers to, its name without case, or self', () => {
  const notebook = machine('ssh:notebook-teste', 'notebook-teste', 'computer', tail('notebook-teste', '192.0.2.2'), [sshRoute('notebook-teste', null)]);
  const listing = composeDevices(world({ peers: [{ id: NOTE.id, name: NOTE.name, online: true, paired: true }], nodes: [{ id: NOTE.id, ip: '192.0.2.2' }], machines: [notebook] }));
  for (const value of [NOTE.id, 'ssh:notebook-teste', 'tail:notebook-teste', 'NOTEBOOK-TESTE']) assert.equal(findDevice(listing, value)?.id, NOTE.id, value);
  assert.equal(findDevice(listing, 'self')?.id, HOME.id);
  assert.equal(findDevice(listing, 'nada'), null);
  assert.equal(findDevice(listing, ''), null);
});

test('createDevices reads the mesh cache by default, waits only when asked, and keeps adb off unless its server runs', async () => {
  const calls = [];
  const mesh = {
    view: () => { calls.push('view'); return { self: HOME, peers: [], requests: [], controllers: [] }; },
    list: async () => { calls.push('list'); return { self: HOME, peers: [], requests: [], controllers: [] }; },
    nodes: () => ({ self: { ...HOME, kind: 'pc' }, nodes: [] }),
  };
  const fleet = { overview: async options => { calls.push(['overview', options]); return { tailnet: { state: 'Running' }, machines: [selfMachine] }; } };
  const runs = [];
  // No adb server on this port: adb is never run.
  const devices = createDevices({ mesh, fleet, env: { ANDROID_ADB_SERVER_PORT: '1' }, runner: async (...args) => { runs.push(args); return ''; } });
  const fast = await devices.list();
  assert.deepEqual(calls, ['view', ['overview', { fresh: false, deep: false }]]);
  assert.equal(fast.devices[0].id, HOME.id);
  await devices.list({ deep: true });
  assert.deepEqual(calls.slice(2), ['list', ['overview', { fresh: false, deep: true }]]);
  assert.deepEqual(runs, []);
  // A failing fleet still gives the mesh's view.
  const lonely = createDevices({ mesh, fleet: { overview: async () => { throw new Error('x'); } }, adb: false });
  assert.equal((await lonely.list()).devices.length, 1);
  const injected = createDevices({ mesh, fleet, adb: async () => parseAdbDevices('List\n192.0.2.3:5555 device\n') });
  assert.equal((await injected.list()).devices.find(item => item.id === 'adb:192.0.2.3:5555').kind, 'phone');
  assert.equal((await injected.find('adb:192.0.2.3:5555')).name, '192.0.2.3:5555');
});

test('a node without node.kind guesses notebook from a system battery, pc otherwise', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-power-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const supply = async (name, files) => { await mkdir(path.join(root, name), { recursive: true }); for (const [file, value] of Object.entries(files)) await writeFile(path.join(root, name, file), `${value}\n`); };
  assert.equal(await detectNodeKind(path.join(root, 'missing')), 'pc');
  await supply('AC', { type: 'Mains' });
  await supply('hidpp_battery_0', { type: 'Battery', scope: 'Device' });
  assert.equal(await detectNodeKind(root), 'pc', 'a wireless mouse battery is not a notebook');
  await supply('BAT0', { type: 'Battery' });
  assert.equal(await detectNodeKind(root), 'notebook');
});

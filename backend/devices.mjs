import net from 'node:net';
import { runCommand } from './process.mjs';

// The device list (ADR 0002): one entity per computer or phone this node
// reaches, composed from what the mesh, the fleet and adb already know. It
// adds no discovery, pairing or transport. The rules (status, routes, what can
// be done and why not) live here, once; every surface only draws the answer.
//
// The answer is the home node's view: owner only, never relayed. The phone
// asks for it with POST /api/action {type:'devices.list'} (its proxy allows no
// new route), a browser or the CLI with GET /api/devices.

export const DEVICE_KINDS = Object.freeze(['pc', 'notebook', 'phone', 'server', 'other']);
export const CAPABILITIES = Object.freeze(['screen', 'control', 'terminal', 'agents', 'sessions', 'info', 'files', 'wake', 'pair', 'revoke', 'mirror']);
const ADB_TTL = 15000;
const PHONE_OS = new Set(['android', 'ios']);
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

const lower = value => String(value || '').toLowerCase();
const yes = via => ({ ok: true, via });
const no = why => ({ ok: false, why });

// `adb devices -l`: one line per device, "SERIAL STATE key:value…".
export function parseAdbDevices(text) {
  const list = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state || !SERIAL.test(serial)) continue;
    const fields = Object.fromEntries(rest.map(item => item.split(':')).filter(pair => pair.length === 2));
    const address = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(serial);
    list.push({ serial, state: state.slice(0, 20), model: (fields.model || '').replace(/_/g, ' ').slice(0, 40) || null, ip: address ? address[1] : null });
  }
  return list.slice(0, 16);
}

// A device that answers on one route is online; offline only when the tailnet
// says so and no other route answered.
function deviceStatus({ self, ponte, tailnet, ssh, adb }) {
  if (self || ponte?.online || tailnet?.online || ssh.some(route => route.check?.ok) || adb.some(route => route.state === 'device')) return 'online';
  if (tailnet && tailnet.online === false) return 'offline';
  if (ponte && ponte.online === false && ponte.state === 'paired') return 'offline';
  return 'unknown';
}

function deviceKind({ node, machine, adb }) {
  if (node?.kind) return node.kind;
  const os = lower(machine?.tailnet?.os || node?.os);
  if (PHONE_OS.has(os) || machine?.kind === 'phone' || (!machine && !node && adb.length)) return 'phone';
  if (node) return os === 'linux' ? 'pc' : 'other';
  if (machine?.kind === 'server') return 'server';
  // A Linux machine of the owner without Ponte: a server or VM.
  return os === 'linux' ? 'server' : 'other';
}

function ponteState(peer) {
  if (peer.paired) return 'paired';
  if (['pending', 'denied', 'expired'].includes(peer.pairing?.status)) return peer.pairing.status;
  return peer.online ? 'available' : 'known';
}

function capabilities({ self, ponte, ssh, adb, machine, status }) {
  const linked = self || (ponte?.state === 'paired' && ponte.online);
  const ponteWhy = () => !ponte ? 'NO_PONTE' : ponte.state === 'paired' ? 'OFFLINE' : ponte.state === 'pending' ? 'PAIRING_PENDING' : 'NOT_PAIRED';
  const configured = ssh.find(route => route.configured && route.kind !== 'tailscale-ssh');
  const terminal = linked ? yes('ponte')
    : configured && configured.check?.ok !== false ? { ok: true, via: 'ssh', host: configured.alias }
    : configured ? no('SSH_UNREACHABLE') : no(ponte ? ponteWhy() : 'NO_ROUTE');
  // Sessions continue here through the fleet's probe over a key route.
  const keyRoute = ssh.find(route => route.alias === machine?.sshAlias);
  const sessions = self ? no('SELF')
    : machine?.probe?.ok ? { ok: true, via: 'ssh', machine: machine.id }
    : machine?.probe && !machine.probe.ok ? no('PROBE_FAILED')
    : !keyRoute ? no('NO_SSH')
    : keyRoute.check?.ok === false ? no('SSH_UNREACHABLE') : no('UNCHECKED');
  const pair = self ? no('SELF') : !ponte ? no('NO_PONTE') : ponte.state === 'paired' ? no('ALREADY_PAIRED')
    : ponte.state === 'pending' ? no('PAIRING_PENDING') : ponte.online ? yes('ponte') : no('OFFLINE');
  const best = self || ponte?.online ? 'ponte' : ssh.some(route => route.check?.ok) ? 'ssh' : status === 'online' && adb.length ? 'adb' : 'tailscale';
  return {
    screen: linked ? yes('ponte') : no(ponteWhy()),
    control: linked ? yes('ponte') : no(ponteWhy()),
    terminal,
    agents: linked ? yes('ponte') : no(ponteWhy()),
    sessions,
    info: yes(best),
    files: no('NOT_AVAILABLE'),
    wake: no('NOT_AVAILABLE'),
    pair,
    revoke: !self && (ponte?.state === 'paired' || ponte?.controlsMe) ? yes('ponte') : no(self ? 'SELF' : 'NOT_PAIRED'),
    mirror: adb.some(route => route.state === 'device') ? yes('adb') : no('NO_ADB'),
  };
}

// The pure part: mesh, fleet and adb views in, the device list out.
//   mesh:  mesh.list() / mesh.view() ({self, peers, requests, controllers})
//   nodes: mesh.nodes() ({self: {..., kind}, nodes: [{id, ip, kind}]})
//   fleet: fleet.overview() ({tailnet, machines, checkedAt})
//   adb:   parseAdbDevices() of the home node, or []
export function composeDevices({ mesh = null, nodes = null, fleet = null, adb = [], now = Date.now() } = {}) {
  const machines = fleet?.machines || [];
  const selfNode = nodes?.self || mesh?.self || null;
  const nodeInfo = new Map((nodes?.nodes || []).map(item => [item.id, item]));
  const controllers = new Map((mesh?.controllers || []).map(item => [item.id, item]));
  const byIp = new Map(), byName = new Map();
  for (const machine of machines) {
    for (const ip of [machine.tailnet?.ip, machine.tailnet?.lanIp]) if (ip) byIp.set(ip, machine);
    for (const name of [machine.tailnet?.key, machine.tailnet?.name, machine.name]) if (name) byName.set(lower(name), machine);
  }
  const claimed = new Set();
  const entries = [];
  const claim = machine => { if (machine && !claimed.has(machine)) { claimed.add(machine); return machine; } return null; };

  // This node, then the other Ponte nodes (joined by tailnet address, then name).
  const selfMachine = claim(machines.find(machine => machine.id === 'self'));
  if (selfNode || selfMachine) entries.push({ self: true, node: selfNode, peer: null, machine: selfMachine });
  const peers = [...(mesh?.peers || [])];
  for (const item of controllers.values()) if (!peers.some(peer => peer.id === item.id)) peers.push({ id: item.id, name: item.name, online: false, paired: false, controlsMe: true });
  for (const peer of peers) {
    const info = nodeInfo.get(peer.id) || {};
    const machine = claim(byIp.get(info.ip || controllers.get(peer.id)?.ip)) || claim(byName.get(lower(peer.name)));
    entries.push({ self: false, node: { ...peer, kind: info.kind || null }, peer, machine });
  }
  for (const machine of machines) if (!claimed.has(machine)) entries.push({ self: false, node: null, peer: null, machine: claim(machine) });
  // adb devices of this node: on the matching tailnet device, or on their own.
  const adbFor = new Map();
  for (const item of adb) {
    const entry = entries.find(candidate => item.ip && [candidate.machine?.tailnet?.ip, candidate.machine?.tailnet?.lanIp].includes(item.ip))
      || (() => { const created = { self: false, node: null, peer: null, machine: null, adbOnly: item }; entries.push(created); return created; })();
    adbFor.set(entry, [...(adbFor.get(entry) || []), item]);
  }

  const devices = entries.map(entry => {
    const { self, node, peer, machine } = entry;
    const tail = machine?.tailnet || null;
    const adbItems = adbFor.get(entry) || [];
    const controller = node ? controllers.get(node.id) : null;
    const routes = [];
    const ponte = self ? { via: 'ponte', state: 'self', online: true, controlsMe: false }
      : peer ? { via: 'ponte', state: ponteState(peer), online: !!peer.online, controlsMe: !!peer.controlsMe, ...(peer.pairing?.status === 'pending' ? { code: peer.pairing.code } : {}) }
      : null;
    if (ponte) routes.push(ponte);
    const tailnet = tail ? { via: 'tailscale', ip: tail.ip || null, online: tail.online !== false, link: tail.link || null, relay: tail.relay || null, lastSeen: tail.lastSeen || null } : null;
    if (tailnet) routes.push(tailnet);
    const ssh = (machine?.routes || []).map(route => ({ via: 'ssh', alias: route.alias, kind: route.kind, configured: !!route.configured,
      check: route.check ? { ok: !!route.check.ok, ms: route.check.ms ?? null, code: route.check.code || null, checkedAt: route.check.checkedAt ?? null } : null }));
    routes.push(...ssh);
    const adbRoutes = adbItems.map(item => ({ via: 'adb', serial: item.serial, state: item.state }));
    routes.push(...adbRoutes);
    const status = deviceStatus({ self, ponte, tailnet: tail, ssh, adb: adbRoutes });
    const fleetId = machine && machine.id !== 'self' ? machine.id : null;
    const id = node?.id || fleetId || (entry.adbOnly ? `adb:${entry.adbOnly.serial}` : 'self');
    const ids = [...new Set([node?.id, self ? 'self' : null, fleetId, tail?.key && !self ? `tail:${tail.key}` : null,
      ...ssh.map(route => `ssh:${route.alias}`), ...adbItems.map(item => `adb:${item.serial}`)].filter(Boolean))];
    const label = machine?.routes?.find(route => route.label)?.label;
    const name = node?.name || label || machine?.name || entry.adbOnly?.model || entry.adbOnly?.serial || id;
    const probe = machine?.probe?.ok ? machine.probe : null;
    return {
      id, ids, name, kind: deviceKind({ node, machine, adb: adbItems }), self,
      os: (tail?.os || node?.os || (adbItems.length ? 'android' : null)) || null,
      ponte: node ? { version: node.version || null } : null,
      status,
      lastSeen: tail?.lastSeen || controller?.lastSeen || null,
      routes,
      can: capabilities({ self, ponte, ssh, adb: adbRoutes, machine, status }),
      pairing: peer?.pairing ? { status: peer.pairing.status, ...(peer.pairing.code ? { code: peer.pairing.code } : {}) } : null,
      summary: probe ? { agents: probe.agents?.length || 0, tools: ['claude', 'codex', 'jcode'].filter(tool => probe.tools?.[tool]) } : null,
    };
  });
  const order = { pc: 0, notebook: 1, server: 2, phone: 3, other: 4 };
  const rank = { online: 0, unknown: 1, offline: 2 };
  devices.sort((a, b) => Number(b.self) - Number(a.self) || rank[a.status] - rank[b.status] || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  return {
    v: 1,
    home: selfNode ? { id: selfNode.id, name: selfNode.name } : null,
    devices,
    requests: (mesh?.requests || []).map(item => ({ code: item.code, from: item.nodeId, name: item.name, expiresAt: item.expiresAt })),
    tailnet: fleet?.tailnet ? { state: fleet.tailnet.state || null } : null,
    checkedAt: now,
  };
}

// Any id a device answers to (`ids`), its name without case, or "self".
export function findDevice(listing, value) {
  const wanted = lower(value).trim();
  if (!wanted) return null;
  const list = listing?.devices || [];
  return list.find(item => item.ids.some(id => lower(id) === wanted)) || list.filter(item => lower(item.name) === wanted).at(0) || null;
}

// Is an adb server already up? Asking `adb devices` would start one.
function adbServerUp(port, timeout = 300) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.setTimeout(timeout, () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });
}

export function createDevices({ mesh, fleet, env = process.env, runner = runCommand, adb, now = Date.now } = {}) {
  const adbBin = env.PONTE_ADB_BIN || 'adb';
  const adbPort = Number(env.ANDROID_ADB_SERVER_PORT) || 5037;
  let adbCache = { at: 0, value: [] }, adbInflight = null;

  // adb is read only, and only when its server already runs (the PC that
  // keeps the phone link); `adb: false` turns it off, a function replaces it.
  async function adbDevices() {
    if (adb === false || env.PONTE_ADB === '0') return [];
    if (typeof adb === 'function') return adb();
    if (now() - adbCache.at < ADB_TTL) return adbCache.value;
    adbInflight ||= (async () => {
      let value = [];
      try { if (await adbServerUp(adbPort)) value = parseAdbDevices(await runner(adbBin, ['devices', '-l'], { env, timeout: 3000 })); } catch {}
      adbCache = { at: now(), value };
      return value;
    })().finally(() => { adbInflight = null; });
    return adbInflight;
  }

  // Fast by default (caches only, like mesh.view()); `deep` checks SSH routes
  // and probes machines, `fresh` skips every cache.
  async function list({ fresh = false, deep = false } = {}) {
    const [meshView, fleetView, adbView] = await Promise.all([
      deep || fresh ? mesh.list() : Promise.resolve(mesh.view()),
      fleet ? fleet.overview({ fresh, deep }).catch(() => null) : null,
      adbDevices().catch(() => []),
    ]);
    return composeDevices({ mesh: meshView, nodes: mesh.nodes?.() || null, fleet: fleetView, adb: adbView, now: now() });
  }

  return { list, find: async value => findDevice(await list(), value) };
}

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIPv4 } from 'node:net';
import { ApiError, runCommand } from './process.mjs';
import { SSH_HOST_PATTERN } from './config.mjs';
import { message, messages } from './i18n.mjs';

// The fleet: every machine the owner works on, and the way between them.
//
// Three sources are merged into one list of machines. The tailnet (who is
// online, direct or relayed), the Ponte mesh (which nodes this one can drive)
// and this user's ~/.ssh/config (which aliases reach which host, by key or by
// Tailscale SSH). Each SSH route is checked for real with BatchMode (a key
// that does not log in fails instead of prompting) over a shared connection
// (ControlMaster), so later probes, copies and terminals reuse one handshake.
//
// On each reachable machine backend/fleet-probe.py (standard library only)
// reports its agents and recent sessions. A handoff copies one agent session
// (Claude Code, Codex or Jcode) from the machine where it ran to this one, or
// to any other, brings the git branch along, and resumes it in a Ponte
// terminal, so work started on the notebook continues on the PC.
//
// Every value that reaches a command line is one of: an alias read from
// ~/.ssh/config and matched against SSH_HOST_PATTERN, a session id matched
// against its agent's own id pattern, a branch name, a commit id, or a path the
// probe itself reported. Nothing typed on the phone reaches ssh or a shell.

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_FILE = path.join(here, 'fleet-probe.py');
const PROBE_TTL = 20000;
const CHECK_TTL = 45000;
const JOB_LIMIT = 20;
const SESSION_ID = {
  claude: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  codex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  jcode: /^session_[a-z0-9]{1,32}_[0-9]{10,16}_[0-9a-f]{8,32}$/,
};
export const AGENT_KINDS = Object.freeze(Object.keys(SESSION_ID));
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{40,64}$/;
const MACHINE_ID = /^(self|ssh:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const ABS_PATH = /^\/[^\u0000-\u001f\u007f]{0,1023}$/;

const clean = (value, max = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '';
const shortHost = value => clean(String(value || '').replace(/\.$/, '').split('.')[0], 64).toLowerCase();
// ssh joins its remote argv with spaces and the login shell there splits it
// again, so every remote word is single-quoted.
export const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

// ~/.ssh/config: concrete Host lines only (no patterns), each with its names.
export function parseSshConfig(text) {
  const entries = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    if (/[*?!]/.test(match[1])) continue;
    const names = match[1].split(/\s+/).filter(name => SSH_HOST_PATTERN.test(name));
    if (names.length) entries.push({ alias: names[0], names });
  }
  return entries;
}

// `ssh -G ALIAS`: the effective options, lower-cased keys, first value wins.
export function parseSshG(text) {
  const values = {};
  for (const line of String(text || '').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 1) continue;
    const key = line.slice(0, space).toLowerCase();
    if (!(key in values)) values[key] = line.slice(space + 1).trim();
  }
  return values;
}

// What kind of way in an alias is: a key login (checkable by an agent), a
// Tailscale SSH login (asks for a browser check, never checked here), or a
// hop through another machine (RemoteCommand: works only in a terminal).
export function routeKind(values) {
  if (values.remotecommand && values.remotecommand !== 'none') return 'hop';
  if (values.preferredauthentications === 'none' || ['no', 'false'].includes(values.pubkeyauthentication)) return 'tailscale-ssh';
  return 'key';
}

// Why an ssh check failed, from its stderr, as a stable code for the UI.
export function classifySshFailure(stderr = '', timedOut = false) {
  const text = String(stderr);
  if (timedOut || /timed out|Connection timed out/i.test(text)) return 'TIMEOUT';
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(text)) return 'DNS';
  if (/Connection refused/i.test(text)) return 'REFUSED';
  if (/No route to host|Network is unreachable/i.test(text)) return 'UNREACHABLE';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) return 'HOST_KEY';
  if (/Permission denied|Too many authentication failures/i.test(text)) return 'AUTH';
  if (/tailscale|check|browser/i.test(text) && /ssh/i.test(text)) return 'TAILSCALE_CHECK';
  return 'FAILED';
}

// A machine's key in the fleet: its tailnet host name when it has one, else
// the SSH host name, else the alias.
const tailKey = peer => shortHost(peer.DNSName || peer.HostName);

export function createFleet(options = {}) {
  const env = options.env || process.env;
  const runner = options.runner || runCommand;
  const home = options.home || env.HOME || os.homedir();
  const dataDir = options.dataDir;
  const controlDir = path.join(dataDir, 'fleet');
  const sshBin = env.PONTE_SSH_BIN || 'ssh';
  const pythonBin = env.PONTE_PYTHON_BIN || 'python3';
  const tailscaleBin = env.PONTE_TAILSCALE_BIN || 'tailscale';
  const mesh = options.mesh || null;
  const terminals = options.terminals || null;
  const now = options.now || Date.now;
  const spawnImpl = options.spawn || spawn;
  const sshConfigFile = options.sshConfigFile || path.join(home, '.ssh', 'config');
  const configuredHosts = new Map((options.sshHosts || []).map(item => [item.host, item.label]));
  let probeSource = options.probeSource || null;
  const probes = new Map();     // machine id -> { at, value, error, inflight }
  const checks = new Map();     // alias -> { at, value, inflight }
  const jobs = new Map();
  let inventoryCache = null, inventoryAt = 0, inventoryInflight = null;

  async function source() {
    probeSource ||= await readFile(PROBE_FILE, 'utf8');
    return probeSource;
  }
  async function controlPath() {
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    const info = await lstat(controlDir);
    if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new ApiError(503, 'FLEET_UNAVAILABLE');
    // %C is a hash of the connection: short enough for a Unix socket path.
    return path.join(controlDir, '%C');
  }
  // ssh options every fleet connection shares: never a prompt, a bounded
  // connect, and one master connection per destination kept for 10 minutes.
  async function sshOptions(extra = []) {
    return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
      '-o', 'ControlMaster=auto', '-o', `ControlPath=${await controlPath()}`, '-o', 'ControlPersist=600', '-o', 'RequestTTY=no', '-T', ...extra];
  }

  // ------------------------------------------------------------- inventory
  async function tailnet() {
    try {
      const status = JSON.parse(await runner(tailscaleBin, ['status', '--json'], { env, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }));
      const selfNode = status?.Self || {};
      const devices = [];
      for (const peer of [selfNode, ...Object.values(status?.Peer || {})]) {
        const ip = (peer.TailscaleIPs || []).find(address => isIPv4(address)) || null;
        const lan = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(String(peer.CurAddr || ''));
        devices.push({
          key: tailKey(peer), name: clean(peer.HostName, 64), dns: clean(String(peer.DNSName || '').replace(/\.$/, ''), 200), ip, lanIp: lan ? lan[1] : null,
          os: clean(peer.OS, 24).toLowerCase(), online: peer === selfNode ? true : !!peer.Online, self: peer === selfNode,
          lastSeen: peer.LastSeen && !String(peer.LastSeen).startsWith('0001') ? peer.LastSeen : null,
          link: peer === selfNode ? 'self' : peer.CurAddr ? 'direct' : peer.Relay ? 'relay' : null, relay: clean(peer.Relay, 16) || null,
          tagged: Array.isArray(peer.Tags) && peer.Tags.length > 0, sshServer: Array.isArray(peer.sshHostKeys) && peer.sshHostKeys.length > 0,
        });
      }
      return { state: clean(status?.BackendState, 24), suffix: clean(status?.MagicDNSSuffix, 120), devices };
    } catch { return { state: 'unavailable', suffix: '', devices: [] }; }
  }

  async function sshRoutes() {
    let text = '';
    try { text = await readFile(sshConfigFile, 'utf8'); } catch { return []; }
    const entries = parseSshConfig(text).slice(0, 32);
    return Promise.all(entries.map(async entry => {
      let values = {};
      try { values = parseSshG(await runner(sshBin, ['-G', entry.alias], { env, timeout: 3000 })); } catch {}
      const hostname = clean(values.hostname || entry.alias, 200);
      return { alias: entry.alias, names: entry.names, hostname, port: Number(values.port) || 22, user: clean(values.user, 64) || null,
        kind: routeKind(values), configured: configuredHosts.has(entry.alias), label: configuredHosts.get(entry.alias) || null };
    }));
  }

  // One machine per tailnet device or per SSH hostname outside the tailnet.
  function assemble(tail, routes, meshView) {
    const machines = new Map();
    const byIp = new Map(), byName = new Map();
    for (const device of tail.devices) {
      const id = device.self ? 'self' : `tail:${device.key}`;
      const machine = { id, name: device.name || device.key, tailnet: device, routes: [], mesh: null, kind: device.self ? 'this' : ['android', 'ios'].includes(device.os) ? 'phone' : 'computer' };
      machines.set(id, machine);
      if (device.ip) byIp.set(device.ip, machine);
      // A direct link also names the device's LAN address (CurAddr), so a
      // `*-lan` alias with that address is the same machine.
      if (device.lanIp) byIp.set(device.lanIp, machine);
      for (const name of [device.key, device.dns, shortHost(device.dns)]) if (name) byName.set(name.toLowerCase(), machine);
    }
    for (const route of routes) {
      const host = route.hostname.toLowerCase();
      let machine = byIp.get(host) || byName.get(host) || byName.get(shortHost(host));
      if (!machine && ['127.0.0.1', 'localhost', os.hostname().toLowerCase()].includes(host)) machine = machines.get('self');
      if (!machine) {
        const id = `ssh:${route.alias}`;
        machine = machines.get(`host:${host}`) || { id, name: route.label || route.alias, tailnet: null, routes: [], mesh: null, kind: 'server' };
        machines.set(`host:${host}`, machine);
      }
      machine.routes.push(route);
    }
    for (const peer of meshView?.peers || []) {
      const machine = byName.get(String(peer.name || '').toLowerCase());
      if (machine) machine.mesh = { id: peer.id, paired: !!peer.paired, online: !!peer.online, version: peer.version || null, controlsMe: !!peer.controlsMe };
    }
    const self = machines.get('self');
    if (self && meshView?.self) self.mesh = { id: meshView.self.id, self: true, version: meshView.self.version || null };
    const list = [...new Set(machines.values())];
    for (const machine of list) {
      // The route agents use: a key route that works, preferring the one the
      // owner listed for Ponte terminals, then the tailnet name.
      const keyRoutes = machine.routes.filter(route => route.kind === 'key');
      machine.sshAlias = (keyRoutes.find(route => route.configured) || keyRoutes.find(route => !/lan$/i.test(route.alias)) || keyRoutes[0])?.alias || null;
      if (machine.id.startsWith('tail:') || machine.id.startsWith('host:')) machine.id = machine.sshAlias ? `ssh:${machine.sshAlias}` : machine.id;
      if (machine.kind === 'server' && machine.routes[0]?.label) machine.name = machine.routes[0].label;
    }
    const order = { this: 0, computer: 1, server: 2, phone: 3 };
    return list.sort((a, b) => order[a.kind] - order[b.kind] || Number(!!b.tailnet?.online || !!b.sshAlias) - Number(!!a.tailnet?.online || !!a.sshAlias) || a.name.localeCompare(b.name));
  }

  async function inventory({ fresh = false } = {}) {
    if (!fresh && inventoryCache && now() - inventoryAt < 15000) return inventoryCache;
    if (inventoryInflight) return inventoryInflight;
    inventoryInflight = (async () => {
      const [tail, routes, meshView] = await Promise.all([tailnet(), sshRoutes(), mesh ? mesh.list({ wait: false }).catch(() => null) : null]);
      inventoryCache = { tailnet: { state: tail.state, suffix: tail.suffix }, machines: assemble(tail, routes, meshView) };
      inventoryAt = now();
      return inventoryCache;
    })().finally(() => { inventoryInflight = null; });
    return inventoryInflight;
  }

  // ------------------------------------------------------------ ssh checks
  async function check(alias, { fresh = false } = {}) {
    if (!SSH_HOST_PATTERN.test(alias || '')) throw new ApiError(400, 'FLEET_MACHINE_NOT_FOUND');
    const cached = checks.get(alias);
    if (cached?.inflight) return cached.inflight;
    if (!fresh && cached?.value && now() - cached.at < CHECK_TTL) return cached.value;
    const entry = cached || {};
    entry.inflight = (async () => {
      const started = now();
      let value;
      try {
        // A master already up answers `-O check` at once: the route is warm.
        let warm = false;
        try { await runner(sshBin, [...await sshOptions(), '-O', 'check', alias], { env, timeout: 3000 }); warm = true; } catch {}
        const before = now();
        await runner(sshBin, [...await sshOptions(), alias, 'true'], { env, timeout: 15000 });
        value = { ok: true, ms: now() - before, connectMs: warm ? null : now() - started, warm, checkedAt: now() };
      } catch (error) {
        const detail = error.detail || {};
        value = { ok: false, code: classifySshFailure(detail.stderr, detail.timedOut), error: clean(detail.stderr, 200) || null, checkedAt: now() };
      }
      entry.value = value; entry.at = now();
      return value;
    })().finally(() => { entry.inflight = null; });
    checks.set(alias, entry);
    return entry.inflight;
  }

  // ---------------------------------------------------------------- probes
  // The probe runs as `python3 - ARGS` with the script on stdin, so a machine
  // needs nothing installed besides Python 3.8+.
  async function runProbe(machineId, args, { timeout = 30000 } = {}) {
    const script = await source();
    if (machineId === 'self') return runner(pythonBin, ['-', ...args], { env, input: script, timeout, maxBuffer: 8 * 1024 * 1024 });
    const alias = machineId.slice(4);
    return runner(sshBin, [...await sshOptions(), alias, 'python3', '-', ...args.map(shellQuote)], { env, input: script, timeout, maxBuffer: 8 * 1024 * 1024 });
  }
  const parseProbe = text => {
    const value = JSON.parse(String(text).trim().split('\n').pop());
    if (value?.error) throw new ApiError(409, 'FLEET_PROBE_REFUSED', { reason: clean(value.error, 40) });
    return value;
  };

  async function probe(machineId, { fresh = false } = {}) {
    if (!MACHINE_ID.test(machineId || '')) throw new ApiError(404, 'FLEET_MACHINE_NOT_FOUND');
    const cached = probes.get(machineId);
    if (cached?.inflight) return cached.inflight;
    if (!fresh && cached && now() - cached.at < PROBE_TTL) return cached.value;
    const entry = cached || {};
    entry.inflight = (async () => {
      const started = now();
      let value;
      try { value = { ok: true, ...sanitizeProbe(parseProbe(await runProbe(machineId, ['probe'], { timeout: 25000 }))), roundTripMs: now() - started }; }
      catch (error) {
        const detail = error.detail || {};
        value = { ok: false, code: error.code === 'FLEET_PROBE_REFUSED' ? error.code : classifySshFailure(detail.stderr, detail.timedOut), error: clean(detail.stderr, 200) || null };
      }
      value.probedAt = now();
      entry.value = value; entry.at = now();
      return value;
    })().finally(() => { entry.inflight = null; });
    probes.set(machineId, entry);
    return entry.inflight;
  }

  // Only known fields, bounded, leave the machine that reported them.
  function sanitizeProbe(raw) {
    const text = (value, max) => clean(value, max) || null;
    const num = value => Number.isFinite(value) ? value : null;
    const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).filter(item => SESSION_ID[item?.kind]?.test(item.id)).slice(0, 30).map(item => ({
      kind: item.kind, id: item.id, title: text(item.title, 160) || item.kind, last: text(item.last, 200), cwd: text(item.cwd, 300), branch: text(item.branch, 120),
      updatedAt: num(item.updatedAt), live: !!item.live,
    }));
    const agents = (Array.isArray(raw.agents) ? raw.agents : []).slice(0, 40).map(item => ({
      kind: text(item.kind, 20), pid: num(item.pid), cwd: text(item.cwd, 300), session: typeof item.session === 'string' && Object.values(SESSION_ID).some(pattern => pattern.test(item.session)) ? item.session : null,
    }));
    const tools = {};
    for (const name of ['claude', 'codex', 'jcode', 'tmux', 'git', 'node']) tools[name] = !!raw.tools?.[name];
    return {
      hostname: text(raw.hostname, 64), user: text(raw.user, 64), home: text(raw.home, 300), kernel: text(raw.kernel, 80), arch: text(raw.arch, 20),
      python: text(raw.python, 10), uptime: num(raw.uptime), load: Array.isArray(raw.load) ? raw.load.slice(0, 3).map(num) : null, cpus: num(raw.cpus),
      memory: { total: num(raw.memory?.total), available: num(raw.memory?.available) }, tools, ponte: text(raw.ponte, 40), agents, sessions, probeMs: num(raw.probeMs),
    };
  }

  // ------------------------------------------------------------- overview
  // Machines, their routes and, when asked, a fresh check and probe of each.
  async function overview({ fresh = false, deep = false } = {}) {
    const listing = await inventory({ fresh });
    const machines = await Promise.all(listing.machines.map(async machine => {
      const routes = await Promise.all(machine.routes.map(async route => {
        const cached = checks.get(route.alias)?.value || null;
        const status = route.kind === 'key' && (deep || fresh) && (machine.tailnet?.online !== false) ? await check(route.alias, { fresh }) : cached;
        return { ...route, check: status };
      }));
      const reachable = machine.id === 'self' || routes.some(route => route.alias === machine.sshAlias && route.check?.ok);
      let probeValue = probes.get(machine.id)?.value || null;
      if (deep && reachable && MACHINE_ID.test(machine.id)) probeValue = await probe(machine.id, { fresh });
      return { ...machine, routes, reachable, probe: probeValue, health: health(machine, routes, probeValue) };
    }));
    return { tailnet: listing.tailnet, machines, checkedAt: now() };
  }

  // One word per machine for the UI and for an agent choosing where to work.
  function health(machine, routes, probeValue) {
    if (machine.id === 'self') return probeValue && !probeValue.ok ? 'degraded' : 'ok';
    if (machine.tailnet && !machine.tailnet.online) return 'offline';
    const primary = routes.find(route => route.alias === machine.sshAlias);
    if (!primary) return machine.tailnet?.online ? (machine.kind === 'phone' ? 'ok' : 'no-ssh') : 'unknown';
    if (!primary.check) return 'unchecked';
    if (!primary.check.ok) return 'unreachable';
    if (probeValue && !probeValue.ok) return 'degraded';
    return 'ok';
  }

  async function sessions({ fresh = false } = {}) {
    const listing = await overview({ fresh, deep: true });
    const items = [];
    for (const machine of listing.machines) {
      for (const item of machine.probe?.ok ? machine.probe.sessions : []) items.push({ ...item, machine: machine.id, machineName: machine.name });
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { sessions: items.slice(0, 60), machines: listing.machines.map(machine => ({ id: machine.id, name: machine.name, reachable: machine.reachable, health: machine.health })) };
  }

  // ---------------------------------------------------------------- stream
  // Two probe commands joined by a pipe that never touches a shell: the
  // exporter's stdout goes into the importer's stdin, byte for byte. Used for
  // agent sessions and git bundles, which can be tens of megabytes.
  async function probeArgv(machineId, args) {
    if (machineId === 'self') return [pythonBin, ['-c', await source(), ...args]];
    return [sshBin, [...await sshOptions(), machineId.slice(4), 'python3', '-c', shellQuote(await source()), ...args.map(shellQuote)]];
  }
  async function pipe(fromMachine, fromArgs, toMachine, toArgs, { timeout = 10 * 60 * 1000, onProgress, stage = 'import' } = {}) {
    const [fromCmd, fromArgv] = await probeArgv(fromMachine, fromArgs);
    const [toCmd, toArgv] = await probeArgv(toMachine, toArgs);
    return new Promise((resolve, reject) => {
      const producer = spawnImpl(fromCmd, fromArgv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const consumer = spawnImpl(toCmd, toArgv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let bytes = 0, out = '', producerErr = '', consumerErr = '', producerCode = null, consumerCode = null, done = false;
      const timer = setTimeout(() => { producer.kill('SIGKILL'); consumer.kill('SIGKILL'); }, timeout);
      producer.stdout.on('data', chunk => { bytes += chunk.length; onProgress?.(bytes); });
      producer.stdout.pipe(consumer.stdin);
      consumer.stdin.on('error', () => {});
      producer.stderr.on('data', chunk => { producerErr = (producerErr + chunk).slice(-2000); });
      consumer.stderr.on('data', chunk => { consumerErr = (consumerErr + chunk).slice(-2000); });
      consumer.stdout.on('data', chunk => { out = (out + chunk).slice(-64 * 1024); });
      const finish = () => {
        if (done || producerCode === null || consumerCode === null) return;
        done = true; clearTimeout(timer);
        let value = null;
        try { value = JSON.parse(out.trim().split('\n').pop()); } catch {}
        if (producerCode !== 0) {
          let reason = null; try { reason = JSON.parse(producerErr.trim().split('\n').pop())?.error; } catch {}
          reject(Object.assign(new Error('export failed'), { stage: 'export', code: reason || classifySshFailure(producerErr), stderr: clean(producerErr, 300) }));
        } else if (consumerCode !== 0 || !value || value.error) reject(Object.assign(new Error(`${stage} failed`), { stage, code: value?.error || classifySshFailure(consumerErr), detail: value, stderr: clean(consumerErr, 300) }));
        else resolve({ ...value, bytes });
      };
      producer.on('close', code => { producerCode = code ?? 1; finish(); });
      consumer.on('close', code => { consumerCode = code ?? 1; finish(); });
      producer.on('error', () => { producerCode = 1; finish(); });
      consumer.on('error', () => { consumerCode = 1; finish(); });
    });
  }

  // --------------------------------------------------------------- handoff
  async function machineById(id) {
    if (!MACHINE_ID.test(id || '')) throw new ApiError(404, 'FLEET_MACHINE_NOT_FOUND');
    const listing = await inventory();
    const machine = listing.machines.find(item => item.id === id);
    if (!machine) throw new ApiError(404, 'FLEET_MACHINE_NOT_FOUND');
    return machine;
  }

  function validHandoff(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    const allowed = ['from', 'to', 'kind', 'session', 'git', 'resume', 'force', 'dryRun'];
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    const { from, to = 'self', kind, session } = value;
    if (!MACHINE_ID.test(from || '') || !MACHINE_ID.test(to || '') || from === to) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    if (!AGENT_KINDS.includes(kind) || !SESSION_ID[kind].test(session || '')) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    const git = value.git ?? 'branch';
    if (!['branch', 'changes', 'none'].includes(git)) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    for (const key of ['resume', 'force', 'dryRun']) if (key in value && typeof value[key] !== 'boolean') throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    return { from, to, kind, session, git, resume: value.resume !== false, force: value.force === true, dryRun: value.dryRun === true };
  }

  function publicJob(job) {
    const { id, status, from, to, kind, session, git, steps, result, error, createdAt, finishedAt, bytes } = job;
    return { id, status, from, to, kind, session, git, steps, result, error, createdAt, finishedAt, bytes };
  }

  function handoff(value) {
    const request = validHandoff(value);
    if ([...jobs.values()].some(job => job.status === 'running' && job.session === request.session)) throw new ApiError(409, 'FLEET_HANDOFF_BUSY');
    const job = { id: randomBytes(8).toString('hex'), status: 'running', ...request, steps: [], result: null, error: null, createdAt: now(), finishedAt: null, bytes: 0 };
    jobs.set(job.id, job);
    while (jobs.size > JOB_LIMIT) jobs.delete(jobs.keys().next().value);
    job.promise = runHandoff(job).then(result => { job.status = 'done'; job.result = result; }, error => {
      job.status = 'failed';
      const raw = error.code && /^[A-Z_]{2,40}$/.test(error.code) ? error.code : 'HANDOFF_FAILED';
      const code = raw.startsWith('FLEET_') ? raw : `FLEET_${raw}`;
      const known = Object.hasOwn(messages, code) ? code : 'FLEET_HANDOFF_FAILED';
      const parameters = { stage: error.stage || '', branch: error.detail?.branch || '', dir: error.detail?.dir || error.detail?.detail || '' };
      job.error = { code: known, raw, stage: error.stage || null, detail: clean(error.stderr || error.detail?.detail || '', 300) || null,
        text: { en: message(known, 'en', parameters), pt: message(known, 'pt', parameters) } };
    }).finally(() => { job.finishedAt = now(); });
    return publicJob(job);
  }

  async function runHandoff(job) {
    const step = (name, detail = {}) => { job.steps.push({ name, at: now(), ...detail }); };
    const [from, to] = await Promise.all([machineById(job.from), machineById(job.to)]);
    for (const machine of [from, to]) if (machine.id !== 'self' && !machine.sshAlias) throw Object.assign(new Error('no route'), { code: 'FLEET_NO_ROUTE', stage: 'route' });

    // 1. The session on the source: where it ran and whether it is still open.
    const info = parseProbe(await runProbe(job.from, ['info', job.kind, job.session]));
    step('session', { cwd: info.cwdShort, bytes: info.bytes, live: info.live });
    if (info.live && !job.force) throw Object.assign(new Error('live'), { code: 'FLEET_SESSION_LIVE', stage: 'session' });

    // 2. The project on both sides: same repository, where it lives on the
    // destination, and what state each checkout is in.
    let sourceGit = { repo: false };
    if (info.cwd) sourceGit = parseProbe(await runProbe(job.from, ['git-info', info.cwd]));
    let destination = null, destGit = null;
    const project = path.posix.basename(sourceGit.repo ? sourceGit.rootAbs : info.cwd || '') || 'project';
    if (sourceGit.repo) {
      const hint = String(sourceGit.rootAbs).startsWith(`${info.home}/`) ? `~/${String(sourceGit.rootAbs).slice(info.home.length + 1)}` : sourceGit.rootAbs;
      const located = parseProbe(await runProbe(job.to, ['locate', sourceGit.origin || '', project, hint]));
      if (located.found) destination = located.dirAbs;
      else if (sourceGit.origin && job.git !== 'none' && !job.dryRun) {
        const cloned = parseProbe(await runProbe(job.to, ['clone', sourceGit.origin, located.suggestAbs], { timeout: 10 * 60 * 1000 }));
        destination = cloned.dirAbs;
        step('clone', { dir: cloned.dir });
      } else throw Object.assign(new Error('no checkout'), { code: 'FLEET_NO_CHECKOUT', stage: 'project', detail: { detail: located.suggest } });
      // The session may have run in a subfolder of the repository.
      const sub = info.cwd && info.cwd.startsWith(`${sourceGit.rootAbs}/`) ? info.cwd.slice(sourceGit.rootAbs.length + 1) : '';
      destGit = parseProbe(await runProbe(job.to, ['git-info', destination]));
      if (sub) destination = `${destGit.rootAbs}/${sub}`;
    } else {
      // Not a repository: the same path under the destination's home.
      const probeTo = await probe(job.to);
      const relative = info.cwd && info.home && info.cwd.startsWith(info.home) ? info.cwd.slice(info.home.length) : '';
      destination = probeTo.ok && probeTo.home ? `${probeTo.home}${relative}` : null;
      destGit = destination ? parseProbe(await runProbe(job.to, ['git-info', destination])) : null;
      if (!destGit?.exists) throw Object.assign(new Error('no folder'), { code: 'FLEET_NO_CHECKOUT', stage: 'project', detail: { detail: destination } });
    }
    if (!ABS_PATH.test(destination || '')) throw Object.assign(new Error('bad path'), { code: 'FLEET_NO_CHECKOUT', stage: 'project' });
    step('project', { source: sourceGit.repo ? { branch: sourceGit.branch, head: sourceGit.head, changed: sourceGit.changed, untracked: sourceGit.untracked, ahead: sourceGit.ahead } : null,
      destination: { dir: destination, branch: destGit?.branch || null, head: destGit?.head || null, changed: destGit?.changed || 0 } });
    if (job.dryRun) return { dryRun: true, destination, sourceGit: sourceGit.repo ? { branch: sourceGit.branch, head: sourceGit.head, changed: sourceGit.changed, untracked: sourceGit.untracked } : null, destGit };

    // 3. Code: the source branch's commits travel as a git bundle (only what
    // the destination lacks), then the destination fast-forwards to it. It
    // never merges, resets or discards: a diverged or dirty destination stops.
    if (sourceGit.repo && job.git !== 'none' && sourceGit.branch && BRANCH.test(sourceGit.branch) && SHA.test(sourceGit.head || '')) {
      const known = parseProbe(await runProbe(job.to, ['refs', destination])).shas.filter(sha => SHA.test(sha));
      const moved = await pipe(job.from, ['bundle', sourceGit.rootAbs, sourceGit.branch, ...known.slice(0, 120)], job.to, ['unbundle', destGit.rootAbs, sourceGit.branch, sourceGit.head], { stage: 'git' });
      step('git', { action: moved.action, bytes: moved.bytes });
      if (job.git === 'changes' && (sourceGit.changed || sourceGit.untracked)) {
        const applied = await pipe(job.from, ['git-patch', sourceGit.rootAbs], job.to, ['git-apply', destGit.rootAbs], { stage: 'changes' });
        step('changes', { changed: applied.changed, untracked: applied.untracked, bytes: applied.bytes });
      } else if (sourceGit.changed || sourceGit.untracked) step('changes', { skipped: true, changed: sourceGit.changed, untracked: sourceGit.untracked });
    }

    // 4. The conversation itself, with its paths rewritten for this machine.
    const imported = await pipe(job.from, ['export', job.kind, job.session], job.to, ['import', destination, ...(job.force ? ['--force'] : [])], { stage: 'copy', onProgress: bytes => { job.bytes = bytes; } });
    step('copy', { files: imported.files, bytes: imported.bytes });

    // 5. Resume: a Ponte terminal on the destination running the agent's own
    // resume command. Here directly; on a paired node through the mesh.
    const command = resumeCommand(job.kind, job.session);
    let terminal = null;
    if (job.resume) {
      try {
        if (job.to === 'self') terminal = await resumeHere({ kind: job.kind, session: job.session, directory: destination });
        else if (to.mesh?.paired && mesh?.call) {
          const answer = await mesh.call(to.mesh.id, { method: 'POST', target: '/api/fleet/resume', body: { kind: job.kind, session: job.session, directory: destination } });
          if (answer.status !== 200 && answer.status !== 201) throw Object.assign(new Error('resume'), { code: answer.body?.errorCode || 'FLEET_RESUME_FAILED' });
          terminal = { ...answer.body, node: to.mesh.id };
        }
        step('resume', terminal ? { terminal: terminal.id, title: terminal.title, node: terminal.node || null } : { manual: true });
      } catch (error) {
        // The copy is done; only the terminal failed. The command still works by hand.
        step('resume', { manual: true, error: /^[A-Z_]{2,40}$/.test(error.code || '') ? error.code : 'FLEET_RESUME_FAILED' });
      }
    }
    const fromName = from.name, toName = to.name;
    return { destination, command, terminal, from: fromName, to: toName, note: continuationNote({ fromName, toName, sourceGit, job }) };
  }

  // A copied session resumed here, in a Ponte terminal (phone, Dev, `ctl`).
  // The session must exist on this machine and the folder must be a folder.
  async function resumeHere(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['kind', 'session', 'directory'].includes(key))) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    const { kind, session, directory } = value;
    const argv = resumeCommand(kind, session);
    const info = parseProbe(await runProbe('self', ['info', kind, session]));
    const folder = directory ?? info.cwd;
    if (!ABS_PATH.test(folder || '')) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
    if (info.live) throw new ApiError(409, 'FLEET_SESSION_LIVE');
    if (!terminals?.createInternal) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    return terminals.createInternal({ title: { claude: 'Claude', codex: 'Codex', jcode: 'Jcode' }[kind], directory: folder, argv });
  }

  return {
    inventory, overview, check, probe, sessions, handoff, resume: resumeHere,
    job(id) { const job = jobs.get(id); if (!job) throw new ApiError(404, 'FLEET_JOB_NOT_FOUND'); return publicJob(job); },
    jobs() { return { jobs: [...jobs.values()].reverse().map(publicJob) }; },
    async wait(id, timeout = 600000) { const job = jobs.get(id); if (!job) throw new ApiError(404, 'FLEET_JOB_NOT_FOUND'); await Promise.race([job.promise, new Promise(resolve => setTimeout(resolve, timeout).unref?.())]); return publicJob(job); },
    async close() {
      // Masters persist on their own for 10 minutes; nothing else to stop.
    },
  };
}

// The agent's own resume command, as argv.
export function resumeCommand(kind, session) {
  if (!SESSION_ID[kind]?.test(session || '')) throw new ApiError(400, 'FLEET_INVALID_REQUEST');
  if (kind === 'claude') return ['claude', '--resume', session];
  if (kind === 'codex') return ['codex', 'resume', session];
  return ['jcode', '--resume', session];
}

function continuationNote({ fromName, toName, sourceGit, job }) {
  const parts = [`Sessão continuada de ${fromName} para ${toName} pelo Ponte.`];
  if (sourceGit?.repo) {
    parts.push(`Branch ${sourceGit.branch || '(detached)'} em ${String(sourceGit.head || '').slice(0, 9)}.`);
    if ((sourceGit.changed || sourceGit.untracked) && job.git !== 'changes') parts.push(`${sourceGit.changed + sourceGit.untracked} arquivo(s) sem commit ficaram em ${fromName}.`);
  }
  parts.push('Confira `git status` antes de seguir.');
  return parts.join(' ');
}

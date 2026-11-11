// Windows machines as screen targets. Ponte does not run there: a small agent
// (tools/windows-agent) serves JPEG frames and takes pointer and keyboard
// input on the machine's 127.0.0.1, and this node reaches it through an SSH
// forward to a private unix socket. The phone picks such a machine like a
// paired node; its requests carry ?node=ssh:ALIAS and land here instead of
// the mesh relay. Only the screen, the pointer and the keyboard: no
// workspaces, terminals, agents, audio or video stream.
import http from 'node:http';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { ApiError } from './process.mjs';
import { comboCodes } from './desktop.mjs';

const DRAG_LEASE_MS = 1800;

// Windows virtual-key codes for the named keys of desktop.mjs.
const VK = { Enter: 0x0D, Escape: 0x1B, BackSpace: 0x08, Tab: 0x09, Delete: 0x2E, Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27,
  Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Ctrl: 0x11, Shift: 0x10, Alt: 0x12, Super: 0x5B, F4: 0x73, F5: 0x74 };
export const WINDOWS_KEYS = Object.freeze({
  Enter: [VK.Enter], Escape: [VK.Escape], BackSpace: [VK.BackSpace], Tab: [VK.Tab], Delete: [VK.Delete],
  ArrowUp: [VK.Up], ArrowDown: [VK.Down], ArrowLeft: [VK.Left], ArrowRight: [VK.Right],
  Home: [VK.Home], End: [VK.End], PageUp: [VK.PageUp], PageDown: [VK.PageDown],
  Copy: [VK.Ctrl, 0x43], Paste: [VK.Ctrl, 0x56], Undo: [VK.Ctrl, 0x5A], SelectAll: [VK.Ctrl, 0x41],
  AltTab: [VK.Alt, VK.Tab], Super: [VK.Super], CloseWindow: [VK.Alt, VK.F4],
  ShiftTab: [VK.Shift, VK.Tab], ShiftEnter: [VK.Shift, VK.Enter],
  'Ctrl+Shift+C': [VK.Ctrl, VK.Shift, 0x43], 'Ctrl+Shift+V': [VK.Ctrl, VK.Shift, 0x56], 'Ctrl+Shift+Z': [VK.Ctrl, VK.Shift, 0x5A],
  'Ctrl+D': [VK.Ctrl, 0x44], 'Ctrl+F': [VK.Ctrl, 0x46], 'Ctrl+L': [VK.Ctrl, 0x4C], 'Ctrl+R': [VK.Ctrl, 0x52],
  'Ctrl+S': [VK.Ctrl, 0x53], 'Ctrl+T': [VK.Ctrl, 0x54], 'Ctrl+W': [VK.Ctrl, 0x57], 'Ctrl+Tab': [VK.Ctrl, VK.Tab], F5: [VK.F5],
});
// evdev codes of comboCodes() → virtual keys (Super+… shortcuts).
const EVDEV_TO_VK = (() => {
  const map = { 125: VK.Super, 29: VK.Ctrl, 56: VK.Alt, 42: VK.Shift, 28: VK.Enter, 57: 0x20, 15: VK.Tab, 1: VK.Escape, 14: VK.BackSpace, 111: VK.Delete,
    105: VK.Left, 106: VK.Right, 103: VK.Up, 108: VK.Down, 51: 0xBC, 52: 0xBE, 53: 0xBF, 12: 0xBD, 13: 0xBB, 87: 0x7A, 88: 0x7B, 99: 0x2C };
  'QWERTYUIOP'.split('').forEach((key, i) => { map[16 + i] = key.charCodeAt(0); });
  'ASDFGHJKL'.split('').forEach((key, i) => { map[30 + i] = key.charCodeAt(0); });
  'ZXCVBNM'.split('').forEach((key, i) => { map[44 + i] = key.charCodeAt(0); });
  '1234567890'.split('').forEach((key, i) => { map[2 + i] = key.charCodeAt(0); });
  for (let i = 0; i < 10; i++) map[59 + i] = 0x70 + i;
  return map;
})();

const num = (value, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ApiError(400, 'NUMBER_OUT_OF_RANGE', { min, max });
  return Math.round(value);
};

// Ponte actions → the agent's input ops. `monitors` are the agent's (x/y in
// the virtual desktop); a monitor-relative point becomes absolute here.
export function translateAction(value, monitors) {
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new ApiError(400, 'INVALID_ACTION');
  const at = () => {
    const monitor = monitors.find(item => item.name === value.monitor);
    if (!monitor) throw new ApiError(400, 'INVALID_MONITOR');
    const x = num(value.x, 0, monitor.width - 1), y = num(value.y, 0, monitor.height - 1);
    return { op: 'moveTo', x: monitor.x + x, y: monitor.y + y };
  };
  const button = () => {
    if (!['left', 'right', 'middle'].includes(value.button)) throw new ApiError(400, 'INVALID_BUTTON');
    return value.button;
  };
  switch (value.type) {
    case 'mouse.move': return [{ op: 'move', dx: num(value.dx, -1000, 1000), dy: num(value.dy, -1000, 1000) }];
    case 'mouse.click': return [{ op: 'click', button: button() }];
    case 'mouse.clickAt': { const b = button(); return [at(), { op: 'click', button: b }]; }
    case 'mouse.moveTo': return [at()];
    case 'mouse.scroll': return [...(value.monitor !== undefined ? [at()] : []), { op: 'wheel', dy: num(value.dy, -30, 30) }];
    case 'mouse.dragStartAt': return [{ op: 'button', button: 'left', down: false }, at(), { op: 'button', button: 'left', down: true }];
    case 'mouse.drag':
      if (typeof value.pressed !== 'boolean') throw new ApiError(400, 'INVALID_DRAG_STATE');
      return value.pressed ? [] : [{ op: 'button', button: 'left', down: false }];
    case 'keyboard.text':
      if (typeof value.text !== 'string' || !value.text.length || value.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)) throw new ApiError(400, 'INVALID_TEXT');
      return [{ op: 'text', text: value.text }, ...(value.enter === true ? [{ op: 'keys', vks: [VK.Enter] }] : [])];
    case 'keyboard.key':
      if (!Object.hasOwn(WINDOWS_KEYS, value.key)) throw new ApiError(400, 'KEY_NOT_ALLOWED');
      return [{ op: 'keys', vks: WINDOWS_KEYS[value.key] }];
    case 'keyboard.combo': {
      const vks = comboCodes(value.combo).map(code => EVDEV_TO_VK[code]);
      if (vks.some(vk => !vk)) throw new ApiError(400, 'KEY_NOT_ALLOWED');
      return [{ op: 'keys', vks }];
    }
    default: throw new ApiError(400, 'ACTION_NOT_ALLOWED');
  }
}

export function createWindowsTargets({ hosts = [], configDir, dataDir, env = process.env, spawn = spawnChild, log = console, request: requestOverride } = {}) {
  const targets = new Map(hosts.map(item => [item.host, { ...item, tunnel: null, starting: null, token: null, monitors: [], dragTimer: null }]));
  let closed = false;
  const socketDir = path.join(dataDir || '/tmp', 'windows');

  function byNode(value) {
    if (typeof value !== 'string') return null;
    const alias = value.replace(/^(ssh|win):/, '');
    return targets.get(alias) || [...targets.values()].find(item => item.label.toLowerCase() === value.toLowerCase()) || null;
  }

  async function token(target) {
    if (target.token) return target.token;
    const file = path.join(configDir, 'windows', `${target.host}.token`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || (info.mode & 0o077)) throw new ApiError(503, 'WINDOWS_AGENT_UNAVAILABLE', { name: target.label });
    target.token = (await readFile(file, 'utf8')).trim();
    return target.token;
  }

  // One ssh -N per machine, started on first use and again after it dies.
  async function tunnel(target) {
    if (target.tunnel && target.tunnel.exitCode === null && !target.tunnel.killed) return target.socket;
    if (target.starting) return target.starting;
    target.starting = (async () => {
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      target.socket = path.join(socketDir, `${target.host}.sock`);
      await rm(target.socket, { force: true });
      const child = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'StreamLocalBindUnlink=yes', '-o', 'ConnectTimeout=8', '-L', `${target.socket}:127.0.0.1:${target.port}`, target.host], { stdio: ['ignore', 'ignore', 'pipe'], env });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
      child.once('exit', code => { if (target.tunnel === child) target.tunnel = null; if (!closed && code) log.error?.(`[windows] ssh ${target.host} exited (${code}): ${stderr.trim()}`); });
      target.tunnel = child;
      for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) break;
        if (await stat(target.socket).then(() => true, () => false)) return target.socket;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      child.kill();
      throw new ApiError(502, 'PEER_OFFLINE', { name: target.label });
    })().finally(() => { target.starting = null; });
    return target.starting;
  }

  async function call(target, method, route, { body, signal, binary = false, timeout = 8000 } = {}) {
    if (requestOverride) return requestOverride(target, method, route, { body, binary });
    const [socketPath, bearer] = await Promise.all([tunnel(target), token(target)]);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: route, signal, headers: { Authorization: `Bearer ${bearer}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const data = Buffer.concat(chunks);
          if (res.statusCode === 200) { resolve(binary ? data : JSON.parse(data.toString('utf8'))); return; }
          let code = null; try { code = JSON.parse(data.toString('utf8')).error; } catch {}
          if (res.statusCode === 401) target.token = null;
          reject(res.statusCode === 400 && /^[A-Z_]+$/.test(code || '') ? new ApiError(400, code) : new ApiError(502, 'WINDOWS_AGENT_UNAVAILABLE', { name: target.label }));
        });
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeout);
      req.on('error', error => { clearTimeout(timer); reject(error.name === 'AbortError' ? error : new ApiError(502, 'PEER_OFFLINE', { name: target.label })); });
      req.end(payload);
    });
  }

  async function readState(target) {
    const raw = await call(target, 'GET', '/state');
    target.monitors = (raw.monitors || []).map(m => ({ name: String(m.name), x: m.x, y: m.y, width: m.width, height: m.height, focused: !!m.focused }));
    return raw;
  }

  // The /api/state answer the phone expects from a Ponte node, from what Windows can tell.
  async function state(target, { version, mesh } = {}) {
    const raw = await readState(target);
    const active = raw.active?.title ? { address: raw.active.address, title: String(raw.active.title).slice(0, 1000), class: String(raw.active.class || '').slice(0, 250), monitor: null, workspace: { id: 0, name: '' } } : null;
    return {
      hostname: raw.hostname || target.label, uptime: 0, os: 'windows',
      activeWindow: active,
      monitors: target.monitors.map((m, id) => ({ id, name: m.name, width: m.width, height: m.height, focused: m.focused, dpmsStatus: true, activeWorkspace: null })),
      workspaces: [], windows: [], volume: { value: 0, muted: false },
      capabilities: { mouse: true, keyboard: true, screenshot: true, audio: false, live: true, lights: false, lock: false, stt: false, rd: false },
      warningCodes: [], warnings: [],
      wakeOnLan: { mac: null, interface: null, enabled: null, instructions: '' }, power: { wakeOnLan: { mac: null, interface: null, enabled: null, instructions: '' } },
      session: { locked: null, lockAvailable: false }, textInput: { available: false, focused: null, context: null }, lights: null,
      version, node: { id: `ssh:${target.host}`, name: target.label, version: null, os: 'windows' },
      ...(mesh ? { mesh } : {}),
    };
  }

  async function action(target, value) {
    if (!target.monitors.length) await readState(target);
    const ops = translateAction(value, target.monitors);
    // A held drag is renewed by the phone; a lost phone must not leave the button down.
    if (value.type === 'mouse.dragStartAt' || (value.type === 'mouse.drag' && value.pressed)) {
      clearTimeout(target.dragTimer);
      target.dragTimer = setTimeout(() => { call(target, 'POST', '/input', { body: { op: 'button', button: 'left', down: false } }).catch(() => {}); }, DRAG_LEASE_MS);
      target.dragTimer.unref?.();
    } else if (value.type === 'mouse.drag') clearTimeout(target.dragTimer);
    for (const op of ops) await call(target, 'POST', '/input', { body: op });
    if (value.type === 'mouse.dragStartAt') return { ok: true, window: null };
    if (value.type === 'keyboard.combo') return { ok: true, combo: value.combo };
    return { ok: true };
  }

  function frameRoute({ monitor, scale = 0.5, quality = 65, region } = {}) {
    const query = new URLSearchParams({ scale: String(scale), q: String(quality) });
    if (monitor) query.set('monitor', monitor);
    if (region) for (const key of ['x', 'y', 'w', 'h']) query.set(key, String(region[key]));
    return `/frame?${query}`;
  }

  // The shape live.mjs takes from desktop.prepareLive, so the MJPEG stream,
  // its slots and its pacing are the same code as on a Ponte node.
  function liveSource(target) {
    return {
      async prepareLive({ monitor, scale, quality = 65, region, signal }) {
        if (!target.monitors.length) await readState(target);
        const selected = target.monitors.find(item => item.name === (monitor ?? target.monitors.find(m => m.focused)?.name ?? target.monitors[0]?.name));
        if (!selected) throw new ApiError(400, 'INVALID_MONITOR');
        const crop = region && !(region.w >= selected.width * 0.98 && region.h >= selected.height * 0.98) ? region : null;
        const route = frameRoute({ monitor: selected.name, scale: crop ? 1 : scale, quality, region: crop });
        return { monitor: selected.name, region: crop, capture: captureSignal => call(target, 'GET', route, { binary: true, signal: captureSignal || signal }) };
      },
    };
  }

  async function screenshot(target, monitor, scale = 0.65) {
    if (!target.monitors.length) await readState(target);
    return call(target, 'GET', frameRoute({ monitor, scale, quality: scale === 1 ? 90 : 72 }), { binary: true });
  }

  // Device list: the SSH machine of a Windows host can show its screen and be controlled.
  function decorate(listing) {
    if (!listing?.devices || !targets.size) return listing;
    for (const device of listing.devices) {
      const target = [...targets.values()].find(item => device.ids?.includes(`ssh:${item.host}`));
      if (!target) continue;
      device.can = { ...device.can, screen: { ok: true, via: 'windows' }, control: { ok: true, via: 'windows' } };
      device.os = 'windows';
      if (device.kind === 'other' || device.kind === 'server') device.kind = 'pc';
    }
    return listing;
  }

  function close() {
    closed = true;
    for (const target of targets.values()) { clearTimeout(target.dragTimer); target.tunnel?.kill(); }
  }

  return { byNode, state, action, liveSource, screenshot, decorate, close, get size() { return targets.size; } };
}

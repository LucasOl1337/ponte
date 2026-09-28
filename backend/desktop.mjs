import os from 'node:os';
import path from 'node:path';
import { access, stat, readFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { ApiError, commandExists, runCommand } from './process.mjs';
import { message } from './i18n.mjs';

const keyCodes = {
  Enter: [28], Escape: [1], BackSpace: [14], Tab: [15], Delete: [111],
  ArrowUp: [103], ArrowDown: [108], ArrowLeft: [105], ArrowRight: [106],
  Home: [102], End: [107], PageUp: [104], PageDown: [109],
  Copy: [29, 46], Paste: [29, 47], Undo: [29, 44], SelectAll: [29, 30],
  // Window/desktop keys the phone keyboard has no way to express.
  AltTab: [56, 15], Super: [125], CloseWindow: [56, 62],
};
export const LIGHT_PRESETS = Object.freeze(['lava', 'brasa', 'oceano', 'aurora', 'floresta', 'lua']);
const workspace = (value) => ({ id: Number(value?.id) || 0, name: String(value?.name ?? '').slice(0, 150) });
const windowInfo = (value) => value?.address ? ({
  address: String(value.address), title: String(value.title ?? '').slice(0, 1000),
  monitor: Number.isInteger(value.monitor) ? value.monitor : null,
  class: String(value.class ?? '').slice(0, 250), workspace: workspace(value.workspace),
}) : null;
const numberIn = (value, min, max, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ApiError(400, 'NUMBER_OUT_OF_RANGE', { min, max });
  }
  return value;
};

export function resolveLiveCapture(monitor, scale, region, { minEdge = 8 } = {}) {
  const mx = Number(monitor?.x) || 0;
  const my = Number(monitor?.y) || 0;
  const mw = Number(monitor?.width);
  const mh = Number(monitor?.height);
  if (!Number.isInteger(mw) || !Number.isInteger(mh) || mw < 1 || mh < 1) throw new ApiError(400, 'INVALID_MONITOR');
  if (region == null) return { scale, output: monitor.name, geometry: null, region: null };
  const { x: x0, y: y0, w: w0, h: h0 } = region;
  if (![x0, y0, w0, h0].every(value => Number.isInteger(value))) throw new ApiError(400, 'INVALID_REGION');
  if (w0 < 1 || h0 < 1 || x0 < 0 || y0 < 0) throw new ApiError(400, 'INVALID_REGION');
  const x = Math.min(x0, mw - 1);
  const y = Math.min(y0, mh - 1);
  const w = Math.max(0, Math.min(w0, mw - x));
  const h = Math.max(0, Math.min(h0, mh - y));
  const nearlyFull = w >= mw * 0.98 && h >= mh * 0.98 && x <= mw * 0.02 && y <= mh * 0.02;
  if (nearlyFull || w < minEdge || h < minEdge) return { scale, output: monitor.name, geometry: null, region: null };
  return {
    scale: 1,
    output: null,
    geometry: `${mx + x},${my + y} ${w}x${h}`,
    region: { x, y, w, h },
  };
}

function getEthernetWolInfo(env = process.env) {
  if (env.PONTE_WOL_MAC && env.PONTE_WOL_INTERFACE) {
    return { mac: env.PONTE_WOL_MAC, interface: env.PONTE_WOL_INTERFACE };
  }
  let ifaces;
  try { ifaces = os.networkInterfaces(); } catch { return { mac: null, interface: null }; }
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.internal || !addr.mac || addr.mac === '00:00:00:00:00:00') continue;
      const isEthernetName = /^(en|eth)/i.test(name);
      let isPhysical = false;
      try { isPhysical = existsSync(`/sys/class/net/${name}/device`); } catch {}
      candidates.push({ name, mac: addr.mac, isEthernetName, isPhysical, hasIpv4: addr.family === 'IPv4' });
    }
  }
  candidates.sort((a, b) => {
    if (a.isPhysical !== b.isPhysical) return b.isPhysical ? 1 : -1;
    if (a.isEthernetName !== b.isEthernetName) return b.isEthernetName ? 1 : -1;
    if (a.hasIpv4 !== b.hasIpv4) return b.hasIpv4 ? 1 : -1;
    return 0;
  });
  const best = candidates[0];
  return best ? { mac: best.mac, interface: best.name } : { mac: null, interface: null };
}

export function createDesktop({ runner = runCommand, exists = commandExists, env = process.env, dragTimeout = 1800, log = console, lightsAnswerMs = 11000 } = {}) {
  const ydotoolEnv = { ...env, YDOTOOL_SOCKET: env.YDOTOOL_SOCKET || path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'ponte-input.sock') };
  const run = (command, args, options = {}) => runner(command, args, { env: command === 'ydotool' ? ydotoolEnv : env, ...options });
  const readHypr = async (kind, options = {}) => {
    let result;
    try { result = JSON.parse(await run('hyprctl', ['-j', kind], options)); }
    catch { throw new ApiError(503, 'HYPRLAND_UNAVAILABLE'); }
    if (['clients', 'monitors', 'workspaces'].includes(kind) && !Array.isArray(result)) throw new ApiError(503, 'HYPRLAND_INVALID_RESPONSE');
    return result;
  };
  const monitorPoint = async (value) => {
    if (typeof value.monitor !== 'string' || value.monitor.length < 1 || value.monitor.length > 150 || /[\u0000-\u001f\u007f]/.test(value.monitor)) throw new ApiError(400, 'INVALID_MONITOR');
    const x = numberIn(value.x, 0, 32767, true);
    const y = numberIn(value.y, 0, 32767, true);
    const monitors = await readHypr('monitors');
    const monitor = monitors.find(item => item.name === value.monitor);
    if (!monitor) throw new ApiError(400, 'INVALID_MONITOR');
    const width = Number(monitor.width), height = Number(monitor.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new ApiError(400, 'INVALID_MONITOR');
    numberIn(x, 0, width - 1, true); numberIn(y, 0, height - 1, true);
    return { x: (Number(monitor.x) || 0) + x, y: (Number(monitor.y) || 0) + y };
  };
  let dragTimer;
  let dragging = false;
  let dragModifier = 0; // key code held for the whole drag (Super moves windows in Hyprland)
  let releasePromise = null;
  let closing = false;
  // ydotool has no absolute axis: "mousemove --absolute" is a relative jump to
  // the top-left corner followed by a relative move, so the compositor's
  // pointer acceleration scales the second leg (measured on Hyprland's default
  // adaptive profile: the cursor lands at exactly twice the requested pixel).
  // ydotool's own help says to disable acceleration. Hyprland can configure a
  // single device, so the virtual pointer is set flat, and every placement is
  // verified against the compositor's cursor position: a restarted ydotoold is
  // a new device with the default profile again.
  let pointerCalibratedAt = 0;
  let pointerError = 0;
  const POINTER_TOLERANCE = 1;
  async function calibratePointer(force = false) {
    if (!force && pointerCalibratedAt && Date.now() - pointerCalibratedAt < 60000) return;
    pointerCalibratedAt = Date.now();
    let devices;
    try { devices = JSON.parse(await run('hyprctl', ['-j', 'devices'], { timeout: 1500 })); } catch { return; }
    const names = (Array.isArray(devices?.mice) ? devices.mice : [])
      .map(item => String(item?.name ?? ''))
      .filter(name => name.startsWith('ydotoold-virtual-device') && /^[A-Za-z0-9_.-]+$/.test(name));
    for (const name of names) {
      // Hyprland 0.56+ takes Lua; older releases take keywords. Both exit 0 on
      // failure, so only the Lua acknowledgement decides the fallback.
      const lua = `hl.device({ name = "${name}", accel_profile = "flat", sensitivity = 0 })`;
      const answer = await run('hyprctl', ['eval', lua], { timeout: 1500 }).catch(() => '');
      if (/^ok\b/i.test(String(answer).trim())) continue;
      for (const [key, setting] of [['accel_profile', 'flat'], ['sensitivity', '0']]) {
        await run('hyprctl', ['keyword', `device[${name}]:${key}`, setting], { timeout: 1500 }).catch(() => {});
      }
    }
  }
  async function cursorPosition() {
    const match = /^\s*(-?\d+),\s*(-?\d+)/.exec(String(await run('hyprctl', ['cursorpos'], { timeout: 1500 })));
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  }
  const pointerOff = (landed, point) => !!landed && (Math.abs(landed.x - point.x) > POINTER_TOLERANCE || Math.abs(landed.y - point.y) > POINTER_TOLERANCE);
  async function placePointer(point) {
    await calibratePointer();
    await run('ydotool', ['mousemove', '--absolute', '--', String(point.x), String(point.y)]);
    let landed = await cursorPosition().catch(() => null);
    if (pointerOff(landed, point)) {
      await calibratePointer(true);
      await run('ydotool', ['mousemove', '--absolute', '--', String(point.x), String(point.y)]);
      landed = await cursorPosition().catch(() => null);
    }
    // Still scaled (a compositor without per-device profiles): close the gap
    // with relative moves, dividing by the scale the last move showed.
    let scale = landed && Math.hypot(point.x, point.y) > 0 ? Math.max(1, Math.hypot(landed.x, landed.y) / Math.hypot(point.x, point.y)) : 1;
    for (let attempt = 0; attempt < 3 && pointerOff(landed, point); attempt++) {
      const dx = Math.round((point.x - landed.x) / scale), dy = Math.round((point.y - landed.y) / scale);
      if (!dx && !dy) break;
      await run('ydotool', ['mousemove', '--', String(dx), String(dy)]);
      const next = await cursorPosition().catch(() => null);
      if (!next) { landed = null; break; }
      const observed = Math.hypot(next.x - landed.x, next.y - landed.y) / Math.hypot(dx, dy);
      if (observed > 0.1) scale *= observed;
      landed = next;
    }
    pointerError = landed ? Math.max(Math.abs(landed.x - point.x), Math.abs(landed.y - point.y)) : 0;
    return landed;
  }
  // Every action is serialized in HTTP. This timer also joins that order via
  // releasePromise, so an expired drag cannot release a freshly started drag.
  async function releaseDrag() {
    clearTimeout(dragTimer);
    if (!dragging) return;
    if (releasePromise) return releasePromise;
    const modifier = dragModifier;
    releasePromise = run('ydotool', ['click', '0x80'], { timeout: 1000 })
      .then(() => { dragging = false; dragModifier = 0; })
      .finally(() => { if (modifier) return run('ydotool', ['key', `${modifier}:0`], { timeout: 1000 }).catch(() => {}); })
      .catch(error => {
        // A failed release must not erase held-state: retry if the daemon
        // reconnects, and allow an explicit stop/shutdown to retry immediately.
        if (!closing) {
          dragTimer = setTimeout(() => { releaseDrag().catch(() => {}); }, 250);
          dragTimer.unref();
        }
        throw error;
      }).finally(() => { releasePromise = null; });
    await releasePromise;
  }

  const pythonBin = env.PYTHON_BIN || 'python';
  const lightsController = env.MAGMA_LIGHTS_CONTROLLER || path.join(env.HOME || os.homedir(), '.local/share/magma-lights/controller.py');
  const lightsCommand = (...args) => run(pythonBin, [lightsController, ...args], { timeout: 45000 });
  // Sleep and restore make one OpenRGB call per device group (~5 s of detection
  // each); the controller gets 70 s, the phone's answer is bounded below.
  const LIGHT_LABELS = { 'ENE DRAM': 'RAM ENE', 'Corsair Vengeance RGB DDR5': 'RAM Corsair', 'ASUS TUF GeForce RTX 4070 Ti SUPER Gaming White OC': 'GPU', 'MSI B650M': 'MSI (fans)', 'G515 LS TKL': 'G515', telinha: 'LCD' };
  const lightLabel = device => LIGHT_LABELS[device] || String(device).slice(0, 40);
  const lightsReport = stdout => {
    try {
      const report = JSON.parse(String(stdout));
      if (!report || !Array.isArray(report.devices)) return null;
      return { ok: report.ok === true, devices: report.devices.filter(item => item && typeof item.device === 'string' && ['ok', 'failed', 'absent'].includes(item.status)).map(item => ({ device: lightLabel(item.device), status: item.status })) };
    } catch { return null; }
  };
  // Runs an RGB action with --json when the installed controller knows it (an
  // older one rejects the flag in argparse, before touching any device) and logs
  // the outcome per device to the journal. Throws LIGHTS_FAILED naming them.
  async function lightsAction(label, ...args) {
    let stdout;
    try {
      try { stdout = await run(pythonBin, [lightsController, ...args, '--json'], { timeout: 70000 }); }
      catch (error) {
        if (!/unrecognized arguments: --json/.test(error.detail?.stderr || '')) throw error;
        stdout = await run(pythonBin, [lightsController, ...args], { timeout: 70000 });
      }
    } catch (error) {
      const report = lightsReport(error.detail?.stdout);
      const failed = report ? report.devices.filter(item => item.status === 'failed').map(item => item.device) : [];
      log.error(`[lights] ${label} failed: exit=${error.detail?.exitCode ?? '?'}${error.detail?.timedOut ? ' (timeout)' : ''} ${report ? JSON.stringify(report.devices) : ''} ${error.detail?.stderr || ''}`.trim());
      throw Object.assign(new ApiError(503, 'LIGHTS_FAILED', { devices: failed.length ? failed.join(', ') : 'RGB' }), { devices: report ? report.devices : [] });
    } finally { lightsCache.at = 0; }
    const report = lightsReport(stdout);
    log.log(`[lights] ${label} ok${report ? ` ${JSON.stringify(report.devices)}` : ''}`);
    return report;
  }
  // The Android shell's proxy drops a response after 15 s, and a sleep takes
  // ~20 s. Past lightsAnswerMs the phone gets { pending, job } and the outcome
  // arrives later as state.lights.last with the same job number.
  // One job at a time: the controller's own lock would refuse a second one with
  // no device list, which would read as every light failing.
  let lightsJobs = 0;
  let lightsLast = null;
  let lightsRunning = false;
  async function lightsInTime(label, ...args) {
    if (lightsRunning) throw new ApiError(429, 'OPERATION_BUSY');
    lightsRunning = true;
    const job = ++lightsJobs;
    const work = lightsAction(label, ...args).then(
      report => { lightsLast = { job, action: label, ok: true, devices: report ? report.devices : [] }; return report; },
      error => { lightsLast = { job, action: label, ok: false, devices: error.devices || [] }; throw error; })
      .finally(() => { lightsRunning = false; });
    work.catch(() => {});
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve({ pending: true, job }), lightsAnswerMs); });
    try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
  }
  let lightsCache = { at: 0, value: null };
  async function lightsInstalled() {
    try { await access(lightsController, constants.R_OK); return true; } catch { return false; }
  }
  // The Magma controller reads its saved state; nothing touches OpenRGB here.
  async function lightsStatus() {
    if (Date.now() - lightsCache.at < 15000) return lightsCache.value;
    let value = null;
    try {
      const last = JSON.parse(await run(pythonBin, [lightsController, 'status'], { timeout: 8000 }))?.last_applied || {};
      value = { preset: LIGHT_PRESETS.includes(last.preset) ? last.preset : 'custom', sleeping: last.sleeping === true, brightness: Number.isFinite(Number(last.brightness)) ? Number(last.brightness) : null, incomplete: Array.isArray(last.incomplete) ? last.incomplete.filter(item => typeof item === 'string').map(lightLabel) : [] };
    } catch {}
    lightsCache = { at: Date.now(), value };
    return value;
  }
  async function sessionLocked() {
    try {
      const output = String(await run('omarchy-shell', ['lock', 'isLocked'], { timeout: 2500 })).trim();
      return output === 'true' ? true : output === 'false' ? false : null;
    } catch { return null; }
  }
  // fcitx5 owns the compositor's input-method seat. Its DebugInfo lists every
  // input context with focus:1 only while an *enabled* text field has focus
  // (verified: a button-only dialog reports none). That is the cue to raise
  // the phone keyboard after a tap.
  async function textInputFocused() {
    try {
      const raw = String(await run('busctl', ['--user', '--timeout=1', 'call', 'org.fcitx.Fcitx5', '/controller', 'org.fcitx.Fcitx.Controller1', 'DebugInfo'], { timeout: 1500 }));
      return { available: true, focused: /focus:1\b/.test(raw) };
    } catch { return { available: false, focused: null }; }
  }
  const validMonitorName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 150 && !/[\s;&|`$><()"\\]/u.test(name);
  // Hyprland 0.56+ exposes only a dpms TOGGLE through the Lua dispatch bridge,
  // and it ignores the on/off word. dpmsStatus is readable, so a monitor is set
  // to an explicit state by toggling only when it is not already there.
  async function toggleMonitor(name) {
    await run('hyprctl', ['dispatch', `hl.dsp.dpms({ monitor = "${name}" })`]);
  }
  async function setMonitorDpms(name, desiredOn, monitors) {
    const monitor = (monitors || await readHypr('monitors')).find(m => m.name === name);
    if (!monitor) throw new ApiError(400, 'INVALID_MONITOR');
    if ((monitor.dpmsStatus !== false) === desiredOn) return;
    await toggleMonitor(name);
  }
  async function capabilities() {
    const [mouseBinary, keyboard, screenshot, audio, lights, lock] = await Promise.all([
      exists('ydotool', env), exists('wtype', env), exists('grim', env), exists('ffplay', env), lightsInstalled(), exists('omarchy-shell', env),
    ]);
    let mouse = false;
    if (mouseBinary) {
      try {
        const socket = await stat(ydotoolEnv.YDOTOOL_SOCKET);
        await access(ydotoolEnv.YDOTOOL_SOCKET, constants.W_OK);
        mouse = socket.isSocket();
      } catch {}
    }
    return { mouse, keyboard, screenshot, audio, live: screenshot, lights, lock };
  }

  async function getState({ locale = 'en' } = {}) {
    const names = ['activewindow', 'monitors', 'workspaces', 'clients'];
    const values = await Promise.allSettled([
      ...names.map(readHypr), run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']), capabilities(), sessionLocked(), lightsStatus(), textInputFocused(),
    ]);
    const warnings = [];
    const get = (index, fallback, warning) => {
      if (values[index].status === 'fulfilled') return values[index].value;
      if (warning) warnings.push(warning);
      return fallback;
    };
    const rawVolume = String(get(4, '', 'VOLUME_UNAVAILABLE'));
    const match = rawVolume.match(/Volume:\s*([\d.]+)/);
    const caps = get(5, { mouse: false, keyboard: false, screenshot: false, audio: false, live: false, lights: false, lock: false });
    const locked = caps.lock ? get(6, null) : null;
    const lights = caps.lights ? get(7, null) : null;
    const textInput = get(8, { available: false, focused: null });
    if (!caps.mouse) warnings.push('INPUT_UNAVAILABLE');
    // The verification also sees the user's own mouse moving at that moment;
    // only a miss that no jitter explains is worth a warning.
    else if (pointerError > 8) warnings.push('POINTER_INACCURATE');
    if (!caps.keyboard) warnings.push('TEXT_UNAVAILABLE');
    if (!caps.screenshot) warnings.push('SCREENSHOT_UNAVAILABLE');
    if (!caps.audio) warnings.push('PLAYBACK_UNAVAILABLE');
    const wol = getEthernetWolInfo(env);
    const wolInstructions = message('WOL_INSTRUCTIONS', locale, { mac: wol.mac || '—', interface: wol.interface || '—' });
    let wolEnabled = null;
    if (wol.interface && /^[A-Za-z0-9_.-]+$/.test(wol.interface)) {
      try { wolEnabled = (await readFile(`/sys/class/net/${wol.interface}/device/power/wakeup`, 'utf8')).trim() === 'enabled'; } catch {}
    }
    return {
      hostname: os.hostname(), uptime: Math.floor(os.uptime()),
      activeWindow: windowInfo(get(0, null, 'ACTIVE_WINDOW_UNAVAILABLE')),
      monitors: get(1, [], 'MONITORS_UNAVAILABLE').map(m => ({
        id: m.id, name: String(m.name), width: m.width, height: m.height, focused: Boolean(m.focused),
        dpmsStatus: m.dpmsStatus !== undefined ? Boolean(m.dpmsStatus) : true,
        activeWorkspace: Number.isInteger(m.activeWorkspace?.id) ? m.activeWorkspace.id : null,
        model: m.model ? String(m.model) : (m.description ? String(m.description) : undefined),
      })),
      workspaces: get(2, [], 'WORKSPACES_UNAVAILABLE').map(w => ({ ...workspace(w), windows: Number(w.windows) || 0, monitor: typeof w.monitor === 'string' ? w.monitor.slice(0, 150) : null })),
      windows: get(3, [], 'WINDOWS_UNAVAILABLE').map(windowInfo).filter(Boolean),
      volume: { value: match ? Math.max(0, Math.min(1, Number(match[1]))) : 0, muted: rawVolume.includes('[MUTED]') },
      capabilities: caps, warningCodes: warnings, warnings: warnings.map(code => message(code, locale)),
      wakeOnLan: { mac: wol.mac, interface: wol.interface, enabled: wolEnabled, instructions: wolInstructions },
      power: { wakeOnLan: { mac: wol.mac, interface: wol.interface, enabled: wolEnabled, instructions: wolInstructions } },
      session: { locked, lockAvailable: !!caps.lock },
      textInput,
      lights: lights ? { ...lights, presets: LIGHT_PRESETS, last: lightsLast } : null,
    };
  }

  const pressKeys = async (codes) => {
    try {
      await run('ydotool', ['key', '--key-delay', '1', ...codes.map(code => `${code}:1`), ...[...codes].reverse().map(code => `${code}:0`)]);
    } catch (error) {
      await run('ydotool', ['key', ...[...codes].reverse().map(code => `${code}:0`)], { timeout: 1000 }).catch(() => {});
      throw error;
    }
  };

  async function action(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new ApiError(400, 'INVALID_ACTION');
    if (releasePromise) await releasePromise;
    switch (value.type) {
      case 'mouse.move': {
        const dx = numberIn(value.dx, -1000, 1000), dy = numberIn(value.dy, -1000, 1000);
        await run('ydotool', ['mousemove', '--', String(Math.round(dx)), String(Math.round(dy))]); break;
      }
      case 'mouse.click': {
        const buttons = { left: '0xC0', right: '0xC1', middle: '0xC2' };
        if (!Object.hasOwn(buttons, value.button)) throw new ApiError(400, 'INVALID_BUTTON');
        await run('ydotool', ['click', buttons[value.button]]); break;
      }
      case 'mouse.clickAt': {
        const buttons = { left: '0xC0', right: '0xC1', middle: '0xC2' };
        if (!Object.hasOwn(buttons, value.button)) throw new ApiError(400, 'INVALID_BUTTON');
        const point = await monitorPoint(value);
        await placePointer(point);
        await run('ydotool', ['click', buttons[value.button]]);
        break;
      }
      case 'mouse.moveTo': {
        const point = await monitorPoint(value);
        await placePointer(point);
        break;
      }
      case 'mouse.scroll': {
        const dy = numberIn(value.dy, -30, 30);
        // The wheel scrolls whatever is under the pointer. A phone gesture
        // names its point, so the scroll reaches the window under the finger
        // instead of the one last clicked.
        if (value.monitor !== undefined) await placePointer(await monitorPoint(value));
        await run('ydotool', ['mousemove', '--wheel', '--', '0', String(Math.round(dy))]); break;
      }
      case 'mouse.drag': {
        if (typeof value.pressed !== 'boolean') throw new ApiError(400, 'INVALID_DRAG_STATE');
        if (!value.pressed) { await releaseDrag(); break; }
        if (!dragging) {
          // Mark held before awaiting so cleanup still releases after a timeout.
          dragging = true;
          try { await run('ydotool', ['click', '0x40']); } catch (error) { await releaseDrag().catch(() => {}); throw error; }
        }
        clearTimeout(dragTimer);
        dragTimer = setTimeout(() => { releaseDrag().catch(() => {}); }, dragTimeout);
        dragTimer.unref();
        break;
      }
      case 'mouse.dragStartAt': {
        const point = await monitorPoint(value);
        // A new semantic drag supersedes a stale held button from a lost phone
        // pointer. Pressing at the requested pixel focuses the window beneath
        // it, which lets us return the exact window captured by this gesture.
        if (dragging) await releaseDrag();
        if (value.modifier !== undefined && value.modifier !== 'super') throw new ApiError(400, 'INVALID_ACTION');
        await placePointer(point);
        dragging = true;
        // Hyprland moves (floating) or swaps (tiled) a window under Super+drag;
        // a bare left drag only reaches the window's own contents.
        dragModifier = value.modifier === 'super' ? 125 : 0;
        try {
          if (dragModifier) await run('ydotool', ['key', `${dragModifier}:1`]);
          await run('ydotool', ['click', '0x40']);
        }
        catch (error) { await releaseDrag().catch(() => {}); throw error; }
        clearTimeout(dragTimer);
        dragTimer = setTimeout(() => { releaseDrag().catch(() => {}); }, dragTimeout);
        dragTimer.unref();
        let captured = null;
        try {
          const active = await readHypr('activewindow');
          const at = active?.at, size = active?.size;
          // A click on wallpaper leaves the previous active window unchanged.
          // Only capture it when Hyprland's live geometry proves this gesture
          // actually began inside that window (with a small decoration margin).
          const geometry = Array.isArray(at) && Array.isArray(size) && at.length === 2 && size.length === 2
            && [...at, ...size].every(Number.isFinite) && size[0] > 0 && size[1] > 0;
          if (geometry && point.x >= at[0] - 12 && point.y >= at[1] - 12 && point.x <= at[0] + size[0] + 12 && point.y <= at[1] + size[1] + 12) captured = windowInfo(active);
        } catch {}
        return { ok: true, window: captured };
      }
      case 'keyboard.text': {
        if (typeof value.text !== 'string' || !value.text.length || value.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)) throw new ApiError(400, 'INVALID_TEXT');
        // Unicode goes via stdin so leading dashes are never options. With
        // enter, the whole line lands in one serialized action: a phone on a
        // relay cannot lose the Enter between two requests.
        await run('wtype', ['-'], { input: value.text, timeout: 8000 });
        if (value.enter === true) await pressKeys(keyCodes.Enter);
        break;
      }
      case 'keyboard.key': {
        if (!Object.hasOwn(keyCodes, value.key)) throw new ApiError(400, 'KEY_NOT_ALLOWED');
        await pressKeys(keyCodes[value.key]); break;
      }
      case 'workspace.focus': {
        const id = numberIn(value.id, 1, 100, true);
        // A workspace nobody has opened yet appears on the monitor under the
        // cursor. The phone streams one monitor, so put the cursor there first
        // when asked; an existing workspace keeps its own monitor.
        if (typeof value.monitor === 'string') {
          const workspaces = await readHypr('workspaces');
          if (!workspaces.some(ws => Number(ws.id) === id)) {
            const monitors = await readHypr('monitors');
            const monitor = monitors.find(item => item.name === value.monitor);
            if (!monitor || !validMonitorName(monitor.name)) throw new ApiError(400, 'INVALID_MONITOR');
            await placePointer({ x: (Number(monitor.x) || 0) + Math.floor(Number(monitor.width) / 2), y: (Number(monitor.y) || 0) + Math.floor(Number(monitor.height) / 2) });
          }
        }
        // Hyprland 0.56+ uses Lua dispatch expressions. Only the bounded integer
        // enters this fixed expression; no request-provided code is accepted.
        await run('hyprctl', ['dispatch', `hl.dsp.focus({ workspace = "${id}" })`]); break;
      }
      case 'window.focus': {
        if (typeof value.address !== 'string' || !/^0x[\da-f]{1,32}$/i.test(value.address)) throw new ApiError(400, 'INVALID_WINDOW');
        const windows = await readHypr('clients');
        if (!windows.some(w => w.address === value.address)) throw new ApiError(404, 'WINDOW_CLOSED');
        await run('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${value.address}" })`]); break;
      }
      case 'window.moveToWorkspace': {
        const id = numberIn(value.id, 1, 100, true);
        if (typeof value.address !== 'string' || !/^0x[\da-f]{1,32}$/i.test(value.address)) throw new ApiError(400, 'INVALID_WINDOW');
        const windows = await readHypr('clients');
        const target = windows.find(w => w.address === value.address);
        if (!target) throw new ApiError(404, 'WINDOW_CLOSED');
        if (dragging) await releaseDrag();
        if (Number(target.workspace?.id) === id) return { ok: true, moved: false, workspace: id };
        // Hyprland 0.56's dispatcher accepts an exact window selector. Keeping
        // follow=false moves the captured window without pulling the phone's
        // viewed workspace away from the user's current context.
        await run('hyprctl', ['dispatch', `hl.dsp.window.move({ workspace = "${id}", follow = false, window = "address:${value.address}" })`]);
        return { ok: true, moved: true, workspace: id };
      }
      case 'volume.set': {
        const volume = numberIn(value.value, 0, 1);
        await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', volume.toFixed(3)]); break;
      }
      case 'volume.mute': await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']); break;
      case 'media.toggle': await pressKeys([164]); break;
      case 'media.next': await pressKeys([163]); break;
      case 'media.previous': await pressKeys([165]); break;
      case 'app.launch': {
        const apps = { browser: 'browser', terminal: 'terminal', files: 'nautilus' };
        if (!Object.hasOwn(apps, value.app)) throw new ApiError(400, 'APP_NOT_ALLOWED');
        // A transient user service lets GUI applications outlive the HTTP command,
        // while the launcher itself remains bounded and receives no user command.
        await run('systemd-run', ['--user', '--quiet', '--collect', '--no-ask-password',
          '--property=StandardOutput=null', '--property=StandardError=null',
          '--', 'omarchy', 'launch', apps[value.app]], { timeout: 6000 }); break;
      }
      case 'power.dpms':
      case 'screen.dpms':
      case 'monitor.dpms': {
        const stateStr = typeof value.enabled === 'boolean' ? (value.enabled ? 'on' : 'off') : value.state;
        if (stateStr !== 'on' && stateStr !== 'off') throw new ApiError(400, 'INVALID_POWER_STATE');
        if (!validMonitorName(value.monitor)) throw new ApiError(400, 'INVALID_MONITOR');
        await setMonitorDpms(value.monitor, stateStr === 'on'); break;
      }
      case 'power.dpms_all': {
        const stateStr = typeof value.enabled === 'boolean' ? (value.enabled ? 'on' : 'off') : value.state;
        if (stateStr !== 'on' && stateStr !== 'off') throw new ApiError(400, 'INVALID_POWER_STATE');
        const monitors = await readHypr('monitors');
        for (const monitor of monitors) if (validMonitorName(monitor.name)) await setMonitorDpms(monitor.name, stateStr === 'on', monitors);
        break;
      }
      case 'power.sleep':
      case 'power.smart_sleep':
      case 'power.wake':
      case 'power.restore': {
        // Monitors and lights are independent: a Hyprland hiccup must not leave
        // the RGB on, and a light that stays lit is named instead of hidden.
        const sleeping = value.type === 'power.sleep' || value.type === 'power.smart_sleep';
        let monitorError = null;
        try {
          const monitors = await readHypr('monitors');
          for (const monitor of monitors) if (validMonitorName(monitor.name)) await setMonitorDpms(monitor.name, !sleeping, monitors);
        } catch (error) { monitorError = error; log.error(`[power] ${value.type} monitors failed: ${error.code || error.message}`); }
        lightsCache.at = 0;
        let lights;
        try { lights = await lightsInTime(value.type, sleeping ? 'sleep' : 'restore'); }
        catch (error) { if (!monitorError && sleeping && error.code === 'LIGHTS_FAILED') throw new ApiError(503, 'SLEEP_LIGHTS_FAILED', error.parameters); throw monitorError || error; }
        if (monitorError) throw monitorError;
        return { ok: true, lights };
      }
      case 'lights.preset': {
        if (typeof value.preset !== 'string' || !LIGHT_PRESETS.includes(value.preset)) throw new ApiError(400, 'INVALID_PRESET');
        if (!await lightsInstalled()) throw new ApiError(503, 'LIGHTS_UNAVAILABLE');
        lightsCache.at = 0;
        return { ok: true, lights: await lightsInTime(value.type, 'preset', value.preset) };
      }
      case 'lights.sleep':
      case 'lights.restore':
      case 'lights.reapply': {
        if (!await lightsInstalled()) throw new ApiError(503, 'LIGHTS_UNAVAILABLE');
        lightsCache.at = 0;
        return { ok: true, lights: await lightsInTime(value.type, value.type.slice('lights.'.length)) };
      }
      case 'lights.screen': {
        if (typeof value.enabled !== 'boolean') throw new ApiError(400, 'INVALID_POWER_STATE');
        if (!await lightsInstalled()) throw new ApiError(503, 'LIGHTS_UNAVAILABLE');
        await lightsCommand(value.enabled ? 'screen_on' : 'screen_off'); break;
      }
      case 'session.lock': {
        if (!await exists('omarchy-system-lock', env)) throw new ApiError(503, 'LOCK_UNAVAILABLE');
        await run('omarchy-system-lock', [], { timeout: 8000 }); break;
      }
      case 'session.unlock': {
        // The Omarchy lock only opens through PAM, so the password is typed as
        // real keystrokes through uinput. It is refused unless the lock is up,
        // otherwise the secret could land in whichever window has focus.
        if (typeof value.password !== 'string' || value.password.length < 1 || value.password.length > 256 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.password) || !value.password.isWellFormed()) throw new ApiError(400, 'INVALID_PASSWORD');
        if (!await exists('omarchy-shell', env)) throw new ApiError(503, 'LOCK_UNAVAILABLE');
        if (await sessionLocked() !== true) throw new ApiError(409, 'SESSION_NOT_LOCKED');
        try { const monitors = await readHypr('monitors'); for (const monitor of monitors) if (validMonitorName(monitor.name)) await setMonitorDpms(monitor.name, true, monitors); } catch {}
        await run('ydotool', ['type', '--file', '-', '--key-delay', '12'], { input: value.password, timeout: 15000 });
        await pressKeys([28]); break;
      }
      case 'power.poweroff':
      case 'power.off': {
        await run('systemctl', ['poweroff']); break;
      }
      case 'power.reboot': await run('systemctl', ['reboot']); break;
      case 'power.suspend': await run('systemctl', ['suspend'], { timeout: 10000 }); break;
      default: throw new ApiError(400, 'ACTION_NOT_ALLOWED');
    }
    return { ok: true };
  }

  async function screenshot(requestedMonitor, scale = 0.65) {
    numberIn(scale, 0.2, 1);
    const monitors = await readHypr('monitors');
    const monitor = requestedMonitor ?? monitors.find(m => m.focused)?.name ?? monitors[0]?.name;
    if (typeof monitor !== 'string' || monitor.length > 150 || !monitors.some(m => m.name === monitor)) throw new ApiError(400, 'INVALID_MONITOR');
    return run('grim', ['-c', '-t', 'jpeg', '-q', scale === 1 ? '90' : '72', '-s', String(scale), '-o', monitor, '-'], { binary: true, timeout: 8000, maxBuffer: 12 * 1024 * 1024 });
  }

  async function prepareLive({ monitor: requestedMonitor, scale, quality = 65, region, signal }) {
    numberIn(scale, 0.2, 1);
    numberIn(quality, 30, 90, true);
    const monitors = await readHypr('monitors', { signal });
    const selected = monitors.find(item => item.name === (requestedMonitor ?? monitors.find(m => m.focused)?.name ?? monitors[0]?.name));
    if (!selected || typeof selected.name !== 'string' || selected.name.length > 150) throw new ApiError(400, 'INVALID_MONITOR');
    const capture = resolveLiveCapture(selected, scale, region);
    return {
      monitor: selected.name,
      region: capture.region,
      capture: (captureSignal) => {
        const args = ['-c', '-t', 'jpeg', '-q', String(quality), '-s', capture.geometry ? '1' : capture.scale.toFixed(2)];
        if (capture.geometry) args.push('-g', capture.geometry);
        else args.push('-o', capture.output);
        args.push('-');
        return run('grim', args, { binary: true, signal: captureSignal, timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
      },
    };
  }

  async function close() {
    closing = true;
    clearTimeout(dragTimer);
    for (let attempt = 0; attempt < 3 && dragging; attempt++) await releaseDrag().catch(() => {});
  }
  return { getState, action, screenshot, prepareLive, close, capabilities, textInputFocused };
}

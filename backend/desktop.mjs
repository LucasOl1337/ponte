import os from 'node:os';
import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { ApiError, commandExists, runCommand } from './process.mjs';
import { message } from './i18n.mjs';

const keyCodes = {
  Enter: [28], Escape: [1], BackSpace: [14], Tab: [15],
  ArrowUp: [103], ArrowDown: [108], ArrowLeft: [105], ArrowRight: [106],
  Copy: [29, 46], Paste: [29, 47], Undo: [29, 44], SelectAll: [29, 30],
};
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

export function createDesktop({ runner = runCommand, exists = commandExists, env = process.env, dragTimeout = 1800 } = {}) {
  const ydotoolEnv = { ...env, YDOTOOL_SOCKET: env.YDOTOOL_SOCKET || path.join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'ponte-input.sock') };
  const run = (command, args, options = {}) => runner(command, args, { env: command === 'ydotool' ? ydotoolEnv : env, ...options });
  const readHypr = async (kind, options = {}) => {
    let result;
    try { result = JSON.parse(await run('hyprctl', ['-j', kind], options)); }
    catch { throw new ApiError(503, 'HYPRLAND_UNAVAILABLE'); }
    if (['clients', 'monitors', 'workspaces'].includes(kind) && !Array.isArray(result)) throw new ApiError(503, 'HYPRLAND_INVALID_RESPONSE');
    return result;
  };
  let dragTimer;
  let dragging = false;
  let releasePromise = null;
  let closing = false;
  // Every action is serialized in HTTP. This timer also joins that order via
  // releasePromise, so an expired drag cannot release a freshly started drag.
  async function releaseDrag() {
    clearTimeout(dragTimer);
    if (!dragging) return;
    if (releasePromise) return releasePromise;
    releasePromise = run('ydotool', ['click', '0x80'], { timeout: 1000 })
      .then(() => { dragging = false; })
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

  async function capabilities() {
    const [mouseBinary, keyboard, screenshot, audio] = await Promise.all([
      exists('ydotool', env), exists('wtype', env), exists('grim', env), exists('ffplay', env),
    ]);
    let mouse = false;
    if (mouseBinary) {
      try {
        const socket = await stat(ydotoolEnv.YDOTOOL_SOCKET);
        await access(ydotoolEnv.YDOTOOL_SOCKET, constants.W_OK);
        mouse = socket.isSocket();
      } catch {}
    }
    return { mouse, keyboard, screenshot, audio, live: screenshot };
  }

  async function getState({ locale = 'en' } = {}) {
    const names = ['activewindow', 'monitors', 'workspaces', 'clients'];
    const values = await Promise.allSettled([
      ...names.map(readHypr), run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']), capabilities(),
    ]);
    const warnings = [];
    const get = (index, fallback, warning) => {
      if (values[index].status === 'fulfilled') return values[index].value;
      if (warning) warnings.push(warning);
      return fallback;
    };
    const rawVolume = String(get(4, '', 'VOLUME_UNAVAILABLE'));
    const match = rawVolume.match(/Volume:\s*([\d.]+)/);
    const caps = get(5, { mouse: false, keyboard: false, screenshot: false, audio: false, live: false });
    if (!caps.mouse) warnings.push('INPUT_UNAVAILABLE');
    if (!caps.keyboard) warnings.push('TEXT_UNAVAILABLE');
    if (!caps.screenshot) warnings.push('SCREENSHOT_UNAVAILABLE');
    if (!caps.audio) warnings.push('PLAYBACK_UNAVAILABLE');
    const wol = getEthernetWolInfo(env);
    const wolInstructions = message('WOL_INSTRUCTIONS', locale, { mac: wol.mac || '—', interface: wol.interface || '—' });
    return {
      hostname: os.hostname(), uptime: Math.floor(os.uptime()),
      activeWindow: windowInfo(get(0, null, 'ACTIVE_WINDOW_UNAVAILABLE')),
      monitors: get(1, [], 'MONITORS_UNAVAILABLE').map(m => ({
        id: m.id, name: String(m.name), width: m.width, height: m.height, focused: Boolean(m.focused),
        dpmsStatus: m.dpmsStatus !== undefined ? Boolean(m.dpmsStatus) : true,
        model: m.model ? String(m.model) : (m.description ? String(m.description) : undefined),
      })),
      workspaces: get(2, [], 'WORKSPACES_UNAVAILABLE').map(w => ({ ...workspace(w), windows: Number(w.windows) || 0 })),
      windows: get(3, [], 'WINDOWS_UNAVAILABLE').map(windowInfo).filter(Boolean),
      volume: { value: match ? Math.max(0, Math.min(1, Number(match[1]))) : 0, muted: rawVolume.includes('[MUTED]') },
      capabilities: caps, warningCodes: warnings, warnings: warnings.map(code => message(code, locale)),
      wakeOnLan: { mac: wol.mac, interface: wol.interface, instructions: wolInstructions },
      power: { wakeOnLan: { mac: wol.mac, interface: wol.interface, instructions: wolInstructions } },
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
        if (typeof value.monitor !== 'string' || value.monitor.length < 1 || value.monitor.length > 150 || /[\u0000-\u001f\u007f]/.test(value.monitor)) throw new ApiError(400, 'INVALID_MONITOR');
        const x = numberIn(value.x, 0, 32767, true);
        const y = numberIn(value.y, 0, 32767, true);
        const monitors = await readHypr('monitors');
        const monitor = monitors.find(item => item.name === value.monitor);
        if (!monitor) throw new ApiError(400, 'INVALID_MONITOR');
        const width = Number(monitor.width);
        const height = Number(monitor.height);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new ApiError(400, 'INVALID_MONITOR');
        numberIn(x, 0, width - 1, true);
        numberIn(y, 0, height - 1, true);
        const gx = (Number(monitor.x) || 0) + x;
        const gy = (Number(monitor.y) || 0) + y;
        await run('ydotool', ['mousemove', '--absolute', '--', String(gx), String(gy)]);
        await run('ydotool', ['click', buttons[value.button]]);
        break;
      }
      case 'mouse.scroll': {
        const dy = numberIn(value.dy, -30, 30);
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
      case 'keyboard.text': {
        if (typeof value.text !== 'string' || !value.text.length || value.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text)) throw new ApiError(400, 'INVALID_TEXT');
        // Unicode goes via stdin so leading dashes are never options.
        await run('wtype', ['-'], { input: value.text, timeout: 8000 }); break;
      }
      case 'keyboard.key': {
        if (!Object.hasOwn(keyCodes, value.key)) throw new ApiError(400, 'KEY_NOT_ALLOWED');
        await pressKeys(keyCodes[value.key]); break;
      }
      case 'workspace.focus': {
        const id = numberIn(value.id, 1, 100, true);
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
        if (typeof value.monitor !== 'string' || !value.monitor.length || value.monitor.length > 150 || /[\s;&|`$><()]/u.test(value.monitor)) {
          throw new ApiError(400, 'INVALID_MONITOR');
        }
        const monitors = await readHypr('monitors');
        if (!monitors.some(m => m.name === value.monitor)) throw new ApiError(400, 'INVALID_MONITOR');
        await run('hyprctl', ['dispatch', 'dpms', stateStr, value.monitor]); break;
      }
      case 'power.sleep':
      case 'power.smart_sleep': {
        await run('hyprctl', ['dispatch', 'dpms', 'off']);
        const pythonBin = env.PYTHON_BIN || 'python';
        const controller = env.MAGMA_LIGHTS_CONTROLLER || path.join(env.HOME || os.homedir(), '.local/share/magma-lights/controller.py');
        await run(pythonBin, [controller, 'sleep']); break;
      }
      case 'power.wake':
      case 'power.restore': {
        await run('hyprctl', ['dispatch', 'dpms', 'on']);
        const pythonBin = env.PYTHON_BIN || 'python';
        const controller = env.MAGMA_LIGHTS_CONTROLLER || path.join(env.HOME || os.homedir(), '.local/share/magma-lights/controller.py');
        await run(pythonBin, [controller, 'restore']); break;
      }
      case 'power.poweroff':
      case 'power.off': {
        await run('systemctl', ['poweroff']); break;
      }
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

  async function prepareLive({ monitor: requestedMonitor, scale, region, signal }) {
    numberIn(scale, 0.2, 0.65);
    const monitors = await readHypr('monitors', { signal });
    const selected = monitors.find(item => item.name === (requestedMonitor ?? monitors.find(m => m.focused)?.name ?? monitors[0]?.name));
    if (!selected || typeof selected.name !== 'string' || selected.name.length > 150) throw new ApiError(400, 'INVALID_MONITOR');
    const capture = resolveLiveCapture(selected, scale, region);
    return {
      monitor: selected.name,
      region: capture.region,
      capture: (captureSignal) => {
        const args = ['-c', '-t', 'jpeg', '-q', '65', '-s', capture.geometry ? '1' : capture.scale.toFixed(2)];
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
  return { getState, action, screenshot, prepareLive, close, capabilities };
}

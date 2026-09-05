import os from 'node:os';
import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
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
  class: String(value.class ?? '').slice(0, 250), workspace: workspace(value.workspace),
}) : null;
const numberIn = (value, min, max, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ApiError(400, 'NUMBER_OUT_OF_RANGE', { min, max });
  }
  return value;
};

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
    return {
      hostname: os.hostname(), uptime: Math.floor(os.uptime()),
      activeWindow: windowInfo(get(0, null, 'ACTIVE_WINDOW_UNAVAILABLE')),
      monitors: get(1, [], 'MONITORS_UNAVAILABLE').map(m => ({ name: String(m.name), width: m.width, height: m.height, focused: Boolean(m.focused) })),
      workspaces: get(2, [], 'WORKSPACES_UNAVAILABLE').map(w => ({ ...workspace(w), windows: Number(w.windows) || 0 })),
      windows: get(3, [], 'WINDOWS_UNAVAILABLE').map(windowInfo).filter(Boolean),
      volume: { value: match ? Math.max(0, Math.min(1, Number(match[1]))) : 0, muted: rawVolume.includes('[MUTED]') },
      capabilities: caps, warningCodes: warnings, warnings: warnings.map(code => message(code, locale)),
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
      default: throw new ApiError(400, 'ACTION_NOT_ALLOWED');
    }
    return { ok: true };
  }

  async function screenshot(requestedMonitor) {
    const monitors = await readHypr('monitors');
    const monitor = requestedMonitor ?? monitors.find(m => m.focused)?.name ?? monitors[0]?.name;
    if (typeof monitor !== 'string' || monitor.length > 150 || !monitors.some(m => m.name === monitor)) throw new ApiError(400, 'INVALID_MONITOR');
    return run('grim', ['-t', 'jpeg', '-q', '72', '-s', '0.65', '-o', monitor, '-'], { binary: true, timeout: 8000, maxBuffer: 12 * 1024 * 1024 });
  }

  async function prepareLive({ monitor: requestedMonitor, scale, signal }) {
    numberIn(scale, 0.2, 0.65);
    const monitors = await readHypr('monitors', { signal });
    const monitor = requestedMonitor ?? monitors.find(m => m.focused)?.name ?? monitors[0]?.name;
    if (typeof monitor !== 'string' || monitor.length > 150 || !monitors.some(m => m.name === monitor)) throw new ApiError(400, 'INVALID_MONITOR');
    return {
      monitor,
      capture: (captureSignal) => run('grim', ['-t', 'jpeg', '-q', '65', '-s', scale.toFixed(2), '-o', monitor, '-'], {
        binary: true, signal: captureSignal, timeout: 4000, maxBuffer: 8 * 1024 * 1024,
      }),
    };
  }

  async function close() {
    closing = true;
    clearTimeout(dragTimer);
    for (let attempt = 0; attempt < 3 && dragging; attempt++) await releaseDrag().catch(() => {});
  }
  return { getState, action, screenshot, prepareLive, close, capabilities };
}

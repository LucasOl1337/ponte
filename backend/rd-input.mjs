// Remote-desktop input on the target: maps the client's DOM events to evdev
// and feeds the persistent uinput helper (rd-input.py). Keys go by physical
// position (KeyboardEvent.code), so the target applies its own layout and the
// input method sees a real keyboard; nothing here types text.
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HELPER = fileURLToPath(new URL('./rd-input.py', import.meta.url));

// KeyboardEvent.code → Linux input keycode (input-event-codes.h).
export const KEY_CODES = Object.freeze({
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  Lang5: 85, IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89, Lang3: 90, Lang4: 91, Convert: 92, KanaMode: 93, NonConvert: 94,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115, Power: 116, NumpadEqual: 117, Pause: 119,
  NumpadComma: 121, Lang1: 122, Lang2: 123, IntlYen: 124, MetaLeft: 125, MetaRight: 126, OSLeft: 125, OSRight: 126, ContextMenu: 127,
  BrowserStop: 128, Again: 129, Props: 130, Undo: 131, Copy: 133, Open: 134, Paste: 135, Find: 136, Cut: 137, Help: 138,
  LaunchApp2: 140, Sleep: 142, WakeUp: 143, LaunchMail: 155, BrowserFavorites: 156, LaunchApp1: 157, BrowserBack: 158, BrowserForward: 159,
  Eject: 161, MediaTrackNext: 163, MediaPlayPause: 164, MediaTrackPrevious: 165, MediaStop: 166,
  BrowserHome: 172, BrowserRefresh: 173, NumpadParenLeft: 179, NumpadParenRight: 180,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188, F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
  BrowserSearch: 217, MediaSelect: 226,
});

// MouseEvent.button → BTN_*: 0 left, 1 middle, 2 right, 3 back, 4 forward.
export const BUTTON_CODES = Object.freeze([272, 274, 273, 275, 276]);

// A monitor's box in Hyprland's layout coordinates: position plus size divided
// by the scale, with width and height swapped for 90°/270° transforms.
export function logicalBox(monitor) {
  const scale = Number(monitor.scale) > 0 ? Number(monitor.scale) : 1;
  const swap = [1, 3, 5, 7].includes(Number(monitor.transform));
  const pixelWidth = Number(swap ? monitor.height : monitor.width), pixelHeight = Number(swap ? monitor.width : monitor.height);
  return { x: Number(monitor.x) || 0, y: Number(monitor.y) || 0, width: pixelWidth / scale, height: pixelHeight / scale, pixelWidth, pixelHeight };
}

// (monitor, fx, fy) in 0..1 → ABS_X/ABS_Y in 0..65535. Hyprland 0.56
// (PointerManager::warpAbsolute) puts an absolute pointer with no bound output
// at box.pos + box.size * abs, where box covers every monitor's logical box and
// abs = value / 65536 (libinput's transformed absolute with a range of 1). In
// `output` mode the device is bound to the monitor, so the box is its own.
// The target is the centre of the addressed physical pixel, which keeps the
// rounding error (box / 65536, 0.12 px across 7920 px) inside that pixel.
export function absolutePoint(monitors, name, fx, fy, mode = 'layout') {
  const target = monitors.find(monitor => monitor.name === name);
  if (!target) return null;
  const box = logicalBox(target);
  const pixel = (fraction, size) => (Math.min(size - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, Number(fraction) || 0)) * size))) + 0.5) / size;
  const x = box.x + pixel(fx, box.pixelWidth) * box.width;
  const y = box.y + pixel(fy, box.pixelHeight) * box.height;
  let area = box;
  if (mode !== 'output') {
    const boxes = monitors.map(logicalBox);
    const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
    const right = Math.max(...boxes.map(b => b.x + b.width)), bottom = Math.max(...boxes.map(b => b.y + b.height));
    area = { x: left, y: top, width: right - left, height: bottom - top };
  }
  const scaled = (value, start, size) => Math.min(65535, Math.max(0, Math.round((value - start) / size * 65536)));
  return { x: scaled(x, area.x, area.width), y: scaled(y, area.y, area.height), layoutX: x, layoutY: y };
}

// Where a value lands back in layout coordinates (for tests and the report).
export const absoluteToLayout = (value, start, size) => start + size * value / 65536;

const clampInt = (value, limit) => Math.max(-limit, Math.min(limit, Math.round(Number(value) || 0)));

// One helper process per session. Messages are queued in its stdin pipe and
// each is acknowledged, which gives the time from here to the evdev write.
export function createRdInput({ python = 'python3', helper = HELPER, dryRun = false, logFile, watchdog, mapping = 'layout', env = process.env, spawn = spawnChild, now = () => performance.now(), log = console } = {}) {
  let child = null, seq = 0, ready = false, lastAlive = 0;
  const sentAt = new Map();
  const stats = { sent: 0, acked: 0, timed: 0, lastMs: null, maxMs: 0, totalMs: 0, restarts: 0 };
  let monitors = [];

  function start() {
    if (child) return child;
    const args = [helper, ...(dryRun ? ['--dry-run'] : []), ...(dryRun && logFile ? ['--log', logFile] : []), ...(watchdog ? ['--watchdog', String(watchdog)] : [])];
    const current = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    child = current; ready = false; stats.restarts++;
    let out = '';
    current.stdout.on('data', chunk => {
      out += chunk;
      let newline;
      while ((newline = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, newline); out = out.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.ready) ready = true;
        if (Number.isInteger(message.s) && sentAt.has(message.s)) {
          const at = sentAt.get(message.s);
          sentAt.delete(message.s);
          stats.acked++;
          // Messages queued while the helper was still starting would count its start-up.
          if (at !== null) { const ms = now() - at; stats.timed++; stats.lastMs = ms; stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms); }
        }
        if (message.error) log.error?.(`[rd] input helper: ${message.error}`);
      }
    });
    let err = '';
    current.stderr.on('data', chunk => { err = (err + chunk).slice(-2000); });
    current.stdin.on('error', () => {});
    current.once('error', () => { if (child === current) child = null; });
    current.once('close', code => {
      if (child === current) child = null;
      sentAt.clear();
      if (code && err.trim()) log.error?.(`[rd] input helper exited ${code}: ${err.trim().split('\n').pop()}`);
    });
    return current;
  }

  function send(message) {
    const current = child || start();
    const s = ++seq;
    sentAt.set(s, ready ? now() : null);
    if (sentAt.size > 4096) sentAt.delete(sentAt.keys().next().value);
    stats.sent++;
    current.stdin.write(`${JSON.stringify({ s, ...message })}\n`);
    return true;
  }

  return {
    start,
    get ready() { return ready; },
    get running() { return !!child; },
    get pending() { return sentAt.size; },
    stats,
    setMonitors(list) { monitors = Array.isArray(list) ? list : []; },
    key(code, down) {
      const k = Object.hasOwn(KEY_CODES, code) ? KEY_CODES[code] : null;
      return k ? send({ k, v: down ? 1 : 0 }) : false;
    },
    button(button, down) {
      const b = BUTTON_CODES[button];
      return b ? send({ b, v: down ? 1 : 0 }) : false;
    },
    move(monitor, fx, fy) {
      const point = absolutePoint(monitors, monitor, fx, fy, mapping);
      return point ? send({ a: [point.x, point.y] }) : false;
    },
    rel(dx, dy) { return send({ r: [clampInt(dx, 10000), clampInt(dy, 10000)] }); },
    // DOM wheel: positive deltaY scrolls down, evdev REL_WHEEL > 0 scrolls up.
    wheel(dx, dy) { return send({ w: [clampInt(dx, 12000), -clampInt(dy, 12000)] }); },
    release() { return child ? send({ x: 1 }) : false; },
    // Any client message counts as a sign of life for the helper's 2 s watchdog.
    alive() {
      if (!child || now() - lastAlive < 500) return;
      lastAlive = now();
      send({});
    },
    stop() {
      const current = child;
      child = null;
      if (!current) return;
      try { current.stdin.write(`${JSON.stringify({ x: 1 })}\n`); current.stdin.end(); } catch {}
      const timer = setTimeout(() => current.kill('SIGKILL'), 1500);
      timer.unref?.();
      current.once('close', () => clearTimeout(timer));
    },
  };
}

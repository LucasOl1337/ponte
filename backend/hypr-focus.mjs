// Which monitor has the focus, the moment it changes.
//
// `hyprctl -j monitors` answers only when asked, so a remote screen that polls
// it either lags behind Super+N or burns CPU asking. Hyprland's event socket
// says it as it happens: one line per event, `name>>data`. `focusedmon` carries
// `MONITOR,WORKSPACE` and is what a workspace change across monitors emits; the
// layout events only say the list of monitors changed, and the session rereads
// it for itself.
//
// One connection serves every session: it opens with the first watcher and
// closes with the last. A compositor that is not Hyprland (no instance
// signature, no socket) simply never calls back, and following stays off.
import net from 'node:net';
import path from 'node:path';

// focusedmon names the monitor; the others only invalidate the layout.
export const FOCUS_EVENTS = ['focusedmon', 'monitoradded', 'monitorremoved', 'monitorlayoutchanged'];

export function socketPath(env = process.env) {
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!signature) return null;
  // Hyprland 0.40+ keeps it under the runtime dir; older builds used /tmp.
  return env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'hypr', signature, '.socket2.sock')
    : path.join('/tmp/hypr', signature, '.socket2.sock');
}

// `focusedmon>>DP-3,3` → { event: 'focusedmon', monitor: 'DP-3' }. A monitor
// name never carries a comma, so the first one ends it.
export function parseEvent(line) {
  const at = line.indexOf('>>');
  if (at < 0) return null;
  const event = line.slice(0, at);
  if (!FOCUS_EVENTS.includes(event)) return null;
  if (event !== 'focusedmon') return { event, monitor: null };
  const data = line.slice(at + 2);
  const comma = data.indexOf(',');
  const monitor = (comma >= 0 ? data.slice(0, comma) : data).trim();
  return { event, monitor: monitor || null };
}

export function createFocusWatcher({ env = process.env, connect = net.connect, log = console, retryMs = 2000 } = {}) {
  const listeners = new Set();
  let socket = null, buffer = '', retry = null, stopped = false;

  function drop() {
    if (retry) { clearTimeout(retry); retry = null; }
    if (socket) { try { socket.destroy(); } catch {} socket = null; }
    buffer = '';
  }

  // Hyprland restarting takes its socket with it; the sessions that outlive it
  // keep following once it is back.
  function later() {
    if (stopped || retry || !listeners.size) return;
    retry = setTimeout(() => { retry = null; open(); }, retryMs);
    retry.unref?.();
  }

  function open() {
    if (stopped || socket || !listeners.size) return;
    const file = socketPath(env);
    if (!file) return;
    let current;
    try { current = connect({ path: file }); } catch (error) { log.error?.(`[rd] focus socket: ${error.message}`); return later(); }
    socket = current;
    current.setEncoding?.('utf8');
    current.unref?.();
    current.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseEvent(line);
        if (!event) continue;
        for (const listener of [...listeners]) {
          try { listener(event); } catch (error) { log.error?.(`[rd] focus listener: ${error.message}`); }
        }
      }
    });
    current.on('error', () => { if (socket === current) { socket = null; buffer = ''; later(); } });
    current.on('close', () => { if (socket === current) { socket = null; buffer = ''; later(); } });
  }

  return {
    // onEvent({ event, monitor }). The returned function stops this watcher and,
    // when it was the last one, the connection.
    watch(onEvent) {
      if (stopped) return () => {};
      listeners.add(onEvent);
      open();
      return () => {
        listeners.delete(onEvent);
        if (!listeners.size) drop();
      };
    },
    close() { stopped = true; listeners.clear(); drop(); },
    get watching() { return listeners.size; },
  };
}

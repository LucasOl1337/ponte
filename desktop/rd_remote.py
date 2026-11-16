"""Ponte Remoto session channel. Runs on the controlled computer, stdlib only.

The launcher starts it over the same trusted SSH alias as Gliff, with the fixed
remote command REMOTE_COMMAND, and sends this file's source as the first stdin
line (a JSON string). From then on stdin carries one JSON command per line and
stdout one JSON message per line:

  -> {"t": "state", "monitors": [...], "workspaces": [...], "slots": 10}
  <- {"op": "workspace", "id": 23, "monitor": "DP-2"}
  <- {"op": "monitor", "name": "DP-2"}
  <- {"op": "once"}                       (print one state and exit)
  -> {"t": "done", "op": "workspace", "ok": true}
  -> {"t": "error", "code": "NO_HYPRLAND"}

Only these operations exist. A workspace is a bounded integer and a monitor must
be one of the monitors Hyprland reports right now, so nothing typed or received
reaches a shell: hyprctl gets argv lists with fixed dispatch expressions.

Hyprland is found the way gliff-server finds it: HYPRLAND_INSTANCE_SIGNATURE,
else the newest instance under XDG_RUNTIME_DIR/hypr whose socket answers.
Events come from that instance's .socket2.sock; any change that can move a
workspace, a window or a monitor sends a fresh state (coalesced, and only when
something the bar shows changed).

Per-monitor workspaces (Omarchy 4.5): each physical monitor owns a block of ten
ids, listed in $XDG_STATE_HOME/omarchy/monitor-workspaces as
"BLOCK<TAB>CONNECTOR<TAB>IDENTITY". Super+3 on a monitor with block 2 is
workspace 23. Without that file "block" is null and ids are global.
"""
import json
import os
from pathlib import Path
import re
import select
import socket
import subprocess
import sys
import threading
import time

VERSION = 1
SLOTS = 10
MAX_WORKSPACE = 1000
MONITOR = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z')
# The fixed command the launcher runs on the remote: read one JSON line, run it.
REMOTE_COMMAND = "python3 -u -c 'import sys,json;exec(json.loads(sys.stdin.readline()))'"
# Events that only change a title or the focused window: the bar shows neither.
QUIET_EVENTS = {'activewindow', 'activewindowv2', 'windowtitle', 'windowtitlev2', 'activelayout',
                'submap', 'urgent', 'screencast', 'minimized', 'bell', 'configreloaded', 'pin',
                'changefloatingmode', 'fullscreen', 'togglegroup', 'moveintogroup', 'moveoutofgroup',
                'ignoregrouplock', 'lockgroups', 'custom'}


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(',', ':'), ensure_ascii=False) + '\n')
    sys.stdout.flush()


def runtime_dir():
    return Path(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}')


def state_home():
    value = os.environ.get('XDG_STATE_HOME')
    return Path(value) if value and value.startswith('/') else Path.home() / '.local/state'


def ask(directory, request, timeout=3.0):
    """One request on the instance's control socket. Returns the raw reply."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(directory / '.socket.sock'))
        sock.sendall(request.encode())
        chunks = []
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    return b''.join(chunks).decode('utf-8', errors='replace')


def find_instance(runtime=None, signature=None):
    """Directory of the Hyprland instance to follow, or None."""
    hypr = Path(runtime or runtime_dir()) / 'hypr'
    signature = signature if signature is not None else os.environ.get('HYPRLAND_INSTANCE_SIGNATURE')
    if signature:
        candidates = [hypr / signature]
    else:
        try:
            candidates = sorted((path for path in hypr.iterdir() if (path / '.socket.sock').exists()),
                                key=lambda path: (path / '.socket.sock').stat().st_mtime, reverse=True)
        except OSError:
            candidates = []
    for directory in candidates:
        try:
            if ask(directory, 'j/version', timeout=1.5).lstrip().startswith('{'):
                return directory
        except OSError:
            continue
    return None


def read_blocks(path=None):
    """Connector -> block from Omarchy's per-monitor workspace file."""
    path = Path(path) if path else state_home() / 'omarchy/monitor-workspaces'
    blocks = {}
    try:
        lines = path.read_text().splitlines()
    except (OSError, UnicodeDecodeError):
        return blocks
    for line in lines:
        parts = line.split('\t')
        if len(parts) >= 3 and parts[0].isdigit() and MONITOR.fullmatch(parts[1]) and not parts[1].isdigit():
            blocks[parts[1]] = int(parts[0])
    return blocks


def build_state(monitors, workspaces, blocks):
    """The part of Hyprland's state the bar draws, small and stable."""
    shown = []
    for item in monitors if isinstance(monitors, list) else []:
        if not isinstance(item, dict) or item.get('disabled') or not MONITOR.fullmatch(str(item.get('name', ''))):
            continue
        active = item.get('activeWorkspace') or {}
        shown.append({
            'name': item['name'],
            'description': str(item.get('description') or '')[:120],
            'make': str(item.get('make') or '')[:60],
            'model': str(item.get('model') or '')[:60],
            'width': int(item.get('width') or 0), 'height': int(item.get('height') or 0),
            'x': int(item.get('x') or 0), 'y': int(item.get('y') or 0),
            'scale': float(item.get('scale') or 1),
            'focused': bool(item.get('focused')),
            'active': active.get('id') if isinstance(active.get('id'), int) else None,
            'block': blocks.get(item['name']),
        })
    spaces = []
    for item in workspaces if isinstance(workspaces, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get('id'), int) or not 1 <= item['id'] <= MAX_WORKSPACE:
            continue
        spaces.append({'id': item['id'], 'name': str(item.get('name') or item['id'])[:40],
                       'monitor': str(item.get('monitor') or ''), 'windows': int(item.get('windows') or 0)})
    spaces.sort(key=lambda space: space['id'])
    return {'t': 'state', 'v': VERSION, 'slots': SLOTS, 'monitors': shown, 'workspaces': spaces}


def lua_dispatch(kind, value):
    """Hyprland 0.56+ dispatch expression. Only validated values get here."""
    return f'hl.dsp.focus({{ {kind} = "{value}" }})'


def legacy_dispatch(kind, value):
    return ['focusmonitor', value] if kind == 'monitor' else ['workspace', value]


class Hyprland:
    def __init__(self, directory):
        self.directory = directory
        self.dialect = None

    def read(self, what):
        return json.loads(ask(self.directory, 'j/' + what))

    def state(self):
        return build_state(self.read('monitors'), self.read('workspaces'), read_blocks())

    def dispatch(self, kind, value):
        """Focus a monitor or workspace: Lua syntax first, then the classic one."""
        env = dict(os.environ, HYPRLAND_INSTANCE_SIGNATURE=self.directory.name)
        tries = {'lua': ['dispatch', lua_dispatch(kind, value)], 'legacy': ['dispatch', *legacy_dispatch(kind, value)]}
        order = [self.dialect] if self.dialect else ['lua', 'legacy']
        for dialect in order:
            try:
                result = subprocess.run(['hyprctl', *tries[dialect]], env=env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                        timeout=4, check=False)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0 and result.stdout.strip().lower() in ('ok', ''):
                self.dialect = dialect
                return True
        return False

    def events(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(str(self.directory / '.socket2.sock'))
        sock.setblocking(False)
        return sock


def run_command(hypr, command, state):
    """Apply one command. Returns the reply message."""
    op = command.get('op') if isinstance(command, dict) else None
    if op == 'monitor':
        name = command.get('name')
        names = {item['name'] for item in state['monitors']}
        if not isinstance(name, str) or name not in names:
            return {'t': 'error', 'op': op, 'code': 'INVALID_MONITOR'}
        return {'t': 'done', 'op': op, 'ok': hypr.dispatch('monitor', name)}
    if op == 'workspace':
        ident = command.get('id')
        if not isinstance(ident, int) or isinstance(ident, bool) or not 1 <= ident <= MAX_WORKSPACE:
            return {'t': 'error', 'op': op, 'code': 'INVALID_WORKSPACE'}
        monitor = command.get('monitor')
        monitors = {item['name']: item for item in state['monitors']}
        if monitor is not None and monitor not in monitors:
            return {'t': 'error', 'op': op, 'code': 'INVALID_MONITOR'}
        existing = next((space for space in state['workspaces'] if space['id'] == ident), None)
        # As Omarchy's Super+N: a workspace that does not exist yet opens on the
        # focused monitor, so focus the wanted monitor first.
        if monitor and not existing and not monitors[monitor]['focused']:
            hypr.dispatch('monitor', monitor)
        return {'t': 'done', 'op': op, 'ok': hypr.dispatch('workspace', str(ident))}
    return {'t': 'error', 'op': op if isinstance(op, str) else None, 'code': 'UNKNOWN_COMMAND'}


def line_pipe(stream):
    """A pipe fed from a buffered stream, so select() also sees lines the
    bootstrap readline() already pulled into the stream's buffer."""
    read_end, write_end = os.pipe()

    def pump():
        try:
            for line in stream:
                os.write(write_end, line.encode() if isinstance(line, str) else line)
        except (OSError, ValueError):
            pass
        finally:
            os.close(write_end)

    threading.Thread(target=pump, daemon=True).start()
    return read_end


def serve(stdin=None, runtime=None, idle_refresh=5.0, debounce=0.06):
    stdin = stdin or sys.stdin
    directory = find_instance(runtime)
    if not directory:
        emit({'t': 'error', 'code': 'NO_HYPRLAND'})
        return 3
    hypr = Hyprland(directory)
    try:
        state = hypr.state()
    except (OSError, ValueError):
        emit({'t': 'error', 'code': 'HYPRLAND_UNREADABLE'})
        return 3
    last = json.dumps(state, sort_keys=True)
    emit(state)
    events, buffer, due = None, b'', None
    next_full = time.monotonic() + idle_refresh
    fd = line_pipe(stdin)
    pending = b''
    while True:
        if events is None:
            try:
                events = hypr.events()
            except OSError:
                events = None
        waits = [fd] + ([events] if events else [])
        now = time.monotonic()
        timeout = max(0.0, min(due or next_full, next_full) - now)
        readable, _, _ = select.select(waits, [], [], timeout)
        if fd in readable:
            data = os.read(fd, 65536)
            if not data:
                return 0
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if not line.strip():
                    continue
                try:
                    command = json.loads(line)
                except ValueError:
                    emit({'t': 'error', 'code': 'BAD_JSON'})
                    continue
                if isinstance(command, dict) and command.get('op') == 'once':
                    return 0
                emit(run_command(hypr, command, state))
                due = time.monotonic() + debounce
            if len(pending) > 65536:
                emit({'t': 'error', 'code': 'LINE_TOO_LONG'})
                pending = b''
        if events is not None and events in readable:
            try:
                data = events.recv(65536)
            except OSError:
                data = b''
            if not data:
                events.close()
                events = None
                # Hyprland restarted, or went away: find it again.
                directory = find_instance(runtime)
                if not directory:
                    emit({'t': 'error', 'code': 'NO_HYPRLAND'})
                    return 3
                hypr = Hyprland(directory)
                due = time.monotonic()
            else:
                buffer += data
                lines = buffer.split(b'\n')
                buffer = lines.pop()
                for line in lines:
                    name = line.split(b'>>', 1)[0].decode(errors='replace')
                    if name and name not in QUIET_EVENTS:
                        due = due or time.monotonic() + debounce
        now = time.monotonic()
        if (due and now >= due) or now >= next_full:
            due, next_full = None, now + idle_refresh
            try:
                fresh = hypr.state()
            except (OSError, ValueError):
                continue
            signature = json.dumps(fresh, sort_keys=True)
            if signature != last:
                state, last = fresh, signature
                emit(state)


def main():
    try:
        return serve()
    except (KeyboardInterrupt, BrokenPipeError):
        return 0


if __name__ == '__main__':
    sys.exit(main())

"""Ponte Remoto session logic, without GUI: devices, screens, workspaces, Gliff.

The app (desktop/rd_app.py) draws this; tests drive it with fakes. Nothing
here talks to the local compositor except LocalWindow, which only reads.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time

from desktop import rd
from desktop import rd_remote

REMOTE_SOURCE = Path(rd_remote.__file__).read_text()
COMPUTER_KINDS = ('pc', 'notebook')


# ---- Devices --------------------------------------------------------------

def fetch_ponte_devices(origin, token_file, timeout=4):
    """The home node's /api/devices, or [] when Ponte is not answering."""
    from urllib.request import Request, urlopen
    if not origin or not token_file:
        return []
    try:
        token = Path(token_file).read_text().strip()
        if not re.fullmatch(r'[a-zA-Z0-9_-]{32,128}', token):
            return []
        request = Request(origin + '/api/devices', headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'})
        with urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read(1 << 20))
    except (OSError, ValueError):
        return []
    devices = body.get('devices') if isinstance(body, dict) else None
    return [item for item in devices or [] if isinstance(item, dict)]


def merge_devices(destinations, ponte_devices):
    """SSH destinations, named and grouped with what Ponte knows about them.

    Returns (computers, others): computers are PCs and notebooks (or aliases the
    operator named in ssh.hosts), the ones Gliff is for; others are the rest of
    ~/.ssh/config. This machine itself is left out."""
    by_alias, self_aliases = {}, set()
    for device in ponte_devices:
        aliases = [route.get('alias') for route in device.get('routes') or []
                   if isinstance(route, dict) and route.get('via') == 'ssh' and isinstance(route.get('alias'), str)]
        if device.get('self'):
            self_aliases.update(aliases)
            continue
        for alias in aliases:
            by_alias.setdefault(alias, device)
    computers, others = [], []
    for item in destinations:
        if any(alias in self_aliases for alias in item['aliases']):
            continue
        device = next((by_alias[alias] for alias in item['aliases'] if alias in by_alias), None)
        entry = dict(item)
        labelled = item['name'] != item['alias']
        if device:
            entry['kind'] = str(device.get('kind') or 'other')
            entry['status'] = str(device.get('status') or 'unknown')
            if not labelled:
                entry['name'] = rd.clean_label(device.get('name') or item['name']) or item['name']
        else:
            entry['kind'] = 'computer' if labelled else 'other'
            entry['status'] = 'unknown'
        (computers if entry['kind'] in COMPUTER_KINDS or labelled else others).append(entry)
    order = {'online': 0, 'unknown': 1, 'offline': 2}
    computers.sort(key=lambda entry: (order.get(entry['status'], 1), entry['name'].casefold()))
    others.sort(key=lambda entry: entry['name'].casefold())
    return computers, others


# ---- Screens and workspaces -----------------------------------------------

def monitor_label(monitor):
    """Short human name: model or maker, then resolution."""
    brand = (monitor.get('make') or '').split(' ')[0].title() or monitor['name']
    if brand.lower() in ('ASUSTek'.lower(),):
        brand = 'ASUS'
    height = monitor.get('height') or 0
    size = f'{height}p' if height else ''
    return f'{brand} {size}'.strip()


def find_monitor(state, name):
    return next((item for item in (state or {}).get('monitors', []) if item['name'] == name), None)


def choose_output(state, remembered=None):
    """Remembered screen when still there, else the focused one, else the first."""
    monitors = (state or {}).get('monitors') or []
    if remembered and find_monitor(state, remembered):
        return remembered
    focused = next((item for item in monitors if item['focused']), None)
    return (focused or (monitors[0] if monitors else {})).get('name')


def workspace_strip(state, output):
    """Chips for the workspace row of one screen: [{label, id, active, windows, guest}].

    With Omarchy's per-monitor blocks the row is that screen's 1-10, like its
    own bar; workspaces living on it from outside the block follow as guests.
    Without blocks: 1-5, then every numbered workspace on this screen."""
    monitor = find_monitor(state, output)
    if not monitor:
        return []
    spaces = {space['id']: space for space in state.get('workspaces', [])}
    here = [space for space in state.get('workspaces', []) if space['monitor'] == output]
    slots = int(state.get('slots') or 10)
    chips = []
    block = monitor.get('block')
    if isinstance(block, int):
        first = block * slots + 1
        ids = list(range(first, first + slots))
        for slot, ident in enumerate(ids, 1):
            space = spaces.get(ident)
            chips.append({'label': str(slot), 'id': ident, 'windows': space['windows'] if space else 0,
                          'elsewhere': bool(space and space['monitor'] != output), 'guest': False})
        for space in here:
            if space['id'] not in ids:
                chips.append({'label': space['name'], 'id': space['id'], 'windows': space['windows'],
                              'elsewhere': False, 'guest': True})
    else:
        taken = {space['id'] for space in state.get('workspaces', []) if space['monitor'] != output}
        ids = sorted({space['id'] for space in here} | ({1, 2, 3, 4, 5} - taken))
        for ident in ids:
            space = spaces.get(ident)
            chips.append({'label': str(ident), 'id': ident, 'windows': space['windows'] if space else 0,
                          'elsewhere': False, 'guest': False})
    for chip in chips:
        chip['active'] = chip['id'] == monitor.get('active')
    return chips


# ---- Preferences ----------------------------------------------------------

def prefs_path():
    base = os.environ.get('XDG_STATE_HOME')
    base = Path(base) if base and base.startswith('/') else Path.home() / '.local/state'
    return base / 'ponte/rd-app.json'


def load_prefs(path=None):
    try:
        data = json.loads(Path(path or prefs_path()).read_text())
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    outputs = data.get('outputs') if isinstance(data.get('outputs'), dict) else {}
    return {'outputs': {k: v for k, v in outputs.items() if isinstance(k, str) and isinstance(v, str)},
            'follow': data.get('follow', True) is not False,
            'last': data.get('last') if isinstance(data.get('last'), str) else None}


def save_prefs(prefs, path=None):
    path = Path(path or prefs_path())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(prefs, indent=2, ensure_ascii=False))
        os.chmod(temporary, 0o600)
        temporary.replace(path)
    except OSError:
        pass


# ---- Remote channel -------------------------------------------------------

class Channel:
    """The SSH session channel to rd_remote on the controlled computer."""

    def __init__(self, alias, ssh, on_message, on_close=None, popen=subprocess.Popen):
        if not rd.ALIAS.fullmatch(alias):
            raise ValueError('Invalid SSH alias.')
        self.alias, self.on_message, self.on_close = alias, on_message, on_close
        env = dict(os.environ)
        env.pop('LD_PRELOAD', None)
        self.process = popen([ssh, *rd.SSH_OPTIONS, '-T', '--', alias, rd_remote.REMOTE_COMMAND],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env=env, text=True, bufsize=1)
        self.lock = threading.Lock()
        self.closed = False
        self._write(json.dumps(REMOTE_SOURCE))
        threading.Thread(target=self._read, daemon=True).start()

    def _write(self, line):
        with self.lock:
            if self.closed or self.process.stdin is None:
                return False
            try:
                self.process.stdin.write(line + '\n')
                self.process.stdin.flush()
                return True
            except (OSError, ValueError):
                return False

    def _read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict):
                self.on_message(message)
        self.process.wait()
        if self.on_close and not self.closed:
            detail = ''
            try:
                detail = rd.clean_label(self.process.stderr.read()[-600:])
            except (OSError, ValueError, TypeError):
                pass
            self.on_close(self.process.returncode, detail)

    def workspace(self, ident, monitor=None):
        command = {'op': 'workspace', 'id': int(ident)}
        if monitor:
            command['monitor'] = monitor
        return self._write(json.dumps(command))

    def monitor(self, name):
        return self._write(json.dumps({'op': 'monitor', 'name': name}))

    def close(self):
        with self.lock:
            self.closed = True
            try:
                if self.process.stdin:
                    self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()


def read_state_once(alias, ssh, timeout=12, run=subprocess.run):
    """One state from the remote, for the picker. Raises ValueError on failure."""
    env = dict(os.environ)
    env.pop('LD_PRELOAD', None)
    payload = json.dumps(REMOTE_SOURCE) + '\n' + json.dumps({'op': 'once'}) + '\n'
    try:
        result = run([ssh, *rd.SSH_OPTIONS, '-T', '--', alias, rd_remote.REMOTE_COMMAND], input=payload,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f'{alias}: the screen list did not arrive in time.') from error
    for line in result.stdout.splitlines():
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get('t') == 'state':
            return message
        if message.get('t') == 'error':
            raise ValueError(f"{alias}: {message.get('code')}")
    if result.returncode == 255:
        raise ValueError(rd.ssh_failure(result.stderr))
    raise ValueError(f'{alias}: python3 is needed on the remote computer to list its screens.')


# ---- Gliff ----------------------------------------------------------------

class Gliff:
    """One Gliff window at a time, restartable on another screen."""

    def __init__(self, item, gliff, ssh, options, on_exit, popen=subprocess.Popen):
        self.item, self.gliff, self.ssh, self.options = item, gliff, ssh, options
        self.on_exit, self.popen = on_exit, popen
        self.process, self.directory, self.output = None, None, None
        self.generation = 0
        self.lock = threading.Lock()

    def argv(self, output):
        args = type('Args', (), {})()
        args.server_bin = self.options.get('server_bin', 'gliff-server')
        args.headless = False
        args.monitor = output
        args.no_clipboard = bool(self.options.get('no_clipboard'))
        args.video = self.options.get('video')
        rd.validate_options(args)
        return rd.command(self.gliff, self.item, args)

    def start(self, output):
        self.stop()
        with self.lock:
            self.generation += 1
            generation = self.generation
            self.directory = tempfile.TemporaryDirectory(prefix='ponte-gliff-')
            env = rd.gliff_env(self.directory.name, self.ssh, self.item['alias'])
            log = tempfile.TemporaryFile()
            self.process = self.popen(self.argv(output), env=env, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=log)
            self.output = output
            process, directory = self.process, self.directory
        threading.Thread(target=self._watch, args=(process, generation, log, directory), daemon=True).start()
        return process.pid

    def _watch(self, process, generation, log, directory):
        code = process.wait()
        detail = ''
        if code:
            try:
                log.seek(0, os.SEEK_END)
                log.seek(max(0, log.tell() - 2000))
                detail = rd.clean_label(log.read().decode('utf-8', errors='replace'))
            except OSError:
                pass
        log.close()
        try:
            directory.cleanup()
        except OSError:
            pass
        with self.lock:
            current = generation == self.generation
            if current:
                self.process = None
        if current:
            self.on_exit(code, detail)

    @property
    def pid(self):
        process = self.process
        return process.pid if process and process.poll() is None else None

    def stop(self):
        with self.lock:
            self.generation += 1
            process, self.process = self.process, None
        if process and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


# ---- Where the Gliff window is, locally (read-only) ----------------------

def local_window(pid, runtime=None):
    """Where the Gliff window with this pid is on the local Hyprland:
    {'visible', 'monitor', 'rect', 'monitor_width'}, rect = (x, y, w, h) in the
    monitor's logical pixels. Visible with no monitor when there is no Hyprland
    to ask. Read-only: j/clients and j/monitors."""
    unknown = {'visible': True, 'monitor': None, 'rect': None, 'monitor_width': None}
    directory = rd_remote.find_instance(runtime)
    if not directory or not pid:
        return unknown
    try:
        clients = json.loads(rd_remote.ask(directory, 'j/clients'))
        monitors = json.loads(rd_remote.ask(directory, 'j/monitors'))
    except (OSError, ValueError):
        return unknown
    mapped = [client for client in clients if client.get('mapped', True)]
    window = next((client for client in mapped if client.get('pid') == pid), None)
    if not window:
        # A compositor in another PID namespace reports 0: then the only Gliff window, if just one.
        gliffs = [client for client in mapped if client.get('class') == 'gliff']
        window = gliffs[0] if len(gliffs) == 1 and not any(client.get('pid') == pid for client in clients) else None
    hidden = {'visible': False, 'monitor': None, 'rect': None, 'monitor_width': None}
    if not window:
        return hidden
    workspace = (window.get('workspace') or {}).get('id')
    for monitor in monitors:
        if workspace in ((monitor.get('activeWorkspace') or {}).get('id'), (monitor.get('specialWorkspace') or {}).get('id')):
            scale = float(monitor.get('scale') or 1)
            transform = int(monitor.get('transform') or 0)
            width, height = int(monitor.get('width') or 0), int(monitor.get('height') or 0)
            logical_width = (height if transform % 2 else width) / scale
            at, size = window.get('at') or [0, 0], window.get('size') or [0, 0]
            rect = (int(at[0] - (monitor.get('x') or 0)), int(at[1] - (monitor.get('y') or 0)), int(size[0]), int(size[1]))
            if window.get('fullscreen'):
                rect = (0, 0, int(logical_width), rect[3])
            return {'visible': True, 'monitor': monitor.get('name'), 'rect': rect, 'monitor_width': int(logical_width)}
    return hidden


def wait_for(predicate, timeout, step=0.05):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None

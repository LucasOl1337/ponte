"""Native remote desktop launcher. No network or GUI work at import time."""
import glob
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

ALIAS = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z')
SERVER = re.compile(r'/[A-Za-z0-9_./-]+\Z')
SSH_OPTIONS = ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
               '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15',
               '-o', 'ServerAliveCountMax=2', '-o', 'RequestTTY=no']
ROOT = Path(__file__).resolve().parent.parent


def clean_label(value):
    return ''.join(c for c in str(value) if c.isprintable()).strip()[:120]


def ssh_entries(home):
    """Concrete Host groups, including local Include files. Never evaluate SSH."""
    entries, visited = [], set()
    ssh_home = home / '.ssh'

    def visit(file):
        file = file.resolve()
        if file in visited or len(visited) >= 64:
            return
        visited.add(file)
        try:
            lines = file.read_text().splitlines()
        except FileNotFoundError:
            return
        for line in lines:
            try:
                words = shlex.split(line, comments=True)
            except ValueError as error:
                raise ValueError(f'Invalid SSH config in {file}: {error}') from error
            if not words:
                continue
            key = words[0].lower()
            if key == 'include':
                for pattern in words[1:]:
                    pattern = pattern.replace('~/', str(home) + '/', 1) if pattern.startswith('~/') else pattern
                    if not Path(pattern).is_absolute():
                        pattern = str(ssh_home / pattern)
                    for child in sorted(glob.glob(pattern)):
                        visit(Path(child))
            elif key == 'host':
                names = [name for name in words[1:] if ALIAS.fullmatch(name)]
                if names and not any('*' in name or '?' in name or name.startswith('!') for name in words[1:]):
                    entries.append(names)

    visit(ssh_home / 'config')
    return entries


def destinations(config_file, home=None):
    home = Path(home or os.environ.get('HOME', str(Path.home())))
    try:
        config = json.loads(Path(config_file).read_text())
    except FileNotFoundError:
        config = {}
    if not isinstance(config, dict) or not isinstance(config.get('ssh', {}), dict):
        raise ValueError('Invalid Ponte configuration: ssh must be an object.')
    hosts = config.get('ssh', {}).get('hosts', [])
    if not isinstance(hosts, list):
        raise ValueError('Invalid Ponte configuration: ssh.hosts must be a list.')
    labels = {}
    for item in hosts:
        host = item if isinstance(item, str) else item.get('host') if isinstance(item, dict) else None
        if not isinstance(host, str) or not ALIAS.fullmatch(host):
            raise ValueError('Invalid SSH alias in Ponte ssh.hosts. Use a configured alias, not user@host or options.')
        labels[host] = clean_label(item.get('label') or host) if isinstance(item, dict) else host
    result, seen = [], set()
    for names in ssh_entries(home):
        names = [name for name in names if name not in seen]
        if not names:
            continue
        preferred = next((name for name in names if name in labels), names[0])
        result.append({'id': 'ssh:' + preferred, 'name': labels.get(preferred, preferred),
                       'alias': preferred, 'aliases': names, 'engine': 'gliff'})
        seen.update(names)
    # Explicit Ponte entries can name aliases supplied by system-wide SSH config.
    for alias, label in labels.items():
        if alias not in seen:
            result.append({'id': 'ssh:' + alias, 'name': label, 'alias': alias,
                           'aliases': [alias], 'engine': 'gliff'})
    return result


def resolve(items, value):
    key = value[4:] if value.lower().startswith('ssh:') else value
    exact = [item for item in items if key in item['aliases']]
    if exact:
        return {**exact[0], 'alias': key, 'id': 'ssh:' + key}
    matches = [item for item in items if item['name'].casefold() == value.casefold()]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ValueError(f'More than one device is called {value!r}. Use its ssh:ALIAS from ./ponte rd --list.')
    raise ValueError(f'Unknown SSH device {value!r}. Choose one with ./ponte rd --list, or configure ~/.ssh/config. For paired web devices use --engine legacy.')


def choose(items):
    """Select an opaque row id, never interpret the displayed label as a host."""
    rows = [(str(index), item['name'], item['alias'], 'Gliff') for index, item in enumerate(items)]
    rows.append(('legacy', 'Web legado', 'Aparelhos pareados no Ponte', 'Chromium'))
    zenity = shutil.which('zenity')
    if zenity and (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        command = [zenity, '--list', '--title=Ponte Remoto', '--text=Escolha o computador para controlar.',
                   '--width=720', '--height=480', '--ok-label=Conectar', '--cancel-label=Cancelar',
                   '--column=ID', '--column=Aparelho', '--column=Destino SSH', '--column=Motor',
                   '--hide-column=1', '--print-column=1', '--no-markup']
        for row in rows:
            command.extend(row)
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode == 1:
            return None
        if result.returncode:
            raise ValueError('Could not open the Ponte Remoto picker. Run ./ponte rd --list and select ssh:ALIAS.')
        selected = result.stdout.strip()
    elif sys.stdin.isatty():
        for key, name, alias, engine in rows:
            print(f'{key}: {name} | {alias} | {engine}')
        try:
            selected = input('Destino (Enter cancela): ').strip()
        except EOFError:
            return None
        if not selected:
            return None
    else:
        raise ValueError('A device must be selected. Run ./ponte rd --list, then ./ponte rd ssh:ALIAS. The app-menu picker requires zenity and a graphical session.')
    if selected == 'legacy':
        return 'legacy'
    if selected not in {row[0] for row in rows}:
        raise ValueError('Invalid picker selection. No connection was started.')
    return items[int(selected)]


def validate_options(args):
    if args.headless and args.monitor:
        raise ValueError('--headless and --monitor are mutually exclusive.')
    if args.monitor and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', args.monitor):
        raise ValueError('Invalid monitor name.')
    if args.server_bin != 'gliff-server' and not SERVER.fullmatch(args.server_bin):
        raise ValueError('--server-bin must be an absolute path without spaces or shell metacharacters.')


def checked_run(command, timeout=15):
    try:
        return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError('SSH/Gliff preflight timed out. Check the device connection and try again. No legacy fallback was started.') from error


def ssh_failure(detail):
    if re.search('Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED', detail, re.I):
        return 'SSH host key is unknown or changed. Verify it with the owner and connect with ssh ALIAS in a terminal before retrying. Ponte never accepts keys automatically.'
    if re.search('Permission denied|authentication|Too many authentication', detail, re.I):
        return 'SSH authentication failed. Configure the key/agent for this alias with ssh ALIAS first.'
    return 'SSH connection failed. Check the alias, network and remote SSH service.'


def preflight(item, args):
    validate_options(args)
    gliff = shutil.which('gliff')
    ssh = shutil.which('ssh')
    if not gliff:
        raise ValueError('Gliff is not installed. Install upstream gliff on both computers (omarchy pkg add gliff). Web is available explicitly with --engine legacy.')
    if not ssh:
        raise ValueError('OpenSSH client is missing. Install openssh.')
    local = checked_run([gliff, '--version'])
    if local.returncode or not re.fullmatch(r'gliff 0\.4\.\d+\s*', local.stdout):
        raise ValueError('This launcher supports Gliff 0.4.x (tested with 0.4.1). Check gliff --version before connecting.')
    alias = item['alias']
    if not ALIAS.fullmatch(alias):
        raise ValueError('Invalid SSH alias.')
    effective = checked_run([ssh, *SSH_OPTIONS, '-G', '--', alias])
    if effective.returncode:
        raise ValueError('Could not resolve the SSH configuration for this alias.')
    settings = dict(line.split(' ', 1) for line in effective.stdout.splitlines() if ' ' in line)
    if settings.get('remotecommand', 'none') != 'none':
        raise ValueError('This SSH alias has RemoteCommand configured. Choose a direct SSH alias without RemoteCommand.')
    # Fixed remote command except for a restricted executable path. No user label or host is interpolated.
    remote = f'{args.server_bin} --version'
    if args.server_bin == 'gliff-server':
        remote += ' && hyprctl instances -j'
    probe = checked_run([ssh, *SSH_OPTIONS, '-T', '--', alias, remote], timeout=20)
    if probe.returncode:
        if probe.returncode == 255:
            raise ValueError(ssh_failure(probe.stderr) + f' Destination: {alias}. No legacy fallback was started.')
        raise ValueError(f'{alias}: gliff-server or Hyprland is unavailable. Install upstream gliff on the remote and start its Hyprland session. Custom wrappers must support --version.')
    version, _, instances = probe.stdout.partition('\n')
    if not re.fullmatch(r'gliff-server 0\.4\.\d+', version.strip()):
        raise ValueError(f'{alias}: unsupported gliff-server version. Install matching Gliff 0.4.x on both computers.')
    if args.server_bin == 'gliff-server':
        try:
            sessions = json.loads(instances)
        except ValueError as error:
            raise ValueError(f'{alias}: could not read Hyprland sessions (hyprctl instances -j).') from error
        if not isinstance(sessions, list) or not sessions:
            raise ValueError(f'{alias}: no running Hyprland session. Start Hyprland on the remote computer first.')
    return gliff, str(Path(ssh).resolve())


def command(gliff, item, args):
    result = [gliff, '--server-bin', args.server_bin]
    if args.headless:
        result.append('--headless')
    if args.monitor:
        result.extend(['--output', args.monitor])
    if args.no_clipboard:
        result.append('--no-clipboard')
    if args.video:
        result.extend(['--video', args.video])
    result.extend(['--', item['alias']])
    return result


def launch(item, args):
    gliff, ssh = preflight(item, args)
    argv = command(gliff, item, args)
    if args.check:
        print(json.dumps({'ok': True, 'engine': 'gliff', 'device': item['id'], 'alias': item['alias'],
                          'argv': argv, 'serverBin': args.server_bin}, ensure_ascii=False))
        return
    # Ephemeral config prevents upstream tabs from reconnecting other personal hosts.
    # The selected alias is also enforced by the child-only SSH wrapper.
    with tempfile.TemporaryDirectory(prefix='ponte-gliff-') as directory, tempfile.TemporaryFile(mode='w+t') as log:
        env = dict(os.environ, XDG_CONFIG_HOME=directory, PONTE_RD_SSH=ssh, PONTE_RD_ALIAS=item['alias'],
                   PATH=str(ROOT / 'desktop/rd-bin') + os.pathsep + os.environ.get('PATH', ''))
        original = Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
        theme = original / 'omarchy'
        if theme.is_dir():
            (Path(directory) / 'omarchy').symlink_to(theme, target_is_directory=True)
        print(f"Ponte Remoto: {item['name']} via SSH {item['alias']} (Gliff). Shift+Esc releases keyboard capture.", flush=True)
        result = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stderr=log, check=False)
        if result.returncode:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 3000))
            detail = clean_label(log.read())
            raise ValueError(f'Gliff exited with code {result.returncode}: {detail}. Retry the same destination, or choose --engine legacy explicitly.')


def open_remote(args, config_file, legacy_open):
    if args.engine == 'legacy' or (args.print_url and args.engine is None):
        if args.headless or args.no_clipboard or args.video or args.check or args.list or args.server_bin != 'gliff-server':
            raise ValueError('Native options cannot be used with --engine legacy/--print-url.')
        return legacy_open(args)
    if args.print_url:
        raise ValueError('--print-url is a web-only option. Use --engine legacy --print-url.')
    validate_options(args)
    items = destinations(config_file)
    if args.list:
        print(json.dumps({'engine': 'gliff', 'devices': items, 'legacy': './ponte rd --engine legacy'}, ensure_ascii=False))
        return
    if args.check and not args.device:
        raise ValueError('--check requires a device from ./ponte rd --list.')
    selected = resolve(items, args.device) if args.device else choose(items)
    if selected == 'legacy':
        if args.headless or args.no_clipboard or args.video or args.server_bin != 'gliff-server':
            raise ValueError('Native options cannot be used with the Web legado selection.')
        return legacy_open(args)
    if selected is not None:
        return launch(selected, args)

"""Explicit per-user desktop launcher installation, no service or autostart."""
import os
from pathlib import Path
import stat
import tempfile

MARKER = '# Managed by Ponte Desktop\n'
ROOT = Path(__file__).resolve().parent.parent
# Per-user menu entries: the Android app (./ponte desktop install) and the
# remote desktop client for the other computers of the mesh (./ponte rd --install).
LAUNCHERS = {
    'desktop': {'file': 'ponte-desktop.desktop', 'name': 'Ponte Desktop', 'comment': 'Veja e controle seu Android pelo computador',
                'args': ' desktop', 'wm_class': 'ponte-desktop', 'keywords': 'Android;phone;celular;scrcpy;remote;'},
    'rd': {'file': 'ponte-rd.desktop', 'name': 'Ponte Remoto', 'comment': 'Controle seus outros computadores por esta tela',
           'args': ' rd --notify', 'wm_class': 'ponte-rd', 'keywords': 'remote;desktop;notebook;mesh;malha;computador;'},
}


def launcher_path(env=None, kind='desktop'):
    env = os.environ if env is None else env
    home = Path(env.get('HOME', str(Path.home())))
    base = Path(env.get('XDG_DATA_HOME', str(home / '.local/share')))
    if not base.is_absolute() or any(ord(c) < 32 or ord(c) == 127 for c in str(base)) or '..' in base.parts:
        raise ValueError('XDG_DATA_HOME must be an absolute path without control characters.')
    return base / 'applications' / LAUNCHERS[kind]['file']


def safe_parents(target):
    for parent in [*reversed(target.parent.parents), target.parent]:
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError('Desktop launcher directories must not contain symlinks or non-directories.')


def exec_quote(value):
    # Desktop Entry Exec is not a shell. Escape its reserved quoted characters
    # and literal field-code percent signs as required by the specification.
    text = str(value)
    if any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise ValueError('Launcher paths must not contain control characters.')
    text = text.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%')
    return '"' + text.replace('\\', '\\\\') + '"'


def entry(root=ROOT, kind='desktop'):
    spec = LAUNCHERS[kind]
    root = Path(root).resolve()
    if '%' in str(root):
        raise ValueError('Move the checkout to a path without % before installing the desktop launcher.')
    icon = str(root / 'public/icon-512.png').replace('\\', '\\\\')
    return MARKER + '\n'.join([
        '[Desktop Entry]', 'Type=Application', 'Version=1.0',
        'Name=' + spec['name'], 'Comment=' + spec['comment'],
        'Exec=' + exec_quote(root / 'ponte') + spec['args'],
        'Icon=' + icon, 'Terminal=false', 'Categories=Utility;Network;RemoteAccess;',
        'StartupNotify=true', 'StartupWMClass=' + spec['wm_class'],
        'Keywords=' + spec['keywords'], '',
    ])


def managed(target):
    try:
        info = target.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 65536:
        raise ValueError('Refusing an unmanaged or symlinked desktop launcher.')
    if not target.read_text().startswith(MARKER):
        raise ValueError('Refusing to replace a desktop launcher not managed by Ponte.')
    return True


def install(env=None, root=ROOT, kind='desktop'):
    target = launcher_path(env, kind)
    content = entry(root, kind)
    safe_parents(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_parents(target)
    if target.parent.is_symlink() or target.parent.stat().st_uid != os.getuid():
        raise ValueError('Applications directory must be owned by this user and not a symlink.')
    exists = managed(target)
    if exists and target.read_text() == content:
        return {'installed': True, 'changed': False, 'path': str(target)}
    # Refuse unmanaged names. Atomic replacement is reserved for our own entry.
    descriptor, temporary = tempfile.mkstemp(prefix='.ponte-desktop-', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
        os.chmod(temporary, 0o644)
        if exists:
            managed(target)
            os.replace(temporary, target)
        else:
            os.link(temporary, target)
        return {'installed': True, 'changed': True, 'path': str(target)}
    finally:
        Path(temporary).unlink(missing_ok=True)


def uninstall(env=None, kind='desktop'):
    target = launcher_path(env, kind)
    safe_parents(target)
    exists = managed(target)
    if exists:
        target.unlink()
    return {'installed': False, 'changed': exists, 'path': str(target)}

"""Ponte fleet probe: what a machine is running and how to continue its work.

Runs on any machine the hub reaches (locally, or over SSH as `python3 -c`),
standard library only, Python 3.8+. Every answer is one JSON document on
stdout, except `export` and `git-patch`, which write a gzip tar. It reads the
agents' own files and never writes to them, except `import` and `git-apply`,
which add a copied session or a patch on the machine that continues the work.

  probe                      machine, tools, live agents, recent sessions
  git-info DIR               branch, head, upstream, dirty files
  locate ORIGIN NAME HINT    a checkout of ORIGIN on this machine
  export KIND ID             tar.gz of one agent session (stdout)
  import CWD [--force]       tar.gz from export (stdin) into this home
  git-patch DIR              tar.gz of uncommitted changes (stdout)
  git-apply DIR              tar.gz from git-patch (stdin)
  ff DIR REF BRANCH          fast-forward DIR to REF (fetched or pushed)
  info KIND ID               a session's cwd, size and whether it is open
  refs DIR                   commits DIR already has (for a thin bundle)
  bundle DIR BRANCH SHA...   git bundle of BRANCH minus SHAs (stdout)
  unbundle DIR BRANCH HEAD   bundle (stdin) fetched, then ff DIR to HEAD
  clone ORIGIN DIR           git clone ORIGIN into a new DIR
  reach                      which of this machine's own SSH aliases answer
"""
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

VERSION = 1
HOME = os.path.expanduser('~')
AGENT_NAMES = ('claude', 'codex', 'jcode', 'opencode', 'gemini', 'grok', 'pi', 'aider', 'amp', 'goose', 'crush', 'qwen', 'cursor-agent')
SESSION_DAYS = 14
SESSION_LIMIT = 12
ID = {
    'claude': re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    'codex': re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    'jcode': re.compile(r'^session_[a-z0-9]{1,32}_[0-9]{10,16}_[0-9a-f]{8,32}$'),
}
CLAUDE = os.path.join(HOME, '.claude')
CODEX = os.path.join(HOME, '.codex')
JCODE = os.path.join(HOME, '.jcode')


def out(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    sys.stdout.write('\n')


def fail(code, **extra):
    out(dict(error=code, **extra))
    sys.exit(3)


def one_line(text, limit=160):
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    return text if len(text) <= limit else text[:limit - 1] + '\u2026'


def short(path):
    return '~' + path[len(HOME):] if path and (path == HOME or path.startswith(HOME + '/')) else path


def which(name):
    for directory in os.environ.get('PATH', '/usr/bin:/bin').split(os.pathsep) + [os.path.join(HOME, '.local/bin'), os.path.join(HOME, '.local/share/mise/shims'), '/usr/local/bin', '/snap/bin']:
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def tail(path, size=256 * 1024):
    with open(path, 'rb') as handle:
        handle.seek(0, 2)
        length = handle.tell()
        handle.seek(max(0, length - size))
        data = handle.read()
    lines = data.decode('utf-8', 'replace').split('\n')
    return lines[1:] if length > size else lines


def head(path, size=64 * 1024):
    with open(path, 'rb') as handle:
        return handle.read(size).decode('utf-8', 'replace').split('\n')


def records(lines):
    for line in lines:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            yield json.loads(line)
        except ValueError:
            continue


def user_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get('type') in ('text', 'input_text') and isinstance(part.get('text'), str):
                return part['text']
    return ''


def proc_start(pid):
    try:
        with open('/proc/%d/stat' % pid) as handle:
            text = handle.read()
        return text[text.rindex(')') + 2:].split(' ')[19]
    except (OSError, ValueError, IndexError):
        return None


def proc_comm(pid):
    try:
        with open('/proc/%d/comm' % pid) as handle:
            return handle.read().strip()
    except OSError:
        return ''


# ---------------------------------------------------------------- live agents

def live_agents():
    """Agent processes (top-level only) with their cwd and, when the agent
    says so, the session they hold."""
    procs = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open('/proc/%d/stat' % pid) as handle:
                text = handle.read()
            comm = text[text.index('(') + 1:text.rindex(')')]
            ppid = int(text[text.rindex(')') + 2:].split(' ')[1])
        except (OSError, ValueError):
            continue
        procs[pid] = (comm, ppid)
    agents = {pid for pid, (comm, _) in procs.items() if comm in AGENT_NAMES}

    def nested(pid):
        seen = 0
        parent = procs.get(pid, ('', 0))[1]
        while parent > 1 and seen < 64:
            if parent in agents:
                return True
            parent = procs.get(parent, ('', 0))[1]
            seen += 1
        return False

    claude_by_pid = {}
    try:
        for name in os.listdir(os.path.join(CLAUDE, 'sessions')):
            if name.endswith('.json') and name[:-5].isdigit():
                try:
                    with open(os.path.join(CLAUDE, 'sessions', name)) as handle:
                        value = json.load(handle)
                    claude_by_pid[int(name[:-5])] = value
                except (OSError, ValueError):
                    pass
    except OSError:
        pass
    jcode_by_pid = {}
    try:
        for name in os.listdir(os.path.join(JCODE, 'active_pids')):
            try:
                with open(os.path.join(JCODE, 'active_pids', name)) as handle:
                    jcode_by_pid[int(handle.read().strip())] = name
            except (OSError, ValueError):
                pass
    except OSError:
        pass

    result = []
    for pid in sorted(agents):
        comm = procs[pid][0]
        if nested(pid):
            continue
        try:
            argv = open('/proc/%d/cmdline' % pid, 'rb').read().split(b'\0')
            argv = [part.decode('utf-8', 'replace') for part in argv if part]
        except OSError:
            argv = []
        if comm == 'jcode' and any(arg in ('serve', 'server', 'debug', 'acp', 'api-bridge') for arg in argv[1:3]):
            continue
        if any(arg in ('-p', '--print', 'exec') for arg in argv[1:4]):
            continue
        try:
            cwd = os.readlink('/proc/%d/cwd' % pid)
        except OSError:
            cwd = ''
        session = None
        if comm == 'claude':
            info = claude_by_pid.get(pid)
            if info and str(info.get('procStart')) == str(proc_start(pid)) and ID['claude'].match(str(info.get('sessionId'))):
                session = info['sessionId']
        elif comm == 'jcode':
            session = jcode_by_pid.get(pid)
        elif comm == 'codex':
            for family in [pid] + [child for child, (_, parent) in procs.items() if parent == pid]:
                try:
                    for fd in os.listdir('/proc/%d/fd' % family):
                        target = os.readlink('/proc/%d/fd/%s' % (family, fd))
                        match = re.search(r'/rollout-.+-([0-9a-f-]{36})\.jsonl$', target)
                        if match:
                            session = match.group(1)
                except OSError:
                    pass
        result.append({'kind': comm, 'pid': pid, 'cwd': short(cwd), 'session': session})
    return result


def jcode_attached():
    """Jcode sessions held by a running process. The shared Jcode server hosts
    them all, so the owner pid is often the server, not a client."""
    result = set()
    folder = os.path.join(JCODE, 'active_pids')
    try:
        names = os.listdir(folder)
    except OSError:
        return result
    for name in names:
        if not ID['jcode'].match(name):
            continue
        try:
            with open(os.path.join(folder, name)) as handle:
                pid = int(handle.read().strip())
        except (OSError, ValueError):
            continue
        if os.path.exists('/proc/%d' % pid):
            result.add(name)
    return result


# ------------------------------------------------------------ recent sessions

def claude_file(session_id):
    base = os.path.join(CLAUDE, 'projects')
    try:
        for folder in os.listdir(base):
            path = os.path.join(base, folder, session_id + '.jsonl')
            if os.path.isfile(path):
                return path
    except OSError:
        pass
    return None


def claude_summary(path):
    """Title, last prompt, branch and the folder Claude resumes in: the
    project folder the transcript is filed under (the cwd it started in),
    even when the session later moved around with cd."""
    title = cwd = branch = prompt = None
    entry = None
    start_cwd = None
    for record in records(head(path, 32 * 1024)):
        if not start_cwd and isinstance(record.get('cwd'), str):
            start_cwd = record['cwd']
        if not entry and isinstance(record.get('entrypoint'), str):
            entry = record['entrypoint']
    for record in records(tail(path)):
        kind = record.get('type')
        if kind == 'ai-title' and record.get('aiTitle'):
            title = record['aiTitle']
        elif kind == 'custom-title' and record.get('customTitle'):
            title = record['customTitle']
        if isinstance(record.get('cwd'), str):
            cwd = record['cwd']
        if isinstance(record.get('gitBranch'), str) and record['gitBranch']:
            branch = record['gitBranch']
        if not entry and isinstance(record.get('entrypoint'), str):
            entry = record['entrypoint']
        if kind == 'user' and not record.get('isSidechain') and not record.get('isMeta'):
            text = user_text((record.get('message') or {}).get('content'))
            if text and not text.startswith(('<', '[')):  # tags, [auto], [Request interrupted by user]
                prompt = text
    folder = os.path.basename(os.path.dirname(path))
    for candidate in (start_cwd, cwd):
        if candidate and claude_folder(candidate) == folder:
            cwd = candidate
            break
    else:
        cwd = start_cwd or cwd
    return {'title': title, 'cwd': cwd, 'branch': branch, 'prompt': prompt, 'entry': entry}


def scratch(cwd):
    """A throwaway session: started in a temp directory, outside the home. By
    path, not by substring (~/Projects/app/tmp is a project), and never inside
    the home, which may itself live in a temp directory (containers, CI)."""
    inside = lambda path, root: path == root or path.startswith(root.rstrip('/') + '/')
    if HOME not in ('', '/') and inside(cwd, HOME):
        return False
    return any(inside(cwd, root) for root in {'/tmp', '/var/tmp', tempfile.gettempdir()} if root)


def claude_sessions(since):
    base = os.path.join(CLAUDE, 'projects')
    found = []
    try:
        folders = os.listdir(base)
    except OSError:
        return []
    for folder in folders:
        directory = os.path.join(base, folder)
        try:
            entries = os.scandir(directory)
        except OSError:
            continue
        for entry in entries:
            if not entry.name.endswith('.jsonl') or not ID['claude'].match(entry.name[:-6]):
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            if stat.st_mtime >= since and stat.st_size > 2048:
                found.append((stat.st_mtime, entry.name[:-6], entry.path))
    found.sort(reverse=True)
    result = []
    for mtime, session_id, path in found[:SESSION_LIMIT * 3]:
        info = claude_summary(path)
        if info['entry'] not in (None, 'cli'):
            continue  # claude -p and SDK runs: nothing to continue by hand
        if not info['cwd'] or scratch(info['cwd']):
            continue
        result.append({'kind': 'claude', 'id': session_id, 'title': one_line(info['title'] or info['prompt'] or os.path.basename(info['cwd'])), 'last': one_line(info['prompt'], 200), 'cwd': short(info['cwd']), 'branch': info['branch'], 'updatedAt': int(mtime * 1000)})
        if len(result) >= SESSION_LIMIT:
            break
    return result


def open_ro(path):
    connection = sqlite3.connect('file:%s?mode=ro' % path, uri=True, timeout=1)
    connection.row_factory = sqlite3.Row
    return connection


def codex_sessions(since):
    database = os.path.join(CODEX, 'state_5.sqlite')
    result = []
    if os.path.isfile(database):
        try:
            with open_ro(database) as connection:
                rows = connection.execute(
                    "select id, rollout_path, cwd, title, name, first_user_message, git_branch, updated_at_ms, updated_at, source from threads "
                    "where archived = 0 and source in ('cli', 'vscode') and coalesce(updated_at_ms, updated_at * 1000) >= ? "
                    "order by coalesce(updated_at_ms, updated_at * 1000) desc limit ?", (int(since * 1000), SESSION_LIMIT)).fetchall()
            for row in rows:
                title = row['name'] or row['title'] or row['first_user_message']
                result.append({'kind': 'codex', 'id': row['id'], 'title': one_line(title), 'last': None, 'cwd': short(row['cwd'] or ''), 'branch': row['git_branch'], 'updatedAt': int(row['updated_at_ms'] or row['updated_at'] * 1000)})
            return result
        except sqlite3.Error:
            result = []
    return result


def jcode_sessions(since):
    database = os.path.join(JCODE, 'session-metadata-v1.sqlite3')
    if not os.path.isfile(database):
        return []
    try:
        with open_ro(database) as connection:
            rows = connection.execute(
                "select session_id, working_dir, generated_title, custom_title, todo_title, updated_at_ms, last_active_at_ms from recent_sessions "
                "where coalesce(last_active_at_ms, updated_at_ms) >= ? order by coalesce(last_active_at_ms, updated_at_ms) desc limit ?",
                (int(since * 1000), SESSION_LIMIT * 2)).fetchall()
    except sqlite3.Error:
        return []
    result = []
    for row in rows:
        if not ID['jcode'].match(row['session_id'] or '') or not row['working_dir']:
            continue
        path = os.path.join(JCODE, 'sessions', row['session_id'] + '.json')
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            continue
        # Generated titles are sometimes the first message, which can be a
        # tool attachment marker; the todo title then says more.
        titles = [row['custom_title'], row['generated_title'], row['todo_title']]
        title = next((value for value in titles if value and not value.startswith('[Attached') and value.strip().lower() != 'jcode'), None)
        result.append({'kind': 'jcode', 'id': row['session_id'], 'title': one_line(title), 'last': None, 'cwd': short(row['working_dir']), 'branch': None, 'updatedAt': int(max(mtime * 1000, row['updated_at_ms'] or 0))})
        if len(result) >= SESSION_LIMIT:
            break
    return result


def probe():
    started = time.time()
    since = time.time() - SESSION_DAYS * 86400
    try:
        with open('/proc/uptime') as handle:
            uptime = int(float(handle.read().split()[0]))
    except (OSError, ValueError):
        uptime = None
    try:
        load = [round(value, 2) for value in os.getloadavg()]
    except OSError:
        load = None
    memory = {}
    try:
        with open('/proc/meminfo') as handle:
            for line in handle:
                key, value = line.split(':', 1)
                if key in ('MemTotal', 'MemAvailable'):
                    memory[key] = int(value.split()[0]) * 1024
    except (OSError, ValueError):
        pass
    tools = {name: bool(which(name)) for name in ('claude', 'codex', 'jcode', 'tmux', 'git', 'node')}
    ponte = None
    manifest = os.path.join(HOME, 'Projects', 'ponte', 'package.json')
    try:
        with open(manifest) as handle:
            ponte = json.load(handle).get('version')
    except (OSError, ValueError):
        pass
    agents = live_agents()
    live = {(item['kind'], item['session']) for item in agents if item['session']}
    live |= {('jcode', name) for name in jcode_attached()}
    sessions = []
    for reader in (claude_sessions, codex_sessions, jcode_sessions):
        try:
            sessions.extend(reader(since))
        except Exception:  # one broken store must not hide the others
            pass
    for item in sessions:
        item['live'] = (item['kind'], item['id']) in live
    sessions.sort(key=lambda item: item['updatedAt'], reverse=True)
    uname = os.uname()
    out({
        'v': VERSION, 'hostname': uname.nodename, 'user': os.environ.get('USER') or os.path.basename(HOME), 'home': HOME,
        'kernel': uname.release, 'arch': uname.machine, 'python': '%d.%d' % sys.version_info[:2], 'uptime': uptime, 'load': load,
        'cpus': os.cpu_count(), 'memory': {'total': memory.get('MemTotal'), 'available': memory.get('MemAvailable')},
        'tools': tools, 'ponte': ponte, 'agents': agents, 'sessions': sessions[:SESSION_LIMIT * 2],
        'probeMs': int((time.time() - started) * 1000),
    })


# ------------------------------------------------------------------------ git

def git(directory, *args, check=True, data=None):
    result = subprocess.run(['git', '-C', directory] + list(args), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.decode('utf-8', 'replace').strip()[-400:] or 'git failed')
    return result.stdout.decode('utf-8', 'replace').strip() if data is None or isinstance(data, bytes) else result.stdout


def expand(directory):
    return os.path.join(HOME, directory[2:]) if directory.startswith('~/') else HOME if directory == '~' else directory


def git_info(directory):
    directory = expand(directory)
    if not os.path.isdir(directory):
        out({'exists': False, 'repo': False, 'dir': short(directory), 'dirAbs': directory, 'home': HOME})
        return
    try:
        root = git(directory, 'rev-parse', '--show-toplevel')
    except (RuntimeError, OSError, subprocess.SubprocessError):
        out({'exists': True, 'repo': False, 'dir': short(directory), 'dirAbs': directory, 'home': HOME})
        return
    branch = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False) or None
    head_sha = git(root, 'rev-parse', 'HEAD', check=False) or None
    upstream = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}', check=False) or None
    ahead = behind = None
    if upstream:
        counts = git(root, 'rev-list', '--left-right', '--count', 'HEAD...@{u}', check=False).split()
        if len(counts) == 2:
            ahead, behind = int(counts[0]), int(counts[1])
    status = git(root, 'status', '--porcelain=v1', '--untracked-files=normal', check=False).splitlines()
    origin = git(root, 'remote', 'get-url', 'origin', check=False) or None
    subject = git(root, 'log', '-1', '--format=%s', check=False) or None
    out({'exists': True, 'repo': True, 'dir': short(directory), 'dirAbs': directory, 'home': HOME, 'root': short(root), 'rootAbs': root, 'branch': branch, 'head': head_sha, 'subject': one_line(subject, 100),
         'upstream': upstream, 'ahead': ahead, 'behind': behind, 'origin': origin,
         'changed': len([line for line in status if not line.startswith('??')]), 'untracked': len([line for line in status if line.startswith('??')])})


def normalize_origin(url):
    url = (url or '').strip().rstrip('/')
    url = re.sub(r'\.git$', '', url)
    url = re.sub(r'^(?:ssh://)?git@([^:/]+)[:/]', r'\1/', url)
    url = re.sub(r'^https?://(?:[^@/]+@)?', '', url)
    return url.lower()


def locate(origin, name, hint):
    """A checkout of ORIGIN: the hinted path first, then ~/Projects/NAME,
    then any git folder two levels under ~ and ~/Projects."""
    wanted = normalize_origin(origin)
    candidates = []
    for path in (expand(hint), os.path.join(HOME, 'Projects', name), os.path.join(HOME, name)):
        if path and path not in candidates:
            candidates.append(path)
    for base in (os.path.join(HOME, 'Projects'), HOME):
        try:
            for entry in sorted(os.listdir(base)):
                path = os.path.join(base, entry)
                if os.path.isdir(os.path.join(path, '.git')) and path not in candidates:
                    candidates.append(path)
        except OSError:
            pass
    for path in candidates[:400]:
        if not os.path.isdir(os.path.join(path, '.git')) and path != expand(hint):
            continue
        if not os.path.isdir(path):
            continue
        try:
            root = git(path, 'rev-parse', '--show-toplevel')
            found = git(root, 'remote', 'get-url', 'origin', check=False)
        except (RuntimeError, OSError, subprocess.SubprocessError):
            continue
        if wanted and normalize_origin(found) == wanted:
            out({'found': True, 'dir': short(root), 'dirAbs': root})
            return
        if not wanted and path == expand(hint):
            out({'found': True, 'dir': short(root), 'dirAbs': root})
            return
    out({'found': False, 'suggest': short(os.path.join(HOME, 'Projects', name)), 'suggestAbs': os.path.join(HOME, 'Projects', name)})


def git_patch(directory):
    root = git(expand(directory), 'rev-parse', '--show-toplevel')
    diff = subprocess.run(['git', '-C', root, 'diff', '--binary', 'HEAD'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60).stdout
    untracked = subprocess.run(['git', '-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], stdout=subprocess.PIPE, timeout=60).stdout.split(b'\0')
    buffer = sys.stdout.buffer
    with tarfile.open(fileobj=buffer, mode='w|gz') as archive:
        head_sha = git(root, 'rev-parse', 'HEAD', check=False)
        add_bytes(archive, 'manifest.json', json.dumps({'head': head_sha}).encode())
        add_bytes(archive, 'changes.diff', diff)
        for name in untracked:
            if not name:
                continue
            relative = name.decode('utf-8', 'surrogateescape')
            path = os.path.join(root, relative)
            if os.path.isfile(path) and not os.path.islink(path) and os.path.getsize(path) <= 20 * 1024 * 1024:
                archive.add(path, arcname='untracked/' + relative, recursive=False)


def git_apply(directory):
    root = git(expand(directory), 'rev-parse', '--show-toplevel')
    if git(root, 'status', '--porcelain=v1', check=False):
        fail('DEST_DIRTY', dir=short(root))
    data = sys.stdin.buffer.read()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        manifest = json.loads(archive.extractfile('manifest.json').read())
        if manifest.get('head') and git(root, 'rev-parse', 'HEAD', check=False) != manifest['head']:
            fail('HEAD_MISMATCH', expected=manifest['head'])
        diff = archive.extractfile('changes.diff').read()
        files = []
        for member in members:
            if not member.name.startswith('untracked/') or not member.isfile():
                continue
            relative = os.path.normpath(member.name[len('untracked/'):])
            if relative.startswith('..') or os.path.isabs(relative):
                continue
            target = os.path.join(root, relative)
            if os.path.exists(target):
                fail('UNTRACKED_EXISTS', file=relative)
            files.append((member, target, relative))
        if diff.strip():
            check = subprocess.run(['git', '-C', root, 'apply', '--check', '--binary', '-'], input=diff, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if check.returncode != 0:
                fail('PATCH_FAILED', detail=check.stderr.decode('utf-8', 'replace')[-300:])
            subprocess.run(['git', '-C', root, 'apply', '--binary', '-'], input=diff, check=True)
        for member, target, relative in files:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as handle:
                handle.write(archive.extractfile(member).read())
            os.chmod(target, member.mode & 0o777)
    out({'ok': True, 'changed': diff.count(b'\ndiff --git ') + (1 if diff.startswith(b'diff --git ') else 0), 'untracked': len(files)})


def fast_forward(directory, ref, branch):
    """Bring DIR to REF (a commit that is already in its object store) without
    ever discarding work: only a fast-forward, only a clean tree for a switch."""
    root = git(expand(directory), 'rev-parse', '--show-toplevel')
    target = git(root, 'rev-parse', '--verify', ref + '^{commit}')
    current = git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD', check=False)
    head_sha = git(root, 'rev-parse', 'HEAD', check=False)
    dirty = bool(git(root, 'status', '--porcelain=v1', '--untracked-files=no', check=False))
    if head_sha == target and current == branch:
        out({'ok': True, 'action': 'same'})
        return
    if current != branch:
        if dirty:
            fail('DEST_DIRTY', dir=short(root), branch=current)
        exists = subprocess.run(['git', '-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], stdout=subprocess.PIPE).returncode == 0
        if exists:
            local = git(root, 'rev-parse', 'refs/heads/' + branch)
            if subprocess.run(['git', '-C', root, 'merge-base', '--is-ancestor', local, target]).returncode != 0:
                fail('DIVERGED', branch=branch)
            git(root, 'checkout', '--quiet', branch)
        else:
            git(root, 'checkout', '--quiet', '-b', branch, target)
            out({'ok': True, 'action': 'created', 'branch': branch})
            return
        head_sha = git(root, 'rev-parse', 'HEAD')
    if head_sha == target:
        out({'ok': True, 'action': 'switched'})
        return
    if subprocess.run(['git', '-C', root, 'merge-base', '--is-ancestor', head_sha, target]).returncode != 0:
        if subprocess.run(['git', '-C', root, 'merge-base', '--is-ancestor', target, head_sha]).returncode == 0:
            out({'ok': True, 'action': 'ahead'})
            return
        fail('DIVERGED', branch=branch)
    # A fast-forward over local edits could stop halfway or mix them in: the
    # owner decides what to do with them first.
    if dirty:
        fail('DEST_DIRTY', dir=short(root), branch=branch)
    git(root, 'merge', '--ff-only', '--quiet', target)
    out({'ok': True, 'action': 'fast-forward', 'from': head_sha, 'to': target})


# ------------------------------------------------------------ session copies

def add_bytes(archive, name, data, mtime=None):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = int(mtime or time.time())
    info.mode = 0o600
    archive.addfile(info, io.BytesIO(data))


def claude_folder(cwd):
    return re.sub(r'[^a-zA-Z0-9]', '-', cwd)


def session_files(kind, session_id):
    """(absolute path, path relative to home) of every file of one session,
    and the session's working directory."""
    if kind not in ID or not ID[kind].match(session_id):
        fail('SESSION_INVALID')
    files = []
    cwd = None
    if kind == 'claude':
        path = claude_file(session_id)
        if not path:
            fail('SESSION_NOT_FOUND')
        cwd = claude_summary(path)['cwd']
        files.append(path)
        extra = os.path.join(os.path.dirname(path), session_id)
        if os.path.isdir(extra):
            for folder, _, names in os.walk(extra):
                files.extend(os.path.join(folder, name) for name in names)
    elif kind == 'codex':
        path = None
        database = os.path.join(CODEX, 'state_5.sqlite')
        try:
            with open_ro(database) as connection:
                row = connection.execute('select rollout_path, cwd from threads where id = ?', (session_id,)).fetchone()
            if row:
                path, cwd = row['rollout_path'], row['cwd']
        except sqlite3.Error:
            pass
        if not path or not os.path.isfile(path):
            for folder, _, names in os.walk(os.path.join(CODEX, 'sessions')):
                for name in names:
                    if name.endswith(session_id + '.jsonl'):
                        path = os.path.join(folder, name)
        if not path or not os.path.isfile(path):
            fail('SESSION_NOT_FOUND')
        if not cwd:
            for record in records(head(path, 16 * 1024)):
                cwd = (record.get('payload') or {}).get('cwd')
                break
        files.append(path)
    else:
        path = os.path.join(JCODE, 'sessions', session_id + '.json')
        if not os.path.isfile(path):
            fail('SESSION_NOT_FOUND')
        with open(path, 'rb') as handle:
            cwd = json.load(handle).get('working_dir')
        files.append(path)
        journal = os.path.join(JCODE, 'sessions', session_id + '.journal.jsonl')
        if os.path.isfile(journal):
            files.append(journal)
    pairs = []
    for path in files:
        relative = os.path.relpath(path, HOME)
        if relative.startswith('..'):
            fail('SESSION_OUTSIDE_HOME')
        pairs.append((path, relative))
    return pairs, cwd


def export(kind, session_id):
    pairs, cwd = session_files(kind, session_id)
    live = any(item['session'] == session_id for item in live_agents()) or (kind == 'jcode' and session_id in jcode_attached())
    manifest = {'v': VERSION, 'kind': kind, 'id': session_id, 'home': HOME, 'cwd': cwd, 'live': live, 'host': os.uname().nodename,
                'files': [{'path': relative, 'mtime': os.stat(path).st_mtime} for path, relative in pairs]}
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz') as archive:
        add_bytes(archive, 'manifest.json', json.dumps(manifest).encode())
        for index, (path, _) in enumerate(pairs):
            archive.add(path, arcname='files/%d' % index, recursive=False)


def rewrite(data, replacements):
    for old, new in replacements:
        data = data.replace(old, new)
    return data


def import_session(cwd, force):
    cwd = os.path.normpath(expand(cwd))
    if not os.path.isabs(cwd) or not os.path.isdir(cwd):
        fail('DEST_DIR_MISSING', dir=short(cwd))
    data = sys.stdin.buffer.read()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        manifest = json.loads(archive.extractfile('manifest.json').read())
        kind, session_id = manifest.get('kind'), manifest.get('id', '')
        if kind not in ID or not ID[kind].match(session_id):
            fail('SESSION_INVALID')
        src_home, src_cwd = manifest.get('home') or '', manifest.get('cwd') or ''
        replacements = []
        if src_cwd and src_cwd != cwd:
            replacements.append(('"%s"' % src_cwd, '"%s"' % cwd))
            replacements.append(('"%s/' % src_cwd, '"%s/' % cwd))
        if src_home and src_home != HOME:
            replacements.append((src_home + '/', HOME + '/'))
            replacements.append(('"%s"' % src_home, '"%s"' % HOME))
        replacements = [(old.encode(), new.encode()) for old, new in replacements]
        plan = []
        for index, entry in enumerate(manifest.get('files') or []):
            relative = os.path.normpath(entry['path'])
            if relative.startswith('..') or os.path.isabs(relative):
                fail('SESSION_INVALID')
            if kind == 'claude':
                parts = relative.split(os.sep)
                if len(parts) < 4 or parts[0] != '.claude' or parts[1] != 'projects':
                    fail('SESSION_INVALID')
                parts[2] = claude_folder(cwd)
                relative = os.sep.join(parts)
            elif kind == 'codex' and not relative.startswith('.codex' + os.sep + 'sessions' + os.sep):
                fail('SESSION_INVALID')
            elif kind == 'jcode' and not relative.startswith('.jcode' + os.sep + 'sessions' + os.sep):
                fail('SESSION_INVALID')
            target = os.path.join(HOME, relative)
            if os.path.isfile(target) and os.stat(target).st_mtime > float(entry.get('mtime') or 0) + 2 and not force:
                fail('DEST_NEWER', file=short(target))
            plan.append((archive.getmember('files/%d' % index), target, entry))
        written = []
        for member, target, entry in plan:
            content = archive.extractfile(member).read()
            if target.endswith(('.jsonl', '.json', '.txt', '.md')):
                content = rewrite(content, replacements)
            if kind == 'jcode' and target.endswith('.json') and not target.endswith('.journal.jsonl'):
                try:
                    value = json.loads(content)
                    if value.get('status') == 'Active':
                        value['status'] = 'Closed'
                    value['last_pid'] = None
                    content = json.dumps(value, ensure_ascii=False).encode()
                except ValueError:
                    pass
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            if os.path.isfile(target):
                os.replace(target, target + '.ponte-bak')
            temporary = target + '.ponte-tmp'
            with open(temporary, 'wb') as handle:
                handle.write(content)
            os.chmod(temporary, 0o600)
            mtime = float(entry.get('mtime') or time.time())
            os.utime(temporary, (mtime, mtime))
            os.replace(temporary, target)
            written.append(short(target))
    if kind == 'codex':
        register_codex(session_id, written[0] if written else None, cwd)
    out({'ok': True, 'kind': kind, 'id': session_id, 'files': len(written), 'cwd': short(cwd), 'from': manifest.get('host'), 'wasLive': bool(manifest.get('live'))})


def register_codex(session_id, rollout, cwd):
    """Codex finds a thread through its state database. A copied rollout is
    registered by codex itself the next time it scans its sessions folder;
    nothing is written to its database from here."""
    return None


def info(kind, session_id):
    pairs, cwd = session_files(kind, session_id)
    live = [item for item in live_agents() if item['session'] == session_id]
    if not live and kind == 'jcode' and session_id in jcode_attached():
        live = [{'pid': None}]
    out({'kind': kind, 'id': session_id, 'cwd': cwd, 'cwdShort': short(cwd or ''), 'home': HOME, 'host': os.uname().nodename,
         'bytes': sum(os.path.getsize(path) for path, _ in pairs), 'files': len(pairs),
         'live': bool(live), 'pid': live[0]['pid'] if live else None})


def refs(directory):
    root = git(expand(directory), 'rev-parse', '--show-toplevel')
    lines = git(root, 'for-each-ref', '--format=%(objectname)', '--sort=-committerdate', '--count=200', 'refs/heads', 'refs/remotes', 'refs/tags', check=False).split()
    head_sha = git(root, 'rev-parse', 'HEAD', check=False)
    shas = list(dict.fromkeys(([head_sha] if head_sha else []) + lines))
    out({'shas': shas[:200]})


def bundle(directory, branch, shas):
    root = git(expand(directory), 'rev-parse', '--show-toplevel')
    if not re.match(r'^[A-Za-z0-9._/-]{1,200}$', branch) or '..' in branch:
        fail('GIT_FAILED', detail='bad branch')
    known = []
    if shas:
        check = subprocess.run(['git', '-C', root, 'cat-file', '--batch-check'], input=''.join(sha + '^{commit}\n' for sha in shas if re.match(r'^[0-9a-f]{40,64}$', sha)).encode(), stdout=subprocess.PIPE, timeout=60)
        for line in check.stdout.decode().splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1] == 'commit':
                known.append(parts[0])
    temporary = os.path.join(root, '.git', 'ponte-handoff.bundle')
    result = subprocess.run(['git', '-C', root, 'bundle', 'create', '--quiet', temporary, 'refs/heads/' + branch] + (['--not'] + known if known else []), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    try:
        if result.returncode != 0:
            if b'empty bundle' in result.stderr:
                return  # nothing new: zero bytes on stdout
            sys.stderr.write(result.stderr.decode('utf-8', 'replace')[-300:])
            sys.exit(4)
        with open(temporary, 'rb') as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def unbundle(directory, branch, head_sha):
    root = git(expand(directory), 'rev-parse', '--show-toplevel')
    data = sys.stdin.buffer.read()
    if data:
        temporary = os.path.join(root, '.git', 'ponte-handoff.bundle')
        with open(temporary, 'wb') as handle:
            handle.write(data)
        try:
            git(root, 'fetch', '--quiet', '--no-tags', temporary, '+refs/heads/%s:refs/ponte/handoff' % branch)
        finally:
            os.unlink(temporary)
    fast_forward(root, head_sha, branch)


def clone(origin, directory):
    directory = expand(directory)
    if os.path.exists(directory):
        fail('DEST_EXISTS', dir=short(directory))
    os.makedirs(os.path.dirname(directory), exist_ok=True)
    result = subprocess.run(['git', 'clone', '--quiet', origin, directory], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600, env=dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_SSH_COMMAND='ssh -o BatchMode=yes'))
    if result.returncode != 0:
        fail('CLONE_FAILED', detail=result.stderr.decode('utf-8', 'replace')[-300:])
    out({'ok': True, 'dir': short(directory), 'dirAbs': directory})


def ssh_aliases():
    """Concrete Host names of ~/.ssh/config (one line each, no patterns)."""
    lines = []
    try:
        with open(os.path.join(HOME, '.ssh', 'config')) as handle:
            for line in handle:
                match = re.match(r'^\s*Host\s+(.+?)\s*$', line, re.I)
                if match:
                    names = [name for name in match.group(1).split() if re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', name)]
                    if names and not any(ch in match.group(1) for ch in '*?!'):
                        lines.append(names)
    except OSError:
        pass
    return lines


def ssh_settings(alias):
    result = subprocess.run(['ssh', '-G', alias], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    values = {}
    for line in result.stdout.decode('utf-8', 'replace').splitlines():
        key, _, value = line.partition(' ')
        values.setdefault(key.lower(), value.strip())
    return values


def reach():
    import threading
    found = []
    for names in ssh_aliases()[:24]:
        alias = names[0]
        values = ssh_settings(alias)
        kind = 'hop' if values.get('remotecommand', 'none') != 'none' else 'tailscale-ssh' if values.get('preferredauthentications') == 'none' and values.get('pubkeyauthentication') in ('no', 'false') else 'key'
        found.append({'alias': alias, 'names': names, 'hostname': values.get('hostname'), 'port': int(values.get('port') or 22), 'user': values.get('user'), 'kind': kind})

    def attempt(item):
        if item['kind'] != 'key':
            return
        started = time.time()
        try:
            result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'RequestTTY=no', '-T', item['alias'], 'true'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=12)
            item['ok'] = result.returncode == 0
            if not item['ok']:
                item['stderr'] = result.stderr.decode('utf-8', 'replace').strip()[-200:]
        except subprocess.TimeoutExpired:
            item['ok'] = False
            item['stderr'] = 'Connection timed out'
        item['ms'] = int((time.time() - started) * 1000)

    threads = [threading.Thread(target=attempt, args=(item,)) for item in found]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15)
    out({'host': os.uname().nodename, 'routes': found})


def main(argv):
    if not argv:
        fail('USAGE')
    command, args = argv[0], argv[1:]
    try:
        if command == 'probe':
            probe()
        elif command == 'git-info' and len(args) == 1:
            git_info(args[0])
        elif command == 'locate' and len(args) == 3:
            locate(*args)
        elif command == 'export' and len(args) == 2:
            export(*args)
        elif command == 'import' and len(args) in (1, 2):
            import_session(args[0], args[1:] == ['--force'])
        elif command == 'git-patch' and len(args) == 1:
            git_patch(args[0])
        elif command == 'git-apply' and len(args) == 1:
            git_apply(args[0])
        elif command == 'ff' and len(args) == 3:
            fast_forward(*args)
        elif command == 'info' and len(args) == 2:
            info(*args)
        elif command == 'refs' and len(args) == 1:
            refs(args[0])
        elif command == 'bundle' and len(args) >= 2:
            bundle(args[0], args[1], args[2:])
        elif command == 'unbundle' and len(args) == 3:
            unbundle(*args)
        elif command == 'clone' and len(args) == 2:
            clone(*args)
        elif command == 'reach' and not args:
            reach()
        else:
            fail('USAGE')
    except RuntimeError as error:
        fail('GIT_FAILED', detail=str(error)[-300:])


if __name__ == '__main__':
    main(sys.argv[1:])

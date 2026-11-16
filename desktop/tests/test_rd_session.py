"""Ponte Remoto app logic: remote channel, workspace strip, Gliff restarts.

No real Hyprland, SSH or Gliff: fake Unix sockets stand in for Hyprland and
small scripts for ssh, hyprctl and gliff.
"""
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from desktop import rd_remote, rd_session as rs  # noqa: E402

MONITORS = [
    {'name': 'HDMI-A-1', 'description': 'Samsung', 'make': 'Samsung Electric Company', 'model': 'LS27',
     'width': 1920, 'height': 1080, 'x': 0, 'y': 0, 'scale': 1, 'focused': True,
     'activeWorkspace': {'id': 4, 'name': '4'}, 'disabled': False},
    {'name': 'DP-2', 'description': 'ASUS', 'make': 'ASUSTek COMPUTER INC', 'model': 'VG32',
     'width': 2560, 'height': 1440, 'x': 1920, 'y': 0, 'scale': 1, 'focused': False,
     'activeWorkspace': {'id': 21, 'name': '21'}, 'disabled': False},
    {'name': 'HDMI-A-2', 'disabled': True, 'activeWorkspace': {'id': 31}},
]
WORKSPACES = [
    {'id': 1, 'name': '1', 'monitor': 'HDMI-A-1', 'windows': 0},
    {'id': 4, 'name': '4', 'monitor': 'HDMI-A-1', 'windows': 1},
    {'id': 6, 'name': '6', 'monitor': 'HDMI-A-1', 'windows': 3},
    {'id': 13, 'name': '13', 'monitor': 'HDMI-A-1', 'windows': 1},
    {'id': 21, 'name': '21', 'monitor': 'DP-2', 'windows': 1},
    {'id': 24, 'name': '24', 'monitor': 'HDMI-A-1', 'windows': 2},
    {'id': -98, 'name': 'special:minimized', 'monitor': 'DP-2', 'windows': 1},
]
BLOCKS = {'HDMI-A-1': 0, 'DP-2': 2}


def state(blocks=BLOCKS, workspaces=WORKSPACES):
    return rd_remote.build_state(json.loads(json.dumps(MONITORS)), workspaces, blocks)


class FakeHyprland:
    """Unix sockets shaped like one Hyprland instance under RUNTIME/hypr/SIG."""

    def __init__(self, runtime, signature='fake_sig'):
        self.directory = Path(runtime) / 'hypr' / signature
        self.directory.mkdir(parents=True)
        self.monitors = json.loads(json.dumps(MONITORS))
        self.workspaces = json.loads(json.dumps(WORKSPACES))
        self.clients = []
        self.requests = []
        self.event_clients = []
        self.control = self._listen('.socket.sock', self._answer)
        self.events = self._listen('.socket2.sock', self.event_clients.append)

    def _listen(self, name, handler):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(self.directory / name))
        server.listen(8)

        def loop():
            while True:
                try:
                    conn, _ = server.accept()
                except OSError:
                    return
                handler(conn)
        threading.Thread(target=loop, daemon=True).start()
        return server

    def _answer(self, conn):
        with conn:
            request = conn.recv(4096).decode()
            self.requests.append(request)
            replies = {'j/version': {'tag': 'v0.56.2'}, 'j/monitors': self.monitors, 'j/workspaces': self.workspaces,
                       'j/clients': self.clients}
            conn.sendall(json.dumps(replies.get(request, {})).encode())

    def event(self, line):
        for conn in list(self.event_clients):
            try:
                conn.sendall((line + '\n').encode())
            except OSError:
                self.event_clients.remove(conn)

    def close(self):
        self.control.close()
        self.events.close()
        for conn in self.event_clients:
            conn.close()


class Fakes:
    """A bin directory with fake hyprctl (logging argv) and ssh (runs the remote command locally)."""

    def __init__(self, directory, hyprctl_reply='ok'):
        self.bin = Path(directory) / 'bin'
        self.bin.mkdir()
        self.log = Path(directory) / 'calls.jsonl'
        (self.bin / 'hyprctl').write_text(f'''#!/usr/bin/env python3
import json,os,sys
with open({str(self.log)!r},'a') as f: f.write(json.dumps({{'bin':'hyprctl','args':sys.argv[1:],'sig':os.environ.get('HYPRLAND_INSTANCE_SIGNATURE')}})+'\\n')
reply={hyprctl_reply!r}
if reply=='lua-only' and not sys.argv[2].startswith('hl.dsp'): print('Invalid dispatcher'); sys.exit(1)
if reply=='legacy-only' and sys.argv[2].startswith('hl.dsp'): print('Invalid dispatcher'); sys.exit(1)
print('ok')
''')
        (self.bin / 'ssh').write_text('''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
remote=args[args.index('--')+2]
os.execvp('sh',['sh','-c',remote])
''')
        for name in ('hyprctl', 'ssh'):
            (self.bin / name).chmod(0o755)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]


class StateTests(unittest.TestCase):
    def test_build_state_keeps_enabled_monitors_and_numbered_workspaces(self):
        current = state()
        self.assertEqual([m['name'] for m in current['monitors']], ['HDMI-A-1', 'DP-2'])
        self.assertEqual(current['monitors'][1]['block'], 2)
        self.assertEqual(current['monitors'][0]['active'], 4)
        self.assertNotIn(-98, [w['id'] for w in current['workspaces']])

    def test_read_blocks_maps_connectors_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'monitor-workspaces'
            path.write_text('0\tHDMI-A-1\tSamsung X\n1\t\tASUS unplugged\n2\tDP-2\tASUS Y\n4\t11\tmerged row\nbad\n')
            self.assertEqual(rd_remote.read_blocks(path), {'HDMI-A-1': 0, 'DP-2': 2})
            self.assertEqual(rd_remote.read_blocks(Path(directory) / 'missing'), {})

    def test_strip_follows_omarchy_blocks(self):
        hdmi = rs.workspace_strip(state(), 'HDMI-A-1')
        self.assertEqual([c['label'] for c in hdmi][:10], [str(n) for n in range(1, 11)])
        self.assertEqual([c['id'] for c in hdmi][:10], list(range(1, 11)))
        self.assertEqual([c['id'] for c in hdmi if c['active']], [4])
        self.assertEqual(next(c for c in hdmi if c['id'] == 6)['windows'], 3)
        # Workspaces from other blocks that live here come after, as guests.
        self.assertEqual([(c['label'], c['guest']) for c in hdmi[10:]], [('13', True), ('24', True)])
        dp = rs.workspace_strip(state(), 'DP-2')
        self.assertEqual([c['id'] for c in dp], list(range(21, 31)))
        self.assertEqual(dp[0]['label'], '1')
        self.assertTrue(dp[0]['active'])
        # 24 is in DP-2's block but lives on HDMI-A-1.
        self.assertTrue(next(c for c in dp if c['id'] == 24)['elsewhere'])

    def test_strip_without_blocks_is_global(self):
        chips = rs.workspace_strip(state(blocks={}), 'DP-2')
        self.assertEqual([c['id'] for c in chips], [2, 3, 5, 21])
        self.assertEqual(rs.workspace_strip(state(), 'NOPE'), [])

    def test_choose_output(self):
        current = state()
        self.assertEqual(rs.choose_output(current), 'HDMI-A-1')
        self.assertEqual(rs.choose_output(current, 'DP-2'), 'DP-2')
        self.assertEqual(rs.choose_output(current, 'GONE'), 'HDMI-A-1')
        self.assertEqual(rs.monitor_label(current['monitors'][1]), 'ASUS 1440p')


class CommandTests(unittest.TestCase):
    class Recorder:
        def __init__(self):
            self.calls = []

        def dispatch(self, kind, value):
            self.calls.append((kind, value))
            return True

    def test_commands_are_validated(self):
        current = state()
        hypr = self.Recorder()
        bad = [{'op': 'workspace', 'id': True}, {'op': 'workspace', 'id': '3'}, {'op': 'workspace', 'id': 0},
               {'op': 'workspace', 'id': 5000}, {'op': 'workspace', 'id': 3, 'monitor': 'X; rm'},
               {'op': 'monitor', 'name': 'DP-9'}, {'op': 'exec', 'cmd': 'id'}, ['workspace']]
        for command in bad:
            self.assertEqual(rd_remote.run_command(hypr, command, current)['t'], 'error', command)
        self.assertEqual(hypr.calls, [])

    def test_new_workspace_on_unfocused_monitor_focuses_monitor_first(self):
        hypr = self.Recorder()
        reply = rd_remote.run_command(hypr, {'op': 'workspace', 'id': 23, 'monitor': 'DP-2'}, state())
        self.assertEqual(reply, {'t': 'done', 'op': 'workspace', 'ok': True})
        self.assertEqual(hypr.calls, [('monitor', 'DP-2'), ('workspace', '23')])
        hypr.calls.clear()
        rd_remote.run_command(hypr, {'op': 'workspace', 'id': 21, 'monitor': 'DP-2'}, state())
        self.assertEqual(hypr.calls, [('workspace', '21')])

    def test_dispatch_prefers_lua_then_remembers_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            fakes = Fakes(directory, hyprctl_reply='legacy-only')
            path = os.environ['PATH']
            os.environ['PATH'] = f'{fakes.bin}:{path}'
            try:
                hypr = rd_remote.Hyprland(Path(directory) / 'sig1')
                self.assertTrue(hypr.dispatch('workspace', '3'))
                self.assertTrue(hypr.dispatch('monitor', 'DP-2'))
            finally:
                os.environ['PATH'] = path
            calls = [c['args'] for c in fakes.calls()]
            self.assertEqual(calls, [['dispatch', 'hl.dsp.focus({ workspace = "3" })'], ['dispatch', 'workspace', '3'],
                                     ['dispatch', 'focusmonitor', 'DP-2']])
            self.assertTrue(all(c['sig'] == 'sig1' for c in fakes.calls()))


class ServeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Short path: Unix socket paths are limited to ~108 bytes.
        self.runtime = Path(self.tmp.name)
        self.hypr = FakeHyprland(self.runtime)
        self.fakes = Fakes(self.tmp.name)
        self.env = dict(os.environ, XDG_RUNTIME_DIR=str(self.runtime), PATH=f'{self.fakes.bin}:{os.environ["PATH"]}',
                        XDG_STATE_HOME=str(self.runtime / 'state'))
        self.env.pop('HYPRLAND_INSTANCE_SIGNATURE', None)
        blocks = self.runtime / 'state/omarchy'
        blocks.mkdir(parents=True)
        (blocks / 'monitor-workspaces').write_text('0\tHDMI-A-1\tS\n2\tDP-2\tA\n')

    def tearDown(self):
        self.hypr.close()
        self.tmp.cleanup()

    def test_channel_bootstraps_over_ssh_streams_state_and_runs_commands(self):
        messages = []
        closed = threading.Event()
        old = dict(os.environ)
        os.environ.clear()
        os.environ.update(self.env)
        try:
            channel = rs.Channel('lol', str(self.fakes.bin / 'ssh'), messages.append,
                                 on_close=lambda *_: closed.set())
        finally:
            os.environ.clear()
            os.environ.update(old)
        first = rs.wait_for(lambda: next((m for m in messages if m['t'] == 'state'), None), 10)
        self.assertIsNotNone(first, messages)
        self.assertEqual([m['block'] for m in first['monitors']], [0, 2])
        rs.wait_for(lambda: self.hypr.event_clients, 5)
        # A workspace change on the remote: a new state arrives.
        self.hypr.monitors[0]['activeWorkspace'] = {'id': 6}
        self.hypr.event('workspacev2>>6,6')
        second = rs.wait_for(lambda: [m for m in messages if m['t'] == 'state' and m['monitors'][0]['active'] == 6], 5)
        self.assertTrue(second, messages)
        # A title change alone does not.
        count = len(messages)
        self.hypr.event('windowtitlev2>>0x1,hello')
        time.sleep(0.3)
        self.assertEqual(len(messages), count)
        channel.workspace(23, 'DP-2')
        done = rs.wait_for(lambda: [m for m in messages if m['t'] == 'done'], 5)
        self.assertTrue(done, messages)
        args = [c['args'] for c in self.fakes.calls()]
        self.assertEqual(args, [['dispatch', 'hl.dsp.focus({ monitor = "DP-2" })'],
                                ['dispatch', 'hl.dsp.focus({ workspace = "23" })']])
        channel.close()
        self.assertTrue(channel.process.poll() is not None)

    def test_read_state_once(self):
        old = dict(os.environ)
        os.environ.clear()
        os.environ.update(self.env)
        try:
            current = rs.read_state_once('lol', str(self.fakes.bin / 'ssh'), timeout=10)
        finally:
            os.environ.clear()
            os.environ.update(old)
        self.assertEqual(current['t'], 'state')
        self.assertEqual(self.fakes.calls(), [])

    def test_no_hyprland(self):
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        out = io.StringIO()
        real = sys.stdout
        sys.stdout = out
        try:
            code = rd_remote.serve(stdin=io.StringIO(''), runtime=empty.name)
        finally:
            sys.stdout = real
        self.assertEqual(code, 3)
        self.assertIn('NO_HYPRLAND', out.getvalue())


class LocalWindowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hypr = FakeHyprland(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.hypr.close)
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        os.environ.pop('HYPRLAND_INSTANCE_SIGNATURE', None)
        # DP-2 at x=1920, 2560 wide at scale 1.25: 2048 logical pixels.
        self.hypr.monitors[1].update(scale=1.25, activeWorkspace={'id': 21})

    def window(self, **fields):
        client = {'class': 'gliff', 'pid': 42, 'mapped': True, 'workspace': {'id': 21},
                  'at': [2020, 40], 'size': [1200, 900], 'fullscreen': 0}
        client.update(fields)
        return client

    def test_rect_is_relative_to_the_monitor_in_logical_pixels(self):
        self.hypr.clients = [self.window()]
        where = rs.local_window(42, self.tmp.name)
        self.assertEqual(where, {'visible': True, 'monitor': 'DP-2', 'rect': (100, 40, 1200, 900), 'monitor_width': 2048})

    def test_fullscreen_spans_the_monitor(self):
        self.hypr.clients = [self.window(fullscreen=2)]
        self.assertEqual(rs.local_window(42, self.tmp.name)['rect'], (0, 0, 2048, 900))

    def test_hidden_workspace_and_pid_namespace_fallback(self):
        self.hypr.clients = [self.window(workspace={'id': 23})]
        self.assertFalse(rs.local_window(42, self.tmp.name)['visible'])
        # A compositor in another PID namespace reports pid 0: the only Gliff window is ours.
        self.hypr.clients = [self.window(pid=0)]
        self.assertEqual(rs.local_window(42, self.tmp.name)['monitor'], 'DP-2')
        self.hypr.clients = [self.window(pid=0), self.window(pid=0, at=[0, 0])]
        self.assertFalse(rs.local_window(42, self.tmp.name)['visible'])

    def test_no_hyprland_keeps_the_bar_visible(self):
        self.hypr.close()
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        self.assertEqual(rs.local_window(42, empty.name)['monitor'], None)
        self.assertTrue(rs.local_window(42, empty.name)['visible'])


class DeviceTests(unittest.TestCase):
    def test_merge_groups_computers_and_hides_this_machine(self):
        destinations = [
            {'id': 'ssh:lol-ts', 'name': 'lol-ts', 'alias': 'lol-ts', 'aliases': ['lol-ts'], 'engine': 'gliff'},
            {'id': 'ssh:lol', 'name': 'lol', 'alias': 'lol', 'aliases': ['lol', 'pc'], 'engine': 'gliff'},
            {'id': 'ssh:notebook', 'name': 'notebook', 'alias': 'notebook', 'aliases': ['notebook'], 'engine': 'gliff'},
            {'id': 'ssh:vps', 'name': 'vps', 'alias': 'vps', 'aliases': ['vps'], 'engine': 'gliff'},
            {'id': 'ssh:casa', 'name': 'PC da sala', 'alias': 'casa', 'aliases': ['casa'], 'engine': 'gliff'},
            {'id': 'ssh:isa', 'name': 'isa', 'alias': 'isa', 'aliases': ['isa'], 'engine': 'gliff'},
        ]
        ponte = [
            {'name': 'notebook-omarchy', 'kind': 'notebook', 'self': True, 'routes': [{'via': 'ssh', 'alias': 'notebook'}]},
            {'name': 'lol', 'kind': 'pc', 'status': 'online', 'routes': [{'via': 'ssh', 'alias': 'lol', 'kind': 'key'},
                                                                         {'via': 'ssh', 'alias': 'lol-ts', 'kind': 'tailscale-ssh'}]},
            {'name': 'Hostinger', 'kind': 'server', 'status': 'online', 'routes': [{'via': 'ssh', 'alias': 'vps'}]},
            {'name': 'PC Isa', 'kind': 'pc', 'status': 'offline', 'routes': [{'via': 'ssh', 'alias': 'isa'}]},
        ]
        computers, others = rs.merge_devices(destinations, ponte)
        self.assertEqual([(c['name'], c['alias'], c['status']) for c in computers],
                         [('lol', 'lol', 'online'), ('PC da sala', 'casa', 'unknown'), ('PC Isa', 'isa', 'offline')])
        # One row per machine: the key route wins over Tailscale SSH, which asks the browser.
        self.assertEqual(computers[0]['also'], ['lol-ts'])
        self.assertEqual([o['name'] for o in others], ['Hostinger'])
        # A name in ssh.hosts does not turn a server Ponte knows into a computer.
        named_vps = [dict(destinations[3], name='Hostinger VPS')]
        self.assertEqual(rs.merge_devices(named_vps, ponte)[0], [])
        self.assertEqual(rs.probe_summary('vps: gliff-server or Hyprland is unavailable. Install upstream gliff'),
                         'sem Gliff ou Hyprland lá')
        # Without Ponte answering, only named aliases count as computers.
        computers, others = rs.merge_devices(destinations, [])
        self.assertEqual([c['alias'] for c in computers], ['casa'])

    def test_prefs_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'p/rd-app.json'
            self.assertEqual(rs.load_prefs(path), {'outputs': {}, 'follow': True, 'last': None})
            rs.save_prefs({'outputs': {'lol': 'DP-2'}, 'follow': False, 'last': 'lol', 'pinned': True}, path)
            self.assertEqual(rs.load_prefs(path)['outputs'], {'lol': 'DP-2'})
            self.assertFalse(rs.load_prefs(path)['follow'])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class GliffTests(unittest.TestCase):
    def test_restart_on_another_screen_reports_only_the_current_window(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'gliff.jsonl'
            fake = Path(directory) / 'gliff'
            fake.write_text(f'''#!/usr/bin/env python3
import json,os,signal,sys,time
with open({str(log)!r},'a') as f: f.write(json.dumps({{'args':sys.argv[1:],'config':os.environ.get('XDG_CONFIG_HOME'),'preload':os.environ.get('LD_PRELOAD'),'alias':os.environ.get('PONTE_RD_ALIAS')}})+'\\n')
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
time.sleep(30)
''')
            fake.chmod(0o755)
            exits = []
            item = {'id': 'ssh:lol', 'name': 'lol', 'alias': 'lol', 'aliases': ['lol']}
            os.environ['LD_PRELOAD'] = ''
            runner = rs.Gliff(item, str(fake), '/usr/bin/ssh', {'video': 'cpu'}, lambda code, detail: exits.append(code))
            runner.start('HDMI-A-1')
            rs.wait_for(lambda: log.exists() and log.read_text().count('\n') >= 1, 5)
            runner.start('DP-2')
            rs.wait_for(lambda: log.read_text().count('\n') >= 2, 5)
            time.sleep(0.3)
            self.assertEqual(exits, [], 'the replaced window must not end the session')
            runner.process.send_signal(15)
            rs.wait_for(lambda: exits, 5)
            self.assertEqual(exits, [0])
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual(calls[0]['args'], ['--server-bin', 'gliff-server', '--output', 'HDMI-A-1', '--video', 'cpu', '--', 'lol'])
            self.assertEqual(calls[1]['args'][3], 'DP-2')
            self.assertNotEqual(calls[0]['config'], calls[1]['config'])
            self.assertTrue(all(c['preload'] is None and c['alias'] == 'lol' for c in calls))
            runner.stop()


if __name__ == '__main__':
    unittest.main()

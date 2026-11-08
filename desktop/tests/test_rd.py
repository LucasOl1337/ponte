import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from desktop import rd


def options(**overrides):
    values = dict(engine=None, device='notebook', monitor=None, headless=False,
                  no_clipboard=False, video=None, server_bin='gliff-server',
                  check=False, list=False, print_url=False)
    return SimpleNamespace(**(values | overrides))


def result(stdout='', code=0, stderr=''):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class RemoteDesktopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / '.ssh').mkdir()
        (self.home / '.ssh/config').write_text('Host notebook notebook-omarchy\n HostName notebook.example\nInclude config.d/*\nHost *\n ServerAliveInterval 15\nHost bad* !blocked\nHost -oProxyCommand=x user@host semi;colon\n')
        (self.home / '.ssh/config.d').mkdir()
        (self.home / '.ssh/config.d/extra').write_text('Host desktop\nInclude config\n')
        self.config = self.home / 'ponte.json'
        self.config.write_text(json.dumps({'ssh': {'hosts': [{'host': 'notebook', 'label': 'Meu notebook'}]}}))
        self.items = rd.destinations(self.config, self.home)

    def test_discovery_includes_cycle_dedup_patterns_and_labels(self):
        self.assertEqual([i['alias'] for i in self.items], ['notebook', 'desktop'])
        self.assertEqual(self.items[0]['name'], 'Meu notebook')
        self.assertEqual(rd.resolve(self.items, 'meu NOTEBOOK')['alias'], 'notebook')
        self.assertEqual(rd.resolve(self.items, 'ssh:notebook-omarchy')['alias'], 'notebook-omarchy')

    def test_unknown_and_injected_destination_never_runs(self):
        with patch('desktop.rd.subprocess.run') as run:
            with self.assertRaisesRegex(ValueError, 'Unknown SSH device'):
                rd.resolve(self.items, 'notebook;touch /tmp/no')
            run.assert_not_called()

    def test_ambiguous_name_requires_alias(self):
        with self.assertRaisesRegex(ValueError, 'More than one'):
            rd.resolve([self.items[0], {**self.items[1], 'name': 'Meu notebook'}], 'Meu notebook')

    def test_invalid_config_host_rejected(self):
        self.config.write_text(json.dumps({'ssh': {'hosts': ['-oProxyCommand=bad']}}))
        with self.assertRaisesRegex(ValueError, 'Invalid SSH alias'):
            rd.destinations(self.config, self.home)

    def test_no_config_or_ssh_is_empty(self):
        self.assertEqual(rd.destinations(self.home / 'missing', self.home / 'empty'), [])

    def test_cli_command_is_argument_vector(self):
        argv = rd.command('/usr/bin/gliff', self.items[0], options(monitor='DP-3', no_clipboard=True, video='cpu'))
        self.assertEqual(argv, ['/usr/bin/gliff', '--server-bin', 'gliff-server', '--output', 'DP-3', '--no-clipboard', '--video', 'cpu', '--', 'notebook'])
        self.assertIn('--headless', rd.command('gliff', self.items[0], options(headless=True)))

    def test_conflicting_and_unsafe_options(self):
        with self.assertRaisesRegex(ValueError, 'mutually exclusive'):
            rd.validate_options(options(headless=True, monitor='DP-1'))
        with self.assertRaisesRegex(ValueError, 'Invalid monitor'):
            rd.validate_options(options(monitor='DP-1;id'))
        with self.assertRaisesRegex(ValueError, 'absolute path'):
            rd.validate_options(options(server_bin='/home/me/wrapper;id'))
        rd.validate_options(options(server_bin='/home/me/wrapper'))

    @patch('desktop.rd.shutil.which', side_effect=lambda value: '/usr/bin/' + value)
    def test_preflight_preserves_alias_and_strict_policy(self, which):
        with patch('desktop.rd.checked_run', side_effect=[result('gliff 0.4.1\n'), result('remotecommand none\n'), result('gliff-server 0.4.1\n[{"instance":"test"}]\n')]) as run:
            self.assertEqual(rd.preflight(self.items[0], options()), ('/usr/bin/gliff', '/usr/bin/ssh'))
        calls = [call.args[0] for call in run.call_args_list]
        self.assertIn('StrictHostKeyChecking=yes', calls[1])
        self.assertIn('BatchMode=yes', calls[2])
        self.assertEqual(calls[2][-3:], ['--', 'notebook', 'gliff-server --version && hyprctl instances -j'])

    @patch('desktop.rd.shutil.which', side_effect=lambda value: '/usr/bin/' + value)
    def test_wrapper_preflight_does_not_probe_human_hyprland(self, which):
        with patch('desktop.rd.checked_run', side_effect=[result('gliff 0.4.1\n'), result('remotecommand none\n'), result('gliff-server 0.4.1\n')]) as run:
            rd.preflight(self.items[0], options(server_bin='/home/me/isolated-wrapper'))
        self.assertEqual(run.call_args.args[0][-1], '/home/me/isolated-wrapper --version')

    @patch('desktop.rd.shutil.which', side_effect=lambda value: '/usr/bin/' + value)
    def test_host_key_failure_is_clear_and_does_not_fallback(self, which):
        with patch('desktop.rd.checked_run', side_effect=[result('gliff 0.4.1\n'), result('remotecommand none\n'), result(code=255, stderr='Host key verification failed')]):
            with self.assertRaisesRegex(ValueError, 'never accepts keys automatically'):
                rd.preflight(self.items[0], options())

    @patch('desktop.rd.shutil.which', side_effect=lambda value: '/usr/bin/' + value)
    def test_remotecommand_is_rejected_before_connection(self, which):
        with patch('desktop.rd.checked_run', side_effect=[result('gliff 0.4.1\n'), result('remotecommand ssh other\n')]) as run:
            with self.assertRaisesRegex(ValueError, 'RemoteCommand'):
                rd.preflight(self.items[0], options())
        self.assertEqual(run.call_count, 2)

    @patch('desktop.rd.shutil.which', side_effect=lambda value: '/usr/bin/' + value)
    def test_no_hyprland_session_is_clear(self, which):
        with patch('desktop.rd.checked_run', side_effect=[result('gliff 0.4.1\n'), result(''), result('gliff-server 0.4.1\n[]\n')]):
            with self.assertRaisesRegex(ValueError, 'no running Hyprland'):
                rd.preflight(self.items[0], options())

    @patch('desktop.rd.shutil.which', side_effect=lambda value: '/usr/bin/' + value)
    def test_missing_remote_dependency_and_wrong_version(self, which):
        with patch('desktop.rd.checked_run', side_effect=[result('gliff 0.4.1\n'), result(''), result(code=127)]):
            with self.assertRaisesRegex(ValueError, 'gliff-server or Hyprland is unavailable'):
                rd.preflight(self.items[0], options())
        with patch('desktop.rd.checked_run', return_value=result('gliff 0.3.9\n')) as run:
            with self.assertRaisesRegex(ValueError, 'supports Gliff 0.4.x'):
                rd.preflight(self.items[0], options())
            self.assertEqual(run.call_count, 1)
        self.assertIn('authentication failed', rd.ssh_failure('Permission denied (publickey)'))

    def test_missing_dependency_is_clear(self):
        with patch('desktop.rd.shutil.which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'Gliff is not installed'):
                rd.preflight(self.items[0], options())

    def test_timeout_is_bounded(self):
        with patch('desktop.rd.subprocess.run', side_effect=subprocess.TimeoutExpired('ssh', 15)):
            with self.assertRaisesRegex(ValueError, 'timed out'):
                rd.checked_run(['ssh'])

    def test_legacy_and_print_url_are_explicit(self):
        with patch('desktop.rd.destinations') as discovery, patch('desktop.rd.launch') as launch:
            legacy = unittest.mock.Mock()
            rd.open_remote(options(engine='legacy'), self.config, legacy)
            rd.open_remote(options(print_url=True), self.config, legacy)
            self.assertEqual(legacy.call_count, 2)
            discovery.assert_not_called()
            launch.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'web-only'):
                rd.open_remote(options(engine='gliff', print_url=True), self.config, legacy)
            with self.assertRaisesRegex(ValueError, 'Native options'):
                rd.open_remote(options(engine='legacy', headless=True), self.config, legacy)

    def test_check_requires_explicit_device_and_list_is_offline(self):
        with patch('desktop.rd.destinations', return_value=self.items), patch('desktop.rd.launch') as launch, patch('desktop.rd.choose') as choose:
            with self.assertRaisesRegex(ValueError, 'requires a device'):
                rd.open_remote(options(check=True, device=None), self.config, None)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                rd.open_remote(options(list=True, device=None), self.config, None)
            self.assertEqual(len(json.loads(output.getvalue())['devices']), 2)
            launch.assert_not_called()
            choose.assert_not_called()

    def test_picker_cancel_and_legacy_and_opaque_id(self):
        with patch.dict(os.environ, {'DISPLAY': ':99'}), patch('desktop.rd.shutil.which', return_value='/bin/zenity'):
            with patch('desktop.rd.subprocess.run', return_value=result(code=1)):
                self.assertIsNone(rd.choose(self.items))
            with patch('desktop.rd.subprocess.run', return_value=result('legacy\n')):
                self.assertEqual(rd.choose(self.items), 'legacy')
            with patch('desktop.rd.subprocess.run', return_value=result('0\n')) as run:
                self.assertEqual(rd.choose(self.items), self.items[0])
                argv = run.call_args.args[0]
                self.assertIn('--title=Ponte Remoto', argv)
                self.assertLess(argv.index('--'), argv.index('Meu notebook'))
            with patch('desktop.rd.subprocess.run', return_value=result('notebook;id\n')):
                with self.assertRaisesRegex(ValueError, 'Invalid picker'):
                    rd.choose(self.items)

    def test_check_never_launches_or_changes_environment(self):
        with patch('desktop.rd.preflight', return_value=('/bin/gliff', '/bin/ssh')), patch('desktop.rd.subprocess.run') as run, contextlib.redirect_stdout(io.StringIO()) as out:
            rd.launch(self.items[0], options(check=True))
        run.assert_not_called()
        self.assertTrue(json.loads(out.getvalue())['ok'])

    def test_launch_isolates_state_and_surfaces_exit_failure(self):
        def child(argv, **kwargs):
            env = kwargs['env']
            self.assertEqual(env['PONTE_RD_ALIAS'], 'notebook')
            self.assertTrue(env['PATH'].startswith(str(rd.ROOT / 'desktop/rd-bin')))
            self.assertEqual(list(Path(env['XDG_CONFIG_HOME']).glob('gliff*')), [])
            self.session_dir = env['XDG_CONFIG_HOME']
            kwargs['stderr'].write(b'connection lost')
            return result(code=3)
        with patch('desktop.rd.preflight', return_value=('/bin/gliff', '/bin/ssh')), patch('desktop.rd.subprocess.run', side_effect=child), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, 'Gliff exited with code 3: connection lost'):
                rd.launch(self.items[0], options())
        self.assertFalse(Path(self.session_dir).exists())


class SshWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.real = self.root / 'real-ssh'
        self.real.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
        self.real.chmod(0o755)
        self.env = dict(os.environ, PONTE_RD_SSH=str(self.real), PONTE_RD_ALIAS='notebook')
        self.wrapper = rd.ROOT / 'desktop/rd-bin/ssh'

    def invoke(self, args):
        return subprocess.run([str(self.wrapper), *args], env=self.env, text=True, capture_output=True)

    def test_runtime_strict_precedes_upstream_accept_new(self):
        args = ['-T', '-o', 'Compression=no', '-o', 'IPQoS=lowdelay', '-o', 'StrictHostKeyChecking=accept-new', '--', 'notebook', 'gliff-server', '--stdio']
        process = self.invoke(args)
        self.assertEqual(process.returncode, 0, process.stderr)
        argv = json.loads(process.stdout)
        self.assertEqual(argv[:4], ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes'])
        self.assertEqual(argv[-len(args):], args)

    def test_ssh_g_uses_same_policy(self):
        process = self.invoke(['-G', '--', 'notebook'])
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn('StrictHostKeyChecking=yes', json.loads(process.stdout))

    def test_real_ssh_children_do_not_reenter_gliff_shim(self):
        self.real.write_text('#!/usr/bin/env python3\nimport os\nprint(os.environ["PATH"])\n')
        self.env['PATH'] = str(self.wrapper.parent) + os.pathsep + self.env['PATH']
        process = self.invoke(['-G', '--', 'notebook'])
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertNotIn(str(self.wrapper.parent), process.stdout.split(os.pathsep))

    def test_other_destination_or_option_rejected(self):
        process = self.invoke(['-T', '--', 'other', 'gliff-server', '--stdio'])
        self.assertEqual(process.returncode, 255)
        self.assertIn('selected alias', process.stderr)
        process = self.invoke(['-o', 'ProxyCommand=evil', '--', 'notebook'])
        self.assertEqual(process.returncode, 255)
        self.assertIn('Unsupported', process.stderr)


if __name__ == '__main__':
    unittest.main()

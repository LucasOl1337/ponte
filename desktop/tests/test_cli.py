"""Subprocess contract tests. PATH contains only temporary fake Android tools.

These tests never load the real GUI, use the owner's config, or contact a phone.
"""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import select
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SERIAL = '100.64.0.10:5555'
PAIR_ADDRESS = '100.64.0.10:37123'
PAIR_CODE = '918273'
PNG_HEX = ('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
           '0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082')
PNG = bytes.fromhex(PNG_HEX)

# -S also proves that discovery and automation do not require site packages.
# The finder forbids even attempting a UI import in normal CLI commands.
BOOTSTRAP = r'''
import builtins, os, runpy, subprocess, sys
original_import = builtins.__import__
def no_qt_import(name, *args, **kwargs):
    if name == 'PySide6' or name.startswith('PySide6.'):
        raise AssertionError('The CLI imported Qt: ' + name)
    return original_import(name, *args, **kwargs)
builtins.__import__ = no_qt_import
class NoGui:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'PySide6':
            return None  # status may inspect availability without importing Qt.
        if fullname == 'desktop.gui' or fullname.startswith('PySide6.'):
            if os.environ.get('PONTE_TEST_GUI_IMPORT') == 'missing':
                raise ModuleNotFoundError("No module named 'PySide6'", name='PySide6')
            raise AssertionError('CLI must not import GUI: ' + fullname)
sys.meta_path.insert(0, NoGui())
if os.environ.get('PONTE_TEST_GUI_IMPORT') == 'stub':
    import json, types
    gui = types.ModuleType('desktop.gui')
    def fake_gui_main(args):
        print(json.dumps({'schemaVersion': 1, 'ok': True, 'data': {'guiArgs': args}}))
        return 0
    gui.main = fake_gui_main
    sys.modules['desktop.gui'] = gui
original_popen = subprocess.Popen
class StubToolsOnly(original_popen):
    def __init__(self, command, *args, **kwargs):
        if kwargs.get('shell') or not isinstance(command, (tuple, list)) or not command:
            raise AssertionError('Desktop tools must be direct argv, never a shell')
        name = os.path.basename(str(command[0]))
        allowed = os.path.join(os.environ['PATH'], name)
        if name not in ('adb', 'scrcpy') or str(command[0]) not in (name, allowed):
            raise AssertionError('Only temporary fixture tools may run: ' + str(command[0]))
        super().__init__(command, *args, **kwargs)
subprocess.Popen = StubToolsOnly
original_run = subprocess.run
def controlled_run(command, *args, **kwargs):
    if isinstance(command, (tuple, list)) and command and os.path.basename(str(command[0])) == 'adb':
        fault = os.environ.get('PONTE_TEST_FAULT')
        if fault == 'timeout':
            raise subprocess.TimeoutExpired(command, 0.01)
        if fault == 'interrupted':
            raise KeyboardInterrupt()
    return original_run(command, *args, **kwargs)
subprocess.run = controlled_run
sys.argv = ['ponte desktop'] + sys.argv[1:]
runpy.run_module('desktop', run_name='__main__')
'''

FAKE_TOOL = r'''
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
record = {'tool': name, 'argv': args}
if name == 'adb' and args[:1] == ['pair']:
    record['stdin'] = sys.stdin.read()
with open(os.environ['PONTE_TEST_LOG'], 'a') as stream:
    stream.write(json.dumps(record) + '\n')
if name == 'scrcpy':
    if os.environ.get('PONTE_TEST_VIEWER_WAIT'):
        import signal
        def stop_viewer(signum, _frame):
            Path(os.environ['PONTE_TEST_VIEWER_STOP']).write_text(json.dumps({'signal': signum, 'parent': os.getppid()}))
            sys.exit(0)
        signal.signal(signal.SIGTERM, stop_viewer)
        signal.alarm(10)  # Even a broken cleanup cannot leave a fixture running.
        print('FIXTURE_VIEWER_READY', file=sys.stderr, flush=True)
        while True:
            signal.pause()
    if '--version' in args:
        print('scrcpy 3.3.1')
    elif '--help' in args:
        print('--serial --max-size --video-bit-rate --max-fps --no-audio --no-clipboard-autosync --no-control')
    else:
        print('SCRCPY_STDOUT_FIXTURE')
        print('SCRCPY_STDERR_FIXTURE', file=sys.stderr)
    sys.exit(int(os.environ.get('PONTE_TEST_SCRCPY_EXIT', '0')))
if os.environ.get('PONTE_TEST_ADB_FAIL'):
    print('adb: fixture command failed', file=sys.stderr)
    sys.exit(1)
if args == ['devices', '-l']:
    print('List of devices attached')
    print('100.64.0.10:5555\tdevice product:fixture model:Fixture_Phone device:fixture transport_id:1')
    print('usb-phone\tdevice product:fixture model:USB_Phone device:fixture transport_id:2')
    print('unauthorized-phone\tunauthorized usb:1-1 transport_id:3')
    print('offline-phone\toffline transport_id:4')
elif args[:1] == ['connect']:
    print('connected to ' + args[1])
elif args[:1] == ['disconnect']:
    print('disconnected ' + args[1])
elif args[:1] == ['pair']:
    # Deliberately echo the secret to catch accidental forwarding of ADB output.
    print('Successfully paired to ' + args[1] + ' code=' + record['stdin'].strip())
elif len(args) >= 3 and args[0] == '-s':
    if args[2:] == ['get-state']:
        state = os.environ.get('PONTE_TEST_GET_STATE', 'device')
        print(state)
    elif args[2:] == ['exec-out', 'screencap', '-p']:
        sys.stdout.buffer.write(bytes.fromhex(os.environ['PONTE_TEST_PNG']))
    elif args[2:4] == ['shell', 'input'] or (args[2:3] == ['shell'] and len(args) == 4 and args[3].startswith('input ')):
        pass
    else:
        print('unexpected fake adb request: ' + repr(args), file=sys.stderr)
        sys.exit(90)
else:
    print('unexpected fake adb request: ' + repr(args), file=sys.stderr)
    sys.exit(90)
'''


class DesktopCliTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ponte-desktop-cli-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / 'home'
        self.bin = self.base / 'bin'
        self.home.mkdir()
        self.bin.mkdir()
        self.log = self.base / 'commands.jsonl'
        # Do not inherit PONTE_CONFIG, a real ADB server socket, DISPLAY, or PATH.
        self.env = {
            'HOME': str(self.home),
            'XDG_CONFIG_HOME': str(self.home / 'config'),
            'XDG_STATE_HOME': str(self.home / 'state'),
            'XDG_DATA_HOME': str(self.home / 'data'),
            'XDG_CACHE_HOME': str(self.home / 'cache'),
            'PATH': str(self.bin),
            'PONTE_TEST_LOG': str(self.log),
            'PONTE_TEST_PNG': PNG_HEX,
            'PYTHONDONTWRITEBYTECODE': '1',
            'LC_ALL': 'C.UTF-8',
        }
        for name in ('adb', 'scrcpy'):
            executable = self.bin / name
            executable.write_text('#!' + sys.executable + '\n' + textwrap.dedent(FAKE_TOOL))
            executable.chmod(0o700)
        (self.bin / 'python3').symlink_to(sys.executable)
        self.launcher = self.home / 'data/applications/ponte-desktop.desktop'
        self.preferences = self.home / 'state/ponte/desktop.json'

    def invoke(self, *arguments, stdin='', expected=0, extra_env=None, dispatch=False):
        command = ([sys.executable, '-S', str(ROOT / 'ponte'), 'desktop'] if dispatch else
                   [sys.executable, '-S', '-c', BOOTSTRAP])
        result = subprocess.run(
            command + list(arguments), cwd=ROOT, env={**self.env, **(extra_env or {})},
            input=stdin, text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertNotIn('Traceback (most recent call last)', result.stderr)
        return result

    def cli(self, *arguments, **options):
        result = self.invoke(*arguments, '--json', **options)
        try:
            value = json.loads(result.stdout)
        except ValueError:
            self.fail('Expected one JSON envelope, got: ' + result.stdout + result.stderr)
        self.assertEqual(value.get('schemaVersion'), 1)
        self.assertIs(value.get('ok'), result.returncode == 0)
        if result.returncode == 0:
            self.assertIn('data', value)
            self.assertNotIn('error', value)
            return value['data'], result
        self.assertNotIn('data', value)
        self.assertIsInstance(value.get('error'), dict)
        self.assertIsInstance(value['error'].get('code'), str)
        self.assertTrue(value['error']['code'])
        self.assertIsInstance(value['error'].get('message'), str)
        self.assertTrue(value['error']['message'])
        return value['error'], result

    def calls(self, tool=None):
        rows = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return [row for row in rows if tool is None or row['tool'] == tool]

    def clear_calls(self):
        self.log.unlink(missing_ok=True)

    def assert_no_control(self):
        for call in self.calls():
            self.assertEqual(call['tool'], 'adb', call)
            args = call['argv']
            self.assertTrue(args == ['devices', '-l'] or
                            (len(args) == 3 and args[0] == '-s' and args[2] == 'get-state'), call)

    def test_discovery_is_offline_and_does_not_import_qt(self):
        for command in ('help', 'schema', 'version'):
            with self.subTest(command=command):
                self.cli(command)
        for arguments in (('--help',), ('help', '--schema'), ('--schema',), ('--version',)):
            with self.subTest(arguments=arguments):
                self.invoke(*arguments)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.preferences.exists())

    def test_version_and_schema_are_machine_discoverable(self):
        data, _ = self.cli('version')
        self.assertEqual(data['version'], json.loads((ROOT / 'package.json').read_text())['version'])
        self.assertEqual(data['name'], 'Ponte Desktop')
        self.assertEqual(data['cliSchemaVersion'], 1)
        schema, _ = self.cli('schema')
        commands = {item['name'] for item in schema['commands']}
        self.assertTrue({'status', 'devices', 'connect', 'pair', 'select', 'disconnect',
                         'mirror', 'key', 'tap', 'swipe', 'text', 'screenshot',
                         'preferences', 'install', 'uninstall'}.issubset(commands))
        self.assertIn('exitCodes', schema)
        self.assertEqual(self.calls(), [])

    def test_root_launcher_dispatch_and_pretty_flags(self):
        expected, _ = self.cli('version')
        for args in (('version', '--pretty'), ('--pretty', 'version')):
            with self.subTest(args=args):
                data, result = self.cli(*args, dispatch=True)
                self.assertEqual(data, expected)
                self.assertIn('\n ', result.stdout)
        before_command = self.invoke('--json', '--pretty', 'version', dispatch=True)
        self.assertEqual(json.loads(before_command.stdout)['data'], expected)
        self.assertEqual(self.calls(), [])

    def test_duplicate_and_unknown_global_options_fail_before_adb(self):
        for args in (('--json', 'devices'), ('--pretty', 'devices', '--pretty'),
                     ('devices', '--unknown'), ('connect', SERIAL, '--unknown')):
            with self.subTest(args=args):
                # cli appends --json, making the first case an actual duplicate.
                self.cli(*args, expected=2)
        self.assertEqual(self.calls(), [])

    def test_duplicate_target_and_abbreviated_flags_fail_before_adb(self):
        cases = [
            ('mirror', '--serial', SERIAL, '--serial', 'usb-phone', '--dry-run'),
            ('mirror', '--serial=' + SERIAL, '--serial=usb-phone', '--dry-run'),
            ('--serial', SERIAL, 'mirror', '--serial', 'usb-phone', '--dry-run'),
            ('mirror', '--ser', SERIAL, '--dry-run'),
            ('key', '--serial', SERIAL, '--ke', 'HOME'),
            ('mirror', '--serial', SERIAL, '--dry'),
        ]
        for args in cases:
            with self.subTest(args=args):
                self.cli(*args, expected=2)
        self.assertEqual(self.calls(), [])

    def test_status_and_devices_only_query_adb(self):
        data, _ = self.cli('devices')
        devices = {row['serial']: row for row in data['devices']}
        self.assertEqual(devices[SERIAL]['state'], 'device')
        self.assertEqual(devices['usb-phone']['state'], 'device')
        self.assertEqual(devices['unauthorized-phone']['state'], 'unauthorized')
        self.assertEqual(devices['offline-phone']['state'], 'offline')
        self.assertIn('model', devices[SERIAL])
        self.cli('status')
        self.assertIn(['devices', '-l'], [call['argv'] for call in self.calls('adb')])
        self.assert_no_control()

    def test_saved_selection_never_supplies_an_implicit_action_target(self):
        self.cli('select', 'usb-phone')
        self.clear_calls()
        for args in (('mirror', '--dry-run'), ('key', '--key', 'HOME'),
                     ('tap', '--x', '1', '--y', '2'), ('disconnect',)):
            with self.subTest(args=args):
                self.cli(*args, expected=2)
        self.assertEqual(self.calls(), [])

    def test_connect_verifies_exact_transport_before_persisting(self):
        self.cli('connect', SERIAL)
        calls = [row['argv'] for row in self.calls('adb')]
        self.assertIn(['connect', SERIAL], calls)
        self.assertIn(['-s', SERIAL, 'get-state'], calls)
        self.assertLess(calls.index(['connect', SERIAL]), calls.index(['-s', SERIAL, 'get-state']))
        self.assertTrue(self.preferences.is_file())
        self.assertIn(SERIAL, self.preferences.read_text())
        self.assertEqual(stat.S_IMODE(self.preferences.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.preferences.parent.stat().st_mode), 0o700)

    def test_failed_connect_never_persists_requested_target(self):
        self.cli('select', 'usb-phone')
        before = self.preferences.read_bytes()
        self.clear_calls()
        self.cli('connect', SERIAL, expected=5, extra_env={'PONTE_TEST_GET_STATE': 'offline'})
        self.assertEqual(self.preferences.read_bytes(), before)
        self.assertIn(['-s', SERIAL, 'get-state'], [row['argv'] for row in self.calls('adb')])

    def test_pairing_secret_uses_stdin_and_is_never_returned_or_saved(self):
        _, result = self.cli('pair', PAIR_ADDRESS, '--stdin', stdin=PAIR_CODE + '\n')
        pair = [row for row in self.calls('adb') if row['argv'][:1] == ['pair']]
        self.assertEqual(len(pair), 1)
        self.assertEqual(pair[0]['argv'], ['pair', PAIR_ADDRESS])
        self.assertEqual(pair[0]['stdin'].strip(), PAIR_CODE)
        self.assertNotIn(PAIR_CODE, result.stdout + result.stderr)
        for file in self.home.rglob('*'):
            if file.is_file():
                self.assertNotIn(PAIR_CODE.encode(), file.read_bytes(), str(file))
        self.assertFalse(any(row['argv'][:1] == ['connect'] for row in self.calls('adb')))

    def test_pair_rejects_argv_secret_or_missing_stdin_flag(self):
        for args in (('pair', PAIR_ADDRESS, PAIR_CODE), ('pair', PAIR_ADDRESS)):
            with self.subTest(args=args):
                _, result = self.cli(*args, expected=2)
                self.assertNotIn(PAIR_CODE, result.stdout + result.stderr)
        self.assertEqual(self.calls(), [])

    def test_select_and_disconnect_do_not_fall_back_to_another_phone(self):
        self.cli('select', 'usb-phone')
        self.assertIn('usb-phone', self.preferences.read_text())
        self.clear_calls()
        self.cli('disconnect', SERIAL)
        self.assertIn(['disconnect', SERIAL], [row['argv'] for row in self.calls('adb')])
        self.assertFalse(any(row['argv'] == ['disconnect'] for row in self.calls('adb')))
        for serial in ('unauthorized-phone', 'offline-phone', 'not-connected'):
            with self.subTest(serial=serial):
                self.cli('select', serial, expected=5)
        self.assertIn('usb-phone', self.preferences.read_text())

    def test_mirror_dry_run_returns_argv_and_never_starts_scrcpy(self):
        for profile in ('light', 'balanced', 'sharp'):
            with self.subTest(profile=profile):
                self.clear_calls()
                data, _ = self.cli('mirror', '--serial', SERIAL, '--profile', profile, '--dry-run')
                command = data['command']
                self.assertIsInstance(command, list)
                self.assertTrue(all(isinstance(arg, str) for arg in command))
                self.assertEqual(Path(command[0]).name, 'scrcpy')
                self.assertTrue(('--serial' in command and command[command.index('--serial') + 1] == SERIAL)
                                or '--serial=' + SERIAL in command)
                self.assertIn('--no-audio', command)
                self.assertIn('--no-clipboard-autosync', command)
                self.assert_no_control()
        data, _ = self.cli('mirror', '--serial', SERIAL, '--profile', 'balanced',
                           '--audio', '--clipboard', '--read-only', '--dry-run')
        self.assertNotIn('--no-audio', data['command'])
        self.assertIn('--no-control', data['command'])
        self.assert_no_control()

    def test_mirror_requires_online_exact_serial_even_for_dry_run(self):
        for serial in ('unauthorized-phone', 'offline-phone', 'not-connected'):
            with self.subTest(serial=serial):
                self.cli('mirror', '--serial', serial, '--dry-run', expected=5)
        self.assert_no_control()
        self.assertEqual(self.calls('scrcpy'), [])

    def test_mirror_child_logs_do_not_corrupt_json(self):
        dry_run, _ = self.cli('mirror', '--serial', SERIAL, '--dry-run')
        self.clear_calls()
        _, result = self.cli('mirror', '--serial', SERIAL)
        viewers = [row for row in self.calls('scrcpy') if '--version' not in row['argv'] and '--help' not in row['argv']]
        self.assertEqual(len(viewers), 1)
        self.assertEqual(viewers[0]['argv'], dry_run['command'][1:])
        self.assertIn('SCRCPY_STDOUT_FIXTURE', result.stderr)
        self.assertIn('SCRCPY_STDERR_FIXTURE', result.stderr)
        self.assertNotIn('SCRCPY_', result.stdout)
        self.cli('mirror', '--serial', SERIAL, expected=6, extra_env={'PONTE_TEST_SCRCPY_EXIT': '1'})

    def test_mirror_sigint_stops_its_fake_child_and_returns_json(self):
        stopped = self.base / 'viewer-stopped.json'
        environment = {**self.env, 'PONTE_TEST_VIEWER_WAIT': '1', 'PONTE_TEST_VIEWER_STOP': str(stopped)}
        process = subprocess.Popen(
            [sys.executable, '-S', '-c', BOOTSTRAP, 'mirror', '--serial', SERIAL, '--json'],
            cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            ready, _, _ = select.select([process.stderr], [], [], 5)
            self.assertTrue(ready, 'Fake viewer did not become ready')
            self.assertEqual(process.stderr.readline().strip(), 'FIXTURE_VIEWER_READY')
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate(timeout=8)
            self.assertEqual(process.returncode, 130, stdout + stderr)
            envelope = json.loads(stdout)
            self.assertEqual(envelope['schemaVersion'], 1)
            self.assertIs(envelope['ok'], False)
            self.assertEqual(envelope['error']['code'], 'INTERRUPTED')
            self.assertNotIn('Traceback', stderr)
            self.assertEqual(json.loads(stopped.read_text()), {'signal': signal.SIGTERM, 'parent': process.pid})
            self.assertEqual(len(self.calls('scrcpy')), 1)
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=3)

    def test_mirror_cleanup_races_restore_handlers_and_only_stop_own_child(self):
        from desktop import __main__ as entrypoint
        for race in ('terminate', 'kill', 'kill-after-timeout'):
            with self.subTest(race=race):
                child = mock.Mock()
                child.poll.return_value = None
                if race == 'terminate':
                    child.wait.side_effect = [KeyboardInterrupt()]
                    child.terminate.side_effect = ProcessLookupError()
                else:
                    child.wait.side_effect = [KeyboardInterrupt(), subprocess.TimeoutExpired(['scrcpy'], 3), 0]
                    if race == 'kill':
                        child.kill.side_effect = ProcessLookupError()
                original = {signal.SIGINT: object(), signal.SIGTERM: object()}
                with mock.patch.object(entrypoint.subprocess, 'Popen', return_value=child) as launch, \
                     mock.patch.object(entrypoint.signal, 'signal', side_effect=lambda sig, _handler: original[sig]) as handlers:
                    with self.assertRaises(KeyboardInterrupt):
                        entrypoint.run_mirror(['scrcpy', '--serial', SERIAL])
                launch.assert_called_once_with(['scrcpy', '--serial', SERIAL], stdin=subprocess.DEVNULL,
                                               stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
                child.terminate.assert_called_once_with()
                if race == 'terminate':
                    child.kill.assert_not_called()
                else:
                    child.kill.assert_called_once_with()
                    self.assertIn(mock.call(timeout=3), child.wait.call_args_list)
                self.assertEqual(handlers.call_args_list[-2:], [mock.call(sig, handler) for sig, handler in original.items()])
        self.assertEqual(self.calls(), [])

    def test_named_keys_use_only_explicit_selected_serial(self):
        keys = {'HOME': 3, 'BACK': 4, 'APP_SWITCH': 187, 'POWER': 26,
                'VOLUME_UP': 24, 'VOLUME_DOWN': 25, 'MUTE': 164, 'WAKEUP': 224}
        for key, number in keys.items():
            with self.subTest(key=key):
                self.clear_calls()
                self.cli('key', '--serial', 'usb-phone', '--key', key)
                actions = [row['argv'] for row in self.calls('adb') if 'shell' in row['argv']]
                self.assertEqual(len(actions), 1)
                self.assertEqual(actions[0][:3], ['-s', 'usb-phone', 'shell'])
                self.assertIn('input keyevent ' + str(number), ' '.join(actions[0][3:]))

    def test_tap_swipe_and_stdin_text_are_exactly_targeted(self):
        cases = [
            (('tap', '--serial', SERIAL, '--x', '12', '--y', '34'), 'input tap 12 34', ''),
            (('swipe', '--serial', SERIAL, '--x1', '1', '--y1', '2', '--x2', '3', '--y2', '4'),
             'input swipe 1 2 3 4 300', ''),
            (('swipe', '--serial', SERIAL, '--x1', '5', '--y1', '6', '--x2', '7', '--y2', '8', '--duration', '450'),
             'input swipe 5 6 7 8 450', ''),
            (('text', '--serial', SERIAL, '--stdin'), 'input text', 'fixture text'),
        ]
        for args, expected, stdin in cases:
            with self.subTest(args=args):
                self.clear_calls()
                self.cli(*args, stdin=stdin)
                actions = [row['argv'] for row in self.calls('adb') if 'shell' in row['argv']]
                self.assertEqual(len(actions), 1)
                self.assertEqual(actions[0][:3], ['-s', SERIAL, 'shell'])
                self.assertIn(expected, ' '.join(actions[0][3:]))
                if stdin:
                    self.assertIn('fixture', ' '.join(actions[0][3:]))
                    self.assertIn('text', ' '.join(actions[0][3:]))

    def test_screenshot_is_private_exclusive_and_explicitly_targeted(self):
        output = self.base / 'screen shot.png'
        self.cli('screenshot', '--serial', SERIAL, '--output', str(output))
        self.assertEqual(output.read_bytes(), PNG)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertIn(['-s', SERIAL, 'exec-out', 'screencap', '-p'], [row['argv'] for row in self.calls('adb')])
        self.cli('screenshot', '--serial', SERIAL, '--output', str(output), expected=2)
        self.assertEqual(output.read_bytes(), PNG)
        link = self.base / 'link.png'
        link.symlink_to(output)
        self.cli('screenshot', '--serial', SERIAL, '--output', str(link), expected=2)
        self.assertTrue(link.is_symlink())
        self.assertEqual(output.read_bytes(), PNG)

    def test_preferences_are_private_and_do_not_run_android_tools(self):
        data, _ = self.cli('preferences', '--profile', 'sharp', '--audio', '--clipboard', '--read-only')
        self.assertEqual(data['profile'], 'sharp')
        for key in ('audio', 'clipboard', 'read_only'):
            self.assertIs(data[key], True)
        data, _ = self.cli('preferences', '--profile', 'balanced')
        self.assertEqual(data['profile'], 'balanced')
        for key in ('audio', 'clipboard', 'read_only'):
            self.assertIs(data[key], False)
        self.assertEqual(stat.S_IMODE(self.preferences.stat().st_mode), 0o600)
        self.assertEqual(self.calls(), [])

    def test_read_only_preference_blocks_cli_input(self):
        self.cli('preferences', '--read-only')
        self.cli('key', '--serial', SERIAL, '--key', 'HOME', expected=2)
        self.cli('tap', '--serial', SERIAL, '--x', '1', '--y', '2', expected=2)
        self.assertEqual(self.calls(), [])

    def test_invalid_saved_state_is_reported_without_replacing_it(self):
        self.preferences.parent.mkdir(parents=True, mode=0o700)
        self.preferences.write_text('{not valid json')
        self.preferences.chmod(0o600)
        self.cli('preferences', '--profile', 'balanced', expected=2)
        self.assertEqual(self.preferences.read_text(), '{not valid json')
        self.assertEqual(self.calls(), [])

    def test_filesystem_operation_failures_have_command_exit_code(self):
        from desktop import __main__ as entrypoint
        from desktop.bridge import BridgeError
        cases = [('save_preferences', ['preferences', '--json'], 'persistence_failed'),
                 ('screenshot', ['screenshot', '--serial', SERIAL, '--output', str(self.base / 'shot.png'), '--json'],
                  'screenshot_failed')]
        for method, arguments, code in cases:
            with self.subTest(code=code):
                fake_bridge = mock.Mock()
                getattr(fake_bridge, method).side_effect = BridgeError(code, 'Fixture filesystem failure')
                output = io.StringIO()
                with mock.patch('desktop.bridge.DesktopBridge', return_value=fake_bridge), redirect_stdout(output):
                    self.assertEqual(entrypoint.main(arguments), 6)
                envelope = json.loads(output.getvalue())
                self.assertIs(envelope['ok'], False)
                self.assertEqual(envelope['error']['code'], code.upper())
        self.assertEqual(self.calls(), [])

    def test_usage_and_validation_errors_are_json_exit_two(self):
        invalid = [
            ('unknown-command',), ('connect',), ('connect', '127.0.0.1;whoami'),
            ('key', '--serial', SERIAL, '--key', 'DELETE'),
            ('tap', '--serial', SERIAL, '--x', 'oops', '--y', '2'),
            ('tap', '--serial', SERIAL, '--x', '-1', '--y', '2'),
            ('mirror', '--serial', SERIAL, '--profile', 'ultra', '--dry-run'),
            ('text', '--serial', SERIAL),
        ]
        for args in invalid:
            with self.subTest(args=args):
                self.cli(*args, expected=2)
        self.assert_no_control()

    def test_missing_dependencies_and_command_failure_have_distinct_exits(self):
        (self.bin / 'adb').unlink()
        self.cli('devices', expected=3)
        self.assertEqual(self.calls(), [])
        # Discovery stays usable even with no Android tools on PATH.
        self.cli('schema')

    def test_missing_scrcpy_is_exit_three_without_starting_a_viewer(self):
        (self.bin / 'scrcpy').unlink()
        self.cli('mirror', '--serial', SERIAL, expected=3)
        self.assert_no_control()

    def test_adb_failure_timeout_and_interrupt_are_json(self):
        self.cli('devices', expected=6, extra_env={'PONTE_TEST_ADB_FAIL': '1'})
        for fault, status in (('timeout', 4), ('interrupted', 130)):
            with self.subTest(fault=fault):
                self.cli('devices', expected=status, extra_env={'PONTE_TEST_FAULT': fault})

    def test_missing_qt_is_friendly_without_importing_real_ui(self):
        error, result = self.cli(expected=3, extra_env={'PONTE_TEST_GUI_IMPORT': 'missing'})
        self.assertIn('pyside6', (error['message'] + result.stderr).lower())
        self.assertEqual(self.calls(), [])

    def test_default_gui_and_demo_are_forwarded_without_adb(self):
        cases = [((), []), (('gui',), []), (('--demo',), ['--demo']),
                 (('gui', '--demo'), ['--demo']),
                 (('gui', '--demo', '--serial', 'usb-phone'), ['--demo', '--serial', 'usb-phone'])]
        for args, expected in cases:
            with self.subTest(args=args):
                data, _ = self.cli(*args, extra_env={'PONTE_TEST_GUI_IMPORT': 'stub', 'QT_QPA_PLATFORM': 'offscreen'})
                self.assertEqual(data['guiArgs'], expected)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.preferences.exists())

    def test_no_display_returns_friendly_error_before_starting_gui_stub(self):
        error, _ = self.cli(expected=3, extra_env={'PONTE_TEST_GUI_IMPORT': 'stub'})
        self.assertEqual(error['code'], 'DISPLAY_UNAVAILABLE')
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.preferences.exists())

    def test_install_and_uninstall_are_idempotent_without_starting_gui(self):
        self.cli('preferences', '--profile', 'balanced')
        saved = self.preferences.read_bytes()
        first, _ = self.cli('install')
        self.assertTrue(first['changed'])
        content = self.launcher.read_text()
        self.assertIn('[Desktop Entry]', content)
        self.assertIn('Name=Ponte Desktop', content)
        self.assertIn('Exec="' + str(ROOT / 'ponte') + '" desktop\n', content)
        self.assertNotIn('sh -c', content)
        self.assertIn('Terminal=false', content)
        self.assertEqual(stat.S_IMODE(self.launcher.stat().st_mode), 0o644)
        before = self.launcher.stat().st_mtime_ns
        again, _ = self.cli('install')
        self.assertFalse(again['changed'])
        self.assertEqual(self.launcher.read_text(), content)
        self.assertEqual(self.launcher.stat().st_mtime_ns, before)
        first, _ = self.cli('uninstall')
        self.assertTrue(first['changed'])
        self.assertFalse(self.launcher.exists())
        again, _ = self.cli('uninstall')
        self.assertFalse(again['changed'])
        self.assertEqual(self.preferences.read_bytes(), saved)
        self.assertEqual(self.calls(), [])

    def test_install_and_uninstall_preserve_custom_files_and_symlinks(self):
        self.launcher.parent.mkdir(parents=True)
        custom = '[Desktop Entry]\nName=My launcher\nExec=custom\n'
        self.launcher.write_text(custom)
        for command in ('install', 'uninstall'):
            with self.subTest(command=command, kind='custom'):
                self.cli(command, expected=2)
                self.assertEqual(self.launcher.read_text(), custom)
        self.launcher.unlink()
        target = self.base / 'untouched.desktop'
        target.write_text(custom)
        self.launcher.symlink_to(target)
        for command in ('install', 'uninstall'):
            with self.subTest(command=command, kind='symlink'):
                self.cli(command, expected=2)
                self.assertTrue(self.launcher.is_symlink())
                self.assertEqual(target.read_text(), custom)
        self.assertEqual(self.calls(), [])

    def test_install_and_uninstall_reject_symlinked_parent_directories(self):
        # A valid managed marker is important: uninstall must reject the path,
        # not merely decline to remove an unrelated desktop entry.
        content = '# Managed by Ponte Desktop\n[Desktop Entry]\nName=Keep me\n'
        for kind in ('xdg-home', 'xdg-ancestor', 'applications'):
            with self.subTest(kind=kind):
                fixture = self.base / kind
                fixture.mkdir()
                real = fixture / 'real'
                real.mkdir()
                if kind == 'applications':
                    xdg = fixture / 'data'
                    xdg.mkdir()
                    link = xdg / 'applications'
                    link.symlink_to(real, target_is_directory=True)
                    target = real / 'ponte-desktop.desktop'
                else:
                    link = fixture / 'linked'
                    link.symlink_to(real, target_is_directory=True)
                    xdg = link if kind == 'xdg-home' else link / 'nested/data'
                    target = real / ('applications/ponte-desktop.desktop' if kind == 'xdg-home'
                                     else 'nested/data/applications/ponte-desktop.desktop')
                    target.parent.mkdir(parents=True)
                target.write_text(content)
                for command in ('install', 'uninstall'):
                    self.cli(command, expected=2, extra_env={'XDG_DATA_HOME': str(xdg)})
                    self.assertTrue(link.is_symlink())
                    self.assertEqual(target.read_text(), content)
                    self.assertEqual(list(target.parent.iterdir()), [target])
        self.assertEqual(self.calls(), [])

    def test_install_quotes_repository_path_with_spaces_without_shell_wrapper(self):
        # Exercise generation in a fresh process without copying or editing source.
        repository = self.base / 'Ponte with spaces'
        script = ('import sys; from desktop.install import install; '
                  'install(root=sys.argv[1]); print("ok")')
        result = subprocess.run([sys.executable, '-S', '-c', script, str(repository)],
                                cwd=ROOT, env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        content = self.launcher.read_text()
        self.assertIn('Exec="' + str(repository / 'ponte') + '" desktop\n', content)
        self.assertNotIn('sh -c', content)
        self.assertEqual(self.calls(), [])

    def test_launcher_rejects_percent_path_instead_of_installing_invalid_exec(self):
        from desktop.install import entry
        with self.assertRaises(ValueError):
            entry(self.base / 'Ponte%checkout')
        self.assertFalse(self.launcher.exists())
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()

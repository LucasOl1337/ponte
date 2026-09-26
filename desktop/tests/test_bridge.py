"""Contract tests using only temporary files and strict fake subprocess runners."""

import base64
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from desktop.bridge import BridgeError, DesktopBridge, schema


ADDRESS = "100.64.0.10:5555"
OTHER = "100.64.0.11:5555"
USB = "usb-phone"
EMULATOR = "emulator-5554"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="
)
LISTING = (
    "List of devices attached\n"
    f"{OTHER}\tdevice product:other model:Other_Phone transport_id:1\n"
    f"{ADDRESS}\tdevice product:phone model:Pixel_8 device:phone transport_id:2\n"
    f"{USB}\tdevice usb:1-2 product:phone model:USB_Phone transport_id:3\n"
    f"{EMULATOR}\tdevice product:sdk model:sdk_gphone64 device:emu transport_id:4\n"
    "unauthorized-phone\tunauthorized usb:1-3 transport_id:5\n"
    "offline-phone\toffline transport_id:6\n"
    "no-permission\tno permissions (user is not in the plugdev group)\n\n"
).encode()


class FakeRunner:
    """Unexpected calls fail the test instead of ever reaching a real executable."""

    def __init__(self, listing=LISTING):
        self.listing = listing
        self.calls = []
        self.responses = {}

    def __call__(self, argv, **kwargs):
        self.calls.append((list(argv), dict(kwargs)))
        if not isinstance(argv, list) or argv[0] != "adb":
            raise AssertionError(f"Unexpected command: {argv!r}")
        if kwargs.get("shell", False) or not kwargs.get("check") or not kwargs.get("capture_output"):
            raise AssertionError("Commands must be checked, captured, shell-free")
        if kwargs.get("text") is not False or not 0 < kwargs.get("timeout", 0) <= 15:
            raise AssertionError("Commands must use bounded timeouts and bytes")
        if "input" not in kwargs and kwargs.get("stdin") != subprocess.DEVNULL:
            raise AssertionError("Commands must not inherit interactive stdin")
        if "env" not in kwargs:
            raise AssertionError("Environment must be explicit")
        key = tuple(argv[1:])
        if key in self.responses:
            response = self.responses[key]
        elif key == ("devices", "-l"):
            response = self.listing
        elif key == ("connect", ADDRESS):
            response = f"connected to {ADDRESS}\n".encode()
        elif key == ("pair", ADDRESS):
            response = f"Enter pairing code: Successfully paired to {ADDRESS} [guid=fixture]\n".encode()
        elif key == ("disconnect", ADDRESS):
            response = f"disconnected {ADDRESS}\n".encode()
        elif len(key) >= 3 and key[:1] == ("-s",) and key[1] in (ADDRESS, OTHER, USB, EMULATOR):
            if key[2:] == ("get-state",):
                response = b"device\n"
            elif key[2:] == ("exec-out", "screencap", "-p"):
                response = PNG
            elif len(key) == 4 and key[2] == "shell" and key[3].startswith("input "):
                response = b""
            else:
                raise AssertionError(f"Unexpected targeted command: {key!r}")
        else:
            raise AssertionError(f"Unexpected command: {key!r}")
        if isinstance(response, Exception):
            raise response
        if isinstance(response, subprocess.CompletedProcess):
            return response
        return subprocess.CompletedProcess(argv, 0, stdout=response, stderr=b"")


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ponte-bridge-", dir=os.environ.get("JCODE_SCRATCH_DIR"))
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {
            "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_STATE_HOME": str(self.root / "state"), "PATH": str(self.root / "fake-bin"),
        }
        self.data = self.root / "state/ponte"
        self.config = self.root / "config/ponte/config.json"
        self.fake = FakeRunner()
        self.bridge = DesktopBridge(self.env, self.fake)
        self.which = patch("desktop.bridge.shutil.which", return_value="/fake/bin/tool")
        self.spec = patch("desktop.bridge.importlib.util.find_spec", return_value=None)
        self.which.start()
        self.spec.start()
        self.addCleanup(self.which.stop)
        self.addCleanup(self.spec.stop)

    def write_json(self, path, value, mode=0o600):
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        path.parent.chmod(0o700)
        path.write_text(json.dumps(value))
        path.chmod(mode)
        return path

    def saved(self):
        return json.loads((self.data / "desktop.json").read_text())

    def assert_error(self, code, function, *args, **kwargs):
        with self.assertRaises(BridgeError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), caught.exception.message)
        return caught.exception

    def argv(self):
        return [call[0] for call in self.fake.calls]

    def test_constructor_and_schema_are_side_effect_free(self):
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.data.exists())
        metadata = schema()
        self.assertEqual(set(metadata["profiles"]), {"light", "balanced", "sharp"})
        self.assertEqual(metadata["limits"]["screenshot_bytes"], 20 * 1024 * 1024)
        json.dumps(metadata)
        metadata["preferences"]["audio"] = True
        self.assertFalse(schema()["preferences"]["audio"])
        with patch("desktop.bridge.subprocess.run") as runner:
            default_runner = DesktopBridge(self.env)
            runner.assert_not_called()
            self.assertIs(default_runner._runner, runner)

    def test_status_devices_and_no_implicit_first_selection(self):
        status = self.bridge.status()
        self.assertEqual(status["dependencies"], {"adb": True, "scrcpy": True, "pyside6": False})
        self.assertIsNone(status["selected"])
        self.assertEqual(status["preferences"], {"profile": "balanced", "audio": False, "clipboard": False, "read_only": False})
        self.assertEqual(status["errors"], [])
        self.assertEqual(status["devices"][1], dict(serial=ADDRESS, state="device", model="Pixel_8"))
        self.assertEqual(status["devices"][-1], dict(serial="no-permission", state="no permissions", model=None))
        self.assertEqual(self.argv(), [["adb", "devices", "-l"]])
        self.assertFalse(self.data.exists())
        status["preferences"]["audio"] = True
        self.assertFalse(self.bridge.status()["preferences"]["audio"])

    def test_status_missing_dependency_never_executes(self):
        with patch("desktop.bridge.shutil.which", return_value=None):
            status = self.bridge.status()
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(status["dependencies"]["adb"])
        self.assertEqual(status["devices"], [])
        self.assertEqual(status["errors"][0]["code"], "dependency_missing")

    def test_status_discovers_pyside_without_importing_it(self):
        with patch("desktop.bridge.importlib.util.find_spec", return_value=object()) as probe:
            status = self.bridge.status()
        probe.assert_called_once_with("PySide6")
        self.assertTrue(status["dependencies"]["pyside6"])

    def test_devices_parsing_empty_daemon_and_rejects_ambiguity(self):
        self.fake.listing = b"* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n"
        self.assertEqual(self.bridge.devices(), [])
        for listing in (b"", b"error secret\n", b"List of devices attached\none-field\n",
                        b"List of devices attached\n--bad device\n", b"List of devices attached\nx unknown\n",
                        b"List of devices attached\nx device\nx unauthorized\n", b"\xff"):
            with self.subTest(listing=listing):
                self.fake.listing = listing
                self.assert_error("invalid_output", self.bridge.devices)
        self.fake.listing = LISTING.decode()
        self.assertEqual(self.bridge.devices()[0]["serial"], OTHER)

    def test_all_target_operations_require_explicit_syntactically_valid_serial(self):
        for serial in (None, "", "-d", "--serial", " usb-phone", "usb-phone\n", "usb;id", "usb/phone", "ü", 1, [], "x" * 256):
            for operation in (
                lambda: self.bridge.select(serial),
                lambda: self.bridge.action(serial, "home", {}),
                lambda: self.bridge.mirror_command(serial),
                lambda: self.bridge.screenshot(serial, self.root / "shot.png"),
            ):
                with self.subTest(serial=serial):
                    self.fake.calls.clear()
                    self.assert_error("invalid_serial", operation)
                    self.assertEqual(self.fake.calls, [])

    def test_exact_match_authorization_blocks_every_targeted_operation(self):
        for serial, code in (("usb", "device_not_found"), (ADDRESS + "0", "device_not_found"),
                             ("unauthorized-phone", "device_not_ready"), ("offline-phone", "device_not_ready"),
                             ("no-permission", "device_not_ready")):
            for operation in (
                lambda: self.bridge.select(serial),
                lambda: self.bridge.action(serial, "home", {}),
                lambda: self.bridge.mirror_command(serial),
                lambda: self.bridge.screenshot(serial, self.root / "shot.png"),
            ):
                with self.subTest(serial=serial):
                    self.fake.calls.clear()
                    self.assert_error(code, operation)
                    self.assertEqual(self.argv(), [["adb", "devices", "-l"]])
                    self.assertFalse((self.root / "shot.png").exists())
        self.assertFalse(self.data.exists())

    def test_select_persists_exact_serial_and_does_not_become_implicit_target(self):
        for serial in (ADDRESS, USB, EMULATOR):
            self.assertEqual(self.bridge.select(serial), serial)
            self.assertEqual(self.saved()["selected"], serial)
            restored = DesktopBridge(self.env, self.fake)
            self.assertEqual(restored.status()["selected"], serial)
            self.assert_error("invalid_serial", restored.action, None, "home", {})
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.data / "desktop.json").stat().st_mode), 0o600)
        self.assertEqual(set(self.saved()), {"selected", "preferences"})

    def test_selected_device_is_revalidated_on_every_operation(self):
        self.bridge.select(USB)
        self.fake.listing = LISTING.replace(b"usb-phone\tdevice", b"usb-phone\tunauthorized")
        self.fake.calls.clear()
        self.assert_error("device_not_ready", self.bridge.action, USB, "home", {})
        self.assertEqual(self.argv(), [["adb", "devices", "-l"]])
        self.assertEqual(self.saved()["selected"], USB)

    def test_connect_verifies_exact_list_and_get_state_before_saving(self):
        self.assertEqual(self.bridge.connect(ADDRESS), ADDRESS)
        self.assertEqual(self.argv(), [["adb", "connect", ADDRESS], ["adb", "devices", "-l"], ["adb", "-s", ADDRESS, "get-state"]])
        self.assertEqual(self.saved()["selected"], ADDRESS)
        self.fake.responses[("connect", ADDRESS)] = f"already connected to {ADDRESS}".encode()
        self.assertEqual(self.bridge.connect(ADDRESS), ADDRESS)

    def test_connect_accepts_only_canonical_private_tailnet_loopback(self):
        valid = ("10.0.0.1:1", "172.16.0.1:65535", "172.31.255.254:5555", "192.168.1.2:12345", "100.127.255.254:5555", "127.0.0.1:5555")
        for address in valid:
            with self.subTest(address=address):
                self.fake.responses[("connect", address)] = f"connected to {address}".encode()
                self.fake.responses[("-s", address, "get-state")] = b"device"
                self.fake.listing = f"List of devices attached\n{address} device\n".encode()
                self.assertEqual(self.bridge.connect(address), address)

    def test_invalid_network_arguments_and_pairing_code_have_no_calls(self):
        invalid = (None, "", 1, "localhost:5555", "[::1]:5555", "8.8.8.8:5555", "169.254.1.1:5555", "0.0.0.0:5555",
                   "224.0.0.1:5555", "172.15.0.1:5555", "172.32.0.1:5555", "100.63.0.1:5555", "100.128.0.1:5555",
                   "192.168.01.2:5555", "192.168.1.2:0", "192.168.1.2:65536", "192.168.1.2:05555", "192.168.1.2:+5555",
                   "192.168.1.2", "192.168.1.2:5555\n", " 192.168.1.2:5555", "192.168.1.2:5555;id", USB, EMULATOR)
        for address in invalid:
            for operation in (lambda: self.bridge.connect(address), lambda: self.bridge.pair(address, "123456"), lambda: self.bridge.disconnect(address)):
                with self.subTest(address=address):
                    self.assert_error("invalid_address", operation)
        for code in (None, 123456, "12345", "1234567", "123 56", "１２３４５６", "123456\n", "$(id)"):
            with self.subTest(code=code):
                self.assert_error("invalid_pairing_code", self.bridge.pair, ADDRESS, code)
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.data.exists())

    def test_failed_connect_never_changes_selection_or_tries_another_transport(self):
        self.bridge.select(USB)
        old = (self.data / "desktop.json").read_bytes()
        scenarios = (
            (f"cannot connect to {ADDRESS}".encode(), LISTING, b"device", "connect_failed", 1),
            (f"connected to {OTHER}".encode(), LISTING, b"device", "connect_failed", 1),
            (f"connected to {ADDRESS}".encode(), LISTING.replace(ADDRESS.encode(), b"unrelated"), b"device", "device_not_found", 2),
            (f"connected to {ADDRESS}".encode(), LISTING.replace(f"{ADDRESS}\tdevice".encode(), f"{ADDRESS}\tunauthorized".encode()), b"device", "device_not_ready", 2),
            (f"connected to {ADDRESS}".encode(), LISTING, b"offline", "device_not_ready", 3),
            (f"connected to {ADDRESS}".encode(), LISTING, b"device\nother", "device_not_ready", 3),
        )
        for output, listing, state, code, count in scenarios:
            with self.subTest(code=code, count=count):
                self.fake.calls.clear()
                self.fake.responses[("connect", ADDRESS)] = output
                self.fake.responses[("-s", ADDRESS, "get-state")] = state
                self.fake.listing = listing
                self.assert_error(code, self.bridge.connect, ADDRESS)
                self.assertEqual(len(self.fake.calls), count)
                self.assertEqual((self.data / "desktop.json").read_bytes(), old)
                self.assertFalse(any("tcpip" in arg or "ensure" in arg for argv in self.argv() for arg in argv))

    def test_pair_stdin_only_no_auto_connect_or_persistence(self):
        self.assertIsNone(self.bridge.pair(ADDRESS, "928431"))
        self.assertEqual(self.argv(), [["adb", "pair", ADDRESS]])
        options = self.fake.calls[0][1]
        self.assertEqual(options["input"], b"928431\n")
        self.assertEqual(options["timeout"], 15)
        self.assertNotIn("stdin", options)
        self.assertNotIn("928431", repr(self.argv()))
        self.assertFalse(self.data.exists())
        self.fake.responses[("pair", ADDRESS)] = b"wrong pairing code 928431 secret"
        error = self.assert_error("pair_failed", self.bridge.pair, ADDRESS, "928431")
        self.assertNotIn("928431", repr(error))
        self.assertNotIn("secret", str(error))

    def test_pair_wrong_endpoint_confirmation_is_refused(self):
        self.fake.responses[("pair", ADDRESS)] = f"Successfully paired to {ADDRESS}0".encode()
        self.assert_error("pair_failed", self.bridge.pair, ADDRESS, "123456")
        self.assertFalse(self.data.exists())

    def test_connect_and_pair_timeouts_preserve_state_without_secret_in_errors(self):
        self.bridge.select(USB)
        before = (self.data / "desktop.json").read_bytes()
        for kind in ("connect", "pair"):
            self.fake.calls.clear()
            self.fake.responses[(kind, ADDRESS)] = subprocess.TimeoutExpired(
                ["adb", kind, ADDRESS], 15, output=b"sensitive 927413", stderr=b"927413")
            operation = (lambda: self.bridge.connect(ADDRESS)) if kind == "connect" else (lambda: self.bridge.pair(ADDRESS, "927413"))
            error = self.assert_error("timeout", operation)
            self.assertNotIn("927413", str(error))
            self.assertEqual(len(self.fake.calls), 1)
            self.assertEqual((self.data / "desktop.json").read_bytes(), before)
            self.assertNotIn("927413", repr(self.argv()))

    def test_disconnect_exact_network_and_saved_null_prevents_fallback(self):
        self.write_json(self.config, {"schemaVersion": 1, "phone": {"address": ADDRESS}})
        self.bridge = DesktopBridge(self.env, self.fake)
        self.fake.calls.clear()
        self.assertIsNone(self.bridge.disconnect(ADDRESS))
        self.assertEqual(self.argv(), [["adb", "devices", "-l"], ["adb", "disconnect", ADDRESS]])
        self.assertIsNone(self.saved()["selected"])
        self.assertIsNone(DesktopBridge(self.env, self.fake).status()["selected"])
        self.assertEqual(json.loads(self.config.read_text())["phone"]["address"], ADDRESS)

    def test_disconnect_unauthorized_network_does_not_call_disconnect(self):
        self.fake.listing = LISTING.replace(f"{ADDRESS}\tdevice".encode(), f"{ADDRESS}\toffline".encode())
        self.assert_error("device_not_ready", self.bridge.disconnect, ADDRESS)
        self.assertEqual(self.argv(), [["adb", "devices", "-l"]])

    def test_disconnect_other_does_not_clear_saved_selection(self):
        self.bridge.select(USB)
        self.bridge.disconnect(ADDRESS)
        self.assertEqual(self.saved()["selected"], USB)

    def test_disconnect_zero_exit_failure_preserves_saved_selection(self):
        self.bridge.select(ADDRESS)
        for output in (b"error: no such device", f"disconnected {OTHER}".encode(), b""):
            with self.subTest(output=output):
                self.fake.responses[("disconnect", ADDRESS)] = output
                self.assert_error("disconnect_failed", self.bridge.disconnect, ADDRESS)
                self.assertEqual(self.saved()["selected"], ADDRESS)

    def test_subprocess_errors_are_safe_stable_and_status_reports_them(self):
        secret = "pairing-secret-934871"
        failures = (
            (FileNotFoundError(secret), "dependency_missing"),
            (subprocess.TimeoutExpired(["adb", secret], 8, output=secret.encode(), stderr=secret.encode()), "timeout"),
            (subprocess.CalledProcessError(1, ["adb", secret], output=secret.encode(), stderr=secret.encode()), "command_failed"),
            (PermissionError(secret), "command_error"),
            (subprocess.CompletedProcess(["adb"], 1, stdout=secret.encode(), stderr=secret.encode()), "command_failed"),
        )
        for failure, code in failures:
            with self.subTest(code=code):
                self.fake.responses[("devices", "-l")] = failure
                error = self.assert_error(code, self.bridge.devices)
                self.assertNotIn(secret, str(error))
                self.assertIsNone(error.__cause__)
                if error.__context__ is not None:
                    self.assertTrue(error.__suppress_context__)
                status = self.bridge.status()
                self.assertEqual(status["devices"], [])
                self.assertEqual(status["errors"][0]["code"], code)
                self.assertNotIn(secret, json.dumps(status))
        self.fake.responses[("devices", "-l")] = b"x" * (64 * 1024 + 1)
        self.assert_error("output_too_large", self.bridge.devices)

    def test_environment_is_snapshot_not_ambient_merged_or_mutated(self):
        original = dict(self.env)
        self.env["HOME"] = "/not-used"
        self.bridge.devices()
        self.assertEqual(self.fake.calls[0][1]["env"], original)
        self.fake.calls[0][1]["env"]["HOME"] = "/also-not-used"
        self.bridge.devices()
        self.assertEqual(self.fake.calls[1][1]["env"], original)

    def test_preferences_and_mirror_profiles_are_bounded_positional_and_copied(self):
        for profile, size, fps, bitrate in (("light", 720, 30, "2M"), ("balanced", 1280, 45, "4M"), ("sharp", 1920, 60, "8M")):
            with self.subTest(profile=profile):
                result = self.bridge.save_preferences(profile, True, True, False)
                self.assertEqual(result["profile"], profile)
                result["profile"] = "invalid"
                command = self.bridge.mirror_command(USB, profile, True, True, True)
                self.assertEqual(command, ["scrcpy", "--serial", USB, "--window-title", "Ponte · Celular", "--video-codec=h264",
                                           f"--max-size={size}", f"--max-fps={fps}", f"--video-bit-rate={bitrate}", "--no-control"])
                self.assertEqual(self.saved()["preferences"]["profile"], profile)
        command = self.bridge.mirror_command(EMULATOR)
        self.assertIn("--no-audio", command)
        self.assertIn("--no-clipboard-autosync", command)
        self.assertIn("--max-size=1280", command)
        for option in ("--stay-awake", "--turn-screen-off", "--keyboard=uhid", "--no-control"):
            self.assertNotIn(option, command)
        self.assertTrue(all(argv == ["adb", "devices", "-l"] for argv in self.argv()))

    def test_invalid_preferences_do_not_execute_or_persist(self):
        for args in (("custom", False, False, False), ([], False, False, False), ("balanced", 1, False, False),
                     ("balanced", False, "false", False), ("balanced", False, False, None)):
            with self.subTest(args=args):
                self.assert_error("invalid_preferences", self.bridge.save_preferences, *args)
                self.assert_error("invalid_preferences", self.bridge.mirror_command, USB, *args)
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.data.exists())

    def test_mirror_missing_scrcpy_fails_without_starting_any_process(self):
        with patch("desktop.bridge.shutil.which", return_value=None):
            self.assert_error("dependency_missing", self.bridge.mirror_command, USB)
        self.assertEqual(self.fake.calls, [])

    def test_read_only_blocks_actions_without_adb(self):
        self.bridge.save_preferences("balanced", False, False, True)
        self.assert_error("read_only", self.bridge.action, USB, "home", {})
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(self.bridge.screenshot(USB, self.root / "readonly.png"), str(self.root / "readonly.png"))

    def test_action_allowlist_aliases_and_wakeup_never_unlock(self):
        keys = {"BACK": 4, "HOME": 3, "APP_SWITCH": 187, "POWER": 26, "VOLUME_UP": 24, "VOLUME_DOWN": 25, "MUTE": 164, "WAKEUP": 224}
        for name, keycode in keys.items():
            with self.subTest(name=name):
                self.fake.calls.clear()
                self.assertIsNone(self.bridge.action(USB, "key", {"key": name}))
                self.assertEqual(self.argv(), [["adb", "devices", "-l"], ["adb", "-s", USB, "shell", f"input keyevent {keycode}"]])
        for alias, name in schema()["actions"]["aliases"].items():
            self.bridge.action(EMULATOR, alias, {})
            self.assertEqual(self.argv()[-1], ["adb", "-s", EMULATOR, "shell", f"input keyevent {keys[name]}"])
        self.assertFalse(any("unlock" in arg or "wm dismiss-keyguard" in arg for argv in self.argv() for arg in argv))

    def test_actions_tap_swipe_boundaries(self):
        self.bridge.action(ADDRESS, "tap", {"x": 0, "y": 32767})
        self.assertEqual(self.argv()[-1], ["adb", "-s", ADDRESS, "shell", "input tap 0 32767"])
        for duration in (1, 2000):
            self.bridge.action(USB, "swipe", dict(x1=0, y1=32767, x2=32767, y2=0, duration=duration))
            self.assertEqual(self.argv()[-1], ["adb", "-s", USB, "shell", f"input swipe 0 32767 32767 0 {duration}"])

    def test_text_is_ascii_single_argument_shell_quoted_and_spaces_encoded(self):
        text = "a b '$HOME'; $(id) `id` && | <> \\\" ! # * ? ( ) [ ] { } ~ = : / @ + - _"
        self.bridge.action(USB, "text", {"text": text})
        argv = self.argv()[-1]
        self.assertEqual(argv[:4], ["adb", "-s", USB, "shell"])
        self.assertEqual(shlex.split(argv[4]), ["input", "text", text.replace(" ", "%s")])
        self.assertEqual(len(argv), 5)
        self.bridge.action(USB, "text", {"text": "x" * 1024})
        self.bridge.action(USB, "text", {"text": " "})
        self.assertEqual(shlex.split(self.argv()[-1][-1]), ["input", "text", "%s"])

    def test_invalid_actions_never_call_adb(self):
        invalid = [("key", {"key": value}) for value in ("ENTER", "UNLOCK", "home", 3, [], "HOME;id")]
        invalid += [("tap", {"x": value, "y": 0}) for value in (-1, 32768, True, 1.0, "1", None)]
        invalid += [("swipe", dict(x1=0, y1=0, x2=1, y2=1, duration=value)) for value in (0, 2001, True, 1.0, "1")]
        invalid += [("text", {"text": value}) for value in ("", "á", "a\nb", "a\rb", "a\tb", "\0", "\x7f", "100%", "%s", "x" * 1025, None)]
        invalid += [("shell", {}), ("home", {"extra": True}), ("tap", {"x": 1}), ("tap", {"x": 1, "y": 2, "z": 3}),
                    ("swipe", {"x1": 0, "y1": 0, "x2": 1, "y2": 1}), ("text", {"text": "ok", "extra": 1}), ([], {}), ("home", [])]
        for kind, values in invalid:
            with self.subTest(kind=kind, values=values):
                self.assert_error("invalid_action", self.bridge.action, USB, kind, values)
        self.assertEqual(self.fake.calls, [])

    def test_screenshot_bytes_private_exclusive_and_no_overwrite(self):
        output = self.root / "shot.png"
        self.assertEqual(self.bridge.screenshot(USB, output), str(output))
        self.assertEqual(output.read_bytes(), PNG)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertEqual(self.argv(), [["adb", "devices", "-l"], ["adb", "-s", USB, "exec-out", "screencap", "-p"]])
        self.fake.calls.clear()
        self.assert_error("output_exists", self.bridge.screenshot, USB, output)
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(output.read_bytes(), PNG)

    def test_screenshot_invalid_or_oversized_png_never_leaves_file(self):
        output = self.root / "shot.png"
        for image, code in ((b"not png", "invalid_png"), (b"\x89PNG\r\n\x1a\n", "invalid_png"),
                            (PNG[:16] + b"\0\0\0\0" + PNG[20:], "invalid_png"), (PNG.decode("latin1"), "invalid_output"),
                            (PNG + b"0" * (20 * 1024 * 1024), "output_too_large")):
            with self.subTest(code=code):
                self.fake.responses[("-s", USB, "exec-out", "screencap", "-p")] = image
                self.assert_error(code, self.bridge.screenshot, USB, output)
                self.assertFalse(output.exists())

    def test_screenshot_accepts_exact_payload_cap(self):
        output = self.root / "limit.png"
        image = PNG + b"\0" * (20 * 1024 * 1024 - len(PNG))
        self.fake.responses[("-s", USB, "exec-out", "screencap", "-p")] = image
        self.bridge.screenshot(USB, output)
        self.assertEqual(output.stat().st_size, 20 * 1024 * 1024)

    def test_screenshot_invalid_path_is_rejected_before_any_adb_call(self):
        for output in (None, "relative.png", "/some/../other.png", "/path\nshot.png"):
            self.assert_error("invalid_path", self.bridge.screenshot, USB, output)
        self.assertEqual(self.fake.calls, [])

    def test_screenshot_timeout_and_write_failure_cleanup(self):
        output = self.root / "shot.png"
        key = ("-s", USB, "exec-out", "screencap", "-p")
        self.fake.responses[key] = subprocess.TimeoutExpired(["adb"], 8)
        self.assert_error("timeout", self.bridge.screenshot, USB, output)
        self.assertFalse(output.exists())
        self.fake.responses.pop(key)
        with patch("desktop.bridge.os.fsync", side_effect=OSError("fixture failure")):
            self.assert_error("screenshot_failed", self.bridge.screenshot, USB, output)
        self.assertFalse(output.exists())

    def test_screenshot_rejects_existing_symlink_directory_and_parent_symlink(self):
        target = self.root / "existing"
        target.write_bytes(b"keep")
        link = self.root / "link.png"
        link.symlink_to(target)
        dangling = self.root / "dangling.png"
        dangling.symlink_to(self.root / "missing")
        for path in (target, link, dangling, self.root):
            self.assert_error("output_exists", self.bridge.screenshot, USB, path)
        parent = self.root / "parent-link"
        parent.symlink_to(self.root, target_is_directory=True)
        self.assert_error("screenshot_failed", self.bridge.screenshot, USB, parent / "new.png")
        self.assertEqual(self.fake.calls, [])
        self.assertEqual(target.read_bytes(), b"keep")

    def test_screenshot_creation_race_does_not_overwrite_or_remove_other_file(self):
        output = self.root / "race.png"
        real_open = os.open

        def racing_open(path, flags, mode=0o777, **kwargs):
            if path == "race.png" and flags & os.O_CREAT:
                output.write_bytes(b"other owner")
            return real_open(path, flags, mode, **kwargs)

        with patch("desktop.bridge.os.open", side_effect=racing_open):
            self.assert_error("output_exists", self.bridge.screenshot, USB, output)
        self.assertEqual(output.read_bytes(), b"other owner")

    def test_screenshot_failure_cleanup_preserves_replaced_inode(self):
        output = self.root / "race.png"

        def replace_while_syncing(fd):
            output.unlink()
            output.write_bytes(b"another writer")
            raise OSError("simulated write failure after replacement")

        with patch("desktop.bridge.os.fsync", side_effect=replace_while_syncing):
            self.assert_error("screenshot_failed", self.bridge.screenshot, USB, output)
        self.assertEqual(output.read_bytes(), b"another writer")

    def test_paths_and_runtime_data_dir_precedence_and_secret_filtering(self):
        runtime = self.root / "actual-runtime"
        self.write_json(self.config, {"schemaVersion": 1, "dataDir": str(runtime), "phone": {"address": ADDRESS},
                                      "token": "secret-token", "nativeTls": {"key": "secret-key"}})
        bridge = DesktopBridge(self.env, self.fake)
        self.assertEqual(bridge.status()["selected"], ADDRESS)
        bridge.save_preferences("sharp", True, False, False)
        self.assertTrue((runtime / "desktop.json").exists())
        self.assertFalse(self.data.exists())
        persisted = (runtime / "desktop.json").read_text()
        self.assertNotIn("secret", persisted)
        self.assertNotIn("secret", json.dumps(bridge.status()))
        override = self.root / "override"
        env = dict(self.env, OMARCHY_REMOTE_DATA=str(override))
        DesktopBridge(env, self.fake).save_preferences()
        self.assertTrue((override / "desktop.json").exists())
        explicit = self.root / "explicit.json"
        self.write_json(explicit, {"phone": {"address": OTHER}})
        env["PONTE_CONFIG"] = str(explicit)
        self.assertEqual(DesktopBridge(env, self.fake).status()["selected"], ADDRESS)  # saved state wins
        env["OMARCHY_REMOTE_DATA"] = str(self.root / "fresh")
        self.assertEqual(DesktopBridge(env, self.fake).status()["selected"], OTHER)

    def test_home_default_and_phone_json_fallback(self):
        env = {"HOME": str(self.root), "PATH": self.env["PATH"]}
        data = self.root / ".local/state/ponte"
        self.write_json(data / "phone.json", {"address": ADDRESS, "ignored": "secret"})
        bridge = DesktopBridge(env, self.fake)
        self.assertEqual(bridge.status()["selected"], ADDRESS)
        bridge.select(USB)
        self.assertEqual(DesktopBridge(env, self.fake).status()["selected"], USB)
        self.assertEqual(json.loads((data / "phone.json").read_text())["address"], ADDRESS)
        self.assertNotIn("secret", (data / "desktop.json").read_text())

    def test_config_phone_precedes_legacy_and_preferences_only_do_not_destroy_fallback(self):
        self.write_json(self.config, {"phone": {"address": ADDRESS}})
        self.write_json(self.data / "phone.json", {"address": OTHER})
        self.write_json(self.data / "desktop.json", {"preferences": {"profile": "light", "clipboard": True}})
        status = DesktopBridge(self.env, self.fake).status()
        self.assertEqual(status["selected"], ADDRESS)
        self.assertEqual(status["preferences"], dict(profile="light", audio=False, clipboard=True, read_only=False))

    def test_unknown_saved_fields_are_never_rewritten_or_returned(self):
        self.write_json(self.data / "desktop.json", {"selected": USB, "token": "SECRET", "preferences": {"profile": "light", "token": "SECRET"}})
        bridge = DesktopBridge(self.env, self.fake)
        self.assertNotIn("SECRET", json.dumps(bridge.status()))
        bridge.save_preferences()
        self.assertNotIn("SECRET", json.dumps(self.saved()))

    def test_private_json_rejects_permissions_symlinks_hardlinks_and_oversize(self):
        for path in (self.config, self.data / "desktop.json", self.data / "phone.json"):
            for mode in (0o644, 0o640, 0o400, 0o700):
                with self.subTest(path=path.name, mode=mode):
                    self.write_json(path, {}, mode)
                    self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
                    path.unlink()
            self.write_json(path, {})
            original = path.with_name(path.name + ".original")
            path.rename(original)
            path.symlink_to(original)
            self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
            path.unlink()
            os.link(original, path)
            self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
            path.unlink()
            original.unlink()
            self.write_json(path, {"secret": "x" * 65536})
            self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
            path.unlink()
        self.assertEqual(self.fake.calls, [])

    def test_private_json_rejects_fifo_directory_wrong_owner_and_ancestor_symlink(self):
        self.config.parent.mkdir(mode=0o700, parents=True)
        os.mkfifo(self.config, 0o600)
        self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
        self.config.unlink()
        self.config.mkdir()
        self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
        self.config.rmdir()
        self.write_json(self.config, {})
        with patch("desktop.bridge.os.getuid", return_value=os.getuid() + 1):
            self.assert_error("unsafe_file", DesktopBridge, self.env, self.fake)
        link = self.root / "config-link"
        link.symlink_to(self.config.parent, target_is_directory=True)
        self.assert_error("unsafe_file", DesktopBridge, dict(self.env, PONTE_CONFIG=str(link / "config.json")), self.fake)
        self.assertEqual(self.fake.calls, [])

    def test_missing_explicit_config_invalid_json_and_invalid_paths(self):
        self.assert_error("config_missing", DesktopBridge, dict(self.env, PONTE_CONFIG=str(self.root / "missing.json")), self.fake)
        for value in ([], None, 1, {"schemaVersion": 2}, {"schemaVersion": True}, {"phone": "bad"}):
            self.write_json(self.config, value)
            self.assert_error("invalid_config", DesktopBridge, self.env, self.fake)
        self.config.write_bytes(b"{secret invalid json")
        self.assert_error("invalid_config", DesktopBridge, self.env, self.fake)
        self.config.write_bytes(b"\xff")
        self.assert_error("invalid_config", DesktopBridge, self.env, self.fake)
        self.config.unlink()
        for key in ("HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PONTE_CONFIG", "OMARCHY_REMOTE_DATA"):
            for path in ("relative", "/some/../other", "/bad\npath", "/bad\x7fpath"):
                with self.subTest(key=key, path=path):
                    self.assert_error("invalid_path", DesktopBridge, dict(self.env, **{key: path}), self.fake)
        self.assertEqual(self.fake.calls, [])

    def test_private_state_directory_must_be_owned_0700_and_never_symlinked(self):
        self.data.mkdir(parents=True, mode=0o755)
        self.data.chmod(0o755)
        self.assert_error("unsafe_file", self.bridge.save_preferences)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o755)
        self.data.rmdir()
        self.data.symlink_to(self.root, target_is_directory=True)
        self.assert_error("persistence_failed", self.bridge.save_preferences)
        self.assertFalse((self.root / "desktop.json").exists())

    def test_atomic_persistence_failure_preserves_file_memory_and_cleans_temporary(self):
        self.bridge.save_preferences("light", False, False, False)
        target = self.data / "desktop.json"
        before = target.read_bytes()

        def failed_replace(source, destination, **kwargs):
            self.assertEqual(target.read_bytes(), before)
            candidate = self.data / source
            self.assertEqual(stat.S_IMODE(candidate.stat().st_mode), 0o600)
            self.assertEqual(json.loads(candidate.read_text())["preferences"]["profile"], "sharp")
            raise OSError("private sentinel")

        with patch("desktop.bridge.os.replace", side_effect=failed_replace):
            error = self.assert_error("persistence_failed", self.bridge.save_preferences, "sharp", True, True, True)
        self.assertNotIn("sentinel", str(error))
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list(self.data.iterdir()), [target])
        self.assertEqual(self.bridge.status()["preferences"]["profile"], "light")

    def test_persistence_rechecks_replaced_symlink_without_touching_target(self):
        self.bridge.save_preferences()
        target = self.data / "desktop.json"
        other = self.root / "other.json"
        other.write_bytes(b"must keep")
        target.unlink()
        target.symlink_to(other)
        self.assert_error("unsafe_file", self.bridge.save_preferences, "light", False, False, False)
        self.assertEqual(other.read_bytes(), b"must keep")
        self.assertTrue(target.is_symlink())

    def test_persistence_temp_name_collision_never_deletes_existing_file(self):
        self.data.mkdir(mode=0o700, parents=True)
        existing = self.data / ".desktop-fixture"
        existing.write_bytes(b"another writer")
        with patch("desktop.bridge.secrets.token_hex", return_value="fixture"):
            self.assert_error("persistence_failed", self.bridge.save_preferences)
        self.assertEqual(existing.read_bytes(), b"another writer")
        self.assertFalse((self.data / "desktop.json").exists())


if __name__ == "__main__":
    unittest.main()

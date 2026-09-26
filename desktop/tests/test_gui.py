"""Qt tests, always synthetic. Run offscreen or inside an isolated agent bench.

    QT_QPA_PLATFORM=offscreen python -m unittest discover -s desktop/tests -p test_gui.py

No test contacts adb, a phone, the desktop input stack or a real scrcpy session.
"""

import copy
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

# An explicit platform (for example xcb on a bench) wins. Never open the user's
# display merely because DISPLAY/WAYLAND_DISPLAY happens to be inherited.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
try:
    from PySide6.QtCore import QObject, QPoint, QRect, QTimer, Qt
    from PySide6.QtGui import QImage
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication, QCheckBox, QLabel, QLineEdit, QMessageBox, QWidget
except ImportError:
    QT_AVAILABLE = False
else:
    from desktop.gui import DemoBridge, LOG_LIMIT, MainWindow, PhoneIllustration, _synthetic_image, main
    QT_AVAILABLE = True


class FakeBridge:
    """Independent bridge contract fixture, not an inherited real bridge."""

    def __init__(self):
        self.calls = []
        self.call_threads = []
        self.state = {
            "dependencies": dict(adb=True, scrcpy=True, pyside6=True),
            "selected": "phone-a",
            "devices": [
                dict(serial="phone-a", state="device", model="Phone_A"),
                dict(serial="phone-b", state="device", model="Phone_B"),
            ],
            "preferences": dict(profile="balanced", audio=False, clipboard=False, read_only=False),
            "errors": [],
        }
        self.command = [sys.executable, "-u", "-c", "import time; print('fixture ready', flush=True); time.sleep(30)"]
        self.fail = {}
        self.gates = {}

    def _call(self, name, *args):
        self.calls.append((name, *args))
        self.call_threads.append(threading.get_ident())
        if name in self.gates:
            if not self.gates[name].wait(3):
                raise RuntimeError("fixture worker timed out")
        if name in self.fail:
            raise RuntimeError(self.fail[name])

    def status(self):
        self._call("status")
        return copy.deepcopy(self.state)

    def connect(self, address):
        self._call("connect", address)

    def pair(self, address, code):
        self._call("pair", address, code)

    def select(self, serial):
        self._call("select", serial)
        self.state["selected"] = serial

    def disconnect(self, serial):
        self._call("disconnect", serial)
        for device in self.state["devices"]:
            if device["serial"] == serial:
                device["state"] = "offline"

    def save_preferences(self, profile, audio, clipboard, read_only):
        preferences = dict(profile=profile, audio=audio, clipboard=clipboard, read_only=read_only)
        self._call("save_preferences", preferences)
        self.state["preferences"] = preferences

    def mirror_command(self, serial, profile, audio, clipboard, read_only):
        self._call("mirror_command", serial, profile, audio, clipboard, read_only)
        return self.command

    def action(self, serial, kind, values):
        self._call("action", serial, kind, values)

    def screenshot(self, serial, output):
        self._call("screenshot", serial, output)
        with open(output, "xb") as stream:
            stream.write(b"synthetic fixture, not a screen capture")


@unittest.skipUnless(QT_AVAILABLE, "PySide6 não instalado")
class GuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication(["ponte-gui-tests"])
        cls.app.setQuitOnLastWindowClosed(False)

    def setUp(self):
        self.bridge = FakeBridge()
        self.windows = []
        self._subprocess_guard = patch("subprocess.run", side_effect=AssertionError("GUI tests must not run adb"))
        self._subprocess_guard.start()

    def tearDown(self):
        for bridge in [self.bridge] + [window.bridge for window in self.windows]:
            for gate in getattr(bridge, "gates", {}).values():
                gate.set()
        for window in self.windows:
            window.close()
        self.wait_for(lambda: all(not window.isVisible() and not window._busy and window._pool.activeThreadCount() == 0 and window._process is None for window in self.windows), timeout=5000)
        for window in self.windows:
            window.deleteLater()
        self.app.processEvents()
        self._subprocess_guard.stop()

    def wait_for(self, predicate, timeout=3500):
        deadline = time.monotonic() + timeout / 1000
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail("Qt condition did not settle before timeout")
            QTest.qWait(10)
        self.app.processEvents()

    def window(self, bridge=None, demo=False, wait=True):
        window = MainWindow(bridge=self.bridge if bridge is None and not demo else bridge, demo=demo)
        self.windows.append(window)
        window.show()
        if wait:
            self.wait_for(lambda: bool(window._snapshot) and not window._busy)
        return window

    def click(self, button):
        if isinstance(button, QCheckBox):
            QTest.mouseClick(button, Qt.MouseButton.LeftButton, pos=QPoint(10, button.height() // 2))
        else:
            QTest.mouseClick(button, Qt.MouseButton.LeftButton)

    def settled(self, window):
        self.wait_for(lambda: not window._busy and window._pool.activeThreadCount() == 0)

    def test_startup_only_status_and_no_polling(self):
        window = self.window()
        QTest.qWait(100)
        self.assertEqual(self.bridge.calls, [("status",)])
        self.assertTrue(all(ident != threading.get_ident() for ident in self.bridge.call_threads))
        self.assertTrue(window.start_button.isEnabled())
        self.assertFalse(window.audio_check.isChecked())
        self.assertFalse(window.clipboard_check.isChecked())
        self.assertFalse(window.read_only_check.isChecked())
        self.assertEqual(window.profile_combo.currentData(), "balanced")
        self.assertEqual(window.address_field.placeholderText(), "100.x.x.x:5555")

    def test_public_widgets_have_stable_unique_names(self):
        window = self.window()
        names = (
            "addressField", "deviceCombo", "connectButton", "refreshButton", "selectButton",
            "disconnectButton", "pairToggle", "pairAddressField", "pairCodeField", "pairButton",
            "profileCombo", "savePreferencesButton", "audioCheck", "clipboardCheck", "readOnlyCheck",
            "startButton", "stopButton", "screenshotButton", "backButton", "homeButton",
            "recentsButton", "wakeButton", "volumeDownButton", "volumeUpButton", "statusLabel",
            "processStatusLabel", "dependenciesLabel", "previewDisclaimer", "messageLabel", "logView",
        )
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(len(window.findChildren(QObject, name)), 1)
        self.assertIn("separada", window.findChild(QLabel, "previewDisclaimer").text())
        self.assertEqual(window.pair_code.echoMode(), QLineEdit.EchoMode.Password)

    def test_static_phone_illustration_never_claims_no_phone_is_connected(self):
        window = self.window()
        illustration = window.findChild(PhoneIllustration, "phoneIllustration")
        self.assertIn("Ilustração estática", illustration.accessibleDescription())
        self.assertIn("Vídeo em janela separada", illustration.accessibleDescription())
        self.assertNotIn("Sem aparelho", illustration.accessibleDescription())
        self.assertEqual(illustration._image, _synthetic_image(demo=False))
        self.assertNotEqual(illustration._image, _synthetic_image(demo=True))

    def test_active_badge_preserves_busy_and_error_precedence(self):
        window = self.window()
        self.click(window.start_button)
        self.wait_for(lambda: window.process_state == "running")
        self.assertIn("Controle ativo", window.status_label.text())
        self.assertNotIn("pronto pra abrir", window.status_label.text())
        gate = self.bridge.gates["action"] = threading.Event()
        self.click(window.action_buttons["home"])
        self.assertEqual(window.status_label.text(), "Trabalhando…")
        gate.set()
        self.settled(window)
        self.assertIn("Controle ativo", window.status_label.text())
        window._snapshot["errors"] = [dict(message="fixture discovery error")]
        window._update_controls()
        self.assertEqual(window.status_label.text(), "Falha ao conferir aparelhos")
        window._snapshot["errors"] = []
        window._update_controls()
        self.assertIn("Controle ativo", window.status_label.text())
        self.click(window.stop_button)
        self.assertIn("Encerrando controle", window.status_label.text())
        self.wait_for(lambda: window._process is None)
        self.assertIn("pronto pra abrir", window.status_label.text())

    def test_layout_does_not_overlap_when_resized_or_pairing_expanded(self):
        window = self.window(demo=True)
        for size in ((1140, 850), (980, 680)):
            for expanded in (False, True):
                with self.subTest(size=size, pairing=expanded):
                    window.resize(*size)
                    window.pair_toggle.setChecked(expanded)
                    QTest.qWait(30)
                    intro = window.findChild(QWidget, "experienceIntro")
                    root = window.findChild(QWidget, "root")
                    intro_rect = QRect(intro.mapTo(root, QPoint(0, 0)), intro.size())
                    profile_rect = QRect(window.profile_combo.mapTo(root, QPoint(0, 0)), window.profile_combo.size())
                    self.assertLess(intro_rect.bottom(), profile_rect.top())
                    illustration = intro.findChild(QWidget, "phoneIllustration")
                    self.assertTrue(intro.rect().contains(QRect(illustration.mapTo(intro, QPoint(0, 0)), illustration.size())))
                    for label in intro.findChildren(QLabel):
                        needed = label.heightForWidth(label.width())
                        self.assertGreaterEqual(label.height(), needed)
                    if expanded:
                        self.assertGreater(window.centralWidget().verticalScrollBar().maximum(), 0)

    def test_serial_candidate_requires_explicit_select(self):
        window = self.window(wait=False)
        window.set_requested_serial("phone-b")
        self.wait_for(lambda: bool(window._snapshot) and not window._busy)
        self.assertEqual(window.device_combo.currentData(), "phone-b")
        self.assertEqual(self.bridge.calls, [("status",)])
        self.assertFalse(window.start_button.isEnabled())
        self.assertFalse(window.action_buttons["home"].isEnabled())
        self.click(window.select_button)
        self.settled(window)
        self.assertIn(("select", "phone-b"), self.bridge.calls)
        self.assertTrue(window.start_button.isEnabled())

    def test_combo_change_does_not_mutate_or_redirect_input(self):
        window = self.window()
        window.device_combo.setCurrentIndex(window.device_combo.findData("phone-b"))
        self.assertEqual(self.bridge.calls, [("status",)])
        self.assertFalse(window.action_buttons["home"].isEnabled())
        window._action("home")
        self.assertEqual(self.bridge.calls, [("status",)])
        self.click(window.select_button)
        self.settled(window)
        for kind, button in window.action_buttons.items():
            self.click(button)
            self.settled(window)
            self.assertIn(("action", "phone-b", kind, {}), self.bridge.calls)
        self.assertFalse(any(call[0] == "action" and call[1] == "phone-a" for call in self.bridge.calls))

    def test_connect_is_explicit_and_address_required(self):
        window = self.window()
        self.click(window.connect_button)
        self.assertEqual(self.bridge.calls, [("status",)])
        self.assertIn("Preencha", window.message_label.text())
        window.address_field.setText(" 100.22.33.44:5555 ")
        self.click(window.connect_button)
        self.settled(window)
        self.assertIn(("connect", "100.22.33.44:5555"), self.bridge.calls)
        self.assertFalse(any(call[0] in ("select", "pair", "mirror_command") for call in self.bridge.calls))

    def test_pair_disclosure_password_and_error_redaction(self):
        window = self.window()
        self.assertFalse(window.pair_panel.isVisible())
        self.click(window.pair_toggle)
        self.assertTrue(window.pair_panel.isVisible())
        window.pair_address.setText("100.2.3.4:12345")
        window.pair_code.setText("987654")
        self.bridge.fail["pair"] = "pairing code: 987654 rejected"
        self.click(window.pair_button)
        self.settled(window)
        self.assertIn(("pair", "100.2.3.4:12345", "987654"), self.bridge.calls)
        self.assertEqual(window.pair_code.text(), "")
        self.assertNotIn("987654", window.log_view.toPlainText())
        self.assertNotIn("987654", window.message_label.text())
        self.assertIn("[oculto]", window.message_label.text())
        self.assertFalse(any(call[0] == "connect" for call in self.bridge.calls))
        self.assertTrue(window.connect_button.isEnabled())

    def test_offline_unauthorized_missing_and_no_selection(self):
        window = self.window()
        for state, label in (("offline", "Offline"), ("unauthorized", "Não autorizado")):
            with self.subTest(state=state):
                self.bridge.state["devices"][0]["state"] = state
                self.click(window.refresh_button)
                self.settled(window)
                self.assertIn(label, window.status_label.text())
                self.assertFalse(window.start_button.isEnabled())
                self.assertFalse(window.screenshot_button.isEnabled())
                self.assertTrue(all(not button.isEnabled() for button in window.action_buttons.values()))
        self.bridge.state["dependencies"]["adb"] = False
        self.click(window.refresh_button)
        self.settled(window)
        self.assertIn("Dependências", window.status_label.text())
        self.assertIn("adb", window.dependencies_label.text())
        self.assertFalse(window.connect_button.isEnabled())
        self.bridge.state["dependencies"]["adb"] = True
        self.bridge.state["selected"] = None
        self.click(window.refresh_button)
        self.settled(window)
        self.assertIn("Selecione", window.status_label.text())
        self.assertFalse(window.start_button.isEnabled())

    def test_missing_scrcpy_blocks_viewer_but_not_device_navigation(self):
        self.bridge.state["dependencies"]["scrcpy"] = False
        window = self.window()
        self.assertFalse(window.start_button.isEnabled())
        self.assertTrue(window.action_buttons["home"].isEnabled())
        self.assertTrue(window.screenshot_button.isEnabled())
        self.assertIn("scrcpy", window.dependencies_label.text())

    def test_status_error_returns_to_recoverable_state(self):
        self.bridge.fail["status"] = "adb indisponível"
        window = self.window(wait=False)
        self.wait_for(lambda: bool(self.bridge.calls) and not window._busy)
        self.assertIn("adb indisponível", window.message_label.text())
        self.assertFalse(window.start_button.isEnabled())
        self.assertTrue(window.refresh_button.isEnabled())
        del self.bridge.fail["status"]
        self.click(window.refresh_button)
        self.settled(window)
        self.assertTrue(window.start_button.isEnabled())

    def test_discovery_errors_are_visible_and_fail_closed(self):
        self.bridge.state["errors"] = [dict(code="adb_timeout", message="ADB demorou demais")]
        window = self.window()
        self.assertIn("ADB demorou demais", window.message_label.text())
        self.assertNotIn("Lista atualizada", window.message_label.text())
        self.assertIn("Falha", window.status_label.text())
        self.assertFalse(window.start_button.isEnabled())
        self.assertFalse(window.action_buttons["home"].isEnabled())

    def test_selected_network_address_is_only_an_initial_suggestion(self):
        self.bridge.state["selected"] = "100.22.33.44:5555"
        self.bridge.state["devices"][0]["serial"] = "100.22.33.44:5555"
        window = self.window()
        self.assertEqual(window.address_field.text(), "100.22.33.44:5555")
        self.assertEqual(self.bridge.calls, [("status",)])
        window.address_field.setText("user-edited:1234")
        self.click(window.refresh_button)
        self.settled(window)
        self.assertEqual(window.address_field.text(), "user-edited:1234")
        self.assertTrue(window.disconnect_button.isEnabled())
        self.click(window.disconnect_button)
        self.settled(window)
        self.assertIn(("disconnect", "100.22.33.44:5555"), self.bridge.calls)
        self.assertIn("Offline", window.status_label.text())

    def test_usb_serial_does_not_enable_network_disconnect(self):
        window = self.window()
        self.assertEqual(window.address_field.text(), "")
        self.assertFalse(window.disconnect_button.isEnabled())
        self.assertIn("USB", window.disconnect_button.toolTip())
        window._disconnect()
        self.assertEqual(self.bridge.calls, [("status",)])

    def test_busy_worker_does_not_block_ui_or_allow_competing_jobs(self):
        window = self.window()
        gate = self.bridge.gates["connect"] = threading.Event()
        window.address_field.setText("100.2.3.4:5555")
        ticks = []
        self.click(window.connect_button)
        QTimer.singleShot(0, lambda: ticks.append(True))
        self.wait_for(lambda: bool(ticks))
        self.assertTrue(window._busy)
        for button in (window.start_button, window.connect_button, window.select_button, window.refresh_button, window.screenshot_button, window.preferences_button):
            self.assertFalse(button.isEnabled())
        self.assertFalse(window.device_combo.isEnabled())
        self.assertTrue(all(not button.isEnabled() for button in window.action_buttons.values()))
        window._action("home")
        self.assertFalse(any(call[0] == "action" for call in self.bridge.calls))
        gate.set()
        self.settled(window)
        self.assertTrue(window.device_combo.isEnabled())

    def test_read_only_blocks_all_input_including_wake_and_volume(self):
        window = self.window()
        self.click(window.read_only_check)
        for kind, button in window.action_buttons.items():
            self.assertFalse(button.isEnabled(), kind)
            window._action(kind)
        self.assertFalse(any(call[0] == "action" for call in self.bridge.calls))
        self.assertTrue(window.screenshot_button.isEnabled())
        self.assertTrue(window.start_button.isEnabled())
        self.assertFalse(any(call[0] == "save_preferences" for call in self.bridge.calls))

    def test_preferences_only_save_on_explicit_apply(self):
        window = self.window()
        window.profile_combo.setCurrentIndex(window.profile_combo.findData("sharp"))
        self.click(window.audio_check)
        self.click(window.clipboard_check)
        self.click(window.read_only_check)
        self.assertEqual(self.bridge.calls, [("status",)])
        self.click(window.preferences_button)
        self.settled(window)
        self.assertIn(("save_preferences", dict(profile="sharp", audio=True, clipboard=True, read_only=True)), self.bridge.calls)
        self.assertEqual(window.profile_combo.currentData(), "sharp")

    def test_screenshot_targets_selected_and_never_overwrites(self):
        window = self.window()
        self.click(window.read_only_check)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "phone.png"
            with patch("desktop.gui.QFileDialog.getSaveFileName", return_value=(str(output), "PNG")):
                self.click(window.screenshot_button)
                self.settled(window)
            self.assertIn(("screenshot", "phone-a", str(output)), self.bridge.calls)
            original = output.read_bytes()
            count = len([call for call in self.bridge.calls if call[0] == "screenshot"])
            with patch("desktop.gui.QFileDialog.getSaveFileName", return_value=(str(output), "PNG")):
                self.click(window.screenshot_button)
                self.settled(window)
            self.assertEqual(count, len([call for call in self.bridge.calls if call[0] == "screenshot"]))
            self.assertEqual(original, output.read_bytes())
            self.assertIn("já existe", window.message_label.text())
        with patch("desktop.gui.QFileDialog.getSaveFileName", return_value=("", "")):
            self.click(window.screenshot_button)
        self.assertFalse(window._busy)

    def test_mirror_reverification_failure_never_starts_a_process(self):
        window = self.window()
        self.bridge.fail["mirror_command"] = "aparelho ficou offline"
        with patch("desktop.gui.QProcess", side_effect=AssertionError("no fallback process")):
            self.click(window.start_button)
            self.settled(window)
        self.assertEqual(window.process_state, "error")
        self.assertIsNone(window._process)
        self.assertFalse(window.stop_button.isEnabled())
        self.assertTrue(window.device_combo.isEnabled())
        self.assertIn(("mirror_command", "phone-a", "balanced", False, False, False), self.bridge.calls)
        self.assertIn("offline", window.message_label.text())

    def test_malformed_mirror_command_has_no_shell_fallback(self):
        window = self.window()
        self.bridge.command = "scrcpy --serial phone-a"
        with patch("desktop.gui.QProcess", side_effect=AssertionError("no shell fallback")):
            self.click(window.start_button)
            self.settled(window)
        self.assertEqual(window.process_state, "error")
        self.assertIn("comando válido", window.message_label.text())
        self.assertIsNone(window._process)

    def test_start_uses_current_permissions_and_locks_them_for_lifetime(self):
        window = self.window()
        window.profile_combo.setCurrentIndex(window.profile_combo.findData("light"))
        self.click(window.read_only_check)
        self.click(window.start_button)
        self.wait_for(lambda: window.process_state == "running")
        self.assertIn(("mirror_command", "phone-a", "light", False, False, True), self.bridge.calls)
        self.assertIn("Somente leitura", window.status_label.text())
        self.assertNotIn("Controle ativo", window.status_label.text())
        self.assertFalse(window.read_only_check.isEnabled())
        self.assertTrue(all(not button.isEnabled() for button in window.action_buttons.values()))
        self.assertTrue(window.screenshot_button.isEnabled())
        self.click(window.stop_button)
        self.wait_for(lambda: window._process is None)
        self.assertTrue(window.read_only_check.isEnabled())

    def test_managed_process_exact_argv_and_stop(self):
        window = self.window()
        self.click(window.start_button)
        self.wait_for(lambda: window.process_state == "running")
        self.assertEqual(window._process.program(), sys.executable)
        self.assertEqual(window._process.arguments(), self.bridge.command[1:])
        self.assertFalse(window.device_combo.isEnabled())
        self.assertFalse(window.disconnect_button.isEnabled())
        self.assertFalse(window.profile_combo.isEnabled())
        self.assertTrue(window.stop_button.isEnabled())
        self.wait_for(lambda: "fixture ready" in window.log_view.toPlainText())
        self.click(window.stop_button)
        self.wait_for(lambda: window._process is None)
        self.assertEqual(window.process_state, "stopped")
        self.assertTrue(window.device_combo.isEnabled())
        self.assertFalse(window.stop_button.isEnabled())

    def test_process_unexpected_exit_clears_running_state(self):
        self.bridge.command = [sys.executable, "-c", "import sys; print('fixture failure'); sys.exit(7)"]
        window = self.window()
        self.click(window.start_button)
        self.wait_for(lambda: window.process_state == "error" and not window._busy and window._process is None)
        self.assertIn("7", window.message_label.text())
        self.assertIn("fixture failure", window.log_view.toPlainText())
        self.assertIn("Controle interrompido", window.status_label.text())
        self.assertTrue(window.start_button.isEnabled())
        self.assertFalse(window.stop_button.isEnabled())
        self.assertTrue(window.device_combo.isEnabled())

    def test_process_failed_to_start_can_retry(self):
        self.bridge.command = ["/nonexistent/ponte-test-fixture"]
        window = self.window()
        self.click(window.start_button)
        self.wait_for(lambda: window.process_state == "error" and window._process is None and not window._busy)
        self.assertTrue(window.start_button.isEnabled())
        self.assertTrue(window.device_combo.isEnabled())
        self.assertFalse(window.stop_button.isEnabled())

    def test_process_logs_are_bounded_and_redacted(self):
        window = self.window()
        window._secrets.add("927461")
        window._log("x" * 50_000 + "\ncode 927461 password=secret")
        self.assertLessEqual(len(window.log_view.toPlainText()), LOG_LIMIT)
        self.assertNotIn("927461", window.log_view.toPlainText())
        self.assertNotIn("secret", window.log_view.toPlainText())
        for index in range(150):
            window._log(f"line {index}")
        self.assertLessEqual(window.log_view.document().blockCount(), 100)

    def test_close_waits_for_worker_without_launching_viewer_after_close(self):
        window = self.window()
        gate = self.bridge.gates["mirror_command"] = threading.Event()
        self.click(window.start_button)
        self.wait_for(lambda: any(call[0] == "mirror_command" for call in self.bridge.calls))
        window.close()
        self.assertTrue(window._closing)
        self.assertTrue(window.isVisible())
        self.assertFalse(window.connect_button.isEnabled())
        gate.set()
        self.wait_for(lambda: not window.isVisible())
        self.assertIsNone(window._process)

    def test_close_terminates_only_own_process(self):
        window = self.window()
        self.click(window.start_button)
        self.wait_for(lambda: window.process_state == "running")
        window.close()
        self.wait_for(lambda: not window.isVisible() and window._process is None)
        self.assertFalse(any(call[0] == "disconnect" for call in self.bridge.calls))

    @unittest.skipUnless(sys.platform != "win32", "fixture uses POSIX SIGTERM")
    def test_stop_kills_own_uncooperative_process_after_timer(self):
        self.bridge.command = [sys.executable, "-u", "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ignoring term',flush=True); time.sleep(30)"]
        window = self.window()
        self.click(window.start_button)
        self.wait_for(lambda: "ignoring term" in window.log_view.toPlainText())
        self.click(window.stop_button)
        self.assertEqual(window.process_state, "stopping")
        self.assertFalse(window.device_combo.isEnabled())
        self.wait_for(lambda: window._process is None, timeout=4000)
        self.assertEqual(window.process_state, "stopped")

    def test_demo_is_in_memory_and_never_launches_a_process(self):
        with patch("desktop.gui.QProcess", side_effect=AssertionError("demo must not spawn")):
            window = self.window(demo=True)
            self.assertIsInstance(window.bridge, DemoBridge)
            self.assertEqual(window.bridge.log, [])
            self.assertEqual(window._target(), "emulator-demo")
            self.click(window.start_button)
            self.settled(window)
            self.assertEqual(window.process_state, "running")
            self.assertEqual(window.status_label.text(), "Demonstração ativa")
            self.assertIsNone(window._process)
            dialog = window._demo_dialog
            self.assertEqual(dialog.windowTitle(), "Ponte • Demonstração")
            self.assertIn("Sem aparelho conectado", dialog.findChild(QLabel, "demoDisclaimer").text())
            self.click(window.action_buttons["home"])
            self.settled(window)
            self.assertIn(("action", "emulator-demo", "home", {}), window.bridge.log)
            self.click(window.stop_button)
            self.assertIsNone(window._demo_dialog)
            self.assertEqual(window.process_state, "stopped")
            self.click(window.disconnect_button)
            self.settled(window)
            self.assertFalse(window.start_button.isEnabled())
            self.assertIn("Offline", window.status_label.text())
            self.click(window.connect_button)
            self.settled(window)
            self.assertTrue(window.start_button.isEnabled())

    def test_demo_readonly_badge_cannot_be_mistaken_for_real_control(self):
        window = self.window(demo=True)
        self.click(window.read_only_check)
        self.click(window.start_button)
        self.settled(window)
        self.assertEqual(window.status_label.text(), "Demo · somente leitura")
        self.assertIn("Sem aparelho conectado", window._demo_dialog.findChild(QLabel, "demoDisclaimer").text())

    def test_demo_screenshot_is_static_image_and_exclusive(self):
        window = self.window(demo=True)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "demo.png"
            with patch("desktop.gui.QFileDialog.getSaveFileName", return_value=(str(output), "PNG")):
                self.click(window.screenshot_button)
                self.settled(window)
            image = QImage(str(output))
            self.assertFalse(image.isNull())
            self.assertEqual((image.width(), image.height()), (360, 640))
            if sys.platform != "win32":
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            before = output.read_bytes()
            with self.assertRaises(FileExistsError):
                window.bridge.screenshot("emulator-demo", str(output))
            self.assertEqual(output.read_bytes(), before)
            self.assertIn("sintética", window.message_label.text())

    def test_main_reuses_qapplication_and_serial_does_not_select(self):
        current = QApplication.instance()
        code = main(["--serial", "phone-b"], bridge=self.bridge)
        self.assertEqual(code, 0)
        self.assertIs(QApplication.instance(), current)
        window = current._ponte_windows[-1]
        # This test owns final deletion through the common teardown.
        window.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, False)
        self.windows.append(window)
        self.wait_for(lambda: bool(window._snapshot) and not window._busy)
        self.assertEqual(window.device_combo.currentData(), "phone-b")
        self.assertEqual(self.bridge.calls, [("status",)])
        self.assertFalse(window.start_button.isEnabled())

    def test_main_shows_safe_config_error_instead_of_silent_launcher_failure(self):
        from desktop.bridge import BridgeError
        with patch("desktop.bridge.DesktopBridge", side_effect=BridgeError("invalid_config", "Configuração inválida <arquivo>")), patch.object(QMessageBox, "exec", return_value=0) as execute:
            self.assertEqual(main([]), 2)
            execute.assert_called_once()

    def test_main_demo_never_constructs_real_bridge(self):
        with patch("desktop.bridge.DesktopBridge", side_effect=AssertionError("no real bridge in demo")):
            self.assertEqual(main(["--demo"]), 0)
            window = self.app._ponte_windows[-1]
            window.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, False)
            self.windows.append(window)
            self.wait_for(lambda: bool(window._snapshot) and not window._busy)
            self.assertIsInstance(window.bridge, DemoBridge)
            self.assertEqual(window.bridge.log, [])


if __name__ == "__main__":
    unittest.main()

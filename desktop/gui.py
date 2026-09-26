"""Native Ponte desktop UI. Importing this module never contacts a device.

All bridge calls run in a single worker pool. Device selection and mutations
require explicit user actions; the only startup operation is ``status()``.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Callable

from PySide6.QtCore import (
    QByteArray, QBuffer, QIODevice, QObject, QProcess, QRunnable,
    QSize, Qt, QThreadPool, QTimer, Signal, Slot,
)
from PySide6.QtGui import QColor, QFont, QIcon, QImage, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QDialog, QFileDialog, QFrame,
    QGridLayout, QHBoxLayout, QLabel, QLayout, QLineEdit, QMainWindow, QMessageBox, QPlainTextEdit,
    QPushButton, QScrollArea, QSizePolicy, QToolButton, QVBoxLayout, QWidget,
)


PROFILES = (("Leve", "light"), ("Equilibrado", "balanced"), ("Nítido", "sharp"))
LOG_LIMIT = 12_000
STATIC_PHONE_CAPTION = "Ilustração estática\nVídeo em janela separada"
DEMO_PHONE_CAPTION = "Imagem sintética\nSem aparelho conectado"
STYLE = """
QWidget { color: #e8eee7; font-family: 'Inter', 'Noto Sans', sans-serif; font-size: 13px; }
QMainWindow, QDialog, QWidget#root { background: #101411; }
QFrame[card="true"] { background: #19221b; border: 1px solid #2d3b2f; border-radius: 18px; }
QLabel { background: transparent; }
QLabel#brandLabel { font-size: 29px; font-weight: 800; color: #c9f75c; }
QLabel#subtitleLabel { color: #a9b9aa; font-size: 15px; }
QLabel[heading="true"] { font-size: 18px; font-weight: 700; }
QLabel[muted="true"] { color: #a4b5a6; }
QLabel#statusLabel { background: #263829; color: #c9f75c; padding: 9px 15px; border-radius: 14px; }
QLabel#messageLabel { color: #d5e5ca; padding: 3px; }
QLabel#messageLabel[error="true"] { color: #ffb7a5; }
QPushButton, QToolButton { background: #27352a; border: 1px solid #3a4b3d; border-radius: 9px; padding: 9px 13px; font-weight: 600; }
QPushButton:hover, QToolButton:hover { background: #334637; border-color: #769458; }
QPushButton:pressed { background: #40563a; }
QPushButton:disabled, QToolButton:disabled { color: #667368; background: #1c281f; border-color: #28362b; }
QPushButton[primary="true"] { background: #c9f75c; color: #142008; border: none; font-weight: 800; }
QPushButton[primary="true"]:hover { background: #d8ff7a; }
QPushButton[primary="true"]:disabled { color: #6d7a59; background: #35432a; }
QPushButton#startButton { padding: 14px; font-size: 15px; }
QLineEdit, QComboBox, QPlainTextEdit { background: #111a14; border: 1px solid #3b4b3d; border-radius: 8px; padding: 9px; selection-background-color: #66812d; }
QLineEdit:focus, QComboBox:focus { border-color: #c9f75c; }
QLineEdit:disabled, QComboBox:disabled { color: #778578; border-color: #29362c; }
QComboBox QAbstractItemView { background: #19221b; selection-background-color: #3a502e; }
QCheckBox { spacing: 8px; padding: 4px 0; }
QCheckBox::indicator { width: 17px; height: 17px; border: 1px solid #61725a; border-radius: 4px; background: #111a14; }
QCheckBox::indicator:checked { background: #c9f75c; border-color: #c9f75c; }
QCheckBox:disabled { color: #778578; }
QPlainTextEdit#logView { color: #a4b5a6; font-family: monospace; font-size: 11px; }
QToolTip { color: #e8eee7; background: #263829; border: 1px solid #769458; }
"""


class _WorkerSignals(QObject):
    completed = Signal(object, object)


class _Worker(QRunnable):
    def __init__(self, operation: Callable):
        super().__init__()
        self.operation = operation
        self.signals = _WorkerSignals()

    @Slot()
    def run(self):
        try:
            value = self.operation()
        except Exception as exc:
            self.signals.completed.emit(None, str(exc) or type(exc).__name__)
        else:
            self.signals.completed.emit(value, None)


def _synthetic_image(demo=True) -> QImage:
    image = QImage(360, 640, QImage.Format.Format_RGB32)
    image.fill(QColor("#18271c"))
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(QColor("#c9f75c"))
    painter.setFont(QFont("Sans Serif", 15, QFont.Weight.Bold))
    painter.drawText(image.rect().adjusted(20, 35, -20, -500), Qt.AlignmentFlag.AlignCenter, "PONTE • DEMONSTRAÇÃO" if demo else "PONTE • ILUSTRAÇÃO")
    painter.setFont(QFont("Sans Serif", 42, QFont.Weight.Light))
    painter.drawText(40, 200, "09:41")
    painter.setPen(QColor("#dce8d8"))
    painter.setFont(QFont("Sans Serif", 14))
    painter.drawText(40, 242, "Seu espaço de teste")
    for row in range(2):
        for col in range(3):
            painter.setBrush(QColor(("#c9f75c", "#597650", "#334c38")[(row + col) % 3]))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawRoundedRect(40 + col * 100, 310 + row * 100, 70, 70, 20, 20)
    painter.setPen(QColor("#b8cbb5"))
    painter.setFont(QFont("Sans Serif", 12))
    painter.drawText(image.rect().adjusted(15, 515, -15, -15), Qt.AlignmentFlag.AlignCenter, DEMO_PHONE_CAPTION if demo else STATIC_PHONE_CAPTION)
    painter.end()
    return image


class PhoneIllustration(QWidget):
    """A deliberately labeled illustration, never a claimed live preview."""

    def __init__(self, parent=None, demo=False):
        super().__init__(parent)
        self.setObjectName("phoneIllustration")
        self.setAccessibleName("Ilustração de celular, não é uma tela ao vivo")
        self.setAccessibleDescription(DEMO_PHONE_CAPTION if demo else STATIC_PHONE_CAPTION)
        self.setMinimumSize(150, 185)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._image = _synthetic_image(demo=demo)

    def sizeHint(self):
        return QSize(220, 285)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        height = min(self.height() - 12, 320)
        width = height * 0.5625
        x, y = (self.width() - width) / 2, (self.height() - height) / 2
        painter.setPen(QPen(QColor("#5a7452"), 2))
        painter.setBrush(QColor("#0c120e"))
        painter.drawRoundedRect(int(x), int(y), int(width), int(height), 23, 23)
        painter.drawImage(int(x + 9), int(y + 20), self._image.scaled(int(width - 18), int(height - 38), Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation))
        painter.setPen(QPen(QColor("#719060"), 3))
        painter.drawLine(int(x + width * .4), int(y + 10), int(x + width * .6), int(y + 10))
        painter.end()


class DemoBridge:
    """In-memory fixture. No adb, subprocess, real device or screen capture."""

    def __init__(self):
        self.selected = "emulator-demo"
        self.online = True
        self.log = []
        self.preferences = dict(profile="balanced", audio=False, clipboard=False, read_only=False)

    def status(self):
        return {
            "dependencies": dict(adb=True, scrcpy=True, pyside6=True),
            "selected": self.selected,
            "devices": [dict(serial="emulator-demo", state="device" if self.online else "offline", model="Celular de demonstração")],
            "preferences": dict(self.preferences),
        }

    def connect(self, address):
        self.log.append(("connect", address))
        self.online = True
        self.selected = "emulator-demo"

    def pair(self, address, code):
        self.log.append(("pair", address, "[oculto]"))

    def select(self, serial):
        if serial != "emulator-demo":
            raise ValueError("Na demonstração, selecione emulator-demo.")
        self.log.append(("select", serial))
        self.selected = serial

    def disconnect(self, serial):
        self._check(serial)
        self.log.append(("disconnect", serial))
        self.online = False

    def save_preferences(self, profile, audio, clipboard, read_only):
        self.preferences = dict(profile=profile, audio=audio, clipboard=clipboard, read_only=read_only)
        self.log.append(("preferences", dict(self.preferences)))

    def _check(self, serial):
        if serial != self.selected or serial != "emulator-demo" or not self.online:
            raise ValueError("Celular de demonstração offline. Clique em Conectar.")

    def mirror_command(self, serial, profile, audio, clipboard, read_only):
        self._check(serial)
        self.log.append(("mirror", serial, profile, audio, clipboard, read_only))
        return ["demo-only", serial]

    def action(self, serial, kind, values):
        self._check(serial)
        if self.preferences["read_only"]:
            raise ValueError("Somente leitura: comandos de entrada bloqueados.")
        self.log.append(("action", serial, kind, dict(values)))

    def screenshot(self, serial, output):
        self._check(serial)
        data = QByteArray()
        buffer = QBuffer(data)
        buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        if not _synthetic_image().save(buffer, "PNG"):
            raise RuntimeError("Não foi possível criar a imagem sintética.")
        buffer.close()
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(bytes(data))
        self.log.append(("screenshot", serial, str(output)))


class MainWindow(QMainWindow):
    def __init__(self, bridge=None, demo=False):
        super().__init__()
        if bridge is None:
            if demo:
                bridge = DemoBridge()
            else:
                from .bridge import DesktopBridge
                bridge = DesktopBridge()
        self.bridge = bridge
        self.demo = bool(demo or isinstance(bridge, DemoBridge))
        self.setObjectName("ponteMainWindow")
        self.setWindowTitle("ponte. / desktop" + (" • Demonstração" if self.demo else ""))
        icon_path = Path(__file__).resolve().parent.parent / "public" / "icon-512.png"
        if icon_path.is_file():
            self.setWindowIcon(QIcon(str(icon_path)))
        self.setMinimumSize(980, 680)
        self.resize(1140, 850)
        self.setStyleSheet(STYLE)
        self._snapshot = {}
        self._requested_serial = None
        self._preferences_loaded = False
        self._address_suggested = False
        self._status_error = False
        self._busy = False
        self._closing = False
        self._worker = None
        self._job_callback = None
        self._job_error = None
        self._pool = QThreadPool(self)
        self._pool.setMaxThreadCount(1)
        self._process = None
        self._demo_dialog = None
        self.process_state = "stopped"
        self._stop_requested = False
        self._secrets = set()
        self._kill_timer = QTimer(self)
        self._kill_timer.setSingleShot(True)
        self._kill_timer.timeout.connect(self._kill_own_process)
        self._close_timer = QTimer(self)
        self._close_timer.setInterval(25)
        self._close_timer.timeout.connect(self._try_close)
        self._build_ui()
        self._update_controls()
        QTimer.singleShot(0, self.refresh_status)

    @staticmethod
    def _label(text, name=None, heading=False, muted=False):
        label = QLabel(text)
        label.setWordWrap(True)
        label.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Minimum)
        label.setTextFormat(Qt.TextFormat.PlainText)
        if name:
            label.setObjectName(name)
        label.setProperty("heading", heading)
        label.setProperty("muted", muted)
        return label

    @staticmethod
    def _button(text, name, primary=False):
        button = QPushButton(text)
        button.setObjectName(name)
        button.setAccessibleName(text)
        button.setProperty("primary", primary)
        button.setCursor(Qt.CursorShape.PointingHandCursor)
        return button

    @staticmethod
    def _card():
        card = QFrame()
        card.setProperty("card", True)
        layout = QVBoxLayout(card)
        layout.setContentsMargins(22, 20, 22, 20)
        layout.setSpacing(12)
        return card, layout

    def _build_ui(self):
        root = QWidget()
        root.setObjectName("root")
        scroll = QScrollArea()
        scroll.setObjectName("contentScroll")
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(root)
        self.setCentralWidget(scroll)
        page = QVBoxLayout(root)
        page.setSizeConstraint(QLayout.SizeConstraint.SetMinimumSize)
        page.setContentsMargins(24, 20, 24, 16)
        page.setSpacing(12)
        header = QHBoxLayout()
        brand = QVBoxLayout()
        brand.addWidget(self._label("ponte. / desktop", "brandLabel"))
        brand.addWidget(self._label("Seu celular, no computador.", "subtitleLabel"))
        header.addLayout(brand)
        header.addStretch()
        self.status_label = self._label("Conferindo conexão…", "statusLabel")
        header.addWidget(self.status_label, 0, Qt.AlignmentFlag.AlignVCenter)
        page.addLayout(header)
        if self.demo:
            banner = self._label("DEMONSTRAÇÃO  •  Sem aparelho conectado. Nada aqui envia comandos reais.", "demoBanner")
            page.addWidget(banner)
        columns = QHBoxLayout()
        columns.setSpacing(18)
        left, connection = self._card()
        left.setFixedWidth(370)
        connection.addWidget(self._label("01   Conexão", heading=True))
        connection.addWidget(self._label("Use o endereço do celular no Tailscale ou na rede local.", muted=True))
        connection.addWidget(self._label("Endereço do celular"))
        self.address_field = QLineEdit()
        self.address_field.setObjectName("addressField")
        self.address_field.setAccessibleName("Endereço do celular")
        self.address_field.setPlaceholderText("100.x.x.x:5555")
        connection.addWidget(self.address_field)
        self.connect_button = self._button("Conectar", "connectButton", True)
        self.connect_button.clicked.connect(self._connect)
        connection.addWidget(self.connect_button)
        connection.addWidget(self._label("Aparelho selecionado"))
        self.device_combo = QComboBox()
        self.device_combo.setObjectName("deviceCombo")
        self.device_combo.setAccessibleName("Aparelho para controlar")
        self.device_combo.currentIndexChanged.connect(self._update_controls)
        connection.addWidget(self.device_combo)
        selection = QHBoxLayout()
        self.refresh_button = self._button("Atualizar", "refreshButton")
        self.refresh_button.clicked.connect(self.refresh_status)
        self.select_button = self._button("Selecionar", "selectButton")
        self.select_button.clicked.connect(self._select)
        selection.addWidget(self.refresh_button)
        selection.addWidget(self.select_button)
        connection.addLayout(selection)
        self.disconnect_button = self._button("Desconectar aparelho", "disconnectButton")
        self.disconnect_button.clicked.connect(self._disconnect)
        connection.addWidget(self.disconnect_button)
        self.pair_toggle = QToolButton()
        self.pair_toggle.setObjectName("pairToggle")
        self.pair_toggle.setText("Pareamento sem fio")
        self.pair_toggle.setCheckable(True)
        self.pair_toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.pair_toggle.setArrowType(Qt.ArrowType.RightArrow)
        connection.addWidget(self.pair_toggle)
        self.pair_panel = QWidget()
        self.pair_panel.setObjectName("pairPanel")
        pairing = QVBoxLayout(self.pair_panel)
        pairing.setContentsMargins(0, 0, 0, 0)
        pairing.addWidget(self._label("Android 11+: abra Depuração sem fio e use a porta de pareamento, não a de conexão.", muted=True))
        self.pair_address = QLineEdit()
        self.pair_address.setObjectName("pairAddressField")
        self.pair_address.setAccessibleName("Endereço de pareamento")
        self.pair_address.setPlaceholderText("Endereço de pareamento:porta")
        self.pair_code = QLineEdit()
        self.pair_code.setObjectName("pairCodeField")
        self.pair_code.setAccessibleName("Código de pareamento")
        self.pair_code.setPlaceholderText("Código mostrado no celular")
        self.pair_code.setEchoMode(QLineEdit.EchoMode.Password)
        self.pair_code.setMaxLength(32)
        self.pair_button = self._button("Parear", "pairButton")
        self.pair_button.clicked.connect(self._pair)
        pairing.addWidget(self.pair_address)
        pairing.addWidget(self.pair_code)
        pairing.addWidget(self.pair_button)
        self.pair_panel.hide()
        self.pair_toggle.toggled.connect(self._toggle_pairing)
        connection.addWidget(self.pair_panel)
        connection.addStretch()
        self.dependencies_label = self._label("Conferindo ferramentas…", "dependenciesLabel", muted=True)
        connection.addWidget(self.dependencies_label)
        connection.addWidget(self._label("Nenhuma conexão é feita sozinha. Seu aparelho precisa autorizar a depuração USB.", muted=True))
        columns.addWidget(left)
        right, experience = self._card()
        experience.setSpacing(9)
        experience.addWidget(self._label("02   Do seu jeito", heading=True))
        intro_widget = QWidget()
        intro_widget.setObjectName("experienceIntro")
        intro_widget.setMinimumHeight(200)
        intro = QHBoxLayout(intro_widget)
        intro.setContentsMargins(0, 0, 0, 0)
        illustration = PhoneIllustration()
        intro.addWidget(illustration, 1)
        guidance = QVBoxLayout()
        guidance.setSpacing(8)
        guidance.addWidget(self._label("Uma tela só sua.", heading=True))
        guidance.addWidget(self._label("1. Conecte e selecione seu celular.\n2. Escolha qualidade e permissões.\n3. Abra a tela pra usar mouse e teclado.", muted=True))
        guidance.addWidget(self._label("O scrcpy abre em uma janela separada.\nA figura ao lado é só uma ilustração.", "previewDisclaimer", muted=True))
        intro.addLayout(guidance, 2)
        experience.addWidget(intro_widget, 1)
        settings = QHBoxLayout()
        settings.addWidget(self._label("Qualidade"))
        self.profile_combo = QComboBox()
        self.profile_combo.setObjectName("profileCombo")
        self.profile_combo.setAccessibleName("Perfil de qualidade")
        for label, value in PROFILES:
            self.profile_combo.addItem(label, value)
        self.profile_combo.setCurrentIndex(1)
        settings.addWidget(self.profile_combo, 1)
        self.preferences_button = self._button("Aplicar", "savePreferencesButton")
        self.preferences_button.clicked.connect(self._save_preferences)
        settings.addWidget(self.preferences_button)
        experience.addLayout(settings)
        permissions = QHBoxLayout()
        self.audio_check = QCheckBox("Áudio")
        self.audio_check.setObjectName("audioCheck")
        self.clipboard_check = QCheckBox("Clipboard")
        self.clipboard_check.setObjectName("clipboardCheck")
        self.clipboard_check.setToolTip("Permite compartilhar a área de transferência com o celular.")
        self.read_only_check = QCheckBox("Somente leitura")
        self.read_only_check.setObjectName("readOnlyCheck")
        self.read_only_check.toggled.connect(self._update_controls)
        for check in (self.audio_check, self.clipboard_check, self.read_only_check):
            permissions.addWidget(check)
        experience.addLayout(permissions)
        self.start_button = self._button("Abrir tela do celular", "startButton", True)
        self.start_button.clicked.connect(self._start_mirror)
        experience.addWidget(self.start_button)
        controls = QHBoxLayout()
        self.stop_button = self._button("Encerrar controle", "stopButton")
        self.stop_button.clicked.connect(self._stop_mirror)
        self.screenshot_button = self._button("Salvar captura", "screenshotButton")
        self.screenshot_button.clicked.connect(self._screenshot)
        controls.addWidget(self.stop_button)
        controls.addWidget(self.screenshot_button)
        experience.addLayout(controls)
        navigation = QGridLayout()
        self.action_buttons = {}
        for index, (label, name, kind) in enumerate((
            ("Voltar", "backButton", "back"), ("Início", "homeButton", "home"),
            ("Recentes", "recentsButton", "recents"), ("Acordar", "wakeButton", "wake"),
            ("Volume −", "volumeDownButton", "volume_down"), ("Volume +", "volumeUpButton", "volume_up"),
        )):
            button = self._button(label, name)
            button.clicked.connect(lambda checked=False, action=kind: self._action(action))
            self.action_buttons[kind] = button
            navigation.addWidget(button, index // 3, index % 3)
        experience.addLayout(navigation)
        self.process_status_label = self._label("Tela fechada", "processStatusLabel", muted=True)
        experience.addWidget(self.process_status_label)
        columns.addWidget(right, 1)
        page.addLayout(columns, 1)
        self.message_label = self._label("Só o aparelho selecionado recebe comandos.", "messageLabel")
        page.addWidget(self.message_label)
        self.log_view = QPlainTextEdit()
        self.log_view.setObjectName("logView")
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumHeight(76)
        self.log_view.document().setMaximumBlockCount(100)
        self.log_view.setPlaceholderText("Atividade da sessão")
        page.addWidget(self.log_view)

    def set_requested_serial(self, serial):
        """Preselect a candidate, never call bridge.select without a click."""
        self._requested_serial = serial
        if self._snapshot:
            self._apply_status(self._snapshot)

    def _toggle_pairing(self, expanded):
        self.pair_panel.setVisible(expanded)
        self.pair_toggle.setArrowType(Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow)

    def _redact(self, text):
        text = str(text)
        for secret in sorted(self._secrets, key=len, reverse=True):
            if secret:
                text = text.replace(secret, "[oculto]")
        return re.sub(r"(?i)((?:pairing[ _-]?code|password|código)\s*[:=]\s*)\S+", r"\1[oculto]", text)

    def _log(self, text):
        text = self._redact(text)[-LOG_LIMIT:]
        combined = (self.log_view.toPlainText() + "\n" + text).strip()[-LOG_LIMIT:]
        self.log_view.setPlainText(combined)
        scrollbar = self.log_view.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _message(self, text, error=False):
        self.message_label.setText(self._redact(text)[-1000:])
        self.message_label.setProperty("error", error)
        self.message_label.style().unpolish(self.message_label)
        self.message_label.style().polish(self.message_label)
        self._log(text)

    def _submit(self, label, operation, callback=None, on_error=None):
        if self._busy or self._closing:
            return False
        self._busy = True
        self._job_callback = callback
        self._job_error = on_error
        self._message(label)
        self._update_controls()
        self._worker = _Worker(operation)
        self._worker.signals.completed.connect(self._job_finished)
        self._pool.start(self._worker)
        return True

    @Slot(object, object)
    def _job_finished(self, value, error):
        callback, on_error = self._job_callback, self._job_error
        self._job_callback = self._job_error = None
        self._busy = False
        if not self._closing:
            if error is not None:
                if on_error:
                    on_error()
                self._message("Não deu certo: " + error, error=True)
            elif callback:
                try:
                    callback(value)
                except Exception as exc:
                    if on_error:
                        on_error()
                    self._message("Não deu certo: " + str(exc), error=True)
        self._update_controls()
        self._try_close()

    def _mutation(self, label, operation, success):
        def work():
            value = operation()
            return value, self.bridge.status()

        def done(result):
            value, snapshot = result
            self._apply_status(snapshot)
            errors = self._status_errors()
            self._message(success + (" Não consegui conferir o estado: " + errors if errors else ""), bool(errors))
            if self._demo_dialog is not None:
                self._demo_dialog.findChild(QLabel, "demoActivityLabel").setText(success)

        self._submit(label, work, done)

    def refresh_status(self):
        self._submit("Conferindo aparelhos…", self.bridge.status, self._status_ready, self._status_failed)

    def _status_ready(self, snapshot):
        self._apply_status(snapshot)
        errors = self._status_errors()
        self._message("Não consegui conferir os aparelhos: " + errors if errors else "Lista atualizada. Nenhuma conexão foi iniciada.", bool(errors))

    def _status_failed(self):
        self._snapshot = {}
        self._status_error = True

    def _status_errors(self):
        return "; ".join(str(error.get("message", error.get("code", "Erro desconhecido"))) if isinstance(error, dict) else str(error) for error in self._snapshot.get("errors", []))

    @staticmethod
    def _network_serial(serial):
        if not isinstance(serial, str) or not re.fullmatch(r"(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):[0-9]{1,5}", serial):
            return False
        return 0 < int(serial.rsplit(":", 1)[1]) <= 65535

    def _apply_status(self, snapshot):
        if not isinstance(snapshot, dict):
            raise ValueError("O bridge retornou um status inválido.")
        self._snapshot = snapshot
        self._status_error = False
        previous = self.device_combo.currentData()
        selected = snapshot.get("selected")
        if not self._address_suggested:
            self._address_suggested = True
            if not self.address_field.text() and self._network_serial(selected):
                self.address_field.setText(selected)
        candidate = self._requested_serial or previous or selected
        self.device_combo.blockSignals(True)
        self.device_combo.clear()
        self.device_combo.addItem("Selecione um aparelho…", None)
        states = {"device": "online", "online": "online", "offline": "offline", "unauthorized": "não autorizado"}
        for device in snapshot.get("devices", []):
            serial = device.get("serial")
            if not serial:
                continue
            state = states.get(device.get("state"), device.get("state", "desconhecido"))
            model = str(device.get("model") or serial).replace("_", " ")
            self.device_combo.addItem(f"{model} · {serial} · {state}", serial)
        index = self.device_combo.findData(candidate)
        if candidate and index < 0:
            self.device_combo.addItem(f"{candidate} · não encontrado", candidate)
            index = self.device_combo.count() - 1
        self.device_combo.setCurrentIndex(max(0, index))
        self.device_combo.blockSignals(False)
        if not self._preferences_loaded:
            prefs = snapshot.get("preferences", {})
            index = self.profile_combo.findData(prefs.get("profile", "balanced"))
            self.profile_combo.setCurrentIndex(max(0, index))
            self.audio_check.setChecked(bool(prefs.get("audio", False)))
            self.clipboard_check.setChecked(bool(prefs.get("clipboard", False)))
            self.read_only_check.setChecked(bool(prefs.get("read_only", False)))
            self._preferences_loaded = True
        self._update_controls()

    def _target(self):
        selected = self._snapshot.get("selected")
        return selected if selected and self.device_combo.currentData() == selected else None

    def _online(self):
        target = self._target()
        return bool(target and not self._status_errors() and any(d.get("serial") == target and d.get("state") in ("device", "online") for d in self._snapshot.get("devices", [])))

    def _active(self):
        return self._process is not None or self._demo_dialog is not None or self.process_state in ("starting", "running", "stopping")

    def _update_controls(self, *_):
        if not hasattr(self, "start_button"):
            return
        deps = self._snapshot.get("dependencies", {})
        missing = [name for name in ("adb", "scrcpy", "pyside6") if not deps.get(name)]
        self.dependencies_label.setText("Faltando: " + ", ".join(missing) if missing else ("Modo demo: ferramentas simuladas" if self.demo else "adb + scrcpy + PySide6 prontos"))
        idle = not self._busy and not self._closing
        editable = idle and not self._active()
        adb = bool(deps.get("adb"))
        for widget in (self.address_field, self.device_combo, self.pair_toggle, self.pair_address, self.pair_code):
            widget.setEnabled(editable)
        self.refresh_button.setEnabled(editable)
        self.connect_button.setEnabled(editable and adb)
        self.pair_button.setEnabled(editable and adb)
        self.select_button.setEnabled(editable and adb and bool(self.device_combo.currentData()))
        network_target = bool(self._target()) and (self.demo or self._network_serial(self._target()))
        self.disconnect_button.setEnabled(editable and adb and network_target)
        self.disconnect_button.setToolTip("Desconecta somente este endereço de rede." if network_target else "Para USB, retire o cabo. Desconectar só vale para endereços de rede.")
        for widget in (self.profile_combo, self.audio_check, self.clipboard_check, self.read_only_check, self.preferences_button):
            widget.setEnabled(editable)
        self.start_button.setEnabled(editable and self._online() and not missing)
        self.stop_button.setEnabled(not self._closing and not self._stop_requested and (self._process is not None or self._demo_dialog is not None))
        self.screenshot_button.setEnabled(idle and adb and self._online())
        can_input = idle and adb and self._online() and not self.read_only_check.isChecked() and self.process_state not in ("starting", "stopping")
        for button in self.action_buttons.values():
            button.setEnabled(can_input)
        target = self._target()
        state = next((d.get("state") for d in self._snapshot.get("devices", []) if d.get("serial") == target), None)
        if self._closing:
            status = "Encerrando com segurança…"
        elif self._busy:
            status = "Trabalhando…"
        elif self._status_error:
            status = "Não foi possível conferir"
        elif missing:
            status = "Dependências faltando"
        elif self._status_errors():
            status = "Falha ao conferir aparelhos"
        elif self.process_state == "error":
            status = "Controle interrompido · confira a atividade"
        elif self.process_state == "starting":
            status = "Abrindo demonstração…" if self.demo else "Abrindo tela do celular…"
        elif self.process_state == "stopping":
            status = "Encerrando demonstração…" if self.demo else "Encerrando controle…"
        elif self.process_state == "running":
            if self.demo:
                status = "Demo · somente leitura" if self.read_only_check.isChecked() else "Demonstração ativa"
            else:
                status = "Somente leitura · tela aberta" if self.read_only_check.isChecked() else "Controle ativo · tela aberta"
        elif not target:
            status = "Selecione um aparelho"
        elif state == "unauthorized":
            status = "Não autorizado · confirme no celular"
        elif self._online():
            status = "Demo online" if self.demo else "Online · pronto pra abrir"
        else:
            status = "Offline · confira a conexão"
        self.status_label.setText(status)
        self.process_status_label.setText({
            "starting": "Abrindo uma janela separada…", "running": "Demonstração aberta · sem aparelho real" if self.demo else "scrcpy aberto em uma janela separada",
            "stopping": "Encerrando nossa janela…", "error": "A tela não abriu ou foi interrompida. Confira a atividade.", "stopped": "Tela fechada · nenhuma transmissão neste painel",
        }[self.process_state])

    def _preferences(self):
        return dict(profile=self.profile_combo.currentData(), audio=self.audio_check.isChecked(), clipboard=self.clipboard_check.isChecked(), read_only=self.read_only_check.isChecked())

    def _connect(self):
        if not self.connect_button.isEnabled():
            return
        address = self.address_field.text().strip()
        if not address and not self.demo:
            self._message("Preencha o endereço do celular, incluindo a porta.", True)
            return
        self._mutation("Conectando ao endereço informado…", lambda: self.bridge.connect(address or "emulator-demo"), "Conexão solicitada. Confira o aparelho e clique em Selecionar.")

    def _select(self):
        if not self.select_button.isEnabled():
            return
        serial = self.device_combo.currentData()
        self._requested_serial = None
        self._mutation("Selecionando aparelho…", lambda: self.bridge.select(serial), f"Aparelho selecionado: {serial}")

    def _disconnect(self):
        if self.disconnect_button.isEnabled():
            serial = self._target()
            self._mutation("Desconectando aparelho selecionado…", lambda: self.bridge.disconnect(serial), "Aparelho desconectado.")

    def _pair(self):
        if not self.pair_button.isEnabled():
            return
        address, code = self.pair_address.text().strip(), self.pair_code.text().strip()
        if not address or not code:
            self._message("Preencha o endereço e o código de pareamento.", True)
            return
        self._secrets.add(code)
        self.pair_code.clear()
        self._mutation("Pareando com o celular…", lambda: self.bridge.pair(address, code), "Pareamento concluído. Use agora o endereço de conexão em Conectar.")

    def _save_preferences(self):
        if self.preferences_button.isEnabled():
            preferences = self._preferences()
            self._mutation("Salvando preferências…", lambda: self.bridge.save_preferences(**preferences), "Preferências salvas. Valem na próxima tela aberta.")

    def _action(self, kind):
        if kind not in self.action_buttons or not self.action_buttons[kind].isEnabled():
            return
        serial = self._target()
        self._mutation("Enviando comando ao aparelho selecionado…", lambda: self.bridge.action(serial, kind, {}), f"Comando enviado: {self.action_buttons[kind].text()}")

    def _screenshot(self):
        if not self.screenshot_button.isEnabled():
            return
        serial = self._target()
        output, _ = QFileDialog.getSaveFileName(self, "Salvar imagem sintética" if self.demo else "Salvar captura do celular", "ponte-demo.png" if self.demo else "ponte-captura.png", "Imagem PNG (*.png)")
        if not output:
            return
        if not output.lower().endswith(".png"):
            output += ".png"
        if Path(output).exists():
            self._message("Esse arquivo já existe. Escolha outro nome, não sobrescrevemos capturas.", True)
            return
        self._mutation("Salvando imagem sintética…" if self.demo else "Capturando só o aparelho selecionado…", lambda: self.bridge.screenshot(serial, output), "Imagem sintética salva." if self.demo else "Captura salva.")

    def _start_mirror(self):
        if not self.start_button.isEnabled():
            return
        serial, preferences = self._target(), self._preferences()
        self.process_state = "starting"
        self._stop_requested = False

        def work():
            self.bridge.save_preferences(**preferences)
            return self.bridge.mirror_command(serial, **preferences)

        self._submit("Conferindo o aparelho antes de abrir a tela…", work, self._launch_mirror, self._mirror_failed)

    def _mirror_failed(self):
        self.process_state = "error"

    def _launch_mirror(self, command):
        if not isinstance(command, (list, tuple)) or not command or any(not isinstance(arg, str) or "\x00" in arg for arg in command) or not command[0]:
            raise ValueError("O bridge não retornou um comando válido. Nenhum processo foi iniciado.")
        if self.demo:
            dialog = QDialog(self)
            dialog.setObjectName("demoViewer")
            dialog.setWindowTitle("Ponte • Demonstração")
            dialog.setStyleSheet(STYLE)
            dialog.resize(370, 570)
            layout = QVBoxLayout(dialog)
            layout.addWidget(self._label("DEMONSTRAÇÃO", heading=True))
            layout.addWidget(self._label("Sem aparelho conectado. Esta imagem é sintética.", "demoDisclaimer"))
            layout.addWidget(PhoneIllustration(demo=True), 1)
            layout.addWidget(self._label("Os botões só registram ações de teste.", "demoActivityLabel"))
            close = self._button("Fechar demonstração", "closeDemoButton")
            close.clicked.connect(dialog.close)
            layout.addWidget(close)
            dialog.finished.connect(self._demo_finished)
            self._demo_dialog = dialog
            dialog.show()
            self.process_state = "running"
            self._message("Demonstração aberta. Nenhum processo scrcpy ou ADB foi iniciado.")
            return
        process = QProcess(self)
        self._process = process
        process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        process.readyReadStandardOutput.connect(self._read_process_output)
        process.started.connect(self._process_started)
        process.finished.connect(self._process_finished)
        process.errorOccurred.connect(self._process_error)
        process.setProgram(command[0])
        process.setArguments(list(command[1:]))
        process.start()

    def _process_started(self):
        if self._closing or self._stop_requested:
            self._stop_mirror()
            return
        self.process_state = "running"
        self._message("Tela aberta em uma janela separada do scrcpy.")
        self._update_controls()

    def _read_process_output(self):
        if self._process is not None:
            data = bytes(self._process.readAllStandardOutput())
            self._log(data[-LOG_LIMIT:].decode("utf-8", errors="replace"))

    def _process_error(self, error):
        if self._process is None:
            return
        if not self._stop_requested:
            self.process_state = "error"
            self._message("O scrcpy não pôde continuar: " + self._process.errorString(), True)
        if error == QProcess.ProcessError.FailedToStart:
            self._release_process()
        self._update_controls()
        self._try_close()

    def _process_finished(self, exit_code, exit_status):
        self._read_process_output()
        stopped = self._stop_requested or (exit_code == 0 and exit_status == QProcess.ExitStatus.NormalExit)
        self.process_state = "stopped" if stopped else "error"
        self._message("Tela encerrada." if stopped else f"O scrcpy saiu inesperadamente (código {exit_code}).", not stopped)
        self._release_process()
        self._update_controls()
        self._try_close()

    def _release_process(self):
        self._kill_timer.stop()
        process, self._process = self._process, None
        if process is not None:
            process.deleteLater()

    def _demo_finished(self, _result):
        dialog, self._demo_dialog = self._demo_dialog, None
        if dialog is not None:
            dialog.deleteLater()
        self.process_state = "stopped"
        self._update_controls()
        self._try_close()

    def _stop_mirror(self):
        self._stop_requested = True
        if self._demo_dialog is not None:
            self._demo_dialog.close()
        elif self._process is not None:
            self.process_state = "stopping"
            self._process.terminate()
            self._kill_timer.start(1500)
        self._update_controls()

    def _kill_own_process(self):
        if self._process is not None and self._process.state() != QProcess.ProcessState.NotRunning:
            self._process.kill()

    def closeEvent(self, event):
        if self._busy or self._pool.activeThreadCount() or self._process is not None or self._demo_dialog is not None:
            event.ignore()
            self._closing = True
            self._stop_mirror()
            self._close_timer.start()
            self._update_controls()
            return
        self._closing = True
        self._close_timer.stop()
        self._kill_timer.stop()
        event.accept()

    def _try_close(self):
        if self._closing and not self._busy and not self._pool.activeThreadCount() and self._process is None and self._demo_dialog is None:
            self._close_timer.stop()
            self.close()


def main(argv=None, bridge=None) -> int:
    parser = argparse.ArgumentParser(description="Ponte desktop: seu celular, no computador.")
    parser.add_argument("--demo", action="store_true", help="demonstração sintética, sem ADB ou aparelho real")
    parser.add_argument("--serial", help="pré-seleciona um candidato, confirme no botão Selecionar")
    args = parser.parse_args(argv)
    application = QApplication.instance()
    owns_application = application is None
    if owns_application:
        application = QApplication(["ponte-desktop"])
        application.setApplicationName("ponte-desktop")
        application.setOrganizationName("Ponte")
        application.setDesktopFileName("ponte-desktop")
    try:
        window = MainWindow(bridge=bridge, demo=args.demo)
    except Exception as exc:
        from .bridge import BridgeError
        if not isinstance(exc, BridgeError):
            raise
        box = QMessageBox()
        box.setWindowTitle("Ponte • Não foi possível abrir")
        box.setIcon(QMessageBox.Icon.Critical)
        box.setTextFormat(Qt.TextFormat.PlainText)
        box.setText(exc.message)
        box.setInformativeText("Confira a configuração do desktop e tente de novo.")
        box.setStandardButtons(QMessageBox.StandardButton.Close)
        box.exec()
        return 2
    if args.serial:
        window.set_requested_serial(args.serial)
    # Keep an owned reference when embedded in an existing Qt application.
    windows = getattr(application, "_ponte_windows", None)
    if windows is None:
        windows = application._ponte_windows = []
    windows.append(window)
    window.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
    window.destroyed.connect(lambda: windows.remove(window) if window in windows else None)
    window.show()
    return int(application.exec()) if owns_application else 0

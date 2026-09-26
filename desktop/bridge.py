"""Stdlib-only desktop companion. Importing/constructing never starts ADB or a GUI.

All device methods require an explicit serial, never the saved selection. ADB uses
its supported ``-s SERIAL`` spelling, scrcpy uses ``--serial SERIAL``. Connect and
pair are the only pre-authorization operations, addressed by a canonical endpoint.
The injected runner follows subprocess.run's signature and returns stdout bytes.
CLI/UI adapters own process launch for the argv returned by mirror_command().
"""

import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import stat
import subprocess

__all__ = ["BridgeError", "DesktopBridge", "schema"]

_TIMEOUT = 8
_PAIR_TIMEOUT = 15
_MAX_JSON = 64 * 1024
_MAX_PNG = 20 * 1024 * 1024
_MAX_TEXT = 1024
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PROFILES = {
    "light": (720, 30, "2M"),
    "balanced": (1280, 45, "4M"),
    "sharp": (1920, 60, "8M"),
}
_DEFAULT_PREFERENCES = {
    "profile": "balanced", "audio": False, "clipboard": False, "read_only": False,
}
_KEYS = {
    "BACK": 4, "HOME": 3, "APP_SWITCH": 187, "POWER": 26,
    "VOLUME_UP": 24, "VOLUME_DOWN": 25, "MUTE": 164, "WAKEUP": 224,
}
_ALIASES = {
    "back": "BACK", "home": "HOME", "recents": "APP_SWITCH", "wake": "WAKEUP",
    "power": "POWER", "volume_up": "VOLUME_UP", "volume_down": "VOLUME_DOWN",
    "mute": "MUTE",
}
_NETWORKS = tuple(ipaddress.IPv4Network(value) for value in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8",
))
_SERIAL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}\Z", re.ASCII)


class BridgeError(Exception):
    """Stable machine-readable code plus a safe message, never raw command output."""

    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(message)


def _absolute(value):
    try:
        value = os.fspath(value)
    except TypeError:
        raise BridgeError("invalid_path", "Use an absolute filesystem path.") from None
    if (not isinstance(value, str) or not value.startswith("/")
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or ".." in value.split("/")):
        raise BridgeError("invalid_path", "Use an absolute path without traversal or controls.")
    return Path(value)


def _serial(value):
    if not isinstance(value, str) or not _SERIAL.fullmatch(value):
        raise BridgeError("invalid_serial", "An explicit, valid ADB serial is required.")
    return value


def _address(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9.]+:[1-9][0-9]{0,4}", value):
        raise BridgeError("invalid_address", "Use a canonical private IPv4 address:port.")
    host, port = value.split(":")
    try:
        ip = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError:
        raise BridgeError("invalid_address", "Use a canonical private IPv4 address:port.") from None
    if str(ip) != host or int(port) > 65535 or not any(ip in net for net in _NETWORKS):
        raise BridgeError("invalid_address", "Only RFC1918, tailnet or loopback IPv4 ports are allowed.")
    return value


def _preferences(profile="balanced", audio=False, clipboard=False, read_only=False):
    if not isinstance(profile, str) or profile not in _PROFILES:
        raise BridgeError("invalid_preferences", "Profile must be light, balanced or sharp.")
    if any(type(value) is not bool for value in (audio, clipboard, read_only)):
        raise BridgeError("invalid_preferences", "Audio, clipboard and read_only must be booleans.")
    return dict(profile=profile, audio=audio, clipboard=clipboard, read_only=read_only)


def _open_directory(path, *, create=False, private=False):
    """Walk using directory descriptors so no ancestor symlink is followed."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        for component in path.parts[1:]:
            if create:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if private and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
            raise BridgeError("unsafe_file", "Desktop state needs a user-owned 0700 directory.")
        result, fd = fd, None
        return result
    finally:
        if fd is not None:
            os.close(fd)


def _check_private_file(info):
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > _MAX_JSON):
        raise BridgeError("unsafe_file", "Private JSON must be owned, regular, single-link, 0600 and at most 64 KiB.")


def _read_private_json(path, *, optional=True, private_parent=False):
    parent = fd = None
    try:
        parent = _open_directory(path.parent, private=private_parent)
        _check_private_file(os.stat(path.name, dir_fd=parent, follow_symlinks=False))
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        _check_private_file(os.fstat(fd))
        with os.fdopen(fd, "rb") as stream:
            fd = None
            raw = stream.read(_MAX_JSON + 1)
        if len(raw) > _MAX_JSON:
            raise BridgeError("unsafe_file", "Private JSON exceeds 64 KiB.")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise BridgeError("invalid_config", "Private JSON must contain an object.")
        return value
    except FileNotFoundError:
        if optional:
            return None
        raise BridgeError("config_missing", "The explicit Ponte configuration is missing.") from None
    except (UnicodeError, ValueError, RecursionError):
        raise BridgeError("invalid_config", "Private JSON is invalid.") from None
    except OSError:
        raise BridgeError("unsafe_file", "Cannot safely read the private JSON file.") from None
    finally:
        if fd is not None:
            os.close(fd)
        if parent is not None:
            os.close(parent)


class DesktopBridge:
    """Synchronous API with bounded, captured subprocess calls and private state.

    env, when supplied, replaces os.environ rather than merging with it. Paths:
    PONTE_CONFIG > XDG_CONFIG_HOME/ponte/config.json > HOME/.config/ponte/config.json.
    Data: OMARCHY_REMOTE_DATA > config.dataDir > XDG_STATE_HOME/ponte > HOME default.
    Selection: desktop.json (including explicit null) > config.phone.address > phone.json.
    Loaded selection is only a UI hint, never implicit authorization or a connection.
    """

    def __init__(self, env=None, runner=None):
        self._env = dict(os.environ if env is None else env)
        self._runner = subprocess.run if runner is None else runner
        home = _absolute(self._env.get("HOME") or str(Path.home()))
        config_home = _absolute(self._env.get("XDG_CONFIG_HOME") or home / ".config")
        state_home = _absolute(self._env.get("XDG_STATE_HOME") or home / ".local/state")
        config_path = _absolute(self._env.get("PONTE_CONFIG") or config_home / "ponte/config.json")
        config = _read_private_json(config_path, optional=not bool(self._env.get("PONTE_CONFIG"))) or {}
        if "schemaVersion" in config and (type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1):
            raise BridgeError("invalid_config", "Unsupported Ponte configuration schema.")
        self._data_dir = _absolute(self._env.get("OMARCHY_REMOTE_DATA") or config.get("dataDir") or state_home / "ponte")
        saved = _read_private_json(self._data_dir / "desktop.json", private_parent=True) or {}
        preferences = saved.get("preferences", {})
        if not isinstance(preferences, dict):
            raise BridgeError("invalid_config", "Saved desktop preferences must be an object.")
        self._preferences = _preferences(**{
            key: preferences.get(key, default) for key, default in _DEFAULT_PREFERENCES.items()
        })
        if "selected" in saved:
            self._selected = None if saved["selected"] is None else _serial(saved["selected"])
        else:
            phone = config.get("phone") or {}
            if not isinstance(phone, dict):
                raise BridgeError("invalid_config", "Configured phone must be an object.")
            address = phone.get("address")
            if not address:
                legacy = _read_private_json(self._data_dir / "phone.json", private_parent=True) or {}
                address = legacy.get("address")
            self._selected = _address(address) if address else None

    def _run(self, arguments, *, pairing_input=None, binary=False):
        options = dict(check=True, capture_output=True, text=False,
                       timeout=_PAIR_TIMEOUT if pairing_input is not None else _TIMEOUT,
                       env=dict(self._env))
        if pairing_input is None:
            options["stdin"] = subprocess.DEVNULL
        else:
            options["input"] = pairing_input
        # Do not include output, arguments, or the underlying exception in errors.
        try:
            result = self._runner(["adb", *arguments], **options)
            if result.returncode != 0:
                raise BridgeError("command_failed", "ADB rejected the operation.")
        except FileNotFoundError:
            raise BridgeError("dependency_missing", "ADB is not installed or not on PATH.") from None
        except subprocess.TimeoutExpired:
            raise BridgeError("timeout", "ADB did not finish within the time limit.") from None
        except subprocess.CalledProcessError:
            raise BridgeError("command_failed", "ADB rejected the operation.") from None
        except (OSError, subprocess.SubprocessError):
            raise BridgeError("command_error", "ADB could not be executed.") from None
        output = result.stdout
        if isinstance(output, str) and not binary:
            output = output.encode("utf-8")
        if not isinstance(output, bytes):
            raise BridgeError("invalid_output", "ADB returned an unexpected output format.")
        if len(output) > (_MAX_PNG if binary else _MAX_JSON):
            raise BridgeError("output_too_large", "ADB output exceeded the size limit.")
        if binary:
            return output
        try:
            return output.decode("utf-8")
        except UnicodeError:
            raise BridgeError("invalid_output", "ADB returned invalid text.") from None

    def devices(self):
        """Return [{serial, state, model}], without selecting or connecting anything."""
        output = self._run(["devices", "-l"])
        devices, seen = [], set()
        header = False
        states = {"device", "offline", "unauthorized", "recovery", "sideload", "bootloader", "host", "connecting", "authorizing", "no permissions"}
        for line in output.splitlines():
            line = line.strip()
            if not line or line.startswith("* daemon"):
                continue
            if line == "List of devices attached":
                header = True
                continue
            if not header:
                raise BridgeError("invalid_output", "ADB device list has no header.")
            parts = line.split()
            if len(parts) < 2:
                raise BridgeError("invalid_output", "ADB device list is malformed.")
            try:
                serial = _serial(parts[0])
            except BridgeError:
                raise BridgeError("invalid_output", "ADB listed an invalid serial.") from None
            state = "no permissions" if parts[1:3] == ["no", "permissions"] else parts[1]
            if serial in seen or state not in states:
                raise BridgeError("invalid_output", "ADB device list is ambiguous or malformed.")
            seen.add(serial)
            model = next((part[6:] for part in parts[2:] if part.startswith("model:")), None)
            if model and (len(model) > 128 or not re.fullmatch(r"[A-Za-z0-9_.-]+", model)):
                model = None
            devices.append(dict(serial=serial, state=state, model=model))
        if not header:
            raise BridgeError("invalid_output", "ADB device list has no header.")
        return devices

    def _require_device(self, serial):
        serial = _serial(serial)
        device = next((item for item in self.devices() if item["serial"] == serial), None)
        if device is None:
            raise BridgeError("device_not_found", "The exact serial is not listed by ADB.")
        if device["state"] != "device":
            raise BridgeError("device_not_ready", "The exact device must be online and authorized.")
        return serial

    def status(self):
        """Non-connecting snapshot. Discovery failures become safe entries in errors."""
        try:
            pyside6 = importlib.util.find_spec("PySide6") is not None
        except (ImportError, ValueError, AttributeError):
            pyside6 = False
        dependencies = {
            name: shutil.which(name, path=self._env.get("PATH", os.defpath)) is not None
            for name in ("adb", "scrcpy")
        }
        dependencies["pyside6"] = pyside6
        devices, errors = [], []
        if dependencies["adb"]:
            try:
                devices = self.devices()
            except BridgeError as error:
                errors.append(dict(code=error.code, message=error.message))
        else:
            errors.append(dict(code="dependency_missing", message="ADB is not installed or not on PATH."))
        return dict(dependencies=dependencies, selected=self._selected, devices=devices,
                    preferences=dict(self._preferences), errors=errors)

    def _persist(self, selected, preferences):
        """Atomic 0600 replacement in a private 0700 directory, with no config copying."""
        parent = fd = None
        temporary = None
        created = False
        try:
            parent = _open_directory(self._data_dir, create=True, private=True)
            try:
                _check_private_file(os.stat("desktop.json", dir_fd=parent, follow_symlinks=False))
            except FileNotFoundError:
                pass
            temporary = ".desktop-" + secrets.token_hex(16)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=parent)
            created = True
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                fd = None
                json.dump(dict(selected=selected, preferences=preferences), stream, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, "desktop.json", src_dir_fd=parent, dst_dir_fd=parent)
            temporary = None
            os.fsync(parent)
        except OSError:
            raise BridgeError("persistence_failed", "Could not save private desktop preferences.") from None
        finally:
            if fd is not None:
                os.close(fd)
            if created and temporary is not None and parent is not None:
                try:
                    os.unlink(temporary, dir_fd=parent)
                except OSError:
                    pass
            if parent is not None:
                os.close(parent)
        self._selected = selected
        self._preferences = dict(preferences)

    def connect(self, address):
        """Connect only this endpoint, verify its list entry AND exact get-state, then save."""
        address = _address(address)
        output = self._run(["connect", address]).strip()
        if output not in (f"connected to {address}", f"already connected to {address}"):
            raise BridgeError("connect_failed", "ADB did not confirm the requested connection.")
        self._require_device(address)
        if self._run(["-s", address, "get-state"]).strip() != "device":
            raise BridgeError("device_not_ready", "The requested connection is not authorized and online.")
        self._persist(address, self._preferences)
        return address

    def pair(self, address, code):
        """Pair only. The six ASCII digits are sent on stdin, never argv or error text."""
        address = _address(address)
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
            raise BridgeError("invalid_pairing_code", "Pairing requires exactly six ASCII digits.")
        output = self._run(["pair", address], pairing_input=(code + "\n").encode("ascii"))
        # ADB can return exit status zero for pairing failures, so require its confirmation.
        if not re.search(r"(?:^|\n)(?:Enter pairing code: )?Successfully paired to " + re.escape(address) + r"(?:\s|$)", output):
            raise BridgeError("pair_failed", "ADB did not confirm pairing with the requested endpoint.")

    def select(self, serial):
        """Persist an explicitly listed and authorized serial. Return the serial string."""
        serial = self._require_device(serial)
        self._persist(serial, self._preferences)
        return serial

    def disconnect(self, serial):
        """Disconnect one online network endpoint only. Never issue global disconnect."""
        serial = _address(serial)
        self._require_device(serial)
        if self._run(["disconnect", serial]).strip() != f"disconnected {serial}":
            raise BridgeError("disconnect_failed", "ADB did not confirm disconnection of the requested endpoint.")
        if self._selected == serial:
            self._persist(None, self._preferences)

    def save_preferences(self, profile="balanced", audio=False, clipboard=False, read_only=False):
        """Save only validated settings and the existing selection. Return a fresh dict."""
        preferences = _preferences(profile, audio, clipboard, read_only)
        self._persist(self._selected, preferences)
        return dict(preferences)

    def mirror_command(self, serial, profile="balanced", audio=False, clipboard=False, read_only=False):
        """Return scrcpy argv, not a process. Preferences are explicit, never implicitly loaded."""
        preferences = _preferences(profile, audio, clipboard, read_only)
        _serial(serial)
        if shutil.which("scrcpy", path=self._env.get("PATH", os.defpath)) is None:
            raise BridgeError("dependency_missing", "scrcpy is not installed or not on PATH.")
        serial = self._require_device(serial)
        size, fps, bitrate = _PROFILES[preferences["profile"]]
        command = ["scrcpy", "--serial", serial, "--window-title", "Ponte · Celular",
                   "--video-codec=h264", f"--max-size={size}", f"--max-fps={fps}", f"--video-bit-rate={bitrate}"]
        if not audio:
            command.append("--no-audio")
        if not clipboard:
            command.append("--no-clipboard-autosync")
        if read_only:
            command.append("--no-control")
        return command

    def action(self, serial, kind, values):
        """Perform a bounded input action. values is a dict, validated before any ADB call.

        key: {key: uppercase allowlisted name}, aliases: {}, tap: {x,y},
        swipe: {x1,y1,x2,y2,duration}, text: {text: printable ASCII, 1..1024 chars}.
        Percent is refused because Android interprets %s. Use scrcpy for Unicode.
        Saved read_only blocks these actions too. WAKEUP does not unlock the device.
        """
        _serial(serial)
        if not isinstance(kind, str) or not isinstance(values, dict):
            raise BridgeError("invalid_action", "Use a supported action and a values object.")
        if kind in _ALIASES:
            if values:
                raise BridgeError("invalid_action", "Key aliases take an empty values object.")
            arguments = ["keyevent", str(_KEYS[_ALIASES[kind]])]
        elif kind == "key":
            if set(values) != {"key"} or not isinstance(values["key"], str) or values["key"] not in _KEYS:
                raise BridgeError("invalid_action", "Key is not in the supported allowlist.")
            arguments = ["keyevent", str(_KEYS[values["key"]])]
        elif kind in ("tap", "swipe"):
            fields = ("x", "y") if kind == "tap" else ("x1", "y1", "x2", "y2", "duration")
            if set(values) != set(fields):
                raise BridgeError("invalid_action", "Coordinates and duration must match the action schema.")
            for field in fields:
                minimum, maximum = (1, 2000) if field == "duration" else (0, 32767)
                if type(values[field]) is not int or not minimum <= values[field] <= maximum:
                    raise BridgeError("invalid_action", "Coordinates or duration are outside the allowed range.")
            arguments = [kind, *(str(values[field]) for field in fields)]
        elif kind == "text":
            text = values.get("text")
            if (set(values) != {"text"} or not isinstance(text, str) or not 1 <= len(text) <= _MAX_TEXT
                    or any(not 32 <= ord(char) <= 126 for char in text)):
                raise BridgeError("invalid_action", "Text must be 1..1024 printable ASCII characters on one line. Use scrcpy for Unicode.")
            if "%" in text:
                raise BridgeError("invalid_action", "Literal % is not supported by ADB input text. Use scrcpy instead.")
            arguments = ["text", text.replace(" ", "%s")]
        else:
            raise BridgeError("invalid_action", "Unsupported action kind.")
        if self._preferences["read_only"]:
            raise BridgeError("read_only", "Input actions are disabled by the saved read_only preference.")
        self._require_device(serial)
        # ADB shell joins argv remotely. Quote for that shell, not just the host subprocess.
        command = "input " + " ".join(shlex.quote(argument) for argument in arguments)
        self._run(["-s", serial, "shell", command])

    def screenshot(self, serial, output):
        """Save PNG bytes to a new absolute path, mode 0600. Never overwrite any entry.

        Return the absolute path string. The runner captures bytes, checked against
        20 MiB before writing. This is a payload limit, not a streaming memory limit.
        PNG signature and IHDR are checked, not a full image decode (stdlib only).
        """
        _serial(serial)
        output = _absolute(output)
        parent = fd = None
        created = False
        identity = None
        try:
            parent = _open_directory(output.parent)
            try:
                os.stat(output.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise BridgeError("output_exists", "Screenshot output already exists and will not be overwritten.")
            self._require_device(serial)
            image = self._run(["-s", serial, "exec-out", "screencap", "-p"], binary=True)
            if (len(image) < 33 or not image.startswith(_PNG_SIGNATURE + b"\x00\x00\x00\rIHDR")
                    or not 0 < int.from_bytes(image[16:20], "big") <= 32768
                    or not 0 < int.from_bytes(image[20:24], "big") <= 32768):
                raise BridgeError("invalid_png", "ADB did not return a PNG screenshot with a valid header.")
            fd = os.open(output.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=parent)
            created = True
            info = os.fstat(fd)
            identity = (info.st_dev, info.st_ino)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as stream:
                fd = None
                stream.write(image)
                stream.flush()
                os.fsync(stream.fileno())
            created = False
            return str(output)
        except FileExistsError:
            raise BridgeError("output_exists", "Screenshot output already exists and will not be overwritten.") from None
        except OSError:
            raise BridgeError("screenshot_failed", "Could not safely write the screenshot.") from None
        finally:
            if fd is not None:
                os.close(fd)
            if created:
                try:
                    info = os.stat(output.name, dir_fd=parent, follow_symlinks=False)
                    if identity == (info.st_dev, info.st_ino):
                        os.unlink(output.name, dir_fd=parent)
                except OSError:
                    # Never replace the original error or delete another writer's entry.
                    pass
            if parent is not None:
                os.close(parent)


def schema():
    """Return JSON-serializable adapter metadata. This module deliberately has no CLI."""
    return {
        "commands": {
            "status": "Inspect dependencies, saved selection and ADB devices without connecting.",
            "devices": "List ADB devices without choosing the first device.",
            "connect": "Connect one private IPv4:port and select only after exact authorization checks.",
            "pair": "Pair using a six-digit code on stdin, without connecting or selecting.",
            "select": "Save an explicitly authorized device serial.",
            "disconnect": "Disconnect one explicitly authorized network endpoint, never all devices.",
            "action": "Send an allowlisted bounded input action to an exact serial.",
            "screenshot": "Capture a PNG to a new private file without overwrite.",
            "save_preferences": "Save only selected and validated preferences in desktop.json.",
            "mirror_command": "Build scrcpy argv for an explicitly authorized serial without launching it.",
        },
        "profiles": {name: dict(max_size=size, max_fps=fps, video_bit_rate=bitrate)
                     for name, (size, fps, bitrate) in _PROFILES.items()},
        "preferences": dict(_DEFAULT_PREFERENCES),
        "actions": {
            "key": {"key": list(_KEYS)}, "aliases": dict(_ALIASES),
            "tap": ["x", "y"], "swipe": ["x1", "y1", "x2", "y2", "duration"], "text": ["text"],
        },
        "limits": {"coordinate": [0, 32767], "duration_ms": [1, 2000], "text_chars": _MAX_TEXT,
                   "screenshot_bytes": _MAX_PNG, "json_bytes": _MAX_JSON, "timeout_seconds": _TIMEOUT,
                   "pair_timeout_seconds": _PAIR_TIMEOUT},
    }

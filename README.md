<p align="center"><img src="docs/assets/hero.png" alt="Ponte concept artwork: a lime glass bridge connects a phone and desktop monitors" width="100%"></p>

<h1 align="center">ponte.</h1>
<p align="center"><strong>Your Omarchy desktop, within reach.</strong><br>Touch controls and live monitor views on your Android phone, over Tailscale.</p>
<p align="center"><a href="README.pt-BR.md">Português</a> · <a href="#try-it">Setup</a> · <a href="docs/evidence.md">Real device evidence</a> · <a href="docs/presentation.pdf">Presentation</a> · <a href="https://lucasol1337.github.io/ponte/">Project page</a> · <a href="CONTRIBUTING.md">Contribute</a></p>

Ponte started with a simple wish: open an app on my phone and use my Omarchy PC from wherever I am. Move the pointer, type a sentence, switch windows, and see what is happening on a monitor without rebuilding a desktop interface on a small screen.

This is an independent **experimental alpha**. Live video and persistent pairing have been verified on a Redmi Note 13 Pro+ running Android 14. The public setup builds an APK for your own PC. English is the default. Choose Portuguese in the language selector and Ponte remembers your preference. See the [tested scope and remaining work](docs/evidence.md) before installing.

## The interface

<p align="center"><img src="docs/assets/screen-single-mode.png" width="23%" alt="Screen page: the monitor fills the phone, with switch-monitor, rotate and mic buttons above the app navigation"> <img src="docs/assets/screen-keyboard.png" width="23%" alt="Screen page with the Android keyboard raised after tapping a text field on the PC"> <img src="docs/assets/home-lights-session.png" width="23%" alt="Home page: monitors all on/off, RGB presets, session lock, suspend and restart"> <img src="docs/assets/terminal-dictation.png" width="23%" alt="Terminals page with the Speak to terminal button and Run with Enter"></p>

<p align="center"><img src="docs/assets/screen-landscape.png" width="72%" alt="Forced landscape: the monitor edge to edge with the floating buttons on the right"></p>

These are Android 11 emulator captures of the current interface in Portuguese; the streamed desktop is pixelated because it is a real work session. The [original Redmi captures](docs/evidence.md#physical-android-device) document the first physical-device test. The cover is AI-generated concept art. See the [changelog](CHANGELOG.md) for what each alpha added and how it was verified.

## What it does

| Control | Behavior |
| --- | --- |
| Screen | Opens first. The monitor fills the phone: tap clicks, drag selects or moves like a held mouse button, long-press right-clicks or opens workspace dragging, pinch zooms, one finger pans while zoomed, and two fingers scroll the PC. Drop a long-pressed window on the workspace shelf to move that exact window. Tap a text field and the Android keyboard rises; what you type goes to the PC live |
| Screen buttons | Switch to the next monitor, force landscape edge to edge (and release it), dictate into the focused field |
| Terminals | Read and type in dedicated text sessions, or **speak**: the PC transcribes and types into the selected session, then presses Enter |
| Windows | Browse windows and workspaces, then focus the one you want |
| Media | Volume, mute, playback and track controls |
| Power | Per-monitor on/off, all monitors on/off, Smart sleep and Wake up, suspend, restart, double-confirmed power off; Wake-on-LAN status |
| Lights | Six RGB presets, lights off/restore, water-cooler screen on/off (through the Magma controller, optional) |
| Session | Lock, and unlock by typing your password through the app while the Omarchy lock is up |
| Voice | Record, review, send to the PC and play back |
| Pairing | Pair once. The app remembers the connection across restarts |

Live view is authenticated MJPEG. The default *Auto* profile starts light and climbs to *Sharp* (native pixels, up to 15 fps) while frames keep arriving on time, then backs off when the link lags, so the same app works on home Wi-Fi and on 4G. You can also pin *Sharp*, *Balanced* or *Light*. Zoom is a continuous transform on the phone, like Chrome Remote Desktop: the frame never gets re-cropped mid-pinch, and the *Sharp* profile stays crisp up to 1:1. It does not stream system audio. This is intended for desktop control and checking progress, not gaming.

The keyboard raise relies on fcitx5 running on the PC, which is how Ponte learns that a text field has focus. Dictation uses the Sussurro socket when it is running, or any OpenAI-compatible transcription endpoint (`PONTE_STT_URL`, OmniVoice Studio by default). Audio is transcribed and discarded. See the [screen and terminal guide](docs/screen-and-terminals.md).

From any device on your tailnet, `ssh user@<tailscale-ip> ./ponte pc <lock|unlock|sleep|wake|suspend|reboot|off|monitors on|off [NAME]|lights NAME>` runs the same validated actions without the app; `unlock` reads the password from stdin.

To see and control the phone from this PC over Tailscale, use `./ponte phone status`, then `./ponte phone connect` (default `100.111.221.82:5555`) and `./ponte phone view`. Step-by-step: [PC controls phone](docs/pc-controls-phone.md).

## Try it

You need an active Omarchy/Hyprland graphical session, Node.js 22+, Python 3.12+, OpenSSL 3, and Tailscale connected on both devices. Desktop capabilities use `hyprctl`, `ydotool`/`ydotoold`, `wtype`, `grim`, `wpctl`, `ffmpeg` and `ffplay`. Text sessions also require `tmux`. The input service needs your user's existing access to `/dev/uinput`.

```sh
git clone https://github.com/LucasOl1337/ponte.git
cd ponte
./ponte setup
./ponte install
./android/build.sh
```

Setup creates private local configuration and a certificate for your Tailscale address. Installation explicitly enables a user service. The build downloads verified, pinned Android tools into `.work/` and writes `.work/Ponte.apk`. Transfer that file privately to your phone, install it, and open Ponte. There is no password: a phone on the same Tailscale account connects automatically (the Tailscale daemon authenticates it and the server hands it the access token over the pinned TLS listener). Add the app icon to your first home screen. Future launches reconnect on their own.

The first alpha still requires this one-time build and pairing step. Improving that first connection is a priority. Your customized APK contains your server address and public certificate, so build it locally rather than redistributing somebody else's APK.

For a fresh local development configuration, use the following instead of the remote setup above. This does not change an existing TLS configuration:

```sh
./ponte setup --local-only
npm start
```

See the [CLI and configuration guide](docs/setup.md) and [Android build guide](android/README.md) for paths, lifecycle, updates and troubleshooting.

## Desktop app: control Android from the PC

Ponte now also has a native Linux companion. `./ponte desktop` opens connection
and pairing controls, explicit Android device selection, quality profiles,
navigation buttons and private screenshots. Its managed scrcpy window provides
live video, mouse and keyboard control, without changing the existing APK.
Audio and automatic clipboard synchronization are opt-in.

```sh
./ponte desktop                 # requires PySide6, adb and scrcpy
./ponte desktop install         # optional per-user application-menu entry
./ponte desktop --demo          # clearly labeled synthetic UI, no phone access
./ponte desktop schema          # CLI discovery, no Qt needed
```

ADB authorization on the phone is required, via USB or wireless debugging.
There is no automatic device fallback or unlocking. See the [desktop guide
(PT-BR)](docs/desktop.md) for setup, controls, testing and platform limits.
See [observed acceptance](docs/desktop-acceptance.md) for real Android emulator
video/input, screenshots and exactly what was and was not live-tested.

## Agent CLI

`./ponte ctl` controls the running app through its authenticated API, without
opening the UI or adding production dependencies. It covers state/capability
queries, every desktop action, terminals, dictation, audio, screenshots and
bounded MJPEG capture. Existing installation and phone commands are unchanged.

```sh
./ponte ctl help
./ponte ctl schema                  # machine-readable commands and constraints, offline
./ponte ctl state --pretty
./ponte ctl mouse move --dx 20 --dy -5 --dry-run
```

Results and errors use a versioned JSON envelope with stable exit codes.
Destructive operations require `--yes`. Use isolated fixtures for input and
capture tests, never an unrelated live desktop. See the [complete CLI guide
(PT-BR)](docs/cli.md) and [coverage plan](docs/cli-plan.md).

## Connection and privacy

Ponte runs a Node server on your PC. The Android app serves the interface through a private loopback proxy and connects to the PC's Tailscale address over TLS. The APK pins the installation CA and checks the PC's certificate against it before sending authorization; the server certificate can be renewed without a new app. HTTP stays on loopback.

Every control API requires a pairing token. The server uses an explicit action list and bounded subprocess arguments. It stores voice files on your PC. Ponte has no analytics SDK and does not send recordings to an AI provider.

A paired phone can operate your live desktop and view its screens. Treat it like physical access. Tailscale membership and access rules remain your responsibility. Read [the security model](SECURITY.md), including certificate renewal and token revocation, before exposing the service to another device.

## Development

The backend and web UI have no production npm dependencies.

```sh
npm test
./android/test.sh
python3 android/tests/build_fixture_test.py
```

Tests use temporary data and synthetic servers. They do not need a real phone or inject input into your desktop. The full Android fixture build downloads the pinned toolchain on its first run.

| Path | Responsibility |
| --- | --- |
| `backend/` and `server.mjs` | Authentication, desktop actions, monitor capture and audio storage |
| `public/` | Mobile interface, live frame parser and recording controls |
| `desktop/` | Native Linux companion and explicitly targeted Android control CLI |
| `android/` | Android shell, CA pinning and loopback transport |
| `ponte` and `bin/ctl-*.mjs` | Installation, phone lifecycle and authenticated agent CLI |
| `docs/` | Setup, measured evidence, project page and presentation |

## What comes next

The first priorities are a simpler pairing flow, a live check of unlock on a locked session, a keyboard-raise signal that does not depend on fcitx5, additional translations, and measurements over cellular or geographically remote Tailscale connections. Contributions that include a reproducible test are welcome. The [PC-controls-phone spec](docs/pc-controls-phone.md) evaluates the reverse direction: operating the paired phone from the PC over the same Tailscale network. Validate new builds on the device with the [manual test checklist](docs/manual-test-checklist.md).

This project is independent of Omarchy. Any upstream integration is a proposal until Omarchy's maintainers accept it. [Omarchy](https://github.com/omacom/omarchy) is created by [DHH](https://dhh.dk/).

## License

Ponte source code is [MIT licensed](LICENSE). Third-party build tools retain their own licenses and are downloaded from their publishers. The interview frame in the evidence screenshots remains the property of its respective rights holders. See [asset credits](docs/assets.md).

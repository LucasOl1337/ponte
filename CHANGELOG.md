# Changelog

All notable changes to Ponte. The project is an experimental alpha; entries describe what was built and how it was verified, not promises.

## 0.1.0-alpha.13 — 2026-09-11

The screen keyboard was rebuilt as a real keyboard, the live stream stopped dropping, pairing lost its last password, and a full pass of adversarial review (a second model reading the diff) hardened the input path. Verified on an Android 11 emulator against an isolated recording server, so keystrokes, taps, drags and terminal input could be checked without touching a live desktop.

### Type on the screen
- **A typing bar instead of an invisible field.** Tapping the keyboard button opens a thin bar and focuses its text field inside the same tap, which is the only way Android raises the soft keyboard. Every edit is sent to the PC's focused window as it is typed; Enter presses Enter. The bar shrinks the monitor to the space above it so nothing is covered, and the floating switch-monitor and rotate buttons step aside while it is open. A tap on a PC text field lights the keyboard button (fcitx focus) as a cue rather than trying to open the keyboard on its own.
- **Safer input.** The bar never saves what you type — it goes to arbitrary fields, passwords included, so there is no history there (the terminal composer keeps its own command history). IME composition is respected: keys are held until the candidate commits, and confirming a candidate no longer sends a stray Enter. Deletion counts whole characters, so an emoji is one backspace and surrogate pairs are never split. A keystroke that fails to reach the PC resets the bar instead of letting a later edit delete unrelated text, and the bar only opens when the PC can actually accept typing.

### Live view stability
- **No more "reconnecting" every few seconds.** A slow frame is given far longer to drain and the stream self-throttles to the phone's real bandwidth instead of being killed. Stream slots are shared fairly: a device reopening its screen replaces only its own stream, a preview on the PC yields to a remote phone, and no single device can take every slot, so two devices never knock each other off.
- **Smoother rendering.** Per-frame DOM work is down to the image swap; labels, geometry and status only change when they actually change, and only the visible page is re-rendered each poll.
- **Tap to start.** With no toolbar, tapping the idle screen begins streaming — the way back if a monitor was unplugged or the stream stopped.

### No password
- **Pairing has no key to type.** A device on your Tailscale account connects automatically; the typed-key fallback screen is gone. If the PC can't be reached the app says so and offers to try again, never a password box.

## 0.1.0-alpha.7 — 2026-09-11

- **A terminal command composer.** Build a command with the full phone keyboard, then Send types it and runs it in one atomic operation (paste-buffer then Enter), fixing a race where a busy client dropped the Enter. Sent commands join a reusable, on-device history shown as chips; Paste-only sends the text without running it. Terminal dictation drops its transcript into the composer to review before sending.

## 0.1.0-alpha.6 — 2026-09-11

- **Auto-pairing on your tailnet.** A phone on the same Tailscale account no longer types a key. `GET /api/pair`, served only over the native TLS listener, asks `tailscale whois` who owns the connecting peer and returns the pairing token when it is the same user that owns this PC. Machines shared with you by someone else, and tagged devices, still fall back to the typed key. The app tries this on boot when it has no saved key and enters straight away. Verified end to end on the emulator (cleared data → opened straight into the screen) and by unit tests for the identity logic and the route.
- **A stale phone reloads itself** when the PC serves a newer interface: the app carries a version constant, `/api/health` and `/api/state` report the server's, and a mismatch triggers one guarded reload. The service-worker cache name is bumped so its network-first cache drops old files.

## 0.1.0-alpha.5 — 2026-09-11

The screen page was rebuilt around one idea: the phone shows the monitor and you touch it like a phone. No control modes, no toolbar. Voice dictation, RGB and session control, and an SSH-friendly CLI arrived in the same cycle. Everything below was dogfooded on an Android 11 emulator (WebView 83) and installed on a Redmi Note 13 Pro+ (Android 14).

### Screen
- **One direct-touch mode.** Tap clicks at that monitor pixel. Long-press then lift right-clicks. Long-press then move drags with the button held (windows, text selection). Pinch zooms. One finger pans while zoomed. Two fingers together scroll the PC. The Trackpad, Direct touch, Touchpad and Keyboard tabs, the pause, freeze, 1:1 and fullscreen buttons and the touchpad panel were removed from the code, not hidden.
- **Zoom like Chrome Remote Desktop.** The whole native frame is streamed and the pinch is a continuous CSS transform on the client. The previous design re-cropped on the server mid-pinch, which reconnected the stream (jumpy) and showed the stale frame stretched (blurry). It is gone; `viewRegion` and the `x/y/w/h` stream parameters are no longer sent.
- **Sharper, faster profiles.** `scale` may now be 1 and `fps` up to 20, with a `q` JPEG quality parameter (30–90). The default *Sharp* profile streams native pixels at 15 fps. `grim` scales on the CPU, so a full-size frame at lower quality is both faster (~10 ms vs ~60 ms) and crisper than a downscaled one.
- **The phone keyboard rises when you tap a text field on the PC.** After a tap-click the app asks `GET /api/textinput`, which reads fcitx5's input contexts over DBus (`focus:1` only while an enabled text field has focus; a button-only dialog reports none). A hidden input takes focus, Android shows its keyboard, and every edit is forwarded live as keystrokes, including autocorrect revisions and Backspace. The send key presses Enter. The keyboard closes when the field loses focus on the PC.
- **Floating buttons** beside the mic: switch to the next monitor, and force landscape (immersive, edge to edge) or release it. Orientation is requested through a bridge-free `ponte://orientation/...` navigation that the Activity intercepts; rotation no longer recreates the Activity.
- Monitor and quality selectors moved to a *Screen* card on Início. Android Back returns from the screen to Início instead of quitting the app.

### Voice dictation
- **Speak into a terminal.** *Speak to terminal* records, transcribes on the PC and types the text into the selected session, then presses Enter (a checkbox turns Enter off). A mic on the screen page does the same into whatever field has focus on the PC.
- Transcription prefers the Sussurro IPC socket (faster-whisper on the GPU, ~280 ms) and falls back to any OpenAI-compatible endpoint such as OmniVoice Studio (`PONTE_STT_URL`). Audio is transcribed and discarded; nothing is stored. New routes: `POST /api/dictate` and `POST /api/terminals/<id>/dictate?enter=1`.

### Power, lights and session
- **Monitor on/off now works on current Hyprland.** `hyprctl dispatch dpms off HDMI-A-1` stopped working when Hyprland moved dispatch to Lua; only `focus` had been migrated. The Lua `dpms` dispatcher also ignores the on/off word and merely toggles, so Ponte reads `dpmsStatus` and toggles only when the monitor is not already in the requested state. Per-monitor toggles, *All on* / *All off*, smart sleep and wake use this path. Verified live and idempotent.
- **RGB lights** through the Magma controller: six presets (lava, brasa, oceano, aurora, floresta, lua), lights off/restore/reapply, and the water-cooler screen on/off. State (`preset`, `sleeping`) is exposed in `/api/state`.
- **Session:** lock (`omarchy-system-lock`), unlock (types the password through uinput only while the Omarchy lock is up; the password is never stored on the phone), suspend and restart with confirmation dialogs. `/api/state` reports `session.locked`.
- Wake-on-LAN reports whether it is enabled on the network card.

### SSH over Tailscale
- New `./ponte pc <lock|unlock|sleep|wake|suspend|reboot|off|monitors on|off [NAME]|lights NAME>` (`bin/ponte-pc.mjs`) reuses the same validated desktop actions from a shell, so `ssh user@<tailscale-ip> ponte pc suspend` works without the HTTP server. `unlock` reads the password from stdin, never from `argv`.

### Fixes
- Every `dvh` rule now has a `vh` fallback; WebViews older than Chromium 108 dropped those declarations, which let the terminal output grow without bound and left a gap under the keyboard.
- `backdrop-filter` was removed from the navigation bar and screen overlays: on WebView 83 it blanked the entire page whenever it shared the screen with a live frame. CSS `inset` was replaced with explicit offsets for the same WebView.
- Terminal output keeps a fixed height with internal scrolling, so buttons stop moving while text arrives.
- Recording names are no longer generated in UTC.

### Tests and docs
- 103 tests (`npm test`): new coverage for the transcriber (Sussurro and HTTP providers, validation, cleanup), dictation routes, `mouse.moveTo`, the text-input probe, lights and session actions, the read-then-toggle DPMS logic, the direct-touch gesture mapping, keystroke forwarding, monitor cycling and forced landscape, and the `ponte pc` CLI.

### Known limits
- *Lights off* (`lights.sleep`) fails intermittently when OpenRGB cannot enumerate the Logitech keyboard; Ponte reports the failure. Presets, restore and the cooler screen are reliable.
- Unlock was unit-tested but not exercised on a live locked session in this cycle.
- The Android keyboard raise depends on fcitx5 running on the PC. Without it, tapping a field does nothing and the terminal page's *Type text* field remains the fallback.

## Earlier alphas

- **0.1.0-alpha.4** — native 1:1 crops, Direct touch cues, emulator after-shots (PR #10, #11).
- **0.1.0-alpha.2 / alpha.3** — immersive screen page, terminals over a private tmux socket, power superbuttons and Wake-on-LAN metadata.
- **0.1.0-alpha.1** — first public alpha: pairing, touchpad, keyboard, windows, live MJPEG monitor view, voice recordings, personalized Android build with certificate pinning.

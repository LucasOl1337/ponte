# Changelog

All notable changes to Ponte. The project is an experimental alpha; entries describe what was built and how it was verified, not promises.

## 0.1.0-alpha.23 (2026-09-28)

The owner's calls on the Dev tab and the agents list. No new routes; the APK (versionCode 20) only carries the version.

- **Dev tab.** The key row puts the 1/2/3 permission-menu answers right after Esc.
  "Open on the PC" asks only the first time for each session. Claude Code's ⏵ ⏸ ⏺ ⎿
  symbols, which no font on the phone has, are drawn as one-cell look-alikes
  (▸ ‖ ● └), so the footer no longer shows empty boxes and columns stay aligned.
- **Agents tell you when they need you.** An idle Claude that already did work in its
  session now shows as **Ready** in a softer amber. One that was just opened and never
  asked anything stays **Idle**. The list is ordered waiting, working, ready, idle,
  terminal.
- **Automated agents hidden.** `codex exec` and `claude -p` are hidden by default
  behind **Show automated (N)**, which keeps counting them.
- **Agent alerts.** With the app open on any tab, the phone reads the agent list every
  10 s; this pauses when the app is in the background. When an agent goes from working
  to waiting for you, or to ready, a banner says "<title> needs you" or "<title>
  finished". The phone buzzes and the Terminals tab gets a dot; tapping the banner
  opens the conversation. It never fires on the first read, for automated agents, or
  right after you replied from the phone. **Agent alerts** turns it off.
- Maestri agents stay read-only: the Maestri CLI refuses to run outside its own
  terminals, and the hint now says so.

Verified with `npm test`, including fixture tests for the ready rule and UI tests for
the filter, the alerts, the per-session confirmation and the symbol mapping. The glyph
coverage was checked against the fonts pulled from the phone. On the phone itself, the
Dev tab and the agents list were checked after install.

## 0.1.0-alpha.22 (2026-09-28)

A Dev tab for developing from the phone: an agent terminal on the PC that reads and types like the real thing. Needs the new APK (versionCode 19) only for "Open on the PC"; the rest reloads with the page.

- **Dev tab.** A sixth button opens one Ponte tmux session full screen, running Claude,
  Codex or a shell in a `~/Projects` folder. It shows colours and the cursor (SGR
  16/256/truecolor). The session is sized to the phone's character grid instead of
  40×24; A−/A+ changes the font and the badge shows columns×rows. A key row carries
  what Claude Code needs: Esc, ⇧Tab, arrows, Enter, ^C, 1/2/3, /, @, !, PgUp/PgDn,
  ^O/^R/^D/^L, with a single character sent as a key so permission menus answer.
  The composer grows to five lines and has Send, Paste, dictation and image attach.
  A request of several lines goes as one bracketed paste only when the pane is
  waiting for pasted text; a busy shell refuses it and nothing is typed. Reads poll
  every 350 ms right after input, slow down to 3 s when nothing changes, and stop
  outside the tab. Large reads are gzipped (1000 coloured lines ≈ 100 KiB → 3.5 KiB).
- **Open on the PC.** It attaches a terminal window on the desktop to the same session
  through Omarchy's own launcher (`uwsm-app` + `xdg-terminal-exec`). It is refused
  while the PC is locked. The PC window then sets the size; the phone takes it back
  on its own layout changes or a tap on "PC 120×40 · fit", never on a read.
- New sessions from Home and Terminals also start at the measured size.
- **Lab.** A fake Claude Code TUI (colours, a 1/2/3 permission menu, ⇧Tab modes,
  bracketed paste). Fake `uwsm-app`, `omarchy-shell` and `omarchy-system-lock` mean a
  lab session never opens windows on, reads or changes the real PC's lock.

Verified with `npm test` (256 pass, 1 skip), `android/test.sh` (proxy 193 checks) and
a mobile-viewport browser against the lab's fake Claude in portrait, landscape and
with the keyboard open. That run answered the permission menu from the key row,
cycled modes with ⇧Tab, sent a three-line request as one paste and showed a busy
shell refusing one. The real phone was checked after install.

## 0.1.0-alpha.21 (2026-09-28)

A round built from the owner's six-point mission: see and answer every agent from the phone, start agent work from Home, scroll with the phone, a reliable Smart sleep, and screenshots from the phone to the PC. Plus a lighter app. Needs the new APK (versionCode 18) for agents, images and compression; everything else reloads with the page.

- **Agents and terminals.** The Terminals page is now one list of everything open:
  Claude, Codex and other agents in foot windows, on the Maestri canvas, inside apps
  or headless, terminal windows and Ponte sessions. Each card says whether the agent
  is working, waiting for you or idle, where it runs, its folder and since when.
  Claude's state comes from `~/.claude/sessions/<pid>.json`, checked against pid
  reuse; other agents use CPU and recent transcript writes. Tapping opens the
  conversation in readable type. "Reply on PC" focuses the window, confirms the focus
  and only then types the text and Enter; a Ponte session is typed into without
  moving focus; a locked PC refuses. The `/proc` scan takes ~43 ms (median), cached 1.5 s.
- **Start working from Home.** A card opens a text session already running Claude,
  Codex or a shell, in a recent `~/Projects` folder, with a typed or dictated request,
  and jumps to it. The request reaches the agent as a process argument, never as shell
  text; when the agent exits the session falls back to a shell.
- **Scrolling from the phone.** Hold one finger still and drag another to scroll the
  PC under the resting finger, zoomed or not, without ever clicking or dragging. Scroll
  gestures follow the finger like a phone, and every phone scroll first places the PC
  pointer at the gesture, so the wheel reaches the window under your fingers (before,
  it scrolled wherever the pointer was). Up/down buttons on the Screen repeat while
  held. The Terminals reader keeps the 1000-line history and your place.
- **Reliable Smart sleep.** The Magma lights controller sent RAM, GPU, keyboard and
  board in one OpenRGB call; when the Logitech keyboard was asleep OpenRGB 1.0rc3
  aborted the whole call and only the fans went dark. The controller now makes one
  call per group with the MSI board last, skips an absent keyboard and reports each
  device (`controller.py sleep --json`). Ponte logs each light's result, tries the
  lights even if Hyprland fails, names on the phone the lights that stayed on, and
  answers within 11 s (the Android proxy gives up at 15 s) with the outcome arriving
  through the state. The lab no longer drives the real lights controller.
- **Screenshots to the PC.** Share an image to Ponte from Android's Share menu or pick
  one from Home: a sheet previews it and uploads only when you choose Copy to PC
  (`wl-copy --type`, paste with Ctrl+V, including into Claude Code), Paste path into a
  Ponte session (no Enter) or Just save. Images live in `<dataDir>/inbox` (0600,
  newest 30 / 200 MiB).
- **Lighter app.** Static files are compressed (br/gzip) and revalidated by ETag: a
  cold load goes from 292 KB to ~70 KB, a reload to ~3 KB. `/api/state` caches
  capabilities (60 s) and the lock flag (5 s): median poll 30.5 → 9.4 ms. Viewers of the
  same picture share one capture loop (half the capture CPU for two). Sharp streams at
  JPEG quality 40. An idle terminal costs 29 tmux spawns and 29 KB a minute instead of
  219 spawns and 4.4 MB; typed input no longer waits behind output polling. The page
  stops polling while the Android app is paused.
- Verified: 233 Node tests (1 optional systemd test skipped), 188 native proxy checks and the rest of `android/test.sh`, CDP
  multi-touch and emulator runs against the lab for each feature, and on this PC a real
  Smart sleep and restore through the new controller (every light reported ok, 18 s and
  8 s). Physical confirmation of the lights and a human pick inside Android's file
  picker are still pending.

## 0.1.0-alpha.20 (2026-09-27)

Ponte now works in both directions: the phone still drives the PC, and the PC can open and control an authorized Android phone. Agents get a JSON CLI over the running server. The Android shell did not change: phones on the alpha.19 APK need no reinstall.

- Added **Ponte Desktop** for Linux: `./ponte desktop` opens a native PySide6
  manager for authorized Android devices, with connection/pairing, explicit
  selection, quality profiles, read-only mode, navigation and private screenshots.
  Video and mouse/keyboard control run in a managed, separate scrcpy window.
- Added a stdlib-only `ponte desktop` JSON CLI, offline help/schema, stdin-only
  pairing codes and per-user menu installation. No new server, autostart, APK
  permission or implicit device fallback. Audio and clipboard autosync are opt-in.
- Verified live Android 11 video and input in an isolated emulator: a mouse drag
  opened notifications, the native Back button restored Home, read-only blocked
  input, the screenshot dialog saved a private PNG, and stopping/closing the app
  ended only its viewer. Tests cover the bridge, CLI, Qt widgets and process
  lifecycle. Physical USB and wireless pairing were not live-tested in this round.
  See `docs/desktop.md` and `docs/desktop-acceptance.md` for setup and evidence.
- Added `./ponte ctl`: 59 discoverable commands covering the running server's
  public control API, including all 32 desktop actions and five legacy aliases,
  state/capability queries, terminal sessions, audio, dictation and bounded
  JPEG/MJPEG captures. Installation, phone and direct `pc` commands stay compatible.
- Added offline help/schema and redacted dry runs, a versioned JSON result/error
  envelope, stable exit codes, stdin-only unlock passwords and explicit
  confirmation for shutdown, reboot, suspend and terminal removal. Terminal
  dictation does not press Enter unless requested.
- The dependency-free client reuses private config/token files, verifies HTTPS
  certificates, refuses redirects/retries and output overwrites, bounds transfers
  and cleans up its incomplete files. Timeouts warn that a mutation may already
  have happened.
- Documented commands, limits, client-only UI boundaries and isolated testing in
  `docs/cli.md`, with an audit and coverage matrix in `docs/cli-plan.md`.
- Verified through real CLI subprocesses and the HTTP router with synthetic
  effects, local HTTP/HTTPS transport tests, the Node suite and native Android
  checks. The installed server's health endpoint was checked without restarting
  services, injecting desktop input, capturing the user's display or installing
  an APK.
- Release: version bumped to 0.1.0-alpha.20 in `package.json`, the UI constant and
  cache-busting query. The Android manifest stays at 0.1.0-alpha.19 (`versionCode 17`)
  because the native shell is unchanged. Validated with 181 Node tests (1 opt-in
  skipped), 120 desktop Python tests (Qt offscreen), 270 native checks and 7
  configuration tests. A running alpha.19 server keeps serving the phone; it reports
  the new version after its next restart.

## 0.1.0-alpha.19 — 2026-09-18

Second round on the Redmi, this time with the WebView inspectable (a debuggable dogfooding build, `PONTE_ANDROID_DEBUGGABLE=1`), so the keyboard complaints could be measured instead of guessed.

- **The keyboard opened with no field behind it.** Asking the shell for the IME (`requestFocusFromTouch`) moved the page focus from the typing field to the screen preview: keys went nowhere, `+`/`-` zoomed the monitor, and because the layout only counted the keyboard as open when a field was focused, the bar was positioned for "no keyboard" (off-screen in landscape, with the navigation tabs wedged between bar and keyboard in portrait). The shell now only re-requests focus when the WebView really lacks it, the page puts the focus back as the keyboard settles, and the viewport shrinking is the keyboard signal on its own. Measured: field focused, tabs hidden, bar directly above the keyboard, monitor visible above the bar.
- **Text is sent as one line, not as keystrokes.** Forwarding every edit live turned a Gboard correction over a Tailscale relay into a burst of backspaces that arrived garbled or not at all. The line now stays on the phone until Send, which types it and presses Enter in a single server action (`keyboard.text` with `enter`); the bar closes after a successful send, a failed send keeps the draft, and "Send without Enter" pastes. `wtype` was checked on the desktop with accented text: exact.
- **Long-press drag moves windows.** The gesture now holds Super for the duration, which is how Hyprland moves floating windows and swaps tiled ones; the workspace shelf remains the drop target for another workspace. A plain one-finger drag still drags inside the window's contents.
- **Workspaces on the screen.** A row of Omarchy workspaces sits over the monitor: the one the streamed monitor shows is lit, a dot marks the ones with windows, a tap is Super+N. A workspace living on another monitor pulls the stream to that monitor first; a new workspace opens on the streamed monitor (the pointer is placed there before the dispatch).
- **The phone is reachable over Tailscale alone.** `./ponte phone ensure` keeps adb on the phone's Tailscale address (fixed TCP port 5555; when the listener is gone after a reboot it is re-enabled through whatever transport is up and the link comes back over Tailscale), `phone install` installs the built APK that way, `phone app` brings Ponte to the front with the screen on and above the lock screen (an agent session that finishes itself when it leaves the foreground; HyperOS's "show on lock screen" op is granted over adb), `phone wake` handles the lock screen when the rest of the phone is needed, `phone timer on` keeps the link alive every two minutes, and `doctor` reports the Tailscale adb link. The shell retries a failed first load a few times quietly (a cold start right after the screen turns on can race the VPN) and reloads on its own after a load that failed while the activity was being paused. Measured end to end through the phone's Tailscale address (the phone on 5G, through the DERP relay): install, launch over the lock screen, live stream, screenshot and tap.
- Verified by 133 Node tests, 270 native checks and the synthetic APK build (`versionCode 17`); layout, focus and IME dismissal measured on the Redmi over CDP, the drag sequence in the lab.

## 0.1.0-alpha.18 — 2026-09-18

A dogfooding round on the Redmi about the thing that matters most in a remote control: does the click land where the finger says. It did not, and the reason was on the PC, not on the phone.

- **Every absolute pointer placement landed at twice the requested pixel.** `ydotool mousemove --absolute` is not absolute: it jumps to the top-left corner and then moves relatively, and Hyprland's default adaptive acceleration scales that second leg (measured: (1000,700) became (2000,1400) on every monitor). ydotool's own help says to turn acceleration off. The server now sets its virtual pointer to a flat profile through Hyprland's per-device configuration (Lua on 0.56+, keywords before), verifies each placement against `hyprctl cursorpos`, re-applies the profile when a restarted `ydotoold` shows up as a new device, and closes any remaining gap with scale-aware relative moves. A miss that jitter cannot explain surfaces as a warning in the app. Measured after the fix: pixel-exact on all three monitors, from the API and from the phone.
- **A pinch survives the auto quality profile.** Each rung of Auto streams a different frame resolution, and the screen treated that as a new monitor and threw the zoom away seconds after the user pinched. Only a different aspect ratio (another monitor) resets now. Zoom always reaches at least 4x, even on the light profile: blurry is fine when the point is to hit a small target, and the frame sharpens in place as the profile climbs.
- **The stream no longer gives up.** After five failed attempts (a PC restart, a mobile hand-over) the screen used to freeze on a still frame with "tap play", and there was no play. It keeps trying at a gentle pace while the screen is open, and a tap on a still frame reconnects instead of clicking on whatever the desktop shows now. A brief ring marks where each tap became a click.
- **Keyboard.** A row of keys the phone keyboard cannot type sits above the typing bar: Esc, Tab, arrows, Del, Home, End, Ctrl+C/V/Z/A, Alt+Tab, Super. The native shell keeps the screen on (the phone locked itself mid-session before) and lowers the IME when the typing bar closes, so an open keyboard never types into nothing; the keyboard button brings the keyboard back when the bar is open without it instead of closing the bar.
- **`tools/lab/`: a real Ponte server with fake desktop tools.** `hyprctl`, `ydotool`, `wtype` and `grim` are replaced by scripts that log every call and draw a synthetic monitor (grid, targets, cursor, clicks, typed text), so a phone or emulator can be exercised end to end without touching a live desktop. `tap-test.py` taps at known fractions of the streamed image and checks the cursor; `cdp.mjs` drives a debuggable Chrome for real pinches and exact layout readings. Client-side mapping measured exact (0 px) at 1x and 4x.
- Verified by 127 Node tests, 270 native checks and the synthetic APK build (`versionCode 16`).

## 0.1.0-alpha.17 — 2026-09-18

Diagnosed on the real Redmi after the app spent a morning saying "Your PC has not responded" while Tailscale was fine. Two independent causes were found and both classes of failure are closed, plus the tooling to see the next one in a minute.

- **The app pins the installation CA, not the one-year server certificate.** A `./ponte setup` on 2026-09-17 had regenerated TLS; the phone's older APK pinned the previous leaf and its loopback proxy rejected every handshake, which the WebView showed as an unreachable PC. The same failure would have returned on its own when the leaf expired. The Android proxy now trusts the CA created at setup and requires the PC's certificate to be issued directly by it (IP SAN and hostname checks unchanged). `./ponte renew-cert` reissues the server certificate under that CA and restarts the service; the phone keeps working. Only a new CA needs a new APK.
- **A certificate the app does not trust is a certificate error.** The proxy reports `proxy_certificate` in the status line and body; the native shell shows "Your PC's certificate changed" with the rebuild instruction instead of the generic Tailscale advice.
- **Auto-pairing no longer latches off when the service starts before Tailscale.** The owner lookup (`tailscale whois` on the PC's own address) ran once at startup; at login the daemon was still coming up, so the lookup failed and every `/api/pair` was denied until a restart. A failed lookup is now retried on the next request (throttled to one attempt per 5 s); only a real answer is final.
- **`./ponte doctor`** checks configuration, certificate expiry, Tailscale address and connectivity (including how the phone is reached: direct or relay), both services, `ydotoold`, the TLS listener, auto-pairing from the PC itself, whether `.work/Ponte.apk` pins the current CA, and the installed app version over `adb`.
- **Auto stream quality.** Measured on a 1440p monitor: Sharp ~49 Mbit/s, Balanced ~7, Light ~2, which is why Sharp never worked over mobile data. The new default *Auto* profile starts light, climbs one rung after two consecutive on-time windows (3 s each) and drops a rung as soon as fewer than 60% of the requested frames arrive, holding 20 s (doubling after each fall, up to 2 min) before climbing again. A stream that breaks steps down immediately; a window stretched by a pause is discarded rather than judged.
- Verified by 123 Node tests, 270 native checks, the synthetic APK build, and on the Redmi over 5G (relay through DERP São Paulo): auto-pair, live screen, background/resume and cold start. MJPEG remains the transport; a video codec (H.264 via ffmpeg or WebRTC) is the next step for mobile use and is not in this release.

## 0.1.0-alpha.16 — 2026-09-13

- Fixed ordinary finger taps disappearing when normal contact wobble crossed the old 12 CSS px threshold; the direct-touch gesture now tolerates 24 CSS px before changing intent.
- A deliberate one-finger move at fitted 1× now becomes a real held-left-button drag, so desktop text, list rows, sliders and draggable items can be selected directly. One-finger movement while zoomed continues to pan the phone view.
- Long-press still provides right-click, and long-press plus drag keeps the semantic workspace shelf. The regression test covers both jittery taps and direct mouse-style selection drags.

## 0.1.0-alpha.15 — 2026-09-13

- Fixed Android text-field taps that could do nothing when fcitx published the new input context after the app's single focus check.
- The screen now retries text-focus detection for a short bounded window after a tap, without injecting speculative keys into the PC.
- Added a guarded native WebView bridge and a MIUI-friendly IME retry so the phone keyboard opens reliably once a PC text field is confirmed.

## 0.1.0-alpha.14 — 2026-09-13

The screen now understands two intents that raw mouse emulation could not express cleanly on a phone.

- **Move a window between workspaces in one gesture.** Long-press a window and start moving it; a workspace shelf appears over the bottom of the monitor. Drop on a number to move the exact window captured at the start of the gesture. The backend uses Hyprland's exact address selector with `follow = false`, so the window moves without pulling the current view to the destination. Dropping elsewhere remains an ordinary desktop drag, and starting on wallpaper can never reuse the previously active window by mistake.
- **A field tap raises the Android keyboard.** The fcitx5 focus probe still decides whether the PC target accepts text, but the native shell can now raise the IME after that asynchronous answer. The typing bar opens automatically in the Android app; tapping away closes bars opened this way. Browser users keep the highlighted keyboard button as the explicit fallback.
- **Kept narrow and reversible.** No Android permission was added. Pointer coordinates, window addresses and workspace IDs remain validated; held input is released before the semantic move. The release was verified by 112 Node tests, 267 native checks, and a fully compiled synthetic APK (`versionCode 11`).

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

# Ponte lab

The real server with fake desktop tools, for exercising a phone without a live desktop.

```sh
tools/lab/run.sh                                  # HTTP 127.0.0.1:8799, prints the #pair= URL
adb -s SERIAL reverse tcp:8799 tcp:8799           # phone's localhost:8799 → this PC
adb -s SERIAL shell am start -a android.intent.action.VIEW -d 'http://127.0.0.1:8799/#pair=TOKEN'
```

`PONTE_LAB_DIR` (default `.work/lab`) holds `events.jsonl` (every fake call), `clipboard.bin` (the last image the fake `wl-copy` received) and `state.json` (cursor, held button, typed text, fcitx focus). `PONTE_LAB_MONITOR=3440x1440` changes the synthetic monitor; `PONTE_LAB_BACKDROP=image.png` tiles a real screenshot under it so frame sizes look like a real desktop (e.g. `magick docs/assets/desktop-control.png docs/assets/desktop-notifications.png +append .work/backdrop.png`); `PONTE_LAB_ACCEL=2` is the pointer acceleration the fake compositor applies until the server sets the device profile flat, which reproduces the real bug.

The synthetic monitor shows a coordinate grid, targets A/B (text fields: a left click turns the fcitx focus flag on) and C (a button: off), the cursor with its coordinates, the last clicks and whatever was typed.

- `tap-test.py --serial SERIAL` taps at known fractions of the streamed image (found on the device screenshot) and compares with the cursor the server placed. Independent of the page's own numbers.
- `cdp.mjs` needs a debuggable Chrome (`adb forward tcp:9222 localabstract:chrome_devtools_remote`): `rect`, `pinch`, `tap`, `tap-check LABEL`, `drag`, `two-drag`, `text`, `key`, `click SELECTOR`, `eval JS`.
- `bin/claude` and `bin/codex` stand in for the agent CLIs: a session started from Home runs them, and they print the request they got as argv (also logged to `events.jsonl`), then echo each typed line. No model is called.
- On a terminal, `bin/claude` draws a Claude Code-like TUI instead (`bin/_claude_tui.py`): the conversation scrolls in colour (SGR, truecolour orange), the footer (input box, mode line, permission menu) is redrawn in place, the terminal cursor is hidden and bracketed paste is on. Enter sends a request and it asks to run `npm test` with a 1/2/3 menu (1/2/3, arrows + Enter, Esc = 3); Shift+Tab cycles default, accept edits and plan mode; Ctrl+C twice or Ctrl+D exits. Every recognised key (`{"tool":"claude-tui","key":...}`), request, paste and menu answer goes to `events.jsonl`. `PONTE_LAB_CLAUDE=line` keeps the old line-echo fake.
- `fake-agent.sh start|waiting|busy|ready|stop` runs one fake Claude Code (a `sleep` named `claude` plus its session file) that the agent scanner sees go working → waiting or working → ready, for the agent alerts (`/api/agents/events`) without calling a model. `HOME` picks the `~/.claude` it writes to; `stop` removes what it wrote.
- `pinch.py` sends a two-finger gesture through `sendevent` (rooted emulator only).
- Lights: the lab never runs the owner's Magma controller (it drives the real RGB). `PONTE_LAB_MAGMA=<folder with a controller.py copy>` runs that copy through `magma.py` with its state and `telinha` under `$PONTE_LAB_DIR/magma-home`, against the fake `openrgb`, which behaves like 1.0rc3: one missing `--device` aborts the whole call. `PONTE_LAB_OPENRGB_DEVICES` ('|'-separated) is what is on the bus (default: this PC without the sleeping G515 keyboard); `PONTE_LAB_OPENRGB_FAIL` names devices whose write fails; `PONTE_LAB_OPENRGB_DELAY=5` adds the per-call detection time of the real CLI.

- Remote desktop (`/api/rd`): `run.sh` sets `PONTE_RD_CAPTURE=lab` (an ffmpeg `testsrc2` + x264 zerolatency stream instead of the screen) and `PONTE_RD_INPUT=dry-run`: `backend/rd-input.py` never opens `/dev/uinput` and appends each evdev frame it would write to `events.jsonl` (`{"tool":"rd-input","dev":"ponte-rd-keys","events":[["EV_KEY","KEY_A",1]]}`). The fake `wl-paste --watch` follows `clipboard.bin`, so `clip` works both ways. `PONTE_LAB_EXTRA_MONITORS="LAB-2:1280x720"` adds outputs to `hyprctl -j monitors` for the monitor picker (the screenshot fake always draws LAB-1). With `public/rd.html` present, `run.sh` also prints the `rd.html#pair=` URL.
- The lab stream carries its capture time: 44 cells of 16x16 px at the top-left, most significant bit first, white = 1, the wall-clock ms epoch when the frame left ffmpeg's `realtime` filter. `rd-measure.mjs --url ws://127.0.0.1:8799/api/rd --token-file .work/lab/data/token --band` decodes what arrived and reports capture → send and capture → arrival, plus fps, bitrate, keyframe/delta sizes and RTT; `--lab` runs the same in-process, `--gsr DP-3 --seconds 8` measures a real monitor with input off (keep real captures ≤ 10 s), `--switch NAME` times an encoder restart.

`uwsm-app` (the Dev tab's "Abrir no PC") only logs the attach argv and never opens a window; `omarchy-shell lock isLocked` and `omarchy-system-lock` read and set `locked` in the lab's `state.json`, never the real PC's lock.

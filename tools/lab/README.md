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

`uwsm-app` (the Dev tab's "Abrir no PC") only logs the attach argv and never opens a window; `omarchy-shell lock isLocked` and `omarchy-system-lock` read and set `locked` in the lab's `state.json`, never the real PC's lock.

## Two nodes (mesh)

```sh
node tools/lab/mesh.mjs      # pc-teste on 127.0.0.1:8799, notebook-teste on :8797, each prints its #pair= URL
```

Two real servers in one process, each with its own data, CA (`.work/lab-mesh/a|b/tls`), owner token and fake desktop; the synthetic monitor is titled with the node's name (`PONTE_LAB_TITLE`) and notebook-teste's is 1366x768. Their tailnet TLS listeners sit on 127.0.0.1:8798 and :8796, discovery points each at the other and the whois stand-in says "same owner" for 127.0.0.1, so pairing, the pinned CA and the `?node=` relay run the production code. On pc-teste: Home → Devices → Ask for access; approve the code on notebook-teste's own page; then pick notebook-teste in the selector and open the screen. `PONTE_LAB_MESH_DIR` and `PONTE_LAB_PORT_A|B`, `PONTE_LAB_NATIVE_A|B` move it.

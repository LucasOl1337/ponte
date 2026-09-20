# Ponte lab

The real server with fake desktop tools, for exercising a phone without a live desktop.

```sh
tools/lab/run.sh                                  # HTTP 127.0.0.1:8799, prints the #pair= URL
adb -s SERIAL reverse tcp:8799 tcp:8799           # phone's localhost:8799 → this PC
adb -s SERIAL shell am start -a android.intent.action.VIEW -d 'http://127.0.0.1:8799/#pair=TOKEN'
```

`PONTE_LAB_DIR` (default `.work/lab`) holds `events.jsonl` (every fake call) and `state.json` (cursor, held button, typed text, fcitx focus). `PONTE_LAB_MONITOR=3440x1440` changes the synthetic monitor; `PONTE_LAB_ACCEL=2` is the pointer acceleration the fake compositor applies until the server sets the device profile flat, which reproduces the real bug.

The synthetic monitor shows a coordinate grid, targets A/B (text fields: a left click turns the fcitx focus flag on) and C (a button: off), the cursor with its coordinates, the last clicks and whatever was typed.

- `tap-test.py --serial SERIAL` taps at known fractions of the streamed image (found on the device screenshot) and compares with the cursor the server placed. Independent of the page's own numbers.
- `cdp.mjs` needs a debuggable Chrome (`adb forward tcp:9222 localabstract:chrome_devtools_remote`): `rect`, `pinch`, `tap`, `tap-check LABEL`, `drag`, `two-drag`, `text`, `key`, `click SELECTOR`, `eval JS`.
- `pinch.py` sends a two-finger gesture through `sendevent` (rooted emulator only).

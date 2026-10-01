#!/usr/bin/env python3
"""Passive click/focus probe. Read only.

Reads mouse BUTTON events (BTN_LEFT/RIGHT/MIDDLE only; every other code,
keyboard keys included, is dropped unread) from the given evdev nodes without
grabbing them, and for each left press samples fcitx5 DebugInfo (focused input
context), `hyprctl -j activewindow` and `hyprctl cursorpos` right at the press
and 50/150/400/800 ms later. One JSON line per click. It never writes to any
device, never clicks, types or focuses anything.

  tools/lab/click-focus-probe.py OUT.jsonl /dev/input/eventN [...]
"""
import json, os, re, select, struct, subprocess, sys, threading, time

EV_KEY = 1
BUTTONS = {0x110: 'left', 0x111: 'right', 0x112: 'middle'}
FMT = 'llHHi'
SIZE = struct.calcsize(FMT)
IC = re.compile(r'IC \[([^\]]+)\]\s+program:(\S*)\s+frontend:(\S+)\s+cap:([0-9a-fA-F]+)\s+focus:([01])\b')


def sh(*argv):
    try: return subprocess.run(argv, capture_output=True, text=True, timeout=1.5).stdout
    except Exception: return ''


def sample():
    raw = sh('busctl', '--user', '--timeout=1', 'call', 'org.fcitx.Fcitx5', '/controller', 'org.fcitx.Fcitx.Controller1', 'DebugInfo').replace('\\n', '\n')
    focused = [{'id': m[1][:8], 'program': m[2], 'cap': m[4]} for m in IC.finditer(raw) if m[5] == '1']
    try: w = json.loads(sh('hyprctl', '-j', 'activewindow')); win = w.get('class')
    except Exception: win = None
    return {'ic': focused, 'window': win, 'cursor': sh('hyprctl', 'cursorpos').strip()}


history = []  # (wall time, sample), last ~2 s, filled every ~40 ms
fast = []  # (wall time, focused IC key), fcitx only, every ~15 ms, last ~3 s


def ic_key():
    raw = sh('busctl', '--user', '--timeout=1', 'call', 'org.fcitx.Fcitx5', '/controller', 'org.fcitx.Fcitx.Controller1', 'DebugInfo').replace('\\n', '\n')
    return '|'.join(f'{m[2]}:{m[4]}:{m[1][:4]}' for m in IC.finditer(raw) if m[5] == '1') or '-'


def fast_sampler():
    while True:
        fast.append((time.time(), ic_key())); del fast[:-250]
        time.sleep(0.012)


def sampler():
    while True:
        now = time.time(); s = sample()
        history.append((now, s)); del history[:-60]
        time.sleep(0.04)


def timeline(t0):
    # Distinct fcitx states from 300 ms before to 700 ms after the press.
    out, last = [], None
    for t, key in list(fast):
        if t < t0 - 0.3 or t > t0 + 0.7: continue
        if key != last: out.append([round((t - t0) * 1000), key]); last = key
    return out


def before(t0):
    older = [s for t, s in list(history) if t < t0 - 0.03]
    return older[-1] if older else None


def probe(out, device, button, t0):
    row = {'t': time.strftime('%H:%M:%S', time.localtime(t0)) + f'.{int(t0 * 1000) % 1000:03d}', 'device': device, 'button': button, 'before': before(t0), 'samples': {}}
    start = time.monotonic()
    for ms in (0, 50, 150, 400, 800):
        wait = start + ms / 1000 - time.monotonic()
        if wait > 0: time.sleep(wait)
        row['samples'][str(ms)] = sample()
    time.sleep(max(0, start + 0.75 - time.monotonic()))
    row['timeline'] = timeline(t0)
    with open(out, 'a') as f: f.write(json.dumps(row) + '\n')


def main():
    out, paths = sys.argv[1], sys.argv[2:]
    fds = {}
    for path in paths:
        try: fds[os.open(path, os.O_RDONLY | os.O_NONBLOCK)] = os.path.basename(path)
        except OSError as error: print(f'skip {path}: {error}', file=sys.stderr)
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=fast_sampler, daemon=True).start()
    while True:
        ready, _, _ = select.select(list(fds), [], [])
        for fd in ready:
            try: data = os.read(fd, SIZE * 64)
            except BlockingIOError: continue
            for off in range(0, len(data) - SIZE + 1, SIZE):
                sec, usec, etype, code, value = struct.unpack_from(FMT, data, off)
                if etype != EV_KEY or code not in BUTTONS or value != 1: continue
                threading.Thread(target=probe, args=(out, fds[fd], BUTTONS[code], sec + usec / 1e6), daemon=True).start()


main()

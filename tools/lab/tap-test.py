#!/usr/bin/env python3
"""Tap the lab monitor on a phone at known fractions of the streamed image and
compare where the Ponte server placed the cursor. Ground truth is geometric:
the image rectangle is measured on the device screenshot, so this checks the
whole path (touch → client mapping → server → cursor) independently.

  tools/lab/tap-test.py --serial emulator-5554 [--monitor 1920x1080] [--points 9]
"""
import argparse, json, os, subprocess, sys, time, io
from PIL import Image

def sh(serial, *args, binary=False):
    out = subprocess.run(['adb', '-s', serial, *args], capture_output=True, check=True)
    return out.stdout if binary else out.stdout.decode()

def screenshot(serial):
    return Image.open(io.BytesIO(sh(serial, 'exec-out', 'screencap', '-p', binary=True))).convert('RGB')

def image_rect(im, aspect):
    """The lab monitor's background is brighter than the preview's. Find the
    largest run of rows/columns above the threshold and sanity-check the aspect."""
    w, h = im.size; px = im.load()
    def bright_rows():
        rows = []
        for y in range(0, h):
            vals = [max(px[x, y]) for x in range(0, w, 8)]
            rows.append(sum(vals) / len(vals))
        return rows
    rows = bright_rows()
    runs, start = [], None
    for y, v in enumerate(rows + [0]):
        if v > 21 and start is None: start = y
        elif v <= 21 and start is not None: runs.append((start, y - 1)); start = None
    top, bottom = max(runs, key=lambda r: r[1] - r[0])
    cols = []
    for x in range(0, w):
        vals = [max(px[x, y]) for y in range(top, bottom + 1, 8)]
        cols.append(sum(vals) / len(vals))
    xs = [x for x, v in enumerate(cols) if v > 21]
    left, right = xs[0], xs[-1]
    rect = (left, top, right - left + 1, bottom - top + 1)
    measured = rect[2] / rect[3]
    return rect, measured

def last_click(lab_dir):
    try:
        with open(os.path.join(lab_dir, 'events.jsonl')) as f: lines = f.readlines()
    except OSError: return None
    for line in reversed(lines):
        event = json.loads(line)
        if event['tool'] == 'ydotool' and event['args'][:1] == ['click'] and event['args'][1].lower() in ('0xc0', '0xc1'): return event
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--serial', required=True); ap.add_argument('--monitor', default=os.environ.get('PONTE_LAB_MONITOR', '1920x1080'))
    ap.add_argument('--lab', default=os.environ.get('PONTE_LAB_DIR') or os.path.join(os.getcwd(), '.work', 'lab'))
    ap.add_argument('--points', type=int, default=9); ap.add_argument('--tolerance', type=float, default=3)
    ap.add_argument('--label', default='')
    a = ap.parse_args()
    mw, mh = (int(v) for v in a.monitor.split('x'))
    im = screenshot(a.serial)
    (x0, y0, w, h), measured = image_rect(im, mw / mh)
    print(f'image rect on device: x={x0} y={y0} w={w} h={h} (aspect {measured:.3f}, monitor {mw/mh:.3f})')
    if abs(measured - mw / mh) > 0.03: print('!! aspect mismatch: the frame is cropped, zoomed or the rect was misdetected');
    fractions = [(0.5, 0.5), (0.1, 0.1), (0.9, 0.1), (0.1, 0.9), (0.9, 0.9), (0.3, 0.7), (0.7, 0.3), (0.02, 0.5), (0.98, 0.5)][:a.points]
    worst = 0; rows = []
    for fx, fy in fractions:
        tx, ty = x0 + fx * (w - 1), y0 + fy * (h - 1)
        # Where that device pixel lands on the monitor if the mapping is exact.
        ex, ey = round(fx * (mw - 1)), round(fy * (mh - 1))
        before = last_click(a.lab)
        sh(a.serial, 'shell', 'input', 'tap', str(round(tx)), str(round(ty)))
        deadline = time.time() + 3
        event = None
        while time.time() < deadline:
            event = last_click(a.lab)
            if event and event is not before and (before is None or event['t'] != before['t']): break
            time.sleep(0.05)
        else: event = None
        if not event: rows.append((fx, fy, ex, ey, None, None, None)); print(f'tap {fx:.2f},{fy:.2f} → no click reached the server'); continue
        cx, cy = event['cursor']['x'], event['cursor']['y']
        err = max(abs(cx - ex), abs(cy - ey)); worst = max(worst, err)
        rows.append((fx, fy, ex, ey, cx, cy, err))
        print(f'tap {fx:.2f},{fy:.2f} device ({round(tx)},{round(ty)}) expected ({ex},{ey}) got ({cx},{cy}) err {err}px' + ('  <-- MISS' if err > a.tolerance else ''))
        time.sleep(0.25)
    misses = [r for r in rows if r[6] is None or r[6] > a.tolerance]
    print(f'{a.label} worst error {worst}px over {len(rows)} taps; {len(misses)} outside ±{a.tolerance}px')
    sys.exit(1 if misses else 0)

if __name__ == '__main__': main()

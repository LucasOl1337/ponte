#!/usr/bin/env python3
"""Two-finger gestures over adb sendevent (multitouch protocol B), for the
Android emulator whose touch panel reports 0..32767 on both axes.

  tools/lab/pinch.py --serial emulator-5554 --center 540,1073 --from 150 --to 450 [--steps 12]
  tools/lab/pinch.py ... --pan 0,-200      # two fingers moving together (scroll/pan)
"""
import argparse, subprocess

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--serial', required=True); ap.add_argument('--device', default='/dev/input/event2')
    ap.add_argument('--screen', default='1080x2280'); ap.add_argument('--center', required=True)
    ap.add_argument('--from', dest='start', type=float, default=150); ap.add_argument('--to', dest='end', type=float, default=450)
    ap.add_argument('--pan', default='0,0'); ap.add_argument('--steps', type=int, default=12); ap.add_argument('--vertical', action='store_true')
    a = ap.parse_args()
    sw, sh = (int(v) for v in a.screen.split('x')); cx, cy = (float(v) for v in a.center.split(',')); px, py = (float(v) for v in a.pan.split(','))
    def raw(x, y): return round(x / (sw - 1) * 32767), round(y / (sh - 1) * 32767)
    lines = []
    def ev(t, c, v): lines.append(f'sendevent {a.device} {t} {c} {v}')
    def syn(): ev(0, 0, 0)
    def fingers(i):
        f = i / a.steps
        d = a.start + (a.end - a.start) * f; ox, oy = px * f, py * f
        if a.vertical: return (cx + ox, cy - d / 2 + oy), (cx + ox, cy + d / 2 + oy)
        return (cx - d / 2 + ox, cy + oy), (cx + d / 2 + ox, cy + oy)
    (x1, y1), (x2, y2) = fingers(0)
    for slot, tid, (x, y) in ((0, 100, (x1, y1)), (1, 101, (x2, y2))):
        rx, ry = raw(x, y); ev(3, 47, slot); ev(3, 57, tid); ev(3, 53, rx); ev(3, 54, ry)
        if slot == 0: ev(1, 330, 1)
    syn()
    for i in range(1, a.steps + 1):
        (x1, y1), (x2, y2) = fingers(i)
        for slot, (x, y) in ((0, (x1, y1)), (1, (x2, y2))):
            rx, ry = raw(x, y); ev(3, 47, slot); ev(3, 53, rx); ev(3, 54, ry)
        syn(); lines.append('sleep 0.03')
    for slot in (0, 1): ev(3, 47, slot); ev(3, 57, -1)
    ev(1, 330, 0); syn()
    subprocess.run(['adb', '-s', a.serial, 'shell', '; '.join(lines)], check=True)

if __name__ == '__main__': main()

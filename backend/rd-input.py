#!/usr/bin/env python3
"""Remote-desktop input for Ponte: one persistent process per session that
reads JSON lines on stdin and replays them through two uinput devices.

  ponte-rd-keys  every key, BTN_LEFT..BTN_EXTRA, REL_X/Y and the wheel (hi-res too)
  ponte-rd-abs   ABS_X/Y 0..65535 and the buttons: udev sees an absolute mouse,
                 like QEMU's tablet, and Hyprland maps it onto the monitor layout

Messages (the Node side already mapped codes and coordinates):
  {"s":1,"k":30,"v":1}      key down (v=0 up); k is an evdev keycode
  {"s":2,"b":272,"v":1}     button on the device that moved last
  {"s":3,"a":[x,y]}         absolute position, 0..65535 each
  {"s":4,"r":[dx,dy]}       relative motion
  {"s":5,"w":[hx,hy]}       wheel in 1/120 notch, evdev sign (y > 0 = up)
  {"s":6,"x":1}             release everything held
  {"s":7}                   heartbeat
Each message is acknowledged on stdout with {"s":n} once its events are out.

Safety: everything held is released on EOF, on {"x":1}, and after WATCHDOG
seconds without any message while something is held. The kernel also releases
keys when the device goes away.

--dry-run never opens /dev/uinput: it prints (or appends to --log) one JSON
line per event frame it would have written. Tests and the lab use only that.
"""
import argparse, json, os, select, sys, time

p = argparse.ArgumentParser()
p.add_argument('--dry-run', action='store_true')
p.add_argument('--log', help='dry-run: append event frames to this file instead of stderr')
p.add_argument('--watchdog', type=float, default=2.0)
args = p.parse_args()

try:
    from evdev import ecodes as e
except ImportError:
    if not args.dry_run:
        print(json.dumps({'error': 'python-evdev missing'}), flush=True)
        sys.exit(3)
    e = None

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES = 0, 1, 6, 8, 11, 12
ABS_X, ABS_Y = 0, 1
BUTTONS = [272, 273, 274, 275, 276]  # BTN_LEFT, RIGHT, MIDDLE, SIDE, EXTRA
KEYS = list(range(1, 249))            # KEY_ESC .. KEY_MICMUTE: everything the Node map can send
TYPES = {EV_SYN: 'EV_SYN', EV_KEY: 'EV_KEY', EV_REL: 'EV_REL', EV_ABS: 'EV_ABS'}


def code_name(kind, code):
    if e is None:
        return code
    table = {EV_KEY: {**e.KEY, **e.BTN}, EV_REL: e.REL, EV_ABS: e.ABS}.get(kind, {})
    name = table.get(code, code)
    return name[0] if isinstance(name, (list, tuple)) else name


class DryDevice:
    def __init__(self, name, out):
        self.name, self.out, self.frame = name, out, []

    def write(self, kind, code, value):
        self.frame.append([TYPES[kind], code_name(kind, code), value])

    def syn(self):
        if not self.frame:
            return
        self.out.write(json.dumps({'t': round(time.time(), 3), 'tool': 'rd-input', 'dev': self.name, 'events': self.frame}) + '\n')
        self.out.flush()
        self.frame = []

    def close(self):
        pass


def open_devices():
    if args.dry_run:
        out = open(args.log, 'a') if args.log else sys.stderr
        return DryDevice('ponte-rd-keys', out), DryDevice('ponte-rd-abs', out)
    from evdev import UInput, AbsInfo

    class WriteOnly(UInput):
        # python-evdev opens the new /dev/input/event* node to read it back,
        # retrying for two seconds when that fails. Nothing here reads from it,
        # and a service started before its user joined the 'input' group can
        # write /dev/uinput (logind's ACL) but not open the node: every device
        # would cost two seconds, and a session's first keys would wait that
        # long and then land all at once.
        def _find_device(self, fd):
            return None

    keys = WriteOnly({EV_KEY: KEYS + BUTTONS, EV_REL: [REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES]},
                     name='ponte-rd-keys', vendor=0x1d6b, product=0x0104)
    absolute = WriteOnly({EV_KEY: BUTTONS, EV_ABS: [(ABS_X, AbsInfo(0, 0, 65535, 0, 0, 0)), (ABS_Y, AbsInfo(0, 0, 65535, 0, 0, 0))]},
                         name='ponte-rd-abs', vendor=0x1d6b, product=0x0105)
    return keys, absolute


keys, absolute = open_devices()
pointer = absolute        # buttons go to the device that moved last
held = {}                 # (device, code) -> True
wheel_rest = [0, 0]       # hi-res units not yet worth a whole notch


def press(device, code, value):
    key = (device, code)
    if value and key in held:
        return            # the client's auto-repeat: the target repeats by itself
    if not value and key not in held:
        return
    device.write(EV_KEY, code, 1 if value else 0)
    device.syn()
    if value:
        held[key] = True
    else:
        held.pop(key, None)


def release_all():
    for device, code in list(held):
        device.write(EV_KEY, code, 0)
    held.clear()
    for device in (keys, absolute):
        device.syn()


def clamp(value, low, high):
    return max(low, min(high, int(value)))


def handle(msg):
    global pointer
    if 'k' in msg:
        code = int(msg['k'])
        if code in KEYS:
            press(keys, code, msg.get('v'))
    elif 'b' in msg:
        code = int(msg['b'])
        if code in BUTTONS:
            # A release goes to the device that pressed, even if the other one moved since.
            device = next((d for d, c in held if c == code), pointer) if not msg.get('v') else pointer
            press(device, code, msg.get('v'))
    elif 'a' in msg:
        x, y = msg['a']
        absolute.write(EV_ABS, ABS_X, clamp(x, 0, 65535))
        absolute.write(EV_ABS, ABS_Y, clamp(y, 0, 65535))
        absolute.syn()
        pointer = absolute
    elif 'r' in msg:
        dx, dy = (clamp(v, -10000, 10000) for v in msg['r'])
        if dx: keys.write(EV_REL, REL_X, dx)
        if dy: keys.write(EV_REL, REL_Y, dy)
        keys.syn()
        pointer = keys
    elif 'w' in msg:
        hx, hy = (clamp(v, -12000, 12000) for v in msg['w'])
        for axis, (hi, lo, value) in enumerate(((REL_HWHEEL_HI_RES, REL_HWHEEL, hx), (REL_WHEEL_HI_RES, REL_WHEEL, hy))):
            if not value:
                continue
            keys.write(EV_REL, hi, value)
            wheel_rest[axis] += value
            notches = int(wheel_rest[axis] / 120)
            if notches:
                keys.write(EV_REL, lo, notches)
                wheel_rest[axis] -= notches * 120
        keys.syn()
    elif msg.get('x'):
        release_all()


def main():
    print(json.dumps({'ready': True, 'dryRun': args.dry_run}), flush=True)
    fd = sys.stdin.fileno()
    pending = b''
    last = time.monotonic()
    while True:
        timeout = max(0.05, args.watchdog - (time.monotonic() - last)) if held else None
        ready, _, _ = select.select([fd], [], [], timeout)
        if not ready:
            if held and time.monotonic() - last >= args.watchdog:
                release_all()
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        last = time.monotonic()
        pending += chunk
        *lines, pending = pending.split(b'\n')
        if len(pending) > 65536:
            pending = b''  # no sane message is this long
        acks = []
        for line in lines:
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
                if isinstance(msg, dict):
                    handle(msg)
                    if 's' in msg:
                        acks.append(msg['s'])
            except (ValueError, TypeError, KeyError):
                continue
        if acks:
            sys.stdout.write(''.join(json.dumps({'s': s}) + '\n' for s in acks))
            sys.stdout.flush()


try:
    main()
finally:
    release_all()
    for device in (keys, absolute):
        device.close()

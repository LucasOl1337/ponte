"""Shared state for the Ponte lab fakes. Every fake binary appends what it was
asked to do to events.jsonl and keeps a tiny state.json (cursor, typed text)
so the synthetic monitor can show the result of each phone gesture."""
import json, os, sys, time, fcntl

LAB = os.environ.get('PONTE_LAB_DIR') or os.path.join(os.getcwd(), '.work', 'lab')
STATE = os.path.join(LAB, 'state.json')
EVENTS = os.path.join(LAB, 'events.jsonl')
LOCK = os.path.join(LAB, '.lock')

def monitor():
    size = os.environ.get('PONTE_LAB_MONITOR', '1920x1080')
    w, h = (int(v) for v in size.lower().split('x'))
    return {'id': 0, 'name': 'LAB-1', 'x': 0, 'y': 0, 'width': w, 'height': h, 'scale': 1.0, 'focused': True, 'dpmsStatus': True, 'activeWorkspace': {'id': 1, 'name': '1'}}

def extra_monitors():
    """PONTE_LAB_EXTRA_MONITORS="LAB-2:1280x720,LAB-3:800x600": more outputs to
    the right of LAB-1, listed by hyprctl only (for the remote-desktop monitor
    picker; the synthetic screenshot is always LAB-1)."""
    out, x = [], monitor()['width']
    for i, item in enumerate(filter(None, os.environ.get('PONTE_LAB_EXTRA_MONITORS', '').split(','))):
        name, size = item.split(':')
        w, h = (int(v) for v in size.lower().split('x'))
        out.append({'id': i + 1, 'name': name, 'x': x, 'y': 0, 'width': w, 'height': h, 'scale': 1.0, 'transform': 0, 'focused': False, 'dpmsStatus': True, 'activeWorkspace': {'id': i + 2, 'name': str(i + 2)}})
        x += w
    return out

def default_state():
    m = monitor()
    return {'cursor': {'x': m['width'] // 2, 'y': m['height'] // 2}, 'held': False, 'typed': '', 'clicks': [], 'accel': float(os.environ.get('PONTE_LAB_ACCEL', '1')), 'profile': 'adaptive', 'textFocus': False, 'scrolls': [], 'wheel': 0}

class locked:
    def __enter__(self):
        os.makedirs(LAB, exist_ok=True)
        self.fd = open(LOCK, 'w'); fcntl.flock(self.fd, fcntl.LOCK_EX); return self
    def __exit__(self, *a):
        fcntl.flock(self.fd, fcntl.LOCK_UN); self.fd.close()

def load():
    try:
        with open(STATE) as f: return {**default_state(), **json.load(f)}
    except (OSError, ValueError): return default_state()

def save(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f: json.dump(state, f)
    os.replace(tmp, STATE)

def log(tool, args, extra=None):
    os.makedirs(LAB, exist_ok=True)
    with open(EVENTS, 'a') as f:
        f.write(json.dumps({'t': round(time.time(), 3), 'tool': tool, 'args': args, **(extra or {})}) + '\n')

def targets():
    """Labelled rectangles on the synthetic monitor. Clicking a field turns the
    fcitx focus flag on (the phone keyboard should rise); the button turns it off.
    D is a canvas like Maestri's: its app keeps one input context focused
    whatever is clicked inside it, so a tap there must not raise the keyboard."""
    m = monitor(); W, H = m['width'], m['height']
    found = [
        ('A', 'field', (int(W * 0.12), int(H * 0.2), int(0.18 * W), 70)),
        ('B', 'field', (int(W * 0.55), int(H * 0.55), int(0.28 * W), 70)),
        ('C', 'button', (int(W * 0.7), int(H * 0.15), int(0.16 * W), 70)),
        ('D', 'canvas', (int(W * 0.08), int(H * 0.45), int(0.3 * W), int(0.3 * H))),
    ]
    # PONTE_LAB_TARGET_D="x,y,w,h": one more button anywhere, e.g. in the corner
    # the phone's floating buttons cover, to prove it can still be clicked.
    extra = os.environ.get('PONTE_LAB_TARGET_D', '')
    if extra:
        try:
            x, y, w, h = (int(v) for v in extra.split(','))
            found.append(('E', 'button', (x, y, w, h)))
        except ValueError: pass
    return found

def target_at(x, y):
    for name, kind, (tx, ty, tw, th) in targets():
        if tx <= x <= tx + tw and ty <= y <= ty + th: return name, kind
    return None, None

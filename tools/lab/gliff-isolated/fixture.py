#!/usr/bin/env python3
"""Observable Wayland fixture. Only keyboard/mouse callbacks write events."""
import gi, json, os, time
from pathlib import Path
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib, Gdk
root = Path(os.environ['GLIFF_PROOF_ROOT'])
log = open(root / 'events.jsonl', 'a', buffering=1)
def emit(kind, **data):
    log.write(json.dumps({'kind': kind, 'monotonic_ns': time.monotonic_ns(), **data})+'\n')
app = Gtk.Application(application_id='dev.ponte.GliffProof')
def activate(app):
    win = Gtk.ApplicationWindow(application=app, title='PONTE GLIFF ISOLATED PROOF')
    win.set_default_size(1100, 650)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=24)
    box.set_margin_top(45); box.set_margin_start(60); box.set_margin_end(60)
    title = Gtk.Label(label='PONTE / GLIFF\nISOLATED NOTEBOOK FIXTURE')
    title.set_markup('<span size="28000" weight="bold">PONTE / GLIFF\nISOLATED FIXTURE</span>')
    box.append(title)
    tick = Gtk.Label(); box.append(tick)
    entry = Gtk.Entry(placeholder_text='Type proof token here'); entry.set_size_request(-1,70)
    entry.connect('changed', lambda entry: emit('text', value=entry.get_text()))
    box.append(entry)
    button = Gtk.Button(label='CLICK PROOF 0'); button.set_size_request(-1,90)
    count=[0]
    def click(button):
        count[0]+=1; button.set_label(f'CLICK PROOF {count[0]}'); emit('click', count=count[0])
    button.connect('clicked', click); box.append(button)
    label = Gtk.Label(label='No human compositor, input devices or desktop capture.'); box.append(label)
    def beat():
        tick.set_markup(f'<span size="20000">VIDEO HEARTBEAT {time.monotonic():.1f}</span>'); return True
    GLib.timeout_add(100, beat)
    win.set_child(box); win.present(); entry.grab_focus(); emit('ready', pid=os.getpid())
app.connect('activate', activate)
app.run([])

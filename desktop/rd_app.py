"""Ponte Remoto app: pick a computer and a screen, then drive it through Gliff
with a slim bar for screens and workspaces.

GTK4 + libadwaita like Gliff itself, themed from the same Omarchy colors.toml.
The bar is a layer-shell surface (gtk4-layer-shell) at the top of the screen
that shows the Gliff window: nothing to configure in Hyprland, and it hides
when the Gliff window is not on screen. Without layer-shell (X11, other
compositors) it falls back to a small ordinary window.

Run through ./ponte rd (menu entry Ponte Remoto). Remote effects go only
through desktop/rd_remote.py over the selected SSH alias; locally it only
reads Hyprland to know where the Gliff window is.
"""
import argparse
import ctypes.util
import os
from pathlib import Path
import signal
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
LAYER_LIB = 'libgtk4-layer-shell.so'


def ensure_layer_preload(argv):
    """gtk4-layer-shell must load before libwayland-client: re-exec once with it preloaded."""
    if os.environ.get('PONTE_RD_NO_LAYER') or not os.environ.get('WAYLAND_DISPLAY'):
        return
    if LAYER_LIB in os.environ.get('LD_PRELOAD', '') or os.environ.get('PONTE_RD_PRELOADED'):
        return
    found = next((path for path in ('/usr/lib/libgtk4-layer-shell.so', '/usr/lib64/libgtk4-layer-shell.so',
                                     '/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so') if Path(path).exists()),
                 None) or ctypes.util.find_library('gtk4-layer-shell')
    if not found:
        return
    env = dict(os.environ, PONTE_RD_PRELOADED='1')
    env['LD_PRELOAD'] = found + (':' + env['LD_PRELOAD'] if env.get('LD_PRELOAD') else '')
    os.execve(sys.executable, [sys.executable, str(Path(__file__).resolve()), *argv], env)


if __name__ == '__main__':
    ensure_layer_preload(sys.argv[1:])
    sys.path.insert(0, str(ROOT))

import cairo  # noqa: E402
import gi  # noqa: E402

gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Adw, Gdk, GLib, Gtk  # noqa: E402

try:
    gi.require_version('Gtk4LayerShell', '1.0')
    from gi.repository import Gtk4LayerShell as LayerShell  # noqa: E402
except (ValueError, ImportError):
    LayerShell = None

from desktop import rd, rd_remote, rd_session as rs  # noqa: E402

KIND_ICON = {'pc': 'computer-symbolic', 'notebook': 'computer-symbolic', 'computer': 'computer-symbolic'}


# ---- Theme ------------------------------------------------------------------

def omarchy_palette():
    home = Path.home()
    for directory in (home / '.local/state/omarchy/current/theme', home / '.config/omarchy/current/theme'):
        try:
            text = (directory / 'colors.toml').read_text()
        except OSError:
            continue
        colors = {}
        for line in text.splitlines():
            key, _, value = line.partition('=')
            value = value.strip().strip('"').strip("'")
            if key.strip() and value.startswith('#') and len(value) in (4, 7):
                colors[key.strip()] = value
            elif key.strip() == 'mode':
                colors['mode'] = value
        if 'background' in colors:
            return colors
    return {}


def _rgb(value):
    value = value.lstrip('#')
    if len(value) == 3:
        value = ''.join(c * 2 for c in value)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def _hex(rgb):
    return '#%02x%02x%02x' % tuple(max(0, min(255, round(c))) for c in rgb)


def _mix(a, b, t):
    a, b = _rgb(a), _rgb(b)
    return _hex(tuple(x + (y - x) * t for x, y in zip(a, b)))


def _contrast_fg(value):
    r, g, b = (c / 255 for c in _rgb(value))
    return 'rgb(0 0 6 / 80%)' if 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 else '#ffffff'


def install_css(palette):
    """Same mapping as Gliff's theme.rs, so the picker and the bar match its window."""
    light = palette.get('mode') == 'light'
    bg = palette.get('background') or palette.get('bg') or ('#fafafa' if light else '#1e1e1e')
    fg = palette.get('foreground') or palette.get('fg') or ('#000000' if light else '#ffffff')
    accent = palette.get('accent') or palette.get('blue') or '#3584e4'
    dark = palette.get('dark_background') or _mix(bg, '#000000', 0.25)
    lighter = palette.get('lighter_background') or bg
    view, headerbar, raised = (_mix(bg, '#ffffff', 0.5), bg, lighter) if light else (dark, lighter, lighter)
    muted = palette.get('light_foreground') or fg
    variables = ''
    if palette:
        values = {'accent-bg-color': accent, 'accent-fg-color': _contrast_fg(accent), 'window-bg-color': bg,
                  'window-fg-color': fg, 'view-bg-color': view, 'view-fg-color': fg, 'headerbar-bg-color': headerbar,
                  'headerbar-fg-color': fg, 'headerbar-backdrop-color': bg, 'card-bg-color': raised, 'card-fg-color': fg,
                  'dialog-bg-color': raised, 'dialog-fg-color': fg, 'popover-bg-color': raised, 'popover-fg-color': fg}
        variables = ':root {\n' + ''.join(f'  --{k}: {v};\n' for k, v in values.items()) + '}\n'
    css = variables + f"""
    window.ponte-bar {{ background: transparent; }}
    .ponte-pill {{
      background: alpha({bg}, 0.94); color: {fg};
      border: 1px solid alpha({fg}, 0.10); border-radius: 999px;
      padding: 3px 6px; box-shadow: 0 2px 8px alpha(black, 0.30);
    }}
    .ponte-pill .device {{ font-weight: 600; padding: 0 6px 0 2px; }}
    .ponte-pill .dot {{ min-width: 8px; min-height: 8px; border-radius: 99px; background: #2ec27e; margin: 0 2px 0 6px; }}
    .ponte-pill .dot.busy {{ background: #e5a50a; }}
    .ponte-pill .dot.lost {{ background: #e01b24; }}
    .ponte-pill .sep {{ min-width: 1px; background: alpha({fg}, 0.14); margin: 6px 4px; }}
    .ponte-pill button.flat {{ min-height: 26px; padding: 0 8px; border-radius: 999px; }}
    .ponte-pill .screen.selected {{ background: alpha({accent}, 0.22); color: {fg}; }}
    .ponte-pill .ws {{ min-width: 26px; min-height: 26px; padding: 0; border-radius: 999px; font-feature-settings: "tnum"; }}
    .ponte-pill .ws.empty {{ color: alpha({muted}, 0.75); }}
    .ponte-pill .ws.elsewhere {{ color: alpha({muted}, 0.45); }}
    .ponte-pill .ws.active {{ background: {accent}; color: {bg}; font-weight: 700; }}
    .ponte-pill .ws .mark {{ min-width: 4px; min-height: 4px; border-radius: 99px; background: currentColor; margin-top: 1px; }}
    .ponte-pill .peek {{ font-weight: 600; padding: 0 8px 0 2px; color: alpha({fg}, 0.85); }}
    .screen-map {{ background: alpha({fg}, 0.04); border-radius: 12px; }}
    .screen-tile {{ border-radius: 8px; border: 2px solid alpha({fg}, 0.18); background: alpha({fg}, 0.06); padding: 6px; }}
    .screen-tile:hover {{ border-color: alpha({accent}, 0.6); }}
    .screen-tile.selected {{ border-color: {accent}; background: alpha({accent}, 0.16); }}
    .screen-tile .title {{ font-weight: 700; }}
    .screen-tile .caption {{ font-size: smaller; opacity: 0.7; }}
    """
    provider = Gtk.CssProvider()
    provider.load_from_string(css)
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
                                              Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)


# ---- Demo data --------------------------------------------------------------

DEMO_STATE = {
    't': 'state', 'v': 1, 'slots': 10,
    'monitors': [
        {'name': 'HDMI-A-1', 'description': 'Samsung LS27', 'make': 'Samsung Electric Company', 'model': 'LS27',
         'width': 1920, 'height': 1080, 'x': 0, 'y': 180, 'scale': 1, 'focused': True, 'active': 4, 'block': 0},
        {'name': 'DP-2', 'description': 'ASUS VG32', 'make': 'ASUSTek COMPUTER INC', 'model': 'VG32VQ1B',
         'width': 2560, 'height': 1440, 'x': 1920, 'y': 0, 'scale': 1, 'focused': False, 'active': 21, 'block': 2},
    ],
    'workspaces': [
        {'id': 1, 'name': '1', 'monitor': 'HDMI-A-1', 'windows': 0},
        {'id': 3, 'name': '3', 'monitor': 'HDMI-A-1', 'windows': 2},
        {'id': 4, 'name': '4', 'monitor': 'HDMI-A-1', 'windows': 1},
        {'id': 6, 'name': '6', 'monitor': 'HDMI-A-1', 'windows': 3},
        {'id': 21, 'name': '21', 'monitor': 'DP-2', 'windows': 1},
        {'id': 27, 'name': '27', 'monitor': 'DP-2', 'windows': 2},
    ],
}


def run_async(work, done):
    """Run work() in a thread, then done(result, error) on the GTK thread."""
    def target():
        try:
            result, error = work(), None
        except Exception as caught:  # noqa: BLE001 - surfaced to the user as text
            result, error = None, caught
        GLib.idle_add(lambda: (done(result, error), False)[1])
    threading.Thread(target=target, daemon=True).start()


# ---- The bar ------------------------------------------------------------------

class Bar(Gtk.Window):
    def __init__(self, app):
        super().__init__(application=app.gtk, title='Ponte Remoto · barra')
        self.app = app
        self.add_css_class('ponte-bar')
        self.set_decorated(False)
        self.layer = bool(LayerShell and LayerShell.is_supported())
        # Left resizable: a fixed-size window ignores the stretch between the
        # left and right anchors, and the pill sits at the window's left edge.
        if self.layer:
            LayerShell.init_for_window(self)
            LayerShell.set_namespace(self, 'ponte-rd-bar')
            LayerShell.set_layer(self, LayerShell.Layer.OVERLAY)
            LayerShell.set_anchor(self, LayerShell.Edge.TOP, True)
            LayerShell.set_margin(self, LayerShell.Edge.TOP, 2)
            # No keyboard: a click on an area must not take typing away from Gliff.
            LayerShell.set_keyboard_mode(self, LayerShell.KeyboardMode.NONE)
        self.expanded_by_hover = False
        self.collapse_timer = None

        pill = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        pill.add_css_class('ponte-pill')
        pill.set_halign(Gtk.Align.CENTER)
        # Room for the shadow inside the surface, else the compositor clips it square.
        for side in ('top', 'bottom', 'start', 'end'):
            getattr(pill, f'set_margin_{side}')(2 if side == 'top' else 12)
        self.dot = Gtk.Box()
        self.dot.add_css_class('dot')
        self.dot.set_valign(Gtk.Align.CENTER)
        pill.append(self.dot)

        self.menu = Gtk.MenuButton()
        self.menu.add_css_class('flat')
        self.device_label = Gtk.Label(css_classes=['device'])
        self.menu.set_child(self.device_label)
        self.menu.set_tooltip_text('Aparelho e sessão')
        self.menu.set_popover(self._menu_popover())
        self.menu.get_popover().connect('closed', lambda *_: self._schedule_collapse())
        self.menu.connect('notify::active', lambda button, *_: self._menu_keyboard(button.get_active()))
        pill.append(self.menu)

        self.peek = Gtk.Label(css_classes=['peek'])
        pill.append(self.peek)

        self.revealer = Gtk.Revealer(transition_type=Gtk.RevealerTransitionType.SLIDE_RIGHT, transition_duration=140)
        body = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        sep = Gtk.Box(css_classes=['sep'])
        body.append(sep)
        self.screens = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        body.append(self.screens)
        self.screens_sep = Gtk.Box(css_classes=['sep'])
        body.append(self.screens_sep)
        self.strip = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=1)
        body.append(self.strip)
        self.revealer.set_child(body)
        pill.append(self.revealer)

        motion = Gtk.EventControllerMotion()
        motion.connect('enter', lambda *_: self._expand())
        motion.connect('leave', lambda *_: self._schedule_collapse())
        pill.add_controller(motion)
        self.set_child(pill)
        self.pill = pill
        self.signature = None
        self.placement = None
        self.input_box = None
        self.track_until = 0
        self.connect('map', lambda *_: self._track())

    def _menu_popover(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin_top=6, margin_bottom=6,
                      margin_start=6, margin_end=6)
        def item(label, callback):
            button = Gtk.Button(label=label, css_classes=['flat'])
            button.get_child().set_xalign(0)
            button.connect('clicked', lambda *_: (self.menu.popdown(), callback()))
            box.append(button)
        item('Trocar de aparelho…', self.app.switch_device)
        item('Reconectar o vídeo', self.app.reconnect_video)
        box.append(Gtk.Separator(margin_top=4, margin_bottom=4))
        self.follow_switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        self.follow_switch.set_active(self.app.prefs['follow'])
        self.follow_switch.connect('notify::active', lambda sw, *_: self.app.set_follow(sw.get_active()))
        row = Gtk.Box(spacing=12, margin_start=10, margin_end=4)
        label = Gtk.Label(label='Seguir a tela da área escolhida', hexpand=True, xalign=0)
        row.append(label)
        row.append(self.follow_switch)
        box.append(row)
        self.pin_switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        self.pin_switch.set_active(self.app.prefs.get('pinned', False))
        self.pin_switch.connect('notify::active', lambda sw, *_: self.app.set_pinned(sw.get_active()))
        row = Gtk.Box(spacing=12, margin_start=10, margin_end=4)
        row.append(Gtk.Label(label='Manter a barra aberta', hexpand=True, xalign=0))
        row.append(self.pin_switch)
        box.append(row)
        box.append(Gtk.Separator(margin_top=4, margin_bottom=4))
        item('Desconectar', self.app.disconnect)
        hint = Gtk.Label(label='Shift+Esc devolve o teclado a este computador.', xalign=0, wrap=True,
                         max_width_chars=34, css_classes=['dim-label', 'caption'], margin_start=10, margin_top=4)
        box.append(hint)
        popover = Gtk.Popover()
        popover.set_child(box)
        return popover

    def _menu_keyboard(self, open_):
        """Only the open menu takes the keyboard (its popover needs a grab)."""
        if self.layer:
            LayerShell.set_keyboard_mode(self, LayerShell.KeyboardMode.ON_DEMAND if open_
                                         else LayerShell.KeyboardMode.NONE)

    def _expand(self):
        if self.collapse_timer:
            GLib.source_remove(self.collapse_timer)
            self.collapse_timer = None
        self.revealer.set_reveal_child(True)
        self.peek.set_visible(False)
        self._track()

    def _schedule_collapse(self):
        if self.app.prefs.get('pinned') or self.menu.get_active():
            return
        if self.collapse_timer:
            GLib.source_remove(self.collapse_timer)
        self.collapse_timer = GLib.timeout_add(900, self._collapse)

    def _collapse(self):
        self.collapse_timer = None
        if self.app.prefs.get('pinned') or self.menu.get_active():
            return False
        self.revealer.set_reveal_child(False)
        self.peek.set_visible(True)
        self._track()
        return False

    def set_status(self, status):
        for name in ('busy', 'lost'):
            self.dot.remove_css_class(name)
        if status in ('busy', 'lost'):
            self.dot.add_css_class(status)

    def place(self, monitor_name, rect=None, monitor_width=None):
        """Over the Gliff window: the surface spans the window's width (left and
        right margins) and the pill centers inside it; clicks outside the pill
        go through (input region below)."""
        if not self.layer or not monitor_name:
            return
        placement = (monitor_name, rect, monitor_width)
        if placement == self.placement:
            return
        self.placement = placement
        display = Gdk.Display.get_default()
        monitors = display.get_monitors()
        for index in range(monitors.get_n_items()):
            monitor = monitors.get_item(index)
            if monitor.get_connector() == monitor_name:
                LayerShell.set_monitor(self, monitor)
                break
        left = right = 0
        if rect and monitor_width and rect[2] > 0:
            left = max(0, rect[0])
            right = max(0, monitor_width - rect[0] - rect[2])
        for edge in (LayerShell.Edge.LEFT, LayerShell.Edge.RIGHT):
            LayerShell.set_anchor(self, edge, True)
        LayerShell.set_margin(self, LayerShell.Edge.LEFT, left)
        LayerShell.set_margin(self, LayerShell.Edge.RIGHT, right)

    def _clip_input(self, *_args):
        """Only the pill takes the pointer; the transparent rest of the strip
        lets clicks reach the Gliff window below."""
        surface = self.get_surface()
        if surface is None:
            return True
        ok, bounds = self.pill.compute_bounds(self)
        if not ok:
            return True
        box = (int(bounds.get_x()), int(bounds.get_y()), int(bounds.get_width()) + 1, int(bounds.get_height()) + 1)
        if box != self.input_box:
            self.input_box = box
            surface.set_input_region(cairo.Region(cairo.RectangleInt(*box)))
        return True

    def _track(self, seconds=0.5):
        """Follow the pill's size for a moment (an animation, a re-render),
        then let the frame clock rest."""
        if not self.layer:
            return
        running = GLib.get_monotonic_time() < self.track_until
        self.track_until = GLib.get_monotonic_time() + int(seconds * 1e6)
        if not running:
            self.add_tick_callback(lambda *_: self._clip_input() and GLib.get_monotonic_time() < self.track_until)

    def render(self):
        app = self.app
        state, output = app.state, app.output
        chips = rs.workspace_strip(state, output) if state else []
        monitors = (state or {}).get('monitors', [])
        signature = (app.item['name'], output, repr(chips), repr([(m['name'], m['width'], m['height']) for m in monitors]),
                     app.switching)
        active = next((chip for chip in chips if chip['active']), None)
        monitor = rs.find_monitor(state, output)
        self.device_label.set_label(app.item['name'])
        peek = []
        if len(monitors) > 1 and monitor:
            peek.append(rs.monitor_label(monitor))
        if active:
            peek.append(active['label'])
        self.peek.set_label(' · '.join(peek))
        self._track(0.3)
        waiting = app.switching or (app.channel is not None and not state)
        self.set_status('busy' if waiting else ('lost' if app.lost else 'ok'))
        if signature == self.signature:
            return
        self.signature = signature

        for container in (self.screens, self.strip):
            while child := container.get_first_child():
                container.remove(child)
        for item in monitors:
            button = Gtk.Button(label=rs.monitor_label(item), css_classes=['flat', 'screen'])
            button.set_tooltip_text(f"{item['name']} · {item['width']}×{item['height']}")
            if item['name'] == output:
                button.add_css_class('selected')
            button.connect('clicked', lambda _b, name=item['name']: app.switch_output(name))
            self.screens.append(button)
        self.screens.set_visible(len(monitors) > 1)
        self.screens_sep.set_visible(len(monitors) > 1)
        for chip in chips:
            button = Gtk.Button(css_classes=['flat', 'ws'])
            inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
            inner.append(Gtk.Label(label=chip['label']))
            mark = Gtk.Box(css_classes=['mark'], halign=Gtk.Align.CENTER)
            mark.set_opacity(1 if chip['windows'] else 0)
            inner.append(mark)
            button.set_child(inner)
            if chip['active']:
                button.add_css_class('active')
            elif chip['elsewhere']:
                button.add_css_class('elsewhere')
            elif not chip['windows']:
                button.add_css_class('empty')
            windows = chip['windows']
            tip = f"Área {chip['label']}" + (f" · {windows} janela" + ('s' if windows != 1 else '') if windows else ' · vazia')
            if chip['elsewhere']:
                tip += ' · está em outra tela'
            button.set_tooltip_text(tip)
            button.connect('clicked', lambda _b, c=chip: app.focus_workspace(c))
            self.strip.append(button)
        if app.prefs.get('pinned'):
            self._expand()


# ---- Picker -----------------------------------------------------------------

class Picker(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app.gtk, title='Ponte Remoto')
        self.app = app
        self.set_default_size(480, 620)
        self.toasts = Adw.ToastOverlay()
        self.nav = Adw.NavigationView()
        self.toasts.set_child(self.nav)
        self.set_content(self.toasts)
        self.rows, self.row_parents = {}, []
        self.nav.add(self._devices_page())

    def toast(self, text):
        toast = Adw.Toast(title=GLib.markup_escape_text(text[:300]))
        toast.set_timeout(6)
        self.toasts.add_toast(toast)

    def _devices_page(self):
        view = Adw.ToolbarView()
        header = Adw.HeaderBar()
        refresh = Gtk.Button(icon_name='view-refresh-symbolic', tooltip_text='Atualizar')
        refresh.connect('clicked', lambda *_: self.app.load_devices())
        header.pack_end(refresh)
        view.add_top_bar(header)
        page = Adw.PreferencesPage()
        self.computers = Adw.PreferencesGroup(title='Computadores',
                                              description='Gliff por SSH. Escolha um para ver as telas dele.')
        page.add(self.computers)
        self.others_group = Adw.PreferencesGroup()
        self.others = Adw.ExpanderRow(title='Outros destinos SSH', subtitle='Servidores e aliases sem Hyprland conhecido')
        self.others_group.add(self.others)
        page.add(self.others_group)
        legacy_group = Adw.PreferencesGroup()
        legacy = Adw.ActionRow(title='Web legado', subtitle='Cliente Chromium com os aparelhos pareados no Ponte',
                               activatable=True)
        legacy.add_prefix(Gtk.Image(icon_name='web-browser-symbolic'))
        legacy.add_suffix(Gtk.Image(icon_name='go-next-symbolic'))
        legacy.connect('activated', lambda *_: self.app.open_legacy())
        legacy_group.add(legacy)
        page.add(legacy_group)
        view.set_content(page)
        self.placeholder = Adw.ActionRow(title='Procurando aparelhos…')
        self.computers.add(self.placeholder)
        return Adw.NavigationPage(title='Ponte Remoto', tag='devices', child=view)

    def show_devices(self, computers, others):
        for row, other in self.row_parents:
            (self.others.remove if other else self.computers.remove)(row)
        if self.placeholder:
            self.computers.remove(self.placeholder)
            self.placeholder = None
        self.rows, self.row_parents = {}, []
        if not computers:
            self.placeholder = Adw.ActionRow(title='Nenhum computador configurado',
                                             subtitle='Adicione um Host em ~/.ssh/config ou ssh.hosts no Ponte.')
            self.computers.add(self.placeholder)
        for entry in computers:
            row = self._row(entry)
            self.computers.add(row)
            self.row_parents.append((row, False))
        for entry in others:
            row = self._row(entry)
            self.others.add_row(row)
            self.row_parents.append((row, True))
        self.others_group.set_visible(bool(others))

    def _row(self, entry):
        row = Adw.ActionRow(title=GLib.markup_escape_text(entry['name']), activatable=True)
        row.add_prefix(Gtk.Image(icon_name=KIND_ICON.get(entry.get('kind'), 'network-server-symbolic')))
        spinner = Adw.Spinner()
        spinner.set_visible(False)
        row.add_suffix(spinner)
        row.add_suffix(Gtk.Image(icon_name='go-next-symbolic'))
        row.spinner = spinner
        row.entry = entry
        row.connect('activated', lambda *_: self.app.choose_device(entry))
        self.rows[entry['id']] = row
        self.update_row(entry['id'])
        return row

    def update_row(self, ident):
        row = self.rows.get(ident)
        if not row:
            return
        entry = row.entry
        probe = self.app.probes.get(ident)
        parts = [entry['alias']]
        status = {'online': 'online', 'offline': 'offline'}.get(entry.get('status'))
        if status:
            parts.append(status)
        busy = False
        if probe is None:
            pass
        elif probe.get('pending'):
            parts.append('verificando…')
            busy = True
        elif probe.get('error'):
            parts.append(probe['error'][:90])
        else:
            count = len(probe['state']['monitors'])
            parts.append(f"{count} tela{'s' if count != 1 else ''} · pronto")
        row.set_subtitle(GLib.markup_escape_text(' · '.join(parts)))
        row.spinner.set_visible(busy)

    def show_screens(self, entry, state, selected):
        page_view = Adw.ToolbarView()
        page_view.add_top_bar(Adw.HeaderBar())
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16, margin_top=12, margin_bottom=18,
                          margin_start=18, margin_end=18)
        title = Gtk.Label(label=f"Qual tela de {entry['name']}?", xalign=0, css_classes=['title-2'])
        content.append(title)
        hint = Gtk.Label(label='Na barra da sessão dá para trocar depois, e as áreas de cada tela aparecem lá.',
                         xalign=0, wrap=True, css_classes=['dim-label'])
        content.append(hint)
        chosen = {'name': selected}
        tiles = {}
        canvas = Gtk.Fixed(css_classes=['screen-map'])
        monitors = state['monitors']
        min_x = min(m['x'] for m in monitors)
        min_y = min(m['y'] for m in monitors)
        # Logical sizes, laid out side by side as in Hyprland; gaps from disabled monitors are closed.
        ordered = sorted(monitors, key=lambda m: (m['x'], m['y']))
        boxes, cursor = [], 0
        for m in ordered:
            scale = m.get('scale') or 1
            w, h = m['width'] / scale, m['height'] / scale
            boxes.append((m, cursor, m['y'] - min_y, w, h))
            cursor += w
        total_w = max(x + w for _, x, _, w, _ in boxes)
        total_h = max(y + h for _, _, y, _, h in boxes)
        avail_w, avail_h = 420, 220
        factor = min(avail_w / total_w, avail_h / total_h)
        pad = 12
        canvas.set_size_request(int(total_w * factor) + 2 * pad, int(total_h * factor) + 2 * pad)
        gap = 6
        del min_x

        def select(name):
            chosen['name'] = name
            for key, tile in tiles.items():
                (tile.add_css_class if key == name else tile.remove_css_class)('selected')

        for m, x, y, w, h in boxes:
            tile = Gtk.Button(css_classes=['screen-tile', 'flat'])
            inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, valign=Gtk.Align.CENTER, spacing=2)
            inner.append(Gtk.Label(label=rs.monitor_label(m), css_classes=['title']))
            active = rs.workspace_strip(state, m['name'])
            current = next((c['label'] for c in active if c['active']), None)
            caption = m['name'] + (f' · área {current}' if current else '')
            inner.append(Gtk.Label(label=caption, css_classes=['caption']))
            tile.set_child(inner)
            tile.set_size_request(max(80, int(w * factor) - gap), max(56, int(h * factor) - gap))
            tile.connect('clicked', lambda _b, name=m['name']: select(name))
            canvas.put(tile, pad + x * factor + gap / 2, pad + y * factor + gap / 2)
            tiles[m['name']] = tile
        select(selected)
        frame = Gtk.Box(halign=Gtk.Align.CENTER)
        frame.append(canvas)
        content.append(frame)
        connect = Gtk.Button(label='Conectar', css_classes=['suggested-action', 'pill'], halign=Gtk.Align.CENTER)
        connect.connect('clicked', lambda *_: self.app.start_session(entry, chosen['name']))
        content.append(connect)
        page_view.set_content(content)
        page = Adw.NavigationPage(title=entry['name'], tag='screens', child=page_view)
        if self.nav.find_page('screens'):
            self.nav.pop_to_tag('devices')
        self.nav.push(page)
        connect.grab_focus()

    def show_connecting(self, entry):
        view = Adw.ToolbarView()
        view.add_top_bar(Adw.HeaderBar())
        status = Adw.StatusPage(title=f"Conectando a {entry['name']}…", description='Conferindo SSH, Gliff e as telas.')
        status.set_child(Adw.Spinner(halign=Gtk.Align.CENTER, width_request=32, height_request=32))
        view.set_content(status)
        if self.nav.find_page('connecting'):
            self.nav.pop_to_tag('devices')
        self.nav.push(Adw.NavigationPage(title=entry['name'], tag='connecting', child=view))

    def back_to_devices(self):
        self.nav.pop_to_tag('devices')


# ---- Application ------------------------------------------------------------

class App:
    def __init__(self, options):
        self.options = options
        self.gtk = Adw.Application(application_id=None, flags=0)
        GLib.set_prgname('ponte-rd')
        GLib.set_application_name('Ponte Remoto')
        self.gtk.connect('activate', self.on_activate)
        self.prefs = rs.load_prefs()
        self.probes = {}
        self.entries = {}
        self.picker = None
        self.bar = None
        self.item = None
        self.state = None
        self.output = None
        self.channel = None
        self.gliff = None
        self.switching = False
        self.lost = False
        self.last_focused = None
        self.follow_timer = None
        self.local_watch = None
        self.local_pending = False
        self.closing = False

    def save_prefs(self):
        if not self.options.demo:
            rs.save_prefs(self.prefs)

    # --- startup
    def on_activate(self, _app):
        if self.picker:
            self.picker.present()
            return
        palette = omarchy_palette()
        style = Adw.StyleManager.get_default()
        mode = palette.get('mode')
        style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT if mode == 'light' else Adw.ColorScheme.FORCE_DARK
                               if palette else Adw.ColorScheme.DEFAULT)
        install_css(palette)
        self.picker = Picker(self)
        if self.options.demo:
            self.load_demo()
            return
        self.picker.present()
        self.load_devices(then=self.options.device)

    def load_demo(self):
        entry = {'id': 'ssh:demo', 'name': 'lol (demonstração)', 'alias': 'demo', 'aliases': ['demo'],
                 'engine': 'gliff', 'kind': 'pc', 'status': 'online'}
        self.entries = {entry['id']: entry}
        self.probes[entry['id']] = {'state': DEMO_STATE, 'gliff': None, 'ssh': None}
        self.picker.show_devices([entry], [])
        self.picker.update_row(entry['id'])
        if self.options.demo == 'bar':
            self.item, self.state, self.output = entry, DEMO_STATE, 'HDMI-A-1'
            self.prefs['pinned'] = bool(os.environ.get('PONTE_RD_DEMO_OPEN'))
            self.show_bar()
            if os.environ.get('PONTE_RD_DEMO_MENU'):
                GLib.timeout_add(600, lambda: (self.bar.menu.set_active(True), False)[1])
            return
        self.picker.present()
        if self.options.demo == 'screens':
            self.picker.show_screens(entry, DEMO_STATE, 'DP-2')

    def load_devices(self, then=None):
        config_file = self.options.config

        def work():
            items = rd.destinations(config_file)
            ponte = rs.fetch_ponte_devices(os.environ.get('PONTE_RD_ORIGIN'), os.environ.get('PONTE_RD_TOKEN_FILE'))
            return items, rs.merge_devices(items, ponte)

        def done(result, error):
            if error:
                self.picker.toast(str(error))
                return
            items, (computers, others) = result
            self.entries = {entry['id']: entry for entry in computers + others}
            self.probes = {}
            self.picker.show_devices(computers, others)
            if then:
                try:
                    target = rd.resolve(items, then)
                except ValueError as failure:
                    self.picker.toast(str(failure))
                    return
                entry = next((e for e in self.entries.values() if target['alias'] in e['aliases']), None) or target
                self.entries.setdefault(entry['id'], entry)
                self.choose_device(entry)
                return
            for entry in computers:
                if entry.get('status') != 'offline':
                    self.probe(entry)

        run_async(work, done)

    def probe_args(self):
        args = argparse.Namespace(server_bin=self.options.server_bin, headless=False, monitor=None,
                                  no_clipboard=self.options.no_clipboard, video=self.options.video)
        return args

    def probe(self, entry, then=None):
        ident = entry['id']
        if self.probes.get(ident, {}).get('pending'):
            if then:
                self.probes[ident].setdefault('then', []).append(then)
            return
        self.probes[ident] = {'pending': True, 'then': [then] if then else []}
        self.picker.update_row(ident)
        args = self.probe_args()

        def work():
            gliff, ssh = rd.preflight(entry, args)
            state = rs.read_state_once(entry['alias'], ssh) if args.server_bin == 'gliff-server' else None
            return gliff, ssh, state

        def done(result, error):
            waiting = self.probes.get(ident, {}).get('then', [])
            if error:
                self.probes[ident] = {'error': str(error)}
            else:
                gliff, ssh, state = result
                self.probes[ident] = {'gliff': gliff, 'ssh': ssh, 'state': state}
            self.picker.update_row(ident)
            for callback in waiting:
                callback()

        run_async(work, done)

    # --- choosing
    def choose_device(self, entry):
        if self.item:
            return
        probe = self.probes.get(entry['id'])
        if not probe or probe.get('error'):
            self.picker.show_connecting(entry)
            self.picker.present()
            self.probe(entry, then=lambda: self.choose_device_ready(entry))
            return
        if probe.get('pending'):
            self.picker.show_connecting(entry)
            probe.setdefault('then', []).append(lambda: self.choose_device_ready(entry))
            return
        self.choose_device_ready(entry)

    def choose_device_ready(self, entry):
        probe = self.probes.get(entry['id']) or {}
        if probe.get('error'):
            self.picker.back_to_devices()
            self.picker.present()
            self.picker.toast(probe['error'])
            return
        state = probe.get('state')
        if self.options.monitor:
            return self.start_session(entry, self.options.monitor)
        if not state:
            return self.start_session(entry, None)
        remembered = self.prefs['outputs'].get(entry['alias'])
        if len(state['monitors']) > 1 and not (remembered and rs.find_monitor(state, remembered)):
            self.picker.show_screens(entry, state, rs.choose_output(state))
            self.picker.present()
            return
        self.start_session(entry, rs.choose_output(state, remembered))

    # --- session
    def start_session(self, entry, output):
        if self.item:
            return
        probe = self.probes.get(entry['id']) or {}
        if self.options.demo:
            self.item, self.state, self.output = entry, probe.get('state'), output
            self.picker.set_visible(False)
            self.show_bar()
            return
        gliff, ssh = probe.get('gliff'), probe.get('ssh')
        if not gliff:
            return
        self.item, self.output, self.state = entry, output, probe.get('state')
        self.lost = False
        if output:
            self.prefs['outputs'][entry['alias']] = output
        self.prefs['last'] = entry['alias']
        self.save_prefs()
        options = {'server_bin': self.options.server_bin, 'no_clipboard': self.options.no_clipboard,
                   'video': self.options.video}
        self.gliff = rs.Gliff(entry, gliff, ssh, options,
                              on_exit=lambda code, detail: GLib.idle_add(self.on_gliff_exit, code, detail))
        if self.options.server_bin == 'gliff-server':
            # A private --server-bin wrapper drives another compositor; the
            # channel would find the session one, so it stays off there.
            self.channel = rs.Channel(entry['alias'], ssh,
                                      on_message=lambda m: GLib.idle_add(self.on_remote, m),
                                      on_close=lambda code, detail: GLib.idle_add(self.on_channel_closed, code, detail))
        self.focus_remote_output(output)
        try:
            self.gliff.start(output)
        except (OSError, ValueError) as error:
            self.end_session(keep_open=True)
            self.picker.toast(f'Gliff não abriu: {error}')
            return
        self.picker.back_to_devices()
        self.picker.set_visible(False)
        self.show_bar()

    def focus_remote_output(self, output):
        monitor = rs.find_monitor(self.state, output)
        if self.channel and monitor and not monitor['focused']:
            self.channel.monitor(output)

    def show_bar(self):
        if not self.bar:
            self.bar = Bar(self)
        self.bar.render()
        self.bar.present()
        self.local_watch = GLib.timeout_add(700, self.place_bar)
        self.place_bar()

    def place_bar(self):
        if not self.bar or not self.gliff:
            return bool(self.bar)
        where = rs.local_window(self.gliff.pid)
        visible = where['visible'] or self.switching
        if where['monitor']:
            self.bar.place(where['monitor'], where['rect'], where['monitor_width'])
        self.bar.set_visible(visible)
        return True

    def on_remote(self, message):
        if message.get('t') == 'state':
            focused = next((m['name'] for m in message['monitors'] if m['focused']), None)
            previous = self.last_focused
            self.state, self.last_focused, self.lost = message, focused, False
            if self.output and not rs.find_monitor(message, self.output) and message['monitors']:
                # The screen we were mirroring went away.
                self.switch_output(rs.choose_output(message))
            elif (self.prefs['follow'] and previous and focused and focused != previous
                  and focused != self.output and not self.switching):
                self.schedule_follow(focused)
        elif message.get('t') == 'error' and self.picker:
            codes = {'NO_HYPRLAND': 'O Hyprland do outro computador não respondeu.',
                     'INVALID_MONITOR': 'Essa tela não existe mais.'}
            self.flash(codes.get(message.get('code'), f"Erro remoto: {message.get('code')}"))
        if self.bar:
            self.bar.render()

    def schedule_follow(self, name):
        if self.follow_timer:
            GLib.source_remove(self.follow_timer)

        def fire():
            self.follow_timer = None
            current = next((m['name'] for m in (self.state or {}).get('monitors', []) if m['focused']), None)
            if current == name and name != self.output:
                self.switch_output(name, focus=False)
            return False
        self.follow_timer = GLib.timeout_add(300, fire)

    def on_channel_closed(self, code, detail):
        if self.closing or not self.item:
            return
        self.lost = True
        if self.bar:
            self.bar.render()
        if code == 255:
            self.flash('O canal de controle caiu. O vídeo segue pelo Gliff.')

    def flash(self, text):
        if self.picker and self.picker.get_visible():
            self.picker.toast(text)
        elif self.bar:
            self.bar.set_tooltip_text(text)

    def on_gliff_exit(self, code, detail):
        if self.closing:
            return
        if self.switching:
            return
        if code == 0:
            # The Gliff window was closed: the session is over.
            self.end_session()
            return
        message = f'O Gliff fechou com código {code}.' + (f' {detail[-200:]}' if detail else '')
        self.end_session(keep_open=True)
        self.picker.toast(message)

    # --- bar actions
    def switch_output(self, name, focus=True):
        if not self.item or not name or (name == self.output and self.gliff and self.gliff.pid):
            return
        self.output = name
        self.prefs['outputs'][self.item['alias']] = name
        self.save_prefs()
        if focus:
            self.focus_remote_output(name)
        if self.options.demo:
            self.bar.render()
            return
        self.switching = True
        self.bar.render()

        def work():
            self.gliff.start(name)
            return rs.wait_for(lambda: self.gliff and rs.local_window(self.gliff.pid)['rect'], 8)

        def done(_result, error):
            self.switching = False
            if error:
                self.flash(f'Não foi possível abrir a tela {name}: {error}')
            if self.bar:
                self.bar.render()
            self.place_bar()

        run_async(work, done)

    def focus_workspace(self, chip):
        if self.options.demo:
            for monitor in self.state['monitors']:
                if monitor['name'] == self.output:
                    monitor['active'] = chip['id']
            self.bar.render()
            return
        if not self.channel:
            return
        target = next((s for s in self.state.get('workspaces', []) if s['id'] == chip['id']), None)
        if target and target['monitor'] != self.output and self.prefs['follow']:
            # Lives on another screen: go there, like Super+N does.
            self.channel.workspace(chip['id'])
            self.switch_output(target['monitor'], focus=False)
            return
        self.channel.workspace(chip['id'], self.output)

    def set_follow(self, value):
        self.prefs['follow'] = bool(value)
        self.save_prefs()

    def set_pinned(self, value):
        self.prefs['pinned'] = bool(value)
        self.save_prefs()
        if self.bar:
            (self.bar._expand if value else self.bar._schedule_collapse)()

    def reconnect_video(self):
        if self.gliff and self.output is not None:
            self.switching = True
            run_async(lambda: (self.gliff.start(self.output), rs.wait_for(lambda: self.gliff and rs.local_window(self.gliff.pid)['rect'], 8)),
                      lambda *_: (setattr(self, 'switching', False), self.bar and self.bar.render()))

    def switch_device(self):
        self.end_session(keep_open=True)

    def disconnect(self):
        self.end_session()

    def open_legacy(self):
        self.closing = True
        self.gtk.quit()
        self.after = 'legacy'

    def end_session(self, keep_open=False):
        self.closing = True
        if self.follow_timer:
            GLib.source_remove(self.follow_timer)
            self.follow_timer = None
        if self.local_watch:
            GLib.source_remove(self.local_watch)
            self.local_watch = None
        gliff, channel = self.gliff, self.channel
        self.gliff = self.channel = None
        if gliff:
            gliff.stop()
        if channel:
            channel.close()
        if self.bar:
            self.bar.set_visible(False)
            self.bar.destroy()
            self.bar = None
        self.item = self.state = self.output = None
        self.switching = self.lost = False
        self.last_focused = None
        self.closing = False
        if keep_open:
            self.picker.back_to_devices()
            self.picker.present()
            self.load_devices()
        else:
            self.gtk.quit()

    def run(self):
        self.after = None
        # SIGTERM/SIGINT (logout, Ctrl+C): quit the loop so the finally below
        # closes this session's Gliff window and channel, not leave them behind.
        try:
            gi.require_version('GLibUnix', '2.0')
            from gi.repository import GLibUnix
            signal_add = GLibUnix.signal_add
        except (ImportError, ValueError):
            signal_add = GLib.unix_signal_add
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal_add(GLib.PRIORITY_DEFAULT, number, lambda *_: (self.gtk.quit(), False)[1])
        self.gtk.hold()
        try:
            self.gtk.run([])
        finally:
            self.gtk.release()
            if self.gliff or self.channel:
                self.closing = True
                if self.gliff:
                    self.gliff.stop()
                if self.channel:
                    self.channel.close()
        return self.after


def parse(argv):
    parser = argparse.ArgumentParser(prog='ponte rd (app)')
    parser.add_argument('device', nargs='?')
    parser.add_argument('--config', required=False, default=os.environ.get('PONTE_RD_CONFIG', ''))
    parser.add_argument('--server-bin', default='gliff-server')
    parser.add_argument('--no-clipboard', action='store_true')
    parser.add_argument('--video', choices=['gpu', 'cpu'])
    parser.add_argument('--monitor')
    parser.add_argument('--demo', nargs='?', const='devices', choices=['devices', 'screens', 'bar'])
    return parser.parse_args(argv)


def main(argv=None):
    options = parse(sys.argv[1:] if argv is None else argv)
    if options.server_bin != 'gliff-server' and not rd.SERVER.fullmatch(options.server_bin):
        print('Ponte Remoto: invalid --server-bin.', file=sys.stderr)
        return 2
    app = App(options)
    after = app.run()
    if after == 'legacy':
        return 10
    return 0


if __name__ == '__main__':
    sys.exit(main())

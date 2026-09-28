#!/usr/bin/env python3
"""Runs a copy of the Magma lights controller (PONTE_LAB_MAGMA=<folder with
controller.py>) with a lab HOME: its state, lock and telinha live under
$PONTE_LAB_DIR/magma-home, and openrgb resolves to the lab fake. The owner's
controller is never used: it drives the real RGB."""
import os, pathlib, stat, sys
bin_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bin')
sys.path.insert(0, bin_dir)
import _lab

home = pathlib.Path(_lab.LAB).resolve() / 'magma-home'
telinha = home / '.local/bin/telinha'
if not telinha.exists():
    telinha.parent.mkdir(parents=True, exist_ok=True)
    telinha.write_text(f'#!/usr/bin/env python3\nimport sys\nsys.path.insert(0, {bin_dir!r})\nfrom _lab import log\nlog("telinha", sys.argv[1:])\n')
    telinha.chmod(telinha.stat().st_mode | stat.S_IXUSR)
pathlib.Path.home = classmethod(lambda cls: home)
sys.path.insert(0, os.environ['PONTE_LAB_MAGMA'])
import controller
controller.main(sys.argv[1:], controller.Controller(home / '.config/magma-lights/state.json'))

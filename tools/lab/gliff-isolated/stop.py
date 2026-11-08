#!/usr/bin/env python3
"""Stop only this directory's recorded supervisor, after validating its argv."""
import os, signal
from pathlib import Path
root=Path(__file__).resolve().parent
pid=int((root/'supervisor.pid').read_text())
cmd=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
if str(root/'start.py').encode() not in cmd:
    raise SystemExit('Refusing to stop PID not owned by this harness')
os.kill(pid,signal.SIGTERM)

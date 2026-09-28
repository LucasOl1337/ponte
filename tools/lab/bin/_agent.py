"""Stand-in for an agent CLI (claude, codex) in the lab: shows the request it
received as argv, logs it, then echoes each line typed into it. It never calls
a model or touches anything outside the lab."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lab import locked, EVENTS

name, words = sys.argv[1], sys.argv[2:]
with locked():
    with open(EVENTS, 'a') as f: f.write(json.dumps({'t': time.time(), 'tool': name, 'argv': words, 'cwd': os.getcwd()}) + '\n')
print(f'[lab {name}] fake agent, pid {os.getpid()}')
print(f'[lab {name}] cwd: {os.getcwd()}')
print(f'[lab {name}] request: {words[0] if words else "(none)"}')
while True:
    try: line = input(f'{name}> ')
    except EOFError: break
    if line.strip() in ('/exit', 'exit'): break
    print(f'[lab {name}] got: {line}')

# Isolated Gliff acceptance fixture

Runs real Hyprland, GTK, Gliff client and Gliff server. It never targets the logged-in compositor. Copy this directory to any writable destination, then use that absolute path for the server wrapper. Paths resolve relative to the scripts, not a developer's home.

## Requirements

Linux, Hyprland 0.56.2, Gliff 0.4.1, Cage 0.3.1/wlroots 0.20, bubblewrap, Python with PyGObject/GTK4, C compiler, D-Bus and an accessible Mesa DRM render node. Existing trusted SSH alias and host key. This is an acceptance fixture, not a performance benchmark.

## Isolation contract

- `start.py` puts Cage headless, nested Hyprland and GTK in bubblewrap with private `/dev`, `/run`, `/tmp`, PID namespace, HOME and D-Bus. Only `/dev/dri/renderD*` are exposed. No DRM card, input, uinput or host session bus.
- Runtime is `/run/user/UID/pg-proof`, kept short for Unix socket limits. One harness per UID, enforced with a file lock. Existing instance directories are excluded when selecting the new compositor.
- Hyprland receives a minimal config without human shortcuts, autostart or systemd environment updates. Output `PROOF` is created before GTK. The wrapper requires that exact output, runtime, signature and Wayland socket and passes `--instance` explicitly. It never falls back to session discovery.
- The Cage-only shim advertises xdg-shell v6 supported by wlroots. Aquamarine requires v6 without negotiating; unmodified Cage advertises v5. Weston 15 also failed wl_compositor version negotiation. No system libraries or product binaries are patched.
- Video is forced to shared-memory capture and CPU OpenH264. The PC fixture chooses renderD129 when present (AMD in the validated PC), otherwise renderD128 (notebook). Adapt that explicit selection to other hardware before use. Do not add physical devices to work around failure.

## Run

Hold the operator's heavy-work slot for the duration. Native client must be launched in an exclusive agent bench, never a human desktop. On the destination, copy this directory to a writable `PROOF_ROOT`, then:

```sh
python3 /ABS/PROOF_ROOT/start.py
```

`start.py` builds the tiny shim and stays in foreground. It prints private instance state when ready. `events.jsonl` records GTK readiness and real input callbacks. Keep SSH connected while running remotely. A cancelled SSH connection alone may leave the remote job alive, so always use explicit cleanup below.

From the PC, with the existing trusted SSH alias:

```sh
./ponte rd ALIAS --engine gliff --server-bin /ABS/PROOF_ROOT/gliff-server-private --check
agent-bench launch ponte-gliff -- /ABS/PONTE/ponte rd ALIAS --engine gliff --server-bin /ABS/PROOF_ROOT/gliff-server-private --no-clipboard --video cpu
```

Omit `ALIAS` to prove the device picker, then select the alias corresponding to this private wrapper. Never click Connect without passing the private wrapper. The wrapper supports `--version` without connecting to any compositor.

## Acceptance protocol

1. Screenshot only the bench and inspect the fixture title and advancing heartbeat.
2. Through the real client, type a unique token into the field and click the proof button. Require matching `text` and `click` entries in destination `events.jsonl`, not just a successful input-tool result.
3. Record the current private server PID from `server-launches.jsonl`. Verify its argv contains this runtime's `--instance` before sending SIGTERM to that PID alone.
4. Wait for the client's `first frame decoded` log event after reconnect. Send a distinct suffix and another click. Verify both remote callbacks and screenshot.
5. Close the client, then run `python3 /ABS/PROOF_ROOT/stop.py` on the destination. It validates the recorded supervisor's argv before termination. Confirm no process with this proof directory in its argv remains. Release the heavy slot and stop only your exclusive bench.

Heartbeat updates every 100 ms, so ~10 fps is expected for this scene. Telemetry decode time is not input-to-photon latency. The validated run used 1280x720@30 output and a 1248x702 adaptive stream. It proves functionality, not GPU speed, Internet latency or a performance advantage over the legacy engine.

## Validated 2026-11-08

PC bench client to notebook over SSH and to PC private compositor over localhost both passed video, unique keyboard token, mouse count and automatic reconnect with input after reconnect. Picker to Connect to video also passed. Seletor rendered within 1360x768 and 900x1000, with the legacy row reachable by End. No human screen was captured or operated. Evidence lives in the operator's report directory, not this source tree.

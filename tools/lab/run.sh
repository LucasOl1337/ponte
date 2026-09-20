#!/usr/bin/env bash
# Ponte lab: the real server with fake desktop tools, so a phone can be
# exercised (taps, zoom, drags, typing) without touching a live desktop.
# Every fake logs to $PONTE_LAB_DIR/events.jsonl and the synthetic monitor
# shows the cursor, clicks and typed text.
#
#   tools/lab/run.sh                # HTTP on 127.0.0.1:8799
#   adb reverse tcp:8799 tcp:8799   # then open the printed URL on the phone
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export PONTE_LAB_DIR="${PONTE_LAB_DIR:-$root/.work/lab}"
export PONTE_LAB_MONITOR="${PONTE_LAB_MONITOR:-1920x1080}"
export PONTE_LAB_ACCEL="${PONTE_LAB_ACCEL:-2}"
port="${PONTE_LAB_PORT:-8799}"
mkdir -p "$PONTE_LAB_DIR/data"
config="$PONTE_LAB_DIR/config.json"
umask 077
cat > "$config" <<JSON
{"schemaVersion":1,"dataDir":"$PONTE_LAB_DIR/data","http":{"host":"127.0.0.1","port":$port},"trustedHosts":["127.0.0.1:$port","localhost:$port"]}
JSON
rm -f "$PONTE_LAB_DIR/state.json" "$PONTE_LAB_DIR/events.jsonl"
# capabilities.mouse needs a writable unix socket at YDOTOOL_SOCKET; the fake
# ydotool never connects to it.
sock="$PONTE_LAB_DIR/input.sock"
if [ ! -S "$sock" ]; then python3 - "$sock" <<'PY'
import socket, sys, os
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sys.argv[1])
PY
fi
export YDOTOOL_SOCKET="$sock"
export PONTE_CONFIG="$config"
export PATH="$root/tools/lab/bin:$PATH"
export PONTE_SUSSURRO_SOCKET='' PONTE_STT_URL=''
cd "$root"
( sleep 1.5; if [ -f "$PONTE_LAB_DIR/data/token" ]; then echo "lab: http://127.0.0.1:$port/#pair=$(cat "$PONTE_LAB_DIR/data/token")"; fi ) &
exec "${PONTE_NODE:-node}" server.mjs

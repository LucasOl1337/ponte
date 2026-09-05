#!/usr/bin/env bash
set -euo pipefail
ponte_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export YDOTOOL_SOCKET="${YDOTOOL_SOCKET:-$XDG_RUNTIME_DIR/ponte-input.sock}"
cd "$ponte_root"
exec "${PONTE_NODE:-node}" server.mjs

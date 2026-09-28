#!/usr/bin/env bash
# One fake Claude Code for testing agent alerts: a real process named
# "claude" (a symlink to sleep) plus its session file and an empty
# transcript. The server's scanner sees it move busy → waiting or busy →
# ready, and no model is ever called.
#
#   tools/lab/fake-agent.sh start     # working (Claude's "busy")
#   tools/lab/fake-agent.sh waiting   # → "<title> needs you"
#   tools/lab/fake-agent.sh busy      # working again
#   tools/lab/fake-agent.sh ready     # → "<title> finished"
#   tools/lab/fake-agent.sh stop      # kill it and remove its files
#
# HOME picks the ~/.claude it writes to: a lab HOME for the lab server
# (HOME="$PONTE_LAB_DIR/home"), or the real one for the real server. In the
# real one it only adds sessions/<pid>.json and one projects/<dir>/<id>.jsonl,
# both removed by stop. The process is started detached (setsid), because an
# agent started under another agent (say, the Claude Code running this) is
# counted as part of that agent and never listed on its own.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
lab="${PONTE_LAB_DIR:-$root/.work/lab}"
base="$lab/fake-agent"
cwd="$base/ponte-aviso-teste"
bin="$base/bin"
pidfile="$base/pid"
sid=00000000-0000-4000-8000-00000000a1e7
title="${PONTE_FAKE_AGENT_TITLE:-Teste de aviso do Ponte}"
sessions="$HOME/.claude/sessions"
projects="$HOME/.claude/projects/$(printf '%s' "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')"
now_ms() { date +%s%3N; }
running() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }

write_session() {
  local pid start status="$1" waiting="${2:-}"
  pid="$(cat "$pidfile")"; start="$(awk '{print $22}' "/proc/$pid/stat")"
  mkdir -p "$sessions"
  printf '{"pid":%s,"sessionId":"%s","cwd":"%s","procStart":"%s","status":"%s"%s,"statusUpdatedAt":%s,"name":"%s"}\n' \
    "$pid" "$sid" "$cwd" "$start" "$status" "${waiting:+,\"waitingFor\":\"$waiting\"}" "$(now_ms)" "$title" > "$sessions/$pid.json.tmp"
  mv "$sessions/$pid.json.tmp" "$sessions/$pid.json"
  # A transcript written after the process started is what makes an idle
  # Claude "ready" instead of merely "idle".
  mkdir -p "$projects"; : >> "$projects/$sid.jsonl"; touch "$projects/$sid.jsonl"
  echo "fake agent $pid: $status${waiting:+ ($waiting)}"
}

case "${1:-}" in
  start)
    running && { echo "already running: $(cat "$pidfile")"; exit 0; }
    mkdir -p "$bin" "$cwd"
    ln -sf "$(command -v sleep)" "$bin/claude"
    rm -f "$pidfile"
    (cd "$cwd" && setsid -f bash -c 'echo $$ > "$1"; exec "$2" 7200' _ "$pidfile" "$bin/claude") </dev/null >/dev/null 2>&1
    for _ in $(seq 50); do [ -s "$pidfile" ] && [ "$(cat "/proc/$(cat "$pidfile")/comm" 2>/dev/null)" = claude ] && break; sleep 0.05; done
    write_session busy ;;
  busy) running || { echo "not running; use start" >&2; exit 1; }; write_session busy ;;
  waiting) running || { echo "not running; use start" >&2; exit 1; }; write_session waiting "${PONTE_FAKE_AGENT_WAITING:-teste do aviso}" ;;
  ready) running || { echo "not running; use start" >&2; exit 1; }; write_session idle ;;
  stop)
    if [ -f "$pidfile" ]; then pid="$(cat "$pidfile")"; kill "$pid" 2>/dev/null || true; rm -f "$sessions/$pid.json" "$pidfile"; fi
    rm -rf "$projects"
    echo "fake agent stopped" ;;
  *) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac

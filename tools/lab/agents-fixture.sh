#!/usr/bin/env bash
# Seeds the lab with fake agents for the Terminals list: real processes whose
# names are foot/claude/codex (symlinks to bash and sleep), their windows in
# clients.json for the fake hyprctl, and Claude/Codex files in a lab HOME.
# Nothing here reads or writes the real ~/.claude or ~/.codex.
#
#   tools/lab/agents-fixture.sh                          # seed (replaces a previous seed)
#   HOME="$PONTE_LAB_DIR/home" PONTE_LAB_PORT=8801 tools/lab/run.sh
#   tools/lab/agents-fixture.sh stop                     # kill the fake processes
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
lab="${PONTE_LAB_DIR:-$root/.work/lab}"
home="$lab/home" bin="$lab/agent-bin" pids="$lab/agents.pids"
killtree() { local c; for c in $(pgrep -P "$1"); do killtree "$c"; done; kill "$1" 2>/dev/null || true; }
if [ -f "$pids" ]; then while read -r pid; do killtree "$pid"; done < "$pids"; rm -f "$pids"; fi
rm -f "$lab/clients.json"
[ "${1:-}" = stop ] && exit 0
mkdir -p "$bin" "$home/.claude/sessions" "$home/.codex/sessions"
for name in foot dailywork codex; do ln -sf "$(command -v bash)" "$bin/$name"; done
ln -sf "$(command -v sleep)" "$bin/claude"
starttime() { awk '{print $22}' "/proc/$1/stat"; }
child() { for _ in $(seq 50); do c="$(pgrep -P "$1" | head -1)"; [ -n "$c" ] && { echo "$c"; return; }; sleep 0.05; done; echo "no child of $1" >&2; exit 1; }
encode() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }
now_ms() { date +%s%3N; }
iso() { date -u -d "@$(( $1 / 1000 ))" +%Y-%m-%dT%H:%M:%SZ; }
# The trailing "; true" keeps bash from exec'ing into the child.
spawn() { local dir="$1"; shift; mkdir -p "$dir"; (cd "$dir" && exec "$@") >/dev/null 2>&1 & echo $! >> "$pids"; echo $!; }

claude_window() {
  local dir="$1" status="$2" waiting="$3" title="$4" address="$5" ws="$6" sid="$7"; shift 7
  local term agent start
  term="$(spawn "$dir" "$bin/foot" -c "\"$bin/claude\" 7200; true")"
  agent="$(child "$term")"; start="$(starttime "$agent")"
  printf '{"pid":%s,"sessionId":"%s","cwd":"%s","procStart":"%s","status":"%s"%s,"statusUpdatedAt":%s,"name":"lab"}\n' \
    "$agent" "$sid" "$dir" "$start" "$status" "${waiting:+,\"waitingFor\":\"$waiting\"}" "$(( $(now_ms) - 180000 ))" > "$home/.claude/sessions/$agent.json"
  local transcript="$home/.claude/projects/$(encode "$dir")/$sid.jsonl"
  mkdir -p "$(dirname "$transcript")"; : > "$transcript"
  local t="$(( $(now_ms) - 600000 ))"
  while [ $# -gt 0 ]; do
    printf '%s\n' "$(sed "s/@T@/$(iso "$t")/" <<< "$1")" >> "$transcript"; shift; t=$(( t + 20000 ))
  done
  printf '{"pid":%s,"address":"%s","title":"%s","class":"foot","monitor":0,"workspace":{"id":%s,"name":"%s"},"at":[0,0],"size":[800,600]},' "$term" "$address" "$title" "$ws" "$ws" >> "$lab/clients.part"
}

: > "$lab/clients.part"
claude_window "$home/Projects/nexsales" waiting 'permission prompt' '✳ Nexsales pendências da semana' 0xa001 2 6fbaff9b-af31-4e65-bdcd-6afbd38f946e \
  '{"type":"user","timestamp":"@T@","message":{"role":"user","content":"quais pendências ficaram da semana?"}}' \
  '{"type":"assistant","timestamp":"@T@","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"git log --since=monday","description":"Lista commits da semana"}}]}}' \
  '{"type":"user","timestamp":"@T@","message":{"role":"user","content":[{"type":"tool_result","content":"(saída grande omitida)"}]}}' \
  '{"type":"assistant","timestamp":"@T@","message":{"role":"assistant","content":[{"type":"text","text":"Ficaram três pendências: o anexo do chat, o retorno das 3h e o relatório do cliente. Posso rodar a migração do anexo agora? Ela mexe no banco de produção."}]}}'
claude_window "$home/Projects/ramdog" busy '' '◑ Ramdog processos agrupados' 0xa002 2 14aa97af-974b-4809-8a76-7a0a81f6c9bb \
  '{"type":"user","timestamp":"@T@","message":{"role":"user","content":"agrupa os processos por app e mostra a RAM de cada grupo"}}' \
  '{"type":"assistant","timestamp":"@T@","message":{"role":"assistant","content":[{"type":"text","text":"Vou ler /proc/*/status e somar VmRSS por árvore de processos."}]}}' \
  '{"type":"assistant","timestamp":"@T@","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/home/lol/Projects/ramdog/src/groups.rs"}}]}}'
# A terminal window with no agent in it.
term="$(spawn "$home" "$bin/foot" -c 'sleep 7200; true')"
printf '{"pid":%s,"address":"0xa003","title":"lol@lol:~","class":"foot","monitor":0,"workspace":{"id":3,"name":"3"},"at":[0,0],"size":[800,600]},' "$term" >> "$lab/clients.part"
# A headless Codex started by an app window, holding its rollout open.
day="$(date +%Y/%m/%d)" project="$home/Projects/DailyWork"
rollout="$home/.codex/sessions/$day/rollout-$(date +%Y-%m-%dT%H-%M-%S)-01a0e7ad-bef0-78f3-a6b9-d9586f6da905.jsonl"
mkdir -p "$(dirname "$rollout")" "$project"
{
  printf '{"timestamp":"%s","type":"session_meta","payload":{"cwd":"%s"}}\n' "$(iso "$(now_ms)")" "$project"
  printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"resolve a pendência do contato de ontem"}]}}\n' "$(iso "$(now_ms)")"
  printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"O LinkedIn pediu login antes de mostrar a conversa. Não reenviei nada."}]}}\n' "$(iso "$(now_ms)")"
} > "$rollout"
app="$(spawn "$project" "$bin/dailywork" -c "\"$bin/codex\" -c 'exec 3<\"$rollout\"; sleep 7200; true'; true")"
printf '{"pid":%s,"address":"0xa004","title":"DailyWork","class":"dailywork","monitor":0,"workspace":{"id":4,"name":"4"},"at":[0,0],"size":[800,600]}' "$app" >> "$lab/clients.part"
{ printf '['; cat "$lab/clients.part"; printf ']\n'; } > "$lab/clients.json"; rm -f "$lab/clients.part"
echo "lab agents seeded: $(wc -l < "$pids") processes, windows in $lab/clients.json, HOME=$home"

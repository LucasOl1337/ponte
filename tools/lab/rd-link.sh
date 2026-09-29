#!/usr/bin/env bash
# Remote desktop over a simulated internet link. rd-measure.mjs runs the lab
# server and a client inside a private user + network namespace (unshare -rn),
# where netem on that namespace's own loopback shapes server → client (rate,
# delay, loss, queue) and delays the way back. The real network stack and its
# sysctls are never touched.
#
#   tools/lab/rd-link.sh --plan 0:2500kbit --client old --seconds 60 --timeline
#   tools/lab/rd-link.sh --plan 0:20mbit,15:2000kbit,45:20mbit --client old --seconds 60
#   tools/lab/rd-link.sh --plan 0:2500kbit --netem "delay 25ms loss 3% limit 400" --client old
#   RD_LINK_SYSCTL="net.ipv4.tcp_notsent_lowat=131072" tools/lab/rd-link.sh ...   # inside the namespace only
#
# Defaults: --lab --scene desktop --port 8800 and netem "delay 12ms loss 1%
# limit 150" (about 24 ms round trip, 1% loss, ~190 KB queue at the
# bottleneck); any rd-measure.mjs option passes through. MTU 1280 like the
# tailnet, offloads off so loss hits packets and not 64 KB super-packets.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
port=8800
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[i]}" = --port ] && port="${args[i + 1]}"; done
defaults=()
[[ " $* " == *" --port "* ]] || defaults+=(--port "$port")
[[ " $* " == *" --scene "* ]] || defaults+=(--scene desktop)
[[ " $* " == *" --lab "* || " $* " == *" --url "* ]] || defaults+=(--lab)
export PONTE_LAB_NETNS=1 RD_LINK_PORT="$port" RD_LINK_ROOT="$root" RD_LINK_SYSCTL="${RD_LINK_SYSCTL:-}"
exec unshare -rn bash -c '
set -euo pipefail
ip link set lo up
ip link set lo mtu 1280
ethtool -K lo tso off gso off gro off >/dev/null 2>&1 || echo "rd-link: offloads unchanged" >&2
tc qdisc add dev lo root handle 1: prio bands 3 priomap 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1
tc qdisc add dev lo parent 1:1 handle 10: netem delay 12ms
tc qdisc add dev lo parent 1:2 handle 20: netem delay 12ms
tc filter add dev lo parent 1: protocol ip prio 1 u32 match ip sport "$RD_LINK_PORT" 0xffff flowid 1:1
for setting in $RD_LINK_SYSCTL; do sysctl -q -w "$setting"; done
cd "$RD_LINK_ROOT"
exec node tools/lab/rd-measure.mjs "$@"
' rd-link "${defaults[@]}" "$@"

#!/usr/bin/env bash
# Install or update a Ponte node on an Omarchy machine (a notebook, a second
# PC) so it joins the owner's mesh. Run it on that machine, as its user:
#
#   curl -fsSL https://raw.githubusercontent.com/LucasOl1337/ponte/main/tools/node-install.sh | bash
#   tools/node-install.sh --dry-run      # only lists what it would do
#
# It clones or fast-forwards ~/Projects/ponte, checks the dependencies (and
# prints the pacman line for what is missing), runs `./ponte setup` on this
# machine's Tailscale IPv4, `./ponte install`, and prints how to pair.
set -euo pipefail

repo="${PONTE_REPO:-https://github.com/LucasOl1337/ponte.git}"
branch="${PONTE_BRANCH:-main}"
dir="${PONTE_DIR:-$HOME/Projects/ponte}"
dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) dry=1 ;;
    --dir=*) dir="${arg#--dir=}" ;;
    --branch=*) branch="${arg#--branch=}" ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (use --dry-run, --dir=PATH, --branch=NAME)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
step() { if [ "$dry" = 1 ]; then say "would: $*"; else say "==> $*"; fi; }
run() { if [ "$dry" = 1 ]; then say "would run: $*"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" != 0 ] || { say 'Run this as your own user, not root: Ponte is a per-user service.' >&2; exit 1; }

# ------------------------------------------------------------------ checks
missing=() packages=() notes=()
need() { # need COMMAND PACKAGE
  if ! have "$1"; then missing+=("$1"); packages+=("$2"); fi
}
need git git
need python3 python
need openssl openssl
need tailscale tailscale
need grim grim
need ydotool ydotool
need ydotoold ydotool
need gpu-screen-recorder gpu-screen-recorder
need tmux tmux
need wtype wtype
if have node; then
  major="$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p')"
  if [ -z "$major" ] || [ "$major" -lt 22 ]; then missing+=("node>=22 (found $(node --version 2>/dev/null || echo '?'))"); packages+=(nodejs); fi
else
  missing+=(node); packages+=(nodejs)
fi
if have python3 && ! python3 -c 'import evdev' >/dev/null 2>&1; then missing+=(python-evdev); packages+=(python-evdev); fi
have hyprctl || notes+=('hyprctl not found: Ponte drives Hyprland (Omarchy); without it only terminals work.')
if ! id -nG 2>/dev/null | tr ' ' '\n' | grep -qx input; then
  notes+=("You are not in the 'input' group (needed for raw remote keyboard and mouse): sudo usermod -aG input \"\$USER\", then log out and back in.")
fi

tailnet_ip=''
if have tailscale; then
  tailnet_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  [ -n "$tailnet_ip" ] || notes+=('Tailscale is installed but not connected: sudo systemctl enable --now tailscaled && sudo tailscale up')
fi

if [ "${#missing[@]}" -gt 0 ]; then
  unique="$(printf '%s\n' "${packages[@]}" | sort -u | tr '\n' ' ')"
  say "Missing: ${missing[*]}"
  say "Install with: sudo pacman -S --needed ${unique% }"
fi
for note in "${notes[@]}"; do say "Note: $note"; done
if [ "$dry" = 0 ] && { [ "${#missing[@]}" -gt 0 ] || [ -z "$tailnet_ip" ]; }; then
  say 'Fix the items above and run this again. Nothing was changed.' >&2
  exit 1
fi

# ------------------------------------------------------------ clone/update
if [ -d "$dir/.git" ]; then
  step "update $dir (git pull --ff-only, branch $branch)"
  run git -C "$dir" fetch --quiet origin "$branch"
  run git -C "$dir" checkout --quiet "$branch"
  run git -C "$dir" pull --quiet --ff-only origin "$branch"
elif [ -e "$dir" ]; then
  say "$dir exists and is not a git checkout; move it away or use --dir=PATH." >&2
  exit 1
else
  step "clone $repo ($branch) into $dir"
  run mkdir -p "$(dirname "$dir")"
  run git clone --quiet --branch "$branch" "$repo" "$dir"
fi

# ----------------------------------------------------------- setup/install
step "configure Ponte on this machine's Tailscale address ${tailnet_ip:-(not connected)}"
run "$dir/ponte" setup
step 'install and start the user services (ponte-remote, ponte-input)'
was_running=0
[ "$dry" = 1 ] || ! systemctl --user is-active --quiet ponte-remote.service || was_running=1
run "$dir/ponte" install
# An update of an already running node: load the new code.
if [ "$was_running" = 1 ]; then run systemctl --user restart ponte-remote.service; fi

name="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Self",{}).get("HostName",""))' 2>/dev/null || true)"
say ''
say "Ponte node ${name:-$(uname -n)} at https://${tailnet_ip:-<tailnet-ip>}:8788"
say "  checkout: $dir"
say "  check:    $dir/ponte doctor"
say "  pair:     on the device that will control this one, open Devices (Home) or run"
say "            ./ponte mesh pair ${name:-<this-name>}"
say "            then approve here with the code it shows: $dir/ponte mesh approve <code>"
[ "$dry" = 0 ] || say 'Dry run: nothing was changed.'

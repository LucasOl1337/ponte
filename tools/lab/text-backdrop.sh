#!/usr/bin/env bash
# A desktop backdrop with small native text (14 px monospace, three columns of
# this repo's own source) at the monitor's size: what a terminal on a real
# 3440×1440 monitor looks like. The default backdrop is a 1600 px screenshot
# stretched up, whose big text stays readable even at 1280 px.
#   tools/lab/text-backdrop.sh [3440x1440] [.work/backdrop-text.png]
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
size="${1:-3440x1440}" out="${2:-$root/.work/backdrop-text.png}"
w="${size%x*}" h="${size#*x}"
lines=$(( (h - 20) / 17 )) column=$(( w / 3 ))
font="$(fc-match -f '%{file}' monospace)"
mkdir -p "$(dirname "$out")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
sed -n "1,${lines}p" "$root/backend/rd-rate.mjs" | cut -c1-128 > "$tmp/1"
sed -n "130,$((129 + lines))p" "$root/backend/rd.mjs" | cut -c1-128 > "$tmp/2"
sed -n "846,$((845 + lines))p" "$root/public/app.js" | cut -c1-128 > "$tmp/3"
magick -size "$size" xc:'#1a1b26' -font "$font" -pointsize 14 -fill '#c0caf5' -interline-spacing 2 \
  -annotate +16+20 @"$tmp/1" -annotate +$((column + 16))+20 @"$tmp/2" -annotate +$((2 * column + 16))+20 @"$tmp/3" "$out"
echo "$out"

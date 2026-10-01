#!/usr/bin/env bash
# Coverage matrix of the Screen tab's floating layer: tools/lab/overlays-matrix.sh PREFIX OUTDIR
# Needs CDP_URL and LAB_URL (see overlays.mjs).
set -euo pipefail
prefix="$1"; out="$2"
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$out/medidas"
run() {
  local name="$1"; shift
  timeout 60 node "$here/overlays.mjs" --json --shot "$out/$prefix-$name.png" "$@" > "$out/medidas/$prefix-$name.json"
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const hits = Object.entries(r.items).filter(([, v]) => v.coversImagePct > 0).map(([k, v]) => `${k}:${v.coversImagePct}%`).join(" ");
    console.log(process.argv[2], "preview", JSON.stringify(r.preview), "visible", JSON.stringify(r.visible), "scale", r.scale, hits, r.target ? "target=" + JSON.stringify(r.target) : "");
  ' "$out/medidas/$prefix-$name.json" "$name"
}
target=(${TARGET:+--target "$TARGET"})
run retrato-1x "${target[@]}"
run retrato-zoom3 --zoom 3 "${target[@]}"
run retrato-teclado --keyboard "${target[@]}"
run retrato-teclado-zoom3 --keyboard --zoom 3 "${target[@]}"
run paisagem-1x --landscape "${target[@]}"
run paisagem-zoom3 --landscape --zoom 3 "${target[@]}"
run paisagem-teclado --landscape --keyboard "${target[@]}"

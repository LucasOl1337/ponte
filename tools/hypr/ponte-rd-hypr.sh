#!/usr/bin/env bash
# Liga ou desliga o "Super vai pro outro aparelho" do Ponte rd no Hyprland.
#
#   tools/hypr/ponte-rd-hypr.sh status     o que está instalado (padrão)
#   tools/hypr/ponte-rd-hypr.sh check      valida sem instalar
#   tools/hypr/ponte-rd-hypr.sh install    copia o módulo e acrescenta 1 linha no hyprland.lua
#   tools/hypr/ponte-rd-hypr.sh remove     tira a linha e o módulo, volta o submap ao normal
#
# Só toca em dois lugares: $HYPR_DIR/ponte_rd.lua e uma linha marcada no
# $HYPR_DIR/hyprland.lua (com backup .bak.<data> antes). Nada é instalado sem
# passar no Hyprland --verify-config com a config inteira. Ver docs/rd-control.md.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
module_src="$here/ponte_rd.lua"
hypr_dir="${HYPR_DIR:-$HOME/.config/hypr}"
main="$hypr_dir/hyprland.lua"
module_dst="$hypr_dir/ponte_rd.lua"
marker='-- ponte-rd (tools/hypr/ponte-rd-hypr.sh)'
line="dofile(os.getenv(\"HOME\") .. \"/.config/hypr/ponte_rd.lua\") $marker"
[ -n "${HYPR_DIR:-}" ] && line="dofile(\"$module_dst\") $marker"

verify() { # $1 = arquivo de config inteiro
  local out
  out="$(Hyprland --verify-config -c "$1" 2>&1)" || true
  if ! grep -q '^config ok' <<<"$out"; then
    printf '%s\n' "$out" | tail -n 20 >&2
    return 1
  fi
}

installed() { [ -f "$main" ] && grep -qF -e "$marker" "$main"; }

case "${1:-status}" in
  status)
    if installed; then echo "instalado: $module_dst + linha no $main"; else echo "não instalado"; fi
    command -v hyprctl >/dev/null && echo "submap atual: $(hyprctl submap 2>/dev/null || echo '?')"
    ;;
  check)
    [ -f "$main" ] || { echo "sem $main" >&2; exit 1; }
    work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
    cp -- "$module_src" "$work/ponte_rd.lua"
    { cat -- "$main"; printf 'dofile("%s") %s\n' "$work/ponte_rd.lua" "$marker"; } > "$work/hyprland.lua"
    verify "$work/hyprland.lua" && echo "ok: a config com o módulo passa no --verify-config"
    ;;
  install)
    installed && { echo "já instalado"; exit 0; }
    [ -z "$(tail -c1 -- "$main")" ] || { echo "$main não termina em quebra de linha; não mexo" >&2; exit 1; }
    "$0" check
    stamp="$(date +%s)"
    cp -- "$main" "$main.bak.$stamp"
    cp -- "$module_src" "$module_dst"
    printf '%s\n' "$line" >> "$main"
    if ! verify "$main"; then
      cp -- "$main.bak.$stamp" "$main"; rm -f -- "$module_dst"
      echo "falhou a validação; voltei o hyprland.lua do backup" >&2; exit 1
    fi
    echo "instalado (backup em $main.bak.$stamp). O Hyprland recarrega sozinho; senão: hyprctl reload"
    ;;
  remove)
    if installed; then
      backup="$main.bak.$(date +%s).antes-de-remover"
      cp -- "$main" "$backup"
      grep -vF -e "$marker" "$backup" > "$main" || true
      echo "linha removida (backup em $backup)"
    fi
    rm -f -- "$module_dst"
    # Com HYPR_DIR (uma cópia, nos testes) a sessão viva não é tocada.
    if [ -z "${HYPR_DIR:-}" ] && command -v hyprctl >/dev/null && [ "$(hyprctl submap 2>/dev/null)" = "ponte-rd" ]; then
      hyprctl dispatch 'hl.dsp.submap("reset")' >/dev/null || true
    fi
    echo "removido"
    ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

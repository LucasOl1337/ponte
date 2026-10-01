-- Ponte rd: enquanto a janela do rd estiver controlando o outro aparelho
-- (título começa com "⌨ "), o Hyprland entra no submap "ponte-rd", que não tem
-- atalho nenhum além da saída de emergência. Tecla sem atalho no submap vai pra
-- janela, então Super, Super+1, Alt+Tab etc. chegam no aparelho da tela.
--
-- Sai sozinho quando a página solta o controle (o título perde o "⌨"), quando
-- outra janela ganha o foco (clique fora, por exemplo) ou com
-- SUPER + CTRL + ALT + ESC, que nunca vai pro outro aparelho.
--
-- Instalado e removido por tools/hypr/ponte-rd-hypr.sh; nada aqui mexe em outro
-- atalho do PC. Ver docs/rd-control.md.

local SUBMAP = "ponte-rd"
local MARK = "⌨ "

local function is_rd(w)
  if not w then return false end
  local class = w.class or w.initial_class or ""
  return class == "ponte-rd" or class:match("^chrome%-.*__rd%.html") ~= nil
end

local function controlling(w)
  return is_rd(w) and (w.title or ""):sub(1, #MARK) == MARK
end

local function follow(w)
  local inside = hl.get_current_submap() == SUBMAP
  local want = controlling(w)
  if want and not inside then
    hl.dispatch(hl.dsp.submap(SUBMAP))
  elseif inside and not want then
    hl.dispatch(hl.dsp.submap("reset"))
  end
end

hl.define_submap(SUBMAP, function()
  hl.bind("SUPER + CTRL + ALT + ESCAPE", hl.dsp.submap("reset"), { description = "Ponte: devolver os atalhos ao PC" })
end)

hl.on("window.active", function(w) follow(w) end)

hl.on("window.title", function(w)
  local active = hl.get_active_window and hl.get_active_window() or w
  -- Só a janela ativa decide; título mudando em janela de fundo não conta.
  if active and w and active.address and w.address and active.address ~= w.address then return end
  follow(w)
end)

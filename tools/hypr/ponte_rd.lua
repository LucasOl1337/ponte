-- Ponte rd: enquanto a janela do rd estiver controlando o outro aparelho
-- (título começa com "⌨ "), o Hyprland entra no submap "ponte-rd", que não tem
-- atalho nenhum além da saída de emergência. Tecla sem atalho no submap vai pra
-- janela, então Super, Super+1, Alt+Tab etc. chegam no aparelho da tela.
--
-- Sai sozinho quando a página solta o controle (o título perde o "⌨"), quando
-- outra janela ganha o foco, a janela fecha ou com SUPER + CTRL + ALT + ESC.
-- A emergência devolve os atalhos e só rearma essa janela depois que a página
-- tira a marca do título. Ela não desliga o encaminhamento de input da página.
--
-- Instalado e removido por tools/hypr/ponte-rd-hypr.sh; nada aqui mexe em outro
-- atalho do PC. Ver docs/rd-control.md.

local SUBMAP = "ponte-rd"
local MARK = "⌨ "
local owner = nil
local blocked = {}

local function is_rd(w)
  if not w then return false end
  local class = w.class or w.initial_class or ""
  return class == "ponte-rd" or class:match("^chrome%-.*__rd%.html") ~= nil
end

local function marked(w)
  return is_rd(w) and (w.title or ""):sub(1, #MARK) == MARK
end

local function release()
  owner = nil
  if hl.get_current_submap() == SUBMAP then
    hl.dispatch(hl.dsp.submap("reset"))
  end
end

local function follow(w)
  local address = w and w.address
  if address and not marked(w) then blocked[address] = nil end
  -- No 0.56.2, close pode emitir window.active com a janela já unmapped.
  local want = address and w.mapped and w.active and marked(w) and not blocked[address]
  local submap = hl.get_current_submap()
  if not want then
    release()
  elseif submap == SUBMAP then
    owner = address
  elseif submap == "" or submap == "default" then
    owner = address
    hl.dispatch(hl.dsp.submap(SUBMAP))
  else
    -- Não toma posse de um submap de outro módulo (resize, por exemplo).
    owner = nil
  end
end

hl.define_submap(SUBMAP, function()
  hl.bind("SUPER + CTRL + ALT + ESCAPE", function()
    if owner then blocked[owner] = true end
    release()
  end, { dont_inhibit = true, description = "Ponte: devolver os atalhos ao PC" })
end)

-- No Hyprland 0.56.2: Window direto, mais reason inteiro em window.active.
hl.on("window.active", function(w) follow(w) end)

hl.on("window.title", function(w)
  local address = w and w.address
  if address and not marked(w) then blocked[address] = nil end
  local active = hl.get_active_window()
  -- Sem ativa, nunca usa a janela de fundo como fallback.
  if not active or not active.address then release(); return end
  if address ~= active.address then return end
  follow(active)
end)

hl.on("window.close", function(w)
  local address = w and w.address
  if not address then return end
  blocked[address] = nil
  if owner == address then release() end
end)

follow(hl.get_active_window())

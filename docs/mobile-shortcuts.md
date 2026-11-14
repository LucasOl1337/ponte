# Atalhos e janelas na Tela

Escolha o monitor na barra superior. O nome combina posição física, quando disponível, e output. A ordem vem de `x/y` do compositor, nunca dos números dos workspaces. Abrir o seletor ou mudar o monitor só altera o preview, sem enviar foco ao PC.

**Janelas** abre busca por título/aplicativo e filtros de workspace do monitor escolhido. Escolher uma janela envia seu endereço e o monitor esperado. Se ela mudou de monitor entre leitura e ação, o servidor recusa e pede nova escolha. O antigo `#janelas` abre este painel em `#tela`.

## Criar e usar atalhos

1. Abra **Atalhos**, depois **Novo**.
2. Dê um nome, escolha Super/Ctrl/Alt/Shift e uma tecla. Nenhum modificador é obrigatório. A combinação resultante aparece antes de enviar.
3. **Salvar** guarda no navegador/app atual. **Enviar** executa no workspace visível do monitor escolhido. **Editar** permite alterar ou remover um item, inclusive um preset.

A busca encontra nome ou combinação. Grupos recolhíveis mantêm o catálogo curto. Os presets são sugestões do Ponte baseadas nos binds observados em outubro de 2026, não leitura dinâmica nem configuração do Omarchy. As teclas Super+1 etc. seguem o mapeamento vigente do sistema, que pode ser relativo ao monitor. Bancadas atuais ficam em 26–30, não presumir Super+6–0.

O armazenamento continua `localStorage['ponte-shortcuts']`: rótulo, combinação e presets ocultos. Dados antigos são lidos. Duplicatas são recusadas. Erro de armazenamento não é anunciado como sucesso e não altera o catálogo em memória.

## Contrato único

`public/mobile-shortcuts.js` define `PonteCombo`, importado também por `backend/desktop.mjs`. O browser e o servidor usam a mesma lista de nomes e códigos, com ordem canônica `Super`, `Ctrl`, `Alt`, `Shift`, tecla. Exemplos: `Super+F`, `Ctrl+Shift+C`, `Alt+Tab`, `Home`. `Enter` no editor corresponde ao nome canônico `Return`.

`POST /api/action {type:'keyboard.combo',combo,monitor}` valida antes de agir. O monitor é opcional para clientes CLI existentes. Com monitor, confere a presença e foca seu workspace visível antes do envio. Pressiona e solta todas as teclas numa chamada de ydotool, em ordem inversa na liberação. Falha tenta uma liberação compensatória e retorna erro. Arrasto em curso é solto antes.

A ação fixa **Abrir terminal com Pi** continua usando `/api/terminals {agent:'pi'}` na máquina selecionada, sem prompt nem shell livre.

## Verificação e compatibilidade

- `tests/mobile-shortcuts.test.mjs`: Super+F, combinação composta sem Super, tecla especial, invalidez, liberação, CRUD, duplicatas e falha de persistência.
- `tests/screen-context.test.mjs` e `tests/frontend.test.mjs`: três monitores com IDs não contíguos, destino obsoleto, remoção, nenhum monitor, último quadro identificado e ações contextuais.
- `tests/mobile-composition.test.mjs`: payload autenticado preserva combinação e monitor, sem digitar texto.
- `tools/lab/bin/hyprctl` aceita `.work/lab/desktop.json` com `monitors/workspaces/clients` para casos isolados de topologia dinâmica. Nunca envie testes ao desktop humano.
- Scripts e CSS continuam nos assets já autorizados pelo APK alpha.49. Esta mudança web não exige reinstalar o app.

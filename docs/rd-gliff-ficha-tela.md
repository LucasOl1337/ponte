# Ponte Remoto: ficha do seletor

1. **Quem usa:** Lucas no PC ou notebook Omarchy, ao abrir Ponte Remoto no menu.
2. **Tarefas:** escolher computador pelo nome, escolher a tela dele, conectar pelo Gliff, trocar de tela e de área durante a sessão, abrir explicitamente o Web legado.
3. **Objeto principal:** lista compacta de destinos SSH locais, com nome e alias lado a lado.
4. **Decisão:** nome do aparelho, rota SSH e motor devem aparecer juntos antes de conectar.
5. **Dados reais:** ~/.ssh/config tem 13 blocos Host concretos e um wildcard nesta máquina; aliases alternativos de um bloco aparecem numa linha. Sem consultar ou conectar hosts na abertura.
6. **Estado:** seleção vale apenas nesta abertura. Conectar faz preflight SSH e abre o upstream. Cancelar não conecta. Legado é uma linha nomeada, nunca substituição automática.

## App GTK (desde 16/11/2026)

O seletor padrão virou o app GTK/libadwaita de `desktop/rd_app.py` (detalhes em [rd-gliff.md](rd-gliff.md#app-aparelho-tela-e-áreas)). Lista agrupada (Computadores, Outros destinos SSH recolhidos, Web legado), página de telas com o mapa do Hyprland remoto, e na sessão uma pílula layer-shell no topo: recolhida mostra aparelho e área; aberta, telas e áreas 1–10 da tela mostrada. Prova visual feita num Hyprland isolado (fixture `tools/lab/gliff-isolated`), nunca no desktop humano.

## Regras e prova (seletor Zenity, ainda disponível com PONTE_RD_PICKER=zenity)

Seletor nativo Zenity, título Ponte Remoto, tabela expansível com uma linha por destino, botão Conectar e Cancelar. Nenhum campo exige digitar hostname. Alias vem de config local, nunca do texto exibido. Erros do atalho aparecem em notificação. Na CLI também aparecem no stderr.

O portão DOM checa_tela.py não se aplica a um diálogo GTK, sem navegador ou DOM. A lane Prova real deve medir/observar a janela em bancada em 1366×768 e 900×1000, confirmar ausência de corte horizontal, destino antes da dobra, cancelamento e rota legado. Captura e crítica visual pertencem à evidência dessa lane, não foram feitas nesta implementação.

Galeria consultada: manter formato conhecido, uma linha por objeto e escolhas nomeadas. Evitar cartões e densidade.

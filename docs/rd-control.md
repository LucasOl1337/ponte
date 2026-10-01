# Controle do teclado e do mouse no rd

Como a página `rd.html` decide se o teclado e o mouse estão neste aparelho (o PC
onde a janela está aberta) ou no aparelho da tela, e o que fica de fora.

## O que a página faz sozinha

- **Ctrl+Alt+Shift** alterna nos dois sentidos, com ou sem tela cheia. Só
  conta quando essas três são as únicas teclas apertadas, então Ctrl+Alt+Shift+T
  continua sendo atalho daqui. As três nunca chegam no aparelho da tela.
- **Clique na tela** começa a controlar. **Clique na barra** (fora do
  indicador) devolve.
- **Segurar Esc 2 s** sai da tela cheia e devolve.
- O **indicador no meio da barra** diz pra onde as teclas vão
  ("Teclado e mouse → notebook") e é clicável. Na troca aparece um aviso grande
  no meio da tela por 1,2 s, e a borda da tela fica verde enquanto controla.
- O **título da janela** ganha `⌨ nome · ` na frente enquanto controla. É isso
  que o módulo do Hyprland abaixo usa.
- Nas **Configurações** (engrenagem), o atalho pode também entrar em tela cheia
  em vez de só alternar.

## O limite do navegador

Fora da tela cheia, o Chrome entrega à página letras, números, Ctrl+C/V e as
setas, mas não as teclas que o próprio Chrome ou o Hyprland pegam antes:

| Tecla | Na janela | Em tela cheia (Keyboard Lock) |
| --- | --- | --- |
| Letras, Ctrl+C/V, setas | vai | vai |
| Ctrl+T, Ctrl+W, Ctrl+N | fica no Chrome | vai |
| Super e Super+qualquer | fica no Hyprland | vai |
| Alt+Tab | fica no Hyprland | vai |

Medido na bancada em 2026-10-01: `navigator.keyboard.lock()` resolve fora da
tela cheia, mas não tem efeito; Ctrl+T abriu aba nova. Em tela cheia, Ctrl+T/W,
Super e Alt+Tab chegaram ao lab como `KEY_LEFTMETA` etc.

## Opcional: Super pro outro aparelho também na janela

O Hyprland entrega tecla à janela quando ela não tem atalho no submap atual.
O módulo `tools/hypr/ponte_rd.lua` cria o submap `ponte-rd`, vazio a não ser
pela saída de emergência, e entra nele só quando a janela ativa é o rd
(classe `ponte-rd` ou `chrome-…__rd.html-…`) **e** o título começa com `⌨ `.

Sai do submap, devolvendo todos os atalhos do PC:

- quando a página solta o controle (o título perde o `⌨`);
- quando outra janela ganha o foco;
- com **Super+Ctrl+Alt+Esc**, que nunca vai pro outro aparelho.

O Chrome ainda pega Ctrl+T/W na janela; pra esses, a tela cheia continua sendo o
caminho.

```sh
tools/hypr/ponte-rd-hypr.sh check     # valida a config inteira com o módulo, sem gravar nada
tools/hypr/ponte-rd-hypr.sh install   # backup + módulo + 1 linha marcada no hyprland.lua
tools/hypr/ponte-rd-hypr.sh status
tools/hypr/ponte-rd-hypr.sh remove    # tira a linha e o módulo; o hyprland.lua volta igual
```

`install` só grava se `Hyprland --verify-config` aprovar a config inteira, e se
a gravação falhar a validação ele volta o backup. `HYPR_DIR=/uma/cópia` faz tudo
numa cópia (é assim que `tests/rd-hypr.test.mjs` testa).

**Ainda não instalado no PC do Lucas.** O que está provado: a config real com o
módulo passa no `--verify-config` (Hyprland 0.56.2), o `--verify-config` recusa
nome de evento errado, e o ciclo instalar/remover devolve o arquivo byte a byte.
O que só dá pra provar ao vivo: os campos `title`/`class` do objeto janela nos
eventos `window.active` e `window.title`. Teste ao vivo sugerido, com o Lucas
olhando: instalar, abrir `ponte rd notebook`, Ctrl+Alt+Shift, conferir
`hyprctl submap` = `ponte-rd`, apertar Super no notebook, Ctrl+Alt+Shift de
volta e conferir `hyprctl submap` = `default`. Se algo prender:
Super+Ctrl+Alt+Esc, e `remove`.

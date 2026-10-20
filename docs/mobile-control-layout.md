# Layout editável dos controles do celular

Módulo: `public/mobile-control-layout.js` (script clássico, sem dependências, expõe `window.PonteControlLayout`) e `public/mobile-control-layout.css`. Testes: `tests/mobile-control-layout.test.mjs`. Prova no navegador: `tools/lab/control-layout/`.

## O que flutua hoje (base b8d960c)

| Elemento (`public/index.html`) | ID genérico do contrato | Como é posicionado hoje |
| --- | --- | --- |
| `#screen-scroll` (grupo ▲▼, dois botões) | `screen.scroll` | dentro de `.screen-fabs`, `position:fixed` no canto inferior direito |
| `#screen-switch-monitor` | `screen.monitor` | idem |
| `#screen-rotate` | `screen.rotate` | idem |
| `#screen-keyboard` | `screen.keyboard` | idem |
| `#screen-dictate` (`.screen-mic`, 52 px) | `screen.dictate` | idem |
| `#screen-key-row .key-tail` (teclas móveis da barra do compositor) | lista `screen.keys` | `renderKeyBar('screen')` refaz o HTML com `innerHTML`; a cabeça Enter/Esc/Ctrl+C (`.key-head`), o `⋯` e a folha `.key-sheet` ficam fora |
| `#screen-workspaces`, `#node-badge` | não editáveis | ficam fora do módulo |

`.screen-fabs` segue a área segura e o teclado só por CSS: `bottom:calc(96px + env(safe-area-inset-bottom))`, `body[data-keyboard-open=true]` sobe acima de `--remote-viewport-top + --screen-composer-h`, e em paisagem vira fileira. `app.js` lê `.screen-fabs` em `screenControlBoxes()` para o pan não esconder a imagem atrás dos botões, e observa o mesmo seletor no `ResizeObserver`.

## Contrato

- Sem layout salvo, o módulo não toca em nada: o CSS atual decide. Com o módulo desligado (tela larga sem toque, o PC), estilos inline são removidos e nada salvo é aplicado.
- Posição salva = fração do percurso livre dentro da área segura sem teclado e sem a barra de edição (`x,y` de 0 a 1, canto superior esquerdo do item). Não guarda pixel absoluto. Na exibição, o item volta para dentro da área segura atual (teclado aberto, paisagem, barra de navegação, compositor) e é afastado de outros itens que ele sobreporia. Durante a edição a barra só limita até onde se arrasta; ela não entra no referencial, então o botão fica no mesmo pixel ao Salvar ou Cancelar.
- Retrato e paisagem têm posições separadas.
- Armazenamento: `localStorage['ponte-control-layout.v1.<layout>[.<aparelho>]']`, JSON `{v:1,pos:{portrait:{id:{x,y}},landscape:{…}},order:{lista:[ids]}}`. Só IDs (`[a-z0-9][a-z0-9._-]{0,47}`) e números; nenhum rótulo, texto digitado, comando salvo ou token. Mais de 8 KB, versão diferente de 1 ou JSON quebrado: padrão, sem lançar erro. A gravação só acontece em Salvar.
- Edição deliberada: só `layout.enter()` (o integrador põe um botão "Organizar botões"). Em edição: véu sobre a tela do PC (z-index 44, abaixo dos botões flutuantes em 45 e do compositor em 60; nenhum toque chega ao PC), cada item vira alça de arrastar, `pointerdown`/`touch*`/`mouse*`/`click` do item são engolidos na captura do documento (o atalho, a rolagem ou a tecla nunca saem), barra com Salvar, Cancelar, Restaurar padrão, Próximo, setas ↑↓←→ (8 px) e Antes/Depois para listas, todos com 44 px. Esc cancela. Fora da edição não há ouvinte do módulo em toque, ponteiro ou clique: arrastar remoto e pinça seguem iguais (só `resize`/`scroll`/`orientationchange` da janela e do `visualViewport`).
- A fileira de teclas só existe com o compositor aberto; é aí que ela é organizada. Comandos salvos (`[data-key-command]`) não são tocados nem guardados.
- Salvar falha (armazenamento cheio, bloqueado, mais de 8 KB): continua em edição com aviso, nada se perde em silêncio.
- `onChange({reason})` só dispara quando o layout muda (`enter`, `move`, `order`, `reset`, `save`, `cancel`), nunca por redimensionar; `layout.apply()` reaplica sem disparar, para usar logo depois de `renderKeyBar` sem laço.
- Listas (atalhos): ordem por ID genérico. `layout.order(lista, idsDoCatálogo, disponível)` devolve a ordem a desenhar: IDs salvos que sumiram do catálogo caem, novos entram na posição do catálogo, IDs travados (cabeça) ficam no lugar, e item indisponível por permissão nunca volta por causa da ordem salva (a posição dele é guardada, a visibilidade não).
- Item com `hidden` (permissão, capacidade) não é mostrado nem selecionável pelo módulo.

## API

```js
const layout = PonteControlLayout.mount({
  layoutId: 'screen',                 // chave v1
  floats: [{ id: 'screen.keyboard', element: $('#screen-keyboard') }, …],
  // element pode ser função: a fileira é refeita por innerHTML.
  lists: [{ id: 'screen.keys', element: () => $('#screen-key-row .key-tail'), locked: ['enter','esc','ctrl-c'] }],
  avoid: () => [$('.bottom-nav'), $('#screen-composer')],   // o que não pode ser coberto
  t,                                  // tradução opcional (recebe a frase PT)
  onChange: ({ reason }) => …,        // layout mudou
});
layout.enter(); layout.cancel(); layout.save(); layout.reset();
layout.refresh();                     // agenda reaplicação (rAF), ex. depois de syncRemoteViewport
layout.apply();                       // reaplica já, sem onChange (depois de renderKeyBar)
layout.boxes();                       // [{id,left,top,width,height}] dos itens visíveis
layout.order('screen.keys', ids, id => available);
layout.editing();                     // true durante a edição
layout.snapshot();                    // estado atual (só IDs e frações)
layout.destroy();
```

Outras opções: `deviceId` (layout por PC), `storage` (padrão `localStorage`), `enabled()` (padrão: toque grosso ou largura ≤ 700 px), `insets()` (padrão: `env(safe-area-inset-*)` via `.pcl-probe`), `layerParent`, `itemSelector`/`idOf` por lista, `catalog()` por lista (ordem padrão; sem ela, a ordem de quando a edição começou).

O snippet de integração para `public/app.js`/`index.html` está em `/home/lol/relatorios/ponte-mobile-20261020/layout/INTEGRACAO.md`.

## Prova no navegador

`tools/lab/control-layout/index.html` monta o `#page-tela` e a `.bottom-nav` reais de `public/index.html` com o `styles.css` real e a fileira de teclas com as mesmas classes de `renderKeyBar`. `drive.mjs` dirige a página por CDP com toques de verdade num celular emulado (320, 360, 390, 430, paisagem 844×390, teclado aberto) e grava capturas e `checks.json`:

```sh
python3 -m http.server 8817 --bind 127.0.0.1 &   # na raiz do repo
CDP_URL=http://127.0.0.1:PORTA OUT=/tmp/prova node tools/lab/control-layout/drive.mjs
```

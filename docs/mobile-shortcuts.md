# Atalhos do sistema no celular

O celular manda atalhos do Omarchy (Hyprland) para a máquina que está
controlando sem digitar a palavra "Super" e sem deixar tecla presa. Há também
uma ação fixa, **Abrir terminal com Pi**.

## Peças

| Peça | Arquivo | O que faz |
| --- | --- | --- |
| Ação `keyboard.combo` | `backend/desktop.mjs` | Recebe `{type:'keyboard.combo', combo}` em `POST /api/action`, com o token de sempre. Aceita só `Super[+Ctrl][+Alt][+Shift]+TECLA`, com os modificadores nessa ordem. Cada nome vira um código evdev fixo (`COMBO_KEYS`). Pressiona e solta tudo numa única chamada `ydotool key`, soltando na ordem inversa. Se a chamada falha, solta de novo. Um arrasto em curso é solto antes do atalho. Fora da lista, devolve `400 KEY_NOT_ALLOWED` e o ydotool não roda. |
| Agente `pi` | `backend/terminals.mjs` | `POST /api/terminals {agent:'pi'}` abre a sessão tmux "Pi N" rodando o CLI `pi` como argv, sem shell. Agente `bare`: qualquer `prompt` é recusado (`INVALID_PROMPT`). A máquina vem do `?node=` que o app já usa (relay entre nós pareados); sem nó, é o próprio PC. |
| Paleta | `public/mobile-shortcuts.js` + `.css` | O botão "⌘ Atalhos" abre uma lista agrupada (Ações, Janela, Workspaces, Apps, Sistema, Meus atalhos). Cada toque envia um `keyboard.combo`. "Montar atalho" combina Ctrl/Alt/Shift com uma tecla, e os atalhos salvos vão para `localStorage['ponte-shortcuts']`, só com combo e rótulo. Todo alvo de toque tem 44px ou mais. O módulo não faz fetch: o app injeta `send`, `openPreset` e `target`. |
| CLI | `bin/ctl-catalog.mjs` | `./ponte ctl keyboard combo --combo Super+F` |

## Atalhos padrão

Foram conferidos contra `hyprctl -j binds` em 20/10/2026, e o teste exige que
cada um seja canônico. Os cinco pedidos vêm primeiro: Super+F (tela cheia),
Super+W (fechar janela ou encerrar bancada), Super+Shift+1 e Super+Shift+2
(mover janela para o workspace 1 e 2) e Super+Space (menu de apps). Depois vêm
Super+Return, Super+1…3, Super+Shift+3, Super+Tab, Super+Ctrl+Tab, as setas,
T, J, S, Shift+B, Shift+F, C, V, Escape, K e Comma.

Super+6…0 ficam fora da lista padrão de propósito: nesta máquina eles entram
nas bancadas dos agentes. Quem quiser pode montá-los em "Montar atalho".

## Ligar no app (para quem mexe em `public/app.js` e `index.html`)

```html
<!-- index.html, junto dos outros assets -->
<link rel="stylesheet" href="/mobile-shortcuts.css?v=0.1.0-alpha.48">
<script src="/mobile-shortcuts.js?v=0.1.0-alpha.48" defer></script>
<!-- onde o botão deve morar, por exemplo ao lado da barra de teclas da tela -->
<div id="shortcut-host"></div>
```

```js
// app.js, depois que o app está pronto
const shortcuts = window.PonteShortcuts?.mountShortcuts($('#shortcut-host'), {
  // /api/action com o token e o ?node= atuais; actionResult já mostra o erro.
  send: async action => { if (!await actionResult(action.type, { combo: action.combo })) throw new Error(t('Não foi possível concluir a ação.')); },
  // Abre o Pi na máquina escolhida; a máquina vem só de targetNode.
  openPreset: async request => {
    if ((request.node || '') !== targetNode) throw new Error('TARGET_CHANGED');
    const session = await (await api(request.path, { method: request.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request.body, ...devSessionSize() }) })).json();
    toast(t('Abrindo {title}…', { title: session.title }));
  },
  target: () => connected ? { id: targetNode, name: targetName() } : null,
  storage: localStorage,
});
// Em setTargetNode(), depois de trocar a máquina: shortcuts?.refresh();
```

## Segurança

- Super é obrigatório, então `Ctrl+Alt+Delete` e atalhos de aplicativo não
  passam por aqui. Esses continuam em `keyboard.key`, que tem a própria lista.
- O pedido não carrega código de tecla. O servidor só converte nomes
  conhecidos, e `__proto__`, `toString` e afins são recusados.
- O Pi nunca recebe texto do celular: o agente é `bare`, o id vem de uma lista
  constante (`TERMINAL_AGENTS`), sem curinga, e o app só manda `agent:'pi'`.
- O botão do Pi fica desligado enquanto não houver máquina escolhida.

## Prova

- `tests/mobile-shortcuts.test.mjs`: ordem de pressionar e soltar, lista
  recusada sem chamar o ydotool, liberação depois de falha, arrasto solto
  antes, catálogo e persistência, paleta no DOM fake e alvos de 44px.
- `tests/backend.test.mjs`: `/api/action` sem token dá 401, com token faz uma
  única chamada ao ydotool, e um combo fora da lista dá 400.
- `tests/terminals.test.mjs`: o Pi abre como argv `pi`, recusa prompt e
  recusa variações do id.
- O lab (`tools/lab/bin/ydotool`) registra em `down` as teclas que ainda estão
  pressionadas depois de cada chamada. Depois de um atalho, a lista deve
  ficar vazia.

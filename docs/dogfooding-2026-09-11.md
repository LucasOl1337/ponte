# Dogfooding do Ponte no emulador (11/09/2026)

Relatório inicial. Rodei o APK atual do repo (0.1.0-alpha.4, versionCode 7) num emulador Android dentro do Maestri, conectado no servidor real deste PC (`100.99.71.120:8788`). Passei por todas as telas, gravei e mandei voz, criei e fechei sessão de terminal, despareei e pareei de novo.

Screenshots (109 arquivos) estão fora do repo porque mostram o desktop de verdade, com WhatsApp e afins: `~/Documents/Codex/2026-09-05/ar/work/dogfood-2026-09-11/shots/`. O nome de cada shot citado abaixo tá entre colchetes.

## Ambiente e ressalvas

- Emulador `sfr-portfolio`, Android 11, 1080x2280, **WebView 83 (2020)**. O Redmi de verdade tem Android 14 com WebView atual, então parte do que vi aqui é o app rodando num WebView velho. Marquei esses casos com "(WebView velho)".
- Build com config sintético apontando pro cert atual (`~/Documents/Codex/2026-09-05/ar/work/ponte-native-tls/server.crt`, self-signed, CA = ele mesmo). `~/.config/ponte/config.json` não existe nesta máquina, então `./ponte pair` e `./android/build.sh` sem `PONTE_CONFIG` quebram. O serviço em execução ainda é o unit antigo com `OMARCHY_REMOTE_*`.
- Não disparei nada que mexesse no seu desktop de propósito: nada de touchpad, teclado pro PC, foco de janela, mídia, energia, "Tocar no PC". Exceção involuntária: um toque caiu na imagem em modo Toque direto e provavelmente mandou um clique esquerdo em ~(1665, 875) do HDMI-A-1, na área do chat do WhatsApp. Ver bug 2.
- A árvore de acessibilidade do uiautomator vem vazia (`uiautomator returned no usable nodes`). O WebView não expõe nada. Tive que navegar por coordenada de screenshot.

## Os bugs que importam, em ordem

1. **`dvh` sem fallback quebra o layout em WebView antigo.** `public/styles.css` tem ~10 regras com `dvh` puro (preview da tela, `#terminal-output`, touchpad, modal, fullscreen). Chromium só entende `dvh` a partir da 108. No WebView 83 a regra inteira é descartada: a caixa do terminal fica sem altura e cresce até virar a página inteira [23-term-typed], o modo Foto ocupa a tela toda [51-frozen-later], a aba Teclado fica com ~230px de buraco embaixo da imagem [14-keyboard-noime]. Fix barato: declarar `vh` na linha de cima de cada `dvh`, e/ou usar a `--remote-viewport-height` que o app já seta (`app.js:340`) em todas elas, não só em algumas. (WebView velho, mas o README diz "Android 8+".)

2. **Trocar de aba pra Toque direto rola a página pro topo e coloca a imagem clicável exatamente onde ficavam os controles.** Eu estava com a página rolada (Touchpad selecionado), toquei em "Toque direto", a página voltou pro topo, e meu toque seguinte na posição da aba "Teclado" caiu dentro da imagem e virou clique no PC [10-direct-touch]. Num celular na mão isso é um clique fantasma no desktop. Sugestão: ao entrar em Toque direto, manter a posição de rolagem, ou pedir um segundo toque de confirmação nos primeiros segundos, ou pelo menos não rolar.

3. **Back fecha o app de qualquer tela.** `navigate()` usa `history.replaceState` (`app.js:283`), então `browser.canGoBack()` em `MainActivity.onBackPressed()` é sempre falso e o app morre no primeiro Back com teclado fechado [19-term-typed, 60-pre-enter]. Aconteceu duas vezes sem querer. Fix: `pushState` por página e tratar `popstate`, ou interceptar Back no JS e voltar pra Tela.

4. **Nome da gravação de voz em UTC.** `backend/audio.mjs:60` monta `Audio ${createdAt.slice(0,19)}` do ISO (UTC). Título mostra "10:20:28" e o subtítulo mostra "07:20 AM" [36-voice-list]. Além disso o nome antigo era "Áudio" (localizado) e o novo é "Audio", então a lista mistura idiomas. Gerar o nome no cliente, na hora local, ou exibir só `createdAt` formatado e deixar o nome como campo editável.

5. **Landscape: a nav inferior cobre a fila de modos (Ver / Toque direto / Touchpad / Teclado).** `.bottom-nav` é `position:fixed; z-index:20` e em landscape ela cai em cima dos tabs; só "Ver" e "Teclado" aparecem nas pontas [42-landscape-crop]. Em fullscreen tá certo [43-fullscreen-crop]. Pode ser efeito do bug 1, mas vale checar no Redmi.

6. **Nav inferior fica em cima do campo quando o teclado do Android abre.** Na tela Terminais com IME aberto, a nav cobre metade do botão "Digitar" [56-term-typed]. Esconder a nav enquanto um input tem foco.

7. **Os alvos mudam de lugar enquanto você mira.** Na tela Terminais a caixa de saída cresce conforme chega texto e empurra Enter/Encerrar pra baixo. Dois toques meus em "Enter" caíram no vazio por isso (e o "Encerrar" também). A caixa precisa de altura fixa com rolagem interna (é o que o CSS tenta fazer, ver bug 1), e mesmo com altura certa vale prender a área de comandos.

8. **Despareamento sem confirmação.** "Desconectar este navegador" no modal de Info apaga a chave num toque [63-unpair → 64-unpair2]. Pedir confirmação; é a única ação que te obriga a voltar no PC pra pegar a chave de novo.

9. **Erro de chave errada é o genérico `PAIRING_REQUIRED`: "Pareie este dispositivo para continuar."** [68-pair-wrong-result]. Você tá literalmente tentando parear. Precisa dizer "Chave incorreta. Confira `./ponte pair` no PC."

10. **Copy de PWA dentro do app nativo.** Modal de Info: "Um lugar na sua tela inicial / Ponte instalado. Abra pelo ícone", "Desconectar este navegador", "A chave fica somente neste navegador", "Acompanhar a construção ↗" (link externo que o app não abre, por design). A lista de capacidades (Mouse, Teclado, Foto, Tela ao vivo, Áudio) não cita Terminais, Janelas nem Energia [37-info-strip].

## Por tela

### Tela (Screen) [01, 41-pt-screen, 47-one-to-one, 49-strip, 52-frozen-bottom]

Funciona: ao vivo com ~10 fps no emulador, pausar/retomar, snapshot, 1:1 (mostra pixel nativo e dá pra ler texto), fullscreen em landscape, seleção de monitor e qualidade (selects nativos), "Ler em alta resolução" (chegou em ~10-15s no WebView velho, com "tile memory limits exceeded" no logcat; deve ser bem mais rápido no Redmi).

Problemas:
- Layout: a página cabe na tela em retrato sem rolar, ótimo. Mas o texto de ajuda encosta na nav.
- Em 1:1 e no modo Foto não tem nenhuma pista de qual pedaço do monitor você tá vendo. Um minimapa pequeno no canto ou uma barra "x% da tela" resolve.
- "Capturando…" fica como texto solto em cima da imagem, sem fundo, e sem indicação de progresso [50-frozen].
- O select do monitor trunca em PT: "HDMI-A-1 · 1920 × 1080 · em foc" [41-pt-screen].
- "Foto às 07:23:22 · imagem parada" quebra em duas linhas com o 1:1 ativo [52-frozen-bottom].
- Console: `The key "interactive-widget" is not recognized` e `ResizeObserver loop limit exceeded` (esse último ao entrar no modo Foto).
- Badge "Toque direto ligado" cobre o canto superior esquerdo da imagem [10-direct-touch].

### Controle = Tela + Touchpad [09-control-adb, 16-touchpad-after-kb]

A aba "Controle" da nav é a mesma página Tela com Touchpad selecionado e rolada pra baixo. Isso confunde: a nav marca "Controle" mas o título continua "Tela", e ao tocar em "Ver" o item ativo da nav volta pra "Tela". Ou vira página própria, ou a nav destaca os dois como um só.

O touchpad em si tem bom tamanho e os botões Clique / Arrastar / Botão direito estão à mão. Não testei o movimento (mexeria no seu mouse).

### Teclado [13-keyboard, 14-keyboard-noime, 15-crop]

- Selecionar a aba já abre o IME, bom.
- Mostra "Texto vai para a janela focada: de_dust2 - Chromium", útil.
- A fila de atalhos (Esc, Tab, Delete, Enter, Copiar, Colar, Desfazer, Selecionar tudo, setas) rola na horizontal sem nenhuma pista visual de que continua. Sugiro duas linhas, ou um fade na borda direita.
- Buraco de ~230px embaixo da imagem depois que o IME fecha (bug 1).
- Ação do IME é "→" (próximo). Podia ser "Enviar" (`enterkeyhint="send"`).

### Terminais [17-terminals, 55-new-session, 73-close-dialog, 74-close-dialog]

Funciona: Nova sessão cria tmux novo, "Digitar" manda o texto, Enter executa (confirmei o eco no pane via tmux), Encerrar pede confirmação e remove a sessão. Ficou a "Terminal 1 · 4c5db2" que já existia, com um agente Hermes rodando dentro; o app mostra a saída em tempo real.

Problemas:
- A caixa de saída (bugs 1 e 7).
- Uma sessão recém-criada aparece com a caixa vazia por alguns segundos antes do prompt `~ ❯` chegar; um "aguardando o shell…" evitaria a impressão de que travou.
- Os botões de tecla quebram em duas linhas assim: `Enter Tab Ctrl+C Esc ←` / `→ ↑ ↓ ⌫`. As setas ficam separadas. Agrupar setas num bloco (cruz) e deixar Enter/Tab/Ctrl+C/Esc/⌫ na outra linha.
- Margens da página são maiores que as da Tela (34px vs 18px no screenshot). O logo "ponte." pula de lugar ao trocar de aba.
- "Largura" com o label cortado ("Largura" fica espremido ao lado do select "Celular · 40 colunas").
- Diálogo de encerrar: botões pequenos e alinhados à esquerda, "Cancelar" com foco visível por padrão (bom) mas o destrutivo devia ficar à direita e em cor de alerta.

### Janelas [27-windows, 28-windows-strip]

Funciona: busca, chips de workspace, lista com app, título, workspace e "focused".

Problemas:
- O hero "Find your next window." come 250px antes do conteúdo. Numa página utilitária isso é rolagem grátis. O mesmo vale pra Voz e Início.
- Chips de workspace fora de ordem: `All 1 2 3 11 7 4` aqui e `1 2 3 11 4 5` no Início. Ordenar numericamente e usar a mesma lista nos dois lugares.
- A janela focada (RamDog) aparece no fim da lista. Colocar no topo ou fixar como card "agora".
- Títulos truncados sem tooltip (`devin: Build a highly accurate playable clone o`). Aceitável, mas duas linhas cabem.

### Início (casa) [29-home-strip, 30-home-mid-strip]

É a única página com Som/Mídia e Energia, e não está na nav inferior. Você chega por um ícone de casa no topo que não parece botão. Mídia e Energia ficam duas rolagens abaixo do hero. Sugestão: promover "Início" pra nav (trocando "Controle", que é redundante com Tela), ou tirar Mídia e Energia dali e dar página própria.

Detalhes:
- Card "Seu computador: lol · online · 10 janelas · 7 workspaces · 32m uptime" é bom.
- "Abrir algo: Browser / Terminal / Arquivos" com setas de link externo: o ícone sugere que sai do app; na verdade abre no PC. Trocar por ícone de monitor.
- Slider de volume no meio de uma página que rola: fácil mudar sem querer. Passos de botão (+/-) ou pedir toque no valor.
- Ícone de alto-falante aparece duas vezes (título da seção e botão mudo) com o mesmo desenho. Qual é botão?
- "Desligar computador" vermelho fica entre "Acordar" e o MAC de Wake-on-LAN. Tem dupla confirmação, mas eu afastaria pra baixo de tudo.
- Os chips de workspace têm um pontinho (`1•`) sem legenda.

### Voz [31-voice-strip, 33-voice-granted, 34-voice-review, 36-voice-list]

Funciona: pedido de permissão do Android, gravação com contador e badge RECORDING (e um pontinho na aba Voz), parar, preview, "Enviar para o PC" grava o `.webm` + `.json` no servidor, lista atualiza.

Problemas:
- Bug 4 (UTC e idioma misturado no nome).
- O player de preview é o `<audio controls>` nativo: pílula branca em cima do tema escuro [34-voice-review]. Player próprio ou pelo menos `color-scheme` no elemento.
- "Send to PC ▷" com o ícone grudado no texto.
- "Stop PC audio" com glifo de checkbox dentro de um botão: parece opção e não ação.
- Meta "Sep 11, 07:20 AM ·" com o ponto separador solto quando "72 KB" quebra de linha.

### Info (modal) [37-info-strip, 63-unpair]

Bugs 8 e 10. O modal rola junto com a página atrás dele em vez de ficar fixo. Título "Uma conexão. Muitas possibilidades." não diz nada; podia ser o estado real (host, IP, cert, versão do app e do servidor, que hoje não aparece em lugar nenhum).

### Pareamento [66-pair-strip, 67-pair-wrong-typed, 68-pair-wrong-result, 70-paired]

Funciona: cola a chave, conecta, cai direto na Tela ao vivo. Persiste entre relaunches.

Problemas:
- Bug 9 (erro genérico).
- Campo de senha sem botão de mostrar/ocultar. Chave de 43 caracteres digitada às cegas.
- O IME abre sozinho ao entrar na página e cobre o botão; ao fechar, a página rola e o campo muda de lugar.
- Copy "A chave fica somente neste navegador" (é um app).
- Hero "Dois dispositivos. Um só lugar." + ilustração tomam 60% da tela antes do campo.

### Idioma [39-lang-dropdown, 41-pt-strip]

PT/EN funcionam e persistem. O select nativo é feio mas ok. Depois de escolher PT o primeiro frame ainda mostrava EN por ~1s.

## O que não testei e por quê

- Movimento do touchpad, clique, arrastar, botão direito, envio de texto/atalhos pro PC, foco de janela, mídia, volume, mudo, energia, "Tocar no PC": tudo isso agiria no seu desktop enquanto você usa. Precisa de uma sessão Hyprland separada (a bancada `agent-bench`) pra testar de verdade.
- Pinch pra zoom na imagem: o adb não segura o gesto no meio.
- Microfone real: o emulador grava silêncio.
- Wake-on-LAN, renovação de certificado, revogação de token.

## Ferramental

- `maestri portal click` não registrou nenhum toque no WebView; `adb shell input tap` funciona. `maestri portal snapshot` vem vazio. Pra esse app o caminho é screenshot + coordenada.
- Escala: screenshot do portal 606x1280, device 1080x2280, fator 1,78.
- Helper que usei: `shots/` tem os PNG numerados na ordem em que testei.

## Próximos passos que eu faria

1. Fallback `vh` pra todo `dvh` e reusar `--remote-viewport-height` (uma tarde, resolve 1, 5 parcialmente, 7).
2. `pushState` + `popstate` pra Back não matar o app.
3. Nome da gravação em hora local, gerado uma vez só.
4. Confirmação no despareamento e mensagem específica pra chave errada.
5. Esconder a nav com o IME aberto; travar rolagem ao entrar em Toque direto.
6. Repensar a nav: Tela · Terminais · Janelas · Voz · Início, com Controle virando aba interna da Tela (já é).

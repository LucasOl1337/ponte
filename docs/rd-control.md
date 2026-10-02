# Controle do teclado e do mouse no rd

A página `rd.html` alterna entre o teclado e mouse deste aparelho e os do aparelho na tela.

## Alternar

- **Ctrl+X** alterna nos dois sentidos, com ou sem tela cheia. É reservado nesta janela, não recorta. Ctrl+Shift+X, Ctrl+Alt+X e Super+Ctrl+X não alternam. O Ctrl e o X da alternância não vão pro outro aparelho.
- **Clique na tela** começa a controlar. **Clique na barra**, fora do indicador, devolve. A tela recebe o foco de teclado mesmo depois de trocar aparelho ou monitor pelo seletor.
- **Segurar Esc 2 s** sai da tela cheia e devolve. Esc curto continua sendo tecla remota.
- O **indicador da barra** diz pra onde as teclas vão e também alterna com um clique. Controlando, a tela tem borda verde e o título começa com `⌨ nome · `.
- Ao perder o foco da janela ou esconder a página, o controle é devolvido e as teclas remotas são soltas. Ctrl+X pega de novo.
- Nas **Configurações**, Ctrl+X pode também entrar em tela cheia em vez de só alternar.

## A tela acompanha o monitor em foco

Um atalho como **Super+2** que abre um espaço de trabalho morando em outro monitor traz esse monitor pra tela remota. Quem decide é o aparelho mostrado: ele escuta o socket de eventos do Hyprland (`.socket2.sock`), e um `focusedmon` que aponta pra outro monitor vira uma troca de captura. A página só recebe o `ready` novo, com o nome e o tamanho do monitor que entrou.

- **Ligado por padrão.** Desliga em Configurações → Monitor → *Acompanhar o monitor em foco*, por página. O `hello` leva `follow`, e `{"t":"follow","on":false}` muda no meio da sessão. Religar já pula pro monitor que está em foco agora.
- **Escolher um monitor na lista não desliga o acompanhamento**, só muda a vista naquele momento: o próximo Super+N continua levando a tela junto.
- **Passar por vários espaços de trabalho reinicia o encoder uma vez só.** Cada troca custa ~450 ms sem imagem, então só o monitor onde o foco para conta (`FOLLOW_SETTLE_MS`, 250 ms).
- Uma conexão de eventos serve todas as sessões, abre com a primeira e fecha com a última. Sem Hyprland (sem assinatura de instância ou sem socket) o acompanhamento simplesmente não acontece, e o resto da sessão segue igual. Se o Hyprland reiniciar, a conexão volta sozinha.

## Texto legível em monitor largo

Fora da LAN a sessão anda numa escada de degraus (`backend/rd-rate.mjs`). Cada degrau tem um teto de largura em pixels e um **piso de legibilidade**: a fração mínima do monitor que sobrevive a esse teto.

Só o teto quebrava a promessa do próprio código ("fps cai antes da largura: ler texto importa mais que movimento") em tela larga: 1920 de um monitor de 3440 é 56% da imagem, e texto a 56% não dá pra ler por mais quadros que cheguem. O limite de cada degrau é o maior entre os dois, então um monitor de 1080p vê exatamente os tetos de sempre e um ultrawide guarda pixel suficiente pra leitura.

| Degrau | kbps | Teto | Piso | 1920 | 2560 | 3440 |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 600 | 1280 | 50% | 1280 | 1280 | 1720 |
| 1 | 1000 | 1920 | 75% | 1920 | 1920 | 2580 |
| 2 | 1600 | 1920 | 100% | 1920 | nativo | nativo |
| 3 (abertura) | 2500 | 1920 | 100% | 1920 | nativo | nativo |
| 4 e 5 | 4000 e 6000 | nativo | 100% | nativo | nativo | nativo |

O palco da página continua limitando por cima: mandar 3440 px pra uma janela de 1500 px gasta bytes que ninguém vê. Trocar de monitor relê o piso, porque ele é uma fração do monitor que está sendo mostrado.

## O limite do navegador

| Tecla | Na janela | Em tela cheia (Keyboard Lock) |
| --- | --- | --- |
| Letras, Ctrl+C/V, setas | vai | vai |
| Ctrl+X | alterna, não recorta | alterna, não recorta |
| Ctrl+T, Ctrl+W, Ctrl+N | fica no Chrome | vai |
| Super e Super+qualquer | depende do módulo Hyprland abaixo | vai |
| Alt+Tab | depende do módulo Hyprland abaixo | vai |

Keyboard Lock só captura os atalhos do Chrome em tela cheia iniciada pela página. Fora dela, pedir `navigator.keyboard.lock()` não basta. Isso foi medido com o teclado da bancada e o lab em 2026-10-01.

## Opcional: atalhos do Omarchy na janela

`tools/hypr/ponte_rd.lua` cria o submap `ponte-rd` e entra nele só quando a janela ativa é o rd, classe `ponte-rd` ou `chrome-…__rd.html-…`, e o título começa com `⌨ `. As teclas sem bind no submap vão à janela. Assim Super e os atalhos do Omarchy podem chegar no aparelho remoto sem tela cheia.

Devolve os atalhos locais quando o título perde a marca, outra janela ganha foco, a janela fecha ou você aperta **Super+Ctrl+Alt+Esc**. Ctrl+X remove a marca na página, portanto devolve também o submap. O Chrome ainda pega Ctrl+T/W na janela.

```sh
tools/hypr/ponte-rd-hypr.sh check
# Só o operador instala na sessão real:
tools/hypr/ponte-rd-hypr.sh install
tools/hypr/ponte-rd-hypr.sh status
tools/hypr/ponte-rd-hypr.sh remove
```

`install` faz backup e só grava se a config inteira passar em `Hyprland --verify-config`. `HYPR_DIR=/uma/cópia` permite testar sem tocar na config viva.

## Por que o teclado sumia depois de trocar de aparelho

O clique na imagem usava `preventDefault`, que conservava o foco no `<select>` da barra. A página dizia que controlava, mas descartava todo evento de tecla cujo alvo fosse `SELECT`. Reproduzido com notebook → este aparelho → notebook, clique na imagem e teclado nativo da bancada: mouse chegou, Z e Super não. Agora todas as entradas de controle focam a tela não editável e um foco antigo de seletor não bloqueia a injeção.

## Aceite de 1 minuto no aparelho real

Só o dono opera o teclado real. O agente acompanha os logs sem injetar entrada.

1. Abra `ponte rd` no notebook remoto. No seletor, escolha este aparelho e volte ao notebook.
2. Clique na imagem. Digite `zzz` num campo de teste do notebook e use Super+1. Deve atuar no notebook. A barra deve dizer que está controlando o notebook.
3. Aperte Ctrl+X. A barra volta pra este aparelho e `hyprctl submap` no PC volta a `default`. Super+1 deve funcionar no PC.
4. Ctrl+X de novo pega o notebook. Ctrl+Shift+X não pode devolver o controle. Ctrl+C/V devem continuar remotos.
5. Escolha tela cheia nas configurações. Ctrl+X entra, outro Ctrl+X sai e devolve. Segurar Esc 2 s também devolve.
6. Abra detalhes técnicos e confira a trilha de teclas. Feche a janela e compare os contadores de teclado no journal de origem e destino.

Se prender: **Super+Ctrl+Alt+Esc** devolve os atalhos locais. Feche a janela e guarde os registros `session closed` dos dois aparelhos.

## Diagnóstico que fica disponível

Configurações → Detalhes técnicos mostra as últimas 12 teclas: código físico, pressão/soltura, se saiu ou por que ficou. `IME/229` destaca composição local sem descartar um código físico válido. A trilha fica só na memória da página, sem o texto de `event.key`, clipboard ou gravação no servidor. Reconectar zera os contadores da página.

Ao fechar uma sessão, o journal tem `[rd] session closed` com `sessionId` aleatório e papel `target` ou `relay`:

- `received`: mensagens key que chegaram, antes dos filtros;
- `queued`: enfileiradas pro helper, não prova de injeção;
- `injected`: ACK do helper com `applied=true`, depois do evento evdev escrito;
- `discarded`: quantidade por motivo, como `view_only`, `unknown_code`, `duplicate_down`, `up_without_down`;
- `unconfirmed` e `pending`: sem prova de aplicação, por saída do helper, pipe quebrado ou final não observado;
- `dryRun`: a injeção era simulada no lab, nunca abriu uinput.

Na origem, `forwarded` só significa encaminhado. `targetObserved` é a última contagem confirmada pelo destino. `complete:false` e `unobserved` avisam que o fechamento da conexão pode ter perdido os ACKs finais. O journal do destino, após drenar o helper, é a contagem final. Os logs não contêm códigos das teclas, texto digitado nem tokens.

Para separar a falha: página viu 0 eventos é foco/compositor/IME antes dela. Viu eventos sem envio é uma decisão da página. Enviados e relay encaminhados, mas destino não recebeu, aponta transporte. Recebidos sem injected, confira discarded/unconfirmed no alvo. Contagem não substitui olhar o efeito no aplicativo remoto.

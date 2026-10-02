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
| 4 a 7 | 4000, 6000, 9000 e 14000 | nativo | 100% | nativo | nativo | nativo |

Os dois últimos degraus existem porque o link de casa mediu 27,9 Mbps com 0% de
perda e a escada parava em 6: uma sessão usava 21% do que havia. Em CBR o
keyframe melhora junto com o bitrate (SSIM 0,959 a 2500 kbps contra 0,986 a
6000), e é ele que aparece depois de cada reinício.

O palco da página continua limitando por cima: mandar 3440 px pra uma janela de
1500 px gasta bytes que ninguém vê. Trocar de monitor relê o piso, porque ele é
uma fração do monitor que está sendo mostrado.

## Como a escada sabe que tem espaço

A escada subia no cronômetro: 30 s sem reclamação e um degrau por minuto. Não
era conservadorismo, era falta de medida. A única régua era cronometrar a
rajada de um keyframe, e uma rajada não mede mais que os próprios bytes sobre o
piso de 50 ms do ack: um keyframe de 110 KB mediu 17 Mbps num link que carrega
28, e um de 15 KB ficou abaixo do limiar de amostragem e não mediu nada. Com
isso dava pra saber que o degrau atual cabe, nunca que o de cima cabe.

Hoje ela lê o **gradiente do atraso de ida**, que é como o WebRTC mede
capacidade sem nunca encher o link (`backend/rd-bwe.mjs`, o estimador do
[GCC](https://datatracker.ietf.org/doc/html/draft-ietf-rmcat-gcc-02)). Os
quadros saem em T(i) e chegam em t(i); enquanto o link dá conta, a diferença
`(t(i) − t(i−1)) − (T(i) − T(i−1))` fica em volta de zero por mais rápido que
se mande. No instante em que se pede mais do que ele carrega, começa a formar
fila e essa diferença vira positiva, muito antes de perder um byte ou de a fila
ficar grande o bastante pra aparecer num limiar.

O dado já estava no fio: o cabeçalho de vídeo leva a hora de envio e o ack leva
o número do quadro que chegou. Faltava o ack dizer **quando** chegou, que é o
campo `rx`. Ele vai no relógio da própria página, sem correção: o servidor só
subtrai uma chegada da outra, então o deslocamento entre os dois relógios
cancela sozinho, e reestimar esse deslocamento no meio da sessão não injeta
degrau num gradiente que é lido em décimos de milissegundo.

Quem autoriza subir é o gradiente plano por 2 s. O alvo do próprio GCC não
serve pra isso: ele nunca passa de 1,5× o que está sendo entregue, e todo salto
da escada é de 1,5× ou mais, então o alvo bloquearia qualquer subida. O alvo
serve pra descida, junto com o que o link entregou desde que o gradiente saiu
do plano; vale a menor das duas, porque um link que acabou de estreitar ainda
está entregando a taxa antiga de dentro dos buffers.

Três constantes do libwebrtc tiveram que ser recalibradas, todas pelo mesmo
motivo: lá o retorno é por pacote, centenas por segundo, e aqui é um ack a cada
50 ms.

| Constante | libwebrtc | Aqui | Por quê |
| --- | --- | --- | --- |
| Janela do ajuste | 20 pontos | 16, a partir de 5 | 20 pontos a 50 ms é 1 s, e num link entregando metade do que se manda as chegadas se espaçam pra 100 ms: a resposta vinha com a fila já passando de 1 s |
| Suavização | 0,9 (dez amostras) | 0,7 (três) | a 50 ms por amostra, 0,9 é meio segundo de atraso só no filtro |
| Ganho da adaptação do limiar | k·Δt, Δt ≤ 100 ms | o mesmo, com ganho ≤ 0,5 | `k_down = 0,039` por ms com Δt de 50 ms dá ganho 1,95, que oscila em vez de convergir; lá o retorno denso mantém o ganho em ~0,2 |

Uma página que não reporta `rx` continua exatamente no comportamento antigo.

Medido em link simulado (`tests/rd-rate.test.mjs`), a escada estabiliza no
degrau certo em 900k, 1200k, 3000k, 5000k, 9000k e 28000k. Num link largo ela
sai do degrau de abertura e chega ao topo em 12 s, contra os ~4 minutos do
cronômetro. Num estreitamento de 28 Mbps pra 900 kbps, cai em 3 s.

## O palco não reinicia o encoder por alguns pixels

Arrastar a borda da janela mudava a largura do palco a cada quadro, e cada
largura nova era um encoder novo: 8 reinícios numa sessão, a ~450 ms sem imagem
cada. O limite em vigor só muda quando o palco sai de uma faixa em volta dele,
6% pra cima (acima disso a imagem esticaria de forma visível) ou 25% pra baixo
(abaixo disso os bytes economizados pagam o reinício). Dentro da faixa, o palco
novo pega carona no próximo reinício, qualquer que seja o motivo dele.

## Qualidade constante com teto de pico

O degrau da escada não é mais um alvo de tamanho, é um **teto de pico**. O
encoder gasta o que a imagem precisa e para aí, em vez de encher o bitrate
contratado com dados que ninguém pediu. Quem mais ganha é o keyframe, que era o
quadro mais sacrificado pelo CBR e é exatamente o que aparece depois de cada
reinício.

Medido num monitor 1080p real, h264, 30 fps, keyint 2 s:

| Teto | CBR (como era) | Qualidade constante |
| --- | --- | --- |
| 600 | 0,49 Mbps, keyframe 39 KB | 0,38 Mbps, keyframe 41 KB |
| 1600 | 1,14 Mbps, keyframe 88 KB | 1,11 Mbps, keyframe 87 KB |
| 2500 | 1,43 Mbps, keyframe 115 KB | 1,10 Mbps, keyframe 131 KB |
| 6000 | 2,84 Mbps, keyframe 201 KB | 1,13 Mbps, keyframe 201 KB |

Abaixo de 1600 o teto é o que aperta e os dois dão no mesmo, então link ruim não
regride. No degrau de 6000 é o mesmo keyframe por 60% menos banda, e é por isso
que os degraus do topo deixaram de ser desperdício: em CBR o degrau de 14 Mbps
queimava 8,27 Mbps numa tela parada sem entregar nada.

As chaves são do encoder, não do `gpu-screen-recorder`, e mudam com o
fornecedor: NVENC quer `rc=vbr;cq=…` e exige `b=0`, VAAPI quer
`rc_mode=QVBR;qp=…` e recusa `b=0`. `ICQ` e `AVBR` nem abrem o codec. Quem
decide é o `vendor` que o próprio `gpu-screen-recorder --info` relata,
perguntado uma vez por processo; fornecedor sem receita continua em CBR.

Uma chave errada não deixa a imagem pior, impede o encoder de abrir
(`Could not open video codec: Invalid argument`) e a sessão não mostraria nada.
Por isso, um run que morre em menos de 4 s sem um único quadro desliga a
qualidade constante para o resto da sessão e segue em CBR: keyframe mais mole é
melhor que tela preta.

## Por que um quadro é descartado

O servidor joga um delta fora quando o socket tem bytes demais esperando, e um
delta descartado quebra todos os quadros até o keyframe seguinte, que fora da
LAN custa um encoder novo. O teto segue a capacidade que o link provou carregar,
não o bitrate do encoder: num link de 28 Mbps carregando 2 Mbps, 100 ms do
encoder eram 31 KB, e um pico de jitter de 100 ms descartava o quadro com o link
inteiro livre. Sem medida de capacidade o teto é o piso de sempre, 128 KB.

O fechamento da sessão agora diz quantos quadros foram descartados, por quê e
quanto o socket tinha no momento do corte, contra o teto que valia:

```
drops 131 (over_ceiling 120, wait_key 11), socket p50 180 KB p95 480 KB of 128 KB
```

Isso separa duas coisas que a contagem de reinícios mostrava igual: um link que
travou de verdade (socket bem acima do teto) e um teto baixo demais (socket
raspando o teto com o link folgado). Numa sessão, 131 dos 176 reinícios eram
keyframes pedidos depois de um descarte, e o journal não dizia nada sobre eles.

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

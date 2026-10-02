# Onde o rd ainda tem folga

Medições de 2026-10-02 entre o notebook e o `lol`, pelo Tailscale. Tudo aqui foi
medido, não estimado. A cena de referência dos testes de codec é a mesma do modo
lab (fundo real de desktop, terminal rolando a 420 px/s, cursor em movimento),
3440x1440 a 30 fps, e nenhum teste capturou tela de ninguém.

## O link não é o gargalo

| O que | Medido |
| --- | --- |
| Banda `lol` → notebook | **27,9 Mbps** (21,4 a 34,7 por segundo) |
| Perda de pacote | **0%** em 60 pings |
| Round trip | min 14,4 ms, média 32,9 ms, pico 101,9 ms, mdev 16,8 ms |
| Rota | `186.204.63.39:14783`, IP público |

As duas máquinas não estão na mesma rede: o notebook fica em `10.0.40.16/24`
(wifi) e o `lol` em `192.168.0.38/24` (cabo). O Tailscale abre rota direta, mas
pela internet, nunca pela LAN. Daí os 14 ms de piso, que já colocam toda sessão
em modo WAN (`LAN_RTT_MS` é 15).

O teto da escada é 6 Mbps no degrau 5 e 2,5 Mbps no degrau de abertura. Com 28
Mbps de link, uma sessão usa entre 9% e 21% do que existe. Nenhuma sessão real
passou de 2 Mbps.

O que o link tem de ruim é jitter, não banda: a média é o dobro do piso e o pico
é 7x. Com 0% de perda, trocar TCP por QUIC ou WebRTC não compra nada aqui, o
problema não é retransmissão.

## CBR é a escolha errada

`-bm cbr` pede tamanho constante. Numa tela de desktop isso gasta bits onde não
precisa e racionaliza o keyframe, que é justamente o primeiro frame que aparece
depois de cada reinício do encoder.

SSIM do primeiro frame comparado com o regime, H.264 NVENC na mesma cena:

| Configuração | Banda | Keyframe | SSIM do 1º frame | SSIM em regime |
| --- | --- | --- | --- | --- |
| `cbr 2500` (degrau 3, a abertura de hoje) | 2,38 Mbps | 15 KB | **0,959** | 0,9979 |
| `cbr 6000` (degrau 5) | 5,60 Mbps | 26 KB | 0,986 | 0,9991 |
| `vbr 2500` pico 10M | 2,18 Mbps | 20 KB | 0,975 | 0,9976 |
| **`cq 23` teto 12M** | **1,02 Mbps** | 40 KB | **0,992** | 0,9980 |

Qualidade constante com teto de pico ganha nas duas pontas: menos da metade da
banda e um keyframe muito melhor. Não há troca a fazer, é ganho puro.

O `gpu-screen-recorder` não expõe essa combinação. `-bm cbr` tem controle de
taxa mas não de qualidade; `-bm qp` tem qualidade mas nenhum teto de banda, e o
`-q` dele é preset (`medium`…`ultra`), não número. A ferramenta não tem capped CQ.

Outra pista de que CBR desperdiça: `stripFiller` existe em `backend/rd-capture.mjs`
para jogar fora o NAL tipo 12 que o NVENC gera só para encher o bitrate contratado.

## Codec: AV1 entra, HEVC não

Mesma cena, mesma qualidade alvo, qualidade constante com teto de 12 Mbps:

| Codec | Banda | Keyframe | SSIM 1º frame | SSIM regime | Encode |
| --- | --- | --- | --- | --- | --- |
| h264 cq23 | 1,02 Mbps | 40 KB | 0,992 | 0,9980 | 161 fps |
| hevc cq25 | 1,07 Mbps | 42 KB | 0,992 | 0,9980 | 133 fps |
| **av1 cq30** | **0,85 Mbps** | 36 KB | 0,991 | 0,9981 | 184 fps |

No mesmo bitrate pedido em CBR, o HEVC é o mais eficiente de longe: pedindo
12000 kbps ele usou 2,80 Mbps e deu SSIM 0,999373, melhor que H.264 gastando
11,52 Mbps (0,999350). Quase 4x menos bits pela mesma imagem.

Só que **o Chromium no Linux não decodifica HEVC em WebCodecs**:
`VideoDecoder.isConfigSupported` responde `false` para `hvc1` e `hev1` em
`prefer-hardware`, `prefer-software` e `no-preference`. AV1 e VP9 respondem
`true`. Então HEVC está fora e AV1 é o caminho: -17% de bits contra H.264 na
mesma qualidade, e encoda mais rápido.

O `lol` tem RTX 4070 Ti SUPER (NVENC Ada): h264, hevc e av1 em hardware. O
notebook tem Radeon 680M (RDNA2), que decodifica AV1 em hardware.

O teste de decode rodou numa bancada Xvnc, sem GPU, por isso `prefer-hardware`
deu `false` até para H.264. Serve para saber qual codec o Chromium aceita, não
se o decode do notebook está em hardware. **Isso continua em aberto** e importa:
decodificar 3440x1440 em software custa CPU do notebook.

## O que custa imagem é o reinício do encoder

Restarts por sessão, do journal do `lol`:

| Sessão | fps | kbps médio | Degrau | Restarts |
| --- | --- | --- | --- | --- |
| 01/10 19:12 (4h45) | 23,2 | 684 | 5 | **176** (key 131, probe 21, up 14, down 6, view 4) |
| 02/10 13:19 | 16,3 | 265 | 0 | 34 (key 16, view 8, up 3, down 3, probe 2) |
| 02/10 12:47 | 20,6 | 1016 | 0 | 53 (key 13, wan 1) |
| 02/10 13:35 | 20,1 | 514 | 3 | 23 (view 8, key 7, probe 3) |

A ~450 ms cada, 176 restarts são 79 s sem imagem, 0,5% de uma sessão de 4h45.
O tempo parado não é o pior: cada reinício recomeça num keyframe de 15 KB com
SSIM 0,959, ou seja **a imagem borra de novo a cada restart**.

Nenhuma dessas quatro razões precisaria de um processo novo:

- `key` (131, a maioria): a página perdeu um delta e pediu keyframe. O NVENC
  força um IDR no frame seguinte de graça.
- `probe` (21): reinicia só para medir capacidade do link.
- `up`/`down` (20): mudança de bitrate.
- `view` (8): a janela mudou de tamanho. `view()` reinicia na hora, sem debounce
  nem histerese; redimensionar a janela com o mouse gera uma rajada.

De onde vem o `key`: `backend/rd.mjs:467` descarta qualquer delta quando
`ws.bufferedAmount` passa de 128 KB, e um delta descartado liga `waitKey`, que
pede keyframe, que reinicia o processo. Os keyframes medidos têm 13–42 KB, bem
abaixo de 128 KB, então não é o keyframe que estoura o buffer: é acúmulo
momentâneo, compatível com os picos de jitter de 102 ms.

A trava é arquitetural, não é descuido: o IPC do `gpu-screen-recorder` (`-ipc`)
só aceita `stop`, `save-replay`, `toggle-pause`, `set-paused` e os comandos de
replay. Não muda bitrate, fps nem resolução, e não força keyframe. Com essa
ferramenta, reiniciar é a única via, exatamente como diz o comentário no topo de
`backend/rd-rate.mjs`.

## O GStreamer já resolve isso, e está instalado

No `lol`, `gst-inspect-1.0` lista `nvh264enc`, `nvh265enc`, `nvav1enc`,
`cudaupload` e `pipewiresrc`. E no `nvh265enc`:

```
bitrate         : changeable in NULL, READY, PAUSED or PLAYING state
max-bitrate     : changeable in NULL, READY, PAUSED or PLAYING state
const-quality   : changeable in NULL, READY, PAUSED or PLAYING state
gop-size        : changeable in NULL, READY, PAUSED or PLAYING state
```

`const-quality` é o capped CQ que mediu melhor, `max-bitrate` é o teto de pico,
e os dois mudam com o pipeline rodando. Keyframe sob demanda é o evento padrão
`GstForceKeyUnit`, sem reinício. Ou seja: o degrau da escada deixa de ser um
processo novo e passa a ser um `g_object_set`, e os 176 restarts viram zero.

## Rust paga onde?

O relay em Node **não** é o gargalo. O journal mede `pes→send p50` entre 0,03 e
0,12 ms em toda sessão: o servidor repassa bytes em microssegundos. Reescrever o
transporte em Rust ganharia nada mensurável.

Onde código nativo pagaria é no lugar do `gpu-screen-recorder`: um daemon que
captura dmabuf do Wayland, alimenta o NVENC e aceita comandos de bitrate,
qualidade, resolução e keyframe sem morrer. Só que o GStreamer entrega isso sem
escrever uma linha de Rust, com os plugins já instalados.

Rust ficaria valendo a pena numa fase seguinte, para o que o GStreamer não dá:
mapa de QP por macrobloco (`NV_ENC_PIC_PARAMS`), que é dar mais bits para a
região com texto e menos para o resto. Aí sim "transmitir os dados corretos" vira
literal. Antes disso, é esforço grande para ganho que o capped CQ já captura.

## O que já foi feito (2026-10-02)

- **Dois degraus no topo da escada**, 9 e 14 Mbps. A escada parava em 6 num link
  de 28. Em CBR o keyframe melhora junto com o bitrate, e é ele que aparece
  depois de cada reinício.
- **Histerese no palco.** O limite só muda quando o palco sai de uma faixa em
  volta dele (6% pra cima, 25% pra baixo). Mata os 8 reinícios de `view` por
  sessão; dentro da faixa o palco novo pega carona no próximo reinício.
- **Teto do socket pela capacidade medida do link**, não pelo bitrate do
  encoder. Quando existe medida, um link folgado segura um pico de jitter em vez
  de jogar o quadro fora. Sem medida, continua o piso de 128 KB de sempre.
- **Os descartes passaram a aparecer no journal**: quantos, por qual motivo e
  quanto o socket tinha contra o teto em vigor.

Um limite que apareceu medindo: **uma rajada de keyframe não mede capacidade
além dos próprios bytes sobre o piso de 50 ms do ack**. Um keyframe de 110 KB
mede no máximo ~17 Mbps, e um de 15 KB (o que o CBR faz a 2500 kbps num monitor
largo) fica abaixo do limiar de 20 KB e não gera amostra nenhuma. Por isso a
abertura rápida não alcançava os degraus novos e a subida real era de um degrau
por minuto.

Eu escrevi aqui que "medir banda sem encher o link não dá". Isso está errado, e
é exatamente o problema que o WebRTC resolve há dez anos: não se mede a banda,
mede-se o **gradiente do atraso de ida**. Enquanto o link dá conta, o intervalo
entre chegadas acompanha o intervalo entre envios por mais rápido que se mande;
quando não dá, começa a formar fila e os dois descolam, antes de qualquer perda.
Implementado em `backend/rd-bwe.mjs` (ver `docs/rd-control.md`), sem trocar o
transporte: o ack passou a levar a hora de chegada e o resto é aritmética. O
estimador mede bem isolado, mas está **desligado por padrão**, porque medir a
capacidade do link não adianta enquanto a escada continuar escolhendo degrau
pela taxa que o encoder produziu. Ver a seção em `docs/rd-control.md`.

Isso também explica a degradação que ficava: pedidos repetidos de keyframe
derrubam a escada (`KEYS_PER_MINUTE`, 3 por minuto, desce um degrau), porque a
regra presume que o link não aguenta. Numa sessão com 60 ms de round trip isso
levou até W0, 265 kbps, com o link carregando 28 Mbps. Para corrigir essa regra
falta saber se o socket estava cheio ou vazio na hora do descarte, que é
exatamente o dado que a instrumentação nova passou a registrar. Sem ele, mexer
na regra é apostar.

## O gargalo que apareceu: taxa entregue não é capacidade

É o item que agora vale mais que todos os abaixo, e ele nasceu do próprio
alpha.47. Com CBR, o encoder enchia o degrau, então `deliveredKbps` era um bom
retrato do que o link carregava e a escada podia escolher degrau por ele. Com
qualidade constante e teto de pico, o degrau virou teto: a cena decide a taxa.
Uma tela parada entrega 130 kbps com o teto em 600 ou em 14000.

A escada inteira ainda trata a taxa entregue como capacidade (`fitting`). Medido
no link real: sessão no degrau 0 em `shed`, sem mandar nada, com o link
carregando 28 Mbps. Isso acontece independente do gradiente; o gradiente só
chega lá mais rápido.

O conserto é distinguir "o encoder não produziu" de "o link não deu conta". O
discriminador é a fila: a taxa entregue só mede o link quando havia fila. Está
em aberto.

## O que ficou de fora, e por quê

- **Pipeline GStreamer** (capped CQ, bitrate e keyframe ao vivo): o único
  elemento de captura disponível é `pipewiresrc`, que precisa de uma sessão
  ScreenCast do portal. A primeira abre um seletor de tela que só o dono pode
  aprovar; depois dela o `restore_token` dispensa o diálogo. É o item de maior
  retorno e está parado nessa autorização.
- **AV1**: ganho de 17% nos bits, mas o demuxer de TS e o `parseSps` de
  `backend/rd-capture.mjs` são de H.264 (NAL, SPS, `avc1.*`); AV1 é OBU e
  `av01.*`, outro tipo de stream no PMT. É reescrita de verdade, e antes dela
  importa saber se o Chrome do notebook decodifica em hardware: AV1 3440x1440
  em software é pior que H.264 em hardware.
- **Buffer de jitter no cliente**: troca latência por cadência. A latência hoje
  é 14 ms e o jitter tem mdev de 16 ms com pico raro de 102. Em controle remoto
  a latência de entrada é mais perceptível que o jitter de vídeo, então o custo
  não se paga.

## Ordem que compensa

1. **Capped CQ em vez de CBR.** Metade da banda, keyframe de 0,959 para 0,992.
   Precisa de encoder controlável, então vem junto com o item 2.
2. **Trocar `gpu-screen-recorder` por pipeline GStreamer** com bitrate,
   qualidade e keyframe ao vivo. Mata os 176 restarts e o borrão que vem depois
   de cada um. É a mudança de maior retorno e a mais trabalhosa.
3. **Debounce e histerese no `view`.** Oito restarts por sessão que somem com
   algumas linhas, independente de tudo acima.
4. **AV1.** -17% de bits, decode em hardware nas duas pontas, de graça depois do item 2.
5. **Buffer de jitter no cliente.** O link tem 0% de perda e jitter de 14/33/102
   ms. Guardar um frame antes de apresentar troca um pouco de latência por
   cadência regular. Hoje a latência é 14 ms, tem margem.
6. **`-fm vfr`.** O rd força `cfr`; o default da ferramenta é `vfr`. Ganho pequeno
   em banda (frames repetidos de tela parada custam centenas de bytes), mas tira
   trabalho do encoder. `-fm content` não serve: só existe em X11 ou portal, e a
   captura aqui é KMS.

O que **não** compensa é o **transporte** do WebRTC: QUIC, WebTransport ou UDP
no lugar do WebSocket. O link não perde pacote (0% medido), e o servidor já
descarta frame velho por conta própria (`shed` e `drop`). O que UDP compraria é
o fim do bloqueio de cabeça de fila do TCP, que importa num 4G instável e quase
nada neste link. E subir o teto da escada para perto dos 28 Mbps também não:
com capped CQ a cena fica em 1 Mbps, a banda deixa de ser o limite.

O **algoritmo** do WebRTC, esse compensou, e era a parte que faltava: o controle
de congestionamento por gradiente de atraso não depende de UDP nenhum, só de
saber a hora em que cada quadro chegou. Vale separar as duas coisas, porque
misturá-las foi o que me fez descartar o WebRTC inteiro de uma vez.

## O que o Chrome Remote Desktop faz diferente

Comparação feita a pedido, pra saber o que ainda dá pra puxar de lá.

| | Chrome Remote Desktop | Ponte hoje |
| --- | --- | --- |
| Transporte | WebRTC sobre UDP, SRTP | WebSocket sobre TCP |
| Medir capacidade | gradiente de atraso, feedback por pacote | gradiente de atraso, feedback por ack (50 ms) |
| Mudar bitrate | contínuo, sem reiniciar o encoder | degrau da escada, ~450 ms sem imagem |
| Perda | NACK e retransmissão | TCP retransmite, com bloqueio de cabeça de fila |
| O que manda | só a região que mudou (damage region) | o quadro inteiro, delta do H.264 resolve |
| Resolução | muda a resolução da tela remota pra casar com a janela | escala a imagem, com piso de legibilidade |
| Encoder | VP8/VP9, historicamente em software | H.264 em NVENC/VAAPI |

O que vale puxar, em ordem:

1. **Damage region.** Tela de desktop é quase toda estática. O `gpu-screen-recorder` já tem noção de damage, mas `-fm content` só existe em X11 ou portal e aqui a captura é KMS. O caminho possível é `-fm vfr` (item 6 acima).
2. **Bitrate ao vivo.** É o item 2 da ordem acima, barrado na autorização do portal.
3. **UDP.** Ganho real só em link ruim de verdade. Exigiria escrever o pacing e o controle de congestionamento do lado do servidor, que é a parte difícil, ou trazer uma dependência nativa (o Ponte tem zero dependência npm hoje).

O que **não** serve: mudar a resolução da tela remota. O CRD assume que ninguém está sentado na máquina remota; aqui o Lucas usa o PC presencialmente, e trocar a resolução do monitor dele no meio do trabalho é invasivo. O piso de legibilidade é o substituto.

## Em aberto

- **`fitting` escolhe degrau pela taxa entregue**, que desde o capped CQ é a taxa
  da cena, não a do link. É o que trava o gradiente, e trava sozinho também.
- O Chrome do notebook decodifica H.264 3440x1440 em hardware ou software? Se for
  software, é gargalo de fluidez no lado de quem assiste. Só dá para medir no
  Chrome real, em `chrome://media-internals` com uma sessão aberta.
- `focusedmon` trocando o monitor exibido de ponta a ponta continua sem
  confirmação em aparelho real.

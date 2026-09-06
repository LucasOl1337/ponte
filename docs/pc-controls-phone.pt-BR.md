# PC controla o celular (vice-versa)

Situação: o CLI do caminho A está implementado (`ponte phone`). Os caminhos B e
C continuam especificação. Este documento descreve como o PC controla o celular
Android já pareado pela mesma rede Tailscale, espelhando o que o Ponte faz hoje
na direção contrária.

## Objetivo

Um companheiro do Ponte no PC: a partir do desktop Omarchy, ver a tela do
celular pareado e operá-lo (tocar, digitar, voltar, responder uma notificação)
sem pegar o celular na mão. Mesmo modelo de confiança de hoje: rede Tailscale
privada, pareamento explícito, sem serviço de nuvem, sem analytics.

Fora do escopo: controlar celular nunca pareado, controlar iOS, acesso remoto
pela internet pública e qualquer recurso que exija conta Google ou relay de
terceiros na nuvem.

## Como o Ponte funciona hoje (base para reaproveitar)

- O pareamento é um token aleatório de 32 a 128 caracteres base64url guardado
  fora do repositório (`$XDG_STATE_HOME/ponte/`, `docs/setup.md:33-40`). Toda
  chamada `/api/` precisa apresentá-lo como token `Bearer`, comparado em tempo
  constante (`server.mjs:205`). O app Android guarda sua cópia no storage
  privado da WebView e consome um extra de intent `pair_token` de uso único
  (`MainActivity.java:54-68,165-167`).
- O transporte são dois listeners no PC: HTTP simples no loopback
  `127.0.0.1:8787` e HTTPS com certificado dedicado no IPv4 Tailscale do PC
  (`server.mjs:267-280,325-338`; o bind precisa estar em `100.64.0.0/10`,
  `backend/config.mjs:6-10,45-54`). O app fixa (pin) o certificado folha exato
  do servidor, não a CA, e recusa redirects (`android/README.md:49-53`).
- O app nunca fala com o PC diretamente. Um proxy nativo de loopback em
  `http://127.0.0.1:18987` encaminha uma lista fechada de métodos e caminhos
  (`MainActivity.java:44,156`, `LoopbackProxy.java:13` e sua lista de
  caminhos). Não há ponte JavaScript, navegação externa nem backup da WebView
  (`android/README.md:55-63`).
- A API do PC é uma lista explícita e pequena: `health`, `state`, `action`,
  `screenshot`, `stream` (MJPEG autenticado, máximo 10 fps), `audio` e, neste
  branch, `terminals` (`server.mjs:202-244`). Os efeitos no desktop rodam via
  subprocessos limitados: `hyprctl`, `ydotool`/`ydotoold`, `wtype`, `grim`,
  `wpctl`, `ffmpeg`/`ffprobe` e `ffplay` (`docs/setup.md:9-21`,
  `backend/desktop.mjs`).
- O APK declara só `INTERNET`, `RECORD_AUDIO` e `MODIFY_AUDIO_SETTINGS`
  (`android/AndroidManifest.xml:4-6`).

## Caminho A — scrcpy / ADB sem fio via Tailscale

Rodar a ferramenta aberta padrão de espelhamento sobre a tailnet existente: o
PC roda `adb` + `scrcpy`, o celular expõe a depuração sem fio, e vídeo/entrada
trafegam por TCP até o IPv4 Tailscale estável do celular. Nenhuma mudança no APK.

Prós:

- Controle total no primeiro dia: tela ao vivo, toques, digitação, voltar/início,
  clipboard e (Android 11+) encaminhamento de áudio, tudo mantido pelo scrcpy.
- Zero permissões novas no Android e zero gasto de bateria em repouso: nada novo
  roda no celular; o APK atual do Ponte não muda.
- Totalmente reversível: desligar a depuração sem fio e o caminho some.

Contras:

- Exige Opções do desenvolvedor e depuração sem fio no celular pessoal, além de
  um `adb pair` manual; a porta de depuração pode mudar e precisa ser digitada
  de novo.
- ADB é um shell completo, bem mais amplo que a lista explícita de ações do
  Ponte: com a conta do PC comprometida, o celular fica totalmente exposto
  enquanto a depuração estiver ligada.
- Dependências extras no PC (`android-tools`, `scrcpy`) e carga de encode
  H.264/H.265 no celular durante o espelhamento.

Permissões Android necessárias: nenhuma no manifest. No aparelho: ativar Opções
do desenvolvedor, ligar Depuração sem fio, parear com o código. A sessão de
depuração precisa ficar ligada durante todo o controle.

O que reaproveita: a identidade Tailscale e o conceito de `trustedHosts`
(`backend/config.mjs`, `server.mjs:62-83`); os padrões de setup/install/pair do
CLI `ponte` (`ponte`, `docs/setup.md:46-59`); o visualizador MJPEG e os perfis
de live de `public/` como referência para embutir a janela do scrcpy; a
disciplina de testes com adaptador sintético para qualquer wrapper (`tests/`,
`CONTRIBUTING.md`).

## Caminho B — serviço de acessibilidade dentro do app Ponte + API HTTP no aparelho

Estender o app Ponte com um serviço de acessibilidade e um pequeno servidor
HTTP no celular espelhando o formato da API do PC (`/api/phone/state`,
`/api/phone/action`, quadros de tela). O PC vira cliente; o celular o autentica
com o mesmo token de pareamento via tailnet.

Prós:

- Coerente com o produto: um pareamento, um modelo de confiança, sem Opções do
  desenvolvedor, usando o APK em que o usuário já confia.
- Ações delimitadas: a API expõe exatamente o que o Ponte permite (tocar,
  arrastar, digitar, voltar, abrir app), ao contrário do shell total do ADB.
- Reaproveita autenticação, pinning e padrões de UI do Ponte quase um a um.

Contras:

- Maior construção: serviço foreground com notificação persistente, servidor TLS
  no aparelho, captura por `MediaProjection`, ações em nós de acessibilidade,
  tudo com casos de borda de ciclo de vida como os do microfone em
  `MainActivity.java:125-141`.
- Acesso de acessibilidade é uma concessão sensível; usuários e revisores
  examinam com razão, e o serviço gasta bateria rodando.
- A captura de tela exige consentimento de `MediaProjection` a cada início, e
  inícios em background são restritos no Android recente.

Permissões Android necessárias: `BIND_ACCESSIBILITY_SERVICE` (declaração do
serviço + ativação pelo usuário nos Ajustes), `FOREGROUND_SERVICE` +
`POST_NOTIFICATIONS` em runtime para o serviço persistente, consentimento de
projeção de mídia em runtime para os quadros. `INTERNET` já existe; o servidor
no aparelho não precisa de permissão nova de manifest, mas precisa do serviço
foreground vivo, o que pede ao usuário tirar o Ponte da otimização de bateria.

O que reaproveita: auth por token `Bearer`, guarda de requisições, rate limits
e tetos de corpo (`server.mjs:61-135,199-214`); o contrato de config
`schemaVersion: 1` (`backend/config.mjs`, `ponte`); pinning de folha exata
invertido (o celular apresenta cert fixado, modelo em
`LoopbackProxy.java:61-72`); os padrões de permissão/ciclo de vida da Activity
(`MainActivity.java`); o live-view e o UX de ações de `public/`.

## Caminho C — só espelhamento de notificações / clipboard

Sem tela, sem toques. O app encaminha notificações (e opcionalmente clipboard)
ao PC pelo canal TLS existente; o PC mostra e oferece as poucas ações remotas
que o Android permite (responder notificação, marcar como lida).

Prós:

- Menor mudança e menor risco: duas APIs conhecidas, sem depuração, sem
  acessibilidade, sem encode de vídeo.
- Barato o bastante para ficar sempre ligado, ao contrário do vídeo.

Contras:

- Não é controlar o celular: não toca, não digita, não navega nem mostra a
  tela, então não cumpre o objetivo sozinho.
- Acesso a notificações expõe conteúdo de mensagens ao processo do PC; sync de
  clipboard pode vazar senhas se não for delimitado e registrado com cuidado.

Permissões Android necessárias: `BIND_NOTIFICATION_LISTENER_SERVICE` (ativação
pelo usuário nos Ajustes) para notificações; acesso ao clipboard no serviço
foreground para o sync. Nada perigoso novo no manifest além da declaração do
listener.

O que reaproveita: o padrão de upload autenticado por TLS (`/api/audio` POST,
`server.mjs:239-243`); token de pareamento e pinning sem mudar; o formato de
agregação do `getState` para um payload de `phone-state` (`server.mjs:205-207`,
`backend/desktop.mjs:74-101`).

## Comparação

|  | A: scrcpy/ADB | B: serviço no app | C: só notificações |
| --- | --- | --- | --- |
| Tela + entrada total | sim | sim | não |
| Mudança no APK | nenhuma | grande | pequena |
| Concessão no aparelho | depuração sem fio | acessibilidade + projeção | acesso a notificações |
| Amplitude do privilégio | shell total (amplo) | ações delimitadas (estreito) | leitura + respostas (mínimo) |
| Bateria em repouso | zero | custo do serviço | desprezível |
| Tempo até a primeira demo | uma noite | semanas | dias |

## Recomendação

Adotar o **caminho A (scrcpy / ADB sem fio via Tailscale)** como caminho oficial.

É o único que entrega o objetivo — ver e operar o celular a partir do PC — sem
mudar o APK publicado, sem pedir permissões novas e sem gastar bateria parado.
O celular mantém exatamente a superfície de ataque de hoje, e tudo se reverte
nos Ajustes do aparelho. O caminho B é o produto ideal se o Lucas quiser um dia
controlar sem modo desenvolvedor, e o C é um complemento sempre-ligado útil,
mas nenhum dos dois deve travar a primeira versão funcionando.

## Controlar o celular a partir do PC

Este é o caminho A na prática. O PC fala com o Redmi (`redmi-note-13-pro-5g-1`)
no IPv4 Tailscale `100.111.221.82`. Depois de uma sessão de depuração sem fio
bem-sucedida, o Android costuma escutar na porta **5555**, que é o padrão do
Ponte. A porta de pareamento (já vimos 33841 e 44875) só entra quando o celular
mostra um código.

ADB é um shell completo. Deixe a depuração sem fio desligada quando não estiver
usando.

### Uma vez no celular

1. Ative as Opções do desenvolvedor (toque sete vezes em Número da compilação).
2. Ligue **Depuração sem fio**.
3. Mantenha a Tailscale conectada no celular.

Se o PC ainda não foi aceito, abra Depuração sem fio → **Parear dispositivo com
código de pareamento**. Anote o IP:porta de pareamento e o código de 6 dígitos.

### No PC

```sh
./ponte phone status
```

Confere se `adb` e `scrcpy` estão instalados, se `100.111.221.82` está online na
tailnet, e se o ADB já lista o celular como `device`.

Se o status pedir código de pareamento:

```sh
./ponte phone pair 100.111.221.82:37123 123456
```

Use o IP:porta de pareamento e o código do celular, não a 5555.

Conectar (o padrão é `100.111.221.82:5555`, ou o último endereço salvo):

```sh
./ponte phone connect
./ponte phone connect 100.111.221.82:5555
```

Abrir a janela do scrcpy (título `Ponte`, tela acordada, H.264, sem áudio).
`--screen-off` apaga a tela do celular enquanto você usa o PC:

```sh
./ponte phone view
./ponte phone view --screen-off
```

Quando a porta de depuração mudar, o `connect` falha em vez de travar. Leia a
porta nova no celular e rode `./ponte phone connect IP:PORTA` de novo. Feche a
janela do scrcpy para encerrar. Desligue a depuração sem fio para cortar o
acesso.

Se o `status` disser que falta ferramenta neste Omarchy: `pacman -S android-tools scrcpy`.

## Primeira fatia mínima

Um wrapper `ponte phone` no CLI mais docs, sem mudar APK nem servidor:

1. `ponte phone --check` confere `adb` e `scrcpy` instalados e imprime os passos
   exatos no celular (Opções do desenvolvedor, Depuração sem fio, código de
   pareamento, Tailscale ligada).
2. `ponte phone` conecta o `adb` ao IPv4 Tailscale do celular e porta, e abre o
   `scrcpy` com padrão sensato (codec H.264, sem áudio até o usuário pedir,
   janela com o nome do celular).
3. `docs/` ganha um guia de uma página: ativar, parear, conectar, desconectar e
   o que fazer quando a porta de depuração trocar.

Aceite: no Redmi Note 13 Pro+ (Android 14) via Tailscale, o Lucas abre a janela
do celular pelo PC, toca, digita uma frase num app, volta e encerra a sessão;
desligar a depuração sem fio corta todo o acesso. Validação é teste em aparelho
real mais `npm test` verde; o wrapper em si é testado com `adb`/`scrcpy` falsos
no PATH, seguindo a regra do adaptador sintético (`CONTRIBUTING.md:5-7`).

## Riscos

- Alcance da depuração sem fio pela interface Tailscale não verificado no
  Redmi; o Android pode prendê-la só ao Wi-Fi.
- A porta de depuração pode trocar e quebrar reconexões até o usuário ler a
  porta nova; o wrapper precisa mostrar isso em vez de falhar em silêncio.
- ADB dá shell total, então esse caminho nunca deve ficar ligado sem supervisão
  e precisa estar documentado como mais forte que a lista normal de ações.
- O encode de vídeo esquenta o celular e gasta bateria; padrão com bitrate
  modesto, usuário aumenta se quiser.
- Versões de `scrcpy` e `adb` variam por distro; fixar as versões testadas no
  guia depois de medir.

## Decisões só do Lucas

- Ativar Opções do desenvolvedor e depuração sem fio no celular pessoal (sim/não).
- Aceitar acesso nível ADB para controlar o celular, ou exigir só ações
  delimitadas (o que apontaria para o caminho B).
- Se o IPv4 Tailscale do celular pode ser usado para ADB, ou se o controle tem
  que ser só no Wi-Fi de casa.
- Se o controle pode rodar com a tela do PC bloqueada, e se precisa parar
  quando o PC dorme.
- Se quer buscar o caminho B depois (sem modo dev) e/ou o C (notificações
  sempre ligadas) após o A funcionar.

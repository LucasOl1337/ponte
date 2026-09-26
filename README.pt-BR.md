# ponte.

![Arte conceitual do Ponte](docs/assets/hero.png)

Seu Omarchy pelo celular. A tela do PC na mão, com toque, voz, janelas, luzes e energia pela Tailscale.

[English](README.md) · [Evidências reais](docs/evidence.md) · [Apresentação](docs/presentation.pdf)

A versão global abre em inglês. Escolha PT no seletor do app para usar português; a preferência fica salva. A página do projeto também oferece os dois idiomas.

O Ponte nasceu da vontade de abrir um app no celular e continuar usando o PC. A interface tem controles grandes para mover o mouse, escrever, escolher uma janela e acompanhar um monitor ao vivo.

É uma versão **alfa experimental e independente do Omarchy**. O acesso e a imagem ao vivo foram testados em um Redmi Note 13 Pro+ com Android 14. O pareamento permaneceu salvo depois de fechar o app à força e abrir novamente pelo ícone. O teste final de gravação no Android ainda está pendente.

<p align="center"><img src="docs/assets/screen-single-mode.png" width="23%" alt="Tela: o monitor ocupa o celular, com os botões de trocar monitor, girar e mic acima da navegação"> <img src="docs/assets/screen-keyboard.png" width="23%" alt="Tela com o teclado do Android aberto depois de tocar num campo de texto no PC"> <img src="docs/assets/home-lights-session.png" width="23%" alt="Início: monitores, presets RGB, bloquear, suspender e reiniciar"> <img src="docs/assets/terminal-dictation.png" width="23%" alt="Terminais com o botão Falar no terminal e Executar com Enter"></p>

<p align="center"><img src="docs/assets/screen-landscape.png" width="72%" alt="Paisagem forçada: o monitor de ponta a ponta com os botões flutuantes à direita"></p>

Capturas do emulador (Android 11) da interface atual; o desktop transmitido aparece pixelado porque é uma sessão de trabalho real.

A Tela é um modo só: o monitor ocupa o celular e você toca nele como num celular. Toque clica; arrastar em 1× segura o botão esquerdo como um mouse, permitindo selecionar texto, mover sliders e arrastar itens; toque longo e solta é botão direito; toque longo e arrasta abre a prateleira de workspaces; pinça amplia; um dedo navega com zoom; dois dedos rolam. Solte numa área da prateleira para levar exatamente aquela janela ao workspace, sem trocar a área que você está vendo. Tocou num campo de texto no PC, o teclado do Android sobe sozinho e o que você digita vai ao vivo (o Ponte descobre o foco pelo fcitx5). O zoom é uma transformação contínua no celular, como no Chrome Remote Desktop: nunca recorta o stream no meio da pinça, e o perfil Nítido fica cravado até 1:1. Três botões flutuam ao lado da navegação: trocar de monitor, forçar paisagem de ponta a ponta e ditar. Veja o [guia de tela e terminais](docs/screen-and-terminals.md) e o [changelog](CHANGELOG.md).

Para ver e controlar o celular a partir deste PC pela Tailscale: `./ponte phone status`, depois `./ponte phone connect` (padrão `100.111.221.82:5555`) e `./ponte phone view`. Passo a passo: [PC controla o celular](docs/pc-controls-phone.pt-BR.md).

## Instalação

No PC, você precisa de Omarchy/Hyprland ativo, Node.js 22+, Python 3.12+, OpenSSL 3 e Tailscale conectada. No celular, Android 8+ e Tailscale na mesma rede privada. Os recursos do desktop usam `hyprctl`, `ydotool`, `wtype`, `grim`, `wpctl`, `ffmpeg` e `ffplay`. As sessões de texto também precisam de `tmux`.

```sh
git clone https://github.com/LucasOl1337/ponte.git
cd ponte
./ponte setup
./ponte install
./android/build.sh
```

Transfira `.work/Ponte.apk` para seu celular e instale. Abra o app e faça o pareamento uma vez com a chave exibida por `./ponte pair`. Depois, o app lembra o acesso. Coloque o ícone na primeira tela para abrir com facilidade.

Cada instalação gera configuração e uma CA próprias. O APK é personalizado para seu PC (pina a CA da instalação; o certificado do servidor pode ser renovado com `./ponte renew-cert` sem gerar app novo) e deve ficar privado. `./ponte doctor` confere PC, Tailscale, serviço, pareamento e APK de uma vez. O processo inicial ainda exige compilação e pareamento manual, que pretendemos simplificar.

## O que já está disponível

- A tela do PC abre primeiro, num modo só: toque, toque longo, arraste, pinça, dois dedos. Teclado do celular sobe ao tocar num campo de texto no PC.
- Ditado por voz: no terminal ("Falar no terminal", com Enter automático) e na tela (mic flutuante, digita no campo focado e dá Enter). Transcrição no PC pelo Sussurro ou por um endpoint compatível com OpenAI; o áudio não fica salvo.
- Terminais de texto com sessões próprias, edição com setas e Enter separado. A mesma sessão pode ser aberta no PC.
- Lista de janelas e troca de áreas de trabalho. Volume e controles de mídia.
- Energia: cada monitor ou todos on/off, Dormir inteligente e Acordar, suspender, reiniciar, desligar com confirmação dupla, estado do Wake-on-LAN.
- Luzes RGB pelo Magma: seis presets, apagar e restaurar, telinha do water cooler.
- Sessão: bloquear e desbloquear digitando a senha pelo app (só com a tela de bloqueio do Omarchy ativa; a senha não fica no celular).
- `./ponte pc …` pra fazer tudo isso por SSH na Tailscale, sem o app.
- Interface para gravar, revisar e enviar áudio ao PC.

## Gerenciamento de energia e dormir inteligente

O Ponte inclui controles de energia no painel inicial do celular:

- **Controle individual de telas:** Ligue ou desligue cada monitor separadamente, ou todos de uma vez. No Hyprland atual o dispatcher `dpms` só alterna, então o Ponte lê o `dpmsStatus` e alterna apenas quando o monitor não está no estado pedido; o resultado é determinístico.
- **Superbotão "Dormir inteligente":** Apaga todos os monitores e desliga as luzes RGB via Magma Lights (`controller.py sleep`). **Não é suspensão (suspend) nem desligamento**: o computador continua ligado rodando seus agentes e processos em segundo plano, acessível remotamente pela Tailscale.
- **Superbotão "Acordar":** Acende todos os monitores e restaura a iluminação RGB (`controller.py restore`).
- **Desligar com confirmação dupla:** Desliga o sistema por completo (`systemctl poweroff`), exigindo confirmação na interface para evitar toques acidentais.
- **Wake-on-LAN (WoL) e botão "Ligar PC" no Android:** Com a máquina desligada, o Ponte não roda e a Tailscale desconecta. Para religar o computador remotamente:
  - **No BIOS/UEFI:** Habilite "Power On By PCI-E" (ou "Wake on LAN") nas opções de energia ACPI/APM.
  - **No Linux / NetworkManager:** Habilite com `sudo ethtool -s <iface> wol g`. Para persistir no NetworkManager, use `nmcli connection modify <conexão> 802-3-ethernet.wake-on-lan magic`. Verifique com `ethtool <iface> | grep Wake-on`, que deve exibir `Wake-on: g`.
  - **No app Android:** O app salva o MAC da Ethernet (`wakeOnLan` de `/api/state`) enquanto conectado. Se o PC estiver desligado, a tela de conexão exibe o botão **"Ligar PC"**, que envia 3 Magic Packets via UDP (porta 9) para `255.255.255.255` e o broadcast da sub-rede Wi-Fi local.
  - **Limitação da Tailscale:** O Magic Packet é um broadcast de rede local (camada 2 / UDP broadcast) e **não atravessa a Tailscale** (que opera em camada 3 por roteamento unicast). O celular precisa estar conectado ao Wi-Fi local de casa (na mesma rede que o cabo Ethernet do PC) para acordar a máquina.
- **APK no celular:** O app atualizado (versionCode 8, alpha.5) inclui WoL, energia, luzes, sessão, ditado e a Tela nova. Instale por cima do app atual, com a mesma chave de assinatura.
- **Por SSH:** com a Tailscale SSH ligada no PC, `ssh usuario@<ip-tailscale> ./ponte pc suspend` (ou `lock`, `unlock`, `sleep`, `wake`, `reboot`, `off`, `monitors on|off [nome]`, `lights <preset>`) roda as mesmas ações sem o app.

A imagem usa MJPEG autenticado. O perfil Automático (padrão) começa leve e sobe até o Nítido (pixel nativo, até 15 quadros/s) enquanto os quadros chegam em dia, e recua sozinho quando a conexão atrasa; assim o mesmo app serve no Wi-Fi de casa e no 4G. Dá pra cravar Nítido, Equilibrado ou Leve. Medido num monitor 1440p: Nítido ~49 Mbit/s, Equilibrado ~7, Leve ~2. Não transmite o áudio do sistema.

Leia o [guia de configuração](docs/setup.md), o [guia Android](android/README.md) e o [modelo de segurança](SECURITY.md). Um celular pareado pode operar sua sessão real do PC. A [especificação do caminho inverso](docs/pc-controls-phone.pt-BR.md) avalia operar o celular a partir do PC pela mesma rede Tailscale. Valide as novidades no aparelho com o [roteiro de teste manual](docs/manual-test-checklist.pt-BR.md).

## App de computador: controle o celular pelo PC

`./ponte desktop` abre o app nativo Linux, com conexão e pareamento, seleção
explícita do Android, perfis de qualidade, botões de navegação e screenshot.
A tela ao vivo abre numa janela scrcpy gerenciada pelo Ponte, com mouse e
teclado. Áudio e clipboard automático ficam desligados por padrão.

```sh
./ponte desktop                 # precisa de PySide6, adb e scrcpy
./ponte desktop install         # opcional: atalho no menu de aplicativos
./ponte desktop --demo          # demonstração sintética, sem acessar celular
./ponte desktop schema          # comandos de automação, sem precisar de Qt
```

O celular precisa autorizar o ADB, por USB ou depuração sem fio. Não muda o APK,
não desbloqueia sozinho e não troca para outro aparelho quando o alvo cai.
Veja [instalação, controles e limites](docs/desktop.md).
O [registro de aceitação](docs/desktop-acceptance.md) mostra vídeo e controle
reais num Android isolado, com capturas e limites do que foi testado.

## CLI pra agentes

`./ponte ctl` controla o app pela mesma API autenticada do Android, sem abrir a
interface nem instalar dependências npm. Dá pra consultar estado e capacidades,
comandar desktop, terminais, áudio e ditado, salvar screenshots e capturar MJPEG
com duração limitada. Os comandos de instalação e celular continuam funcionando.

```sh
./ponte ctl help
./ponte ctl schema                  # catálogo JSON com parâmetros e limites, offline
./ponte ctl state --pretty
./ponte ctl mouse move --dx 20 --dy -5 --dry-run
```

Saída e erros em JSON, exit codes definidos e `--yes` nas operações destrutivas.
Teste controles numa fixture isolada, não na sessão de trabalho do dono.
O [guia completo do CLI](docs/cli.md) explica cada grupo, conexão, segurança e
testes. A [matriz de cobertura](docs/cli-plan.md) registra o planejamento.

O código é aberto sob a [licença MIT](LICENSE). Sugestões e contribuições são bem-vindas.

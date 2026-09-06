# ponte.

![Arte conceitual do Ponte](docs/assets/hero.png)

Seu Omarchy pelo celular. Touchpad, teclado, janelas e imagem dos monitores pela Tailscale.

[English](README.md) · [Evidências reais](docs/evidence.md) · [Apresentação](docs/presentation.pdf)

A versão global abre em inglês. Escolha PT no seletor do app para usar português; a preferência fica salva. A página do projeto também oferece os dois idiomas.

O Ponte nasceu da vontade de abrir um app no celular e continuar usando o PC. A interface tem controles grandes para mover o mouse, escrever, escolher uma janela e acompanhar um monitor ao vivo.

É uma versão **alfa experimental e independente do Omarchy**. O acesso e a imagem ao vivo foram testados em um Redmi Note 13 Pro+ com Android 14. O pareamento permaneceu salvo depois de fechar o app à força e abrir novamente pelo ícone. O teste final de gravação no Android ainda está pendente.

Os modos Ver, Toque direto, Touchpad e Teclado compartilham o mesmo monitor. A imagem fica acima dos controles em pé e ao lado deles na horizontal. Ao dar zoom, o Ponte captura só a região visível em resolução real. O toque direto clica na imagem; o touchpad separado continua disponível. O layout combinado passou nos testes de navegador; a conferência do teclado real no Android ainda está pendente.

As melhorias de tela e terminais estão na próxima alfa. A atualização personalizada já foi instalada no Redmi, preservando o login; foram verificados a abertura direta na imagem ao vivo, a tela cheia na horizontal e a execução no terminal. A verificação completa do teclado virtual e da gravação ainda está pendente. Veja o [guia de tela e terminais](docs/screen-and-terminals.md).

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

Cada instalação gera configuração e certificado próprios. O APK é personalizado para seu PC e deve ficar privado. O processo inicial ainda exige compilação e pareamento manual, que pretendemos simplificar.

## O que já está disponível

- Mouse com toque, rolagem de dois dedos, arraste e botão direito.
- Texto, atalhos, lista de janelas e troca de áreas de trabalho.
- A imagem do PC abre primeiro, com zoom por pinça em resolução real, toque direto na imagem, rotação, tela cheia e captura em resolução original para ler.
- Terminais de texto com sessões próprias, edição com setas e Enter separado. A mesma sessão pode ser aberta no PC.
- Volume e controles de mídia.
- Gerenciamento de energia: ligar/desligar cada monitor individualmente, superbotões "Dormir inteligente" e "Acordar", e desligamento completo com confirmação dupla.
- Interface para gravar, revisar e enviar áudio ao PC, com validação final no Android em andamento.

## Gerenciamento de energia e dormir inteligente

O Ponte inclui controles de energia no painel inicial do celular:

- **Controle individual de telas:** Ligue ou desligue cada monitor separadamente via DPMS (`hyprctl dispatch dpms off/on <nome>`).
- **Superbotão "Dormir inteligente":** Apaga todos os monitores e desliga as luzes RGB via Magma Lights (`controller.py sleep`). **Não é suspensão (suspend) nem desligamento**: o computador continua ligado rodando seus agentes e processos em segundo plano, acessível remotamente pela Tailscale.
- **Superbotão "Acordar":** Acende todos os monitores e restaura a iluminação RGB (`controller.py restore`).
- **Desligar com confirmação dupla:** Desliga o sistema por completo (`systemctl poweroff`), exigindo confirmação na interface para evitar toques acidentais.
- **Pré-requisitos de Wake-on-LAN (WoL):** Com a máquina desligada, o Ponte não roda e a Tailscale desconecta. Para religar o computador remotamente, envie um Magic Packet para a interface Ethernet física. O MAC (`d8:43:ae:8b:e8:a8`) e a interface (`enp12s0`) ficam expostos em `/api/state` e `/api/power`. Habilite "Power On By PCI-E" na BIOS/UEFI e confirme `Wake-on: g` com `ethtool`.
- **APK no celular:** o card de energia usa `/api/power`. Instale o APK alpha.3 (version code 6) por cima do app atual, com a mesma chave de assinatura, para o proxy nativo encaminhar essa rota.

A imagem usa MJPEG autenticado, com perfis de até 10 quadros por segundo. Não transmite o áudio do sistema. O teste local com três monitores ficou entre 7,1 e 7,3 quadros por segundo por transmissão. Ainda não medimos a experiência por rede celular ou fora de casa.

Leia o [guia de configuração](docs/setup.md), o [guia Android](android/README.md) e o [modelo de segurança](SECURITY.md). Um celular pareado pode operar sua sessão real do PC. A [especificação do caminho inverso](docs/pc-controls-phone.pt-BR.md) avalia operar o celular a partir do PC pela mesma rede Tailscale. Valide as novidades no aparelho com o [roteiro de teste manual](docs/manual-test-checklist.pt-BR.md).

O código é aberto sob a [licença MIT](LICENSE). Sugestões e contribuições são bem-vindas.

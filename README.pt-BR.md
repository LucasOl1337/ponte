# ponte.

![Arte conceitual do Ponte](docs/assets/hero.png)

Seu Omarchy pelo celular. Touchpad, teclado, janelas e imagem dos monitores pela Tailscale.

[English](README.md) · [Evidências reais](docs/evidence.md) · [Apresentação](docs/presentation.pdf)

A versão global abre em inglês. Escolha PT no seletor do app para usar português; a preferência fica salva. A página do projeto também oferece os dois idiomas.

O Ponte nasceu da vontade de abrir um app no celular e continuar usando o PC. A interface tem controles grandes para mover o mouse, escrever, escolher uma janela e acompanhar um monitor ao vivo.

É uma versão **alfa experimental e independente do Omarchy**. O acesso e a imagem ao vivo foram testados em um Redmi Note 13 Pro+ com Android 14. O pareamento permaneceu salvo depois de fechar o app à força e abrir novamente pelo ícone. O teste final de gravação no Android ainda está pendente.

As melhorias de tela e terminais estão na próxima alfa. A atualização personalizada já foi instalada no Redmi, preservando o login; foram verificados a abertura direta na imagem ao vivo, a tela cheia na horizontal e a execução no terminal. A verificação completa do teclado virtual e da gravação ainda está pendente. Veja o [guia de tela e terminais](docs/screen-and-terminals.md).

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
- A imagem do PC abre primeiro, com zoom por pinça, rotação, tela cheia e captura em resolução original para ler.
- Terminais de texto com sessões próprias, edição com setas e Enter separado. A mesma sessão pode ser aberta no PC.
- Volume e controles de mídia.
- Interface para gravar, revisar e enviar áudio ao PC, com validação final no Android em andamento.

A imagem usa MJPEG autenticado, com perfis de até 10 quadros por segundo. Não transmite o áudio do sistema. O teste local com três monitores ficou entre 7,1 e 7,3 quadros por segundo por transmissão. Ainda não medimos a experiência por rede celular ou fora de casa.

Leia o [guia de configuração](docs/setup.md), o [guia Android](android/README.md) e o [modelo de segurança](SECURITY.md). Um celular pareado pode operar sua sessão real do PC.

O código é aberto sob a [licença MIT](LICENSE). Sugestões e contribuições são bem-vindas.

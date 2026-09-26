# Ponte Desktop: celular no computador

O Ponte agora tem os dois sentidos:

- **Android → PC:** o aplicativo Android existente controla o desktop Omarchy.
- **PC → Android:** o Ponte Desktop abre a tela e o controle do celular no PC.

Esta primeira versão desktop é para **Linux**. A janela principal é nativa Qt.
O vídeo e a entrada usam scrcpy em uma segunda janela chamada **Ponte · Celular**,
gerenciada pelo app. Não é uma imagem estática nem uma página do app Android.
Não precisa rebuildar o APK, subir outro servidor HTTP ou criar conta.

## Abrir e instalar no menu

No Arch/Omarchy, as dependências de desktop são `python`, `pyside6`,
`android-tools` e `scrcpy`. O scrcpy precisa oferecer `--no-audio`,
`--no-clipboard-autosync`, `--video-codec` e os perfis usados aqui, então use uma
versão atual (3.x ou 4.x). Em outras distribuições, instale os pacotes equivalentes.
PySide6 é só da interface gráfica: os comandos CLI funcionam com Python stdlib.

```sh
# Instale as dependências pelo gerenciador da sua distribuição, se necessário.
sudo pacman -S --needed python pyside6 android-tools scrcpy

cd /caminho/do/ponte
./ponte desktop

# Opcional: cria Ponte Desktop no menu deste usuário. Não abre o app.
./ponte desktop install
# Remove só esse atalho, preservando conexão, preferências e APK.
./ponte desktop uninstall
```

O launcher fica em `$XDG_DATA_HOME/applications/ponte-desktop.desktop` (fallback:
`~/.local/share/applications`). Referencia este checkout: não mova a pasta sem
reinstalar o atalho. Não há autostart, serviço novo, sudo automático ou download
silencioso. Arquivos de launcher alheios e symlinks não são substituídos.
Caminhos com espaços são suportados, mas `%` no caminho do checkout é recusado
para evitar launchers que o desktop não consegue interpretar.

## Conectar um celular

1. No Android, ative **Opções do desenvolvedor** e a depuração apropriada.
2. Use um dos caminhos abaixo. A autorização acontece no próprio aparelho.
3. No Ponte Desktop, clique em **Atualizar**, escolha o serial exato e selecione.
4. Clique em **Abrir tela do celular**. A janela de vídeo aceita mouse, teclado,
   scroll e os atalhos do scrcpy. Use os botões do app para voltar, início,
   recentes, volume ou acordar a tela.
5. **Encerrar controle** fecha só o scrcpy desta sessão. Fechar o app também
   encerra a janela que ele criou, não outros controles abertos por você.

### USB

Conecte o cabo e aceite a chave de depuração na tela do celular. O aparelho deve
aparecer como `device`. Se aparecer `unauthorized`, o app não tenta aceitar nem
contornar a confirmação. Selecione o serial mostrado, nunca um aparelho parecido.

### Depuração sem fio

Nas configurações de **Depuração sem fio** do Android, abra **Parear com código**.
Preencha no app o endereço/porta de pareamento e o código de seis dígitos. Depois,
use **Conectar** com o endereço/porta de conexão, que costuma ser diferente.
O código não fica salvo nem aparece em argumentos de processo ou logs do Ponte.

### Tailscale

Se o telefone já tem o transporte ADB configurado, use o IP Tailscale e a porta
salva. O endereço existente no Ponte aparece como sugestão. O app nunca conecta,
acorda, muda TCP ou escolhe outro transporte sozinho.

O novo desktop aceita IPv4 canônico de rede privada, Tailscale ou loopback com
porta. Não aceita hostname, IPv6 ou IP público para conexão ADB. ADB expõe shell
amplo do aparelho, não apenas os controles do Ponte. Mantenha-o em redes e
computadores autorizados. ADB pode parar de escutar após reiniciar o Android:
isso precisa ser reativado pelo operador. A recuperação antiga `phone ensure`
continua disponível separadamente, mas não é executada pelo app desktop.

## Qualidade e privacidade

| Perfil | Limite de imagem | FPS máximo | Bitrate |
| --- | --- | --- | --- |
| Leve | 720 px | 30 | 2 Mbit/s |
| Equilibrado | 1280 px | 45 | 4 Mbit/s |
| Nítido | 1920 px | 60 | 8 Mbit/s |

A proporção é preservada pelo scrcpy. A resolução/fps real depende do aparelho,
codec e conexão. H.264 é usado para compatibilidade.

- **Áudio desligado por padrão.** Ative só se quiser ouvir o celular no PC.
  O suporte depende da versão do Android e do scrcpy.
- **Clipboard automático desligado por padrão.** A opção permite sincronização
  do scrcpy. Mesmo sem sincronização automática, atalhos explícitos de copiar e
  colar do scrcpy podem transferir conteúdo por iniciativa de quem usa a janela.
- **Somente visualização:** abre scrcpy com `--no-control` e bloqueia os botões
  de entrada. Screenshot continua permitido. Não é proteção contra outro
  cliente ADB que você inicie separadamente.
- **Acordar** liga a tela, não desbloqueia senha/PIN, não usa `phone-unlock`.
- O app não desliga a tela física nem mantém o aparelho acordado por padrão.
- **Capturar tela** cria PNG privado em `0600` e não sobrescreve arquivos.

Conexão, seleção e preferências ficam em `desktop.json` no `dataDir` privado do
Ponte. O app respeita `PONTE_CONFIG`, `OMARCHY_REMOTE_DATA` e os caminhos XDG.
Sem instalação prévia do servidor, usa `$XDG_STATE_HOME/ponte` (fallback
`~/.local/state/ponte`). Não precisa copiar tokens do servidor ou alterar o APK.
As autorizações ADB continuam sendo as do próprio ADB, não o token HTTP do Ponte.

## CLI do desktop

```sh
./ponte desktop help
./ponte desktop schema
./ponte desktop version
./ponte desktop status --pretty
./ponte desktop devices
./ponte desktop connect 100.64.0.10:5555
./ponte desktop select SERIAL
./ponte desktop disconnect 100.64.0.10:5555
```

Substitua os endereços e `SERIAL` pelos alvos reais autorizados. Cada efeito
exige o serial explícito, mesmo que exista seleção salva. Nenhum comando escolhe
o primeiro aparelho da lista. Estado `offline` ou `unauthorized` é recusado.

```sh
# Código vem de stdin. Não passe em argv nem registre o valor no shell.
./ponte desktop pair 100.64.0.10:37123 --stdin < /fonte/privada/codigo

./ponte desktop mirror --serial SERIAL --profile balanced --dry-run
./ponte desktop mirror --serial SERIAL --profile light --read-only
./ponte desktop key --serial SERIAL --key HOME
./ponte desktop tap --serial SERIAL --x 300 --y 600
./ponte desktop swipe --serial SERIAL --x1 300 --y1 900 --x2 300 --y2 300 --duration 400
printf '%s' 'texto ASCII' | ./ponte desktop text --serial SERIAL --stdin
./ponte desktop screenshot --serial SERIAL --output ./celular.png
./ponte desktop preferences --profile sharp --audio
```

`mirror --dry-run` verifica o alvo por `adb devices`, mas não abre vídeo nem
envia entrada. Diferente do `ponte ctl --dry-run`, ele **não é totalmente
offline**. As flags de `mirror` são explícitas; o comando não herda opções
sensíveis da GUI. Em `preferences`, flags omitidas ficam desligadas.

Input CLI aceita 1 a 1024 caracteres ASCII imprimíveis, sem `%` e sem quebra de
linha interna. Remove uma quebra de linha final do stdin. Use o teclado/clipboard
da janela scrcpy para textos Unicode conforme o método de entrada do aparelho.
Coordenadas: 0 a 32767. Duração de swipe: 1 a 2000 ms. Teclas disponíveis no
`schema`. Nenhuma API de shell arbitrário foi adicionada.

Comandos CLI retornam um documento JSON com `schemaVersion:1`, `ok` e `data` ou
`error:{code,message}`. `--pretty` indenta. `help` é texto, `help --json` retorna
o catálogo. Logs do scrcpy vão para stderr, nunca misturados ao JSON de stdout.
`mirror` permanece no processo até a janela fechar; SIGINT/SIGTERM encerram só
o filho criado por esse comando.

| Exit | Significado |
| --- | --- |
| 0 | Sucesso |
| 2 | Uso, configuração, arquivo ou validação inválida |
| 3 | Dependência ausente ou sessão gráfica indisponível |
| 4 | Timeout |
| 5 | Dispositivo exato indisponível ou não autorizado |
| 6 | Ferramenta falhou ou respondeu de forma inválida |
| 130 | Interrompido |

Não repita entrada automaticamente depois de timeout ou desconexão. Ela pode
ter chegado ao celular. Observe o estado primeiro. O comando `status` retorna
um diagnóstico com `errors` quando uma consulta falha, sem tentar reparos.

## Demonstração e testes sem telefone

```sh
./ponte desktop --demo
npm run test:desktop
# Com PySide6 instalado e display de teste apropriado:
python3 -m unittest discover -s desktop/tests -p test_gui.py
```

`--demo` mostra um celular sintético, com indicação explícita de demonstração.
Não chama ADB, não acessa seu telefone e não inicia scrcpy. Ele serve para
avaliar a interface e os estados, não para comprovar transmissão real.
Testes de bridge/CLI usam executáveis falsos e estado temporário, com alvos
propositadamente diferentes para comprovar que não há fallback silencioso.
Os testes Qt exercitam widgets, tarefas assíncronas e ciclo de vida de processos.

Nesta máquina, toda validação visual roda em bancada `agent-bench`, nunca no
compositor humano. Testes de vídeo/emulador só rodam com vaga na fila pesada.
Consulte [o plano](desktop-plan.md) e [as evidências de aceitação](desktop-acceptance.md)
para o que foi de fato medido, incluindo vídeo e controle reais em Android 11
isolado. A imagem ilustrativa na janela de gerenciamento não é o stream.

## Limites desta entrega

- Linux desktop, Android autorizado por ADB. Não inclui versão Windows/macOS/iOS.
- A interface nativa desta primeira versão está em PT-BR. Não muda o idioma
  selecionado no app Android ou na interface web existente.
- A janela de vídeo é separada da janela de gerenciamento. Não promete embedding
  frágil de janela X11 dentro do Qt em Wayland.
- Depuração/autorização é requisito, não contornada. Sem pareamento ADB prévio
  não existe controle remoto apenas por ter o APK Ponte instalado.
- Conteúdo protegido por DRM/FLAG_SECURE pode não aparecer no espelhamento.
- O app não adiciona AccessibilityService, MediaProjection ou controle permanente
  no telefone. Essas seriam outra arquitetura, descrita em
  [PC controls phone](pc-controls-phone.md).

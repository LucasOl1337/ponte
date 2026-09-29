# CLI do Ponte para agentes

O ponto de entrada é `./ponte`. Pra controlar o app sem interface, use
`./ponte ctl`. Ele fala com o mesmo servidor autenticado que o Android usa,
sem dependências npm, daemon extra ou uma segunda implementação do desktop.
Requer Node.js 22+ e Python 3.12+, já usados pelo projeto.

[Aceitação no serviço instalado](cli-acceptance.md): fluxo real de terminal,
consultas e TLS, com [cobertura por comando](cli-command-evidence.md) e limites
dos efeitos que só foram testados em ambiente sintético.

## Comece por aqui

```sh
./ponte --help
./ponte ctl help
./ponte ctl help keyboard text
./ponte ctl schema                  # catálogo JSON completo, sem conectar
./ponte ctl schema terminals input  # parâmetros, tipos, limites e defaults
./ponte ctl version                 # versão local, sem conectar
./ponte ctl config                  # caminhos e listeners, sem segredos
./ponte ctl health                  # saúde e versão do servidor, sem token
./ponte ctl capabilities
./ponte ctl state --pretty
```

`help`, `schema`, `version` e `--dry-run` funcionam sem serviço ou configuração.
`config` lê a configuração local, não mostra token, senha, chave privada ou o
conteúdo de certificados. Não confunda `./ponte status` (systemd) com
`./ponte ctl state` (estado do aplicativo).

## Conexão

Por padrão, o cliente usa o listener HTTP de loopback e o arquivo `token` do
`dataDir` da configuração. Respeita `PONTE_CONFIG`, os caminhos XDG e os overrides
`OMARCHY_REMOTE_*` do servidor. Não cria configuração, token ou pareamento.

```sh
# Servidor isolado de teste, com token privado já criado pela fixture.
./ponte ctl --url http://127.0.0.1:8799 --token-file /caminho/privado/token state

# Outro computador: HTTPS verificado, nunca --insecure.
./ponte ctl --url https://100.64.0.10:8788 \
  --ca-file /caminho/ca.crt --token-file /caminho/privado/token state
```

O endereço acima é exemplo. O token deve ser um arquivo regular, do usuário,
modo `0600`, sem symlink. Não passe token em argv, URL ou query string.
`--url` junto com `--token-file` não depende da configuração desta máquina.
Nesse modo, forneça `--ca-file` quando a instalação usar CA privada.
HTTP só aceita `127.0.0.1`, `localhost` ou `[::1]`. HTTPS verifica CA e hostname.
O cliente não segue redirects, não faz pareamento automático e não repete
requisições. `PONTE_NODE` escolhe o executável Node se necessário.

### Outro aparelho da malha (`--node`)

Qualquer comando, exceto `health`, vai pra um aparelho pareado com
`--node NOME|ID`. O servidor local (o nó de casa) repassa a requisição com o
token de par e o CA fixado daquele aparelho, então o agente continua usando só
o token local. Nada de SSH, segundo token ou certificado do outro lado.

```sh
./ponte mesh list                                  # nomes e ids pareados
./ponte ctl state --node notebook                  # data.node diz quem respondeu
./ponte ctl windows --node notebook
./ponte ctl terminals create --node notebook
./ponte ctl volume set --value 0.3 --node 3f2a9c0d1e4b5a67
```

O nome não diferencia maiúsculas e só vale pra aparelho pareado; um id de 16
hex é usado direto, sem consultar `/api/mesh`. O nome do próprio nó de casa
fica local. `--dry-run` mostra o caminho com `?node=` pra um id e deixa um nome
sem resolver (resolver exige conexão). Erros próprios:

| Código | Quando |
| --- | --- |
| `MESH_PEER_NOT_PAIRED` | O aparelho está no tailnet mas não foi pareado: `./ponte mesh pair NOME` e aprove lá |
| `MESH_PEER_NOT_FOUND` | Nenhum pareado tem esse nome; a mensagem lista os pareados |
| `MESH_PEER_AMBIGUOUS` | Dois pareados com o mesmo nome: use o id |
| `PEER_OFFLINE` / `PEER_REVOKED` / `PEER_UNTRUSTED` | Do relay: aparelho fora, vínculo revogado lá (e esquecido aqui) ou certificado diferente do fixado |

Um par nunca repassa adiante: `--node` só funciona a partir do nó de casa do
dono. Veja [a malha](mesh.md).

## Contrato de automação

Todos os comandos `ctl`, exceto a ajuda textual, escrevem **um documento JSON
em stdout**, inclusive nas falhas. `--json` é opcional. `--pretty` só muda a
formatação. Use o exit code e `ok`, não texto humano, pra decidir o próximo passo.

```json
{"schemaVersion":1,"ok":true,"data":{"ok":true}}
```

```json
{"schemaVersion":1,"ok":false,"error":{"code":"PAIRING_REQUIRED","message":"HTTP 401: ...","status":401}}
```

| Exit code | Significado |
| --- | --- |
| 0 | Sucesso |
| 1 | Falha local inesperada |
| 2 | Uso, validação, arquivo/configuração inválida ou confirmação ausente |
| 3 | Conexão indisponível ou TLS inválido |
| 4 | Deadline excedida |
| 5 | Autenticação ou autorização negada |
| 6 | Erro da API, redirect ou resposta inválida |
| 130 | Interrompido por sinal |

`--timeout` é em milissegundos, de 1 a 120000, padrão 15000. Pra transcrição
ou RGB lento, use `--timeout 90000`. Stream ajusta o padrão à duração solicitada.
Entrada stdin precisa fechar em até 15 segundos. Não há prompt interativo.
Opções desconhecidas, repetidas, valores inválidos e argumentos extras falham.
Flags booleanas aceitam `--enter`, `--enter=true` e `--enter=false`.
Pra texto que começa com `--`, use `--text=--valor` ou stdin.

**Timeout/interrupção não significa que uma ação não aconteceu.** Consulte o
estado antes de repetir. Isso vale especialmente pra digitação, terminal,
toggle de mute, mídia, upload e energia. `data.ok` do servidor confirma que ele
aceitou/executou a operação, não que uma aplicação externa terminou seu trabalho.

## Consultas

| Comando | Dados |
| --- | --- |
| `health` | Nome, versão e disponibilidade de auto-pareamento |
| `state` | Estado completo, warnings e códigos de warning |
| `capabilities` | Input, texto, captura, áudio, luzes, lock e transcrição |
| `windows`, `workspaces`, `monitors` | Alvos atuais e IDs |
| `volume`, `lights`, `session` | Estado desses controles |
| `textinput` | Foco em campo de texto via fcitx5, se disponível |
| `power` | Monitores e informação de Wake-on-LAN |
| `terminals list` | Sessões privadas do Ponte e limite disponível |
| `audio list` | Gravações armazenadas |

Leia os IDs e capacidades antes de agir. Alvos fechados, dependências ausentes e
modo de cópia do tmux continuam sendo validados pelo servidor.

## Desktop

Os exemplos abaixo **alteram a sessão atendida pelo servidor**. Use o laboratório
ou uma sessão explicitamente autorizada. Não execute testes contra o desktop do
dono. Nesta máquina, bancadas e a política de convivência continuam valendo.

```sh
./ponte ctl mouse move --dx 20 --dy -5
./ponte ctl mouse click --button left
./ponte ctl mouse click-at --monitor DP-1 --x 100 --y 200 --button right
./ponte ctl mouse move-to --monitor DP-1 --x 100 --y 200
./ponte ctl mouse scroll --dy -3
./ponte ctl mouse drag --pressed true
./ponte ctl mouse drag --pressed false
./ponte ctl mouse drag-start --monitor DP-1 --x 100 --y 200 --modifier super

./ponte ctl keyboard text --text 'texto literal'
printf '%s' 'texto literal' | ./ponte ctl keyboard text --stdin
./ponte ctl keyboard text --file ./texto.txt
./ponte ctl keyboard key --key Enter
./ponte ctl workspace focus --id 6 --monitor DP-1
./ponte ctl window focus --address 0x123abc
./ponte ctl window move --address 0x123abc --id 7
./ponte ctl app launch --app terminal

./ponte ctl volume set --value 0.4
./ponte ctl volume mute
./ponte ctl media toggle
./ponte ctl media next
./ponte ctl media previous
```

`keyboard text` não acrescenta Enter, a menos que você peça `--enter`.
Quebras de linha **dentro do texto** são preservadas e podem executar comandos
se o foco for um terminal. Pra uma linha sem execução implícita, prefira
`terminals input`. Drag é estado do servidor, com liberação automática de
segurança em cerca de 1,8 segundo. Comandos curtos de movimento não mantêm uma
operação de drag indefinidamente. Sempre termine com `mouse drag --pressed=false`.
A escala/zoom da tela do celular não muda coordenadas: `x/y` são pixels do monitor.

### Energia, luzes e sessão

```sh
./ponte ctl monitors set --monitor DP-1 --state off
./ponte ctl monitors all --state on
./ponte ctl power sleep
./ponte ctl power wake
./ponte ctl lights preset --preset oceano
./ponte ctl lights sleep
./ponte ctl lights restore
./ponte ctl lights reapply
./ponte ctl lights screen --enabled false
./ponte ctl session lock

# Senha somente via stdin, vinda de uma fonte privada. Nunca escreva a senha
# literal no comando, no histórico ou num exemplo de documentação.
secret-tool lookup servico ponte | ./ponte ctl session unlock --stdin

# Inspecionar não executa e não precisa de conexão.
./ponte ctl power off --dry-run
# Execução real é intencional e exige confirmação explícita.
./ponte ctl power off --yes
./ponte ctl power reboot --yes
./ponte ctl power suspend --yes
```

`unlock` remove uma quebra de linha final do stdin e só funciona quando o
backend confirma que o lock está ativo. Não redefine senha. `sleep` desliga
monitores/luzes, mas não suspende o PC. `wake` restaura esses controles num PC
ligado. Um servidor suspenso/desligado não pode acordar a si mesmo: o pacote
Wake-on-LAN continua saindo do cliente Android.

`--yes` é obrigatório para desligar, reiniciar, suspender e remover terminal.
As demais ações também podem interromper trabalho. A flag não substitui a
autorização humana nem a política da máquina. Os comandos legados `ponte pc`
continuam com seu comportamento anterior, sem essas novas confirmações.

## Terminais

```sh
./ponte ctl terminals create --cols 100 --rows 30
./ponte ctl terminals list
# Substitua ID pelo data.id recebido, de 24 caracteres hexadecimais.
./ponte ctl terminals read --id ID
printf '%s' 'pwd' | ./ponte ctl terminals input --id ID --stdin --enter
./ponte ctl terminals input --id ID --file ./comando-de-uma-linha.txt
./ponte ctl terminals key --id ID --key Interrupt
./ponte ctl terminals resize --id ID --cols 120 --rows 40
./ponte ctl terminals remove --id ID --yes
```

Sem `--enter`, o texto fica no prompt. Input de terminal aceita só uma linha e
remove uma quebra final de arquivo/stdin. Caracteres de controle e multiline
são rejeitados. Os terminais pertencem ao socket privado do Ponte, não ao tmux
pessoal, mas **o shell roda como o mesmo usuário, não é sandbox**. Remover mata a
sessão e seus processos. O padrão de criação é 80 colunas por 24 linhas.

### Máquinas SSH

```sh
./ponte ctl terminals places                              # pastas e máquinas SSH deste aparelho
./ponte ctl terminals create --agent ssh --host cloud-vm  # sessão rodando `ssh cloud-vm`
./ponte ctl terminals create --agent ssh --host work-vm --node notebook
```

O `--host` precisa ser um dos apelidos que `terminals places` lista em
`data.hosts`, que vêm de `ssh.hosts` na configuração privada do aparelho (veja
[a malha](mesh.md#ssh-machines-in-the-app)). Qualquer outro nome, um
`usuario@host` ou algo começando com hífen volta `SSH_HOST_NOT_ALLOWED` antes do
tmux rodar. Quando o ssh termina, a sessão cai num shell local do aparelho.

## Voz e ditado

```sh
./ponte ctl audio upload --file ./fala.webm
./ponte ctl audio list
./ponte ctl audio download --id UUID --output ./copia.webm
./ponte ctl audio play --id UUID
./ponte ctl audio stop
./ponte ctl dictate --file ./fala.wav --timeout 90000
./ponte ctl terminals dictate --id ID --file ./fala.webm --timeout 90000
./ponte ctl terminals dictate --id ID --file ./fala.webm --enter --timeout 90000
```

Formatos: WebM, Ogg, MP4/M4A e WAV, até 25 MiB. MIME é inferido da extensão ou
informado com `--mime`. O cliente verifica assinatura/tamanho antes de enviar e
o servidor faz a validação de mídia. `dictate` só retorna transcrição.
`terminals dictate` digita no alvo, sem Enter por padrão, diferente da rota HTTP
antiga cujo default é executar. `audio play` toca no PC, não no cliente CLI.
Não há endpoint de exclusão de gravação no aplicativo, então o CLI não inventa um.

## Captura e streaming

```sh
./ponte ctl screenshot --monitor DP-1 --scale 0.65 --output ./monitor.jpg
./ponte ctl stream --monitor DP-1 --seconds 3 --fps 10 --quality 65 \
  --scale 0.5 --output ./monitor.mjpeg
./ponte ctl stream --monitor DP-1 --x 100 --y 100 --w 800 --h 600 \
  --seconds 2 --output ./recorte.mjpeg
```

O arquivo de stream contém o corpo HTTP multipart MJPEG, com boundaries e
headers de cada frame. Não é MP4 e não tem áudio do sistema. Duração: 0,1 a
60 segundos, padrão 5. O timeout geral ainda limita conexão e transferência.
O limite do stream é 128 MiB, das outras respostas é 32 MiB.
Captura usa arquivo obrigatório, nunca binário misturado com JSON em stdout.
O arquivo precisa não existir. É criado em `0600`; symlinks e sobrescrita são
recusados. Falha remove só o arquivo incompleto criado por esta requisição.
Captura visual e gravação longa nesta máquina exigem bancada e vaga na fila
pesada conforme a política de convivência. Os testes automatizados usam pixels
sintéticos, não fazem captura do compositor humano.

## Ação genérica e dry run

```sh
./ponte ctl action mouse.move --data '{"dx":20,"dy":-5}' --dry-run
printf '%s' '{"key":"Enter"}' | ./ponte ctl action keyboard.key --stdin
./ponte ctl action window.focus --file ./acao.json
```

A ação genérica usa os mesmos validadores e confirmações dos comandos nomeados.
Não aceita campos extras, ações arbitrárias nem execução de shell. `schema`
inclui aliases legados, como `screen.dpms` e `power.poweroff`.
Se houver `type` no JSON, precisa coincidir com o nome solicitado.
Unlock genérico aceita JSON **somente via stdin**.
`--dry-run` valida e mostra método, rota e corpo, sem ler token/configuração,
conectar ou executar. Texto e senha ficam `[REDACTED]`. Upload dry-run verifica
os parâmetros, mas não lê nem valida o conteúdo do áudio.

## Administração e Android continuam no mesmo CLI

O app desktop e o controle no sentido PC → Android estão em `./ponte desktop`.
Use `./ponte desktop schema` para automação de dispositivos explicitamente
selecionados. Veja [o guia desktop](desktop.md). `ctl` continua sendo o cliente
da API que controla o PC, não uma nova API ADB exposta na rede.

| Tarefa | Interface existente |
| --- | --- |
| Configurar e instalar | `./ponte setup`, `install`, `uninstall` |
| Serviço e logs | `start`, `stop`, `restart`, `status`, `logs` |
| Diagnóstico e certificado | `doctor`, `renew-cert` |
| Pareamento explícito | `pair`, `pair --url ORIGIN` |
| Tailscale Serve e configuração Android | `serve`, `android-config` |
| Controle local sem servidor HTTP | `./ponte pc --help` |
| Conexão ADB, install, app, wake, view, timer | `./ponte phone --help` |
| Build e teste Android | `./android/build.sh`, `./android/test.sh` |

Esses comandos legados mantêm sua saída própria, não o envelope de `ctl`.
`pair` revela o token por design. Nunca o inclua em relatórios. `doctor` e os
comandos `phone` podem consultar/interagir com o aparelho real e não fazem parte
do smoke test isolado do CLI.
Orientação, zoom, idioma, revisão local de gravação e permissões Android são
estado do cliente, não do servidor. Não há endpoint remoto pra mudar essas
preferências. O catálogo cobre as funções públicas do servidor e aponta pros
comandos existentes de administração, sem fingir que controla estado local da UI.

## Testes e extensão

```sh
npm test
npm run test:cli
node --test tests/ctl.test.mjs tests/ctl-client.test.mjs
./android/test.sh
```

As suítes CLI usam subprocessos reais, sockets HTTP/HTTPS locais, configuração
privada temporária e servidor real com adapters de desktop/áudio/transcrição
injetados. Nenhum clique, tecla, áudio, comando de energia ou telefone real é
necessário. O teste de cobertura compara o catálogo com **todos** os tipos de
ação do backend, incluindo aliases, pra impedir lacunas silenciosas.
Um teste adicional usa tmux real com HOME e socket privados: cria uma sessão,
executa um comando Unicode, observa a saída, redimensiona e remove. Ele não
acessa o tmux ou o desktop do usuário. Sem tmux instalado, esse caso é skipped.

- `bin/ctl-catalog.mjs`: comandos e validação pura.
- `bin/ctl-client.mjs`: autenticação, TLS, deadlines e I/O limitado.
- `bin/ponte-ctl.mjs`: parser, entrada, envelope e dispatch.
- `docs/cli-plan.md`: auditoria inicial e matriz de cobertura.
- `tools/lab/README.md`: laboratório visual opcional. Não rode a sessão real
  apenas pra testar uma nova flag.

Ao adicionar capacidade no backend, inclua um descritor, um teste de integração
e exemplos aqui. Não replique efeitos desktop no cliente e não adicione retry de
mutações. O servidor continua sendo a autoridade sobre alvos e execução.

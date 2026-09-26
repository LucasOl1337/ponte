# CLI: aceitação contra o Ponte instalado

26/09/2026, 03:43–03:47 UTC. Cliente publicado em `27c1d4b`, serviço instalado
`0.1.0-alpha.19`. Esta rodada complementa os testes sintéticos, não os renomeia
como aceitação real.

## Resultado observado

O caminho executado foi **`./ponte ctl` → configuração/token existentes → HTTP
ou HTTPS do servidor instalado → terminal tmux real gerenciado pelo Ponte**.
Não foi criado servidor de teste. Não houve injeção de adapters, cópia de código,
chamada direta ao tmux ou mudança/restart do serviço.

Um script apenas orquestrou subprocessos do CLI público e conferiu seus retornos.
O caminho de aplicação foi o mesmo documentado para agentes usarem o app.

### Workflow completo, não só health

1. `health` confirmou o serviço `0.1.0-alpha.19`.
2. `terminals list` encontrou uma sessão preexistente. Ela não foi lida, usada,
   redimensionada ou encerrada.
3. `terminals create --cols 90 --rows 28` criou um alvo novo, com ID próprio.
4. `terminals input --id NOVO --text COMANDO` digitou um `printf` com Unicode.
   Sem `--enter`, `terminals read` não continha a linha de saída esperada.
5. `terminals key --id NOVO --key Enter` executou o comando. A leitura seguinte
   retornou a linha exata com sufixo aleatório e `ação`.
6. O sentinel foi dividido em dois argumentos no comando, mas unido na saída.
   Portanto a prova foi **saída de execução**, não eco do texto digitado.
7. `terminals resize --id NOVO --cols 100 --rows 30` foi seguido por leitura
   que confirmou exatamente 100×30.
8. `terminals remove --id NOVO`, sem `--yes`, devolveu exit **2** e
   `CONFIRMATION_REQUIRED`. Uma listagem confirmou que o alvo ainda existia.
9. Com `--yes`, a remoção retornou exit **0**. A lista voltou exatamente ao
   conjunto original. Ler o ID removido devolveu exit **6**,
   `TERMINAL_NOT_FOUND`.

Foram 14 processos CLI em cerca de 0,98 s, cada um com JSON válido e
`schemaVersion:1`. O shell da sessão própria só executou `printf`. Nenhum input
foi enviado a janela, foco ou terminal do desktop humano.

Prova sanitizada: [cli-installed-terminal.json](evidence/cli-installed-terminal.json).
IDs, attach paths e texto de terminais não são publicados.

### Consultas de estado com backend real

Estas 13 consultas terminaram com exit **0**, `ok:true` e dados no formato
esperado: `health`, `state`, `capabilities`, `windows`, `workspaces`, `monitors`,
`volume`, `lights`, `session`, `textinput`, `power`, `terminals list`, `audio list`.

- `state` retornou os 16 campos de estado, com `warningCodes:[]` nesta máquina.
- As seleções de lista retornaram arrays, não o objeto inteiro de `/api/state`.
- Volume retornou `value/muted`, sessão retornou `locked/lockAvailable`, foco de
  texto retornou `available/focused` e áudio retornou `recordings`.
- Foram consultas somente leitura. Não houve captura, alteração de volume/luzes,
  monitor, foco ou entrada de teclado/mouse.
- `config` também foi executado e retornou os caminhos/listeners permitidos,
  sem token, senha ou chave privada.

Prova com tipos, chaves e contagens, sem valores pessoais:
[cli-installed-queries.json](evidence/cli-installed-queries.json).

### Autenticação e TLS de instalação existente

`health` e `terminals list` também foram executados no listener **HTTPS real**,
com `--ca-file` da instalação e `--token-file` explícito. Ambos retornaram exit
0. O CLI verificou a CA e o nome/IP do certificado, sem `--insecure`.

Isso observa cliente, arquivo de credencial, TLS, autenticação e router reais.
Não é teste de distância de rede ou conexão partindo de outro computador.
Falhas de CA/hostname, redirects, token inválido e timeouts continuam cobertas
por testes de transporte controlado, não por corromper a instalação do usuário.

Prova: [cli-installed-tls.json](evidence/cli-installed-tls.json).

## Melhoria concreta e requisitos

| Pedido | Antes | Check executado e resultado |
| --- | --- | --- |
| Auditar e planejar antes de implementar | CLI administrativo e `pc` parcial, sem cliente de controle amplo | Auditoria/decisões em `cli-plan.md`, comparação de entrypoints registrada lá |
| Agentes descobrirem funções sem interface | `ctl schema` era comando inválido, exit 2 | CLI entregue retorna catálogo de 59 comandos mesmo com configuração inexistente |
| Adquirir informações facilmente | Exigia conhecer endpoints/token/manual HTTP | 13 consultas publicadas rodaram no serviço instalado, JSON e campos selecionados corretos |
| Dar comandos e completar trabalho | Sem workflow oficial de terminal no CLI | Criar → digitar sem executar → Enter → observar Unicode → resize → remover, com sessão preexistente preservada |
| Todas as funções controláveis expostas | `pc` cobria só parte do app | Teste compara 32 ações canônicas e 5 aliases com backend. Matriz por comando distingue contrato coberto de efeito real não observado |
| Leve e rápido | Nenhum catálogo CLI completo | 20 processos `schema` offline: mediana 58 ms, p95 63 ms, máximo 64 ms. Sem dependências npm de produção novas |
| Fácil pra agentes testarem | Suítes existentes sem cliente de controle | `npm run test:cli` executado após revisão: 66 passaram, zero falhas/pulos. Testes específicos listados na matriz, não só contagem |
| Bem documentado no repositório | Sem guia desse cliente | `docs/cli.md`: descoberta, uso, stdin, confirmação, limites, JSON/exit, timeout ambíguo e escopos. Exemplos de consulta/terminal/dry-run usados na aceitação |
| Compatibilidade com app existente | Serviço já instalado e APK existente | CLI operou esse mesmo serviço por HTTP e HTTPS sem restart, token novo ou instalação de APK. Suites administrativas/Android verdes |
| Segurança previsível | Nenhuma confirmação do novo cliente | Remoção sem yes recusada ao vivo e alvo ainda listado. Dry-run de power off/alias retornou plano sem ação/configuração. Testes negativos cobrem demais fronteiras |

Os tempos são locais e incluem Python, Node, rede local e serialização quando
aplicável. Não são garantia de performance em toda máquina.

## Cobertura por comando e por output

A [matriz completa](cli-command-evidence.md) liga todos os 59 comandos ao teste
concreto, contrato de saída e nível da evidência. Também cobre discovery/config,
ação genérica, aliases e erros públicos. **Integração com efeitos sintéticos não
é marcada como efeito real observado.**

## Ajustes encontrados pela revisão de evidências

A matriz encontrou que `ctl schema` ainda não apontava ao novo grupo `desktop`
na lista de outros entrypoints. O catálogo foi corrigido e a asserção de
descoberta adicionada. A chamada pública `./ponte ctl schema` foi repetida e
retornou `desktop` mantendo os 59 descritores de controle.

Também faltava uma asserção explícita para preservar os campos extras das
respostas de arraste/movimento: `window` objeto/null e `moved` true/false com
`workspace`. Um teste de integração foi adicionado para named/generic actions.
Ele comprova passthrough de JSON, não substitui observar movimento físico.

Depois desses ajustes, `npm run test:cli` passou 66/66 e `npm test` passou
181 casos, com 1 teste opcional de systemd pulado e nenhuma falha. O app Desktop
não mudou nesta revisão. A aceitação de vídeo/input Android registrada nele
continua sendo a da versão final já observada.

## O que esta rodada não prova

- Mouse/teclado de desktop, foco/movimento de janelas, lançamento de apps,
  DPMS, mídia, luzes e lock não foram acionados na sessão humana. A política da
  máquina proíbe esses efeitos incidentais. Não foi criado um backend alternativo
  que fingisse ser esse compositor apenas para alegar aceitação.
- Shutdown/reboot/suspend reais não foram executados. A confirmação e o request
  foram validados sem desligar a máquina do usuário.
- Screenshot/stream do compositor humano não foram capturados. A política exige
  bancada e não autoriza usar essa sessão como alvo de teste. Esses comandos têm
  pixels sintéticos e testes de arquivo/transporte, não aceitação live aqui.
- Upload/download/play/stop e ditado têm integração sintética. `audio list` foi
  real, mas não basta para certificar gravação/transcrição/reprodução. Não houve
  upload persistente de teste sem endpoint público de exclusão, envio a provedor
  de STT ou interrupção de áudio do usuário.
- Fluxos de serviço/pareamento/telefone legados não foram repetidos no aparelho
  pessoal. Os testes existentes verificam compatibilidade sem efeitos físicos.
- Idioma, orientação, zoom e UI de gravação do Android não são APIs de servidor.
  Wake-on-LAN para PC desligado continua função do cliente Android. Estes limites
  são documentados, não comandos ausentes disfarçados de implementados.

Portanto, a melhoria CLI foi observada no fluxo de trabalho real e no transporte
instalado. A aceitação dos efeitos ligados à sessão humana/hardware é **parcial
por restrição de ambiente**, não completa nem substituída por mocks.

O [Ponte Desktop](desktop-acceptance.md) tem aceitação própria com Android
emulado/scrcpy reais. Essa prova não é usada para afirmar que `ponte ctl`
controlou a sessão humana.

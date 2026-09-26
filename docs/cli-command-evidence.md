# CLI Ponte: mapa de comandos e evidências

## Escopo e método

- Base de leitura: `27c1d4b`, em 26/09/2026, versão `0.1.0-alpha.19`. Revisão final incorporou `2d1e11d`. Nomes dos testes são a referência principal, linhas antigas podem ter se deslocado.
- Objetivo: auditar os **59 nomes** de `bin/ctl-catalog.mjs:64-194`, relacionar comportamento público e testes existentes, sem confundir request aceito com efeito comprovado.
- O mapeamento começou por inspeção estática de um worker. O coordenador revisou e integrou a matriz com as execuções reais registradas em [aceitação](cli-acceptance.md), sem confundir teste sintético com efeito físico.
- `AGENTS.md` e `CLAUDE.md` já estavam não rastreados no início e não foram alterados. O workflow terminal pelo serviço instalado foi concluído pelo coordenador, preservando o terminal preexistente.
- Fontes principais: `bin/ctl-catalog.mjs`, `bin/ponte-ctl.mjs`, `bin/ctl-client.mjs`, `server.mjs`, `backend/desktop.mjs`, `backend/terminals.mjs`, `backend/audio.mjs`, `tests/ctl.test.mjs`, `tests/ctl-client.test.mjs`, `docs/cli.md` e `docs/cli-plan.md`.

### O que cada nível quer dizer

| Nível | Evidência existente no código dos testes | O que não prova |
| --- | --- | --- |
| **synthetic** | Validação pura, dry-run, respostas/estado/efeitos fornecidos por fixtures. | Efeito no desktop, áudio ou transcrição reais. |
| **integration** | Processo público `python3 ponte ctl` → Node → HTTP local → `createApp`/roteador verdadeiro, com adapters sintéticos. Testes do cliente também integram sockets HTTP/HTTPS, TLS e arquivos reais com servidor fixture. | Aceitação no serviço instalado ou funcionamento físico do efeito substituído. |
| **real isolado** | Um teste usa `createTerminals`, tmux e shell reais, HOME e socket privados, através do CLI e roteador. | Instalação/ambiente do serviço em uso, GUI humana ou telefone. Pode ser skipped se tmux não existir. |
| **real instalado** | Workflow executado pelo coordenador contra o serviço instalado alpha.19, com antes/depois e sentinela observável. | Não prova efeitos GUI/hardware, telefone ou todas as famílias. Resultado atribuído ao coordenador. |

Na tabela, **I/S** = integration no caminho público, efeito/estado synthetic. **R isolado** = também existe teste real isolado. A coluna dos testes classifica casos existentes. A matriz **Live** separada abaixo registra a aceitação atual do coordenador, sem promover outros efeitos a aceitação completa.

### Matriz live atual: complemento dos níveis por comando

| Referência | Comandos / outputs observados no serviço instalado | Nível atual |
| --- | --- | --- |
| LQ | `health`, `state`, `capabilities`, `windows`, `workspaces`, `monitors`, `volume`, `lights`, `session`, `textinput`, `power`, `terminals list`, `audio list`: 13 consultas passaram com exit 0. Servidor alpha.19, state com `warningCodes:[]`. | **real instalado**, leitura |
| LT | `terminals create`: criou 90x28, preservando 1 terminal preexistente. `terminals input`: Unicode sem Enter não executou. `terminals key Enter`: produziu linha sentinela exata observada por `terminals read`. `terminals resize`: releitura confirmou 100x30. `terminals remove` sem yes retornou 2/CONFIRMATION_REQUIRED mantendo alvo, com yes removeu. Read posterior retornou 6/TERMINAL_NOT_FOUND, `terminals list` voltou ao baseline. Workflow em 0,98 s. | **real instalado**, 7 comandos terminal, exceto dictate |
| LS | HTTPS real com CA/token selecionados: `health` e `terminals list` exit 0, certificados verificados. `config` público também executado. Nenhum segredo impresso. | **real instalado**, transporte e descoberta |
| LP | 20 processos `schema` offline: mediana 58 ms, p95 63 ms, máximo 64 ms. Após ajustes, 66 testes CLI verdes e 181 Node verdes, 1 opcional pulado. | **real**, startup local e suítes executadas |
| LB | Todos os demais nomes da tabela, incluindo `terminals dictate`, áudio com efeitos, desktop, energia, luzes, lock, screenshot e stream. | **integration/synthetic**, live bloqueado ou não exercitado, sem claim de aceitação completa |

Fontes publicadas: [terminal](evidence/cli-installed-terminal.json), [queries](evidence/cli-installed-queries.json), [TLS](evidence/cli-installed-tls.json). São resultados dos subprocessos executados pelo coordenador contra o serviço instalado, sanitizados para não publicar conteúdo pessoal.

## Contrato público comum a todos os 59 comandos

Entrypoint: `./ponte ctl [opções globais] <nome> [parâmetros]`. O Python troca o processo por Node em `ponte:919-939`, preservando sinais/exit. Falta do Node produz `NODE_UNAVAILABLE`, exit 3. Não há prompt.

- **Sucesso / exit 0**: um JSON em stdout, `{"schemaVersion":1,"ok":true,"data":...}`. A coluna saída da tabela descreve `data`, não o envelope externo.
- **Falha**: `{"schemaVersion":1,"ok":false,"error":{"code":"...","message":"...","status":...}}`. `status` só aparece quando disponível. A CLI preserva dados JSON retornados pela API, não inventa um schema completo para cada resposta.
- **E**, usado na tabela: exit **1** inesperado local, **2** uso/parâmetro/config/arquivo/confirmação, **3** conexão/TLS, **4** timeout, **5** autenticação/autorização, **6** API/redirect/resposta inválida, **130** interrupção. Todos os comandos de rede compartilham E, além das particularidades indicadas. Exit 0 prova sucesso da operação HTTP segundo o cliente, não que um app externo terminou seu trabalho.
- **Evidência de exits**: `ctl.test.mjs:78-94` checa envelope e exit em cada fluxo, `:337-400` exit 2 sem requests, `:499-514` exits 5/6, `:516-527` exit 4 e resultado incerto, `:529-535` campo ausente exit 6. `ctl-client.test.mjs:67-78,227-310,354-384,431-463,490-529` cobre contrato, conexão/TLS, deadlines e cancelamento. Sinais recebidos pelo subprocesso CLI não têm caso explícito próprio em `tests/ctl*.test.mjs`.
- `--dry-run` devolve `{dryRun:true,requiresConfirmation,method,path,...}` sem conectar nem ler token/config. `text` e `password` ficam `[REDACTED]`. Entrada textual por stdin/arquivo ainda precisa ser lida e validada. Upload em dry-run **não lê o áudio**. `--url` explícita ainda é validada.
- `--yes` é obrigatório para `power suspend`, `power reboot`, `power off`, `terminals remove`, inclusive aliases genéricos. A ausência falha com `CONFIRMATION_REQUIRED`/2 antes de ler entrada ou conectar. Dry-run dispensa `--yes` e anuncia a necessidade. Outras mutações também podem interromper o dono, mesmo sem essa flag.
- `--timeout` 1..120000 ms, padrão 15000, stream usa `max(15000, duração+5000)` salvo override. Stdin tem deadline separado de 15 s. Sem retry e sem redirects. Timeout/interrupção de POST/DELETE avisa que a ação pode ter chegado ao servidor: observar antes de repetir.
- `health` não envia token. Demais requests usam Bearer lido de arquivo regular privado `0600`, do usuário, não symlink, limitado e validado. HTTP só em loopback literal/localhost, remoto só HTTPS com CA e hostname verificados. `--url` + `--token-file` independem da configuração local.
- Arquivos binários exigem `--output` diferente de `-`, novo, criado `0600`, sem sobrescrita/symlink. Retorno `{output:<absoluto>,bytes,contentType}`, mais `durationMs` para stream. Falha limpa só o parcial que a própria requisição criou. Respostas até 32 MiB, stream até 128 MiB.
- IDs terminal: 24 caracteres hexadecimais minúsculos. IDs áudio: UUID v4 minúsculo. Texto até 4000 caracteres. `terminals input` é uma linha, sem controles, com remoção de uma quebra final de stdin/arquivo. `keyboard text` pode conter quebras de linha, que podem executar num terminal mesmo sem `--enter`.
- `--stdin`, `--file` e `--text` são fontes alternativas, não combináveis. Senha de unlock só por stdin, até 256 caracteres, nunca argv/arquivo. `--enter` default falso nas entradas de texto e ditado terminal.

## Índice dos testes concretos

Todos os caminhos abreviados `ctl.test.mjs` e `ctl-client.test.mjs` nesta seção e na tabela estão em **`tests/`**.

| Código | Teste, localização exata e asserção útil |
| --- | --- |
| Q | `ctl.test.mjs:302-316`, `ctl authenticated queries return the selected JSON fields and unauthenticated health omits the token`: compara campos escolhidos com `STATE`, auth presente nas demais consultas, ausente em health. |
| A | `ctl.test.mjs:318-335`, `ctl sends every named action to the real router with only synthetic effects`: para cada linha de `ACTION_CASES:181-214`, exige `data={ok:true}` e último `f.calls` exatamente `{kind:'action',value:{type,...params}}`. Também verifica cinco aliases. |
| D | `ctl.test.mjs:283-300`, `ctl dry-run validates every named action and all server aliases without network or credentials`: corpo redigido e confirmação, com endpoint/credenciais indisponíveis. |
| C | `ctl.test.mjs:337-353`, `ctl confirmation blocks destructive named and generic commands before requests`: exit 2, zero requests/calls sem `--yes`, dry-run não age, remove confirmado chega ao adapter. |
| V | `ctl.test.mjs:366-401`, `ctl rejects unknown fields, mismatched JSON types, ambiguous input and invalid bounds before I/O`: amostras inválidas, exit 2 e zero requests. Não é matriz exaustiva de todos os limites de todos os comandos. |
| T | `ctl.test.mjs:403-432`, `ctl text sources preserve Unicode, default to no Enter, redact dry-run, and keep passwords off output`: stdin/arquivo, Unicode, Enter opcional, segredo não refletido, JSON genérico por arquivo. |
| L | `ctl.test.mjs:434-448`, `ctl terminal lifecycle uses opaque IDs, expected paths and explicit key or execution flags`: defaults 80x24, leitura, Interrupt, resize 120x40, recusa ID traversal/multiline antes de request. |
| U | `ctl.test.mjs:450-474`, `ctl uploads audio and transcribes safely, with terminal Enter disabled unless explicitly requested`: bytes Ogg fixture, transcrição synthetic, `?enter=0/1`, play/stop registrados, áudio inválido não enviado. |
| B | `ctl.test.mjs:476-497`, `ctl screenshot, audio download and bounded MJPEG stream keep stdout JSON and artifacts private`: compara bytes, parâmetros de recorte, duração 150 ms, MIME, modos 0600 e `OUTPUT_EXISTS`. |
| R | `ctl.test.mjs:537-567`, `ctl real isolated tmux completes create, execute, observe, resize and remove without the human desktop`: list vazio, create, comando Unicode com sentinela dividida no texto de entrada, read encontra linha produzida, resize 100x30, remove e registry vazio. Usa socket privado real. Não cobre `terminals key` ou `terminals dictate` nesse cenário real. |
| K | `ctl.test.mjs:275-281`, `ctl catalog and explicit test cases cover every desktop action and alias`: igualdade de `ACTIONS` com todos os `case` do desktop, casos explícitos para cada ação canônica e nomes sem duplicatas. É garantia de inventário, não efeito. |
| P | `ctl preserves action-specific response fields instead of reducing replies to ok`: teste acrescentado em `2d1e11d`, passa por CLI/HTTP/router com respostas sintéticas `window` objeto/null e `moved` true/false + `workspace`, preservadas em named/generic actions. Passou na suíte de 66 testes. |

Fixture importante: `ctl.test.mjs:35-178` limpa HOME/XDG/config/ambiente herdado, inicia `createApp` em loopback, registra requests e substitui desktop/audio/STT/Tailscale. `realTerminals:true` troca **só** o adapter terminal. O JPEG tem quatro bytes e o áudio é cabeçalho Ogg mais preenchimento: verificam transporte, não qualidade de imagem ou reprodução decodificável.

## Tabela completa: 59 nomes do catálogo

Ação **A(type)** significa `POST /api/action` com JSON `{type,...}`. Saída padrão das ações reais é `{ok:true}`, com exceções explicitadas. Sucesso de todos é exit **0**, falhas seguem **E** acima. Cada linha aponta ao caso existente específico, além dos testes comuns.

| # | Nome exato | Comportamento público: entrada, request, ação e saída `data` | Exit / confirmação | Teste concreto existente | Nível e limite |
| --- | --- | --- | --- | --- | --- |
| 1 | `health` | `GET /api/health` sem auth. `{name,requiresPairing,version,autoPair}`. Não é consulta completa de dependências. | 0 / E, sem token | Q `:304-305`; `ctl.test.mjs:512-513`; `ctl-client.test.mjs:91-109` | I/S. Rota real, disponibilidade da instalação não verificada aqui. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 2 | `state` | `GET /api/state`. Estado completo do desktop, warnings, capacidades, versão acrescentada pelo servidor. | 0 / E | Q `:306`; `ctl.test.mjs:499-511` induz 503/401 | I/S, `STATE` é fixo. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 3 | `capabilities` | `GET /api/state`, seleciona `.capabilities`, servidor acrescenta `stt`. | 0 / E, campo ausente gera 6 | Q `:310` compara capacidades com `stt:true` | I/S, não prova ferramentas instaladas. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 4 | `windows` | `GET /api/state`, retorna `.windows`, array de janelas com endereços/alvos. | 0 / E | Q `:307-309`, caso `windows` | I/S. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 5 | `workspaces` | `GET /api/state`, retorna `.workspaces`, IDs e monitores. | 0 / E | Q `:307-309`, caso `workspaces` | I/S. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 6 | `monitors` | `GET /api/state`, retorna `.monitors`, geometria/foco/workspace/DPMS. | 0 / E | Q `:307-309`, caso `monitors` | I/S, nenhum DPMS físico observado. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 7 | `volume` | `GET /api/state`, retorna `.volume` com valor e mute. | 0 / E | Q `:307-309`; `ctl.test.mjs:529-535` campo ausente→6 | I/S. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 8 | `lights` | `GET /api/state`, retorna `.lights`, estado e presets. | 0 / E | Q `:307-309`, caso `lights` | I/S, controlador RGB não chamado. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 9 | `session` | `GET /api/state`, retorna `.session`, lock e disponibilidade. | 0 / E | Q `:307-309`, caso `session` | I/S, não verifica lock humano. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 10 | `textinput` | `GET /api/textinput`, `{available,focused}`. Backend consulta foco via fcitx5, pode retornar `focused:null` indisponível. | 0 / E | Q `:311` compara `{available:true,focused:true}` | I/S, ramo indisponível não exercitado pelo caso CLI. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 11 | `power` | `GET /api/power`, `{monitors,power,wakeOnLan}`. Informa WoL, não envia pacote de wake. | 0 / E | Q `:312` compara os três campos | I/S. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 12 | `mouse move` | `--dx/--dy` -1000..1000. A(`mouse.move`), deslocamento relativo via ydotool, arredondado no backend. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:182` (-10,20); V `:369` (>1000) | I/S, sem ponteiro real. |
| 13 | `mouse click` | `--button` left/right/middle. A(`mouse.click`), clique no ponteiro atual. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:183` (right) | I/S, só um botão no fluxo happy path. |
| 14 | `mouse click-at` | `--monitor --x --y --button`. Pixels inteiros 0..32767, backend valida geometria, posiciona e clica. A(`mouse.clickAt`), `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:184`; V `:370` rejeita x fracionário | I/S, posicionamento/resultado visual não provados. |
| 15 | `mouse move-to` | `--monitor --x --y`, pixels inteiros. A(`mouse.moveTo`), posiciona ponteiro absoluto. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:185` (TEST-1,10,20) | I/S. |
| 16 | `mouse scroll` | `--dy` -30..30. A(`mouse.scroll`), roda ydotool, valor arredondado. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:186` (-3) | I/S. |
| 17 | `mouse drag` | `--pressed` boolean. A(`mouse.drag`), segura/solta botão esquerdo, backend tem timer de liberação. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:187` (`false`); V `:378` boolean inválido | I/S. Happy path CLI só solta, não testa hold real. |
| 18 | `mouse drag-start` | `--monitor --x --y`, `--modifier super` opcional. A(`mouse.dragStartAt`), posiciona/segura, pode segurar Super. **Real retorna `{ok:true,window:<janela ou null>}`**. | 0 / E | A+D, `ACTION_CASES:188` (super) | I/S. A usa `{ok:true}`. P verifica adicionalmente `window` objeto/null sem alterar payload. Efeito visual segue não observado. |
| 19 | `keyboard text` | Uma fonte de texto, `--enter` default false. A(`keyboard.text`), wtype Unicode no foco, Enter opcional, preserva multiline. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:189`; T `:405-420`; V `:388-390` | I/S, nenhum campo de app real observado. |
| 20 | `keyboard key` | `--key` enum do catálogo. A(`keyboard.key`), key/chord via ydotool. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:190` (Copy); V `:371` (F24 inválida) | I/S, não cobre todas as teclas reais. |
| 21 | `workspace focus` | `--id` 1..100, `--monitor` opcional. A(`workspace.focus`), Hyprland muda workspace, pode posicionar ponteiro para workspace novo. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:191`; V `:372` (id 0) | I/S. Range CLI não é permissão para usar workspaces humanos. |
| 22 | `window focus` | `--address` hexadecimal 0x. A(`window.focus`), backend exige janela existente e foca. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:192`; V `:373` endereço inválido | I/S, janela fechada não testada por esse fluxo. |
| 23 | `window move` | `--address --id` 1..100. A(`window.moveToWorkspace`), move sem seguir, libera drag. **Real `{ok:true,moved:boolean,workspace:id}`**, false se já no alvo. | 0 / E | A+D, `ACTION_CASES:193` (id 7) | I/S. P cobre `moved` true/false e `workspace` no retorno named/generic. Sem prova física de follow=false. |
| 24 | `volume set` | `--value` 0..1. A(`volume.set`), wpctl no sink padrão. `{ok:true}`. | 0 / E, timeout pode ter aplicado | A+D, `ACTION_CASES:194`; V `:375`; `ctl.test.mjs:516-527` timeout sem retry | I/S, volume audível não exercitado. |
| 25 | `volume mute` | Sem parâmetros. A(`volume.mute`), **toggle**, não setter idempotente. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:195` | I/S. |
| 26 | `media toggle` | A(`media.toggle`), tecla play/pause do sistema. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:196` | I/S, nenhum player observado. |
| 27 | `media next` | A(`media.next`), tecla próxima faixa. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:197`; V `:374,383-386` campos/JSON inválidos | I/S. |
| 28 | `media previous` | A(`media.previous`), tecla faixa anterior. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:198` | I/S. |
| 29 | `app launch` | `--app` browser/terminal/files. A(`app.launch`), `systemd-run --user` chama launcher Omarchy. `{ok:true}` não garante janela pronta. | 0 / E | A+D, `ACTION_CASES:199` (terminal) | I/S, browser/files não lançados pelo teste CLI. |
| 30 | `monitors set` | `--monitor`, `--enabled` boolean ou `--state` on/off, ambos devem concordar. A(`power.dpms`), DPMS de um monitor. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:200`; aliases A `:329-334`; V `:376` | I/S. Aliases `screen.dpms`, `monitor.dpms`. |
| 31 | `monitors all` | `--enabled` ou `--state`, concordantes. A(`power.dpms_all`), DPMS de todos monitores. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:201`; V `:377` contraditório | I/S, pode apagar todas as telas na instalação real. |
| 32 | `power sleep` | A(`power.sleep`), apaga monitores e luzes, **mantém PC ligado**. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:202`; alias em A `:329-334` | I/S. Alias `power.smart_sleep`, não suspend. |
| 33 | `power wake` | A(`power.wake`), restaura DPMS/luzes com PC já ligado. `{ok:true}`. Não acorda servidor desligado. | 0 / E | A+D, `ACTION_CASES:203`; alias em A `:329-334` | I/S. Alias `power.restore`. |
| 34 | `power suspend` | A(`power.suspend`), chama systemctl suspend. `{ok:true}` se resposta completar, desconexão pode ser ambígua. | 0 / E, **`--yes`** | A+D, `ACTION_CASES:204`; C `:339-350` | I/S, suspensão física deliberadamente não testada. |
| 35 | `power reboot` | A(`power.reboot`), chama systemctl reboot. `{ok:true}` se resposta completar. | 0 / E, **`--yes`** | A+D, `ACTION_CASES:205`; C `:339-350` | I/S, reboot real bloqueado. |
| 36 | `power off` | A(`power.off`), chama systemctl poweroff. `{ok:true}` se resposta completar. | 0 / E, **`--yes`** | A+D, `ACTION_CASES:206`; C `:339-350`; `ctl.test.mjs:355-364` confirmação antes de arquivo | I/S. Alias `power.poweroff`, shutdown real bloqueado. |
| 37 | `lights preset` | `--preset` lava/brasa/oceano/aurora/floresta/lua. A(`lights.preset`), aplica no controlador. `{ok:true}`. | 0 / E, indisponibilidade API→6 | A+D, `ACTION_CASES:207` (aurora) | I/S, nenhum preset RGB físico observado. |
| 38 | `lights sleep` | A(`lights.sleep`), controlador apaga luzes. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:208` | I/S. |
| 39 | `lights restore` | A(`lights.restore`), restaura estado salvo das luzes. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:209` | I/S. |
| 40 | `lights reapply` | A(`lights.reapply`), reaplica estado atual no hardware. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:210` | I/S. |
| 41 | `lights screen` | `--enabled` boolean. A(`lights.screen`), liga/desliga tela do gabinete, **não monitor desktop**. `{ok:true}`. | 0 / E | A+D, `ACTION_CASES:211` (false) | I/S. |
| 42 | `session lock` | A(`session.lock`), `omarchy-system-lock`. `{ok:true}`. | 0 / E, sem `--yes` automático | A+D, `ACTION_CASES:212` | I/S, lock real não iniciado. |
| 43 | `session unlock` | `--stdin` senha, remove uma quebra final. A(`session.unlock`), exige lock confirmado, acorda monitores, digita senha e Enter. `{ok:true}` **não confirma PAM/unlock final**. | 0 / E, senha fora de argv | A+D, `ACTION_CASES:213`; T `:421-427`; V `:391-392`; `:355-364` | I/S, fake password no adapter, sem senha/lock reais. |
| 44 | `terminals list` | `GET /api/terminals`, `{available,sessions,limit}` (limite 4). Sessions incluem id/title/cols/rows/inMode/attachCommand. | 0 / E | Q `:313`; R `:540,563` | I/S + R isolado. No backend, GET pode inicializar diretório/limpar registry obsoleto. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 45 | `terminals create` | `POST /api/terminals`, cols 20..240 default 80, rows 8..100 default 24. HTTP 201, summary com ID novo. Shell do usuário em socket privado. | 0 / E, limite/indisponibilidade API→6 | L `:436-438`; R `:541-545` | I/S + R isolado. Privado não significa sandbox. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 46 | `terminals read` | `GET /api/terminals/:id`, summary + `text`, captura desde 300 linhas de histórico, com cauda UTF-8 até 64 KiB. Não usa screenshot GUI. | 0 / E | L `:439,445`; R `:552-561` | I/S + R isolado, sentinela comprova execução no teste existente. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 47 | `terminals input` | `POST /api/terminals/:id/input`, `{text,enter:false}` default. Uma linha literal, Enter só explícito. `{ok:true}`. | 0 / E, copy mode/alvo inválido API→6 | T `:411-417`; L `:446-447`; R `:548-558` | I/S + R isolado, `--enter` executa shell no teste. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 48 | `terminals key` | `POST /api/terminals/:id/input`, `{key}` do enum terminal incluindo Interrupt, não aceita texto junto. `{ok:true}`. | 0 / E | L `:440-441` (Interrupt) | I/S apenas. Caso R não chama esse comando. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 49 | `terminals resize` | `POST /api/terminals/:id/resize`, `--cols` 20..240, `--rows` 8..100 obrigatórios. `{ok:true}`. | 0 / E | L `:442-443`; R `:559-561` observa 100x30 | I/S + R isolado. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 50 | `terminals remove` | `DELETE /api/terminals/:id`, mata somente sessão endereçada e remove registry. `{ok:true}`. | 0 / E, **`--yes`** | C `:339-352`; R `:562-566` | I/S + R isolado. Não remover sessão preexistente do dono. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 51 | `terminals dictate` | Upload `POST /api/terminals/:id/dictate?enter=0` default, `1` com `--enter`. Transcreve e digita no terminal. `{ok:true,text,entered,provider}`. | 0 / E | U `:458-463` checa query exata e ações text/Enter | I/S. STT e terminal sintéticos, nenhum áudio real transcrito. |
| 52 | `audio list` | `GET /api/audio`, `{recordings:[{id,name,createdAt,size,mime}]}`. | 0 / E | Q `:314` compara ID fixture | I/S, store real não listado pelo teste CLI. **Live: real instalado, LQ/LT/LS conforme matriz acima.** |
| 53 | `audio upload` | `--file`, `--mime` opcional. `POST /api/audio` bytes raw. WebM/Ogg/MP4/M4A/WAV até 25 MiB, assinatura local e mídia validada no backend. HTTP 201, `{ok:true,recording}`. | 0 / E, arquivo inválido→2 antes de HTTP | U `:452-454,468-473` | I/S. Não comprova ffprobe/store durável real. |
| 54 | `audio download` | `--id --output`. `GET /api/audio/:id`, grava bytes, retorna `{output,bytes,contentType}`. | 0 / E, arquivo existente→2 | B `:483-486,494`; `ctl-client.test.mjs:312-405` | I/S + I/O real de fixture, não gravação real. |
| 55 | `audio play` | `POST /api/audio/:id/play`, interrompe playback anterior do store e inicia áudio no PC. `{ok:true}` após spawn, não após terminar reprodução. | 0 / E | U `:464-465` registra ID | I/S, não produz som real. |
| 56 | `audio stop` | `POST /api/audio/stop`, para processo de playback do store se existir. `{ok:true}`. | 0 / E | U `:466-467` registra stop | I/S, processo de áudio é stub. |
| 57 | `dictate` | `--file`, MIME inferido/opcional. `POST /api/dictate`, transcreve sem digitar. `{ok:true,text,provider}`. Áudio não é guardado como recording dessa rota. | 0 / E | U `:455-457` texto/provider e ausência de terminal.input | I/S, provider `synthetic`. |
| 58 | `screenshot` | `GET /api/screenshot`, `--monitor` opcional, `--scale` .2..1 default .65, `--output` obrigatório. JPEG em arquivo, `{output,bytes,contentType}`. | 0 / E, stdout binário proibido/arquivo existente→2 | B `:478-482,494-496`; V `:382`; `ctl-client.test.mjs:312-405` | I/S. JPEG fixture, nenhum grim/compositor humano. |
| 59 | `stream` | `GET /api/stream`. `--output`; fps 1..20 default 10, scale .2..1 default .5, quality 30..90 default 65 mapeia `q`, monitor opcional. Crop exige x/y/w/h juntos. Seconds .1..60 default 5 é duração local, não query. Arquivo multipart MJPEG, `{output,bytes,contentType,durationMs}`. | 0 / E, timeout/cancelamento não são sucesso | B `:487-494`; V `:381`; `ctl-client.test.mjs:405-487` | I/S + escrita incremental real de fixture. Sem fps/qualidade/latência de monitor real. |

**Contagem:** 11 consultas iniciais + 32 ações desktop + 8 terminais + 5 áudio + dictate + screenshot + stream = **59**. São 37 tipos de ação aceitos na forma genérica: 32 canônicos e 5 aliases. Os aliases não adicionam nomes à tabela.

### Superfícies públicas fora dos 59

Não somar `help`, `schema`, `config`, `version` ou `action TYPE` aos descritores de `COMMANDS`:

- `help` textual, `help --json`, `schema [nome]`, `schema action [tipo]` e `version`: `ctl.test.mjs:218-237`, offline com configuração/credenciais ausentes. `schema` inclui comandos, globais, exits, sintaxe genérica e referências ao legado.
- `config`: `ctl.test.mjs:239-273`, allowlist de caminhos/listeners sem segredo e `CONFIG_ERROR`/2 redigido. Não é necessariamente offline sem config, pois lê configuração.
- `action TYPE`: mesmos validadores/confirmations, JSON estrito via `--data`, stdin ou arquivo, unlock só JSON stdin. Cobertura D/A/C/V/T, inclusive todos aliases. Não é uma API de shell genérico.
- Administração, `pc`, `phone`, `desktop`, build nativo e estado local Android/UI permanecem interfaces separadas. `docs/cli.md:260-285` documenta essa fronteira. Orientação, zoom, idioma, permissões e WoL originado no Android não ganham endpoints fictícios por existirem 59 comandos de servidor.

## Evidências transversais de transporte

Estes testes existem em `tests/ctl-client.test.mjs`. Eles complementam todas as linhas de rede, mas não exercitam cada combinação de comando/erro:

| Requisito técnico | Caso concreto / linhas | Nível e limite |
| --- | --- | --- |
| Config e compatibilidade de descoberta | `explicit endpoint and token bypass malformed or explicitly missing user config` `:80-89`; settings via XDG/PONTE_CONFIG/overrides `:168-185`; IPv6 `:187-192` | integration com config temporária. |
| Segredos e credenciais | Lazy token/health `:91-109`; token rejeita symlink/mode/tamanho/formato `:111-143` | integration de arquivos + HTTP fixture. |
| URLs e input do transporte | Origins disfarçadas `:145-166`; request JSON/string/buffer `:194-210`; request inválida sem rede `:212-225` | synthetic e integration, sem Tailscale real. |
| Diagnóstico seguro e sem retry | Erros HTTP com allowlist `:227-249`; redirects `:251-256`; body de erro truncado `:258-267`; deadline `:269-284`; indisponível `:286-293` | integration de sockets fixture, no máximo uma chamada nos casos assertados. |
| Resposta inválida e limites | JSON/MIME/tamanho `:295-310`; tamanho declarado antes de criar output `:333-352`; chunks reais até exceder limite `:465-487` | integration, não benchmark de RSS/CPU. |
| Artefatos privados e cancelamento | Download exclusivo 0600/symlink `:312-331`; parcial/transporte/deadline `:354-369`; AbortSignal `:371-384`; replacement file/symlink `:386-403` | integration de filesystem e rede locais. |
| Stream finito | Timer escreve incrementalmente `:405-429`; vazio/interrupção prematura/timeout `:431-448`; cancel externo `:450-463` | integration, frames synthetic. |
| HTTPS verificado | `HTTPS keeps certificate verification, accepts explicit CA and scopes config CA to its exact origin` `:490-529`: CA local via OpenSSL, CA desconhecida, hostname errado, CA ausente, escopo de CA, `NODE_TLS_REJECT_UNAUTHORIZED=0` não desabilita verificação | integration TLS local, não caminho remoto da instalação. |

## Requisitos do usuário: rastreabilidade e plano

| Requisito | O que já existe e onde conferir | Limite honesto / próximo check |
| --- | --- | --- |
| **Auditar e planejar antes de agir** | `docs/cli-plan.md:3-61` registra inventário, decisões, cobertura e critérios. Este arquivo amarra cada nome aos contratos/testes, sem efeitos. | Plano escrito e inspeção não provam execução. Coordenador agrega resultado atual do workflow no serviço instalado. |
| **Funções completas** | 59 nomes, 32 ações e 5 aliases. K impede ação desktop sem descritor/caso, Q/L/U/B cobrem outras rotas. Implementação reaproveita API existente. | Completude é da superfície do servidor, não de todas preferências UI/Android. K compara `case` desktop, não é verificador automático de todas as rotas HTTP. P verifica campos especiais de drag/window move. Todas as combinações de teclas/botões/presets e falhas de domínio não têm matriz exaustiva em ctl*. |
| **Informação e comandos fáceis para agentes** | `help/schema/version`, JSON versionado, exits, opções explícitas, `config` redigida, IDs, dry-run e sem prompts. Testes `:218-273`, D/C/V/T. README seção Agent CLI e `docs/setup.md:68-69` apontam ao guia. | `schema` lista parâmetros mas regras conjuntas (DPMS concordante, crop completo, fontes alternativas) também vivem em validação/docs. Descoberta não oferece schema detalhado de resposta por comando. A lacuna de `legacy` sem `desktop` foi corrigida em `2d1e11d`, com asserção no teste offline e chamada pública repetida. |
| **Testes executáveis por agentes e documentação** | `npm run test:cli` inclui CLI administrativo, ctl e client. Há 19 casos top-level ctl e 27 client, além dos legados, com loops por comando. | LP: 66/66 CLI, npm181 passaram/1 skip. Android270+7 e APK fixture passaram na entrega Desktop. Nenhum teste opcional pulado é contado como aprovado. |
| **Leve e rápido** | Sem dependencies npm, transporte nativo Node e sem daemon extra. LP mediu schema offline58ms mediana,63ms p95 e64ms máximo. | Sem medição de RSS/CPU/throughput de captura/STT. JSON pode acumular32MiB e upload25MiB. Consultas selecionadas ainda chamam state completo. Timings locais não são garantia universal. |
| **Compatibilidade com app existente** | LQ/LT/LS percorreram configuração/token/HTTP/HTTPS do serviço instalado, sem restart. Regressões do legado continuam verdes. | Versões mínimas em outra máquina e efeitos físicos não validados aqui. `terminals dictate` sem Enter é escolha explícita, diferente do default da rota HTTP antiga. |

## Lacunas e aceitação live

### O que permanece bloqueado pela sessão humana

Não usar o desktop do dono como bancada, nem mesmo para produzir evidência que pareça mais forte:

- **Mouse, teclado, foco/movimento de janela/workspace e app launch:** respostas sintéticas validam payload, não observam clique/digitação/foco reais. Um endpoint apontado para o compositor humano continua humano mesmo que `--id 6` seja passado. Nunca trocar workspace/focar/warp nas áreas humanas.
- **Screenshot/stream:** não há captura real neste mapa. Exigir bancada explicitamente isolada e vaga na fila pesada para vídeo/captura longa quando houver rodada autorizada. Não capturar workspace humano para completar a tabela.
- **Volume/mídia/áudio:** não produzir som, mutar/trocar faixa ou parar playback do dono. Stubs não provam áudio decodificável, ffprobe, player ou transcrição real. Ditado precisaria de áudio de teste autorizado, provider real, texto observado e nenhuma digitação acidental.
- **DPMS/energia/luzes/lock/unlock:** nenhuma execução física. `--yes` não é autorização, retorno `{ok:true}` não observa hardware/PAM final. Suspend/reboot/off podem interromper a própria conexão e toda a sessão. Não “confirmar” esses efeitos agora.
- **Phone/GUI/Android:** nenhuma chamada a ensure/doctor/ADB/browser nesta missão. Estado local do cliente e Wi-Fi/Tailscale/ADB não foram revalidados, tampouco são requisitos do workflow terminal delegado.

### Lacunas que não devem ser escondidas pelo nome do teste

1. A prova `ctl sends every named action ...` valida payload, não execução de ydotool/wtype/hyprctl/wpctl/systemctl. P cobre agora passthrough dos outputs extras `window`, `moved`, `workspace` com respostas sintéticas. O efeito físico continua não observado.
2. O teste R é um workflow real de tmux **isolado** e condicional. Não prova config/token/ambiente/permissões/registry do serviço instalado. Não cobre `terminals key` nem `terminals dictate` em tmux real.
3. Fixtures de áudio/captura não decodificam mídia real. `audio upload` não percorre ffprobe/store real em ctl.test, nem `dictate` um serviço STT real.
4. Erros de domínio como janela fechada, monitor fora da geometria, terminal em copy mode/limite/alterado, arquivo de áudio ausente, lock indisponível e STT indisponível precisam ser cobertos pelas respectivas suítes backend ou por casos CLI adicionais. Não inferir cobertura ctl* de uma validação genérica.
5. Exits e cancelamento têm bons testes de transporte, mas não há teste explícito do subprocesso recebendo SIGINT/SIGTERM em ctl*. Documentação/pelo código não equivalem a um teste executado.
6. LP contém 66 testes CLI e181 Node aprovados após os ajustes. Native270+7 e APK fixture foram verificados na entrega Desktop, antes desses ajustes somente em discovery/asserções. LQ/LT/LS são execuções reais do serviço instalado, separadas das fixtures.
7. “GET” não é sinônimo de absolutamente nenhum efeito interno: `terminals list/read` podem inicializar diretório privado e reconciliar registry no backend. As consultas reais LQ/LT foram feitas após conferir esse comportamento, sem ler conteúdo ou alterar dimensões das sessões preexistentes.

### Workflow terminal pelo serviço instalado: concluído

LT fecha create/input/key/read/resize/remove/list no serviço instalado, incluindo ausência de Enter implícito, confirmação de remoção, erro após remoção e preservação do baseline. LQ e LS acrescentam consultas e TLS reais. Não há próxima ação pendente desse workflow. O registro está publicado em [cli-acceptance.md](cli-acceptance.md), com JSONs sanitizados em `evidence/`.

Isso fecha um workflow completo sem invadir a sessão visual do dono. Não fecha as lacunas live de efeitos desktop, áudio, STT, energia, lock, captura ou telefone.

## Verificação desta entrega

- Inventário esperado: 59 linhas numeradas, em ordem idêntica a `COMMANDS`, sem aliases contados em duplicidade.
- Referências de testes mapeiam os 59 nomes. 53 têm evidência pública I/S sem cenário R, 6 também aparecem no workflow R: list/create/read/input/resize/remove.
- Números de linhas são relativos ao checkout indicado e podem mudar se outro agente editar os arquivos.
- Verificação final: 59 nomes conferidos contra o catálogo, referências de testes revisadas, 66 casos CLI verdes e fluxo real LT/LQ/LS observado. A inspeção do worker não foi usada como substituto dessas execuções.

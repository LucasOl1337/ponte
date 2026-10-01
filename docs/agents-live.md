# Conversa dos agentes ao vivo

A conversa aberta em **Terminais → Agentes** acompanha os arquivos de Claude, Codex e JCode. O rótulo **Ao vivo** indica que a última leitura encontrou uma conversa legível. Harness sem parser continua aparecendo na contagem, mas não ganha conversa inventada.

## Protocolo de leitura

`GET /api/agents/:id/transcript` mantém o pareamento e a rota do APK atual.

- Sem `since`, devolve a janela recente completa com `reset:true` e um cursor opaco de 32 caracteres hexadecimais. Quando nenhum arquivo existe ainda, pode devolver `available:false` sem cursor.
- `?since=CURSOR&wait=10` espera até 10 segundos por mudança. O watcher verifica a cada segundo, compartilhando e serializando leituras do mesmo agente. Só há polling enquanto alguém espera.
- `unchanged:true` traz `messages:[]`. Não apague o texto exibido.
- `reset:false` traz só mensagens novas, a partir da sobreposição com a versão anterior. Acrescente à conversa local.
- `reset:true` substitui a janela. É a recuperação quando o cursor ficou velho, a sessão mudou ou houve rewrite/rotação sem sobreposição.
- Cursor não é caminho nem índice de arquivo. Quatro versões recentes ficam em memória. Reiniciar o servidor pode exigir reset.
- Cursor inválido e espera inválida dão 400. Parâmetros repetidos dão 400. `wait` aceita inteiros de um ou dois dígitos e é limitado a 10.

Seis requests de transcrição podem esperar ao mesmo tempo. O sétimo libera o mais antigo sem retransmitir mensagens. O orçamento global de leitura continua sendo dois trabalhos de IO simultâneos, incluindo leituras iniciais. Uma espera parada não reserva esse orçamento. Cancelamento do HTTP e fechamento do servidor liberam os watchers.

## Leitura e UI

O servidor guarda uma cauda em bytes limitada a 512 KiB por arquivo e até 40 mensagens na janela da API. Não lê snapshot JCode gigante inteiro. Append JSONL preserva caracteres UTF-8 e registros parciais. Antes de reutilizar bytes, confere toda a janela retida para não misturar um arquivo reescrito com o anterior. Arquivo sem mudança evita nova leitura/parsing. Rewrite de snapshot é relido, não tratado como append.

O poll confere PID/start e o arquivo de sessão do Claude/JCode individualmente, sem varrer `/proc` inteiro em cada tick. Uma sessão nova com o mesmo PID e um transcript que nasce depois de abrir a conversa são redescobertos. Arquivo removido fica indisponível, inclusive nas respostas unchanged seguintes.

A página mantém até 80 mensagens. Pausa nativa, aba oculta ou fechar a conversa cancelam o request, inclusive durante o consumo do JSON, e param o timer. A retomada usa o cursor preservado e não duplica a sequência. Respostas de uma geração anterior são descartadas. O scroll acompanha o fim só quando o leitor já estava perto dele.

## Reproduzir sem desktop real

```sh
mkdir -p .work/lab
node tools/lab/agents-panel-server.mjs .work/lab/agents-panel 8817
# Abrir a URL impressa somente em bancada isolada.
node tools/lab/agents-panel-fixture.mjs append .work/lab/agents-panel
node --test tests/agents.test.mjs tests/agents-ui.test.mjs tests/agents-transcript-events.test.mjs tests/agents-live-http.test.mjs
npm test
```

O lab usa `createApp` e scanner reais com arquivos/processos sintéticos, token público só de loopback e desktop/entrada bloqueados. O teste HTTP cobre espera real, delta, auth, query e orçamento IO. Os testes de watcher cobrem concorrência, cancelamento e encerramento. Os testes backend cobrem UTF-8 parcial, rewrite/regrow, rotação, troca de sessão e desaparecimento de arquivo.

Envio ao Maestri **não faz parte desta mudança**. Continua só leitura até revisão da proposta e autorização da ponte.

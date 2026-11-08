# Ponte Remoto com Gliff

Ponte Remoto abre o cliente nativo **Gliff upstream** para controlar outro computador Omarchy por SSH. Não há fork, codec novo, conta nova, porta pública ou cópia de credenciais. O celular, o servidor Ponte e a página web continuam como antes.

## Abrir e escolher

```sh
./ponte rd --install                 # adiciona/atualiza Ponte Remoto no menu
./ponte rd                           # escolhe aparelho, alias SSH e motor
./ponte rd notebook                  # também aceita ssh:notebook ou nome configurado
./ponte rd --list                    # JSON, sem rede nem janela
./ponte rd notebook --check          # preflight SSH, sem captura, entrada ou janela
```

No menu, abra **Ponte Remoto**, selecione a linha do computador e clique **Conectar**. Cancelar não inicia conexão. A lista mostra os aliases concretos de `~/.ssh/config`, incluindo `Include`, e os nomes opcionais de `ssh.hosts` na configuração Ponte. Aliases alternativos de um mesmo `Host` compartilham uma linha. Padrões como `Host *` não viram destinos. A lista inclui candidatos SSH, não uma promessa de compatibilidade: servidores sem Hyprland são recusados no preflight.

Para nomes amigáveis, preserve as demais propriedades do seu config e use o formato já aceito pelo Ponte:

```json
{"ssh":{"hosts":[{"host":"notebook","label":"Meu notebook"}]}}
```

O destino deve existir nessa lista local. Não são aceitos `user@host`, endereços avulsos ou opções SSH digitadas como destino. `ssh:ALIAS` desambigua nomes repetidos. `ssh.hosts` também permite declarar um alias vindo do config SSH de sistema.

## Dependências e conexão

- **Gliff 0.4.x**, testado com **0.4.1**, nas duas máquinas. Instale pelo upstream, por exemplo `omarchy pkg add gliff` no canal Omarchy que oferece o pacote. Se indisponível, siga [a instalação upstream](https://github.com/omacom/gliff#install), sem baixar binários de terceiros.
- OpenSSH e autenticação por chave/agente já funcionando para o alias.
- Hyprland com sessão ativa no computador controlado. Não é cliente genérico RDP, Windows ou macOS.
- `zenity` para a lista gráfica. Sem ele, um terminal interativo oferece seleção textual. Sem interface nem terminal, a CLI pede um destino explícito.

O cliente Gliff declara Hyprland nas duas pontas. O funcionamento de um cliente em compositor aninhado de bancada é evidência de teste, não garantia geral de suporte a outros desktops. A GPU/video pipeline é a do upstream. NVIDIA pode usar CPU. Não há ganho de desempenho numérico prometido neste corte.

O preflight verifica versão local, config efetivo SSH, login, `gliff-server --version` e `hyprctl instances -j`. Não captura, move ponteiro nem digita. Alias com `RemoteCommand` é recusado: use uma rota SSH direta. Timeout, chave desconhecida/alterada, autenticação, dependência ausente e sessão Hyprland inexistente produzem erro. Não se instala nada automaticamente e **nenhuma falha abre o legado por conta própria**.

## Usar a sessão

```sh
./ponte rd notebook --monitor DP-1      # repassa --output ao Gliff
./ponte rd notebook --headless         # saída privada dentro da sessão remota
./ponte rd notebook --no-clipboard     # sem clipboard compartilhado
./ponte rd notebook --video cpu        # opção explícita do upstream
```

`Shift+Esc` devolve os atalhos ao computador local. Reconexão e controle de vídeo são do Gliff. Fechar sua janela encerra a sessão do cliente. Para trocar de computador, abra Ponte Remoto novamente. O botão `+` do Gliff não pode contornar a seleção: o transporte desta janela aceita somente seu alias selecionado.

**`--headless` não é uma barreira de segurança.** Ele cria uma saída privada na sessão Hyprland existente, que ainda pode compartilhar teclado/foco com outras saídas. Agentes não devem usá-lo contra o desktop humano como se fosse bancada isolada.

Ponte inicia cada janela com configuração Gliff temporária. As abas pessoais de `~/.config/gliff` não são lidas, reabertas nem modificadas. O tema Omarchy permanece disponível por referência ao diretório de tema existente. Config temporária é removida ao terminar normalmente. Uma interrupção forçada do processo pode deixar um diretório `ponte-gliff-*` temporário sem segredos de autenticação. Clipboard/cache seguem o comportamento do upstream, salvo `--no-clipboard`.

## Confiança SSH

Ponte não altera `~/.ssh/config`, `known_hosts`, chaves ou agentes. O alias original chega ao OpenSSH como um argumento, preservando usuário, porta, identidade e ProxyJump configurados localmente. Só comandos fixos ou caminhos restritos chegam ao shell remoto.

Gliff upstream pode oferecer trust-on-first-use com `accept-new`. Para não introduzir essa mudança de confiança, `desktop/rd-bin/ssh` é colocado no `PATH` **somente do subprocesso Gliff**. Ele delega ao SSH real encontrado no preflight com `StrictHostKeyChecking=yes` e `BatchMode=yes` antes dos argumentos upstream. Aplica a mesma política em `ssh -G`, conexão e reconexão. Restringe o alias e as opções ao contrato conhecido. Não é um substituto global do SSH.

Uma chave desconhecida ou alterada exige verificação humana fora do launcher. Confira a identidade do host e resolva a confiança por `ssh ALIAS` antes de tentar novamente. Nunca use `StrictHostKeyChecking=no` para contornar isso. A configuração SSH local continua sendo configuração confiável do operador, inclusive `ProxyCommand` e `Match exec` que ele próprio tiver definido.

Atualizações futuras do Gliff que alterem argv/versão podem ser recusadas explicitamente. Nesse caso atualize e teste o adaptador, não remova a política e não faça fallback silencioso.

## Web legado e celular

```sh
./ponte rd --engine legacy             # seletor de aparelhos já existente dentro da página
./ponte rd notebook --engine legacy    # nome/id do aparelho pareado no Ponte
./ponte rd self --engine legacy
./ponte rd notebook --print-url        # pedido explícito do caminho web, compatível
```

O seletor nativo também oferece a linha **Web legado**. Ela abre o cliente Chromium original, com perfil próprio e seus aparelhos pareados. O caminho usa serviço/token Ponte, ao contrário do Gliff. `--print-url` imprime a chave de pareamento no fragmento: não compartilhe a saída. `--engine gliff --print-url` e misturas de opções nativas com legado são erros.

Nenhum arquivo de UI mobile, shell Android ou servidor de vídeo foi alterado por esta integração. Não é necessário APK novo nem reiniciar `ponte-remote.service`.

## Prova isolada e testes

Para uma bancada com compositor remoto realmente separado, a CLI aceita:

```sh
./ponte rd notebook --server-bin /caminho/absoluto/gliff-server-private --check
./ponte rd notebook --server-bin /caminho/absoluto/gliff-server-private --no-clipboard --video cpu
```

O wrapper deve validar seu runtime/compositor de forma fail-closed e suportar `--version`, retornando `gliff-server 0.4.x` sem iniciar captura. Com wrapper explícito o preflight não consulta o Hyprland padrão. Não há editor de wrapper no seletor, nem opção de listener TCP sem autenticação. O caminho remoto só aceita letras, números, `_`, `.`, `/` e `-`, sem espaços ou metacaracteres shell. A prova visual e de entrada deve usar a fixture da lane Prova real, nunca um desktop humano.

```sh
python3 -m unittest discover -s desktop/tests -p test_rd.py
node --test tests/rd-gliff.test.mjs
node --test --test-name-pattern='^rd ' tests/cli.test.mjs
```

Os testes Python e Node cobrem aliases/nome/Include, seleção/cancelamento, opções, versão, SSH, falhas, estado Gliff isolado, confiança de host, argv real do wrapper e compatibilidade web. São fixtures, não prova de fluidez. Vídeo, entrada, reconexão e limpeza reais ficam registrados separadamente no relatório da bancada. A ficha de UI é [rd-gliff-ficha-tela.md](rd-gliff-ficha-tela.md).

## Integrar e instalar uma revisão

A implantação deve preservar mudanças locais de outras frentes. Em checkout limpo, avance apenas por fast-forward e rode `./ponte rd --install`. Se o checkout principal estiver sujo, instale a revisão em outro diretório limpo e execute o mesmo comando ali. O atalho guarda o caminho absoluto daquela revisão. Config continua em `$PONTE_CONFIG` ou `$XDG_CONFIG_HOME/ponte/config.json`, não é copiada para a revisão. Não remova a revisão enquanto o atalho ou uma sessão a usar.

Rollback: execute `./ponte rd --install` no checkout anterior limpo ou restaure o `.desktop` gerenciado previamente salvo. `./ponte rd --uninstall` remove só esse atalho. Serviço/credenciais/dados permanecem intactos. Para voltar só ao motor web, use `--engine legacy`, sem downgrade.

Não há GitHub Actions. `tools/check-local.sh` roda Node e checks Android em máquina do operador com dependências existentes, sem downloads. `--android-build` adiciona o APK sintético e exige SDK já instalado. Configure `PONTE_JDK` para JDK17+ e, quando necessário, `PONTE_ANDROID_BUILD`, `PONTE_ANDROID_TOOLS` e `PONTE_ANDROID_PLATFORM`. A fixture APK usa sua própria configuração e assinatura temporárias, não o aparelho nem a chave real.

## Licenças

Ponte apenas invoca Gliff instalado pelo operador. Gliff é MIT e inclui avisos de terceiros, incluindo OpenH264 BSD. Preserve `LICENSE` e `NOTICE` do pacote upstream se redistribuir seus binários. Este corte não redistribui binários, código do codec nem dependências do Gliff.

# Ponte Desktop: plano de implementação

## Objetivo

Adicionar um app de computador ao Ponte para ver e controlar um celular Android
pareado, mantendo o app Android atual que controla o computador.

## Auditoria

- `ponte phone` já implementa conexão e pareamento ADB, abertura do scrcpy e
  manutenção do link Tailscale. Não existe janela de gerenciamento do celular.
- `phone view` já usa H.264 e alvo explícito. O scrcpy entrega vídeo, toque,
  teclado, rolagem e atalhos de navegação sem permissões novas no APK.
- A recuperação antiga `phone ensure` pode percorrer outros transportes.
  O novo app não vai usar isso automaticamente. O alvo precisa ser escolhido
  explicitamente e todas as ações conferem seu serial e estado autorizado.
- O backend Node existente controla o PC. O desktop companion não precisa
  expor uma API ADB no listener do servidor nem aumentar privilégios do Android.

## Arquitetura escolhida

1. App nativo Linux com Python e PySide6, iniciado por `./ponte desktop`.
2. Núcleo Python stdlib, sem Qt obrigatório nos comandos de automação. ADB e
   scrcpy continuam sendo ferramentas locais instaladas pelo operador.
3. Janela principal para conexão, pareamento, seleção de dispositivo, qualidade,
   áudio/clipboard opt-in, somente visualização, navegação e screenshot.
4. scrcpy gerenciado como processo filho e janela própria intitulada Ponte.
   Não prometer vídeo embutido: isso seria frágil no Wayland e exigiria outro
   protocolo de vídeo. Fechar/parar encerra somente o processo da própria sessão.
5. Operações ADB assíncronas na GUI, com timeout, erro visível, sem shell=True,
   sem escolha implícita do primeiro aparelho e sem desbloqueio automático.
6. CLI `ponte desktop` com help/schema/status/devices/connect/pair/select,
   disconnect, mirror, ações nomeadas e screenshot. Saída JSON e códigos de
   erro estáveis para continuar dando autonomia aos agentes.
7. Preferências privadas fora do repo. Reaproveitar o endereço salvo do Ponte
   como sugestão, nunca como permissão para clicar ou iniciar controle sozinho.
8. Launcher `.desktop` instalável por comando explícito. Nada de autostart ou
   serviço permanente novo. Modo `--demo` claramente sintético pra testes.

## Guardas

- Pairing code somente por campo protegido ou stdin, não argv.
- Nenhuma ação tenta reconfigurar TCP, elevar privilégios ou autorizar ADB.
- `adb -s SERIAL` em toda ação dirigida. Dispositivo desconectado/unauthorized
  produz erro antes de controle. USB/emulador só por seleção explícita.
- Áudio e sincronização automática de clipboard desativados por padrão.
- Screenshot PNG privado e exclusivo, sem substituir arquivos existentes.
- Testes não chamam `phone ensure`, não tocam o telefone físico nem a sessão
  humana. GUI e entrada visual ficam na bancada `ponte-desktop-app`.

## Aceitação

- Abrir e usar a GUI numa bancada, demonstrar conexão/seleção, iniciar/parar
  viewer de demonstração e verificar que não foi acionado nenhum ADB real.
- Testes reais de widgets/worker/process lifecycle e fixtures ADB/scrcpy
  validando alvo, erros, pareamento, persistência e segurança dos arquivos.
- Comandos CLI exercitados por subprocessos, incluindo help/status sem Qt.
- Suítes Node/Android existentes verdes e documentação com instalação, uso,
  pré-requisitos, limitações e observações, sem prometer controle sem pareamento.
- Se não houver sessão Android isolada disponível, espelhamento físico fica
  explicitamente não validado, sem usar o celular pessoal como atalho.

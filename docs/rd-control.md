# Controle do teclado e do mouse no rd

A página `rd.html` alterna entre o teclado e mouse deste aparelho e os do aparelho na tela.

## Alternar

- **Ctrl+X** alterna nos dois sentidos, com ou sem tela cheia. É reservado nesta janela, não recorta. Ctrl+Shift+X, Ctrl+Alt+X e Super+Ctrl+X não alternam. O Ctrl e o X da alternância não vão pro outro aparelho.
- **Clique na tela** começa a controlar. **Clique na barra**, fora do indicador, devolve. A tela recebe o foco de teclado mesmo depois de trocar aparelho ou monitor pelo seletor.
- **Segurar Esc 2 s** sai da tela cheia e devolve. Esc curto continua sendo tecla remota.
- O **indicador da barra** diz pra onde as teclas vão e também alterna com um clique. Controlando, a tela tem borda verde e o título começa com `⌨ nome · `.
- Ao perder o foco da janela ou esconder a página, o controle é devolvido e as teclas remotas são soltas. Ctrl+X pega de novo.
- Nas **Configurações**, Ctrl+X pode também entrar em tela cheia em vez de só alternar.

## O limite do navegador

| Tecla | Na janela | Em tela cheia (Keyboard Lock) |
| --- | --- | --- |
| Letras, Ctrl+C/V, setas | vai | vai |
| Ctrl+X | alterna, não recorta | alterna, não recorta |
| Ctrl+T, Ctrl+W, Ctrl+N | fica no Chrome | vai |
| Super e Super+qualquer | depende do módulo Hyprland abaixo | vai |
| Alt+Tab | depende do módulo Hyprland abaixo | vai |

Keyboard Lock só captura os atalhos do Chrome em tela cheia iniciada pela página. Fora dela, pedir `navigator.keyboard.lock()` não basta. Isso foi medido com o teclado da bancada e o lab em 2026-10-01.

## Opcional: atalhos do Omarchy na janela

`tools/hypr/ponte_rd.lua` cria o submap `ponte-rd` e entra nele só quando a janela ativa é o rd, classe `ponte-rd` ou `chrome-…__rd.html-…`, e o título começa com `⌨ `. As teclas sem bind no submap vão à janela. Assim Super e os atalhos do Omarchy podem chegar no aparelho remoto sem tela cheia.

Devolve os atalhos locais quando o título perde a marca, outra janela ganha foco, a janela fecha ou você aperta **Super+Ctrl+Alt+Esc**. Ctrl+X remove a marca na página, portanto devolve também o submap. O Chrome ainda pega Ctrl+T/W na janela.

```sh
tools/hypr/ponte-rd-hypr.sh check
# Só o operador instala na sessão real:
tools/hypr/ponte-rd-hypr.sh install
tools/hypr/ponte-rd-hypr.sh status
tools/hypr/ponte-rd-hypr.sh remove
```

`install` faz backup e só grava se a config inteira passar em `Hyprland --verify-config`. `HYPR_DIR=/uma/cópia` permite testar sem tocar na config viva.

## Por que o teclado sumia depois de trocar de aparelho

O clique na imagem usava `preventDefault`, que conservava o foco no `<select>` da barra. A página dizia que controlava, mas descartava todo evento de tecla cujo alvo fosse `SELECT`. Reproduzido com notebook → este aparelho → notebook, clique na imagem e teclado nativo da bancada: mouse chegou, Z e Super não. Agora todas as entradas de controle focam a tela não editável e um foco antigo de seletor não bloqueia a injeção.

## Aceite de 1 minuto no aparelho real

Só o dono opera o teclado real. O agente acompanha os logs sem injetar entrada.

1. Abra `ponte rd` no notebook remoto. No seletor, escolha este aparelho e volte ao notebook.
2. Clique na imagem. Digite `zzz` num campo de teste do notebook e use Super+1. Deve atuar no notebook. A barra deve dizer que está controlando o notebook.
3. Aperte Ctrl+X. A barra volta pra este aparelho e `hyprctl submap` no PC volta a `default`. Super+1 deve funcionar no PC.
4. Ctrl+X de novo pega o notebook. Ctrl+Shift+X não pode devolver o controle. Ctrl+C/V devem continuar remotos.
5. Escolha tela cheia nas configurações. Ctrl+X entra, outro Ctrl+X sai e devolve. Segurar Esc 2 s também devolve.
6. Abra detalhes técnicos e confira a trilha de teclas. Feche a janela e compare os contadores de teclado no journal de origem e destino.

Se prender: **Super+Ctrl+Alt+Esc** devolve os atalhos locais. Feche a janela e guarde os registros `session closed` dos dois aparelhos.

## Diagnóstico que fica disponível

Configurações → Detalhes técnicos mostra as últimas 12 teclas: código físico, pressão/soltura, se saiu ou por que ficou. `IME/229` destaca composição local sem descartar um código físico válido. A trilha fica só na memória da página, sem o texto de `event.key`, clipboard ou gravação no servidor. Reconectar zera os contadores da página.

Ao fechar uma sessão, o journal tem `[rd] session closed` com `sessionId` aleatório e papel `target` ou `relay`:

- `received`: mensagens key que chegaram, antes dos filtros;
- `queued`: enfileiradas pro helper, não prova de injeção;
- `injected`: ACK do helper com `applied=true`, depois do evento evdev escrito;
- `discarded`: quantidade por motivo, como `view_only`, `unknown_code`, `duplicate_down`, `up_without_down`;
- `unconfirmed` e `pending`: sem prova de aplicação, por saída do helper, pipe quebrado ou final não observado;
- `dryRun`: a injeção era simulada no lab, nunca abriu uinput.

Na origem, `forwarded` só significa encaminhado. `targetObserved` é a última contagem confirmada pelo destino. `complete:false` e `unobserved` avisam que o fechamento da conexão pode ter perdido os ACKs finais. O journal do destino, após drenar o helper, é a contagem final. Os logs não contêm códigos das teclas, texto digitado nem tokens.

Para separar a falha: página viu 0 eventos é foco/compositor/IME antes dela. Viu eventos sem envio é uma decisão da página. Enviados e relay encaminhados, mas destino não recebeu, aponta transporte. Recebidos sem injected, confira discarded/unconfirmed no alvo. Contagem não substitui olhar o efeito no aplicativo remoto.

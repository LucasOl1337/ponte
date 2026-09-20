# Roteiro de teste manual (Redmi)

Teste no Redmi Note 13 Pro+ (Android 14) com a Tailscale ligada e o PC acordado. Siga na ordem; cada passo diz o que fazer e o que esperar.

## 1. Instalar a atualização

- Faça: instale o `.work/Ponte.apk` mais novo por cima do app atual (mesma chave, sem desinstalar).
- Espere: o pareamento continua; o app abre sem pedir a chave.

## 2. Abrir a Tela

- Faça: abra o Ponte e toque em Tela.
- Espere: o monitor do PC aparece ao vivo e continua atualizando na página.

## 3. Toque e zoom

- Faça: toque no X de uma janela com a oscilação normal do dedo; em 1×, arraste sobre um texto do PC e mova um slider. Dê pinça para ler um texto pequeno, navegue com um dedo enquanto ampliado e volte o zoom. Role uma página com dois dedos juntos.
- Espere: a janela fecha com o toque, o arraste em 1× seleciona texto e move o slider como o botão esquerdo segurado, a pinça permanece suave e centrada nos dedos, um dedo move somente a vista ampliada e dois dedos rolam o PC quando não há pinça.

## 4. Mover uma janela para outro workspace

- Faça: toque longo na barra de título de uma janela, comece a mover, arraste até um número da prateleira de workspaces que aparece e solte. Repita um arraste comum e solte fora da prateleira.
- Espere: a primeira janela vai para aquele workspace sem trocar a área visível. O segundo continua sendo um arraste comum no PC. Tocar longo no wallpaper e soltar num workspace não move uma janela que estava em foco antes.

## 5. Tocar num campo de texto do PC

- Faça: toque num campo de texto na tela transmitida, digite uma frase curta, pressione Enter e depois toque num alvo que não aceita texto.
- Espere: o teclado do Android e a barra fina de digitação sobem sozinhos; texto e Enter chegam ao campo em foco no PC. Tocar fora fecha a barra que abriu automaticamente. O app não pede nenhuma permissão nova do Android.

## 6. Card Energia (um monitor só)

- Faça: em Energia, Desligue UM monitor e Ligue de novo.
- Espere: só aquela tela apaga e volta; o aviso diz "Monitor desligado/ligado".

- Faça: toque em Dormir inteligente, espere e toque em Acordar.
- Espere: monitores e luzes RGB apagam ("Dormindo...") e voltam ("PC acordado..."); o PC segue acessível pela Tailscale o tempo todo.

## 7. Terminais

- Faça: abra Terminais, crie Nova sessão, use Digitar com `echo ok` e pressione Enter.
- Espere: a saída mostra `ok`; Ctrl+C interrompe; a mesma sessão abre no PC.

Fim: anote o que sair diferente e reporte com o número do passo.

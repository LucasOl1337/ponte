# Roteiro de teste manual (Redmi)

Teste no Redmi Note 13 Pro+ (Android 14) com a Tailscale ligada e o PC acordado. Siga na ordem; cada passo diz o que fazer e o que esperar.

## 1. Instalar a atualização

- Faça: instale o `.work/Ponte.apk` mais novo por cima do app atual (mesma chave, sem desinstalar).
- Espere: o pareamento continua; o app abre sem pedir a chave.

## 2. Abrir a Tela

- Faça: abra o Ponte e toque em Tela.
- Espere: o monitor do PC aparece ao vivo e continua atualizando na página.

## 3. Zoom por região

- Faça: dê pinça para ler um texto pequeno, arraste para outra área, toque em 1:1 e volte o zoom.
- Espere: o recorte com zoom fica nítido (captura em resolução real, sem esticar) e preenche a prévia sem barras pretas; 1:1 mostra pixels nativos de um recorte que dá para arrastar; ao voltar, a tela inteira retorna.

## 4. Toque direto

- Faça: mude para Toque direto, toque num ícone, segure para botão direito, arraste com um dedo, pinça com dois.
- Espere: o monitor ganha uma borda lima e um selo de Toque direto; o texto de ajuda explica toque/toque longo/arraste/pinça; na primeira vez, um aviso curto diz que o toque clica no PC. Toque clica na posição, segurar clica com direito, um dedo move a imagem, dois dão pinça; o mouse do PC só mexe no Toque direto.

## 5. Card Energia (um monitor só)

- Faça: em Energia, Desligue UM monitor e Ligue de novo.
- Espere: só aquela tela apaga e volta; o aviso diz "Monitor desligado/ligado".

- Faça: toque em Dormir inteligente, espere e toque em Acordar.
- Espere: monitores e luzes RGB apagam ("Dormindo...") e voltam ("PC acordado..."); o PC segue acessível pela Tailscale o tempo todo.

## 6. Terminais

- Faça: abra Terminais, crie Nova sessão, use Digitar com `echo ok` e pressione Enter.
- Espere: a saída mostra `ok`; Ctrl+C interrompe; a mesma sessão abre no PC.

Fim: anote o que sair diferente e reporte com o número do passo.

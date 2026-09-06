'use strict';
(() => {
  // Portuguese source messages are stable translation keys. English is the global default.
  const english = {
  "Ver": "View",
  "Ver e controlar": "View and control",
  "Abra o touchpad ou teclado sem perder a imagem. Use Ver para expandir o monitor.": "Open the touchpad or keyboard while keeping the screen in view. Choose View to expand the monitor.",
  "Seu Omarchy ao alcance da mão. Controle seu PC, organize janelas e envie áudio pelo celular.": "Your Omarchy within reach. Control your PC, manage windows and send audio from your phone.",
  "Ponte — seu Omarchy, por perto": "Ponte — your Omarchy, within reach",
  "Ponte, início": "Ponte, home",
  "ponte": "ponte",
  "OMARCHY, POR PERTO": "OMARCHY, WITHIN REACH",
  "Conexão e instalação": "Connection and installation",
  "Tentar agora": "Try now",
  "SEU CELULAR + SEU OMARCHY": "YOUR PHONE + YOUR OMARCHY",
  "Dois dispositivos.": "Two devices.",
  "Um só lugar.": "One place.",
  "Uma ponte para o seu computador. Navegue, troque de janela e envie sua voz de onde estiver.": "A bridge to your computer. Navigate, switch windows and send your voice from wherever you are.",
  "CONECTAR COM SEGURANÇA": "CONNECT SECURELY",
  "Chave de pareamento": "Pairing key",
  "Cole a chave gerada no PC": "Paste the key from your PC",
  "Conectar ao meu PC": "Connect to my PC",
  "Abra o link de pareamento do PC para conectar automaticamente. A chave fica somente neste navegador.": "Open the PC pairing link to connect automatically. The key stays in this browser only.",
  "Acesso privado pela sua rede Tailscale.": "Private access over your Tailscale network.",
  "CONECTANDO AO PC": "CONNECTING TO PC",
  "Tudo perto.": "Your desktop.",
  "Mesmo longe.": "From anywhere.",
  "Seu Omarchy, ao alcance da mão.": "Your Omarchy, within reach.",
  "SEU COMPUTADOR": "YOUR COMPUTER",
  "Conectando…": "Connecting…",
  "aguarde": "please wait",
  "janelas": "windows",
  "áreas ativas": "active workspaces",
  "ligado há": "uptime",
  "Buscando a janela em foco…": "Finding the focused window…",
  "Abra caminho": "Open something",
  "NO SEU PC": "ON YOUR PC",
  "Navegador": "Browser",
  "Terminal": "Terminal",
  "Arquivos": "Files",
  "Seu espaço": "Your workspaces",
  "Ver janelas": "View windows",
  "Carregando áreas de trabalho…": "Loading workspaces…",
  "O SOM DO SEU PC": "YOUR PC AUDIO",
  "No seu ritmo": "Sound and media",
  "Silenciar som do PC": "Mute PC audio",
  "Volume do PC": "PC volume",
  "Controle de mídia": "Media controls",
  "Faixa anterior": "Previous track",
  "Reproduzir ou pausar mídia": "Play or pause media",
  "Próxima faixa": "Next track",
  "Leve sua voz até lá.": "Send your voice over.",
  "Grave no celular. Ouça no PC.": "Record on your phone. Listen on your PC.",
  "p.": "p.",
  "O computador é seu. O controle também.": "Your computer. Your control.",
  "01 / CONTROLE": "01 / CONTROL",
  "Na ponta": "At your",
  "dos dedos.": "fingertips.",
  "Um gesto aqui. Uma ação no seu PC.": "A gesture here. An action on your PC.",
  "Tipo de controle": "Control type",
  "Mouse": "Mouse",
  "Teclado": "Keyboard",
  "Tela": "Screen",
  "Seu PC ao vivo": "Your PC, live",
  "PRONTO": "READY",
  "MONITOR": "MONITOR",
  "Monitor para visualizar": "Monitor to view",
  "Buscando monitores…": "Finding monitors…",
  "QUALIDADE": "QUALITY",
  "Qualidade da transmissão": "Stream quality",
  "Equilibrado": "Balanced",
  "Mais nítido": "Sharper",
  "Acompanhe seu computador": "Keep up with your computer",
  "Escolha um monitor e inicie a transmissão.": "Choose a monitor and start streaming.",
  "Conectando ao monitor…": "Connecting to the monitor…",
  "Monitor do PC": "PC monitor",
  "Pronto para iniciar": "Ready to start",
  "Pausar transmissão": "Pause stream",
  "Ampliar imagem para ler": "Zoom in to read",
  "Abrir tela cheia": "Enter fullscreen",
  "Iniciar ao vivo": "Start live view",
  "Foto": "Snapshot",
  "Veja as mudanças do monitor enquanto esta tela estiver aberta.": "Watch the monitor change while this screen is open.",
  "Touchpad": "Touchpad",
  "PRONTO PARA O TOQUE": "READY FOR TOUCH",
  "Touchpad remoto. Arraste um dedo para mover, toque para clicar, dois dedos para rolar ou toque com dois dedos para botão direito. Use as setas do teclado para mover o cursor.": "Remote touchpad. Drag one finger to move, tap to click, use two fingers to scroll or tap with two fingers to right-click. Use the keyboard arrows to move the pointer.",
  "Deslize. Toque. Controle.": "Swipe. Tap. Control.",
  "1 dedo move · 2 dedos rolam": "1 finger moves · 2 fingers scroll",
  "TOQUE PARA CLICAR": "TAP TO CLICK",
  "Clique": "Click",
  "Arrastar": "Drag",
  "Botão direito": "Right click",
  "Entrada do mouse indisponível no PC. Confira a conexão para detalhes.": "Mouse input is unavailable on the PC. Check the connection for details.",
  "NA JANELA EM FOCO": "IN THE FOCUSED WINDOW",
  "Texto para digitar no PC": "Text to type on the PC",
  "Escreva aqui para digitar no PC…": "Write here to type on the PC…",
  "Envia para a janela ativa.": "Sends to the active window.",
  "Enviar texto": "Send text",
  "Esc": "Esc",
  "Tab ⇥": "Tab ⇥",
  "⌫ Apagar": "⌫ Delete",
  "Enter ↵": "Enter ↵",
  "Copiar": "Copy",
  "Colar": "Paste",
  "Desfazer": "Undo",
  "Selecionar": "Select all",
  "Seta para esquerda": "Left arrow",
  "Seta para baixo": "Down arrow",
  "Seta para cima": "Up arrow",
  "Seta para direita": "Right arrow",
  "Entrada do teclado indisponível no PC.": "Keyboard input is unavailable on the PC.",
  "02 / JANELAS": "02 / WINDOWS",
  "Encontre seu": "Find your",
  "próximo foco.": "next window.",
  "Suas janelas. Um toque para chegar lá.": "Your windows. One tap to get there.",
  "Buscar janela ou aplicativo": "Search windows or apps",
  "Janelas abertas": "Open windows",
  "CARREGANDO": "LOADING",
  "Buscando suas janelas…": "Finding your windows…",
  "03 / VOZ": "03 / VOICE",
  "Fale daqui.": "Record here.",
  "Chegue até lá.": "Send to your PC.",
  "Seu áudio sai do celular e chega ao PC.": "Your audio goes from your phone to your PC.",
  "Uma mensagem de voz": "A voice message",
  "Duração da gravação": "Recording duration",
  "Grave, confira e envie quando quiser.": "Record, review and send when you are ready.",
  "Começar gravação": "Start recording",
  "Descartar": "Discard",
  "Enviar ao PC": "Send to PC",
  "O áudio só toca no PC quando você pedir.": "Audio plays on the PC only when you ask.",
  "Já chegaram ao PC": "Saved on your PC",
  "Atualizar áudios salvos": "Refresh saved recordings",
  "Escolha onde ouvir cada gravação.": "Choose where to listen to each recording.",
  "Parar áudio no PC": "Stop PC audio",
  "Sua voz ganha um lugar aqui.": "No recordings yet.",
  "Os áudios enviados aparecem nesta lista.": "Your uploaded recordings appear here.",
  "Navegação principal": "Main navigation",
  "Início": "Home",
  "Controle": "Control",
  "Janelas": "Windows",
  "Voz": "Voice",
  "SUA PONTE": "YOUR PONTE",
  "Fechar conexão": "Close connection details",
  "Uma conexão.": "Your connection.",
  "Muitas possibilidades.": "Ready when you are.",
  "Seu Omarchy": "Your Omarchy",
  "Não conectado": "Not connected",
  "Um lugar na sua tela inicial": "A place on your home screen",
  "No menu do navegador, escolha “Instalar aplicativo” ou “Adicionar à tela inicial”.": "In your browser menu, choose “Install app” or “Add to Home screen”.",
  "Instalar Ponte": "Install Ponte",
  "Acompanhar a construção": "Follow development",
  "Desconectar este navegador": "Unpair this browser",
  "Isso remove a chave salva somente deste navegador.": "This only removes the key saved in this browser.",
  "Ponte — em construção": "Ponte — in progress",
  "Abrir app ↗": "Open app ↗",
  "CONSTRUÇÃO ABERTA": "BUILDING IN THE OPEN",
  "De ideia": "From an idea",
  "a controle.": "to control.",
  "Acompanhe a evolução do Ponte. Esta página atualiza automaticamente.": "Follow Ponte's progress. This page updates automatically.",
  "Carregando progresso…": "Loading progress…",
  "Não foi possível concluir a ação.": "The action could not be completed.",
  "A chave não foi aceita. Cole a chave atual do PC para reconectar.": "The key was not accepted. Paste the current PC key to reconnect.",
  "O PC demorou para responder. Tente novamente.": "The PC took too long to respond. Try again.",
  "Sem resposta do PC. Confira o Tailscale e a conexão.": "No response from the PC. Check Tailscale and your connection.",
  "Reconecte ao PC para usar este controle.": "Reconnect to the PC to use this control.",
  "SEU PC ESTÁ CONECTADO": "YOUR PC IS CONNECTED",
  "RECONEXÃO AUTOMÁTICA": "AUTOMATIC RECONNECTION",
  "Conexão privada · navegador pareado": "Private connection · paired browser",
  "Aguardando resposta do computador": "Waiting for the computer to respond",
  "Conexão interrompida. Tentando reconectar…": "Connection interrupted. Reconnecting…",
  "AGUARDANDO CONEXÃO": "WAITING FOR CONNECTION",
  "INDISPONÍVEL NO PC": "UNAVAILABLE ON PC",
  "Foto do monitor": "Monitor snapshot",
  "Tela ao vivo": "Live screen",
  "Áudio no PC": "PC audio",
  "Nenhuma janela em foco": "No focused window",
  "Ativar som do PC": "Unmute PC audio",
  "Monitor alterado. Inicie a transmissão do monitor escolhido.": "Monitor changed. Start the stream for the selected monitor.",
  "Nenhum monitor": "No monitor",
  "Nenhuma janela com esse nome.": "No windows with that name.",
  "Um espaço para começar.": "Room to get started.",
  "Tente outro título ou nome de aplicativo.": "Try another title or app name.",
  "As janelas abertas no PC aparecerão aqui.": "Windows open on your PC will appear here.",
  "Janela sem título": "Untitled window",
  "Abrindo no PC…": "Opening on PC…",
  "Janela em foco no PC.": "Window focused on the PC.",
  "Sua ponte está pronta.": "Your Ponte is ready.",
  "Escreva o texto que deseja enviar.": "Write the text you want to send.",
  "Texto digitado no PC.": "Text typed on the PC.",
  "Resposta de vídeo inválida.": "Invalid video response.",
  "Quadro JPEG inválido.": "Invalid JPEG frame.",
  "Cabeçalho do vídeo inválido.": "Invalid video header.",
  "Formato de transmissão não reconhecido.": "Unrecognized stream format.",
  "Tamanho do quadro inválido.": "Invalid frame size.",
  "Retomar transmissão ao vivo": "Resume live stream",
  "Reconectando ao monitor…": "Reconnecting to the monitor…",
  "Último quadro · imagem parada": "Last frame · still image",
  "Transmissão pausada": "Stream paused",
  "Sem novos quadros": "No new frames",
  "Aguardando primeiro quadro": "Waiting for the first frame",
  "Transmissão pausada. Toque em iniciar para acompanhar novamente.": "Stream paused. Tap start to watch again.",
  "Esta é uma foto. Inicie ao vivo para ver as mudanças do monitor.": "This is a snapshot. Start live view to see changes on the monitor.",
  "Ajustar imagem inteira à tela": "Fit the full image on screen",
  "Não foi possível abrir o monitor.": "The monitor could not be opened.",
  "Não foi possível decodificar a imagem do monitor.": "The monitor image could not be decoded.",
  "Aguardando novos quadros do monitor…": "Waiting for new monitor frames…",
  "O PC não ofereceu uma transmissão compatível.": "The PC did not offer a compatible stream.",
  "Resposta de transmissão incompleta.": "Incomplete stream response.",
  "A transmissão foi interrompida.": "The stream was interrupted.",
  "Conexão interrompida.": "Connection interrupted.",
  "Transmissão indisponível. Confira a conexão com o PC.": "Streaming is unavailable. Check the PC connection.",
  "Mais nítido · até 6 quadros/s": "Sharper · up to 6 fps",
  "Equilibrado · até 10 quadros/s": "Balanced · up to 10 fps",
  "Sair da tela cheia": "Exit fullscreen",
  "Nenhum monitor disponível.": "No monitor available.",
  "A foto demorou para chegar. Tente novamente.": "The snapshot took too long to arrive. Try again.",
  "Arraste no touchpad. Toque em Soltar ao terminar.": "Drag on the touchpad. Tap Release when you are done.",
  "O microfone precisa de uma conexão HTTPS. Abra o endereço seguro do Ponte pelo Tailscale.": "Use the Ponte Android app or an HTTPS browser connection to record.",
  "Este navegador não oferece gravação de áudio. Abra o Ponte no Chrome ou em outro navegador atualizado.": "This browser does not support audio recording. Open Ponte in Chrome or another current browser.",
  "PERMISSÃO": "PERMISSION",
  "Permita o microfone. Você pode cancelar a espera.": "Allow microphone access. You can cancel while waiting.",
  "A permissão do microfone não chegou em 25 segundos. Libere o acesso no navegador e tente novamente.": "Microphone permission did not arrive within 25 seconds. Allow access in your browser and try again.",
  "Pedido de microfone cancelado.": "Microphone request canceled.",
  "Nenhum formato de gravação compatível neste navegador. Tente abrir no Chrome.": "No supported recording format in this browser. Try opening Ponte in Chrome.",
  "Gravação pausada perto do limite de 25 MB. Confira e envie este áudio.": "Recording stopped near the 25 MB limit. Review and send this audio.",
  "A gravação foi interrompida. Tente gravar novamente.": "Recording was interrupted. Try recording again.",
  "Nenhum áudio foi capturado. Tente novamente.": "No audio was captured. Try again.",
  "PRÉVIA": "PREVIEW",
  "Ouça antes. O envio é sua escolha.": "Listen first. You decide when to send.",
  "Só você está ouvindo. Pare para conferir.": "Recording stays on this device. Stop to review it.",
  "Microfone não permitido. Nas permissões deste site, libere o microfone e tente novamente.": "Microphone access was denied. Allow the microphone in this site's permissions and try again.",
  "Nenhum microfone encontrado neste dispositivo.": "No microphone found on this device.",
  "O microfone está ocupado. Feche outros apps que estejam gravando e tente novamente.": "The microphone is busy. Close other recording apps and try again.",
  "Não foi possível abrir o microfone.": "The microphone could not be opened.",
  "Acesso ao microfone cancelado. Você pode tentar novamente.": "Microphone access canceled. You can try again.",
  "Conecte ao PC para enviar. Sua gravação continua disponível aqui.": "Connect to the PC to send. Your recording is still available here.",
  "O áudio excede 25 MB. Grave uma mensagem mais curta.": "The audio exceeds 25 MB. Record a shorter message.",
  "Áudio salvo no PC. Escolha onde ouvir.": "Audio saved on the PC. Choose where to listen.",
  "Data indisponível": "Date unavailable",
  "Mensagem de voz": "Voice message",
  "Reprodução de áudio indisponível no PC.": "Audio playback is unavailable on the PC.",
  "Reproduzindo áudio no PC.": "Playing audio on the PC.",
  "Toque no player para ouvir neste dispositivo.": "Tap the player to listen on this device.",
  "Áudio do Ponte parado no PC.": "Ponte audio stopped on the PC.",
  "Chave removida deste navegador.": "Key removed from this browser.",
  "Ponte instalado. Abra pelo ícone da sua tela inicial.": "Ponte is installed. Open it from your home screen.",
  "Instale para abrir o Ponte direto da tela inicial, como um app.": "Install Ponte to open it from your home screen, like an app.",
  "Ponte instalado. Seu PC ganhou um atalho na tela inicial.": "Ponte is installed. Your PC now has a home screen shortcut.",
  "Este dispositivo está sem conexão.": "This device is offline.",
  "Conectando ao seu computador…": "Connecting to your computer…",
  "Imagem do monitor do PC": "Image of the PC monitor",
  "Nenhum monitor disponível": "No monitor available",
  "Nenhuma área de trabalho disponível.": "No workspaces available.",
  "Todas": "All",
  "JANELA": "WINDOW",
  "JANELAS": "WINDOWS",
  "janela": "window",
  "Aplicativo": "App",
  " · em foco": " · focused",
  "CONECTANDO": "CONNECTING",
  "AO VIVO": "LIVE",
  "RECONECTANDO": "RECONNECTING",
  "PAUSADO": "PAUSED",
  "FOTO": "SNAPSHOT",
  "Pausar ao vivo": "Pause live view",
  "O monitor ficou sem enviar imagens.": "The monitor stopped sending frames.",
  "Soltar": "Release",
  "GRAVANDO": "RECORDING",
  "FINALIZANDO": "FINISHING",
  "Parar gravação": "Stop recording",
  "Cancelar acesso ao microfone": "Cancel microphone access",
  "Enviando…": "Sending…",
  "Buscando seus áudios…": "Loading your recordings…",
  "Tocar no PC": "Play on PC",
  "Ouvir aqui": "Listen here",
  "Não foi possível carregar os áudios.": "Recordings could not be loaded.",
  "Toque em atualizar para tentar novamente.": "Tap refresh to try again.",
  "Ir para área {workspace}, {count} janela": "Go to workspace {workspace}, {count} window",
  "Ir para área {workspace}, {count} janelas": "Go to workspace {workspace}, {count} windows",
  "Filtrar área {workspace}": "Filter workspace {workspace}",
  "Focar {title}, área {workspace}": "Focus {title}, workspace {workspace}",
  "Área {workspace}": "Workspace {workspace}",
  "Área {workspace} em foco.": "Workspace {workspace} focused.",
  "{count} JANELA": "{count} WINDOW",
  "{count} JANELAS": "{count} WINDOWS",
  "Quadro às {time}": "Frame at {time}",
  "Foto às {time} · imagem parada": "Snapshot at {time} · still image",
  "Ao vivo · {profile}. O ritmo depende da conexão e do monitor.": "Live · {profile}. Frame rate depends on the connection and monitor.",
  "Monitor {monitor}": "Monitor {monitor}",
  "{message} Tentando novamente em {seconds}s.": "{message} Retrying in {seconds}s.",
  "Idioma": "Language",
  "Alfa experimental": "Experimental alpha",
  "Ponte para Omarchy": "Ponte for Omarchy",
  "Controle e monitores ao vivo": "Controls and live monitors",
  "Disponível": "Available",
  "Gravação no Android": "Android recording",
  "Validação em andamento": "Verification in progress",
  "Pareamento inicial mais simples": "Simpler first pairing",
  "Planejado": "Planned",
  "Em andamento": "In progress",
  "Ponte em construção": "Ponte in development",
  "Etapa": "Stage",
  "Atualizado {time}": "Updated {time}",
  "Progresso sincronizado agora.": "Progress just synchronized.",
  "Aguardando atualização do servidor. Tentando novamente automaticamente.": "Waiting for a server update. Retrying automatically.",
  "Acesse pelo app Ponte ou pelo navegador com HTTPS para gravar.": "Use the Ponte app or an HTTPS browser connection to record.",
  "Terminais": "Terminals",
  "Tela do PC. Use pinça para ampliar e arraste para explorar.": "PC screen. Pinch to zoom, then drag to explore.",
  "Diminuir zoom": "Zoom out",
  "Gire o celular para ver maior. Use pinça para ampliar e arraste para ler.": "Turn your phone sideways for a larger view. Pinch to zoom and drag to read.",
  "Nova sessão": "New session",
  "Sessões de texto para usar pelo celular, sem mudar o foco do PC.": "Text sessions for your phone, without changing the PC's focus.",
  "Sessão do terminal": "Terminal session",
  "Escolha ou crie uma sessão": "Choose or create a session",
  "Pausar leitura": "Pause output",
  "Retomar leitura": "Resume output",
  "Saída do terminal": "Terminal output",
  "Largura": "Width",
  "Celular · 40 colunas": "Phone · 40 columns",
  "Desktop · 80 colunas": "Desktop · 80 columns",
  "Amplo · 120 colunas": "Wide · 120 columns",
  "Encerrar": "Close session",
  "Texto para esta sessão": "Text for this session",
  "Digite aqui e depois envie": "Type here, then send",
  "Digitar": "Type text",
  "Digitar envia o texto. Enter executa separadamente. Evite enviar senhas pelo campo de texto.": "Type text sends the text. Enter executes separately. Avoid sending passwords through the text field.",
  "Comando anterior": "Previous command",
  "Próximo comando": "Next command",
  "Apagar caractere": "Backspace",
  "Você pode sair do app e voltar. Parar o serviço, sair da sessão do Linux ou reiniciar o PC pode encerrar estes terminais.": "You can leave the app and return. Stopping the service, logging out of Linux or restarting the PC may end these terminals.",
  "Terminais abertos no PC": "Terminal windows on your PC",
  "Veja a janela no monitor. O texto dessas janelas não é importado para as sessões acima.": "View the window on its monitor. Text from these windows is not imported into the sessions above.",
  "Focar e ver no monitor": "Focus and view on monitor",
  "Nenhuma janela de terminal aberta.": "No terminal windows are open.",
  "Conectado à sessão de texto.": "Connected to the text session.",
  "Crie uma sessão para começar. Digitar e executar são ações separadas.": "Create a session to begin. Typing and executing are separate actions.",
  "Instale tmux no PC para usar sessões de texto.": "Install tmux on the PC to use text sessions.",
  "Encerrar esta sessão?": "Close this session?",
  "Os processos neste terminal serão encerrados. Esta ação não pode ser desfeita.": "Processes in this terminal will end. This cannot be undone.",
  "Cancelar": "Cancel",
  "Encerrar sessão": "Close session",
  "Ler em alta resolução": "Freeze & read",
  "Ver na resolução original": "View at original resolution",
  "Painel do PC": "PC dashboard",
  "Não chegaram novos quadros. Toque em iniciar para tentar novamente.": "No new frames arrived. Tap play to try again.",
  "Texto vai para a janela em foco: {title}": "Text goes to the focused window: {title}",
  "Modo de cópia ativo. Saia dele no terminal do PC para voltar a digitar.": "Copy mode is active. Leave it in the PC terminal to type again.",
  "Abrir esta mesma sessão no PC": "Open this same session on the PC",
  "Comando para conectar no PC": "Command to attach on the PC",
  "Execute este comando em um terminal do PC. O texto e os processos serão os mesmos.": "Run this command in a PC terminal. Both devices share the same text and processes.",
  "Ocultar controles": "Hide controls",
  "Mostrar controles da tela": "Show screen controls",
  "Controles": "Controls"
};
  // Public API/proxy copy mirrors the authoritative catalogs; parity is tested.
  const apiMessages = {
  "HOST_NOT_ALLOWED": {
    "en": "This host is not allowed.",
    "pt": "Host não autorizado."
  },
  "ORIGIN_NOT_ALLOWED": {
    "en": "This origin is not allowed.",
    "pt": "Origem não autorizada."
  },
  "PAYLOAD_TOO_LARGE": {
    "en": "The request exceeds the allowed size.",
    "pt": "O conteúdo excede o tamanho permitido."
  },
  "UPLOAD_TIMEOUT": {
    "en": "The upload took too long.",
    "pt": "O envio demorou demais."
  },
  "UPLOAD_INTERRUPTED": {
    "en": "The upload was interrupted.",
    "pt": "Envio interrompido."
  },
  "RATE_LIMITED": {
    "en": "Too many requests. Try again shortly.",
    "pt": "Muitas solicitações. Aguarde um instante."
  },
  "OPERATION_BUSY": {
    "en": "An operation is in progress. Try again shortly.",
    "pt": "Operação em andamento. Tente novamente em instantes."
  },
  "SERVER_RESTARTING": {
    "en": "The server is restarting.",
    "pt": "O servidor está reiniciando."
  },
  "ACTION_QUEUE_FULL": {
    "en": "Too many commands are queued.",
    "pt": "Há muitos comandos na fila."
  },
  "FILE_NOT_FOUND": {
    "en": "File not found.",
    "pt": "Arquivo não encontrado."
  },
  "METHOD_NOT_ALLOWED": {
    "en": "This method is not allowed.",
    "pt": "Método não permitido."
  },
  "INVALID_URL": {
    "en": "Invalid URL.",
    "pt": "URL inválida."
  },
  "CROSS_SITE_NOT_ALLOWED": {
    "en": "Cross-site requests are not allowed.",
    "pt": "Solicitação entre sites não permitida."
  },
  "PAIRING_REQUIRED": {
    "en": "Pair this device to continue.",
    "pt": "Pareie este dispositivo para continuar."
  },
  "JSON_REQUIRED": {
    "en": "Send the action as JSON.",
    "pt": "Envie a ação como JSON."
  },
  "INVALID_JSON": {
    "en": "Invalid JSON.",
    "pt": "JSON inválido."
  },
  "ROUTE_NOT_FOUND": {
    "en": "Route not found.",
    "pt": "Rota não encontrada."
  },
  "INTERNAL_ERROR": {
    "en": "The server could not complete the operation.",
    "pt": "O servidor não conseguiu concluir a operação."
  },
  "REPEATED_PARAMETER": {
    "en": "A parameter was repeated.",
    "pt": "Parâmetro repetido."
  },
  "INVALID_FRAME_RATE": {
    "en": "Frame rate must be between 1 and 10 frames per second.",
    "pt": "A taxa deve estar entre 1 e 10 quadros por segundo."
  },
  "INVALID_SCALE": {
    "en": "Scale must be between 0.2 and 0.65.",
    "pt": "A escala deve estar entre 0,2 e 0,65."
  },
  "INVALID_MONITOR": {
    "en": "Invalid monitor.",
    "pt": "Monitor inválido."
  },
  "INVALID_REGION": {
    "en": "The visible monitor region is invalid.",
    "pt": "A região visível do monitor é inválida."
  },
  "STREAM_ENDED": {
    "en": "The live stream ended.",
    "pt": "Transmissão encerrada."
  },
  "INVALID_JPEG_FRAME": {
    "en": "The capture did not return a valid JPEG frame.",
    "pt": "A captura não retornou um quadro JPEG válido."
  },
  "STREAM_TOO_SLOW": {
    "en": "The connection is too slow for live streaming.",
    "pt": "A conexão está lenta demais para transmissão."
  },
  "STREAM_LIMIT_REACHED": {
    "en": "Three live views are already open. Pause one to open another.",
    "pt": "Já existem três telas ao vivo. Pause uma para abrir outra."
  },
  "HYPRLAND_UNAVAILABLE": {
    "en": "The Hyprland session is unavailable.",
    "pt": "A sessão Hyprland não está disponível."
  },
  "HYPRLAND_INVALID_RESPONSE": {
    "en": "Hyprland returned an invalid response.",
    "pt": "Resposta inválida do Hyprland."
  },
  "VOLUME_UNAVAILABLE": {
    "en": "Volume is unavailable.",
    "pt": "Volume indisponível."
  },
  "INPUT_UNAVAILABLE": {
    "en": "Mouse and shortcuts require the ydotool service.",
    "pt": "Mouse e atalhos dependem do serviço ydotool ativo."
  },
  "TEXT_UNAVAILABLE": {
    "en": "Text input is unavailable: wtype was not found.",
    "pt": "Envio de texto indisponível: wtype não encontrado."
  },
  "SCREENSHOT_UNAVAILABLE": {
    "en": "Screen capture is unavailable: grim was not found.",
    "pt": "Captura de tela indisponível: grim não encontrado."
  },
  "PLAYBACK_UNAVAILABLE": {
    "en": "PC playback is unavailable: ffplay was not found.",
    "pt": "Reprodução no PC indisponível: ffplay não encontrado."
  },
  "ACTIVE_WINDOW_UNAVAILABLE": {
    "en": "The active window is unavailable.",
    "pt": "Janela ativa indisponível."
  },
  "MONITORS_UNAVAILABLE": {
    "en": "Monitors are unavailable.",
    "pt": "Monitores indisponíveis."
  },
  "WORKSPACES_UNAVAILABLE": {
    "en": "Workspaces are unavailable.",
    "pt": "Áreas de trabalho indisponíveis."
  },
  "WINDOWS_UNAVAILABLE": {
    "en": "Windows are unavailable.",
    "pt": "Janelas indisponíveis."
  },
  "INVALID_ACTION": {
    "en": "Invalid action.",
    "pt": "Ação inválida."
  },
  "INVALID_BUTTON": {
    "en": "Invalid mouse button.",
    "pt": "Botão inválido."
  },
  "INVALID_DRAG_STATE": {
    "en": "Invalid drag state.",
    "pt": "Estado de arraste inválido."
  },
  "INVALID_TEXT": {
    "en": "Send 1 to 4000 text characters without control characters.",
    "pt": "Envie texto de 1 a 4000 caracteres, sem controles."
  },
  "KEY_NOT_ALLOWED": {
    "en": "This key is not allowed.",
    "pt": "Tecla não permitida."
  },
  "INVALID_WINDOW": {
    "en": "Invalid window identifier.",
    "pt": "Identificador de janela inválido."
  },
  "WINDOW_CLOSED": {
    "en": "This window is no longer open.",
    "pt": "A janela não está mais aberta."
  },
  "APP_NOT_ALLOWED": {
    "en": "This application is not allowed.",
    "pt": "Aplicativo não permitido."
  },
  "ACTION_NOT_ALLOWED": {
    "en": "This action is not allowed.",
    "pt": "Ação não permitida."
  },
  "AUDIO_NOT_FOUND": {
    "en": "Audio recording not found.",
    "pt": "Áudio não encontrado."
  },
  "UNSUPPORTED_AUDIO_FORMAT": {
    "en": "Use WebM, Ogg, MP4 or WAV audio.",
    "pt": "Use áudio WebM, Ogg, MP4 ou WAV."
  },
  "EMPTY_RECORDING": {
    "en": "The recording is empty or incomplete.",
    "pt": "A gravação está vazia ou incompleta."
  },
  "AUDIO_TOO_LARGE": {
    "en": "Audio recordings must not exceed 25 MiB.",
    "pt": "O áudio deve ter no máximo 25 MiB."
  },
  "AUDIO_FORMAT_MISMATCH": {
    "en": "The content does not match its audio format.",
    "pt": "O conteúdo não corresponde ao formato de áudio."
  },
  "AUDIO_STORAGE_FULL": {
    "en": "Audio storage is full.",
    "pt": "O armazenamento de áudios está cheio."
  },
  "AUDIO_ONLY_REQUIRED": {
    "en": "Send a recording containing audio only.",
    "pt": "Envie uma gravação contendo apenas áudio."
  },
  "AUDIO_TOO_LONG": {
    "en": "Each recording must not exceed 30 minutes.",
    "pt": "Cada áudio deve durar no máximo 30 minutos."
  },
  "INVALID_RECORDING": {
    "en": "This audio recording could not be validated.",
    "pt": "Não foi possível validar esta gravação de áudio."
  },
  "PLAYBACK_FAILED": {
    "en": "The recording could not be played on the PC.",
    "pt": "Não foi possível reproduzir o áudio no PC."
  },
  "NUMBER_OUT_OF_RANGE": {
    "en": "The number must be between {min} and {max}.",
    "pt": "Valor numérico deve estar entre {min} e {max}."
  },
  "COMMAND_FAILED": {
    "en": "Could not run {command}.",
    "pt": "Não foi possível executar {command}."
  },
  "proxy_redirect": {
    "en": "The PC tried to redirect the connection.",
    "pt": "O PC tentou redirecionar a conexão."
  },
  "proxy_unavailable": {
    "en": "Could not connect securely to the PC. Check Tailscale.",
    "pt": "Não foi possível conectar ao PC com segurança. Confira o Tailscale."
  },
  "proxy_background": {
    "en": "Ponte is in the background.",
    "pt": "Ponte está em segundo plano."
  },
  "proxy_incomplete": {
    "en": "Incomplete request.",
    "pt": "Pedido incompleto."
  },
  "proxy_headers_large": {
    "en": "Request headers are too large.",
    "pt": "Cabeçalho muito grande."
  },
  "proxy_request": {
    "en": "Invalid request.",
    "pt": "Pedido inválido."
  },
  "proxy_path": {
    "en": "Invalid path.",
    "pt": "Caminho inválido."
  },
  "proxy_path_denied": {
    "en": "Path is not allowed.",
    "pt": "Caminho não permitido."
  },
  "proxy_header": {
    "en": "Invalid header.",
    "pt": "Cabeçalho inválido."
  },
  "proxy_host": {
    "en": "Invalid local origin.",
    "pt": "Origem local inválida."
  },
  "proxy_origin": {
    "en": "Origin is not allowed.",
    "pt": "Origem não permitida."
  },
  "proxy_encoding": {
    "en": "Transfer-Encoding is not allowed in requests.",
    "pt": "Transfer-Encoding não permitido no pedido."
  },
  "proxy_expect": {
    "en": "Expect is not allowed.",
    "pt": "Expect não permitido."
  },
  "proxy_size": {
    "en": "Invalid request size.",
    "pt": "Tamanho inválido."
  },
  "proxy_limit": {
    "en": "The upload exceeds 26 MB.",
    "pt": "O envio excede 26 MB."
  },
  "proxy_body": {
    "en": "A request body is not allowed.",
    "pt": "Corpo não permitido."
  },
  "TERMINAL_IN_COPY_MODE": {
    "en": "This terminal is in copy mode. Exit that mode in the PC terminal before sending input.",
    "pt": "Este terminal está no modo de cópia. Saia desse modo no terminal do PC antes de enviar comandos."
  },
  "TERMINAL_UNAVAILABLE": {
    "en": "Terminals are unavailable. Check that tmux is installed and private terminal storage is accessible.",
    "pt": "Terminais indisponíveis. Verifique se o tmux está instalado e se o armazenamento privado está acessível."
  },
  "TERMINAL_NOT_FOUND": {
    "en": "This terminal session is no longer available.",
    "pt": "Esta sessão de terminal não está mais disponível."
  },
  "TERMINAL_CHANGED": {
    "en": "This terminal was changed outside Ponte and cannot be controlled here.",
    "pt": "Este terminal foi alterado fora do Ponte e não pode ser controlado aqui."
  },
  "TERMINAL_LIMIT_REACHED": {
    "en": "Four terminals are already open. Close one to create another.",
    "pt": "Já existem quatro terminais abertos. Feche um para criar outro."
  },
  "INVALID_TERMINAL_SIZE": {
    "en": "Terminal size must be 20–240 columns and 8–100 rows.",
    "pt": "O terminal deve ter de 20 a 240 colunas e de 8 a 100 linhas."
  },
  "INVALID_TERMINAL_INPUT": {
    "en": "Send either text or one terminal key.",
    "pt": "Envie texto ou uma tecla do terminal."
  }
};
  const storageKey = 'ponte-language';
  let language = 'en';
  try { if (localStorage.getItem(storageKey) === 'pt') language = 'pt'; } catch {}
  const reverse = new Map(Object.entries(english).map(([key,value]) => [value,key]));
  const rendered = new Map();
  const canonical = key => Object.hasOwn(english,key) ? key : reverse.get(key) || key;
  const locale = () => language === 'pt' ? 'pt-BR' : 'en';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function t(key, values = {}) {
    if (rendered.has(key) && !Object.keys(values).length) { const previous = rendered.get(key); key = previous.key; values = previous.values; }
    key = canonical(key);
    const message = language === 'pt' ? key : english[key] ?? key;
    const result = message.replace(/\{([a-zA-Z]+)\}/g, (match,name) => Object.hasOwn(values,name) ? String(values[name]) : match);
    if (Object.hasOwn(english,key) && Object.keys(values).length) {
      if (rendered.size >= 200) rendered.delete(rendered.keys().next().value);
      rendered.set(result,{key,values});
    }
    return result;
  }
  function plural(one,many,count,values = {}) {
    return t(new Intl.PluralRules(locale()).select(count) === 'one' ? one : many,{...values,count:new Intl.NumberFormat(locale()).format(count)});
  }
  function html(key,values = {}) {
    return `<span data-i18n="${escape(canonical(key))}" data-i18n-values="${escape(JSON.stringify(values))}">${escape(t(key,values))}</span>`;
  }
  function apiMessage(code,parameters = {},fallback = '') {
    const entry = Object.hasOwn(apiMessages,code) ? apiMessages[code] : null;
    if (!entry) return fallback;
    return entry[language].replace(/\{(\w+)\}/g, (match,name) => Object.hasOwn(parameters,name) ? String(parameters[name]) : match);
  }
  function write(element,value) {
    element.removeAttribute('data-api-code'); element.removeAttribute('data-api-parameters');
    const code = value && typeof value === 'object' ? value.errorCode : null;
    const fallback = value && typeof value === 'object' ? value.message : String(value ?? '');
    if (code && Object.hasOwn(apiMessages,code)) {
      const parameters = value.errorParameters || {};
      element.setAttribute('data-api-code',code);
      element.setAttribute('data-api-parameters',JSON.stringify(parameters));
      element.textContent = apiMessage(code,parameters,fallback);
    } else element.textContent = fallback;
  }
  function read(element) {
    const errorCode = element.getAttribute('data-api-code');
    return errorCode ? {errorCode,errorParameters:JSON.parse(element.getAttribute('data-api-parameters') || '{}'),message:element.textContent} : t(element.textContent);
  }
  function formatBytes(bytes) {
    return bytes >= 1024*1024 ? `${new Intl.NumberFormat(locale(),{minimumFractionDigits:1,maximumFractionDigits:1}).format(bytes/1024/1024)} MB` : `${new Intl.NumberFormat(locale()).format(Math.max(1,Math.round(bytes/1024)))} KB`;
  }
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(element => {
      const values = JSON.parse(element.getAttribute('data-i18n-values') || '{}');
      element.textContent = t(element.getAttribute('data-i18n'),values);
    });
    for (const attr of ['aria-label','placeholder','title','alt','content']) {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach(element => element.setAttribute(attr,t(element.getAttribute(`data-i18n-${attr}`))));
    }
    root.querySelectorAll('[data-i18n-date]').forEach(element => {
      const date = new Date(element.getAttribute('data-i18n-date'));
      element.textContent = Number.isNaN(date.getTime()) ? t('Data indisponível') : date.toLocaleString(locale(),{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    });
    root.querySelectorAll('[data-api-code]').forEach(element => { element.textContent = apiMessage(element.getAttribute('data-api-code'),JSON.parse(element.getAttribute('data-api-parameters') || '{}'),element.textContent); });
    root.querySelectorAll('[data-i18n-bytes]').forEach(element => { element.textContent = formatBytes(Number(element.getAttribute('data-i18n-bytes'))); });
    root.querySelectorAll('[data-language-select]').forEach(select => { select.value = language; });
  }
  function setLanguage(next) {
    if (!['en','pt'].includes(next)) return;
    language = next;
    try { localStorage.setItem(storageKey,language); } catch {}
    document.documentElement.lang = locale();
    apply();
    const title = document.querySelector('title[data-i18n]');
    if (title) document.title = t(title.dataset.i18n);
    document.dispatchEvent(new CustomEvent('ponte-language-change',{detail:{language,locale:locale()}}));
  }
  window.PonteI18n = {t,html,plural,formatBytes,apiMessage,write,read,apiMessages,apply,setLanguage,canonical,escape,get language(){return language;},get locale(){return locale();},messages:english};
  document.documentElement.lang = locale();
  document.addEventListener('change',event => { if (event.target.matches('[data-language-select]')) setLanguage(event.target.value); });
  window.addEventListener('storage',event => { if (event.key === storageKey) setLanguage(event.newValue === 'pt' ? 'pt' : 'en'); });
  apply();
})();

export const messages = {
  "INVALID_AGENT_QUERY": {
    "en": "Invalid conversation cursor or wait time.",
    "pt": "Cursor de conversa ou tempo de espera inválido."
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
  },
  "AGENT_NOT_ALLOWED": {
    "en": "Choose Claude, Codex, Terminal or SSH to start a session.",
    "pt": "Escolha Claude, Codex, Terminal ou SSH para começar uma sessão."
  },
  "SSH_HOST_NOT_ALLOWED": {
    "en": "That machine is not in this computer's SSH list.",
    "pt": "Essa máquina não está na lista de SSH deste computador."
  },
  "AGENT_UNAVAILABLE": {
    "en": "{agent} is not installed on the PC.",
    "pt": "{agent} não está instalado no PC."
  },
  "INVALID_PROMPT": {
    "en": "The request must have 1–4000 characters of plain text, not starting with a dash.",
    "pt": "O pedido deve ter de 1 a 4000 caracteres de texto simples, sem começar com hífen."
  },
  "PROJECT_NOT_ALLOWED": {
    "en": "That folder is not a project in ~/Projects.",
    "pt": "Essa pasta não é um projeto em ~/Projects."
  },
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
    "en": "Frame rate must be between 1 and 20 frames per second.",
    "pt": "A taxa deve estar entre 1 e 20 quadros por segundo."
  },
  "INVALID_SCALE": {
    "en": "Scale must be between 0.2 and 1.",
    "pt": "A escala deve estar entre 0,2 e 1."
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
  "POINTER_INACCURATE": {
    "en": "The last pointer placement missed: pointer acceleration is still scaling the virtual mouse.",
    "pt": "O último posicionamento do ponteiro errou: a aceleração do mouse ainda está escalando o mouse virtual."
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
  "TERMINAL_TEXT_INVALID": {
    "en": "Send 1 to 16000 characters; line breaks are allowed, other control characters are not.",
    "pt": "Envie de 1 a 16000 caracteres; quebras de linha podem, outros controles não."
  },
  "TERMINAL_PC_LOCKED": {
    "en": "The PC is locked. Unlock it before opening this session there.",
    "pt": "O PC está bloqueado. Desbloqueie antes de abrir esta sessão nele."
  },
  "TERMINAL_OPEN_FAILED": {
    "en": "The PC could not open a terminal window for this session.",
    "pt": "O PC não conseguiu abrir uma janela de terminal para esta sessão."
  },
  "MULTILINE_NOT_SUPPORTED": {
    "en": "This terminal is not waiting for pasted text now, so several lines would run one by one. Send one line at a time.",
    "pt": "Este terminal não está esperando texto colado agora, então várias linhas rodariam uma a uma. Mande uma linha por vez."
  },
  "INVALID_WINDOW": {
    "en": "Invalid window identifier.",
    "pt": "Identificador de janela inválido."
  },
  "WINDOW_CLOSED": {
    "en": "This window is no longer open.",
    "pt": "A janela não está mais aberta."
  },
  "AGENT_NOT_FOUND": {
    "en": "This agent or terminal is no longer running.",
    "pt": "Este agente ou terminal não está mais rodando."
  },
  "AGENT_NOT_INTERACTIVE": {
    "en": "This agent has no terminal window or Ponte session to type into.",
    "pt": "Este agente não tem janela de terminal nem sessão do Ponte para digitar."
  },
  "AGENT_FOCUS_FAILED": {
    "en": "The agent's window did not take focus, so nothing was typed.",
    "pt": "A janela do agente não recebeu o foco, então nada foi digitado."
  },
  "AGENT_PC_LOCKED": {
    "en": "The PC is locked. Unlock it before replying to an agent.",
    "pt": "O PC está bloqueado. Desbloqueie antes de responder a um agente."
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
  "IMAGE_NOT_FOUND": {
    "en": "Image not found.",
    "pt": "Imagem não encontrada."
  },
  "UNSUPPORTED_IMAGE_FORMAT": {
    "en": "Use a PNG, JPEG or WebP image.",
    "pt": "Use uma imagem PNG, JPEG ou WebP."
  },
  "EMPTY_IMAGE": {
    "en": "The image is empty or incomplete.",
    "pt": "A imagem está vazia ou incompleta."
  },
  "IMAGE_TOO_LARGE": {
    "en": "Images must not exceed 20 MiB.",
    "pt": "A imagem deve ter no máximo 20 MiB."
  },
  "IMAGE_FORMAT_MISMATCH": {
    "en": "The content does not match its image format.",
    "pt": "O conteúdo não corresponde ao formato da imagem."
  },
  "INVALID_IMAGE_TARGET": {
    "en": "Choose one Ponte terminal to paste into.",
    "pt": "Escolha um terminal do Ponte para colar."
  },
  "CLIPBOARD_UNAVAILABLE": {
    "en": "The PC clipboard is unavailable. Check that wl-copy is installed and the desktop session is running.",
    "pt": "A área de transferência do PC está indisponível. Verifique se o wl-copy está instalado e a sessão gráfica está ativa."
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
  "INVALID_POWER_STATE": {
    "en": "Power state must be either on or off.",
    "pt": "O estado de energia deve ser ligado ou desligado."
  },
  "STT_UNAVAILABLE": {
    "en": "Speech recognition is unavailable on the PC. Start Sussurro or OmniVoice Studio.",
    "pt": "Reconhecimento de voz indisponível no PC. Abra o Sussurro ou o OmniVoice Studio."
  },
  "STT_FAILED": {
    "en": "The PC could not transcribe this audio.",
    "pt": "O PC não conseguiu transcrever este áudio."
  },
  "STT_EMPTY": {
    "en": "No speech was recognized. Try again closer to the microphone.",
    "pt": "Nenhuma fala reconhecida. Tente de novo mais perto do microfone."
  },
  "INVALID_PRESET": {
    "en": "Unknown light preset.",
    "pt": "Preset de luzes desconhecido."
  },
  "INVALID_PASSWORD": {
    "en": "Send the unlock password as text with 1 to 256 characters.",
    "pt": "Envie a senha de desbloqueio como texto de 1 a 256 caracteres."
  },
  "LOCK_UNAVAILABLE": {
    "en": "The Omarchy lock screen is unavailable on the PC.",
    "pt": "A tela de bloqueio do Omarchy está indisponível no PC."
  },
  "SESSION_NOT_LOCKED": {
    "en": "The PC is not locked, so no password was typed.",
    "pt": "O PC não está bloqueado, então nenhuma senha foi digitada."
  },
  "LIGHTS_UNAVAILABLE": {
    "en": "The Magma lights controller is not installed on the PC.",
    "pt": "O controlador de luzes Magma não está instalado no PC."
  },
  "LIGHTS_FAILED": {
    "en": "These lights did not respond: {devices}. Details are in the PC journal.",
    "pt": "Estas luzes não responderam: {devices}. Detalhes no journal do PC."
  },
  "SLEEP_LIGHTS_FAILED": {
    "en": "Monitors are off, but these lights stayed on: {devices}. Details are in the PC journal.",
    "pt": "Monitores apagados, mas estas luzes ficaram acesas: {devices}. Detalhes no journal do PC."
  },
  "INVALID_QUALITY": {
    "en": "JPEG quality must be between 30 and 90.",
    "pt": "A qualidade JPEG deve estar entre 30 e 90."
  },
  "AUTOPAIR_DENIED": {
    "en": "This device is not on your tailnet, so it needs the pairing key.",
    "pt": "Este aparelho não está no seu tailnet, então precisa da chave de pareamento."
  },
  "MESH_NOT_OWNER": {
    "en": "Only a device of this computer's owner on the tailnet, without tags, can ask for access.",
    "pt": "Só um aparelho do dono deste computador no tailnet, sem tag, pode pedir acesso."
  },
  "MESH_INVALID_REQUEST": {
    "en": "Invalid pairing request.",
    "pt": "Pedido de pareamento inválido."
  },
  "MESH_TOO_MANY_REQUESTS": {
    "en": "There are already 5 pending requests. Approve or deny one, or wait 10 minutes.",
    "pt": "Já há 5 pedidos pendentes. Aprove ou negue um, ou espere 10 minutos."
  },
  "MESH_REQUEST_NOT_FOUND": {
    "en": "This access request no longer exists. Ask again.",
    "pt": "Este pedido de acesso não existe mais. Peça de novo."
  },
  "MESH_CODE_NOT_FOUND": {
    "en": "No pending request has this code.",
    "pt": "Nenhum pedido pendente tem esse código."
  },
  "MESH_OWNER_ONLY": {
    "en": "Only this device's owner manages pairings, never another device.",
    "pt": "Só o dono deste aparelho gerencia pareamentos, nunca outro aparelho."
  },
  "MESH_CHAIN_DENIED": {
    "en": "A paired device cannot relay to a third device.",
    "pt": "Um aparelho pareado não pode repassar para um terceiro."
  },
  "MESH_PEER_ADDRESS": {
    "en": "This device key works only from the device it was approved for.",
    "pt": "Esta chave de aparelho só vale do aparelho para o qual foi aprovada."
  },
  "MESH_PEER_NOT_FOUND": {
    "en": "No device with that name or id was found.",
    "pt": "Nenhum aparelho com esse nome ou id foi encontrado."
  },
  "MESH_PEER_AMBIGUOUS": {
    "en": "More than one device has this name. Use its id.",
    "pt": "Mais de um aparelho tem esse nome. Use o id."
  },
  "MESH_PEER_NOT_PAIRED": {
    "en": "{name} runs Ponte but is not paired with this device yet. Ask for access first.",
    "pt": "{name} tem Ponte, mas ainda não está pareado com este aparelho. Peça acesso primeiro."
  },
  "DEVICE_NOT_PONTE": {
    "en": "{name} does not run Ponte: it can be reached by SSH, not controlled.",
    "pt": "{name} não roda a Ponte: dá para chegar por SSH, não controlar."
  },
  "RD_PEER_CONTROL": {
    "en": "{name} is controlling this screen through Ponte.",
    "pt": "{name} está controlando esta tela pela Ponte."
  },
  "PEER_OFFLINE": {
    "en": "{name} is not answering. Check that it is on and on Tailscale.",
    "pt": "{name} não está respondendo. Confira se está ligado e no Tailscale."
  },
  "PEER_REVOKED": {
    "en": "{name} no longer accepts this device. Pair again.",
    "pt": "{name} não aceita mais este aparelho. Pareie de novo."
  },
  "PEER_UNTRUSTED": {
    "en": "{name} presented a certificate that does not match the one saved when pairing.",
    "pt": "{name} apresentou um certificado diferente do salvo no pareamento."
  },
  "FLEET_UNAVAILABLE": {
    "en": "The fleet folder is not private. Check the permissions of Ponte's data folder.",
    "pt": "A pasta da frota não está privada. Confira as permissões da pasta de dados do Ponte."
  },
  "FLEET_MACHINE_NOT_FOUND": {
    "en": "This machine is not in the fleet. Refresh the list.",
    "pt": "Esta máquina não está na frota. Atualize a lista."
  },
  "FLEET_INVALID_REQUEST": {
    "en": "Invalid fleet request.",
    "pt": "Pedido inválido para a frota."
  },
  "FLEET_PROBE_REFUSED": {
    "en": "The machine refused the request ({reason}).",
    "pt": "A máquina recusou o pedido ({reason})."
  },
  "FLEET_HANDOFF_BUSY": {
    "en": "This session is already being moved.",
    "pt": "Esta sessão já está sendo transferida."
  },
  "FLEET_JOB_NOT_FOUND": {
    "en": "This transfer is no longer tracked.",
    "pt": "Esta transferência não está mais registrada."
  },
  "FLEET_SESSION_LIVE": {
    "en": "The agent is still open on the other machine. Close it there, or continue anyway with force.",
    "pt": "O agente ainda está aberto na outra máquina. Feche lá ou continue mesmo assim forçando."
  },
  "FLEET_RESUME_FAILED": {
    "en": "The session was copied but could not be opened in a terminal.",
    "pt": "A sessão foi copiada, mas não abriu num terminal."
  },
  "FLEET_HANDOFF_FAILED": {
    "en": "The transfer stopped at {stage}. Nothing was discarded.",
    "pt": "A transferência parou em {stage}. Nada foi descartado."
  },
  "FLEET_NO_ROUTE": {
    "en": "There is no SSH route to this machine. Add it to ~/.ssh/config.",
    "pt": "Não há rota SSH para esta máquina. Adicione em ~/.ssh/config."
  },
  "FLEET_NO_CHECKOUT": {
    "en": "The project is not on the destination and could not be cloned ({dir}).",
    "pt": "O projeto não está no destino e não deu para clonar ({dir})."
  },
  "FLEET_DEST_DIRTY": {
    "en": "The destination has uncommitted changes in {dir}. Commit or stash them there first; nothing was touched.",
    "pt": "O destino tem mudanças sem commit em {dir}. Faça commit ou stash lá antes; nada foi mexido."
  },
  "FLEET_DIVERGED": {
    "en": "Branch {branch} diverged between the machines. Merge or rebase by hand; nothing was touched.",
    "pt": "A branch {branch} divergiu entre as máquinas. Faça merge ou rebase à mão; nada foi mexido."
  },
  "FLEET_HEAD_MISMATCH": {
    "en": "The source branch moved during the transfer. Try again.",
    "pt": "A branch de origem andou durante a transferência. Tente de novo."
  },
  "FLEET_UNTRACKED_EXISTS": {
    "en": "A new file from the source already exists on the destination. Nothing was overwritten.",
    "pt": "Um arquivo novo da origem já existe no destino. Nada foi sobrescrito."
  },
  "FLEET_PATCH_FAILED": {
    "en": "The uncommitted changes did not apply cleanly on the destination. Nothing was changed.",
    "pt": "As mudanças sem commit não entraram limpas no destino. Nada foi alterado."
  },
  "FLEET_DEST_NEWER": {
    "en": "The destination has a newer copy of this session. Continue with force to replace it (a backup is kept).",
    "pt": "O destino tem uma cópia mais nova desta sessão. Continue forçando para substituir (fica um backup)."
  },
  "FLEET_SESSION_NOT_FOUND": {
    "en": "This session no longer exists on the source machine.",
    "pt": "Esta sessão não existe mais na máquina de origem."
  },
  "FLEET_CLONE_FAILED": {
    "en": "Cloning the project on the destination failed. Check its access to the repository.",
    "pt": "Falhou ao clonar o projeto no destino. Confira o acesso dele ao repositório."
  },
  "FLEET_TIMEOUT": {
    "en": "The machine did not answer in time.",
    "pt": "A máquina não respondeu a tempo."
  },
  "FLEET_AUTH": {
    "en": "SSH refused the key. Check the key on that machine.",
    "pt": "O SSH recusou a chave. Confira a chave nessa máquina."
  },
  "FLEET_UNREACHABLE": {
    "en": "The machine is unreachable.",
    "pt": "A máquina está inalcançável."
  },
  "FLEET_TAILSCALE_CHECK": {
    "en": "Tailscale SSH asks for a browser check on this route. Use a key route instead.",
    "pt": "O Tailscale SSH pede checagem no navegador nesta rota. Use uma rota por chave."
  },
  "WOL_INSTRUCTIONS": {
    "en": "Enable Wake-on-LAN in UEFI/BIOS (Power On By PCI-E) and Linux with sudo ethtool -s {interface} wol g. Wake with Magic Packet to {mac} on UDP port 9.",
    "pt": "Habilite Wake-on-LAN na BIOS/UEFI (Power On By PCI-E) e no Linux com sudo ethtool -s {interface} wol g. Acorde com Magic Packet para {mac} na porta UDP 9."
  }
};

export function message(code, locale = 'en', parameters = {}) {
  const entry = Object.hasOwn(messages, code) ? messages[code] : messages.INTERNAL_ERROR;
  const template = entry[locale === 'pt' ? 'pt' : 'en'];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(parameters[name] ?? `{${name}}`));
}

export function publicErrorParameters(code, parameters = {}) {
  const template = Object.hasOwn(messages, code) ? messages[code].en : '';
  const result = {};
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    if (!parameters || !Object.hasOwn(parameters, name)) continue;
    const value = parameters[name];
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[name] = value;
  }
  return result;
}

export function requestLocale(req) {
  try {
    const query = new URL(req.url, 'http://localhost').searchParams;
    if (query.has('lang')) return /^pt(?:-|$)/i.test(query.get('lang')) ? 'pt' : 'en';
  } catch {}
  const values = String(req.headers['accept-language'] || '').split(',').slice(0, 20).map((item, index) => {
    const [tag, ...parameters] = item.trim().split(';');
    const weight = parameters.find(value => /^q=/i.test(value.trim()));
    const q = weight === undefined ? 1 : Number(weight.trim().slice(2));
    const locale = /^pt(?:-|$)/i.test(tag) ? 'pt' : /^(?:en(?:-|$)|\*$)/i.test(tag) ? 'en' : null;
    return { locale, q, index };
  }).filter(item => item.locale && Number.isFinite(item.q) && item.q > 0 && item.q <= 1);
  values.sort((a, b) => b.q - a.q || a.index - b.index);
  return values[0]?.locale || 'en';
}

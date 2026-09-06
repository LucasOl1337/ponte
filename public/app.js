'use strict';
const i18n = window.PonteI18n;
const t = i18n.t;
const h = i18n.html;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escaped = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storageKey = 'ponte-pair-token';
let token = '';
let state = null;
let connected = false;
let polling = false;
let currentPage = 'tela';
let liveWanted = true;
let nativePaused = false;
const savedPreference = (key, fallback = '') => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const savePreference = (key,value) => { try { localStorage.setItem(key,value); } catch {} };
let controlMode = 'view';
let lastInputMode = 'mouse';
let lastScreenMode = 'view';
let remoteInputGeneration = 0;
let viewportBaseline = {width:0,height:0};
let chosenWorkspace = 'all';
let windowSignature = '';
let workspaceSignature = '';
let monitorSignature = '';
let audioSignature = '';
let audioLoaded = false;
let audioLoading = false;
let toastTimer;
let screenshotURL;
let deferredInstall;
let volumeEditing = false;
const busyControls = new Set();

try { token = localStorage.getItem(storageKey) || ''; } catch {}
if (location.hash.startsWith('#pair=')) {
  try { token = decodeURIComponent(location.hash.slice(6)); } catch { token = ''; }
  history.replaceState(null, '', location.pathname + location.search);
  if (token) { try { localStorage.setItem(storageKey, token); } catch {} }
}

function toast(message, error = false) {
  const element = $('#toast');
  clearTimeout(toastTimer);
  i18n.write(element,message);
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 6500 : 3300);
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  const requestToken = token;
  const headers = {'Accept-Language':i18n.locale,Authorization: `Bearer ${requestToken}`, ...options.headers};
  try {
    const response = await fetch(`/api${path}`, { ...options, headers, signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      let message = t("Não foi possível concluir a ação.");
      let details;
      try { details = await response.json(); message = details.error || message; } catch {}
      if (response.status === 401 && token === requestToken) {
        connected = false;
        token = '';
        try { localStorage.removeItem(storageKey); } catch {}
        showPairing(t("A chave não foi aceita. Cole a chave atual do PC para reconectar."));
      }
      throw Object.assign(new Error(message),{errorCode:details?.errorCode,errorParameters:details?.errorParameters});
    }
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(t("O PC demorou para responder. Tente novamente."));
    if (error instanceof TypeError) throw new Error(t("Sem resposta do PC. Confira o Tailscale e a conexão."));
    throw error;
  } finally { clearTimeout(timeout); }
}

async function action(type, payload = {}, feedback = '') {
  if (!connected) { toast(t("Reconecte ao PC para usar este controle."), true); return false; }
  try {
    await api('/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type,...payload}) });
    if (feedback) toast(feedback);
    if (!type.startsWith('mouse.')) setTimeout(pollState, 180);
    return true;
  } catch (error) { toast(error, true); return false; }
}

function showPairing(error = '') {
  leaveScreen(); clearScreenImage(); cancelPendingRecording();
  clearTimeout(terminalTimer); terminalGeneration++; terminalDrafts.clear(); terminalId = ''; terminalSessions = []; terminalText = null;
  $('#terminal-output').textContent = ''; $('#terminal-input').value = ''; terminalControls();
  if (recorder?.state === 'recording') stopRecording();
  $('#pairing').hidden = false;
  $('#paired-app').hidden = true;
  $('#bottom-nav').hidden = true;
  $('#connection-banner').hidden = true;
  i18n.write($('#pair-error'),error);
  $('#pair-error').hidden = !error;
  $('#unpair-button').hidden = true;
  $('#dialog-status').textContent = t("Não conectado");
}

function showApp() {
  $('#pairing').hidden = true;
  $('#paired-app').hidden = false;
  $('#bottom-nav').hidden = false;
  $('#unpair-button').hidden = false;
}

function setConnection(isConnected, error = '') {
  connected = isConnected;
  $('#home-status').textContent = isConnected ? t("SEU PC ESTÁ CONECTADO") : t("RECONEXÃO AUTOMÁTICA");
  $('#pc-online').textContent = isConnected ? 'online' : 'offline';
  $('#pc-online').classList.toggle('offline', !isConnected);
  $('#dialog-status').textContent = isConnected ? t("Conexão privada · navegador pareado") : t("Aguardando resposta do computador");
  $('#connection-banner').hidden = isConnected || !token;
  if (!isConnected) i18n.write($('#connection-banner-text'),error || t("Conexão interrompida. Tentando reconectar…"));
  $$('[data-app],[data-action],[data-key],#mute-button,#send-text,#left-click,#right-click,#drag-button,#stop-pc-audio').forEach(button => { button.disabled = !isConnected || busyControls.has(button.id); });
  $('#volume').disabled = !isConnected;
  $('#capture-button').disabled = !isConnected || !state?.capabilities?.screenshot || busyControls.has('capture-button');
  updateScreenButtons();
  if (isConnected && state) updateCapabilities();
  if (!isConnected) {
    $('#touchpad').setAttribute('aria-disabled', 'true');
    $('#touchpad-state').textContent = t("AGUARDANDO CONEXÃO");
  }
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(0,Math.floor(seconds / 60))}m`;
}

function updateCapabilities() {
  const caps = state.capabilities || {};
  const hasMouse = connected && !!caps.mouse;
  const hasKeyboard = connected && !!caps.keyboard;
  $('#touchpad').setAttribute('aria-disabled', String(!hasMouse));
  $('#touchpad-state').textContent = hasMouse ? t("PRONTO PARA O TOQUE") : t("INDISPONÍVEL NO PC");
  $('#mouse-unavailable').hidden = !!caps.mouse;
  $('#keyboard-unavailable').hidden = !!caps.keyboard;
  $$('#left-click,#right-click,#drag-button').forEach(button => { button.disabled = !hasMouse; });
  $$('[data-key],#send-text,#keyboard-text').forEach(element => { element.disabled = !hasKeyboard || busyControls.has(element.id); });
  $('#capture-button').disabled = !connected || !caps.screenshot || !(state.monitors?.length) || busyControls.has('capture-button');
  $('#stop-pc-audio').disabled = !connected || !caps.audio;
  updateScreenButtons();
  const labels = {mouse:t("Mouse"), keyboard:t("Teclado"), screenshot:t("Foto do monitor"), live:t("Tela ao vivo"), audio:t("Áudio no PC")};
  $('#capability-list').innerHTML = Object.entries(labels).map(([key,label]) => `<div class="capability ${caps[key] ? '' : 'unavailable'}">${icon(caps[key] ? 'check' : 'close')}<span>${label}</span></div>`).join('');
  const warnings = state.warnings || [];
  $('#warnings').hidden = !warnings.length;
  $('#warnings').innerHTML = warnings.map((warning,index) => `<p>${escaped(i18n.apiMessage(state.warningCodes?.[index],{},warning))}</p>`).join('');
}

function renderState() {
  $('#hostname').textContent = state.hostname || 'Omarchy';
  $('#dialog-hostname').textContent = state.hostname || 'Omarchy';
  $('#stat-windows').textContent = state.windows?.length ?? 0;
  $('#stat-workspaces').textContent = (state.workspaces || []).filter(ws => Number.isInteger(ws.id) && ws.id >= 1 && ws.id <= 100).length;
  $('#stat-uptime').textContent = formatUptime(state.uptime);
  $('#keyboard-target').textContent = t('Texto vai para a janela em foco: {title}',{title:state.activeWindow?.title || t('Nenhuma janela em foco')});
  $('#focus-summary').textContent = state.activeWindow?.title || t("Nenhuma janela em foco");
  if (!volumeEditing) {
    const volume = Math.round((state.volume?.value || 0) * 100);
    $('#volume').value = Math.min(100, Math.max(0, volume));
    $('#volume-value').textContent = `${volume}%`;
    $('#volume').style.setProperty('--volume', `${Math.min(100,volume)}%`);
  }
  const muted = !!state.volume?.muted;
  $('#mute-button').setAttribute('aria-label', muted ? t("Ativar som do PC") : t("Silenciar som do PC"));
  $('#mute-button').setAttribute('aria-pressed', String(muted));
  $('#mute-button').innerHTML = icon(muted ? 'muted' : 'volume');
  renderWorkspaces();
  renderWindows();
  const monitors = state.monitors || [];
  const nextMonitorSignature = JSON.stringify([monitors,i18n.language]);
  if (monitorSignature !== nextMonitorSignature) {
    monitorSignature = nextMonitorSignature;
    const selected = $('#monitor-select').value || savedPreference('ponte-monitor');
    $('#monitor-select').innerHTML = monitors.length ? monitors.map(m => `<option value="${escaped(m.name)}">${escaped(m.name)} · ${Number(m.width)} × ${Number(m.height)}${m.focused ? t(" · em foco") : ''}</option>`).join('') : `<option value="">${escaped(t("Nenhum monitor disponível"))}</option>`;
    const next = monitors.find(m => m.name === selected) || monitors.find(m => m.focused) || monitors[0];
    if (next) { $('#monitor-select').value = next.name; if (!savedPreference('ponte-monitor')) savePreference('ponte-monitor',next.name); }
    if (selected && next?.name !== selected) { liveWanted = false; stopLive(t("Monitor alterado. Inicie a transmissão do monitor escolhido.")); cancelSnapshot(); clearScreenImage(); }
    $('#viewer-monitor-name').textContent = next?.name || t("Nenhum monitor");
  }
  updateScreenButtons();
  reconcileLive();
}

function renderWorkspaces() {
  const spaces = (state?.workspaces || []).filter(ws => Number.isInteger(ws.id) && ws.id >= 1 && ws.id <= 100);
  if (chosenWorkspace !== 'all' && !spaces.some(ws => String(ws.id) === chosenWorkspace)) chosenWorkspace = 'all';
  const active = state?.activeWindow?.workspace?.id;
  const signature = JSON.stringify([spaces,active,chosenWorkspace,i18n.language]);
  if (workspaceSignature === signature) return;
  workspaceSignature = signature;
  $('#home-workspaces').innerHTML = spaces.length ? spaces.map(ws => `<button class="workspace ${ws.id === active ? 'active' : ''}" data-workspace="${Number(ws.id)}" aria-label="${escaped(i18n.plural('Ir para área {workspace}, {count} janela','Ir para área {workspace}, {count} janelas',Number(ws.windows || 0),{workspace:ws.name || ws.id}))}" ${ws.id === active ? 'aria-current="true"' : ''}>${escaped(ws.name || ws.id)}${ws.windows ? `<i class="workspace-dot" aria-hidden="true"></i>` : ''}</button>`).join('') : `<p class="hint">${h("Nenhuma área de trabalho disponível.")}</p>`;
  $('#window-workspaces').innerHTML = `<button class="workspace ${chosenWorkspace === 'all' ? 'active' : ''}" data-filter="all" aria-pressed="${chosenWorkspace === 'all'}"><span class="workspace-label">${h("Todas")}</span></button>` + spaces.map(ws => `<button class="workspace ${String(ws.id) === chosenWorkspace ? 'active' : ''}" data-filter="${Number(ws.id)}" aria-pressed="${String(ws.id) === chosenWorkspace}" aria-label="${escaped(t('Filtrar área {workspace}',{workspace:ws.name || ws.id}))}">${escaped(ws.name || ws.id)}</button>`).join('');
}

function appIcon(className) {
  const name = (className || '').toLowerCase();
  if (/terminal|alacritty|kitty|ghostty|foot/.test(name)) return 'terminal';
  if (/chrom|firefox|browser|brave|edge/.test(name)) return 'browser';
  if (/nautilus|thunar|dolphin|file/.test(name)) return 'folder';
  return 'windows';
}

function renderWindows() {
  if (!state) return;
  const query = $('#window-search').value.trim().toLocaleLowerCase(i18n.locale);
  const windows = (state.windows || []).filter(window => (chosenWorkspace === 'all' || String(window.workspace?.id) === chosenWorkspace) && (!query || `${window.title} ${window.class}`.toLocaleLowerCase(i18n.locale).includes(query)));
  const activeAddress = state.activeWindow?.address;
  const signature = JSON.stringify([windows,activeAddress,query,chosenWorkspace,i18n.language]);
  if (signature === windowSignature) return;
  windowSignature = signature;
  $('#window-count').textContent = i18n.plural('{count} JANELA','{count} JANELAS',windows.length);
  if (!windows.length) {
    $('#window-list').innerHTML = `<div class="empty-state">${icon(query ? 'search' : 'windows')}<strong>${query ? t("Nenhuma janela com esse nome.") : t("Um espaço para começar.")}</strong><p>${query ? t("Tente outro título ou nome de aplicativo.") : t("As janelas abertas no PC aparecerão aqui.")}</p></div>`;
    return;
  }
  $('#window-list').innerHTML = windows.map(window => `<button class="window-card ${window.address === activeAddress ? 'active' : ''}" data-window="${escaped(window.address)}" aria-label="${escaped(t('Focar {title}, área {workspace}',{title:window.title || window.class || t("janela"),workspace:window.workspace?.name || window.workspace?.id || '—'}))}"><span class="window-app-icon">${icon(appIcon(window.class))}</span><span class="window-details"><span>${escaped(window.class || t("Aplicativo"))}</span><strong>${escaped(window.title || t("Janela sem título"))}</strong><small>${escaped(t('Área {workspace}',{workspace:window.workspace?.name || window.workspace?.id || '—'}))}${window.address === activeAddress ? t(" · em foco") : ''}</small></span>${icon(window.address === activeAddress ? 'check' : 'arrow')}</button>`).join('');
}

async function pollState() {
  if (!token || polling || document.hidden) return;
  const requestToken = token;
  polling = true;
  try {
    const response = await api('/state', {timeout:10000});
    const nextState = await response.json();
    if (requestToken !== token) return;
    state = nextState;
    showApp();
    setConnection(true);
    renderState();
    if (currentPage === 'voz' && !audioLoaded) loadAudio();
    if (currentPage === 'terminais') renderDesktopTerminals();
  } catch (error) { if (token && requestToken === token) setConnection(false, error); }
  finally { polling = false; }
}

function isScreenPage(page) { return page === 'tela' || page === 'controle'; }

function setPageLocation(page) {
  currentPage = page;
  document.body.setAttribute('data-current-page',page);
  $$('.nav-item').forEach(element => { const active = element.dataset.nav === page; element.classList.toggle('active', active); if (active) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
  if (location.hash !== `#${page}`) history.replaceState(null,'',`${location.pathname}${location.search}#${page}`);
}

function navigate(page) {
  if (!['inicio','tela','controle','terminais','janelas','voz'].includes(page)) return;
  const wasScreen = isScreenPage(currentPage), nextScreen = isScreenPage(page);
  if (currentPage !== page) resetRemoteInput();
  if (wasScreen && !nextScreen) leaveScreen();
  if (nextScreen && !wasScreen) liveWanted = true;
  setPageLocation(page);
  const visiblePage = page === 'controle' ? 'tela' : page;
  $$('.page').forEach(element => { element.hidden = element.dataset.page !== visiblePage; });
  if (nextScreen) selectControlMode(page === 'tela' ? lastScreenMode : lastInputMode);
  window.scrollTo({top:0,behavior:'instant'});
  if (page === 'voz' && connected) loadAudio();
  reconcileLive();
  updateTerminalNavigation();
}

function selectControlMode(mode, focusTab = false) {
  if (!['view','touch','mouse','keyboard'].includes(mode)) return;
  if (mode !== controlMode) resetRemoteInput();
  if (mode !== 'keyboard' && document.activeElement === $('#keyboard-text')) $('#keyboard-text').blur();
  controlMode = mode;
  if (mode === 'view' || mode === 'touch') lastScreenMode = mode;
  else lastInputMode = mode;
  $('#screen-stage').setAttribute('data-input-mode',mode);
  $('#screen-stage').classList.remove('controls-hidden');
  $('#remote-controls').hidden = mode === 'view' || mode === 'touch';
  $$('[data-control-panel]').forEach(panel => { panel.hidden = panel.dataset.controlPanel !== mode; });
  $$('[data-control-mode]').forEach(tab => {
    const active = tab.dataset.controlMode === mode;
    tab.classList.toggle('active',active);
    tab.setAttribute('aria-pressed',String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focusTab) tab.focus({preventScroll:true});
  });
  if (isScreenPage(currentPage)) setPageLocation(mode === 'view' || mode === 'touch' ? 'tela' : 'controle');
  updatePreviewAria();
  syncRemoteViewport();
  applyScreenZoom();
  window.scrollTo({top:0,behavior:'instant'});
}

function syncRemoteViewport() {
  const width = window.visualViewport?.width || window.innerWidth;
  const height = window.visualViewport?.height || window.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (Math.abs(width - viewportBaseline.width) > 100) viewportBaseline = {width,height};
  else viewportBaseline.height = Math.max(viewportBaseline.height,height);
  const keyboardOpen = controlMode === 'keyboard' && viewportBaseline.height - height > 100;
  document.body.setAttribute('data-keyboard-open',String(keyboardOpen));
  document.documentElement.style.setProperty('--remote-viewport-height',`${height}px`);
  document.documentElement.style.setProperty('--remote-viewport-top',`${window.visualViewport?.offsetTop || 0}px`);
  applyScreenZoom();
}
window.visualViewport?.addEventListener('resize',syncRemoteViewport);
window.visualViewport?.addEventListener('scroll',syncRemoteViewport);
window.addEventListener('resize',syncRemoteViewport);
$('#keyboard-text').addEventListener('focus',syncRemoteViewport);
$('#keyboard-text').addEventListener('blur',syncRemoteViewport);
document.addEventListener('pointerdown',event => {
  if (document.activeElement === $('#keyboard-text') && event.target.closest('#send-text,[data-key]')) event.preventDefault();
});

$('.control-tabs').addEventListener('keydown', event => {
  const modes = ['view','touch','mouse','keyboard'];
  const current = modes.indexOf(controlMode);
  let next;
  if (event.key === 'ArrowRight') next = (current+1)%modes.length;
  else if (event.key === 'ArrowLeft') next = (current+modes.length-1)%modes.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = modes.length-1;
  else return;
  event.preventDefault(); selectControlMode(modes[next],true);
});

document.addEventListener('click', event => {
  const controlTab = event.target.closest('[data-control-mode]');
  if (controlTab) {
    selectControlMode(controlTab.dataset.controlMode);
    if (controlMode === 'keyboard') $('#keyboard-text').focus({preventScroll:true});
  }
  const nav = event.target.closest('[data-nav]');
  if (nav) navigate(nav.dataset.nav);
  const app = event.target.closest('[data-app]');
  if (app) action('app.launch',{app:app.dataset.app}, t("Abrindo no PC…"));
  const generic = event.target.closest('[data-action]');
  if (generic) action(generic.dataset.action);
  const key = event.target.closest('[data-key]');
  if (key) action('keyboard.key',{key:key.dataset.key});
  const workspace = event.target.closest('[data-workspace]');
  if (workspace) action('workspace.focus',{id:Number(workspace.dataset.workspace)}, t('Área {workspace} em foco.',{workspace:workspace.textContent.trim()}));
  const filter = event.target.closest('[data-filter]');
  if (filter) { chosenWorkspace = filter.dataset.filter; renderWorkspaces(); renderWindows(); }
  const windowButton = event.target.closest('[data-window]');
  if (windowButton) action('window.focus',{address:windowButton.dataset.window}, t("Janela em foco no PC."));
});

$('.brand').addEventListener('click', event => { event.preventDefault(); if(token) navigate('inicio'); });
$('#pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const value = $('#pair-token').value.trim();
  if (!value) return;
  token = value;
  try { localStorage.setItem(storageKey, token); } catch {}
  $('#pair-submit').disabled = true;
  $('#pair-submit').innerHTML = h('Conectando…');
  $('#pair-error').hidden = true;
  try {
    const response = await api('/state');
    state = await response.json();
    $('#pair-token').value = '';
    showApp(); setConnection(true); renderState(); navigate('tela');
    toast(t("Sua ponte está pronta."));
  } catch(error) { i18n.write($('#pair-error'),error); $('#pair-error').hidden = false; }
  finally { $('#pair-submit').disabled = false; $('#pair-submit').innerHTML = `${h('Conectar ao meu PC')} ${icon('arrow')}`; }
});
$('#retry-button').addEventListener('click', pollState);
$('#window-search').addEventListener('input', renderWindows);
$('#mute-button').addEventListener('click', () => action('volume.mute'));
$('#volume').addEventListener('pointerdown', () => { volumeEditing = true; });
$('#volume').addEventListener('input', event => {
  volumeEditing = true;
  $('#volume-value').textContent = `${event.target.value}%`;
  event.target.style.setProperty('--volume', `${event.target.value}%`);
});
$('#volume').addEventListener('change', async event => { await action('volume.set',{value:Number(event.target.value)/100}); volumeEditing = false; });
$('#volume').addEventListener('blur', () => { volumeEditing = false; });
$('#send-text').addEventListener('click', async () => {
  if (busyControls.has('send-text')) return;
  const text = $('#keyboard-text').value;
  if (!text) { $('#keyboard-text').focus(); toast(t("Escreva o texto que deseja enviar.")); return; }
  busyControls.add('send-text'); $('#send-text').disabled = true;
  const success = await action('keyboard.text',{text},t("Texto digitado no PC."));
  if (success && $('#keyboard-text').value === text) $('#keyboard-text').value = '';
  busyControls.delete('send-text'); $('#send-text').disabled = !connected || !state?.capabilities?.keyboard;
});

// Live monitor transport: authenticated MJPEG. A photo is always labelled separately.
let liveSession = null;
let screenMode = 'idle';
let screenStatusMessage = '';
let lastScreenTimestamp = null;
let snapshotRequest = null;
let screenZoomed = false;
let screenZoom = 1;
let screenSourceSize = '';
let readAtOriginal = false;
let viewRegion = null;
let liveRegionTimer = 0;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const LONG_PRESS_MS = 500;
const REGION_RECONNECT_PX = 8;
const SCREEN_PAN_SLOP = 12;

class MjpegParser {
  constructor(onFrame,boundary = 'ponte-frame') {
    this.onFrame = onFrame;
    this.boundary = boundary;
    this.header = new Uint8Array(8192);
    this.headerLength = 0;
    this.frame = null;
    this.frameOffset = 0;
    this.timestamp = null;
  }
  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new Error(t("Resposta de vídeo inválida."));
    let offset = 0;
    while (offset < chunk.length) {
      if (this.frame) {
        const count = Math.min(this.frame.length-this.frameOffset,chunk.length-offset);
        this.frame.set(chunk.subarray(offset,offset+count),this.frameOffset);
        this.frameOffset += count; offset += count;
        if (this.frameOffset === this.frame.length) {
          const frame = this.frame;
          this.frame = null; this.frameOffset = 0;
          if (frame[0] !== 255 || frame[1] !== 216 || frame[frame.length-2] !== 255 || frame[frame.length-1] !== 217) throw new Error(t("Quadro JPEG inválido."));
          this.onFrame(frame,this.timestamp);
        }
        continue;
      }
      if (this.headerLength >= this.header.length) throw new Error(t("Cabeçalho do vídeo inválido."));
      this.header[this.headerLength++] = chunk[offset++];
      const n = this.headerLength;
      if (n < 4 || this.header[n-4] !== 13 || this.header[n-3] !== 10 || this.header[n-2] !== 13 || this.header[n-1] !== 10) continue;
      const header = new TextDecoder().decode(this.header.subarray(0,n-4)).replace(/^(?:\r\n)+/,'');
      if (header.split('\r\n')[0] !== `--${this.boundary}` || !/^Content-Type:\s*image\/jpeg\s*$/mi.test(header)) throw new Error(t("Formato de transmissão não reconhecido."));
      const match = /^Content-Length:\s*(\d+)\s*$/mi.exec(header);
      const length = match ? Number(match[1]) : 0;
      if (!Number.isSafeInteger(length) || length < 4 || length > MAX_FRAME_BYTES) throw new Error(t("Tamanho do quadro inválido."));
      const timestamp = /^X-Frame-Timestamp:\s*(\d+)\s*$/mi.exec(header);
      this.timestamp = timestamp ? Number(timestamp[1]) : Date.now();
      this.frame = new Uint8Array(length);
      this.frameOffset = 0; this.headerLength = 0;
    }
  }
}

function mapTouchToMonitorPixel(localX, localY, layout) {
  const imageWidth = Number(layout.imageWidth);
  const imageHeight = Number(layout.imageHeight);
  const monitorWidth = Number(layout.monitorWidth);
  const monitorHeight = Number(layout.monitorHeight);
  if (!(imageWidth > 0) || !(imageHeight > 0) || !(monitorWidth > 0) || !(monitorHeight > 0)) return null;
  const fx = localX / imageWidth, fy = localY / imageHeight;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
  const source = layout.region && layout.region.w > 0 && layout.region.h > 0 ? layout.region : { x: 0, y: 0, w: monitorWidth, h: monitorHeight };
  return {
    x: Math.max(0, Math.min(monitorWidth - 1, Math.round(source.x + fx * source.w))),
    y: Math.max(0, Math.min(monitorHeight - 1, Math.round(source.y + fy * source.h))),
  };
}

function visibleMonitorRegion(layout) {
  const left = Math.max(0, Number(layout.scrollLeft) || 0);
  const top = Math.max(0, Number(layout.scrollTop) || 0);
  const previewWidth = Number(layout.previewWidth);
  const previewHeight = Number(layout.previewHeight);
  const imageWidth = Number(layout.imageWidth);
  const imageHeight = Number(layout.imageHeight);
  if (!(previewWidth > 0) || !(previewHeight > 0) || !(imageWidth > 0) || !(imageHeight > 0)) return null;
  const right = Math.min(imageWidth, left + previewWidth);
  const bottom = Math.min(imageHeight, top + previewHeight);
  if (right - left < 1 || bottom - top < 1) return null;
  const a = mapTouchToMonitorPixel(left, top, layout);
  const b = mapTouchToMonitorPixel(right, bottom, layout);
  if (!a || !b) return null;
  return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
}

function isFullMonitorRegion(region, monitorWidth, monitorHeight) {
  if (!region) return true;
  return region.x <= monitorWidth * 0.02 && region.y <= monitorHeight * 0.02
    && region.w >= monitorWidth * 0.98 && region.h >= monitorHeight * 0.98;
}

function liveStreamPath(session) {
  let path = `/stream?monitor=${encodeURIComponent(session.monitor)}&fps=${session.fps}&scale=${session.scale}`;
  const region = session.region;
  if (region && [region.x, region.y, region.w, region.h].every(value => Number.isInteger(value))) {
    path += `&x=${region.x}&y=${region.y}&w=${region.w}&h=${region.h}`;
  }
  return path;
}

function regionsClose(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < REGION_RECONNECT_PX && Math.abs(a.y - b.y) < REGION_RECONNECT_PX
    && Math.abs(a.w - b.w) < REGION_RECONNECT_PX && Math.abs(a.h - b.h) < REGION_RECONNECT_PX;
}

function classifyScreenGesture({ pointerCount, moved, durationMs }) {
  if (pointerCount >= 2) return 'pinch';
  if (moved) return 'pan';
  if (durationMs >= LONG_PRESS_MS) return 'longpress';
  return 'tap';
}

function scaleMonitorRegion(region, factor, origin, monitorWidth, monitorHeight) {
  const source = region && region.w > 0 && region.h > 0 ? region : { x: 0, y: 0, w: monitorWidth, h: monitorHeight };
  const ox = origin?.x ?? source.x + source.w / 2;
  const oy = origin?.y ?? source.y + source.h / 2;
  const w = Math.max(8, Math.min(monitorWidth, source.w * factor));
  const h = Math.max(8, Math.min(monitorHeight, source.h * factor));
  const x = Math.max(0, Math.min(monitorWidth - w, ox - (ox - source.x) * (w / source.w)));
  const y = Math.max(0, Math.min(monitorHeight - h, oy - (oy - source.y) * (h / source.h)));
  const next = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  return isFullMonitorRegion(next, monitorWidth, monitorHeight) ? null : next;
}

function screenIsVisible() { return isScreenPage(currentPage) && !document.hidden && !nativePaused && !!token; }
function selectedMonitor() {
  const name = $('#monitor-select').value;
  return state?.monitors?.find(item => item.name === name) || null;
}
function previewLayout() {
  const preview = $('#screen-preview');
  const image = $('#screen-image');
  return {
    previewWidth: preview.clientWidth || 390,
    previewHeight: preview.clientHeight || 300,
    scrollLeft: preview.scrollLeft || 0,
    scrollTop: preview.scrollTop || 0,
    imageWidth: parseFloat(image.style.width) || image.clientWidth || image.naturalWidth || 0,
    imageHeight: parseFloat(image.style.height) || image.clientHeight || image.naturalHeight || 0,
  };
}
function mappingLayout() {
  const monitor = selectedMonitor();
  if (!monitor) return null;
  return { ...previewLayout(), monitorWidth: monitor.width, monitorHeight: monitor.height, region: viewRegion };
}
function currentViewRegion() {
  const monitor = selectedMonitor();
  if (!monitor) return null;
  const layout = mappingLayout();
  if (viewRegion && screenZoom <= 1) return viewRegion;
  if (screenZoom <= 1 && !viewRegion) return null;
  const visible = visibleMonitorRegion(layout);
  if (!visible || isFullMonitorRegion(visible, monitor.width, monitor.height)) return null;
  return visible;
}
function applyLiveRegion(region) {
  if (!liveSession || screenMode === 'snapshot') return;
  const next = region && region.w > 0 ? region : null;
  if (regionsClose(liveSession.region || null, next)) return;
  liveSession.region = next;
  liveSession.refreshing = true;
  liveSession.controller?.abort();
}
function syncLiveRegion() {
  clearTimeout(liveRegionTimer); liveRegionTimer = 0;
  applyLiveRegion(currentViewRegion());
}
function scheduleLiveRegion() {
  clearTimeout(liveRegionTimer);
  liveRegionTimer = setTimeout(() => { liveRegionTimer = 0; syncLiveRegion(); }, 120);
}
function sendMonitorClick(pixel, button) {
  const monitor = selectedMonitor();
  if (!pixel || !monitor || !connected || !state?.capabilities?.mouse) return false;
  return action('mouse.clickAt', { monitor: monitor.name, x: pixel.x, y: pixel.y, button });
}
function updatePreviewAria() {
  $('#screen-preview').setAttribute('aria-label', controlMode === 'touch'
    ? t('Tela do PC. Toque para clicar, toque longo para botão direito, arraste para mover e pinça para ampliar.')
    : t('Tela do PC. Pinça amplia em resolução real. Arraste para mover o recorte.'));
}
function reconcileLive() { if (liveWanted && !liveSession && screenIsVisible() && connected && state?.capabilities?.live && $('#monitor-select').value) startLive(); }
function sessionIsCurrent(session) { return liveSession === session && screenIsVisible(); }
function updateScreenButtons() {
  const canCapture = connected && !!state?.capabilities?.screenshot && !!$('#monitor-select').value;
  const canStream = connected && !!state?.capabilities?.live && !!$('#monitor-select').value;
  $('#live-toggle').disabled = !liveSession && !canStream;
  $('#live-toggle').innerHTML = liveSession ? `${icon('pause')}<span>${h("Pausar ao vivo")}</span>` : `${icon('play')}<span>${h("Iniciar ao vivo")}</span>`;
  $('#capture-button').disabled = !canCapture || busyControls.has('capture-button');
  $('#stage-capture-button').disabled = $('#capture-button').disabled;
  $('#fullscreen-button').disabled = !screenshotURL;
  $('#zoom-button').disabled = !screenshotURL;
  $('#zoom-out-button').disabled = !screenshotURL || (screenZoom <= 1 && !viewRegion);
  $('#stage-live-toggle').hidden = !liveSession && !screenshotURL;
  $('#stage-live-toggle').disabled = !liveSession && !canStream;
  $('#stage-live-toggle').setAttribute('aria-label',liveSession ? t("Pausar transmissão") : t("Retomar transmissão ao vivo"));
  $('#stage-live-toggle').innerHTML = icon(liveSession ? 'pause' : 'play');
}
function setScreenStatus(mode,message = '') {
  screenMode = mode; screenStatusMessage = message;
  const labels = {idle:t("PRONTO"),connecting:t("CONECTANDO"),live:t("AO VIVO"),reconnecting:t("RECONECTANDO"),paused:t("PAUSADO"),snapshot:t("FOTO")};
  $('#live-badge').textContent = labels[mode] || t("PAUSADO");
  $('#live-badge').classList.toggle('live',mode === 'live');
  $('#live-dot').classList.toggle('active',mode === 'live');
  $('#live-overlay').hidden = !['connecting','reconnecting'].includes(mode);
  $('#live-overlay-text').textContent = mode === 'reconnecting' ? t("Reconectando ao monitor…") : t("Conectando ao monitor…");
  if (mode === 'live') $('#capture-time').textContent = t('Quadro às {time}',{time:new Date(lastScreenTimestamp).toLocaleTimeString(i18n.locale)});
  else if (mode === 'snapshot') $('#capture-time').textContent = t('Foto às {time} · imagem parada',{time:new Date(lastScreenTimestamp).toLocaleTimeString(i18n.locale)});
  else if (mode === 'paused') $('#capture-time').textContent = screenshotURL ? t("Último quadro · imagem parada") : t("Transmissão pausada");
  else if (mode === 'reconnecting') $('#capture-time').textContent = t("Sem novos quadros");
  else if (mode === 'connecting') $('#capture-time').textContent = t("Aguardando primeiro quadro");
  else $('#capture-time').textContent = t("Pronto para iniciar");
  i18n.write($('#live-note'),message || (mode === 'live' ? t('Ao vivo · {profile}. O ritmo depende da conexão e do monitor.',{profile:t(liveSession?.profileLabel || 'Equilibrado')}) : mode === 'paused' ? t("Transmissão pausada. Toque em iniciar para acompanhar novamente.") : mode === 'snapshot' ? t("Esta é uma foto. Inicie ao vivo para ver as mudanças do monitor.") : t("Veja as mudanças do monitor enquanto esta tela estiver aberta.")));
  $('#live-note').classList.toggle('error',mode === 'reconnecting');
  updateScreenButtons();
}
function applyScreenZoom() {
  const stage = $('#screen-stage'), preview = $('#screen-preview'), image = $('#screen-image');
  screenZoomed = screenZoom > 1 || !!viewRegion;
  stage.classList.toggle('zoomed',screenZoom > 1);
  const ratio = (image.naturalWidth || 16) / (image.naturalHeight || 9);
  const fitWidth = Math.min(preview.clientWidth || 390,(preview.clientHeight || 300)*ratio);
  image.style.width = `${Math.round(fitWidth*screenZoom)}px`;
  image.style.height = `${Math.round(fitWidth/ratio*screenZoom)}px`;
  $('#zoom-button').setAttribute('aria-pressed',String(screenZoomed));
  $('#zoom-button').setAttribute('aria-label',screenZoomed ? t("Ajustar imagem inteira à tela") : t("Ampliar imagem para ler"));
  $('#zoom-out-button').disabled = !screenshotURL || (screenZoom <= 1 && !viewRegion);
  if (screenZoom <= 1) { preview.scrollLeft = 0; preview.scrollTop = 0; }
}
function setScreenZoom(value, point) {
  const preview = $('#screen-preview');
  const previous = screenZoom;
  const image = $('#screen-image');
  const ratio = (image.naturalWidth || 16)/(image.naturalHeight || 9);
  const fitWidth = Math.min(preview.clientWidth || 390,(preview.clientHeight || 300)*ratio);
  screenZoom = Math.max(1,Math.min(Math.max(4,(image.naturalWidth || fitWidth)/fitWidth),value));
  const x = point?.x ?? preview.clientWidth/2, y = point?.y ?? preview.clientHeight/2;
  const left = preview.scrollLeft || 0, top = preview.scrollTop || 0;
  applyScreenZoom();
  if (screenZoom > 1) { preview.scrollLeft = (left+x)*screenZoom/previous-x; preview.scrollTop = (top+y)*screenZoom/previous-y; }
  if (liveSession && screenMode !== 'snapshot') scheduleLiveRegion();
}
function showScreenImage(url,timestamp,monitor) {
  const oldURL = screenshotURL;
  screenshotURL = url; lastScreenTimestamp = timestamp;
  $('#screen-image').src = url;
  $('#screen-image').alt = t('Monitor {monitor}',{monitor});
  $('#screen-image').hidden = false; $('#screen-empty').hidden = true;
  $('#viewer-monitor-name').textContent = monitor;
  if (oldURL) URL.revokeObjectURL(oldURL);
  applyScreenZoom(); updateScreenButtons();
}
function clearScreenImage() {
  if (screenshotURL) URL.revokeObjectURL(screenshotURL);
  screenshotURL = null; lastScreenTimestamp = null; screenZoomed = false; screenZoom = 1; viewRegion = null;
  $('#screen-image').removeAttribute('src'); $('#screen-image').hidden = true; $('#screen-empty').hidden = false;
  applyScreenZoom(); updateScreenButtons();
}
function stopLive(message = '') {
  const session = liveSession;
  liveSession = null;
  if (session) {
    session.receiving = false; session.pendingFrame = null;
    session.controller?.abort();
    clearInterval(session.watchdog); clearTimeout(session.retryTimer);
    session.cancelRetry?.();
  }
  if (session || ['connecting','live','reconnecting'].includes(screenMode)) setScreenStatus(screenshotURL ? 'paused' : 'idle',message);
}
function cancelSnapshot() {
  const request = snapshotRequest; snapshotRequest = null;
  request?.controller.abort();
  clearTimeout(request?.timer);
  busyControls.delete('capture-button'); $('#screen-preview').classList.remove('loading');
  updateScreenButtons();
}
function exitScreenFullscreen() {
  $('#screen-stage').classList.remove('expanded','controls-hidden');
  if (document.fullscreenElement === $('#screen-stage')) document.exitFullscreen?.().catch(() => {});
  $('#fullscreen-button').setAttribute('aria-label',t("Abrir tela cheia"));
  $('#fullscreen-button').innerHTML = icon('expand');
}
function leaveScreen() { resetRemoteInput(); stopLive(); cancelSnapshot(); exitScreenFullscreen(); }
async function screenResponse(path,controller) {
  const requestToken = token;
  let response;
  try { response = await fetch(`/api${path}`,{headers:{'Accept-Language':i18n.locale,Authorization:`Bearer ${requestToken}`},signal:controller.signal,cache:'no-store'}); }
  catch (error) { if (error instanceof TypeError) throw new Error(t('Sem resposta do PC. Confira o Tailscale e a conexão.')); throw error; }
  if (!response.ok) {
    let message = t("Não foi possível abrir o monitor.");
    let details;
    try { details = await response.json(); message = details.error || message; } catch {}
    if (response.status === 401 && token === requestToken) {
      stopLive(); token = ''; connected = false;
      try { localStorage.removeItem(storageKey); } catch {}
      showPairing(t("A chave não foi aceita. Cole a chave atual do PC para reconectar."));
    }
    throw Object.assign(new Error(message),{status:response.status,errorCode:details?.errorCode,errorParameters:details?.errorParameters});
  }
  return response;
}
async function renderLiveFrames(session,attempt) {
  if (session.rendering) return;
  session.rendering = true;
  try {
    while (session.pendingFrame && sessionIsCurrent(session) && session.attempt === attempt && session.receiving) {
      const frame = session.pendingFrame; session.pendingFrame = null;
      const url = URL.createObjectURL(new Blob([frame.bytes],{type:'image/jpeg'}));
      const decoded = new Image(); decoded.src = url;
      try { await decoded.decode(); }
      catch { URL.revokeObjectURL(url); throw new Error(t("Não foi possível decodificar a imagem do monitor.")); }
      if (!sessionIsCurrent(session) || session.attempt !== attempt || !session.receiving) { URL.revokeObjectURL(url); return; }
      showScreenImage(url,frame.timestamp,session.monitor);
      session.hasFrame = true; session.failures = 0;
      setScreenStatus('live');
    }
  } catch(error) {
    if (sessionIsCurrent(session) && session.attempt === attempt) { session.error = error; session.controller?.abort(); }
  } finally { session.rendering = false; }
}
async function runLiveSession(session) {
  while (sessionIsCurrent(session)) {
    session.attempt += 1;
    const attempt = session.attempt;
    const refreshing = session.refreshing;
    session.refreshing = false;
    session.controller = new AbortController(); session.error = null; session.receiving = false;
    session.pendingFrame = null; session.lastReceived = Date.now();
    if (!refreshing || !session.hasFrame) setScreenStatus(session.attempt > 1 ? 'reconnecting' : 'connecting');
    session.watchdog = setInterval(() => {
      if (sessionIsCurrent(session) && Date.now()-session.lastReceived > 2500 && screenMode === 'live') setScreenStatus('reconnecting',t("Aguardando novos quadros do monitor…"));
      if (sessionIsCurrent(session) && Date.now()-session.lastReceived > 10000) { session.error = new Error(t("O monitor ficou sem enviar imagens.")); session.controller.abort(); }
    },1000);
    try {
      const response = await screenResponse(liveStreamPath(session),session.controller);
      if (!sessionIsCurrent(session)) return;
      const contentType = response.headers.get('content-type') || '';
      if (!/^multipart\/x-mixed-replace\b/i.test(contentType)) throw Object.assign(new Error(t("O PC não ofereceu uma transmissão compatível.")),{status:415});
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
      if (!boundary || !response.body) throw new Error(t("Resposta de transmissão incompleta."));
      session.receiving = true;
      const parser = new MjpegParser((bytes,timestamp) => {
        if (!sessionIsCurrent(session) || session.attempt !== attempt) return;
        session.lastReceived = Date.now(); session.pendingFrame = {bytes,timestamp};
        renderLiveFrames(session,attempt);
      },boundary[1] || boundary[2]);
      const reader = response.body.getReader();
      try {
        while (sessionIsCurrent(session)) {
          const {done,value} = await reader.read();
          if (done) break;
          parser.push(value);
        }
      } finally { session.receiving = false; reader.cancel().catch(() => {}); }
      if (sessionIsCurrent(session)) throw new Error(t("A transmissão foi interrompida."));
    } catch(error) {
      if (!sessionIsCurrent(session)) return;
      session.receiving = false; session.pendingFrame = null;
      if (session.refreshing || refreshing) { session.refreshing = false; session.failures = 0; continue; }
      if ([400,401,403,404,415].includes(error.status)) { liveWanted = false; stopLive(error); toast(error,true); return; }
      session.failures += 1;
      if (session.failures >= 5) { liveWanted = false; stopLive(t('Não chegaram novos quadros. Toque em iniciar para tentar novamente.')); return; }
      const delay = Math.min(5000,1000*2**Math.min(session.failures-1,3));
      session.retryDelay = delay;
      setScreenStatus('reconnecting',t('{message} Tentando novamente em {seconds}s.',{message:t(session.error?.message || 'Conexão interrompida.'),seconds:delay/1000}));
      await new Promise(resolve => { session.cancelRetry = resolve; session.retryTimer = setTimeout(resolve,delay); });
      session.cancelRetry = null;
    } finally { clearInterval(session.watchdog); }
  }
}
function startLive() {
  if (!screenIsVisible() || !connected || !state?.capabilities?.live) { toast(t("Transmissão indisponível. Confira a conexão com o PC."),true); return; }
  const monitor = $('#monitor-select').value;
  if (!monitor) return;
  stopLive(); cancelSnapshot();
  const sharp = $('#live-quality').value === 'sharp';
  const session = {monitor,fps:sharp ? 6 : 10,scale:sharp ? 0.65 : 0.5,profileLabel:sharp ? 'Mais nítido · até 6 quadros/s' : 'Equilibrado · até 10 quadros/s',attempt:0,failures:0,hasFrame:false,rendering:false,pendingFrame:null,region:currentViewRegion(),refreshing:false};
  liveSession = session;
  runLiveSession(session);
}
function toggleLive() { liveWanted = !liveSession; if (liveSession) stopLive(); else startLive(); }
$('#live-toggle').addEventListener('click',toggleLive);
$('#stage-live-toggle').addEventListener('click',toggleLive);
$('#monitor-select').addEventListener('change',() => {
  const restart = !!liveSession || liveWanted;
  savePreference('ponte-monitor',$('#monitor-select').value);
  viewRegion = null; screenZoom = 1;
  stopLive(); cancelSnapshot(); clearScreenImage();
  $('#viewer-monitor-name').textContent = $('#monitor-select').value || t("Monitor do PC");
  setScreenStatus('idle');
  if (restart) startLive();
});
$('#live-quality').value = savedPreference('ponte-quality','balanced') === 'sharp' ? 'sharp' : 'balanced';
$('#live-quality').addEventListener('change',() => { savePreference('ponte-quality',$('#live-quality').value); if (liveSession) startLive(); });
$('#zoom-button').addEventListener('click',() => {
  if (screenZoom > 1 || viewRegion) {
    screenZoom = 1; viewRegion = null; applyScreenZoom(); syncLiveRegion(); return;
  }
  const image = $('#screen-image'), preview = $('#screen-preview');
  const ratio = (image.naturalWidth || 16)/(image.naturalHeight || 9);
  const fitWidth = Math.min(preview.clientWidth || 390,(preview.clientHeight || 300)*ratio);
  setScreenZoom(Math.max(1,(image.naturalWidth || fitWidth)/fitWidth));
});
$('#zoom-out-button').addEventListener('click',() => {
  if (viewRegion && screenZoom <= 1) {
    const monitor = selectedMonitor();
    if (monitor) { viewRegion = scaleMonitorRegion(viewRegion, 1.5, null, monitor.width, monitor.height); applyScreenZoom(); syncLiveRegion(); }
    return;
  }
  setScreenZoom(screenZoom/1.5);
});
$('#screen-image').addEventListener('load',() => {
  const image = $('#screen-image');
  const size = `${image.naturalWidth}x${image.naturalHeight}`;
  if (size !== screenSourceSize) { screenZoom = 1; screenSourceSize = size; }
  applyScreenZoom();
  if (readAtOriginal) { readAtOriginal = false; const preview = $('#screen-preview'); const fit = Math.min(preview.clientWidth,preview.clientHeight*image.naturalWidth/image.naturalHeight); setScreenZoom(image.naturalWidth/fit,{x:0,y:0}); }
});
$('#fullscreen-button').addEventListener('click',async () => {
  const stage = $('#screen-stage');
  if (document.fullscreenElement === stage || stage.classList.contains('expanded')) { exitScreenFullscreen(); return; }
  try { if (!stage.requestFullscreen) throw new Error('unsupported'); await stage.requestFullscreen(); }
  catch { stage.classList.add('expanded'); }
  $('#fullscreen-button').setAttribute('aria-label',t("Sair da tela cheia"));
  $('#fullscreen-button').innerHTML = icon('close');
  applyScreenZoom();
});
$('#hide-screen-controls').addEventListener('click',() => { selectControlMode('view'); $('#screen-stage').classList.add('controls-hidden'); applyScreenZoom(); });
$('#show-screen-controls').addEventListener('click',() => { $('#screen-stage').classList.remove('controls-hidden'); applyScreenZoom(); });
window.addEventListener('resize',applyScreenZoom);
if (window.ResizeObserver) new window.ResizeObserver(applyScreenZoom).observe($('#screen-preview'));
window.addEventListener('keydown',event => { if (event.key === 'Escape') exitScreenFullscreen(); });
document.addEventListener('fullscreenchange',() => {
  if (!document.fullscreenElement) { $('#screen-stage').classList.remove('controls-hidden'); $('#fullscreen-button').setAttribute('aria-label',t("Abrir tela cheia")); $('#fullscreen-button').innerHTML = icon('expand'); }
  applyScreenZoom();
});
$('#capture-button').addEventListener('click',async () => {
  if (busyControls.has('capture-button') || !screenIsVisible()) return;
  const monitor = $('#monitor-select').value;
  if (!monitor) { toast(t("Nenhum monitor disponível."),true); return; }
  liveWanted = false; stopLive();
  const request = {controller:new AbortController(),timer:null}; snapshotRequest = request;
  request.timer = setTimeout(() => request.controller.abort(),15000);
  busyControls.add('capture-button'); updateScreenButtons();
  $('#screen-preview').classList.add('loading');
  try {
    const response = await screenResponse(`/screenshot?monitor=${encodeURIComponent(monitor)}&scale=1`,request.controller);
    const blob = await response.blob();
    if (snapshotRequest !== request || !screenIsVisible()) return;
    readAtOriginal = true; viewRegion = null;
    showScreenImage(URL.createObjectURL(blob),Date.now(),monitor);
    setScreenStatus('snapshot');
  } catch(error) {
    if (snapshotRequest === request) toast(error.name === 'AbortError' ? t("A foto demorou para chegar. Tente novamente.") : error,true);
  } finally { if (snapshotRequest === request) cancelSnapshot(); }
});

$('#stage-capture-button').addEventListener('click',() => $('#capture-button').click());

const screenPointers = new Map();
const screenPreview = $('#screen-preview');
let pinchDistance = 0;
let screenGesture = { pinch: false, panned: false };
const pointerDistance = () => { const [a,b] = [...screenPointers.values()]; return a && b ? Math.hypot(a.x-b.x,a.y-b.y) : 0; };
function imageLocalPoint(clientX, clientY) {
  const image = $('#screen-image');
  const rect = image.getBoundingClientRect?.() || { left: 0, top: 0 };
  return { x: clientX - rect.left, y: clientY - rect.top };
}
function translateViewRegion(dxImage, dyImage) {
  const monitor = selectedMonitor();
  if (!monitor || !viewRegion) return;
  const layout = previewLayout();
  const width = layout.imageWidth || 1, height = layout.imageHeight || 1;
  const next = {
    x: Math.max(0, Math.min(monitor.width - viewRegion.w, Math.round(viewRegion.x - dxImage / width * viewRegion.w))),
    y: Math.max(0, Math.min(monitor.height - viewRegion.h, Math.round(viewRegion.y - dyImage / height * viewRegion.h))),
    w: viewRegion.w, h: viewRegion.h,
  };
  viewRegion = next;
  scheduleLiveRegion();
}
screenPreview.addEventListener('pointerdown',event => {
  if (!screenshotURL) return;
  screenPreview.setPointerCapture?.(event.pointerId);
  screenPointers.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,started:Date.now(),moved:false});
  pinchDistance = pointerDistance();
  if (screenPointers.size === 1) screenGesture = { pinch: false, panned: false };
  if (screenPointers.size >= 2) screenGesture.pinch = true;
});
screenPreview.addEventListener('pointermove',event => {
  const before = screenPointers.get(event.pointerId);
  if (!before) return;
  const dx = event.clientX-before.x, dy = event.clientY-before.y;
  if (Math.hypot(event.clientX-before.startX,event.clientY-before.startY) > SCREEN_PAN_SLOP) before.moved = true;
  screenPointers.set(event.pointerId,{...before,x:event.clientX,y:event.clientY});
  if (screenPointers.size === 2) {
    screenGesture.pinch = true;
    const distance = pointerDistance();
    const [a,b] = [...screenPointers.values()], rect = screenPreview.getBoundingClientRect?.() || {left:0,top:0};
    const factor = pinchDistance > 0 ? distance/pinchDistance : 1;
    pinchDistance = distance;
    const monitor = selectedMonitor();
    if (viewRegion && screenZoom <= 1 && factor < 1 && monitor && screenMode !== 'snapshot') {
      const local = imageLocalPoint((a.x+b.x)/2,(a.y+b.y)/2);
      const origin = mapTouchToMonitorPixel(local.x, local.y, mappingLayout());
      viewRegion = scaleMonitorRegion(viewRegion, 1/factor, origin, monitor.width, monitor.height);
      applyScreenZoom();
      scheduleLiveRegion();
    } else if (pinchDistance >= 0) {
      setScreenZoom(screenZoom*factor,{x:(a.x+b.x)/2-rect.left,y:(a.y+b.y)/2-rect.top});
    }
  } else if (screenZoom > 1) {
    screenGesture.panned = screenGesture.panned || before.moved;
    screenPreview.scrollLeft -= dx;
    screenPreview.scrollTop -= dy;
  } else if (viewRegion && screenPointers.size === 1 && before.moved && screenMode !== 'snapshot') {
    screenGesture.panned = true;
    translateViewRegion(dx, dy);
  }
  event.preventDefault?.();
});
function finishScreenPointer(event) {
  const pointer = screenPointers.get(event.pointerId);
  screenPointers.delete(event.pointerId);
  pinchDistance = pointerDistance();
  if (screenPointers.size > 0 || !pointer) return;
  const visible = currentViewRegion();
  if (visible) viewRegion = visible;
  else if (screenZoom <= 1) viewRegion = null;
  syncLiveRegion();
  const gesture = classifyScreenGesture({
    pointerCount: screenGesture.pinch ? 2 : 1,
    moved: pointer.moved || screenGesture.panned || screenGesture.pinch,
    durationMs: Date.now() - pointer.started,
  });
  if (controlMode === 'touch' && (gesture === 'tap' || gesture === 'longpress')) {
    const layout = mappingLayout();
    const local = imageLocalPoint(pointer.startX, pointer.startY);
    sendMonitorClick(layout ? mapTouchToMonitorPixel(local.x, local.y, layout) : null, gesture === 'longpress' ? 'right' : 'left');
  }
}
for (const name of ['pointerup','pointercancel','lostpointercapture']) screenPreview.addEventListener(name,finishScreenPointer);
screenPreview.addEventListener('keydown',event => {
  if (event.key === '+' || event.key === '=') setScreenZoom(screenZoom*1.5);
  else if (event.key === '-') setScreenZoom(screenZoom/1.5);
  else if (event.key === '0') setScreenZoom(1);
  else return;
  event.preventDefault();
});

// These sessions use Ponte's tmux socket. They never inject desktop input.
let terminalId = '';
let terminalSessions = [];
let terminalAvailable = false;
let terminalBusy = false;
let terminalPaused = false;
let terminalTimer;
let terminalGeneration = 0;
let terminalText = null;
let terminalClosingId = '';
const terminalDrafts = new Map();
function terminalVisible() { return currentPage === 'terminais' && !!token && !document.hidden && !nativePaused; }
function terminalControls() {
  const ready = connected && terminalAvailable && !!terminalId && !terminalBusy;
  $('#terminal-new').disabled = !connected || !terminalAvailable || terminalBusy || terminalSessions.length >= 4;
  $('#terminal-session').hidden = !terminalId;
  $('#terminal-select').disabled = terminalBusy || !terminalSessions.length;
  $('#terminal-pause').disabled = !terminalId;
  $('#terminal-pause').setAttribute('aria-pressed',String(terminalPaused));
  $('#terminal-pause').textContent = terminalPaused ? t('Retomar leitura') : t('Pausar leitura');
  $$('#terminal-send,#terminal-input,#terminal-close,#terminal-size,[data-terminal-key]').forEach(element => { element.disabled = !ready; });
}
function renderDesktopTerminals() {
  const windows = (state?.windows || []).filter(w => appIcon(w.class) === 'terminal');
  $('#desktop-terminals').innerHTML = windows.length ? windows.map(w => `<button class="terminal-window" data-preview-window="${escaped(w.address)}">${icon('terminal')}<span><strong>${escaped(w.title || w.class)}</strong><small>${escaped(t('Focar e ver no monitor'))}</small></span>${icon('arrow')}</button>`).join('') : `<p class="hint">${h('Nenhuma janela de terminal aberta.')}</p>`;
}
function terminalSessionOptions() {
  const select = $('#terminal-select');
  const signature = JSON.stringify([terminalSessions,i18n.language]);
  if (select.dataset.signature !== signature) {
    select.innerHTML = terminalSessions.length ? terminalSessions.map(session => `<option value="${escaped(session.id)}">${escaped(session.title || t('Terminal'))} · ${escaped(session.id.slice(-6))}</option>`).join('') : `<option value="">${h('Escolha ou crie uma sessão')}</option>`;
    select.setAttribute('data-signature',signature);
  }
  select.value = terminalId;
  terminalControls();
}
function selectTerminal(id) {
  if (terminalId) terminalDrafts.set(terminalId,$('#terminal-input').value);
  terminalId = id; terminalText = null;
  $('#terminal-output').textContent = '';
  $('#terminal-input').value = terminalDrafts.get(id) || '';
  savePreference('ponte-terminal',id);
  const session = terminalSessions.find(item => item.id === id);
  $('#terminal-size').value = String(session?.cols || 40);
  terminalSessionOptions();
}
async function readTerminals(generation) {
  if (!terminalVisible() || generation !== terminalGeneration) return;
  const requestToken = token;
  try {
    const response = await api('/terminals',{timeout:8000});
    const listing = await response.json();
    if (generation !== terminalGeneration || requestToken !== token || !terminalVisible()) return;
    terminalAvailable = listing.available === true;
    terminalSessions = listing.sessions || [];
    if (!terminalSessions.some(item => item.id === terminalId)) selectTerminal(terminalSessions.find(item => item.id === savedPreference('ponte-terminal'))?.id || terminalSessions[0]?.id || '');
    terminalSessionOptions();
    const active = terminalSessions.find(session => session.id === terminalId);
    $('#terminal-attach').value = active?.attachCommand || '';
    $('#terminal-mode').hidden = !active?.inMode;
    $('#terminal-status').textContent = terminalAvailable ? terminalId ? t('Conectado à sessão de texto.') : t('Crie uma sessão para começar. Digitar e executar são ações separadas.') : t('Instale tmux no PC para usar sessões de texto.');
    if (terminalId && !terminalPaused) {
      const requestedId = terminalId;
      const view = await (await api(`/terminals/${encodeURIComponent(requestedId)}`,{timeout:8000})).json();
      if (generation !== terminalGeneration || requestedId !== terminalId || requestToken !== token || !terminalVisible()) return;
      const output = $('#terminal-output');
      const followsTail = output.scrollHeight-output.scrollTop-output.clientHeight < 48;
      const text = view.text.replace(/\n+$/,'');
      if (terminalText !== text) {
        terminalText = text;
        output.textContent = text;
        if (followsTail) output.scrollTop = output.scrollHeight;
      }
    }
  } catch (error) {
    if (generation === terminalGeneration && requestToken === token && terminalVisible()) i18n.write($('#terminal-status'),error);
  } finally {
    if (generation === terminalGeneration && terminalVisible()) terminalTimer = setTimeout(() => readTerminals(generation),terminalPaused ? 2000 : 800);
  }
}
function updateTerminalNavigation() {
  clearTimeout(terminalTimer);
  const generation = ++terminalGeneration;
  terminalControls();
  if (terminalVisible()) { renderDesktopTerminals(); readTerminals(generation); }
}
async function terminalMutation(path,body,method = 'POST') {
  if (terminalBusy || !connected || !token) return null;
  terminalBusy = true; terminalControls();
  const requestToken = token;
  try {
    const result = await (await api(path,{method,headers:{'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})})).json();
    return token === requestToken ? result : null;
  } catch(error) { if (token === requestToken) toast(error,true); return null; }
  finally { terminalBusy = false; terminalControls(); }
}
$('#terminal-new').addEventListener('click',async () => {
  const session = await terminalMutation('/terminals',{cols:40,rows:24});
  if (session) { terminalSessions.push(session); selectTerminal(session.id); terminalPaused = false; updateTerminalNavigation(); }
});
$('#terminal-select').addEventListener('change',event => { selectTerminal(event.target.value); terminalPaused = false; updateTerminalNavigation(); });
$('#terminal-pause').addEventListener('click',() => { terminalPaused = !terminalPaused; updateTerminalNavigation(); });
$('#terminal-input-form').addEventListener('submit',async event => {
  event.preventDefault();
  const id = terminalId, text = $('#terminal-input').value;
  if (!id || !text || terminalBusy) return;
  const result = await terminalMutation(`/terminals/${encodeURIComponent(id)}/input`,{text});
  if (result) {
    terminalDrafts.delete(id);
    if (terminalId === id && $('#terminal-input').value === text) $('#terminal-input').value = '';
    updateTerminalNavigation();
  }
});
$('#terminal-size').addEventListener('change',async event => {
  const id = terminalId;
  if (!id) return;
  await terminalMutation(`/terminals/${encodeURIComponent(id)}/resize`,{cols:Number(event.target.value),rows:24});
  updateTerminalNavigation();
});
$('#terminal-close').addEventListener('click',() => {
  if (!terminalId || terminalBusy) return;
  terminalClosingId = terminalId;
  $('#terminal-close-dialog').showModal();
});
$('#terminal-close-cancel').addEventListener('click',() => $('#terminal-close-dialog').close());
$('#terminal-close-confirm').addEventListener('click',async () => {
  const id = terminalClosingId; terminalClosingId = '';
  $('#terminal-close-dialog').close();
  if (!id) return;
  if (await terminalMutation(`/terminals/${encodeURIComponent(id)}`,undefined,'DELETE')) { terminalDrafts.delete(id); selectTerminal(''); updateTerminalNavigation(); }
});
document.addEventListener('click',async event => {
  const key = event.target.closest('[data-terminal-key]');
  if (key && terminalId) { await terminalMutation(`/terminals/${encodeURIComponent(terminalId)}/input`,{key:key.dataset.terminalKey}); updateTerminalNavigation(); }
  const preview = event.target.closest('[data-preview-window]');
  if (preview) {
    const target = (state?.windows || []).find(w => w.address === preview.dataset.previewWindow);
    if (target && await action('window.focus',{address:target.address})) {
      const monitor = (state.monitors || []).find(m => m.id === target.monitor);
      if (monitor) { $('#monitor-select').value = monitor.name; savePreference('ponte-monitor',monitor.name); }
      navigate('tela');
    }
  }
});
document.addEventListener('visibilitychange',updateTerminalNavigation);
window.addEventListener('pagehide',() => { clearTimeout(terminalTimer); terminalGeneration++; });
window.addEventListener('ponte-native-resume',() => { nativePaused = false; updateTerminalNavigation(); pollState(); });

// Pointer deltas are coalesced; only one movement request is in flight.
const touchpad = $('#touchpad');
const pointers = new Map();
let gestureStart = 0;
let gestureDistance = 0;
let gestureMaxPointers = 0;
let moveQueue = {dx:0,dy:0,scroll:0};
let moving = false;
let movementTimer = null;
let dragging = false;
let dragTimer = null;

function resetRemoteInput() {
  remoteInputGeneration++;
  const ids = [...pointers.keys()];
  pointers.clear();
  for (const id of ids) { if (touchpad.hasPointerCapture?.(id)) touchpad.releasePointerCapture(id); }
  touchpad.classList.remove('touched');
  clearInterval(movementTimer); movementTimer = null;
  moveQueue = {dx:0,dy:0,scroll:0};
  stopDrag();
}

async function flushMovement() {
  if (moving || !connected || !state?.capabilities?.mouse) return;
  const dx = Math.max(-1000,Math.min(1000,Math.round(moveQueue.dx)));
  const dy = Math.max(-1000,Math.min(1000,Math.round(moveQueue.dy)));
  const scroll = Math.max(-30,Math.min(30,Math.round(moveQueue.scroll)));
  if (!dx && !dy && !scroll) return;
  if (scroll) moveQueue.scroll -= scroll;
  else { moveQueue.dx -= dx; moveQueue.dy -= dy; }
  moving = true;
  try {
    if (scroll) await api('/action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'mouse.scroll',dy:Math.round(scroll)})});
    else await api('/action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'mouse.move',dx:Math.round(dx),dy:Math.round(dy)})});
  } catch (error) { moveQueue = {dx:0,dy:0,scroll:0}; toast(error,true); }
  finally {
    moving = false;
    if (!pointers.size && (Math.round(moveQueue.dx) || Math.round(moveQueue.dy) || Math.round(moveQueue.scroll))) setTimeout(flushMovement,0);
  }
}

touchpad.addEventListener('pointerdown', event => {
  if (!connected || !state?.capabilities?.mouse || event.button > 0) return;
  event.preventDefault();
  touchpad.setPointerCapture(event.pointerId);
  if (!pointers.size) { gestureStart = performance.now(); gestureDistance = 0; gestureMaxPointers = 0; }
  pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  gestureMaxPointers = Math.max(gestureMaxPointers,pointers.size);
  touchpad.classList.add('touched');
  if (!movementTimer) movementTimer = setInterval(flushMovement,35);
});
touchpad.addEventListener('pointermove', event => {
  const last = pointers.get(event.pointerId);
  if (!last) return;
  event.preventDefault();
  const dx = event.clientX-last.x;
  const dy = event.clientY-last.y;
  gestureDistance += Math.abs(dx)+Math.abs(dy);
  pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
  if (pointers.size >= 2) moveQueue.scroll += -dy / 7;
  else if (gestureMaxPointers < 2) { const scale = 1.7; moveQueue.dx += dx*scale; moveQueue.dy += dy*scale; }
});
function releasePointer(event, cancelled = false) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (!pointers.size) {
    touchpad.classList.remove('touched');
    clearInterval(movementTimer); movementTimer = null;
    flushMovement();
    if (!cancelled && gestureDistance < 11 && performance.now()-gestureStart < 380 && !dragging) action('mouse.click',{button:gestureMaxPointers >= 2 ? 'right' : 'left'});
    if (cancelled) stopDrag();
  }
}
touchpad.addEventListener('pointerup', event => releasePointer(event));
touchpad.addEventListener('pointercancel', event => releasePointer(event,true));
touchpad.addEventListener('lostpointercapture', event => releasePointer(event,true));
touchpad.addEventListener('contextmenu', event => { event.preventDefault(); });
touchpad.addEventListener('keydown', event => {
  const keys = {ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]};
  if (keys[event.key]) { event.preventDefault(); action('mouse.move',{dx:keys[event.key][0],dy:keys[event.key][1]}); }
  else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action('mouse.click',{button:event.shiftKey ? 'right' : 'left'}); }
});
$('#left-click').addEventListener('click', () => action('mouse.click',{button:'left'}));
$('#right-click').addEventListener('click', () => action('mouse.click',{button:'right'}));

function updateDragButton() { $('#drag-button').setAttribute('aria-pressed',String(dragging)); $('#drag-button').textContent = dragging ? t("Soltar") : t("Arrastar"); }
async function stopDrag() {
  if (!dragging) return;
  dragging = false; clearInterval(dragTimer); dragTimer = null; updateDragButton();
  if (connected) await action('mouse.drag',{pressed:false});
}
$('#drag-button').addEventListener('click', async () => {
  if (dragging) { stopDrag(); return; }
  const generation = remoteInputGeneration;
  if (await action('mouse.drag',{pressed:true})) {
    if (generation !== remoteInputGeneration) { action('mouse.drag',{pressed:false}); return; }
    dragging = true; updateDragButton(); toast(t("Arraste no touchpad. Toque em Soltar ao terminar."));
    dragTimer = setInterval(async () => {
      if (!connected || document.hidden) { stopDrag(); return; }
      if (!(await action('mouse.drag',{pressed:true}))) stopDrag();
    },650);
  }
});

// Recording stays local until the explicit send action. Playback is also explicit.
let recorder = null;
let microphoneStream = null;
let recordingBlob = null;
let recordingURL = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let recordingInterval;
let recordingSize = 0;
let recordStarting = false;
let microphoneGeneration = 0;
let pendingMicrophoneRequest = null;
let discardWhenStopped = false;
const audioURLs = new Map();

function recordError(message) { i18n.write($('#record-error'),message); $('#record-error').hidden = !message; }
function closeMicrophone(stream = microphoneStream) {
  stream?.getTracks().forEach(track => track.stop());
  if (microphoneStream === stream) microphoneStream = null;
}
function recordClock() {
  const elapsed = Math.floor((performance.now()-recordingStartedAt)/1000);
  $('#record-timer').textContent = `${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
}
function clearRecording() {
  recordingBlob = null;
  if (recordingURL) { URL.revokeObjectURL(recordingURL); recordingURL = null; }
  $('#record-audio').pause(); $('#record-audio').removeAttribute('src'); $('#record-audio').load();
  $('#record-preview').hidden = true;
  $('#record-button').hidden = false;
  $('#record-button').disabled = false;
  $('#record-button').classList.remove('recording');
  $('#record-button').innerHTML = `${icon('mic')}<span>${h("Começar gravação")}</span>`;
  $('#record-state').textContent = t("PRONTO");
  $('#record-hint').textContent = t("Grave, confira e envie quando quiser.");
  $('#record-timer').textContent = '00:00';
  recordError('');
}
function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    $('#record-button').disabled = true;
    $('#record-state').textContent = t('FINALIZANDO');
    recorder.stop();
  }
}
function cancelPendingRecording(message = '') {
  const request = pendingMicrophoneRequest;
  if (!request) return false;
  pendingMicrophoneRequest = null;
  microphoneGeneration += 1;
  clearTimeout(request.timer);
  request.cancel();
  recordStarting = false;
  $('#record-button').disabled = false;
  $('#record-button').innerHTML = `${icon('mic')}<span>${h("Começar gravação")}</span>`;
  $('#record-state').textContent = t("PRONTO");
  $('#record-hint').textContent = t("Grave, confira e envie quando quiser.");
  recordError(message);
  return true;
}
async function startRecording() {
  if (recordStarting || recorder?.state === 'recording') return;
  recordError('');
  if (!window.isSecureContext) { recordError(t("O microfone precisa de uma conexão HTTPS. Abra o endereço seguro do Ponte pelo Tailscale.")); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { recordError(t("Este navegador não oferece gravação de áudio. Abra o Ponte no Chrome ou em outro navegador atualizado.")); return; }
  const generation = ++microphoneGeneration;
  let requestStream = null;
  recordStarting = true;
  $('#record-button').disabled = false;
  $('#record-button').innerHTML = `${icon('close')}<span>${h("Cancelar acesso ao microfone")}</span>`;
  $('#record-state').textContent = t("PERMISSÃO");
  $('#record-hint').textContent = t("Permita o microfone. Você pode cancelar a espera.");
  try {
    const cancellation = new Promise((resolve,reject) => {
      pendingMicrophoneRequest = {
        generation,
        timer:setTimeout(() => {
          if (pendingMicrophoneRequest?.generation === generation) cancelPendingRecording(t("A permissão do microfone não chegou em 25 segundos. Libere o acesso no navegador e tente novamente."));
        },25000),
        cancel:() => reject(Object.assign(new Error(t("Pedido de microfone cancelado.")),{name:'MicrophoneRequestCancelled'}))
      };
    });
    const permission = Promise.resolve(navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})).then(stream => {
      // getUserMedia cannot dismiss the browser prompt. A late answer owns only
      // this stream, so it must never start recording or close a newer stream.
      if (generation !== microphoneGeneration) {
        closeMicrophone(stream);
        throw Object.assign(new Error(t("Pedido de microfone cancelado.")),{name:'MicrophoneRequestCancelled'});
      }
      return stream;
    });
    requestStream = await Promise.race([permission,cancellation]);
    if (generation !== microphoneGeneration) { closeMicrophone(requestStream); return; }
    clearTimeout(pendingMicrophoneRequest?.timer);
    pendingMicrophoneRequest = null;
    const formats = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4'];
    const supported = formats.find(format => MediaRecorder.isTypeSupported(format));
    if (!supported) throw new Error(t("Nenhum formato de gravação compatível neste navegador. Tente abrir no Chrome."));
    const activeRecorder = new MediaRecorder(requestStream,{mimeType:supported});
    recorder = activeRecorder;
    microphoneStream = requestStream;
    recordingChunks = []; recordingSize = 0; discardWhenStopped = false;
    activeRecorder.ondataavailable = event => {
      if (recorder !== activeRecorder || generation !== microphoneGeneration) return;
      if (event.data.size) { recordingChunks.push(event.data); recordingSize += event.data.size; }
      if (recordingSize > 23*1024*1024 && activeRecorder.state === 'recording') { stopRecording(); recordError(t("Gravação pausada perto do limite de 25 MB. Confira e envie este áudio.")); }
    };
    activeRecorder.onerror = () => {
      closeMicrophone(requestStream);
      if (recorder !== activeRecorder || generation !== microphoneGeneration) return;
      recordError(t("A gravação foi interrompida. Tente gravar novamente.")); stopRecording();
    };
    activeRecorder.onstop = () => {
      closeMicrophone(requestStream);
      if (recorder !== activeRecorder || generation !== microphoneGeneration) return;
      clearInterval(recordingInterval);
      $('#record-button').disabled = false;
      $('#recorder-art').classList.remove('recording'); $('#nav-record-dot').hidden = true;
      if (discardWhenStopped) { clearRecording(); return; }
      recordingBlob = new Blob(recordingChunks,{type:activeRecorder.mimeType || supported});
      if (!recordingBlob.size) { clearRecording(); recordError(t("Nenhum áudio foi capturado. Tente novamente.")); return; }
      if (recordingURL) URL.revokeObjectURL(recordingURL);
      recordingURL = URL.createObjectURL(recordingBlob);
      $('#record-audio').src = recordingURL;
      $('#record-preview').hidden = false; $('#record-button').hidden = true;
      $('#record-state').textContent = t("PRÉVIA");
      $('#record-hint').textContent = t("Ouça antes. O envio é sua escolha.");
    };
    activeRecorder.start(1000);
    recordingStartedAt = performance.now(); recordClock(); recordingInterval = setInterval(recordClock,250);
    $('#record-button').classList.add('recording');
    $('#record-button').innerHTML = `${icon('stop')}<span>${h("Parar gravação")}</span>`;
    $('#record-state').textContent = t("GRAVANDO");
    $('#record-hint').textContent = t("Só você está ouvindo. Pare para conferir.");
    $('#recorder-art').classList.add('recording'); $('#nav-record-dot').hidden = false;
  } catch (error) {
    if (requestStream) closeMicrophone(requestStream);
    if (generation !== microphoneGeneration) return;
    const messages = {NotAllowedError:t("Microfone não permitido. Nas permissões deste site, libere o microfone e tente novamente."),NotFoundError:t("Nenhum microfone encontrado neste dispositivo."),NotReadableError:t("O microfone está ocupado. Feche outros apps que estejam gravando e tente novamente.")};
    recordError(messages[error.name] || error.message || t("Não foi possível abrir o microfone."));
    $('#record-button').innerHTML = `${icon('mic')}<span>${h("Começar gravação")}</span>`;
    $('#record-state').textContent = t("PRONTO");
    $('#record-hint').textContent = t("Grave, confira e envie quando quiser.");
  } finally {
    if (generation === microphoneGeneration) {
      if (pendingMicrophoneRequest?.generation === generation) { clearTimeout(pendingMicrophoneRequest.timer); pendingMicrophoneRequest = null; }
      recordStarting = false;
      $('#record-button').disabled = false;
    }
  }
}
$('#record-button').addEventListener('click', () => {
  if (recordStarting) cancelPendingRecording(t("Acesso ao microfone cancelado. Você pode tentar novamente."));
  else if (recorder?.state === 'recording') stopRecording();
  else startRecording();
});
$('#record-discard').addEventListener('click', clearRecording);
$('#record-send').addEventListener('click', async () => {
  if (!recordingBlob || !connected) { recordError(t("Conecte ao PC para enviar. Sua gravação continua disponível aqui.")); return; }
  if (recordingBlob.size > 25*1024*1024) { recordError(t("O áudio excede 25 MB. Grave uma mensagem mais curta.")); return; }
  $('#record-send').disabled = true; $('#record-discard').disabled = true;
  $('#record-send').innerHTML = h('Enviando…');
  recordError('');
  try {
    await api('/audio',{method:'POST',headers:{'Content-Type':recordingBlob.type},body:recordingBlob,timeout:60000});
    clearRecording(); toast(t("Áudio salvo no PC. Escolha onde ouvir."));
    await loadAudio();
  } catch(error) { recordError(error); }
  finally { $('#record-send').disabled = false; $('#record-discard').disabled = false; $('#record-send').innerHTML = `${h('Enviar ao PC')} ${icon('send')}`; }
});

function formatBytes(bytes) { return i18n.formatBytes(bytes); }
function recordingDate(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return t("Data indisponível");
  return date.toLocaleString(i18n.locale,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
}
async function loadAudio() {
  if (!connected || audioLoading) return;
  audioLoading = true; $('#audio-refresh').disabled = true;
  if (!audioLoaded) $('#recording-list').innerHTML = `<div class="empty-state">${icon('mic')}<strong>${h("Buscando seus áudios…")}</strong></div>`;
  try {
    const response = await api('/audio');
    const data = await response.json();
    const recordings = data.recordings || [];
    audioLoaded = true;
    const signature = JSON.stringify(recordings);
    if (signature === audioSignature) return;
    audioSignature = signature;
    for (const url of audioURLs.values()) URL.revokeObjectURL(url);
    audioURLs.clear();
    $('#recording-list').innerHTML = recordings.length ? recordings.map(recording => `<article class="recording-card" data-recording="${escaped(recording.id)}"><div class="recording-title">${icon('mic')}<div><strong>${recording.name ? escaped(recording.name) : h('Mensagem de voz')}</strong><span><time data-i18n-date="${escaped(recording.createdAt)}">${escaped(recordingDate(recording.createdAt))}</time> · <span data-i18n-bytes="${Number(recording.size)}">${escaped(formatBytes(recording.size))}</span></span></div></div><div class="recording-actions"><button class="button small" data-audio-play="${escaped(recording.id)}">${icon('monitor')} ${h('Tocar no PC')}</button><button class="button small" data-audio-listen="${escaped(recording.id)}">${icon('headphones')} ${h('Ouvir aqui')}</button></div><audio controls preload="none" hidden></audio></article>`).join('') : `<div class="empty-state">${icon('mic')}<strong>${h("Sua voz ganha um lugar aqui.")}</strong><p>${h("Os áudios enviados aparecem nesta lista.")}</p></div>`;
  } catch(error) {
    if (!audioLoaded) $('#recording-list').innerHTML = `<div class="empty-state">${icon('refresh')}<strong>${h("Não foi possível carregar os áudios.")}</strong><p>${h("Toque em atualizar para tentar novamente.")}</p></div>`;
    toast(error,true);
  } finally { audioLoading = false; $('#audio-refresh').disabled = false; }
}
$('#audio-refresh').addEventListener('click', loadAudio);
$('#recording-list').addEventListener('click', async event => {
  const play = event.target.closest('[data-audio-play]');
  const listen = event.target.closest('[data-audio-listen]');
  if (play) {
    if (!connected || !state?.capabilities?.audio) { toast(t("Reprodução de áudio indisponível no PC."),true); return; }
    play.disabled = true;
    try { await api(`/audio/${encodeURIComponent(play.dataset.audioPlay)}/play`,{method:'POST'}); toast(t("Reproduzindo áudio no PC.")); }
    catch(error) { toast(error,true); }
    finally { play.disabled = false; }
  }
  if (listen) {
    const id = listen.dataset.audioListen;
    const audio = $('audio', listen.closest('.recording-card'));
    listen.disabled = true;
    try {
      if (!audioURLs.has(id)) {
        const response = await api(`/audio/${encodeURIComponent(id)}`);
        audioURLs.set(id,URL.createObjectURL(await response.blob()));
        audio.src = audioURLs.get(id);
      }
      audio.hidden = false;
      try { await audio.play(); } catch { toast(t("Toque no player para ouvir neste dispositivo.")); }
    } catch(error) { toast(error,true); }
    finally { listen.disabled = false; }
  }
});
$('#stop-pc-audio').addEventListener('click', async () => {
  try { await api('/audio/stop',{method:'POST'}); toast(t("Áudio do Ponte parado no PC.")); }
  catch(error) { toast(error,true); }
});

$('#connection-open').addEventListener('click', () => { $('#connection-dialog').showModal(); });
$('#connection-close').addEventListener('click', () => { $('#connection-dialog').close(); });
$('#connection-dialog').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) event.currentTarget.close();
});
$('#unpair-button').addEventListener('click', async () => {
  leaveScreen();
  cancelPendingRecording();
  await stopDrag();
  if (recorder?.state === 'recording') { discardWhenStopped = true; stopRecording(); }
  else clearRecording();
  $$('audio').forEach(audio => { audio.pause(); audio.removeAttribute('src'); });
  token = ''; connected = false; state = null;
  try { localStorage.removeItem(storageKey); } catch {}
  if (screenshotURL) URL.revokeObjectURL(screenshotURL);
  screenshotURL = null; $('#screen-image').removeAttribute('src'); $('#screen-image').hidden = true; $('#screen-empty').hidden = false;
  for (const url of audioURLs.values()) URL.revokeObjectURL(url);
  audioURLs.clear(); audioLoaded = false; audioSignature = ''; workspaceSignature = ''; windowSignature = ''; monitorSignature = '';
  $('#connection-dialog').close();
  history.replaceState(null,'',location.pathname+location.search);
  showPairing(); toast(t("Chave removida deste navegador."));
});
function updateInstalledState() {
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true || navigator.userAgent.includes('PonteAndroid/');
  if (installed) { $('#install-button').hidden = true; $('#install-hint').textContent = t("Ponte instalado. Abra pelo ícone da sua tela inicial."); }
  return installed;
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); if (updateInstalledState()) return; deferredInstall = event; $('#install-button').hidden = false; $('#install-hint').textContent = t("Instale para abrir o Ponte direto da tela inicial, como um app."); });
$('#install-button').addEventListener('click', async () => {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null; $('#install-button').hidden = true;
});
window.addEventListener('appinstalled', () => { deferredInstall = null; $('#install-button').hidden = true; $('#install-hint').textContent = t("Ponte instalado. Seu PC ganhou um atalho na tela inicial."); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    leaveScreen();
    stopDrag();
    pointers.clear(); touchpad.classList.remove('touched');
    clearInterval(movementTimer); movementTimer = null; moveQueue = {dx:0,dy:0,scroll:0};
  } else { pollState(); if (recorder?.state === 'recording') recordClock(); }
});
window.addEventListener('online', pollState);
window.addEventListener('offline', () => { if(token) setConnection(false,t("Este dispositivo está sem conexão.")); });
window.addEventListener('pagehide', () => { leaveScreen(); cancelPendingRecording(); stopRecording(); closeMicrophone(); clearInterval(dragTimer); });
window.addEventListener('ponte-native-pause', event => {
  nativePaused = true;
  clearTimeout(terminalTimer); terminalGeneration++;
  leaveScreen(); stopDrag();
  if (!event.detail?.awaitingMicrophonePermission) { cancelPendingRecording(); stopRecording(); closeMicrophone(); }
});
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (token) navigate(page); });

const dynamicFields = '#terminal-pause,#home-status,#pc-online,#hostname,#focus-summary,#dialog-hostname,#dialog-status,#touchpad-state,#window-count,#live-badge,#live-overlay-text,#viewer-monitor-name,#capture-time,#live-note,#record-state,#record-hint,#install-hint,#drag-button';
$$(dynamicFields).forEach(element => element.removeAttribute('data-i18n'));
$$('#mute-button,#stage-live-toggle,#zoom-button,#fullscreen-button').forEach(element => element.removeAttribute('data-i18n-aria-label'));
$('#screen-image').removeAttribute('data-i18n-alt');
document.addEventListener('ponte-language-change', () => {
  const ownedText = '#toast,#pair-error,#record-error,#record-state,#record-hint,#install-hint,#connection-banner-text,#terminal-status';
  $$(ownedText).forEach(element => { element.textContent = t(element.textContent); });
  const bannerError = i18n.read($('#connection-banner-text'));
  setConnection(connected,bannerError);
  if (state) { renderState(); updateCapabilities(); renderDesktopTerminals(); }
  else {
    $('#hostname').textContent = t('Conectando…');
    $('#dialog-hostname').textContent = t('Seu Omarchy');
    $('#focus-summary').textContent = t('Buscando a janela em foco…');
    $('#window-count').textContent = t('CARREGANDO');
    $('#viewer-monitor-name').textContent = t('Monitor do PC');
  }
  terminalSessionOptions();
  if (!token) $('#dialog-status').textContent = t('Não conectado');
  updateDragButton();
  let liveMessage = typeof screenStatusMessage === 'string' ? t(screenStatusMessage) : screenStatusMessage;
  if (screenMode === 'reconnecting' && liveSession?.retryDelay) liveMessage = t('{message} Tentando novamente em {seconds}s.',{message:t(liveSession.error?.message || 'Conexão interrompida.'),seconds:liveSession.retryDelay/1000});
  setScreenStatus(screenMode,liveMessage);
  $('#zoom-button').setAttribute('aria-label',screenZoomed ? t('Ajustar imagem inteira à tela') : t('Ampliar imagem para ler'));
  $('#fullscreen-button').setAttribute('aria-label',document.fullscreenElement || $('#screen-stage').classList.contains('expanded') ? t('Sair da tela cheia') : t('Abrir tela cheia'));
  updatePreviewAria();
  if (screenshotURL) $('#screen-image').alt = t('Monitor {monitor}',{monitor:$('#viewer-monitor-name').textContent});
  updateInstalledState();
  i18n.apply();
  pollState();
});

updateInstalledState();
if (token) { showApp(); setConnection(false,t("Conectando ao seu computador…")); navigate(location.hash.slice(1) || 'tela'); pollState(); }
else showPairing();
setInterval(pollState,4000);
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

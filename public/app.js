'use strict';
const i18n = window.PonteI18n;
const t = i18n.t;
const h = i18n.html;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escaped = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storageKey = 'ponte-pair-token';
// Kept equal to package.json. When the PC reports a different version the page
// reloads once, so a phone left open never runs stale code after an update.
const UI_VERSION = '0.1.0-alpha.7';
let token = '';
let state = null;
let connected = false;
let polling = false;
let currentPage = 'tela';
let liveWanted = true;
let nativePaused = false;
const savedPreference = (key, fallback = '') => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const savePreference = (key,value) => { try { localStorage.setItem(key,value); } catch {} };
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
  $$('[data-app],[data-action],[data-key],[data-monitor-toggle],#mute-button,#stop-pc-audio,#btn-poweroff,#btn-unlock,#btn-suspend,#btn-reboot,#terminal-dictate,#screen-dictate').forEach(button => { button.disabled = !isConnected || busyControls.has(button.id); });
  $('#volume').disabled = !isConnected;
  updateScreenButtons();
  if (isConnected && state) updateCapabilities();
  if (!isConnected) closeRemoteKeyboard();
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(0,Math.floor(seconds / 60))}m`;
}

function updateCapabilities() {
  const caps = state.capabilities || {};
  $('#stop-pc-audio').disabled = !connected || !caps.audio;
  updateScreenButtons();
  const labels = {mouse:t("Mouse"), keyboard:t("Teclado"), screenshot:t("Foto do monitor"), live:t("Tela ao vivo"), audio:t("Áudio no PC"), stt:t("Ditado por voz"), lights:t("Luzes RGB"), lock:t("Bloqueio da sessão")};
  $$('#terminal-dictate,#screen-dictate').forEach(button => { button.disabled = !connected || !caps.stt || busyControls.has(button.id); });
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
  renderPowerMonitors();
  renderLights();
  renderSession();
  const wolSection = $('#power-wol-section');
  if (wolSection) {
    if (state.wakeOnLan?.mac) {
      wolSection.hidden = false;
      $('#wol-mac-address').textContent = state.wakeOnLan.mac;
      $('#wol-interface').textContent = state.wakeOnLan.interface || '';
      $('#wol-enabled').textContent = state.wakeOnLan.enabled === true ? t("ativo na placa de rede") : state.wakeOnLan.enabled === false ? t("desativado na placa de rede") : t("estado desconhecido");
    } else {
      wolSection.hidden = true;
    }
  }
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

function renderPowerMonitors() {
  const container = $('#power-monitors');
  if (!container || !state) return;
  const monitors = state.monitors || [];
  if (!monitors.length) {
    container.innerHTML = `<p class="hint">${h("Nenhum monitor disponível.")}</p>`;
    return;
  }
  const disabledAttr = !connected ? ' disabled' : '';
  container.innerHTML = monitors.map(m => {
    const isOn = m.dpmsStatus !== false;
    const actionLabel = isOn ? t("Desligar monitor {name}",{name:m.name}) : t("Ligar monitor {name}",{name:m.name});
    const stateLabel = isOn ? t("Ligado") : t("Desligado");
    const nextState = isOn ? 'off' : 'on';
    const resolution = `${Number(m.width)}×${Number(m.height)}`;
    return `<div class="power-monitor-row"><div class="power-monitor-info"><strong class="power-monitor-name">${escaped(m.name)}</strong><span class="power-monitor-details">${escaped(resolution)}${m.description ? ` · ${escaped(m.description)}` : ''}</span></div><button type="button" class="power-monitor-toggle ${isOn ? 'on' : 'off'}" data-monitor-toggle="${escaped(m.name)}" data-next-state="${nextState}" aria-label="${escaped(actionLabel)}" aria-pressed="${isOn}"${disabledAttr}><span class="toggle-track"><span class="toggle-thumb"></span></span><span class="toggle-label">${escaped(stateLabel)}</span></button></div>`;
  }).join('');
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
    if (state.version && state.version !== UI_VERSION && typeof location.reload === 'function') {
      let guard = '';
      try { guard = sessionStorage.getItem('ponte-reloaded-for') || ''; } catch {}
      if (guard !== state.version) { try { sessionStorage.setItem('ponte-reloaded-for', state.version); } catch {} location.reload(); return; }
    }
    showApp();
    setConnection(true);
    renderState();
    if (currentPage === 'voz' && !audioLoaded) loadAudio();
    if (keyboardOpen && state.textInput?.focused === false) closeRemoteKeyboard();
    if (currentPage === 'terminais') renderDesktopTerminals();
  } catch (error) { if (token && requestToken === token) setConnection(false, error); }
  finally { polling = false; }
}

function isScreenPage(page) { return page === 'tela'; }

function setPageLocation(page) {
  currentPage = page;
  document.body.setAttribute('data-current-page',page);
  const navPage = page;
  $$('.nav-item').forEach(element => { const active = element.dataset.nav === navPage; element.classList.toggle('active', active); if (active) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
  // Each page is a history entry so the Android Back button returns to the
  // previous page instead of closing the app; the first page replaces.
  if (location.hash !== `#${page}`) {
    const url = `${location.pathname}${location.search}#${page}`;
    if (historyReady && typeof history.pushState === 'function') history.pushState(null,'',url);
    else history.replaceState(null,'',url);
  }
  historyReady = true;
}
let historyReady = false;

function navigate(page) {
  if (page === 'controle') page = 'tela';
  if (!['inicio','tela','terminais','janelas','voz'].includes(page)) return;
  const wasScreen = isScreenPage(currentPage), nextScreen = isScreenPage(page);
  if (currentPage !== page) resetRemoteInput();
  if (wasScreen && !nextScreen) leaveScreen();
  if (nextScreen && !wasScreen) liveWanted = true;
  setPageLocation(page);
  $$('.page').forEach(element => { element.hidden = element.dataset.page !== page; });
  if (!nextScreen) closeRemoteKeyboard();
  window.scrollTo({top:0,behavior:'instant'});
  if (page === 'voz' && connected) loadAudio();
  reconcileLive();
  updateTerminalNavigation();
}

function syncRemoteViewport() {
  const width = window.visualViewport?.width || window.innerWidth;
  const height = window.visualViewport?.height || window.innerHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (Math.abs(width - viewportBaseline.width) > 100) viewportBaseline = {width,height};
  else viewportBaseline.height = Math.max(viewportBaseline.height,height);
  // The phone keyboard is open when an editable field has focus and the visual
  // viewport shrank. That hides the bottom nav (which would otherwise cover the
  // composer) and lets the immersive screen size itself to the visible area.
  const active = document.activeElement;
  const editing = !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active === $('#remote-keys'));
  const keyboardOpen = editing && viewportBaseline.height - height > 100;
  document.body.setAttribute('data-keyboard-open',String(keyboardOpen));
  document.body.setAttribute('data-screen-keyboard',String(keyboardOpen && active === $('#remote-keys')));
  document.documentElement.style.setProperty('--remote-viewport-height',`${height}px`);
  document.documentElement.style.setProperty('--remote-viewport-top',`${window.visualViewport?.offsetTop || 0}px`);
  applyScreenZoom();
}
window.visualViewport?.addEventListener('resize',syncRemoteViewport);
window.visualViewport?.addEventListener('scroll',syncRemoteViewport);
window.addEventListener('resize',syncRemoteViewport);

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav]');
  if (nav) navigate(nav.dataset.nav);
  const app = event.target.closest('[data-app]');
  if (app) action('app.launch',{app:app.dataset.app}, t("Abrindo no PC…"));
  const monitorToggle = event.target.closest('[data-monitor-toggle]');
  if (monitorToggle) {
    const monitor = monitorToggle.dataset.monitorToggle;
    const nextState = monitorToggle.dataset.nextState;
    const feedback = nextState === 'on' ? t("Monitor ligado.") : t("Monitor desligado.");
    action('power.dpms', { monitor, state: nextState }, feedback);
  }
  const generic = event.target.closest('[data-action]');
  if (generic) {
    let feedback = '';
    const type = generic.dataset.action;
    const payload = {};
    if (type === 'power.sleep') feedback = t("Dormindo: monitores e luzes apagados.");
    else if (type === 'power.wake') feedback = t("PC acordado: monitores e luzes restaurados.");
    else if (type === 'power.dpms_all') { payload.state = generic.dataset.state; feedback = generic.dataset.state === 'on' ? t("Todos os monitores ligados.") : t("Todos os monitores desligados."); }
    else if (type === 'lights.preset') { payload.preset = generic.dataset.preset; feedback = t('Luzes no preset {preset}.',{preset:generic.dataset.preset}); }
    else if (type === 'lights.sleep') feedback = t("Luzes apagadas.");
    else if (type === 'lights.restore') feedback = t("Luzes restauradas.");
    else if (type === 'lights.screen') { payload.enabled = generic.dataset.enabled === 'true'; feedback = payload.enabled ? t("Telinha do cooler ligada.") : t("Telinha do cooler apagada."); }
    else if (type === 'session.lock') feedback = t("PC bloqueado.");
    runBusy(generic, () => action(type, payload, feedback));
  }
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
$('#btn-poweroff').addEventListener('click', () => { $('#poweroff-dialog').showModal(); });
$('#poweroff-cancel').addEventListener('click', () => $('#poweroff-dialog').close());
$('#poweroff-dialog-close').addEventListener('click', () => $('#poweroff-dialog').close());
$('#poweroff-confirm').addEventListener('click', async () => {
  $('#poweroff-dialog').close();
  await action('power.poweroff', {}, t("Desligando o PC…"));
});
// Live monitor transport: authenticated MJPEG. A photo is always labelled separately.
let liveSession = null;
let screenMode = 'idle';
let screenStatusMessage = '';
let lastScreenTimestamp = null;
let snapshotRequest = null;
let screenZoomed = false;
// Chrome-Remote-Desktop-style zoom: the whole native frame is streamed and the
// pinch is a continuous CSS transform on the client (no server re-crop, no
// reconnect), so it is smooth and stays sharp up to 1:1 native pixels.
let screenScale = 1;
let screenPanX = 0, screenPanY = 0;
let screenBaseW = 0, screenBaseH = 0;
let screenMaxScale = 6;
let screenSourceSize = '';
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
  if (Number.isInteger(session.quality)) path += `&q=${session.quality}`;
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

function nativePreviewRegion(previewWidth, previewHeight, monitorWidth, monitorHeight, origin) {
  const pw = Math.round(Number(previewWidth));
  const ph = Math.round(Number(previewHeight));
  if (!(pw > 0) || !(ph > 0) || !(monitorWidth > 0) || !(monitorHeight > 0)) return null;
  const previewRatio = pw / ph;
  let w = Math.min(monitorWidth, Math.max(8, pw));
  let h = Math.max(8, Math.round(w / previewRatio));
  if (h > monitorHeight) {
    h = monitorHeight;
    w = Math.min(monitorWidth, Math.max(8, Math.round(h * previewRatio)));
  }
  const ox = origin && Number.isFinite(Number(origin.x)) ? Number(origin.x) : w / 2;
  const oy = origin && Number.isFinite(Number(origin.y)) ? Number(origin.y) : h / 2;
  const x = Math.max(0, Math.min(monitorWidth - w, Math.round(ox - w / 2)));
  const y = Math.max(0, Math.min(monitorHeight - h, Math.round(oy - h / 2)));
  const next = { x: x, y: y, w: w, h: h };
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
  // The image carries a CSS transform, so its on-screen box (getBoundingClientRect)
  // already includes zoom and pan; touch mapping uses those real dimensions.
  const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
  return {
    previewWidth: preview.clientWidth || 390,
    previewHeight: preview.clientHeight || 300,
    scrollLeft: 0,
    scrollTop: 0,
    imageWidth: rect.width || screenBaseW * screenScale || image.naturalWidth || 0,
    imageHeight: rect.height || screenBaseH * screenScale || image.naturalHeight || 0,
  };
}
function mappingLayout() {
  const monitor = selectedMonitor();
  if (!monitor) return null;
  return { ...previewLayout(), monitorWidth: monitor.width, monitorHeight: monitor.height, region: null };
}
// The whole monitor is always streamed; zoom is client-side, so these are inert.
function currentViewRegion() { return null; }
function applyLiveRegion() {}
function syncLiveRegion() { clearTimeout(liveRegionTimer); liveRegionTimer = 0; }
function scheduleLiveRegion() {}
// --- client-side zoom/pan (CSS transform on the frame) ---
function screenPreviewSize() {
  const preview = $('#screen-preview');
  return { w: preview.clientWidth || 390, h: preview.clientHeight || 220 };
}
function computeScreenBase() {
  const image = $('#screen-image');
  const { w: pw, h: ph } = screenPreviewSize();
  const nw = image.naturalWidth || 16, nh = image.naturalHeight || 9;
  const ratio = nw / nh;
  let w = pw, h = pw / ratio;
  if (h > ph) { h = ph; w = ph * ratio; }
  screenBaseW = w; screenBaseH = h;
  // Allow zooming a little past native 1:1 so text stays legible; never so far
  // that it is only upscale blur.
  screenMaxScale = Math.max(2, Math.min(8, (nw / (w || 1)) * 1.3));
}
function centerScreenPan() {
  const { w: pw, h: ph } = screenPreviewSize();
  screenPanX = (pw - screenBaseW * screenScale) / 2;
  screenPanY = (ph - screenBaseH * screenScale) / 2;
}
function clampScreenPan() {
  const { w: pw, h: ph } = screenPreviewSize();
  const sw = screenBaseW * screenScale, sh = screenBaseH * screenScale;
  screenPanX = sw <= pw ? (pw - sw) / 2 : Math.min(0, Math.max(pw - sw, screenPanX));
  screenPanY = sh <= ph ? (ph - sh) / 2 : Math.min(0, Math.max(ph - sh, screenPanY));
}
function applyScreenTransform() {
  const image = $('#screen-image');
  if (!screenBaseW) computeScreenBase();
  image.style.position = 'absolute'; image.style.left = '0'; image.style.top = '0';
  image.style.maxWidth = 'none'; image.style.maxHeight = 'none';
  image.style.width = `${Math.round(screenBaseW)}px`;
  image.style.height = `${Math.round(screenBaseH)}px`;
  image.style.transformOrigin = '0 0';
  image.style.transform = `translate(${screenPanX}px, ${screenPanY}px) scale(${screenScale})`;
  screenZoomed = screenScale > 1.001;
  $('#screen-stage').classList.toggle('zoomed', screenZoomed);
}
function zoomScreenAround(nextScale, clientX, clientY) {
  const preview = $('#screen-preview');
  const rect = preview.getBoundingClientRect?.() || { left: 0, top: 0 };
  const { w: pw, h: ph } = screenPreviewSize();
  const px = (Number.isFinite(clientX) ? clientX - rect.left : pw / 2);
  const py = (Number.isFinite(clientY) ? clientY - rect.top : ph / 2);
  const s0 = screenScale || 1;
  const s1 = Math.max(1, Math.min(screenMaxScale, nextScale));
  if (s1 === s0) return;
  // Keep the point under the fingers fixed on screen: T1 = P - (P - T0)*(s1/s0).
  screenPanX = px - (px - screenPanX) * (s1 / s0);
  screenPanY = py - (py - screenPanY) * (s1 / s0);
  screenScale = s1;
  if (screenScale <= 1.001) { screenScale = 1; centerScreenPan(); }
  else clampScreenPan();
  applyScreenTransform();
}
function panScreen(dx, dy) {
  if (screenScale <= 1.001) return false;
  screenPanX += dx; screenPanY += dy;
  clampScreenPan(); applyScreenTransform();
  return true;
}
function nativeScreenScale() {
  const image = $('#screen-image');
  return (image.naturalWidth || screenBaseW) / (screenBaseW || 1);
}
function sendMonitorClick(pixel, button) {
  const monitor = selectedMonitor();
  if (!pixel || !monitor || !connected || !state?.capabilities?.mouse) return false;
  return action('mouse.clickAt', { monitor: monitor.name, x: pixel.x, y: pixel.y, button });
}
function reconcileLive() { if (liveWanted && !liveSession && screenIsVisible() && connected && state?.capabilities?.live && $('#monitor-select').value) startLive(); }
function sessionIsCurrent(session) { return liveSession === session && screenIsVisible(); }
function updateScreenButtons() {}
function setScreenStatus(mode,message = '') {
  screenMode = mode; screenStatusMessage = message;
  $('#screen-stage').setAttribute('data-screen-mode', mode);
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
  $('#live-note').hidden = mode === 'live' || mode === 'idle';
  updateScreenButtons();
}
function applyScreenZoom() {
  computeScreenBase();
  screenScale = Math.max(1, Math.min(screenMaxScale, screenScale));
  if (screenScale <= 1.001) { screenScale = 1; centerScreenPan(); } else clampScreenPan();
  applyScreenTransform();
}
// Kept for the snapshot 1:1 path: set an absolute scale around the preview centre.
function setScreenZoom(value, point) {
  computeScreenBase();
  zoomScreenAround(value, point && Number.isFinite(point.x) ? ($('#screen-preview').getBoundingClientRect?.().left || 0) + point.x : undefined,
                          point && Number.isFinite(point.y) ? ($('#screen-preview').getBoundingClientRect?.().top || 0) + point.y : undefined);
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
  screenshotURL = null; lastScreenTimestamp = null; screenZoomed = false; screenScale = 1; screenPanX = screenPanY = 0; screenBaseW = screenBaseH = 0;
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
function cancelSnapshot() { snapshotRequest = null; }
function exitScreenFullscreen() {}
function leaveScreen() { resetRemoteInput(); stopLive(); cancelSnapshot(); closeRemoteKeyboard(); if (landscapeForced) requestOrientation('auto'); }
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
  const profile = LIVE_PROFILES[$('#live-quality').value] || LIVE_PROFILES.balanced;
  const session = {monitor,fps:profile.fps,scale:profile.scale,quality:profile.quality,profileLabel:profile.label,attempt:0,failures:0,hasFrame:false,rendering:false,pendingFrame:null,region:null,refreshing:false};
  liveSession = session;
  runLiveSession(session);
}
$('#monitor-select').addEventListener('change',() => {
  const restart = !!liveSession || liveWanted;
  savePreference('ponte-monitor',$('#monitor-select').value);
  screenScale = 1; screenPanX = screenPanY = 0;
  stopLive(); cancelSnapshot(); clearScreenImage();
  $('#viewer-monitor-name').textContent = $('#monitor-select').value || t("Monitor do PC");
  setScreenStatus('idle');
  if (restart) startLive();
});
// grim scales on the CPU, so the sharp profile streams native pixels at a
// lower JPEG quality and is both faster and crisper than a downscaled frame.
const LIVE_PROFILES = {
  sharp:{fps:15,scale:1,quality:50,label:'Nítido · até 15 quadros/s'},
  balanced:{fps:10,scale:0.5,quality:65,label:'Equilibrado · até 10 quadros/s'},
  light:{fps:8,scale:0.35,quality:55,label:'Leve · até 8 quadros/s'},
};
$('#live-quality').value = LIVE_PROFILES[savedPreference('ponte-quality','sharp')] ? savedPreference('ponte-quality','sharp') : 'sharp';
$('#live-quality').addEventListener('change',() => { savePreference('ponte-quality',$('#live-quality').value); if (liveSession) startLive(); });
$('#screen-image').addEventListener('load',() => {
  const image = $('#screen-image');
  const size = `${image.naturalWidth}x${image.naturalHeight}`;
  // A new monitor/source resets zoom; live frames keep the current zoom & pan.
  if (size !== screenSourceSize) { screenScale = 1; screenPanX = screenPanY = 0; screenSourceSize = size; computeScreenBase(); centerScreenPan(); }
  else computeScreenBase();
  applyScreenTransform();
});
window.addEventListener('resize',applyScreenZoom);
if (window.ResizeObserver) new window.ResizeObserver(applyScreenZoom).observe($('#screen-preview'));
const screenPointers = new Map();
const screenPreview = $('#screen-preview');
let pinchDistance = 0;
let pinchMid = null;
let screenGesture = { pinch: false, panned: false, twoFinger: false, moved: false };
const pointerDistance = () => { const [a,b] = [...screenPointers.values()]; return a && b ? Math.hypot(a.x-b.x,a.y-b.y) : 0; };
function imageLocalPoint(clientX, clientY) {
  const rect = $('#screen-image').getBoundingClientRect?.() || { left: 0, top: 0 };
  return { x: clientX - rect.left, y: clientY - rect.top };
}
function monitorPixelAt(clientX, clientY) {
  const layout = mappingLayout();
  if (!layout) return null;
  const local = imageLocalPoint(clientX, clientY);
  return mapTouchToMonitorPixel(local.x, local.y, layout);
}
// Quiet variant of action(): no toast, no state poll. Used for keystrokes and
// drag movement, which are frequent and self-evident on the PC screen.
async function quietAction(type, payload = {}) {
  if (!connected) return false;
  try { await api('/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type,...payload}) }); return true; }
  catch { return false; }
}

// ---- Direct touch: the image is the monitor. One mode, phone gestures only.
// Tap = click. Long press then lift = right click. Long press then move = drag
// with the button held. Pinch = zoom. One finger while zoomed = pan. Two
// fingers together = scroll the PC.
const hold = { timer: null, held: false, dragging: false, lastMove: 0, lastLease: 0, generation: 0 };
function clearHold() { clearTimeout(hold.timer); hold.timer = null; hold.held = false; }
async function beginHoldDrag(pixel) {
  const monitor = selectedMonitor();
  if (hold.dragging || !monitor || !pixel || !connected || !state?.capabilities?.mouse) return;
  const generation = ++hold.generation;
  hold.dragging = true; hold.lastLease = Date.now();
  $('#drag-indicator').hidden = false;
  await quietAction('mouse.moveTo', { monitor: monitor.name, x: pixel.x, y: pixel.y });
  if (generation !== hold.generation || !hold.dragging) return;
  if (!(await quietAction('mouse.drag', { pressed: true }))) endHoldDrag();
}
function moveHoldDrag(pixel) {
  const monitor = selectedMonitor();
  if (!hold.dragging || !monitor || !pixel) return;
  const now = Date.now();
  if (now - hold.lastMove < 35) return;
  hold.lastMove = now;
  quietAction('mouse.moveTo', { monitor: monitor.name, x: pixel.x, y: pixel.y });
  // The server auto-releases a held button after 1.8 s; renew while dragging.
  if (now - hold.lastLease > 600) { hold.lastLease = now; quietAction('mouse.drag', { pressed: true }); }
}
function endHoldDrag() {
  if (!hold.dragging) return;
  hold.dragging = false; hold.generation++;
  $('#drag-indicator').hidden = true;
  if (connected) quietAction('mouse.drag', { pressed: false });
}
function resetScreenGesture() {
  clearHold();
  const ids = [...screenPointers.keys()];
  screenPointers.clear();
  for (const id of ids) { if (screenPreview.hasPointerCapture?.(id)) screenPreview.releasePointerCapture(id); }
  screenGesture = { pinch: false, panned: false, twoFinger: false, moved: false };
  pinchMid = null; pinchDistance = 0;
  endHoldDrag();
}
function queueScroll(dy) {
  if (!connected || !state?.capabilities?.mouse) return;
  moveQueue.scroll += -dy / 7;
  if (!movementTimer) movementTimer = setInterval(flushMovement,35);
}
function stopPointerMoves() {
  clearInterval(movementTimer); movementTimer = null;
  flushMovement();
}
screenPreview.addEventListener('pointerdown',event => {
  if (!screenshotURL || event.target.closest('button')) return;
  if (event.button > 0) return;
  // Keeping default focus behaviour off means the phone keyboard, once open
  // for a text field, stays open while you tap around the screen.
  event.preventDefault?.();
  screenPreview.setPointerCapture?.(event.pointerId);
  screenPointers.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,started:Date.now(),moved:false});
  if (screenPointers.size === 1) {
    screenGesture = { pinch: false, panned: false, twoFinger: false, moved: false };
    pinchMid = null; pinchDistance = 0;
    clearHold();
    hold.timer = setTimeout(() => {
      hold.timer = null;
      const pointer = screenPointers.get(event.pointerId);
      if (pointer && !pointer.moved && screenPointers.size === 1) { hold.held = true; try { navigator.vibrate?.(12); } catch {} }
    },LONG_PRESS_MS);
  } else {
    screenGesture.twoFinger = true;
    clearHold(); endHoldDrag();
    const [a,b] = [...screenPointers.values()];
    pinchMid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
    pinchDistance = pointerDistance();
  }
});
screenPreview.addEventListener('pointermove',event => {
  const before = screenPointers.get(event.pointerId);
  if (!before) return;
  const dx = event.clientX-before.x, dy = event.clientY-before.y;
  if (Math.hypot(event.clientX-before.startX,event.clientY-before.startY) > SCREEN_PAN_SLOP) { before.moved = true; screenGesture.moved = true; }
  screenPointers.set(event.pointerId,{...before,x:event.clientX,y:event.clientY});
  if (screenPointers.size >= 2) {
    const [a,b] = [...screenPointers.values()];
    const midX = (a.x+b.x)/2, midY = (a.y+b.y)/2;
    const distance = pointerDistance();
    const factor = pinchDistance > 0 ? distance/pinchDistance : 1;
    const prevMid = pinchMid || { x: midX, y: midY };
    if (screenGesture.pinch || Math.abs(factor-1) > 0.02) {
      screenGesture.pinch = true;
      if (screenZoomed) panScreen(midX-prevMid.x, midY-prevMid.y);
      zoomScreenAround(screenScale*factor, midX, midY);
    } else if (screenZoomed) {
      screenGesture.panned = true;
      panScreen(midX-prevMid.x, midY-prevMid.y);
    } else {
      screenGesture.panned = true;
      queueScroll(midY - prevMid.y);
    }
    pinchMid = { x: midX, y: midY };
    pinchDistance = distance;
  } else if (!screenGesture.twoFinger) {
    if (hold.held || hold.dragging) {
      if (!hold.dragging && before.moved) beginHoldDrag(monitorPixelAt(before.startX, before.startY));
      if (hold.dragging) moveHoldDrag(monitorPixelAt(event.clientX, event.clientY));
    } else if (before.moved) {
      if (hold.timer) clearHold();
      if (screenZoomed) { screenGesture.panned = true; panScreen(dx, dy); }
    }
  }
  event.preventDefault?.();
});
function finishScreenPointer(event) {
  const pointer = screenPointers.get(event.pointerId);
  screenPointers.delete(event.pointerId);
  if (!pointer) return;
  if (screenPointers.size > 0) { pinchDistance = 0; pinchMid = null; return; }
  pinchMid = null;
  stopPointerMoves();
  const wasHeld = hold.held, wasDragging = hold.dragging;
  clearHold();
  if (wasDragging) { endHoldDrag(); return; }
  if (event.type === 'pointercancel') return;
  const moved = screenGesture.moved || pointer.moved || screenGesture.panned || screenGesture.pinch || screenGesture.twoFinger;
  if (moved) return;
  const pixel = monitorPixelAt(pointer.startX, pointer.startY);
  if (!pixel) return;
  if (wasHeld) { sendMonitorClick(pixel, 'right'); return; }
  if (Date.now() - pointer.started < 500) {
    Promise.resolve(sendMonitorClick(pixel, 'left')).then(ok => { if (ok) scheduleKeyboardCheck(); });
  }
}
for (const name of ['pointerup','pointercancel','lostpointercapture']) screenPreview.addEventListener(name,finishScreenPointer);
screenPreview.addEventListener('contextmenu', event => { event.preventDefault(); });
screenPreview.addEventListener('keydown',event => {
  if (event.key === '+' || event.key === '=') zoomScreenAround(screenScale*1.4);
  else if (event.key === '-') zoomScreenAround(screenScale/1.4);
  else if (event.key === '0') { screenScale = 1; applyScreenZoom(); }
  else return;
  event.preventDefault();
});

// ---- Phone keyboard for the PC. After a tap-click, the PC reports whether a
// text field took focus (fcitx5 input contexts). If so, a hidden input gets
// focus, Android raises its keyboard, and every edit is forwarded live as
// keystrokes. Back/blur closes it; a tap on a non-text area closes it too.
const remoteKeys = $('#remote-keys');
let remoteKeysValue = '';
let keyboardCheckTimer = 0;
let keyboardOpen = false;
let keyQueue = Promise.resolve();
function sendKeys(work) { keyQueue = keyQueue.then(work).catch(() => {}); return keyQueue; }
function scheduleKeyboardCheck() {
  clearTimeout(keyboardCheckTimer);
  keyboardCheckTimer = setTimeout(checkTextInput, 220);
}
async function checkTextInput() {
  if (!connected || !screenIsVisible()) return;
  let info;
  try { info = await (await api('/textinput',{timeout:3000})).json(); } catch { return; }
  if (!screenIsVisible()) return;
  if (info.focused === true) openRemoteKeyboard();
  else if (info.focused === false) closeRemoteKeyboard();
}
function openRemoteKeyboard() {
  remoteKeysValue = ''; remoteKeys.value = '';
  keyboardOpen = true;
  remoteKeys.focus({preventScroll:true});
  syncRemoteViewport();
}
function closeRemoteKeyboard() {
  clearTimeout(keyboardCheckTimer);
  if (!keyboardOpen && document.activeElement !== remoteKeys) return;
  keyboardOpen = false;
  remoteKeysValue = ''; remoteKeys.value = '';
  remoteKeys.blur();
  syncRemoteViewport();
}
remoteKeys.addEventListener('input', () => {
  const next = remoteKeys.value, prev = remoteKeysValue;
  remoteKeysValue = next;
  let common = 0;
  while (common < prev.length && common < next.length && prev[common] === next[common]) common++;
  const removed = prev.length - common, added = next.slice(common);
  if (removed || added) sendKeys(async () => {
    for (let i = 0; i < removed; i++) await quietAction('keyboard.key',{key:'BackSpace'});
    if (added) await quietAction('keyboard.text',{text:added});
  });
  // Keep a buffer so autocorrect can revise the last word, but never let it grow.
  if (next.length > 400) { remoteKeysValue = ''; remoteKeys.value = ''; }
});
remoteKeys.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); remoteKeysValue = ''; remoteKeys.value = ''; sendKeys(() => quietAction('keyboard.key',{key:'Enter'})); }
  else if (event.key === 'Backspace' && !remoteKeys.value) { event.preventDefault(); sendKeys(() => quietAction('keyboard.key',{key:'BackSpace'})); }
});
remoteKeys.addEventListener('blur', () => { keyboardOpen = false; syncRemoteViewport(); });
// Cycle the streamed monitor; the select on Início stays the source of truth.
$('#screen-switch-monitor').addEventListener('click', () => {
  const monitors = state?.monitors || [];
  if (monitors.length < 2) { toast(t("Só um monitor disponível.")); return; }
  const select = $('#monitor-select');
  const index = monitors.findIndex(m => m.name === select.value);
  const next = monitors[(index + 1) % monitors.length];
  select.value = next.name;
  select.dispatchEvent(new CustomEvent('change'));
  toast(t('Monitor {name}',{name:`${next.name} · ${Number(next.width)} × ${Number(next.height)}`}));
});
// Force landscape through the native activity (ponte://orientation/…); a
// second tap hands orientation back to the sensor. Browsers try the
// Screen Orientation API instead.
let landscapeForced = false;
function requestOrientation(mode) {
  const button = $('#screen-rotate');
  landscapeForced = mode === 'landscape';
  button.setAttribute('aria-pressed', String(landscapeForced));
  button.setAttribute('aria-label', landscapeForced ? t("Soltar orientação") : t("Forçar paisagem"));
  if (navigator.userAgent.includes('PonteAndroid/')) { try { location.href = `ponte://orientation/${mode}`; } catch {} return; }
  try {
    if (landscapeForced) { const lock = screen.orientation?.lock?.('landscape'); if (lock?.catch) lock.catch(() => toast(t("Este navegador não permite girar a tela."), true)); }
    else screen.orientation?.unlock?.();
  } catch { toast(t("Este navegador não permite girar a tela."), true); }
}
$('#screen-rotate').addEventListener('click', () => requestOrientation(landscapeForced ? 'auto' : 'landscape'));
$('#screen-dictate').addEventListener('click', () => {
  toggleDictation($('#screen-dictate'), $('#screen-dictate-status'), async blob => {
    const text = await uploadDictation('/dictate', blob);
    if (text) { await quietAction('keyboard.text',{text}); await quietAction('keyboard.key',{key:'Enter'}); }
    return text;
  });
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
  $$('#terminal-send,#terminal-paste,#terminal-clear,#terminal-input,#terminal-close,#terminal-size,[data-terminal-key]').forEach(element => { element.disabled = !ready; });
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
  growComposer();
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
    $('#terminal-status').textContent = terminalAvailable ? terminalId ? t('Conectado à sessão de texto.') : t('Crie uma sessão para começar.') : t('Instale tmux no PC para usar sessões de texto.');
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
// Command composer: build a command with the full phone keyboard, then Send
// (type + Enter in one atomic call) or Paste (type without running). Every sent
// command joins a reusable history that survives across sessions.
const CMD_HISTORY_KEY = 'ponte-cmd-history';
let cmdHistory = [];
try { const saved = JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]'); if (Array.isArray(saved)) cmdHistory = saved.filter(item => typeof item === 'string').slice(0, 40); } catch {}
function rememberCommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  cmdHistory = [trimmed, ...cmdHistory.filter(item => item !== trimmed)].slice(0, 40);
  try { localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(cmdHistory)); } catch {}
  renderCmdHistory();
}
function renderCmdHistory() {
  const box = $('#cmd-history');
  if (!box) return;
  box.hidden = cmdHistory.length === 0;
  box.innerHTML = cmdHistory.map((cmd, index) => `<button type="button" class="cmd-chip" data-cmd-index="${index}" title="${escaped(cmd)}"><span>${escaped(cmd)}</span></button>`).join('');
}
function growComposer() {
  const box = $('#terminal-input');
  box.style.height = 'auto';
  box.style.height = `${Math.min(140, box.scrollHeight)}px`;
}
async function sendCommand(withEnter) {
  const id = terminalId, box = $('#terminal-input'), text = box.value;
  if (!id || !text.trim() || terminalBusy) return;
  const result = await terminalMutation(`/terminals/${encodeURIComponent(id)}/input`, withEnter ? { text, enter: true } : { text });
  if (result) {
    if (withEnter) rememberCommand(text);
    terminalDrafts.delete(id);
    if (terminalId === id && box.value === text) { box.value = ''; growComposer(); }
    updateTerminalNavigation();
  } else if (result === null && connected) {
    toast(t("O comando não entrou. Tente de novo."), true);
  }
}
$('#terminal-send').addEventListener('click', () => sendCommand(true));
$('#terminal-paste').addEventListener('click', () => sendCommand(false));
$('#terminal-clear').addEventListener('click', () => { $('#terminal-input').value = ''; growComposer(); $('#terminal-input').focus(); });
$('#terminal-input').addEventListener('input', growComposer);
$('#terminal-input').addEventListener('focus', () => { setTimeout(syncRemoteViewport, 60); setTimeout(() => $('#terminal-input').scrollIntoView({block:'center',behavior:'smooth'}), 250); });
$('#terminal-input').addEventListener('blur', () => setTimeout(syncRemoteViewport, 60));
$('#terminal-input').addEventListener('keydown', event => {
  // Enter runs the command; Shift+Enter inserts a newline for multi-line input.
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCommand(true); }
});
$('#cmd-history').addEventListener('click', event => {
  const chip = event.target.closest('[data-cmd-index]');
  if (!chip) return;
  const cmd = cmdHistory[Number(chip.dataset.cmdIndex)];
  if (cmd === undefined) return;
  const box = $('#terminal-input');
  box.value = cmd; growComposer(); box.focus();
  try { box.setSelectionRange(cmd.length, cmd.length); } catch {}
});
renderCmdHistory();
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

// Scroll deltas are coalesced; only one movement request is in flight.
let moveQueue = {dx:0,dy:0,scroll:0};
let moving = false;
let movementTimer = null;
let dragging = false;
let dragTimer = null;

function resetRemoteInput() {
  remoteInputGeneration++;
  clearInterval(movementTimer); movementTimer = null;
  moveQueue = {dx:0,dy:0,scroll:0};
  resetScreenGesture();
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
    if (!screenPointers.size && (Math.round(moveQueue.dx) || Math.round(moveQueue.dy) || Math.round(moveQueue.scroll))) setTimeout(flushMovement,0);
  }
}
async function stopDrag() { endHoldDrag(); }

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
    clearInterval(movementTimer); movementTimer = null; moveQueue = {dx:0,dy:0,scroll:0};
  } else { pollState(); if (recorder?.state === 'recording') recordClock(); }
});
window.addEventListener('online', pollState);
window.addEventListener('offline', () => { if(token) setConnection(false,t("Este dispositivo está sem conexão.")); });
window.addEventListener('pagehide', () => { leaveScreen(); cancelPendingRecording(); stopRecording(); closeMicrophone(); clearInterval(dragTimer); abortDictation(); });
window.addEventListener('ponte-native-pause', event => {
  nativePaused = true;
  clearTimeout(terminalTimer); terminalGeneration++;
  leaveScreen(); stopDrag();
  if (!event.detail?.awaitingMicrophonePermission) { cancelPendingRecording(); stopRecording(); closeMicrophone(); abortDictation(); }
});
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (token) navigate(page); });

const dynamicFields = '#terminal-pause,#home-status,#pc-online,#hostname,#focus-summary,#dialog-hostname,#dialog-status,#window-count,#live-badge,#live-overlay-text,#viewer-monitor-name,#capture-time,#live-note,#record-state,#record-hint,#install-hint,#lights-status,#session-status,#wol-enabled,#terminal-dictate-status,#screen-dictate-status';
$$(dynamicFields).forEach(element => element.removeAttribute('data-i18n'));
$$('#mute-button').forEach(element => element.removeAttribute('data-i18n-aria-label'));
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
  let liveMessage = typeof screenStatusMessage === 'string' ? t(screenStatusMessage) : screenStatusMessage;
  if (screenMode === 'reconnecting' && liveSession?.retryDelay) liveMessage = t('{message} Tentando novamente em {seconds}s.',{message:t(liveSession.error?.message || 'Conexão interrompida.'),seconds:liveSession.retryDelay/1000});
  setScreenStatus(screenMode,liveMessage);
  if (screenshotURL) $('#screen-image').alt = t('Monitor {monitor}',{monitor:$('#viewer-monitor-name').textContent});
  updateInstalledState();
  i18n.apply();
  pollState();
});


// A control stays disabled while its own request runs, so a slow OpenRGB or
// lock command cannot be queued twice from repeated taps.
async function runBusy(button, work) {
  if (!button?.id) return work();
  if (busyControls.has(button.id)) return false;
  busyControls.add(button.id); button.disabled = true;
  try { return await work(); }
  finally { busyControls.delete(button.id); button.disabled = !connected; }
}

function renderLights() {
  const section = $('#lights-section');
  if (!section || !state) return;
  const caps = state.capabilities || {};
  const lights = state.lights;
  section.hidden = !caps.lights;
  if (!caps.lights) return;
  const presets = lights?.presets || ['lava','brasa','oceano','aurora','floresta','lua'];
  const names = {lava:t('Lava'),brasa:t('Brasa'),oceano:t('Oceano'),aurora:t('Aurora'),floresta:t('Floresta'),lua:t('Lua')};
  const signature = JSON.stringify([presets,lights?.preset,lights?.sleeping,connected,i18n.language]);
  if (section.dataset.signature === signature) return;
  section.setAttribute('data-signature',signature);
  $('#lights-presets').innerHTML = presets.map(preset => `<button class="workspace lights-preset ${lights && !lights.sleeping && lights.preset === preset ? 'active' : ''}" data-action="lights.preset" data-preset="${escaped(preset)}" aria-pressed="${String(!!lights && !lights.sleeping && lights.preset === preset)}"${connected ? '' : ' disabled'}><span class="lights-swatch" data-preset="${escaped(preset)}"></span>${escaped(names[preset] || preset)}</button>`).join('');
  $('#lights-status').textContent = !lights ? t("Estado das luzes indisponível.") : lights.sleeping ? t("Luzes apagadas. Toque em um preset ou em Restaurar.") : t('Luzes acesas no preset {preset}.',{preset:names[lights.preset] || lights.preset});
}

function renderSession() {
  const section = $('#session-section');
  if (!section || !state) return;
  const session = state.session || {};
  const locked = session.locked;
  $('#session-status').textContent = !session.lockAvailable ? t("Bloqueio do Omarchy indisponível neste PC.") : locked === true ? t("PC bloqueado. Desbloqueie digitando a senha por aqui.") : locked === false ? t("PC desbloqueado.") : t("Estado do bloqueio desconhecido.");
  $('#btn-lock').disabled = !connected || !session.lockAvailable || locked === true || busyControls.has('btn-lock');
  $('#btn-unlock').disabled = !connected || !session.lockAvailable || locked !== true || busyControls.has('btn-unlock');
  $('#btn-unlock').classList.toggle('primary', locked === true);
}

$('#btn-unlock').addEventListener('click', () => { $('#unlock-password').value = ''; $('#unlock-dialog').showModal(); $('#unlock-password').focus?.(); });
$('#unlock-cancel').addEventListener('click', () => $('#unlock-dialog').close());
$('#unlock-dialog-close').addEventListener('click', () => $('#unlock-dialog').close());
$('#unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('#unlock-password').value;
  if (!password) { $('#unlock-password').focus?.(); return; }
  $('#unlock-confirm').disabled = true;
  try {
    const ok = await action('session.unlock',{password},t("Senha digitada no PC."));
    if (ok) { $('#unlock-password').value = ''; $('#unlock-dialog').close(); }
  } finally { $('#unlock-confirm').disabled = false; }
});
$('#btn-reboot').addEventListener('click', () => $('#reboot-dialog').showModal());
$('#reboot-cancel').addEventListener('click', () => $('#reboot-dialog').close());
$('#reboot-confirm').addEventListener('click', async () => { $('#reboot-dialog').close(); await action('power.reboot', {}, t("Reiniciando o PC…")); });
$('#btn-suspend').addEventListener('click', () => $('#suspend-dialog').showModal());
$('#suspend-cancel').addEventListener('click', () => $('#suspend-dialog').close());
$('#suspend-confirm').addEventListener('click', async () => { $('#suspend-dialog').close(); await action('power.suspend', {}, t("Suspendendo o PC…")); });

// Dictation: a short recording is transcribed on the PC and typed there. The
// audio is uploaded once and never stored; only the text comes back.
let dictation = null;
function dictationStatus(element, message, error = false) {
  if (!element) return;
  if (message) i18n.write(element, message); else element.textContent = '';
  element.hidden = !message;
  element.classList.toggle('error', error);
}
function abortDictation() {
  const current = dictation;
  if (!current) return;
  dictation = null;
  current.discard = true;
  clearTimeout(current.timer);
  try { if (current.recorder && current.recorder.state !== 'inactive') current.recorder.stop(); } catch {}
  current.stream?.getTracks().forEach(track => track.stop());
  current.button.classList.remove('recording');
  current.button.setAttribute('aria-pressed','false');
  current.button.innerHTML = current.idle;
  current.button.disabled = !connected || !state?.capabilities?.stt;
  dictationStatus(current.status,'');
}
async function toggleDictation(button, status, upload) {
  if (dictation && dictation.button === button) {
    if (dictation.recorder?.state === 'recording') { dictationStatus(status,t("Transcrevendo…")); dictation.recorder.stop(); }
    return;
  }
  if (dictation) abortDictation();
  if (!connected) { toast(t("Reconecte ao PC para usar este controle."), true); return; }
  if (!state?.capabilities?.stt) { dictationStatus(status,t("Reconhecimento de voz indisponível no PC. Abra o Sussurro ou o OmniVoice Studio."),true); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { dictationStatus(status,t("Este navegador não oferece gravação de áudio. Abra o Ponte no Chrome ou em outro navegador atualizado."),true); return; }
  const idle = button.innerHTML;
  const current = { button, status, idle, recorder: null, stream: null, discard: false, timer: null };
  dictation = current;
  button.setAttribute('aria-pressed','true');
  dictationStatus(status,t("Permita o microfone…"));
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}); }
  catch (error) {
    if (dictation === current) { const messages = {NotAllowedError:t("Microfone não permitido. Nas permissões deste site, libere o microfone e tente novamente."),NotFoundError:t("Nenhum microfone encontrado neste dispositivo."),NotReadableError:t("O microfone está ocupado. Feche outros apps que estejam gravando e tente novamente.")}; abortDictation(); dictationStatus(status,messages[error?.name] || error?.message || t("Não foi possível abrir o microfone."),true); }
    else stream?.getTracks().forEach(track => track.stop());
    return;
  }
  if (dictation !== current) { stream.getTracks().forEach(track => track.stop()); return; }
  current.stream = stream;
  const formats = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4'];
  const supported = formats.find(format => MediaRecorder.isTypeSupported(format));
  if (!supported) { abortDictation(); dictationStatus(status,t("Nenhum formato de gravação compatível neste navegador. Tente abrir no Chrome."),true); return; }
  const chunks = [];
  const recorder = new MediaRecorder(stream,{mimeType:supported});
  current.recorder = recorder;
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => { if (dictation === current) { abortDictation(); dictationStatus(status,t("A gravação foi interrompida. Tente gravar novamente."),true); } };
  recorder.onstop = async () => {
    stream.getTracks().forEach(track => track.stop());
    clearTimeout(current.timer);
    if (current.discard) return;
    dictation = null;
    button.classList.remove('recording'); button.setAttribute('aria-pressed','false'); button.innerHTML = idle; button.disabled = true;
    const blob = new Blob(chunks,{type:recorder.mimeType || supported});
    try {
      if (!blob.size) throw new Error(t("Nenhum áudio foi capturado. Tente novamente."));
      dictationStatus(status,t("Transcrevendo…"));
      const text = await upload(blob);
      dictationStatus(status,t('Você disse: {text}',{text}));
    } catch (error) { dictationStatus(status,error,true); }
    finally { button.disabled = !connected || !state?.capabilities?.stt; }
  };
  recorder.start(500);
  button.classList.add('recording');
  button.innerHTML = `${icon('stop')}<span>${h("Parar e enviar")}</span>`;
  dictationStatus(status,t("Gravando… toque de novo para enviar."));
  // A forgotten microphone stops itself after one minute.
  current.timer = setTimeout(() => { if (dictation === current && recorder.state === 'recording') recorder.stop(); },60000);
}
async function uploadDictation(path, blob) {
  const response = await api(path,{method:'POST',headers:{'Content-Type':blob.type},body:blob,timeout:70000});
  return (await response.json()).text || '';
}
$('#terminal-dictate-enter').checked = savedPreference('ponte-dictate-enter','1') !== '0';
$('#terminal-dictate-enter').addEventListener('change', event => savePreference('ponte-dictate-enter', event.target.checked ? '1' : '0'));
$('#terminal-dictate').addEventListener('click', () => {
  const id = terminalId;
  if (!id) { dictationStatus($('#terminal-dictate-status'),t("Crie ou escolha uma sessão antes de falar."),true); return; }
  toggleDictation($('#terminal-dictate'), $('#terminal-dictate-status'), async blob => {
    // Speaking a command drops the transcript into the composer to review, not
    // straight into the shell — you send it with the same button as typed text.
    const text = await uploadDictation('/dictate', blob);
    if (text) { const box = $('#terminal-input'); box.value = box.value ? `${box.value} ${text}` : text; growComposer(); box.focus(); }
    return text;
  });
});
window.addEventListener('popstate', () => { const page = location.hash.slice(1); if (token && page) navigate(page); });

// A device already on the owner's tailnet is handed the key by the PC, so it
// never sees the pairing screen. The typed key stays as the fallback.
async function autoPair() {
  try {
    const response = await fetch('/api/pair', { headers: { 'Accept-Language': i18n.locale }, cache: 'no-store' });
    if (!response.ok) return false;
    const data = await response.json();
    if (typeof data.token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(data.token)) return false;
    token = data.token;
    try { localStorage.setItem(storageKey, token); } catch {}
    return true;
  } catch { return false; }
}
function enterApp(page) {
  showApp(); setConnection(false,t("Conectando ao seu computador…"));
  const first = page || location.hash.slice(1) || 'tela';
  if (first === 'tela') { navigate('inicio'); navigate('tela'); } else navigate(first);
  pollState();
}
updateInstalledState();
if (token) enterApp();
else {
  showPairing();
  autoPair().then(ok => { if (ok && !connected) { $('#pair-error').hidden = true; enterApp('tela'); toast(t("Conectado pela sua rede Tailscale.")); } });
}
setInterval(pollState,4000);
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});

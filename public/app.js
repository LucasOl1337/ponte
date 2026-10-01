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
const UI_VERSION = '0.1.0-alpha.36';
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
let screenWorkspaceSignature = '';
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

// The device being controlled: empty is the node serving this page. Any other
// id makes every /api call carry node=<id>, which that node relays over its
// pinned link. This is the one place the choice is applied; `home` keeps a
// call (the mesh actions) on the serving node.
let targetNode = '';
let meshInfo = null;
function apiUrl(path, home = false) {
  if (!targetNode || home) return `/api${path}`;
  return `/api${path}${path.includes('?') ? '&' : '?'}node=${encodeURIComponent(targetNode)}`;
}
const monitorKey = () => targetNode ? `ponte-monitor:${targetNode}` : 'ponte-monitor';

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  const requestToken = token;
  const headers = {'Accept-Language':i18n.locale,Authorization: `Bearer ${requestToken}`, ...options.headers};
  try {
    const response = await fetch(apiUrl(path, options.home), { ...options, headers, signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      let message = t("Não foi possível concluir a ação.");
      let details;
      try { details = await response.json(); message = details.error || message; } catch {}
      if (response.status === 401 && token === requestToken) {
        // The token rotated on the PC. No password to re-enter: drop it and let
        // the tailnet hand us a fresh one.
        connected = false;
        token = '';
        try { localStorage.removeItem(storageKey); } catch {}
        showPairing(); connectOverTailscale();
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

// The parsed answer of an action, or false when it failed (already toasted).
async function actionResult(type, payload = {}, feedback = '') {
  if (!connected) { toast(t("Reconecte ao PC para usar este controle."), true); return false; }
  try {
    const response = await api('/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type,...payload}) });
    if (feedback) toast(feedback);
    if (!type.startsWith('mouse.')) setTimeout(pollState, 180);
    try { const body = await response.json(); return body && typeof body === 'object' ? body : {}; } catch { return {}; }
  } catch (error) { toast(error, true); return false; }
}
async function action(type, payload = {}, feedback = '') { return !!await actionResult(type, payload, feedback); }

// Sleep, wake and light changes run one OpenRGB call per device group on the PC
// (~20 s). The PC answers within ~11 s; a longer job comes back as pending and
// its outcome arrives with the state poll as lights.last for the same job.
let pendingLights = null;
function lightsOutcome(devices, feedback) {
  const absent = devices.filter(item => item.status === 'absent').map(item => item.device);
  return absent.length ? `${feedback} ${t('Não encontrado (desligado?): {devices}.',{devices:absent.join(', ')})}` : feedback;
}
function settleLights(last) {
  if (!pendingLights || !last || last.job !== pendingLights.job) return;
  const { feedback } = pendingLights;
  pendingLights = null;
  const devices = Array.isArray(last.devices) ? last.devices : [];
  const failed = devices.filter(item => item.status === 'failed').map(item => item.device);
  if (last.ok) toast(lightsOutcome(devices, feedback));
  else toast(t('Estas luzes não responderam: {devices}.',{devices:failed.join(', ') || 'RGB'}), true);
}
async function lightsAction(type, payload = {}, feedback = '') {
  if (!connected) { toast(t("Reconecte ao PC para usar este controle."), true); return false; }
  try {
    const response = await api('/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type,...payload}) });
    let result = null;
    try { result = await response.json(); } catch {}
    const lights = result && result.lights;
    if (lights && lights.pending) {
      pendingLights = { job: lights.job, feedback };
      toast(t("As luzes ainda estão mudando no PC. O resultado aparece aqui."));
    } else toast(lightsOutcome(lights && Array.isArray(lights.devices) ? lights.devices : [], feedback));
    setTimeout(pollState, 180);
    return true;
  } catch (error) { toast(error, true); setTimeout(pollState, 180); return false; }
}

// ------------------------------------------------------------------- devices
// The home node lists the other Ponte nodes on the tailnet (inside /api/state,
// the only route the phone's proxy has for it) and runs the mesh.* actions.
let meshSignature = '';
const meshSelf = () => meshInfo?.self || null;
const meshPeer = id => (meshInfo?.peers || []).find(peer => peer.id === id) || null;
function targetName() {
  if (!targetNode) return meshSelf()?.name || state?.hostname || '';
  return meshPeer(targetNode)?.name || state?.node?.name || targetNode;
}
function renderMesh() {
  const peers = meshInfo?.peers || [];
  const requests = meshInfo?.requests || [];
  const controllers = meshInfo?.controllers || [];
  const signature = JSON.stringify([meshInfo, targetNode, i18n.language]);
  if (signature === meshSignature) return;
  meshSignature = signature;
  const self = meshSelf();
  const paired = peers.filter(peer => peer.paired);
  // The selector: this device plus paired ones, online or not.
  const select = $('#node-select');
  $('#node-choice').hidden = !self || (!paired.length && !targetNode);
  if (self) {
    select.innerHTML = [`<option value="">${escaped(t('{name} · este aparelho',{name:self.name}))}</option>`]
      .concat(paired.map(peer => `<option value="${escaped(peer.id)}">${escaped(peer.online ? peer.name : t('{name} · offline',{name:peer.name}))}</option>`)).join('');
    select.value = targetNode;
  }
  const badge = $('#node-badge');
  badge.hidden = !targetNode;
  if (targetNode) { badge.textContent = targetName(); badge.setAttribute('aria-label',t('Controlando {name}. Trocar de aparelho',{name:targetName()})); badge.setAttribute('title',t('Controlando {name}',{name:targetName()})); }
  $('#mesh-card').hidden = !self;
  if (!self) return;
  $('#mesh-requests').innerHTML = requests.map(item => `<div class="mesh-row mesh-request"><div><strong>${escaped(t('{name} pede para controlar este aparelho',{name:item.name}))}</strong><span>${escaped(t('Código {code}',{code:item.code}))}</span></div><div class="mesh-buttons"><button type="button" class="button small primary" data-mesh-approve="${escaped(item.code)}">${h('Aprovar')}</button><button type="button" class="button small" data-mesh-deny="${escaped(item.code)}">${h('Negar')}</button></div></div>`).join('');
  $('#mesh-peers').innerHTML = peers.length ? peers.map(peer => {
    const status = peer.pairing?.status === 'pending' ? t('Aguardando aprovação · código {code}',{code:peer.pairing.code})
      : peer.pairing?.status === 'denied' ? t('Pedido negado.') : peer.pairing?.status === 'expired' ? t('Pedido expirou.')
      : peer.paired ? (peer.online ? t('Emparelhado · online') : t('Emparelhado · offline')) : t('Disponível');
    const buttons = peer.paired
      ? `${peer.id === targetNode ? '' : `<button type="button" class="button small primary" data-mesh-control="${escaped(peer.id)}">${h('Controlar')}</button>`}<button type="button" class="button small danger-subtle" data-mesh-revoke="${escaped(peer.id)}">${h('Revogar')}</button>`
      : peer.pairing?.status === 'pending' ? '' : `<button type="button" class="button small primary" data-mesh-pair="${escaped(peer.id)}">${h('Pedir acesso')}</button>`;
    return `<div class="mesh-row${peer.id === targetNode ? ' current' : ''}"><div><strong>${escaped(peer.name)}</strong><span>${escaped(status)}</span></div><div class="mesh-buttons">${buttons}</div></div>`;
  }).join('') : `<p class="hint">${h('Nenhum outro aparelho com Ponte no seu Tailscale.')}</p>`;
  $('#mesh-controllers').innerHTML = controllers.length ? `<span class="small-label">${h('QUEM CONTROLA ESTE APARELHO')}</span>` + controllers.map(item => `<div class="mesh-row"><div><strong>${escaped(item.name)}</strong><span>${escaped(item.ip || '')}</span></div><div class="mesh-buttons"><button type="button" class="button small danger-subtle" data-mesh-revoke="${escaped(item.id)}">${h('Revogar')}</button></div></div>`).join('') : '';
}
function setTargetNode(id) {
  const next = id && id !== meshSelf()?.id ? id : '';
  if (next === targetNode) return;
  const restart = !!liveSession || liveWanted;
  targetNode = next;
  // Everything on screen belonged to the other device: start clean there.
  stopLive(); cancelSnapshot(); clearScreenImage(); setScreenStatus('idle');
  monitorSignature = ''; windowSignature = ''; workspaceSignature = ''; screenWorkspaceSignature = ''; renderedAllOnce = false;
  $('#monitor-select').innerHTML = '';
  clearTimeout(terminalTimer); terminalGeneration++; terminalDrafts.clear(); terminalId = ''; terminalSessions = []; terminalText = null;
  clearTimeout(devTimer); devGeneration++; devId = ''; devSessions = []; devHash = ''; devHashId = '';
  liveWanted = restart;
  renderMesh();
  toast(t('Agora controlando {name}.',{name:targetName()}));
  updateTerminalNavigation(); updateDevNavigation();
  pollState();
}
async function meshAction(type, payload) {
  try {
    const response = await api('/action', { method:'POST', home:true, headers:{'Content-Type':'application/json'}, body:JSON.stringify({type,...payload}) });
    const result = await response.json();
    setTimeout(pollState, 150);
    return result;
  } catch (error) { toast(error, true); return null; }
}
$('#node-select').addEventListener('change', event => setTargetNode(event.target.value));
$('#node-badge').addEventListener('click', () => { navigate('inicio'); $('#mesh-card').scrollIntoView?.({block:'start'}); });
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-mesh-control]');
  if (control) { setTargetNode(control.dataset.meshControl); navigate('tela'); return; }
  const button = event.target.closest('[data-mesh-pair],[data-mesh-approve],[data-mesh-deny],[data-mesh-revoke]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (button.dataset.meshPair) {
      const peer = meshPeer(button.dataset.meshPair);
      const result = await meshAction('mesh.pair', { peer: button.dataset.meshPair });
      if (result?.code) toast(t('Código {code}: aprove no {name}.',{code:result.code,name:result.peer?.name || peer?.name || ''}));
    } else if (button.dataset.meshApprove) {
      const result = await meshAction('mesh.approve', { code: button.dataset.meshApprove });
      if (result?.approved) toast(t('Aprovado: {name} já pode controlar este aparelho.',{name:result.approved.name}));
    } else if (button.dataset.meshDeny) {
      const result = await meshAction('mesh.deny', { code: button.dataset.meshDeny });
      if (result?.denied) toast(t('Pedido de {name} negado.',{name:result.denied.name}));
    } else if (button.dataset.meshRevoke) {
      const id = button.dataset.meshRevoke;
      const result = await meshAction('mesh.revoke', { peer: id });
      if (result?.revoked) { toast(t('Acesso com {name} revogado.',{name:result.revoked.name})); if (targetNode === id) setTargetNode(''); }
    }
  } finally { button.disabled = false; }
});

// ------------------------------------------------------------------- fleet
// Every machine the home node reaches (tailnet, ~/.ssh/config, mesh), the health
// of each SSH route, and agent sessions on the others that can continue here.
// Always the home node's view (home:true), through /api/action like the mesh,
// since the phone's proxy only relays /api/state and /api/action.
let fleetInfo = null, fleetLoadedAt = 0, fleetBusy = false, fleetJob = null, fleetSignature = '';
const FLEET_REFRESH_MS = 60000;
async function fleetAction(type, payload = {}, timeout = 14000) {
  const response = await api('/action', { method:'POST', home:true, timeout, headers:{'Content-Type':'application/json'}, body:JSON.stringify({type,...payload}) });
  return response.json();
}
async function loadFleet(fresh = false) {
  if (fleetBusy || !meshSelf()) return;
  if (!fresh && fleetInfo && Date.now() - fleetLoadedAt < FLEET_REFRESH_MS) return;
  fleetBusy = true; renderFleet();
  try { fleetInfo = await fleetAction('fleet.list', { deep:true, fresh }); fleetLoadedAt = Date.now(); }
  catch (error) { if (fresh) toast(error, true); }
  finally { fleetBusy = false; renderFleet(); }
}
function fleetHealth(health) {
  return ({ ok:[t('Conectada'),'ok'], unchecked:[t('Não conferida'),''], unreachable:[t('Sem conexão'),'bad'], degraded:[t('Instável'),'warn'], offline:[t('Offline'),''], 'no-ssh':[t('Sem SSH'),''] })[health] || [t('Desconhecida'),''];
}
const fleetKindLabel = kind => ({ claude:'Claude Code', codex:'Codex', jcode:'Jcode' })[kind] || kind;
function fleetMachineLine(machine) {
  const [label] = fleetHealth(machine.health);
  const parts = [label];
  const route = (machine.routes || []).find(item => item.alias === machine.sshAlias);
  if (machine.id !== 'self' && route?.check) parts.push(route.check.ok ? t('SSH {ms} ms',{ms:route.check.ms}) : t('SSH: {code}',{code:route.check.code}));
  const link = machine.tailnet?.link;
  if (link === 'direct') parts.push(t('Tailscale direto'));
  else if (link === 'relay') parts.push(t('Tailscale via relay {relay}',{relay:machine.tailnet.relay || ''}));
  const tools = Object.entries(machine.probe?.tools || {}).filter(([name, ok]) => ok && ['claude','codex','jcode'].includes(name)).map(([name]) => fleetKindLabel(name));
  if (tools.length) parts.push(tools.join(', '));
  const open = (machine.probe?.agents || []).length;
  if (open) parts.push(i18n.plural('{count} agente aberto','{count} agentes abertos',open));
  return parts.join(' · ');
}
function fleetRemoteSessions() {
  const here = (fleetInfo?.machines || []).find(machine => machine.id === 'self');
  const tools = here?.probe?.tools || {};
  const items = [];
  for (const machine of fleetInfo?.machines || []) {
    if (machine.id === 'self' || !machine.probe?.ok) continue;
    for (const session of machine.probe.sessions || []) if (tools[session.kind] !== false) items.push({ ...session, machine:machine.id, machineName:machine.name });
  }
  return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
}
function renderFleetJob() {
  const box = $('#fleet-job');
  if (!fleetJob) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const job = fleetJob;
  box.classList.toggle('error', job.status === 'failed');
  const steps = { session:t('sessão lida'), project:t('projeto encontrado'), clone:t('projeto clonado'), git:t('código atualizado'), changes:t('mudanças aplicadas'), copy:t('conversa copiada'), resume:t('agente reaberto') };
  const done = (job.steps || []).map(step => steps[step.name]).filter(Boolean).join(' · ');
  if (job.status === 'running') { box.innerHTML = `<strong>${h('Continuando {kind} de {name}…',{kind:fleetKindLabel(job.kind),name:job.fromName || ''})}</strong><br>${escaped(done)}`; return; }
  if (job.status === 'failed') {
    const text = job.error?.text?.[i18n.language === 'pt' ? 'pt' : 'en'] || job.error?.code || t('Não foi possível concluir a ação.');
    const retry = job.error?.code === 'FLEET_SESSION_LIVE' || job.error?.code === 'FLEET_DEST_NEWER';
    box.innerHTML = `${escaped(text)}${retry ? `<div class="mesh-buttons" style="margin-top:8px"><button type="button" class="button small" data-fleet-force="1">${h('Continuar mesmo assim')}</button></div>` : ''}`;
    return;
  }
  const terminal = job.result?.terminal;
  box.innerHTML = `<strong>${h('{kind} continua aqui.',{kind:fleetKindLabel(job.kind)})}</strong><br>${escaped(job.result?.noteText?.[i18n.language === 'pt' ? 'pt' : 'en'] || job.result?.note || '')}${terminal?.id ? `<div class="mesh-buttons" style="margin-top:8px"><button type="button" class="button small primary" data-fleet-open="${escaped(terminal.id)}">${h('Abrir terminal')}</button></div>` : ''}`;
}
function renderFleet() {
  const card = $('#fleet-card');
  card.hidden = !meshSelf();
  if (card.hidden) return;
  $('#fleet-refresh').disabled = fleetBusy;
  renderFleetJob();
  const signature = JSON.stringify([fleetInfo?.checkedAt, fleetBusy, fleetJob?.status, i18n.language]);
  if (signature === fleetSignature) return;
  fleetSignature = signature;
  const machines = fleetInfo?.machines || [];
  const order = { ok:0, degraded:1, unchecked:2, unreachable:3, 'no-ssh':4, offline:5 };
  // Machines an agent can work on come first; phones and devices with no
  // SSH route or offline fold into one line so the useful ones stay in view.
  const workable = machine => machine.id === 'self' || (machine.kind !== 'phone' && !!machine.sshAlias);
  const others = machines.filter(machine => !workable(machine));
  const othersLine = others.length ? `<p class="hint">${h('Também no Tailscale: {names}.',{names:others.map(machine => `${machine.name} (${fleetHealth(machine.health)[0].toLowerCase()})`).join(', ')})}</p>` : '';
  $('#fleet-machines').innerHTML = machines.length ? machines.filter(workable).sort((a, b) => (a.id === 'self' ? -1 : b.id === 'self' ? 1 : (order[a.health] ?? 6) - (order[b.health] ?? 6)))
    .map(machine => {
      const [, tone] = fleetHealth(machine.health);
      const name = machine.id === 'self' ? t('{name} · este aparelho',{name:machine.name}) : machine.name;
      return `<div class="mesh-row fleet-row"><div><strong><i class="fleet-dot ${tone}"></i>${escaped(name)}</strong><span>${escaped(fleetMachineLine(machine))}</span></div></div>`;
    }).join('') + othersLine : `<p class="hint">${h(fleetBusy ? 'Conferindo as conexões…' : 'Nenhuma máquina encontrada.')}</p>`;
  const sessions = fleetRemoteSessions();
  const busy = fleetJob?.status === 'running';
  $('#fleet-sessions').innerHTML = sessions.length ? sessions.map(item => {
    const where = [item.machineName, fleetKindLabel(item.kind), item.cwd, agentAgo(item.updatedAt), item.live ? t('aberto lá') : ''].filter(Boolean).join(' · ');
    return `<div class="mesh-row fleet-row"><div><strong>${escaped(item.title || item.last || fleetKindLabel(item.kind))}</strong><span>${escaped(where)}</span></div><div class="mesh-buttons"><button type="button" class="button small primary" data-fleet-continue="${escaped(item.id)}" data-fleet-machine="${escaped(item.machine)}" data-fleet-kind="${escaped(item.kind)}"${busy ? ' disabled' : ''}>${h('Continuar aqui')}</button></div></div>`;
  }).join('') : `<p class="hint">${h(fleetBusy ? 'Procurando sessões…' : 'Nenhuma sessão recente em outra máquina.')}</p>`;
}
async function fleetContinue(request) {
  const from = (fleetInfo?.machines || []).find(machine => machine.id === request.from);
  try {
    let job = await fleetAction('fleet.handoff', request);
    fleetJob = { ...job, fromName: from?.name || request.from, request };
    renderFleet();
    while (job.status === 'running') {
      job = await fleetAction('fleet.job', { id: job.id, wait: 8 });
      fleetJob = { ...job, fromName: fleetJob.fromName, request };
      renderFleet();
    }
    if (job.status === 'done') { toast(t('{kind} continua aqui.',{kind:fleetKindLabel(job.kind)})); loadFleet(true); }
  } catch (error) {
    fleetJob = null; renderFleet(); toast(error, true);
  }
}
function fleetOpenTerminal(id) {
  if (targetNode) setTargetNode('');
  const title = fleetKindLabel(fleetJob?.kind);
  if (!terminalSessions.some(item => item.id === id)) terminalSessions.push({ id, title });
  selectTerminal(id); terminalPaused = false; navigate('terminais');
}
$('#fleet-refresh').addEventListener('click', () => loadFleet(true));
document.addEventListener('click', event => {
  const go = event.target.closest('[data-fleet-continue]');
  if (go && !go.disabled) { fleetContinue({ from:go.dataset.fleetMachine, to:'self', kind:go.dataset.fleetKind, session:go.dataset.fleetContinue }); return; }
  const force = event.target.closest('[data-fleet-force]');
  if (force && fleetJob?.request) { fleetContinue({ ...fleetJob.request, force:true }); return; }
  const open = event.target.closest('[data-fleet-open]');
  if (open) fleetOpenTerminal(open.dataset.fleetOpen);
});

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
  // No password/key to manage, so there is nothing to "unpair".
  $('#unpair-button').hidden = true;
}

function setConnection(isConnected, error = '') {
  connected = isConnected;
  $('#home-status').textContent = isConnected ? t("SEU PC ESTÁ CONECTADO") : t("RECONEXÃO AUTOMÁTICA");
  $('#pc-online').textContent = isConnected ? 'online' : 'offline';
  $('#pc-online').classList.toggle('offline', !isConnected);
  $('#dialog-status').textContent = isConnected ? t("Conexão privada · navegador pareado") : t("Aguardando resposta do computador");
  $('#connection-banner').hidden = isConnected || !token;
  if (!isConnected) i18n.write($('#connection-banner-text'),error || t("Conexão interrompida. Tentando reconectar…"));
  $$('[data-app],[data-action],[data-key],[data-monitor-toggle],#mute-button,#stop-pc-audio,#btn-poweroff,#btn-unlock,#btn-suspend,#btn-reboot,#terminal-dictate,#screen-dictate,#screen-keyboard').forEach(button => { button.disabled = !isConnected || busyControls.has(button.id); });
  $('#volume').disabled = !isConnected;
  updateScreenButtons();
  if (isConnected && state) updateCapabilities();
  if (!isConnected) { closeScreenComposer(); markTextFocus(false); }
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
  renderVisiblePage();
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
    const selected = $('#monitor-select').value || savedPreference(monitorKey());
    $('#monitor-select').innerHTML = monitors.length ? monitors.map(m => `<option value="${escaped(m.name)}">${escaped(m.name)} · ${Number(m.width)} × ${Number(m.height)}${m.focused ? t(" · em foco") : ''}</option>`).join('') : `<option value="">${escaped(t("Nenhum monitor disponível"))}</option>`;
    const next = monitors.find(m => m.name === selected) || monitors.find(m => m.focused) || monitors[0];
    if (next) { $('#monitor-select').value = next.name; if (!savedPreference(monitorKey())) savePreference(monitorKey(),next.name); }
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
  // While the Android app is paused its proxy refuses requests; a poll then
  // would only mark the PC offline. Resume polls again.
  if (!token || polling || document.hidden || nativePaused) return;
  const requestToken = token, requestNode = targetNode;
  polling = true;
  try {
    const response = await api('/state', {timeout:10000});
    const nextState = await response.json();
    if (requestToken !== token || requestNode !== targetNode) return;
    state = nextState;
    if (state.mesh) meshInfo = state.mesh;
    renderMesh();
    if (state.version && state.version !== UI_VERSION && typeof location.reload === 'function') {
      let guard = '';
      try { guard = sessionStorage.getItem('ponte-reloaded-for') || ''; } catch {}
      if (guard !== state.version) { try { sessionStorage.setItem('ponte-reloaded-for', state.version); } catch {} location.reload(); return; }
    }
    showApp();
    setConnection(true);
    renderState();
    if (currentPage === 'voz' && !audioLoaded) loadAudio();
    if (typeof state.textInput?.focused === 'boolean') markTextFocus(state.textInput.focused);
    if (currentPage === 'terminais') renderDesktopTerminals();
  } catch (error) {
    // The link to that device is gone (revoked there, or forgotten here): back home.
    if (targetNode && requestNode === targetNode && ['PEER_REVOKED','MESH_PEER_NOT_FOUND'].includes(error.errorCode)) { setTargetNode(''); toast(error, true); return; }
    if (token && requestToken === token && requestNode === targetNode) setConnection(false, error);
  }
  finally { polling = false; if (requestNode !== targetNode) setTimeout(pollState, 0); }
}

// Each poll used to rebuild every page's lists (windows, workspaces, lights,
// session) even while only the monitor was on screen. Only the visible page
// is rendered per poll; the others catch up when navigated to.
let renderedAllOnce = false;
function renderVisiblePage() {
  if (!state) return;
  settleLights(state.lights && state.lights.last);
  // The first state (and a language change) fills every page so nothing is
  // empty when navigated to; after that only the visible page is refreshed.
  if (!renderedAllOnce) { renderedAllOnce = true; renderWorkspaces(); renderScreenWorkspaces(); renderWindows(); renderPowerMonitors(); renderLights(); renderSession(); return; }
  if (currentPage === 'inicio') { renderWorkspaces(); renderPowerMonitors(); renderLights(); renderSession(); }
  else if (currentPage === 'janelas') { renderWorkspaces(); renderWindows(); }
  else if (currentPage === 'tela') renderScreenWorkspaces();
  if (currentPage === 'inicio') { loadStartProjects(); renderFleet(); loadFleet(); }
}
// Omarchy lives on numbered workspaces (Super+1…0). The screen gets the same
// row: the workspace the streamed monitor shows is lit, a dot marks the ones
// with windows, and a tap is Super+N with the stream following.
function renderScreenWorkspaces() {
  const monitor = selectedMonitor();
  const active = monitor?.activeWorkspace ?? state?.activeWindow?.workspace?.id;
  const spaces = state?.workspaces || [];
  const ids = workspaceDropTargetIds(spaces, active);
  const signature = JSON.stringify([ids, active, spaces.map(ws => [ws.id, ws.windows]), i18n.language]);
  if (screenWorkspaceSignature === signature) return;
  screenWorkspaceSignature = signature;
  $('#screen-workspaces').innerHTML = ids.map(id => {
    const ws = spaces.find(item => Number(item.id) === id);
    const windows = Number(ws?.windows || 0);
    return `<button type="button" class="screen-workspace ${id === active ? 'active' : ''}" data-screen-workspace="${id}" aria-label="${escaped(i18n.plural('Ir para área {workspace}, {count} janela','Ir para área {workspace}, {count} janelas',windows,{workspace:id}))}" ${id === active ? 'aria-current="true"' : ''}>${id}${windows ? '<i aria-hidden="true"></i>' : ''}</button>`;
  }).join('');
}
$('#screen-workspaces').addEventListener('click', async event => {
  const chip = event.target.closest('[data-screen-workspace]');
  if (!chip || !connected) return;
  const id = Number(chip.dataset.screenWorkspace);
  const target = (state?.workspaces || []).find(ws => Number(ws.id) === id);
  const select = $('#monitor-select');
  // A workspace that lives on another monitor: follow it there, like the eye
  // follows Super+N across monitors.
  if (target?.monitor && target.monitor !== select.value && (state?.monitors || []).some(m => m.name === target.monitor)) {
    select.value = target.monitor; select.dispatchEvent(new CustomEvent('change'));
  }
  const ok = await action('workspace.focus', { id, monitor: select.value || undefined }, t('Área {workspace} em foco.',{workspace:id}));
  if (ok) renderScreenWorkspaces();
});

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
  if (!['inicio','tela','terminais','dev','janelas','voz'].includes(page)) return;
  const wasScreen = isScreenPage(currentPage), nextScreen = isScreenPage(page);
  if (currentPage !== page) resetRemoteInput();
  if (wasScreen && !nextScreen) leaveScreen();
  if (nextScreen && !wasScreen) liveWanted = true;
  setPageLocation(page);
  $$('.page').forEach(element => { element.hidden = element.dataset.page !== page; });
  if (!nextScreen) closeScreenComposer();
  renderVisiblePage();
  window.scrollTo({top:0,behavior:'instant'});
  if (page === 'voz' && connected) loadAudio();
  reconcileLive();
  updateTerminalNavigation();
  updateDevNavigation();
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
  // Only the IME shrinks the viewport this much. Do not require a focused
  // field: the native keyboard request can land while focus is still moving,
  // and a layout computed for "no keyboard" then puts the bar off-screen.
  const keyboardOpen = viewportBaseline.height - height > 100;
  document.body.setAttribute('data-keyboard-open',String(keyboardOpen));
  document.body.setAttribute('data-screen-keyboard',String(keyboardOpen && screenComposerOpen()));
  // The typing bar's height is what the monitor must leave free above it.
  const composer = $('#screen-composer');
  document.documentElement.style.setProperty('--screen-composer-h',`${composer && !composer.hidden ? (composer.offsetHeight || 60) : 0}px`);
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
    const lightsType = /^(power\.(sleep|wake)|lights\.(preset|sleep|restore))$/.test(type);
    runBusy(generic, () => (lightsType ? lightsAction : action)(type, payload, feedback));
  }
  const key = event.target.closest('[data-key]');
  if (key && key.closest('#screen-key-row')) sendKeys(async () => { if (!(await quietAction('keyboard.key',{key:key.dataset.key}))) toast(t("A tecla não chegou ao PC."), true); });
  else if (key) action('keyboard.key',{key:key.dataset.key});
  const workspace = event.target.closest('[data-workspace]');
  if (workspace) action('workspace.focus',{id:Number(workspace.dataset.workspace)}, t('Área {workspace} em foco.',{workspace:workspace.textContent.trim()}));
  const filter = event.target.closest('[data-filter]');
  if (filter) { chosenWorkspace = filter.dataset.filter; renderWorkspaces(); renderWindows(); }
  const windowButton = event.target.closest('[data-window]');
  if (windowButton) action('window.focus',{address:windowButton.dataset.window}, t("Janela em foco no PC."));
});

$('.brand').addEventListener('click', event => { event.preventDefault(); if(token) navigate('inicio'); });
// No password, ever. A device on the owner's tailnet is authenticated by the
// Tailscale daemon; the server hands it the token automatically. There is no
// key to type — the only control here is to try connecting again.
async function connectOverTailscale() {
  $('#pair-error').hidden = true;
  $('#pair-retry').hidden = true;
  i18n.write($('#pair-status'), t("Conectando ao seu PC pela rede Tailscale…"));
  if (await autoPair()) { enterApp('tela'); toast(t("Conectado pela sua rede Tailscale.")); return; }
  i18n.write($('#pair-status'), t("Não achei seu PC. Confira que os dois estão no mesmo Tailscale e que o PC está ligado."));
  $('#pair-retry').hidden = false;
}
$('#pair-retry').addEventListener('click', connectOverTailscale);
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
let screenStyledSize = '', screenImageMonitor = '';
let screenMaxScale = 6;
let screenSourceSize = '';
// What shows the monitor: the JPEG frames' <img>, or the canvas the H.264
// video draws on. Zoom, pan and touch mapping read whichever is on screen.
let screenCanvasOn = false;
const screenSurface = () => screenCanvasOn ? $('#screen-video') : $('#screen-image');
function screenNaturalSize() {
  const surface = screenSurface();
  return screenCanvasOn ? { w: surface.width, h: surface.height } : { w: surface.naturalWidth, h: surface.naturalHeight };
}
let liveRegionTimer = 0;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const LONG_PRESS_MS = 500;
const REGION_RECONNECT_PX = 8;
// A fingertip never lands as a mathematically fixed point. At phone scale,
// 12 CSS px was small enough for ordinary taps to vanish as fake pans.
const SCREEN_GESTURE_SLOP = 24;
// Hold one finger still this long, then drag another: the wheel scrolls under
// the held finger. A pinch lands both fingers together, well under this.
const ANCHOR_SCROLL_MS = 250;

class MjpegParser {
  constructor(onFrame,boundary = 'ponte-frame') {
    this.onFrame = onFrame;
    this.boundary = boundary;
    this.header = new Uint8Array(8192);
    this.headerLength = 0;
    this.frame = null;
    this.frameOffset = 0;
    this.timestamp = null;
    this.captureMs = null;
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
          this.onFrame(frame,this.timestamp,this.captureMs);
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
      const capture = /^X-Capture-Ms:\s*(\d+)\s*$/mi.exec(header);
      this.captureMs = capture ? Number(capture[1]) : null;
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

// Adaptive quality. The PC paces frames at the requested rate and only slows
// down when the phone cannot drain them, so the rate that actually arrives is
// the link's honest capacity: ~49 Mbit/s for Sharp, ~7 for Balanced, ~2 for
// Light on a 1440p monitor. Auto climbs while frames arrive on time and steps
// down as soon as they lag, holding longer after each fall so the picture does
// not flap on a mobile link. "On time" is against what the PC can capture:
// grim scales on the CPU, so on a 3440×1440 monitor Balanced takes ~140 ms a
// frame and can never reach its 10 fps even on a LAN. That is not the link,
// and it must not keep Auto away from Sharp (18 ms a frame).
const LIVE_LADDER = ['light','balanced','sharp'];
// Where Auto opens. Climbing from Light took ~12 s to reach Sharp, and every
// monitor switch (a workspace on another monitor) or return from the
// background is a new session: the picture was unreadable each time. A slow
// link shows itself in the first 3 s window, so a session opens where the last
// one on this PC settled, or at Sharp when there is none from the last 30 min.
const LIVE_RUNG_TTL_MS = 30 * 60000;
function liveStartRung(saved, at) {
  const [rung, when] = String(saved || '').split('|');
  return LIVE_LADDER.includes(rung) && at - Number(when) >= 0 && at - Number(when) < LIVE_RUNG_TTL_MS ? rung : 'sharp';
}
// Auto with the video: what matters is reading the terminal when zoomed in.
// Below the monitor's own width the video is never readable (a 3440 monitor
// sent at 1920 px is as soft as Balanced), while the JPEG Sharp frame is, even
// at one frame a second. So a video held under the native width for longer
// than the WAN opening needs to climb hands over to JPEG Sharp; back on the
// video only after two JPEG windows showing room for a native step (8 Mbit/s,
// twice W4), and no sooner than a wait that doubles on every hand-over (20 s
// up to 5 min) and resets once the native picture held a minute.
// The JPEG window counts only the time spent sending: a PC whose grim takes
// most of the second would otherwise read as a slow link and never let the
// video back. The capture time comes from X-Capture-Ms and is capped at two
// thirds of the window, so a stale header cannot make a slow link look roomy.
function jpegLinkKbps(bytes, elapsedMs, captureMs) {
  return bytes * 8 / Math.max(elapsedMs - (captureMs || 0), elapsedMs / 3, 1);
}
const AUTO_SOFT_GRACE_MS = 8000, AUTO_RETURN_KBPS = 8000, AUTO_RETURN_WINDOWS = 2;
const AUTO_RETRY_MS = 20000, AUTO_RETRY_MAX_MS = 5 * 60000, AUTO_NATIVE_HELD_MS = 60000;
function createAutoChooser({ now = Date.now } = {}) {
  let mode = 'video', wait = AUTO_RETRY_MS, retryAt = 0, softSince = null, nativeSince = null, good = 0;
  return {
    get mode() { return mode; },
    // A video run starts: its first frames say nothing about the last one.
    start() { softSince = null; nativeSince = null; },
    // Each video frame: native when the encoder sends the monitor's full width.
    video(native) {
      const t = now();
      if (native) {
        softSince = null; if (nativeSince === null) nativeSince = t;
        if (t - nativeSince >= AUTO_NATIVE_HELD_MS) wait = AUTO_RETRY_MS;
        return null;
      }
      nativeSince = null; if (softSince === null) softSince = t;
      if (t - softSince < AUTO_SOFT_GRACE_MS) return null;
      mode = 'jpeg'; softSince = null; good = 0;
      retryAt = t + wait; wait = Math.min(AUTO_RETRY_MAX_MS, wait * 2);
      return 'jpeg';
    },
    // Each JPEG window (about 3 s): the kbps that arrived.
    jpeg(kbps) {
      if (mode !== 'jpeg') return null;
      good = kbps >= AUTO_RETURN_KBPS ? good + 1 : 0;
      if (good < AUTO_RETURN_WINDOWS || now() < retryAt) return null;
      mode = 'video'; good = 0;
      return 'video';
    },
  };
}
function createLiveAdapter({start = 'light', windowMs = 3000, climbAfter = 2, holdMs = 20000, maxHoldMs = 120000, now = Date.now} = {}) {
  let rung = Math.max(0, LIVE_LADDER.indexOf(start));
  let frames = 0, captureTotal = 0, captured = 0, windowStart = now(), healthy = 0, holdUntil = 0, hold = holdMs;
  function drop(at) {
    healthy = 0;
    if (rung === 0) return null;
    rung -= 1;
    holdUntil = at + hold;
    hold = Math.min(maxHoldMs, hold * 2);
    return LIVE_LADDER[rung];
  }
  return {
    get profile() { return LIVE_LADDER[rung]; },
    // captureMs: what the PC said this frame took to capture (older PCs say nothing).
    frame(captureMs) { frames += 1; if (Number.isFinite(captureMs) && captureMs > 0) { captureTotal += captureMs; captured += 1; } },
    // A stream that broke or stalled is treated as one lagging window.
    stall() { return drop(now()); },
    // Called about once a second; answers the new profile key on a change.
    evaluate(requestedFps) {
      const at = now();
      const elapsed = at - windowStart;
      if (elapsed < windowMs) return null;
      const captureFps = captured ? 1000 * captured / captureTotal : Infinity;
      const ratio = frames * 1000 / elapsed / Math.min(requestedFps, captureFps);
      frames = 0; captureTotal = 0; captured = 0; windowStart = at;
      // A window far longer than planned means the page was throttled or
      // paused, not that the link was slow: measure again from here.
      if (elapsed > windowMs * 2) return null;
      if (ratio < 0.6) return drop(at);
      if (ratio < 0.9) { healthy = 0; return null; }
      healthy += 1;
      if (healthy < climbAfter || rung === LIVE_LADDER.length - 1 || at < holdUntil) return null;
      healthy = 0; rung += 1;
      return LIVE_LADDER[rung];
    },
  };
}
const liveRungKey = () => targetNode ? `ponte-live-rung:${targetNode}` : 'ponte-live-rung';
function newLiveAdapter() { return createLiveAdapter({ start: liveStartRung(savedPreference(liveRungKey()), Date.now()) }); }
function applyLiveProfile(session, key) {
  const profile = LIVE_PROFILES[key];
  if (session.adapter) savePreference(liveRungKey(), `${key}|${Date.now()}`);
  session.fps = profile.fps; session.scale = profile.scale; session.quality = profile.quality;
  session.profileLabel = session.adapter ? `${t('Automático')} · ${t(profile.label)}` : profile.label;
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

function workspaceDropTargetIds(workspaces, currentId) {
  // Omarchy exposes ten numbered workspaces by default. Keep the familiar
  // first five reachable even while empty, then append every live numbered
  // workspace reported by Hyprland. The shelf scrolls if a custom setup has
  // more, while special workspaces and unsafe IDs stay out of the interface.
  const ids = new Set([1, 2, 3, 4, 5]);
  for (const item of workspaces || []) {
    const id = Number(item?.id);
    if (Number.isInteger(id) && id >= 1 && id <= 100) ids.add(id);
  }
  if (Number.isInteger(currentId) && currentId >= 1 && currentId <= 100) ids.add(currentId);
  return [...ids].sort((a, b) => a - b);
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
  const image = screenSurface();
  const natural = screenNaturalSize();
  // The image carries a CSS transform, so its on-screen box (getBoundingClientRect)
  // already includes zoom and pan; touch mapping uses those real dimensions.
  const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
  return {
    previewWidth: preview.clientWidth || 390,
    previewHeight: preview.clientHeight || 300,
    scrollLeft: 0,
    scrollTop: 0,
    imageWidth: rect.width || screenBaseW * screenScale || natural.w || 0,
    imageHeight: rect.height || screenBaseH * screenScale || natural.h || 0,
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
  const natural = screenNaturalSize();
  const { w: pw, h: ph } = screenPreviewSize();
  const nw = natural.w || 16, nh = natural.h || 9;
  const ratio = nw / nh;
  let w = pw, h = pw / ratio;
  if (h > ph) { h = ph; w = ph * ratio; }
  screenBaseW = w; screenBaseH = h;
  // Allow zooming a little past native 1:1 so text stays legible. A lighter
  // stream profile still gets 4x: blurry is fine when the point is to land a
  // finger on a small target, and the auto profile sharpens the frame in place.
  screenMaxScale = Math.max(4, Math.min(8, (nw / (w || 1)) * 1.3));
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
  const image = screenSurface();
  if (!screenBaseW) computeScreenBase();
  // Size styles trigger layout; only rewrite them when the fitted size changed.
  // The transform alone is handled by the compositor.
  const sizeKey = `${Math.round(screenBaseW)}x${Math.round(screenBaseH)}`;
  if (screenStyledSize !== sizeKey) {
    screenStyledSize = sizeKey;
    image.style.position = 'absolute'; image.style.left = '0'; image.style.top = '0';
    image.style.maxWidth = 'none'; image.style.maxHeight = 'none';
    image.style.width = `${Math.round(screenBaseW)}px`;
    image.style.height = `${Math.round(screenBaseH)}px`;
    image.style.transformOrigin = '0 0';
  }
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
function sourceAspect(size) {
  const [w, h] = String(size || '').split('x').map(Number);
  return w > 0 && h > 0 ? w / h : 0;
}
function nativeScreenScale() {
  return (screenNaturalSize().w || screenBaseW) / (screenBaseW || 1);
}
function sendMonitorClick(pixel, button) {
  const monitor = selectedMonitor();
  if (!pixel || !monitor || !connected || !state?.capabilities?.mouse) return false;
  return action('mouse.clickAt', { monitor: monitor.name, x: pixel.x, y: pixel.y, button });
}
// A left tap also asks for the text-input baseline: the input context focused
// on the PC right before the click, and whether the click changed the active
// window. Resolves to { before, windowChanged } (before undefined when the PC
// could not tell: older server, no fcitx), or false when the click failed.
async function sendMonitorTap(pixel) {
  const monitor = selectedMonitor();
  if (!pixel || !monitor || !connected || !state?.capabilities?.mouse) return false;
  const result = await actionResult('mouse.clickAt', { monitor: monitor.name, x: pixel.x, y: pixel.y, button: 'left', textBaseline: true });
  if (!result) return false;
  const known = Object.prototype.hasOwnProperty.call(result, 'textBefore');
  return { before: known ? result.textBefore : undefined, windowChanged: known ? result.windowChanged !== false : true };
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
  const image = $('#screen-image');
  image.src = url;
  // Per-frame DOM work stays at the src swap: labels only change with the
  // monitor, and geometry is handled by the load handler when the size changes.
  if (screenImageMonitor !== monitor) { screenImageMonitor = monitor; image.alt = t('Monitor {monitor}',{monitor}); $('#viewer-monitor-name').textContent = monitor; }
  if (image.hidden) { image.hidden = false; $('#screen-empty').hidden = true; }
  if (oldURL) URL.revokeObjectURL(oldURL);
}
function clearScreenImage() {
  if (screenshotURL) URL.revokeObjectURL(screenshotURL);
  showVideoCanvas(false); $('#screen-video').hidden = true;
  screenshotURL = null; lastScreenTimestamp = null; screenZoomed = false; screenScale = 1; screenPanX = screenPanY = 0; screenBaseW = screenBaseH = 0; screenImageMonitor = '';
  // Also forget the tracked source/styled sizes: otherwise switching to a
  // different monitor of the SAME resolution string skips the load-handler
  // recompute and draws the new frame at the previous fit.
  screenSourceSize = ''; screenStyledSize = '';
  $('#screen-image').removeAttribute('src'); $('#screen-image').hidden = true; $('#screen-empty').hidden = false;
  $('#screen-stage').classList.remove('zoomed'); updateScreenButtons();
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
function leaveScreen() { resetRemoteInput(); stopLive(); cancelSnapshot(); closeScreenComposer(); markTextFocus(false); if (landscapeForced) requestOrientation('auto'); }
async function screenResponse(path,controller) {
  const requestToken = token;
  let response;
  try { response = await fetch(apiUrl(path),{headers:{'Accept-Language':i18n.locale,Authorization:`Bearer ${requestToken}`},signal:controller.signal,cache:'no-store'}); }
  catch (error) { if (error instanceof TypeError) throw new Error(t('Sem resposta do PC. Confira o Tailscale e a conexão.')); throw error; }
  if (!response.ok) {
    let message = t("Não foi possível abrir o monitor.");
    let details;
    try { details = await response.json(); message = details.error || message; } catch {}
    if (response.status === 401 && token === requestToken) {
      stopLive(); token = ''; connected = false;
      try { localStorage.removeItem(storageKey); } catch {}
      showPairing(); connectOverTailscale();
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
      // The status pass rewrites a dozen nodes; once live it only matters on change.
      if (screenMode !== 'live') setScreenStatus('live');
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
      if (sessionIsCurrent(session) && Date.now()-session.lastReceived > 6000 && screenMode === 'live') setScreenStatus('reconnecting',t("Aguardando novos quadros do monitor…"));
      if (sessionIsCurrent(session) && Date.now()-session.lastReceived > 18000) { session.error = new Error(t("O monitor ficou sem enviar imagens.")); session.controller.abort(); }
      // Switching profile is a refresh: the stream reopens with new parameters
      // and keeps the last frame on screen instead of showing "reconnecting".
      const next = sessionIsCurrent(session) && session.receiving && session.attempt === attempt ? session.adapter?.evaluate(session.fps) : null;
      if (next) { applyLiveProfile(session, next); session.refreshing = true; session.controller.abort(); }
      // Handed over from the video: back to it once the JPEG frames show the link has room.
      if (session.legible && sessionIsCurrent(session) && session.receiving && session.attempt === attempt && Date.now() - session.windowAt >= 3000) {
        const kbps = jpegLinkKbps(session.windowBytes, Date.now() - session.windowAt, session.windowCapture);
        session.windowAt = Date.now(); session.windowBytes = 0; session.windowCapture = 0;
        if (autoChooser.jpeg(kbps) === 'video') setTimeout(() => { if (sessionIsCurrent(session)) startLive(); }, 0);
      }
    },1000);
    try {
      const response = await screenResponse(liveStreamPath(session),session.controller);
      if (!sessionIsCurrent(session)) return;
      const contentType = response.headers.get('content-type') || '';
      if (!/^multipart\/x-mixed-replace\b/i.test(contentType)) throw Object.assign(new Error(t("O PC não ofereceu uma transmissão compatível.")),{status:415});
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
      if (!boundary || !response.body) throw new Error(t("Resposta de transmissão incompleta."));
      session.receiving = true;
      session.windowAt = Date.now(); session.windowBytes = 0; session.windowCapture = 0;
      const parser = new MjpegParser((bytes,timestamp,captureMs) => {
        if (!sessionIsCurrent(session) || session.attempt !== attempt) return;
        session.windowBytes += bytes.length;
        if (Number.isFinite(captureMs) && captureMs > 0) session.windowCapture += captureMs;
        session.adapter?.frame(captureMs);
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
      // The PC restarting or a mobile hand-over used to end the stream after
      // five misses, leaving a still frame with no way back but leaving the
      // page. While the screen is open, keep trying at a gentle pace instead.
      const lighter = session.adapter?.stall();
      if (lighter) applyLiveProfile(session, lighter);
      const delay = Math.min(5000,1000*2**Math.min(session.failures-1,3));
      session.retryDelay = delay;
      setScreenStatus('reconnecting',t('{message} Tentando novamente em {seconds}s.',{message:t(session.error?.message || 'Conexão interrompida.'),seconds:delay/1000}));
      await new Promise(resolve => { session.cancelRetry = resolve; session.retryTimer = setTimeout(resolve,delay); });
      session.cancelRetry = null;
    } finally { clearInterval(session.watchdog); }
  }
}
// ---- native video: H.264 over /api/rd -------------------------------------
// The PC encodes the monitor at its own resolution, up to 60 fps, on the GPU
// (the same stream the computers get); the phone decodes it in hardware with
// WebCodecs and draws it on a canvas that zooms and pans like the JPEG frames.
// Touches still go through the desktop actions. JPEG stays the fallback: no
// WebCodecs, a PC without the video, or another device holding it.
const VIDEO_HEADER_BYTES = 16;
// A socket that has not even opened in VIDEO_OPEN_MS is a link that does not
// carry it (a proxy holding the upgrade): the JPEG frames should not wait the
// full VIDEO_FIRST_FRAME_MS, which is for an encoder that is starting.
const VIDEO_ACK_MS = 50, VIDEO_KEYFRAME_ASK_MS = 3000, VIDEO_OPEN_MS = 3000, VIDEO_FIRST_FRAME_MS = 9000, VIDEO_RETRIES = 3;
let videoBlockedUntil = 0;
const autoChooser = createAutoChooser();
const videoSupported = () => typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function' && typeof WebSocket === 'function';
function videoSocketUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${apiUrl('/rd')}`;
}
function parseVideoUnit(buffer, littleEndian) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= VIDEO_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1) return null;
  return { key: (view.getUint8(1) & 1) === 1, seq: view.getUint32(4, littleEndian), data: new Uint8Array(buffer, VIDEO_HEADER_BYTES) };
}
// The header's byte order is not fixed: a send time that is only a plausible epoch in little endian says so.
function videoLittleEndian(buffer) {
  const view = new DataView(buffer), now = Date.now();
  const plausible = ms => Number.isFinite(ms) && Math.abs(ms - now) < 864e5;
  return !plausible(view.getFloat64(8, false)) && plausible(view.getFloat64(8, true));
}
function showVideoCanvas(on) {
  if (screenCanvasOn === on) return;
  screenCanvasOn = on;
  $('#screen-video').hidden = !on;
  $('#screen-image').hidden = on || !$('#screen-image').getAttribute('src');
  if (on) $('#screen-empty').hidden = true;
  screenSourceSize = ''; screenStyledSize = '';
}
function startVideoLive(session) {
  session.kind = 'video';
  session.controller = new AbortController();
  const video = { socket: null, opened: false, decoder: null, config: null, littleEndian: null, waitingKey: true, link: 'lan', fps: 60,
    ackSeq: 0, ackSent: 0, ackTimer: 0, lastAckAt: -Infinity, keyAskedAt: -Infinity, drawn: 0, bytes: 0, drops: 0, rtt: null, statsAt: performance.now(), retries: 0 };
  session.video = video;
  // Only Auto trades the video for a sharper JPEG; Native is the person's choice.
  const auto = !!LIVE_PROFILES[$('#live-quality').value]?.auto;
  if (auto) autoChooser.start();
  const current = () => sessionIsCurrent(session) && session.video === video;
  const send = message => { if (video.socket?.readyState === 1) video.socket.send(JSON.stringify(message)); };
  const fallBack = (reason, blockMs = 0) => {
    if (!current()) return;
    if (blockMs) videoBlockedUntil = Date.now() + blockMs;
    teardown();
    session.video = null;
    if (reason) toast(reason);
    startJpegLive(session);
  };
  // The video stayed under the monitor's width: JPEG Sharp until the link shows room.
  const handOver = () => {
    if (!current()) return;
    teardown();
    session.video = null;
    startJpegLive(session, true);
  };
  function teardown() {
    clearTimeout(video.ackTimer); clearInterval(session.watchdog); clearTimeout(session.retryTimer);
    const socket = video.socket; video.socket = null;
    if (socket) { try { socket.close(1000); } catch {} }
    if (video.decoder && video.decoder.state !== 'closed') { try { video.decoder.close(); } catch {} }
    video.decoder = null;
  }
  session.controller.signal.addEventListener('abort', teardown, { once: true });
  function sendAck() {
    video.ackTimer = 0;
    if (video.ackSeq === video.ackSent) return;
    video.lastAckAt = performance.now(); video.ackSent = video.ackSeq;
    send({ t: 'ack', seq: video.ackSeq });
  }
  function acknowledge(seq) {
    if (!(seq > video.ackSeq)) return;
    video.ackSeq = seq;
    if (video.ackTimer) return;
    const wait = video.lastAckAt + VIDEO_ACK_MS - performance.now();
    if (wait <= 0) sendAck(); else video.ackTimer = setTimeout(sendAck, wait);
  }
  function askKeyframe() {
    const now = performance.now();
    if (now - video.keyAskedAt < VIDEO_KEYFRAME_ASK_MS) return;
    video.keyAskedAt = now;
    send({ t: 'keyframe' });
  }
  async function configure(codec) {
    const base = { codec, optimizeForLatency: true };
    let config = { ...base, hardwareAcceleration: 'prefer-hardware' };
    try { if (!(await VideoDecoder.isConfigSupported(config)).supported) config = { ...base, hardwareAcceleration: 'no-preference' }; }
    catch { config = { ...base, hardwareAcceleration: 'no-preference' }; }
    try { if (!(await VideoDecoder.isConfigSupported(config)).supported) { fallBack(t('Este aparelho não decodifica o vídeo do PC. Usando imagens.'), 10 * 60000); return; } }
    catch { fallBack(t('Este aparelho não decodifica o vídeo do PC. Usando imagens.'), 10 * 60000); return; }
    if (!current()) return;
    if (video.decoder && video.decoder.state !== 'closed') { try { video.decoder.close(); } catch {} }
    const decoder = new VideoDecoder({
      output: frame => { if (current() && video.decoder === decoder) draw(frame); else frame.close(); },
      error: () => { if (video.decoder !== decoder) return; video.decoder = null; video.waitingKey = true; askKeyframe(); if (current() && video.config) configure(video.config.codec); },
    });
    decoder.configure(config);
    video.decoder = decoder; video.config = config; video.waitingKey = true;
  }
  function draw(frame) {
    const canvas = $('#screen-video');
    const width = frame.displayWidth, height = frame.displayHeight;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; video.context = null; }
    if (!video.context) video.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    video.context.drawImage(frame, 0, 0, width, height);
    frame.close();
    video.drawn++;
    const first = !screenCanvasOn;
    showVideoCanvas(true);
    if (first || screenSourceSize !== `${width}x${height}`) screenSourceResized(`${width}x${height}`);
    lastScreenTimestamp = Date.now();
    session.lastReceived = Date.now(); session.hasFrame = true; session.failures = 0; video.retries = 0;
    if (screenImageMonitor !== session.monitor) { screenImageMonitor = session.monitor; $('#viewer-monitor-name').textContent = session.monitor; }
    if (screenMode !== 'live') setScreenStatus('live');
    if (auto && autoChooser.video(video.native) === 'jpeg') setTimeout(handOver, 0);
  }
  function unit(buffer) {
    if (video.littleEndian === null && buffer.byteLength > VIDEO_HEADER_BYTES) video.littleEndian = videoLittleEndian(buffer);
    const chunk = parseVideoUnit(buffer, video.littleEndian);
    if (!chunk) return;
    video.bytes += buffer.byteLength;
    acknowledge(chunk.seq);
    const decoder = video.decoder;
    if (!decoder || decoder.state !== 'configured') { video.waitingKey = true; if (!chunk.key) { video.drops++; askKeyframe(); } return; }
    // A late frame is dropped until the next keyframe; outside the LAN frames arrive in bursts, so only a second of them is late.
    const limit = video.link === 'wan' ? Math.max(2, Math.round(video.fps)) : 2;
    const late = decoder.decodeQueueSize > limit;
    if (!chunk.key) {
      if (video.waitingKey || late) { video.waitingKey = true; video.drops++; askKeyframe(); return; }
    } else if (late) {
      video.drops += decoder.decodeQueueSize;
      decoder.reset(); decoder.configure(video.config);
    }
    video.waitingKey = false;
    decoder.decode(new EncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: chunk.seq, data: chunk.data }));
  }
  function message(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'ready') {
      video.fps = Number(m.fps) || video.fps;
      const resized = video.readyWidth !== m.width || video.readyHeight !== m.height;
      video.readyWidth = m.width; video.readyHeight = m.height;
      const monitor = Array.isArray(m.monitors) ? m.monitors.find(item => item && item.name === m.monitor) : null;
      video.native = !(Number(monitor?.width) > Number(m.width));
      if (!video.decoder || !video.config || video.config.codec !== m.codec || resized) configure(m.codec || 'avc1.640034');
      else video.waitingKey = true;
    } else if (m.t === 'link') video.link = m.mode === 'wan' ? 'wan' : 'lan';
    else if (m.t === 'pong' && typeof m.c === 'number') video.rtt = Date.now() - m.c;
    // Another device took the video (the notebook's remote desktop): leave it there.
    else if (m.t === 'taken') fallBack(t('Outro aparelho está com o vídeo deste PC. Usando imagens.'), 60000);
    else if (m.t === 'error') fallBack('', 5 * 60000);
  }
  function connect() {
    const socket = new WebSocket(videoSocketUrl());
    socket.binaryType = 'arraybuffer';
    video.socket = socket;
    video.littleEndian = null; video.ackSeq = 0; video.ackSent = 0; video.waitingKey = true;
    socket.addEventListener('open', () => {
      if (video.socket !== socket) return;
      video.opened = true;
      send({ t: 'hello', v: 1, token, maxFps: 60, caps: { ack: true, key: true }, monitor: session.monitor, input: false });
      send({ t: 'ping', c: Date.now() });
    });
    socket.addEventListener('message', event => { if (video.socket !== socket || !current()) return; if (typeof event.data === 'string') message(event.data); else unit(event.data); });
    socket.addEventListener('close', () => {
      if (video.socket !== socket || !current()) return;
      video.socket = null;
      // Never drew: this PC or this link does not carry the video; the JPEG frames do.
      if (!video.drawn) { fallBack('', 5 * 60000); return; }
      if (++video.retries > VIDEO_RETRIES) { fallBack(''); return; }
      const delay = 1000 * video.retries;
      session.retryDelay = delay;
      setScreenStatus('reconnecting', t('{message} Tentando novamente em {seconds}s.', { message: t('Conexão interrompida.'), seconds: delay / 1000 }));
      session.retryTimer = setTimeout(() => { if (current()) connect(); }, delay);
    });
  }
  session.lastReceived = Date.now();
  const startedAt = Date.now();
  setScreenStatus('connecting');
  session.watchdog = setInterval(() => {
    if (!current()) return;
    const now = performance.now(), elapsed = (now - video.statsAt) / 1000;
    video.statsAt = now;
    send({ t: 'ping', c: Date.now() });
    send({ t: 'stats', fps: Math.round(video.drawn / elapsed), kbps: Math.round(video.bytes * 8 / 1000 / elapsed), rtt: video.rtt, queue: video.decoder?.decodeQueueSize || 0, drops: video.drops });
    video.drawn = 0; video.bytes = 0; video.drops = 0;
    if (!session.hasFrame && Date.now() - startedAt > (video.opened ? VIDEO_FIRST_FRAME_MS : VIDEO_OPEN_MS)) { fallBack('', 5 * 60000); return; }
    if (session.hasFrame && Date.now() - session.lastReceived > 6000 && screenMode === 'live') setScreenStatus('reconnecting', t("Aguardando novos quadros do monitor…"));
  }, 1000);
  connect();
}
// sharp: Auto handed over from a video under the native width (or is still
// waiting to go back to it): JPEG Sharp at whatever rate the link carries.
function startJpegLive(session, sharp = false) {
  session.kind = 'jpeg';
  showVideoCanvas(false);
  const choice = LIVE_PROFILES[$('#live-quality').value] ? $('#live-quality').value : 'auto';
  if (sharp) { session.adapter = null; session.legible = true; applyLiveProfile(session, 'sharp'); session.profileLabel = `${t('Automático')} · ${t(LIVE_PROFILES.sharp.label)}`; }
  else if (LIVE_PROFILES[choice].auto || LIVE_PROFILES[choice].video) { session.adapter = newLiveAdapter(); applyLiveProfile(session, session.adapter.profile); }
  else applyLiveProfile(session, choice);
  runLiveSession(session);
}
function startLive() {
  if (!screenIsVisible() || !connected || !state?.capabilities?.live) { toast(t("Transmissão indisponível. Confira a conexão com o PC."),true); return; }
  const monitor = $('#monitor-select').value;
  if (!monitor) return;
  stopLive(); cancelSnapshot();
  const choice = LIVE_PROFILES[$('#live-quality').value] ? $('#live-quality').value : 'auto';
  const wantsVideo = (LIVE_PROFILES[choice].auto || LIVE_PROFILES[choice].video) && videoSupported() && Date.now() >= videoBlockedUntil;
  if (wantsVideo && LIVE_PROFILES[choice].auto && autoChooser.mode === 'jpeg') {
    const session = {monitor,attempt:0,failures:0,hasFrame:false,rendering:false,pendingFrame:null,region:null,refreshing:false,adapter:null};
    liveSession = session;
    startJpegLive(session, true);
    return;
  }
  if (wantsVideo) {
    const session = {monitor,attempt:0,failures:0,hasFrame:false,rendering:false,pendingFrame:null,region:null,refreshing:false,adapter:null,profileLabel:'Nativo · vídeo até 60 quadros/s'};
    liveSession = session;
    startVideoLive(session);
    return;
  }
  const session = {monitor,attempt:0,failures:0,hasFrame:false,rendering:false,pendingFrame:null,region:null,refreshing:false,adapter:null};
  if (LIVE_PROFILES[choice].auto) { session.adapter = newLiveAdapter(); applyLiveProfile(session, session.adapter.profile); }
  else applyLiveProfile(session, choice);
  liveSession = session;
  runLiveSession(session);
}
$('#monitor-select').addEventListener('change',() => {
  const restart = !!liveSession || liveWanted;
  savePreference(monitorKey(),$('#monitor-select').value);
  screenScale = 1; screenPanX = screenPanY = 0;
  stopLive(); cancelSnapshot(); clearScreenImage();
  $('#viewer-monitor-name').textContent = $('#monitor-select').value || t("Monitor do PC");
  setScreenStatus('idle');
  if (restart) startLive();
});
// grim scales on the CPU, so the sharp profile streams native pixels at a
// lower JPEG quality and is both faster and crisper than a downscaled frame.
// q40 is ~10% smaller than q50 on a desktop with the same look (PSNR -1 dB).
const LIVE_PROFILES = {
  auto:{auto:true,label:'Automático'},
  native:{video:true,label:'Nativo · vídeo até 60 quadros/s'},
  sharp:{fps:15,scale:1,quality:40,label:'Nítido · até 15 quadros/s'},
  balanced:{fps:10,scale:0.5,quality:65,label:'Equilibrado · até 10 quadros/s'},
  light:{fps:8,scale:0.35,quality:55,label:'Leve · até 8 quadros/s'},
};
$('#live-quality').value = LIVE_PROFILES[savedPreference('ponte-quality','auto')] ? savedPreference('ponte-quality','auto') : 'auto';
$('#live-quality').addEventListener('change',() => { savePreference('ponte-quality',$('#live-quality').value); if (liveSession) startLive(); });
$('#screen-image').addEventListener('load',() => {
  const image = $('#screen-image');
  if (!screenCanvasOn) screenSourceResized(`${image.naturalWidth}x${image.naturalHeight}`);
});
function screenSourceResized(size) {
  // A new monitor/source resets zoom; live frames keep the current zoom & pan.
  // Measuring layout on every frame is what made the phone stutter, so the
  // base size is only recomputed when the source changed (viewport changes
  // arrive through syncRemoteViewport → applyScreenZoom).
  if (size !== screenSourceSize) {
    // The auto quality profile changes the frame resolution while the aspect
    // stays the same: that is the same monitor, so a pinch the user just made
    // must survive it. Only a different shape (another monitor) resets.
    const sameShape = sourceAspect(screenSourceSize) > 0 && Math.abs(sourceAspect(screenSourceSize) - sourceAspect(size)) < 0.01;
    screenSourceSize = size;
    computeScreenBase();
    if (sameShape) { screenScale = Math.max(1, Math.min(screenMaxScale, screenScale)); if (screenScale <= 1.001) { screenScale = 1; centerScreenPan(); } else clampScreenPan(); }
    else { screenScale = 1; screenPanX = screenPanY = 0; centerScreenPan(); }
    applyScreenTransform();
  }
  else if (!screenBaseW) applyScreenZoom();
}
window.addEventListener('resize',applyScreenZoom);
if (window.ResizeObserver) new window.ResizeObserver(applyScreenZoom).observe($('#screen-preview'));
const screenPointers = new Map();
const screenPreview = $('#screen-preview');
let pinchDistance = 0;
let pinchMid = null;
let scrollAt = null;
let screenGesture = { pinch: false, panned: false, twoFinger: false, moved: false, anchor: null };
const pointerDistance = () => { const [a,b] = [...screenPointers.values()]; return a && b ? Math.hypot(a.x-b.x,a.y-b.y) : 0; };
function imageLocalPoint(clientX, clientY) {
  const rect = screenSurface().getBoundingClientRect?.() || { left: 0, top: 0 };
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
  return !!await quietActionResult(type, payload);
}
async function quietActionResult(type, payload = {}) {
  if (!connected) return false;
  try {
    const response = await api('/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type,...payload}) });
    return await response.json();
  }
  catch { return false; }
}

// ---- Direct touch: the image is the monitor. One mode, phone gestures only.
// Tap = click. Long press then lift = right click. Long press then move = drag
// with the button held. Pinch = zoom. One finger while zoomed = pan. Two
// fingers together = scroll the PC (pan while zoomed). Hold one finger still,
// then drag another = scroll under the held finger, zoomed or not; it never
// clicks or drags.
const hold = { timer: null, held: false, dragging: false, semantic: false, lastMove: 0, lastLease: 0, generation: 0, windowAddress: '', capturePromise: null, workspaceId: null };
function clearHold() { clearTimeout(hold.timer); hold.timer = null; hold.held = false; }
function renderWorkspaceDropShelf(currentId) {
  const shelf = $('#workspace-drop-shelf');
  const ids = workspaceDropTargetIds(state?.workspaces, currentId);
  $('#workspace-drop-targets').innerHTML = ids.map(id => `<button type="button" role="option" class="workspace-drop-target ${id === currentId ? 'current' : ''}" data-drop-workspace="${id}" aria-selected="false" aria-label="${escaped(t('Mover janela para área {workspace}',{workspace:id}))}">${id}</button>`).join('');
  shelf.hidden = false;
  $('#screen-preview').classList.add('workspace-drop-active');
}
function hideWorkspaceDropShelf() {
  $('#workspace-drop-shelf').hidden = true;
  $('#screen-preview').classList.remove('workspace-drop-active');
  hold.workspaceId = null;
}
function workspaceDropTargetAt(clientX, clientY) {
  let selected = null;
  for (const target of $$('[data-drop-workspace]', $('#workspace-drop-targets'))) {
    const rect = target.getBoundingClientRect?.();
    const inside = rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    target.classList.toggle('active', inside);
    target.setAttribute('aria-selected', String(inside));
    if (inside && !target.classList.contains('current')) selected = Number(target.dataset.dropWorkspace);
  }
  hold.workspaceId = selected;
  return selected;
}
async function beginHoldDrag(pixel, semantic = true) {
  const monitor = selectedMonitor();
  if (hold.dragging || !monitor || !pixel || !connected || !state?.capabilities?.mouse) return;
  const generation = ++hold.generation;
  hold.dragging = true; hold.semantic = semantic; hold.lastLease = Date.now(); hold.windowAddress = '';
  $('#drag-indicator').hidden = false;
  if (semantic) renderWorkspaceDropShelf(state?.activeWindow?.workspace?.id);
  // Long-press drag = move the window (Super+drag in Hyprland); a plain
  // one-finger drag stays a mouse drag inside the window's contents.
  const capture = quietActionResult('mouse.dragStartAt', { monitor: monitor.name, x: pixel.x, y: pixel.y, ...(semantic ? { modifier: 'super' } : {}) });
  hold.capturePromise = capture;
  const result = await capture;
  if (generation !== hold.generation || !hold.dragging) return;
  if (!result) { endHoldDrag(); return; }
  if (semantic) {
    hold.windowAddress = result.window?.address || '';
    renderWorkspaceDropShelf(result.window?.workspace?.id);
  }
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
  if (!hold.dragging) { hideWorkspaceDropShelf(); return Promise.resolve(false); }
  hold.dragging = false; hold.semantic = false; hold.generation++;
  $('#drag-indicator').hidden = true;
  hideWorkspaceDropShelf();
  return connected ? quietAction('mouse.drag', { pressed: false }) : Promise.resolve(false);
}
// A brief ring where the finger landed, so the user sees which point became
// the click (the fingertip hides it) without looking for the PC cursor.
let tapMarkerTimer = 0;
function showTapMarker(clientX, clientY, kind) {
  const marker = $('#tap-marker');
  const rect = screenPreview.getBoundingClientRect?.() || { left: 0, top: 0 };
  marker.style.left = `${clientX - rect.left}px`; marker.style.top = `${clientY - rect.top}px`;
  marker.setAttribute('data-kind', kind);
  marker.hidden = false; marker.classList.remove('show'); void marker.offsetWidth; marker.classList.add('show');
  clearTimeout(tapMarkerTimer); tapMarkerTimer = setTimeout(() => { marker.hidden = true; marker.classList.remove('show'); }, 450);
}
function resetScreenGesture() {
  clearHold();
  const ids = [...screenPointers.keys()];
  screenPointers.clear();
  for (const id of ids) { if (screenPreview.hasPointerCapture?.(id)) screenPreview.releasePointerCapture(id); }
  screenGesture = { pinch: false, panned: false, twoFinger: false, moved: false, anchor: null };
  pinchMid = null; pinchDistance = 0; scrollAt = null;
  endHoldDrag();
}
// The next scroll request carries this point once, so the PC moves its pointer
// there and the wheel reaches the window under the finger.
function anchorScroll(pixel) {
  const monitor = selectedMonitor();
  scrollAt = monitor && pixel ? { monitor: monitor.name, x: pixel.x, y: pixel.y } : null;
}
function queueScroll(dy) {
  if (!connected || !state?.capabilities?.mouse) return;
  // Direct touch: the content follows the finger. A finger moving up shows
  // later text (wheel down, negative REL_WHEEL through ydotool).
  moveQueue.scroll += dy / 7;
  if (!movementTimer) movementTimer = setInterval(flushMovement,35);
}
function stopPointerMoves() {
  clearInterval(movementTimer); movementTimer = null;
  flushMovement();
}
screenPreview.addEventListener('pointerdown',event => {
  if (!screenshotURL || event.target.closest('button')) return;
  if (event.button > 0) return;
  // A still frame is not the PC: clicking on it would land on whatever the
  // desktop shows now. Use the tap to bring the stream back instead.
  if (screenMode !== 'live') {
    event.preventDefault?.();
    if (!liveSession) { liveWanted = true; startLive(); }
    toast(t("A imagem está parada. Reconectando ao monitor…"));
    return;
  }
  // Keeping default focus behaviour off means the phone keyboard, once open
  // for a text field, stays open while you tap around the screen.
  event.preventDefault?.();
  screenPreview.setPointerCapture?.(event.pointerId);
  screenPointers.set(event.pointerId,{x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,started:Date.now(),moved:false});
  const touched = monitorPixelAt(event.clientX, event.clientY), touchedMonitor = selectedMonitor();
  if (touched && touchedMonitor) lastScreenTouch = { monitor: touchedMonitor.name, x: touched.x, y: touched.y };
  if (screenPointers.size === 1) {
    screenGesture = { pinch: false, panned: false, twoFinger: false, moved: false, anchor: null };
    pinchMid = null; pinchDistance = 0;
    clearHold();
    hold.timer = setTimeout(() => {
      hold.timer = null;
      const pointer = screenPointers.get(event.pointerId);
      if (pointer && !pointer.moved && screenPointers.size === 1) { hold.held = true; try { navigator.vibrate?.(12); } catch {} }
    },LONG_PRESS_MS);
  } else {
    const [firstId, first] = screenPointers.entries().next().value;
    const anchored = screenGesture.anchor === firstId || (!screenGesture.twoFinger && !first.moved && Date.now() - first.started >= ANCHOR_SCROLL_MS);
    screenGesture.twoFinger = true;
    clearHold(); endHoldDrag();
    if (anchored && !screenGesture.pinch && screenGesture.anchor !== firstId) {
      screenGesture.anchor = firstId;
      anchorScroll(monitorPixelAt(first.startX, first.startY));
      showTapMarker(first.startX, first.startY, 'scroll');
    }
    const [a,b] = [...screenPointers.values()];
    pinchMid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
    pinchDistance = pointerDistance();
  }
});
screenPreview.addEventListener('pointermove',event => {
  const before = screenPointers.get(event.pointerId);
  if (!before) return;
  const dx = event.clientX-before.x, dy = event.clientY-before.y;
  if (Math.hypot(event.clientX-before.startX,event.clientY-before.startY) > SCREEN_GESTURE_SLOP) { before.moved = true; screenGesture.moved = true; }
  screenPointers.set(event.pointerId,{...before,x:event.clientX,y:event.clientY});
  if (screenGesture.anchor !== null && screenPointers.has(screenGesture.anchor)) {
    screenGesture.panned = true;
    if (screenPointers.size >= 2 && event.pointerId !== screenGesture.anchor) queueScroll(dy);
  } else if (screenPointers.size >= 2) {
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
      if (!screenGesture.panned) anchorScroll(monitorPixelAt(prevMid.x, prevMid.y));
      screenGesture.panned = true;
      queueScroll(midY - prevMid.y);
    }
    pinchMid = { x: midX, y: midY };
    pinchDistance = distance;
  } else if (!screenGesture.twoFinger) {
    if (hold.held || hold.dragging) {
      if (!hold.dragging && before.moved) { beginHoldDrag(monitorPixelAt(before.startX, before.startY)); event.preventDefault?.(); return; }
      if (hold.dragging) {
        const workspaceId = hold.semantic ? workspaceDropTargetAt(event.clientX, event.clientY) : null;
        if (!workspaceId) moveHoldDrag(monitorPixelAt(event.clientX, event.clientY));
      }
    } else if (before.moved) {
      if (hold.timer) clearHold();
      if (screenZoomed) { screenGesture.panned = true; panScreen(dx, dy); }
      else { beginHoldDrag(monitorPixelAt(before.startX, before.startY), false); event.preventDefault?.(); return; }
    }
  }
  event.preventDefault?.();
});
async function finishScreenPointer(event) {
  const pointer = screenPointers.get(event.pointerId);
  screenPointers.delete(event.pointerId);
  if (!pointer) return;
  if (screenPointers.size > 0) { pinchDistance = 0; pinchMid = null; return; }
  pinchMid = null;
  stopPointerMoves();
  const wasHeld = hold.held, wasDragging = hold.dragging, wasSemantic = hold.semantic;
  // Cancellation/lost capture must only release the held button. It can never
  // become a semantic drop, even if its last coordinates crossed the shelf.
  const workspaceId = wasDragging && wasSemantic && event.type === 'pointerup' ? workspaceDropTargetAt(event.clientX, event.clientY) : null;
  const capturedAddress = hold.windowAddress;
  const capturePromise = hold.capturePromise;
  clearHold();
  if (wasDragging) {
    await endHoldDrag();
    if (!wasSemantic) { hold.capturePromise = null; hold.windowAddress = ''; return; }
    const captured = capturePromise ? await capturePromise : null;
    const address = capturedAddress || captured?.window?.address || '';
    hold.capturePromise = null; hold.windowAddress = '';
    if (workspaceId && address) await action('window.moveToWorkspace', { address, id: workspaceId }, t('Janela movida para a área {workspace}.',{workspace:workspaceId}));
    else if (workspaceId) toast(t("Não foi possível identificar a janela arrastada."), true);
    return;
  }
  if (event.type === 'pointercancel') return;
  const moved = screenGesture.moved || pointer.moved || screenGesture.panned || screenGesture.pinch || screenGesture.twoFinger;
  if (moved) return;
  const pixel = monitorPixelAt(pointer.startX, pointer.startY);
  if (!pixel) return;
  if (wasHeld) { showTapMarker(pointer.startX, pointer.startY, 'right'); sendMonitorClick(pixel, 'right'); return; }
  if (Date.now() - pointer.started < 500) {
    showTapMarker(pointer.startX, pointer.startY, 'left');
    Promise.resolve(sendMonitorTap(pixel)).then(tap => { if (tap) scheduleKeyboardCheck(220, 0, tap); });
  }
}
for (const name of ['pointerup','pointercancel','lostpointercapture']) screenPreview.addEventListener(name,finishScreenPointer);
screenPreview.addEventListener('contextmenu', event => { event.preventDefault(); });
// Scroll buttons: a press is one step of wheel notches, holding repeats. The
// wheel lands where the last touch was on this monitor, else at the centre of
// what the phone shows, so reading a terminal needs neither the keyboard nor
// a second finger.
const SCROLL_BUTTON_NOTCHES = 3;
let lastScreenTouch = null;
let scrollButtonTimer = 0;
function scrollButtonPixel() {
  const monitor = selectedMonitor();
  if (!monitor) return null;
  if (lastScreenTouch && lastScreenTouch.monitor === monitor.name) return { x: lastScreenTouch.x, y: lastScreenTouch.y };
  const rect = screenPreview.getBoundingClientRect?.() || { left: 0, top: 0, width: screenPreview.clientWidth, height: screenPreview.clientHeight };
  return monitorPixelAt(rect.left + (rect.width || screenPreview.clientWidth) / 2, rect.top + (rect.height || screenPreview.clientHeight) / 2);
}
function scrollButtonStep(direction) {
  if (!connected || !state?.capabilities?.mouse) return;
  moveQueue.scroll += direction * SCROLL_BUTTON_NOTCHES;
  flushMovement();
}
function stopScrollButton() { clearTimeout(scrollButtonTimer); scrollButtonTimer = 0; }
for (const button of $$('[data-scroll-step]')) {
  const direction = Number(button.dataset.scrollStep);
  button.addEventListener('pointerdown', event => {
    event.preventDefault?.();
    stopScrollButton();
    anchorScroll(scrollButtonPixel());
    scrollButtonStep(direction);
    const repeat = delay => { scrollButtonTimer = setTimeout(() => { scrollButtonStep(direction); repeat(110); }, delay); };
    repeat(400);
  });
  for (const name of ['pointerup','pointercancel','pointerleave']) button.addEventListener(name, stopScrollButton);
  // Keyboard and accessibility activation arrive as a click without a pointer.
  button.addEventListener('click', event => { if (event.detail === 0) { anchorScroll(scrollButtonPixel()); scrollButtonStep(direction); } });
}
screenPreview.addEventListener('keydown',event => {
  if (event.key === '+' || event.key === '=') zoomScreenAround(screenScale*1.4);
  else if (event.key === '-') zoomScreenAround(screenScale/1.4);
  else if (event.key === '0') { screenScale = 1; applyScreenZoom(); }
  else return;
  event.preventDefault();
});

// ---- Phone keyboard for the PC. After a tap-click, the PC reports which fcitx5
// input context (IC) is focused. The phone keyboard opens by itself only when
// the tap *caused* that focus: no IC before -> one now, or a different IC/cap.
// A window that keeps its IC focused all along (Maestri's canvas, a terminal,
// a page with a field focused elsewhere) reports focus:1 whatever was tapped,
// so "some IC is focused" alone never opens it. A tap that also activated
// another window is not proof either (Maestri focuses its hidden textarea on
// any click), so it stays closed; the keyboard button always works.
// Some apps publish their IC a little after the click: a bounded sequence of
// probes, no key injected, taps on non-text UI stay silent.
let keyboardCheckTimer = 0;
const TEXT_FOCUS_RETRY_MS = [180, 360, 700, 1100];
const AUTO_KEYBOARD_KEY = 'ponte-auto-keyboard';
let autoKeyboard = savedPreference(AUTO_KEYBOARD_KEY, 'on') !== 'off';
let keyQueue = Promise.resolve();
function sendKeys(work) { keyQueue = keyQueue.then(work).catch(() => {}); return keyQueue; }
// tap: { before, windowChanged } from the click, or undefined (no tap baseline).
function scheduleKeyboardCheck(delay = 220, attempt = 0, tap) {
  clearTimeout(keyboardCheckTimer);
  keyboardCheckTimer = setTimeout(() => checkTextInput(attempt, tap), delay);
}
function markTextFocus(focused) {
  $('#screen-keyboard').setAttribute('data-text-focused', String(focused === true));
}
// Mirrors backend/textinput.mjs tapFocusedText.
function tapCausedTextFocus(tap, context) {
  if (!tap || tap.before === undefined || tap.windowChanged !== false) return false;
  if (!context || context.typeable === false) return false;
  if (!tap.before) return true;
  return !sameTextContext(tap.before, context);
}
function sameTextContext(a, b) { return Boolean(a && b && a.id === b.id && a.cap === b.cap); }
// The IC an automatically opened bar belongs to: a later tap that leaves it
// (another window, another kind of field, nothing) closes that bar. A bar the
// user opened with the keyboard button is never closed by focus.
let autoComposerContext = null;
async function checkTextInput(attempt = 0, tap) {
  keyboardCheckTimer = 0;
  if (!connected || !screenIsVisible()) return;
  let info;
  try { info = await (await api('/textinput',{timeout:3000})).json(); } catch { return; }
  if (!screenIsVisible()) return;
  if (typeof info.focused === 'boolean') {
    markTextFocus(info.focused);
    // WebView cannot raise Android's keyboard from an asynchronous JavaScript
    // callback by itself. The native shell can, so a field tap opens the
    // typing bar and asks the Activity to show the IME. Plain browsers retain
    // the highlighted keyboard button as their explicit, user-gesture path.
    if (navigator.userAgent.includes('PonteAndroid/')) {
      const caused = autoKeyboard && tapCausedTextFocus(tap, info.context);
      if (caused && !screenComposerOpen()) { openScreenComposer({ automatic: true, requestNativeKeyboard: true }); autoComposerContext = info.context; }
      else if (screenComposerAutomatic && (!info.focused || (tap && !sameTextContext(autoComposerContext, info.context)))) closeScreenComposer();
      else if (!info.focused && autoKeyboard && tap && tap.before !== undefined && tap.windowChanged === false && info.available && attempt < TEXT_FOCUS_RETRY_MS.length) {
        scheduleKeyboardCheck(TEXT_FOCUS_RETRY_MS[attempt], attempt + 1, tap);
      }
    }
  }
}
function setAutoKeyboard(on) {
  autoKeyboard = on === true;
  savePreference(AUTO_KEYBOARD_KEY, autoKeyboard ? 'on' : 'off');
  $('#screen-auto-keyboard').setAttribute('aria-pressed', String(autoKeyboard));
}
$('#screen-auto-keyboard').setAttribute('aria-pressed', String(autoKeyboard));
$('#screen-auto-keyboard').addEventListener('click', () => {
  setAutoKeyboard(!autoKeyboard);
  toast(autoKeyboard ? t("Teclado automático ligado: abre ao tocar num campo de texto.") : t("Teclado automático desligado: use o botão do teclado."));
});
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
// Single-mode has no toolbar Start button, so tapping the idle screen begins the
// stream. This is the way back when the stream stopped (a monitor was
// unplugged, the saved monitor vanished, or too many views hit the cap).
$('#screen-empty').addEventListener('click', () => {
  if (!connected || !state?.capabilities?.live) return;
  const select = $('#monitor-select');
  if (!select.value && state?.monitors?.length) { select.value = (state.monitors.find(m => m.focused) || state.monitors[0]).name; }
  if (!select.value) { toast(t("Nenhum monitor disponível.")); return; }
  liveWanted = true;
  startLive();
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
// Agents and terminals: one list for the agents running on the PC (from
// /api/agents), plain terminal windows and this phone's Ponte sessions.
// Reading never touches the desktop; only the reply button types, and says so.
let agentItems = null;
let agentTimer;
let agentOpenId = '';
let agentTranscriptTimer;
let agentReplyBusy = false;
let agentListHtml = '';
let agentTranscriptHtml = '';
// Automated agents (codex exec, claude -p) are hidden unless asked for, and a
// working agent that starts waiting or finishes raises a small notice. Outside
// Terminals the list is read every AGENT_WATCH_MS only while the app is in
// front and notices are on; Terminals keeps its own faster read.
const AGENT_WATCH_MS = 10000;
let agentShowAuto = savedPreference('ponte-agents-auto') === 'show';
let agentNoticesOn = savedPreference('ponte-agent-notices') !== 'off';
let agentWatchTimer;
let agentLastStates = null;
let agentLastStatesAt = 0;
const agentRepliedAt = {};
let agentNoticeId = '';
let agentNoticeTimer;
const agentKinds = {claude:'Claude',codex:'Codex',grok:'Grok',opencode:'OpenCode',gemini:'Gemini',pi:'Pi',aider:'Aider',crush:'Crush',goose:'Goose',amp:'Amp',qwen:'Qwen','cursor-agent':'Cursor'};
function agentKindLabel(kind) { return agentKinds[kind] || t('Terminal'); }
function agentStateLabel(item) {
  if (item.state === 'working') return t('Trabalhando');
  if (item.state === 'waiting') return t('Esperando você');
  if (item.state === 'ready') return t('Pronto');
  if (item.state === 'idle') return t('Parado');
  return t('Aberto');
}
function agentAgo(ms) {
  if (!ms) return '';
  const minutes = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (minutes < 1) return t('agora');
  if (minutes < 60) return t('há {count} min',{count:minutes});
  if (minutes < 1440) return t('há {count} h',{count:Math.floor(minutes / 60)});
  return t('há {count} d',{count:Math.floor(minutes / 1440)});
}
function agentWhere(item) {
  const where = item.where || {};
  if (where.type === 'ponte') { const session = terminalSessions.filter(item => item.id === where.session)[0]; return session && session.title ? `${t('Sessão do Ponte')} · ${session.title}` : t('Sessão do Ponte'); }
  if (where.type === 'terminal') return where.workspace && where.workspace.id > 0 ? t('Janela no workspace {workspace}',{workspace:where.workspace.name || where.workspace.id}) : t('Janela no PC');
  if (where.type === 'maestri') return t('Maestri');
  if (where.type === 'app') return t('Dentro de {app}',{app:where.app || where.class || ''});
  return item.headless ? t('Sem janela (automático)') : t('Sem janela');
}
function agentSummary(item) { return [agentWhere(item), agentAgo(item.since), item.cwd].filter(Boolean).join(' · '); }
function agentCard(attributes, kind, title, state, stateLabel, detail) {
  return `<button class="agent-card" ${attributes} data-state="${escaped(state)}"><span><span class="agent-kind">${escaped(kind)}</span><strong>${escaped(title)}</strong><small>${escaped(detail)}</small></span><span class="agent-state" data-state="${escaped(state)}">${escaped(stateLabel)}</span></button>`;
}
function renderDesktopTerminals() {
  const list = $('#agent-list');
  if (!list) return;
  const cards = [];
  const linked = {};
  const automated = (agentItems || []).filter(item => item.headless).length;
  const shown = agentVisibleItems();
  if (agentItems) {
    shown.forEach(item => {
      if (item.where && item.where.type === 'ponte') linked[item.where.session] = true;
      if (item.kind === 'terminal') cards.push(agentCard(`data-preview-window="${escaped(item.where.address)}"`, t('Terminal'), item.title, 'terminal', t('Aberto'), `${agentWhere(item)} · ${t('Focar e ver no monitor')}`));
      else cards.push(agentCard(`data-agent-id="${escaped(item.id)}"`, agentKindLabel(item.kind), item.title, item.state, agentStateLabel(item), agentSummary(item)));
    });
  } else {
    // A phone whose native shell predates the agent routes still lists windows.
    (state && state.windows || []).filter(w => appIcon(w.class) === 'terminal').forEach(w => cards.push(agentCard(`data-preview-window="${escaped(w.address)}"`, t('Terminal'), w.title || w.class, 'terminal', t('Aberto'), t('Focar e ver no monitor'))));
  }
  terminalSessions.forEach(session => {
    if (!linked[session.id]) cards.push(agentCard(`data-ponte-session="${escaped(session.id)}"`, t('Terminal'), session.title || t('Terminal'), 'terminal', t('Aberto'), t('Sessão do Ponte')));
  });
  const working = shown.filter(item => item.state === 'working' || item.state === 'waiting').length;
  $('#agent-count').textContent = agentItems ? t('{count} ATIVOS',{count:working}) : '';
  const autoButton = $('#agent-show-auto');
  autoButton.hidden = !agentItems;
  autoButton.textContent = t('Mostrar automáticos ({count})',{count:automated});
  autoButton.setAttribute('aria-pressed',String(agentShowAuto));
  agentNoticesRender();
  const html = cards.length ? cards.join('') : `<p class="hint">${h('Nenhum agente ou terminal aberto.')}</p>`;
  if (agentListHtml !== html) { list.innerHTML = html; agentListHtml = html; }
  if (agentOpenId) renderAgentHeader();
}
async function readAgents(generation) {
  clearTimeout(agentTimer);
  if (!terminalVisible() || generation !== terminalGeneration) return;
  try {
    const listing = await (await api('/agents',{timeout:8000})).json();
    if (generation !== terminalGeneration) return;
    agentItems = Array.isArray(listing.items) ? listing.items : [];
    agentNoticeCheck(agentItems);
  } catch (error) {
    if (generation !== terminalGeneration) return;
    agentItems = null;
  }
  renderDesktopTerminals();
  if (generation === terminalGeneration && terminalVisible()) agentTimer = setTimeout(() => readAgents(generation), 3000);
}
function agentVisibleItems() { return (agentItems || []).filter(item => agentShowAuto || !item.headless); }
function agentNoticesRender() {
  $('#agent-notices').setAttribute('aria-pressed',String(agentNoticesOn));
  const hint = $('#agent-notices-hint');
  hint.hidden = !(agentNoticesOn && agentAlertsNative === 'blocked');
  hint.textContent = hint.hidden ? '' : t('Permita notificações do Ponte nas configurações pra avisar com o app fechado');
}
// Compares with the previous read. The first read, or one after a long gap
// (app paused, reads failing), only sets the baseline, so a change that
// happened while nobody was looking never pops up late.
function agentNoticeCheck(items) {
  const now = Date.now();
  const previous = agentLastStates && now - agentLastStatesAt < 60000 ? agentLastStates : null;
  const next = {};
  let notice = null;
  items.forEach(item => {
    next[item.id] = item.state;
    if (notice || !previous || item.headless || previous[item.id] !== 'working') return;
    if (item.state !== 'waiting' && item.state !== 'ready') return;
    if (now - (agentRepliedAt[item.id] || 0) < 5000) return;
    notice = item;
  });
  agentLastStates = next; agentLastStatesAt = now;
  if (notice && agentNoticesOn) agentNotify(notice);
}
function agentNotify(item) {
  // Already reading that agent: the open conversation shows the change.
  if (agentOpenId === item.id && $('#agent-dialog').open) return;
  agentNoticeId = item.id;
  $('#agent-notice-title').textContent = item.state === 'waiting' ? t('{title} precisa de você',{title:item.title}) : t('{title} terminou',{title:item.title});
  $('#agent-notice-detail').textContent = item.state === 'waiting' && item.waitingFor ? item.waitingFor : '';
  $('#agent-notice').hidden = false;
  clearTimeout(agentNoticeTimer);
  agentNoticeTimer = setTimeout(agentNoticeHide, 12000);
  try { if (navigator.vibrate) navigator.vibrate(60); } catch (error) {}
  if (currentPage !== 'terminais') $('#nav-agent-dot').hidden = false;
}
function agentNoticeHide() { clearTimeout(agentNoticeTimer); $('#agent-notice').hidden = true; }
function agentWatchVisible() { return !!token && !document.hidden && !nativePaused && agentNoticesOn && !terminalVisible(); }
function agentWatchSchedule(generation) {
  clearTimeout(agentWatchTimer);
  if (!agentWatchVisible() || generation !== terminalGeneration) return;
  agentWatchTimer = setTimeout(() => agentWatch(generation), Math.max(0, AGENT_WATCH_MS - (Date.now() - agentLastStatesAt)));
}
async function agentWatch(generation) {
  clearTimeout(agentWatchTimer);
  if (!agentWatchVisible() || generation !== terminalGeneration) return;
  let failed = false;
  try {
    const listing = await (await api('/agents',{timeout:8000})).json();
    if (generation !== terminalGeneration) return;
    agentItems = Array.isArray(listing.items) ? listing.items : [];
    agentNoticeCheck(agentItems);
    if (agentOpenId) renderAgentHeader();
  } catch (error) { failed = true; }
  // An older native shell blocks this route: ask again rarely.
  if (generation === terminalGeneration && agentWatchVisible()) agentWatchTimer = setTimeout(() => agentWatch(generation), failed ? 60000 : AGENT_WATCH_MS);
}
$('#agent-notice').addEventListener('click', () => {
  const id = agentNoticeId;
  agentNoticeHide();
  if (id && (agentItems || []).some(item => item.id === id)) openAgent(id);
});
$('#agent-show-auto').addEventListener('click', () => {
  agentShowAuto = !agentShowAuto;
  savePreference('ponte-agents-auto',agentShowAuto ? 'show' : 'hide');
  renderDesktopTerminals();
});
$('#agent-notices').addEventListener('click', () => {
  agentNoticesOn = !agentNoticesOn;
  savePreference('ponte-agent-notices',agentNoticesOn ? 'on' : 'off');
  agentAlertsSet(agentNoticesOn,agentNoticesOn);
  agentNoticesRender();
  if (!agentNoticesOn) agentNoticeHide();
});
// In the Android app the same switch runs a native service that keeps one
// long-poll to the PC and raises a system notification with the app closed.
// The shell's own record wins on load ("Turn off" on that notification sets
// it), so the page and the service never disagree. A browser has no bridge
// and keeps only the in-app notice.
let agentAlertsNative = '';
function agentAlertsBridge() { return window.PonteNative && typeof window.PonteNative.setAgentAlerts === 'function' ? window.PonteNative : null; }
function agentAlertsSet(on, ask) {
  const bridge = agentAlertsBridge();
  if (!bridge || (on && !token)) return;
  try { bridge.setAgentAlerts(!!on, on ? token : '', !!ask); } catch (error) {}
}
function agentAlertsSync() {
  const bridge = agentAlertsBridge();
  if (!bridge || !token) return;
  let native = '';
  try { native = String(bridge.agentAlerts()); } catch (error) { return; }
  agentAlertsNative = native;
  if (native === 'off' && agentNoticesOn) { agentNoticesOn = false; savePreference('ponte-agent-notices','off'); agentNoticeHide(); }
  else if ((native === 'on' || native === 'blocked') && !agentNoticesOn) { agentNoticesOn = true; savePreference('ponte-agent-notices','on'); }
  // Android asks for the notification permission once, the first time the
  // shell learns the switch is on; after that only a tap on the switch asks.
  if (agentNoticesOn) agentAlertsSet(true, native === 'unset');
  else if (native === 'unset') agentAlertsSet(false, false);
  agentNoticesRender();
}
function agentAlertsForget() {
  agentAlertsNative = '';
  try { if (window.PonteNative && typeof window.PonteNative.forgetAgentAlerts === 'function') window.PonteNative.forgetAgentAlerts(); } catch (error) {}
}
// A tapped system alert: the shell holds the agent's id until the page takes it.
function agentOpenFromNative() {
  if (!token || !window.PonteNative || typeof window.PonteNative.takeAgentToOpen !== 'function') return;
  let id = '';
  try { id = String(window.PonteNative.takeAgentToOpen() || ''); } catch (error) { return; }
  if (!/^(p-\d{1,10}-\d{1,20}|w-[0-9a-f]{1,32})$/.test(id)) return;
  agentNoticeHide();
  navigate('terminais');
  openAgent(id);
}
window.addEventListener('ponte-native-alerts', event => { agentAlertsNative = String(event.detail || ''); agentNoticesRender(); });
window.addEventListener('ponte-native-agent', agentOpenFromNative);
window.addEventListener('ponte-native-resume', () => { agentAlertsSync(); agentOpenFromNative(); });
agentNoticesRender();
function agentOpenItem() { return (agentItems || []).filter(item => item.id === agentOpenId)[0] || null; }
function renderAgentHeader() {
  const item = agentOpenItem();
  if (!item) { $('#agent-dialog-meta').textContent = t('Este agente não está mais rodando.'); $('#agent-reply-form').hidden = true; return; }
  $('#agent-dialog-kind').textContent = `${agentKindLabel(item.kind)} · ${agentStateLabel(item)}${item.waitingFor ? ` (${item.waitingFor})` : ''}`;
  $('#agent-dialog-title').textContent = item.title;
  $('#agent-dialog-meta').textContent = agentSummary(item);
  const where = item.where || {};
  $('#agent-view').hidden = !(where.type === 'terminal' && where.address);
  $('#agent-open-session').hidden = where.type !== 'ponte';
  $('#agent-reply-form').hidden = !item.canReply;
  $('#agent-readonly').hidden = !!item.canReply;
  $('#agent-readonly').textContent = where.type === 'maestri' ? t('Só leitura aqui: responda pelo canvas do Maestri. O Maestri não aceita mensagem de fora dele.') : t('Só leitura: este agente não tem janela de terminal nem sessão do Ponte para digitar.');
  $('#agent-reply-send').textContent = where.type === 'ponte' ? t('Enviar para a sessão') : t('Responder no PC');
  $('#agent-reply-hint').textContent = where.type === 'ponte' ? t('Digita na sessão do Ponte e aperta Enter, sem mudar o foco do PC.') : t('Atenção: traz esta janela para a frente no PC e digita o texto + Enter nela.');
  $('#agent-reply-send').disabled = agentReplyBusy;
}
function renderAgentTranscript(view) {
  const box = $('#agent-transcript');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const who = {user:t('Você'),assistant:t('Agente'),tool:t('Ação')};
  const html = view.available && view.messages.length ? view.messages.map(message => `<div class="agent-msg" data-role="${escaped(message.role)}">${message.role === 'tool' ? '' : `<b>${escaped(who[message.role] || '')}</b>`}${escaped(message.text)}</div>`).join('') : `<p class="hint">${h(view.available ? 'Nada escrito ainda.' : 'Sem conversa legível para este agente.')}</p>`;
  if (agentTranscriptHtml !== html) { const first = !agentTranscriptHtml; box.innerHTML = html; agentTranscriptHtml = html; if (nearBottom || first) box.scrollTop = box.scrollHeight; }
}
async function readAgentTranscript(id) {
  clearTimeout(agentTranscriptTimer);
  if (agentOpenId !== id || !$('#agent-dialog').open) return;
  try {
    const view = await (await api(`/agents/${encodeURIComponent(id)}/transcript`,{timeout:8000})).json();
    if (agentOpenId === id) renderAgentTranscript(view);
  } catch (error) {
    if (agentOpenId === id) i18n.write($('#agent-dialog-meta'),error);
  }
  if (agentOpenId === id && $('#agent-dialog').open && !document.hidden) agentTranscriptTimer = setTimeout(() => readAgentTranscript(id), 3000);
}
function openAgent(id) {
  agentOpenId = id;
  const box = $('#agent-transcript');
  box.innerHTML = `<p class="hint">${h('Carregando conversa…')}</p>`; agentTranscriptHtml = '';
  $('#agent-reply-text').value = ''; $('#agent-reply-status').textContent = '';
  renderAgentHeader();
  if (!$('#agent-dialog').open) $('#agent-dialog').showModal();
  readAgentTranscript(id);
}
function agentShowSession() { const panel = $('#terminal-session'); if (panel.scrollIntoView) panel.scrollIntoView({block:'start',behavior:'smooth'}); }
function closeAgent() {
  agentOpenId = ''; clearTimeout(agentTranscriptTimer);
  if ($('#agent-dialog').open) $('#agent-dialog').close();
}
$('#agent-list').addEventListener('click', event => {
  const agent = event.target.closest('[data-agent-id]');
  if (agent) { openAgent(agent.dataset.agentId); return; }
  const session = event.target.closest('[data-ponte-session]');
  if (session) { selectTerminal(session.dataset.ponteSession); terminalPaused = false; updateTerminalNavigation(); agentShowSession(); }
});
$('#agent-dialog-close').addEventListener('click', closeAgent);
$('#agent-dialog').addEventListener('close', () => { agentOpenId = ''; clearTimeout(agentTranscriptTimer); });
$('#agent-view').addEventListener('click', async () => {
  const item = agentOpenItem();
  if (!item || !item.where.address) return;
  closeAgent();
  if (await action('window.focus',{address:item.where.address})) {
    const monitor = (state && state.monitors || []).filter(m => m.id === item.where.monitor)[0];
    if (monitor) { $('#monitor-select').value = monitor.name; savePreference(monitorKey(),monitor.name); }
    navigate('tela');
  }
});
$('#agent-open-session').addEventListener('click', () => {
  const item = agentOpenItem();
  if (!item || !item.where.session) return;
  closeAgent();
  selectTerminal(item.where.session); terminalPaused = false; updateTerminalNavigation(); agentShowSession();
});
$('#agent-reply-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = agentOpenId, box = $('#agent-reply-text');
  // Newlines would press Enter early in a terminal agent; the reply is one line.
  const text = box.value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!id || !text || agentReplyBusy || !connected) return;
  agentReplyBusy = true; renderAgentHeader();
  agentRepliedAt[id] = Date.now();
  try {
    await api(`/agents/${encodeURIComponent(id)}/reply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    agentRepliedAt[id] = Date.now();
    if (box.value.replace(/[\r\n\t]+/g, ' ').trim() === text) box.value = '';
    $('#agent-reply-status').textContent = t('Enviado para o agente.');
    setTimeout(() => readAgentTranscript(id), 1200);
  } catch (error) { i18n.write($('#agent-reply-status'),error); }
  finally { agentReplyBusy = false; if (agentOpenId) renderAgentHeader(); }
});
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
  terminalSizeOptions(session?.cols || 40);
  terminalSessionOptions();
}
// Reading back in the session: a finger on the output, a fling still running
// or a text selection keeps the text as it is until the next read, and new
// output that pushes old lines off the top keeps the line being read in place.
let terminalTouching = false, terminalScrolledAt = 0, terminalOwnScrollTop = -1;
const TERMINAL_SCROLL_SETTLE_MS = 700;
function terminalReaderBusy(output) {
  if (terminalTouching || Date.now() - terminalScrolledAt < TERMINAL_SCROLL_SETTLE_MS) return true;
  const selection = window.getSelection?.();
  return !!(selection && !selection.isCollapsed && output.contains?.(selection.anchorNode));
}
// The first line may be cut by the byte cap, so the match starts one line in.
function terminalLinesDropped(before, after) {
  if (!before || !after) return 0;
  const old = before.split('\n'), next = after.split('\n');
  for (let line = 1; line < old.length; line++) {
    const count = Math.min(3, old.length - line, next.length - 1);
    if (count < Math.min(2, next.length - 1)) break;
    let same = true;
    for (let i = 0; i < count && same; i++) same = old[line + i] === next[1 + i];
    if (same) return line - 1;
  }
  return 0;
}
{
  const output = $('#terminal-output');
  output.addEventListener('touchstart', () => { terminalTouching = true; }, { passive: true });
  for (const name of ['touchend','touchcancel']) output.addEventListener(name, () => { terminalTouching = false; terminalScrolledAt = Date.now(); }, { passive: true });
  output.addEventListener('scroll', () => { if (Math.abs(output.scrollTop - terminalOwnScrollTop) > 1) terminalScrolledAt = Date.now(); }, { passive: true });
}
// Polling cost: the session list refreshes every 5 s (and on every visit or
// action), the output is asked with the hash of what is shown so an idle pane
// answers without its text, and an idle pane is polled less and less often.
const TERMINAL_LIST_MS = 5000;
const TERMINAL_POLL_MS = [800, 800, 1200, 1600, 2400, 3000];
let terminalListedAt = 0, terminalListedGeneration = -1, terminalQuietTicks = 0, terminalHash = '', terminalHashId = '';
async function readTerminals(generation) {
  if (!terminalVisible() || generation !== terminalGeneration) return;
  const requestToken = token;
  try {
    const listDue = terminalListedGeneration !== generation || Date.now() - terminalListedAt >= TERMINAL_LIST_MS;
    if (terminalListedGeneration !== generation) terminalQuietTicks = 0;
    const response = listDue ? await api('/terminals',{timeout:8000}) : null;
    const listing = response ? await response.json() : { available: terminalAvailable, sessions: terminalSessions };
    if (response) { terminalListedAt = Date.now(); terminalListedGeneration = generation; }
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
      const since = terminalText !== null && terminalHashId === requestedId && terminalHash ? `?since=${encodeURIComponent(terminalHash)}` : '';
      const view = await (await api(`/terminals/${encodeURIComponent(requestedId)}${since}`,{timeout:8000})).json();
      if (generation !== terminalGeneration || requestedId !== terminalId || requestToken !== token || !terminalVisible()) return;
      $('#terminal-mode').hidden = !view.inMode;
      const output = $('#terminal-output');
      const followsTail = output.scrollHeight-output.scrollTop-output.clientHeight < 48;
      const text = view.unchanged === true || typeof view.text !== 'string' ? terminalText : view.text.replace(/\n+$/,'');
      terminalQuietTicks = terminalText === text ? terminalQuietTicks + 1 : 0;
      if (terminalText === text && view.hash) { terminalHash = view.hash; terminalHashId = requestedId; }
      // The hash is kept only for text actually on screen: text held back
      // under a finger comes again on the next read.
      if (terminalText !== text && !terminalReaderBusy(output)) {
        terminalHash = view.hash || ''; terminalHashId = requestedId;
        const before = terminalText, lineHeight = before ? output.scrollHeight / before.split('\n').length : 0;
        const dropped = followsTail ? 0 : terminalLinesDropped(before, text);
        const top = output.scrollTop;
        terminalText = text;
        output.textContent = text;
        if (followsTail) output.scrollTop = output.scrollHeight;
        else if (dropped) output.scrollTop = Math.max(0, top - dropped * lineHeight);
        terminalOwnScrollTop = output.scrollTop;
      }
    }
  } catch (error) {
    if (generation === terminalGeneration && requestToken === token && terminalVisible()) i18n.write($('#terminal-status'),error);
  } finally {
    if (generation === terminalGeneration && terminalVisible()) terminalTimer = setTimeout(() => readTerminals(generation),terminalPaused ? 2000 : TERMINAL_POLL_MS[Math.min(terminalQuietTicks, TERMINAL_POLL_MS.length - 1)]);
  }
}
function updateTerminalNavigation() {
  clearTimeout(terminalTimer);
  const generation = ++terminalGeneration;
  terminalControls();
  if (terminalVisible()) { $('#nav-agent-dot').hidden = true; renderDesktopTerminals(); readTerminals(generation); readAgents(generation); }
  agentWatchSchedule(generation);
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
  const session = await terminalMutation('/terminals',devSessionSize());
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
  // History belongs to the terminal composer only. The screen typing bar types
  // into arbitrary PC fields (passwords included), so it never saves anything.
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

// Screen typing bar. It works like a keyboard, not like a form: the keyboard
// button opens a thin bar and focuses its field inside the same tap (the only
// way Android shows the soft keyboard), and every edit goes to the PC as it
// happens — the field only mirrors what was sent, so autocorrect fixes turn
// into backspaces on the PC too. Enter presses Enter on the PC, remembers the
// line in the command history shared with the terminal, and clears the field.
// The clock button reveals that history plus New/Close; a chip types its line.
const screenInput = $('#screen-input');
let screenComposing = false;
let screenComposerH = -1;
let screenComposerAutomatic = false;
function screenComposerOpen() { return !$('#screen-composer').hidden; }
function screenKeyboardAvailable() { return connected && state?.capabilities?.keyboard !== false; }
// The bar's height is what the monitor must leave free above it. Recompute it
// (and re-fit the stream) only when the textarea actually changed height.
function growScreenInput() {
  screenInput.style.height = 'auto';
  screenInput.style.height = `${Math.min(96, screenInput.scrollHeight)}px`;
  const h = screenComposerOpen() ? ($('#screen-composer').offsetHeight || 0) : 0;
  if (h !== screenComposerH) { screenComposerH = h; syncRemoteViewport(); }
}
function measureScreenComposer() { screenComposerH = -1; growScreenInput(); setTimeout(() => { screenComposerH = -1; growScreenInput(); }, 80); }
// Asking the shell for the IME re-focuses the WebView, which drops the DOM
// focus onto the screen preview (measured on the Redmi): the keyboard opens
// with no field behind it. Put the focus back as the keyboard settles.
let screenFocusTimers = [];
function keepScreenInputFocused() {
  for (const timer of screenFocusTimers) clearTimeout(timer);
  screenFocusTimers = [50, 150, 300, 600].map(ms => setTimeout(() => {
    if (screenComposerOpen() && document.activeElement !== screenInput) screenInput.focus({ preventScroll: true });
  }, ms));
}
function requestNativeScreenKeyboard() {
  if (!navigator.userAgent.includes('PonteAndroid/')) return;
  try {
    if (window.PonteNative && typeof window.PonteNative.showKeyboard === 'function') window.PonteNative.showKeyboard();
    else location.href = 'ponte://keyboard/show';
  } catch { try { location.href = 'ponte://keyboard/show'; } catch {} }
  keepScreenInputFocused();
}
function openScreenComposer({ automatic = false, requestNativeKeyboard = false } = {}) {
  // A general keyboard that silently drops keys is worse than none: only open
  // when the PC can actually accept typed input (wtype present, connected).
  if (!screenKeyboardAvailable()) { toast(connected ? t("Digitação indisponível neste PC.") : t("Reconecte ao PC para usar este controle."), true); return; }
  screenComposing = false;
  screenComposerAutomatic = automatic;
  $('#screen-composer').hidden = false;
  document.body.setAttribute('data-screen-composer', 'true');
  $('#screen-keyboard').setAttribute('aria-pressed', 'true');
  screenInput.focus({ preventScroll: true });
  if (requestNativeKeyboard) requestNativeScreenKeyboard();
  measureScreenComposer();
}
function closeScreenComposer() {
  clearTimeout(keyboardCheckTimer);
  if (!screenComposerOpen()) return;
  $('#screen-composer').hidden = true;
  $('#screen-composer-tools').hidden = true;
  $('#screen-input-more').setAttribute('aria-pressed', 'false');
  document.body.setAttribute('data-screen-composer', 'false');
  $('#screen-keyboard').setAttribute('aria-pressed', 'false');
  screenInput.value = ''; screenComposing = false; screenComposerH = -1; screenComposerAutomatic = false;
  for (const timer of screenFocusTimers) clearTimeout(timer);
  screenInput.blur();
  // Blurring the field does not always lower the IME inside the WebView; ask
  // the shell, otherwise an open keyboard types into nothing.
  try { if (navigator.userAgent.includes('PonteAndroid/') && window.PonteNative && typeof window.PonteNative.hideKeyboard === 'function') window.PonteNative.hideKeyboard(); } catch {}
  syncRemoteViewport();
}
// A key that did not reach the PC: keep the draft so it can be sent again.
function failScreenInput() { toast(t("O texto não entrou. Tente de novo."), true); }
// The text stays on the phone until Send: one request types the whole line
// and presses Enter in the same server action. Forwarding every edit as
// keystrokes (the previous design) turned a Gboard correction over a
// Tailscale relay into a burst of backspaces that arrived garbled or not at
// all. The bar closes after a successful send, like a chat.
function sendScreenText({ enter = true } = {}) {
  if (screenComposing || !screenKeyboardAvailable()) return;
  const text = screenInput.value;
  // The screen bar types into arbitrary PC fields (including password fields),
  // so its lines are NEVER saved to history. Only the terminal composer keeps a
  // command history.
  sendKeys(async () => {
    const ok = text ? await quietAction('keyboard.text', enter ? { text, enter: true } : { text }) : (enter ? await quietAction('keyboard.key',{key:'Enter'}) : true);
    if (!ok) { failScreenInput(); return; }
    if (screenInput.value !== text) return; // typed more meanwhile: keep the bar
    screenInput.value = ''; growScreenInput();
    if (enter && text) closeScreenComposer(); else screenInput.focus({ preventScroll: true });
  });
}
function sendScreenEnter() { sendScreenText({ enter: true }); }
// A button tap must not steal focus from the field: that would close the
// keyboard, shift the bar under the finger and lose the tap itself.
for (const name of ['pointerdown','mousedown']) {
  $$('#screen-input-send,#screen-input-more,#screen-input-clear,#screen-input-paste,#screen-key-row button').forEach(element => element.addEventListener(name, event => event.preventDefault()));
}
$('#screen-keyboard').addEventListener('click', () => {
  if (!screenComposerOpen()) { openScreenComposer({ automatic: false, requestNativeKeyboard: true }); return; }
  // The bar is open but the phone keyboard is not (MIUI sometimes ignores the
  // first request, or the user dismissed it with Back): the natural tap is
  // "give me the keyboard", not "close the bar".
  if (document.body.getAttribute('data-screen-keyboard') !== 'true' && navigator.userAgent.includes('PonteAndroid/')) {
    screenComposerAutomatic = false;
    screenInput.focus({ preventScroll: true });
    requestNativeScreenKeyboard();
    return;
  }
  closeScreenComposer();
});
$('#screen-input-close').addEventListener('click', closeScreenComposer);
$('#screen-input-send').addEventListener('click', sendScreenEnter);
$('#screen-input-more').addEventListener('click', () => {
  const open = $('#screen-composer-tools').hidden;
  $('#screen-composer-tools').hidden = !open;
  $('#screen-input-more').setAttribute('aria-pressed', String(open));
  measureScreenComposer();
});
$('#screen-input-clear').addEventListener('click', () => {
  // Nothing was sent yet, so New only clears the phone's draft.
  screenInput.value = ''; growScreenInput();
  screenInput.focus({ preventScroll: true });
});
$('#screen-input-paste').addEventListener('click', () => sendScreenText({ enter: false }));
screenInput.addEventListener('input', growScreenInput);
screenInput.addEventListener('compositionstart', () => { screenComposing = true; });
screenInput.addEventListener('compositionend', () => { screenComposing = false; });
screenInput.addEventListener('keydown', event => {
  // Ignore Enter/Backspace mid-IME-composition (isComposing, or Android's 229
  // placeholder keycode): otherwise confirming a candidate sends a stray Enter.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendScreenEnter(); }
  else if (event.key === 'Backspace' && !screenInput.value) { event.preventDefault(); sendKeys(() => quietAction('keyboard.key',{key:'BackSpace'})); }
});
screenInput.addEventListener('focus', measureScreenComposer);
screenInput.addEventListener('blur', measureScreenComposer);

// Sessions born at the phone's measured grid (e.g. 52 columns) show their
// width as a fourth option instead of a blank select.
function terminalSizeOptions(cols) {
  const widths = [[40,'Celular · 40 colunas'],[80,'Desktop · 80 colunas'],[120,'Amplo · 120 colunas']];
  const current = widths.some(([width]) => width === cols) ? '' : `<option value="${Number(cols)}">${escaped(t('Atual · {cols} colunas',{cols}))}</option>`;
  $('#terminal-size').innerHTML = current + widths.map(([width, label]) => `<option value="${width}" data-i18n="${label}">${escaped(t(label))}</option>`).join('');
  $('#terminal-size').value = String(cols);
}
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
      if (monitor) { $('#monitor-select').value = monitor.name; savePreference(monitorKey(),monitor.name); }
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
  moveQueue = {dx:0,dy:0,scroll:0}; scrollAt = null;
  stopScrollButton();
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
    if (scroll) { const at = scrollAt; scrollAt = null; await api('/action', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'mouse.scroll',dy:Math.round(scroll),...(at || {})})}); }
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

// Images from the phone (a screenshot shared to Ponte, or one picked here) go
// to the PC only where the user points: nothing is uploaded, copied or pasted
// before a destination button is pressed, and Enter is never sent.
const IMAGE_TYPES = ['image/png','image/jpeg','image/webp'];
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
let imageQueue = [];
let imageIndex = 0;
let imageBusy = false;
const imageTerminalTitles = new Map();
function currentImage() { return imageQueue[imageIndex] || null; }
function imageResult(message, error = false) {
  const element = $('#image-result');
  if (!message) { element.hidden = true; element.textContent = ''; return; }
  i18n.write(element,message); element.classList.toggle('error', error); element.hidden = false;
}
function imageFailure(error) {
  if (error && error.errorCode) return i18n.apiMessage(error.errorCode,error.errorParameters || {},error.message);
  return error && error.message ? error.message : String(error);
}
function renderImageChoice() {
  const item = currentImage();
  $('#image-empty').hidden = !!item;
  $('#image-chosen').hidden = !item;
  if (!item) { $('#image-preview').removeAttribute('src'); return; }
  $('#image-preview').src = item.url;
  $('#image-caption').textContent = `${item.name} · ${formatBytes(item.blob.size)}`;
  $('#image-nav').hidden = imageQueue.length < 2;
  $('#image-position').textContent = t('{current} de {total}',{current:imageIndex + 1,total:imageQueue.length});
  ['#image-copy','#image-paste','#image-save','#image-prev','#image-next'].forEach(selector => { $(selector).disabled = imageBusy; });
  $('#image-paste').disabled = imageBusy || !$('#image-terminal').value;
}
function setImageQueue(items) {
  imageQueue.forEach(item => { if (item.ownURL) URL.revokeObjectURL(item.url); });
  imageQueue = items.map(item => ({...item, url: item.url || URL.createObjectURL(item.blob), ownURL: !item.url}));
  imageIndex = 0; imageResult('');
  renderImageChoice();
}
function acceptImageFiles(files) {
  const items = [];
  for (const file of files) {
    if (IMAGE_TYPES.indexOf(file.type) < 0) { toast(i18n.apiMessage('UNSUPPORTED_IMAGE_FORMAT'), true); continue; }
    if (file.size > IMAGE_MAX_BYTES) { toast(i18n.apiMessage('IMAGE_TOO_LARGE'), true); continue; }
    items.push({blob:file, name:file.name || 'imagem', mime:file.type, uploaded:null});
  }
  if (items.length) setImageQueue(items.slice(0,10));
}
async function loadImageTerminals() {
  const select = $('#image-terminal');
  const previous = select.value;
  let sessions = [];
  try { sessions = (await (await api('/terminals')).json()).sessions || []; } catch {}
  select.innerHTML = sessions.length
    ? sessions.map(session => `<option value="${escaped(session.id)}">${escaped(session.title)}</option>`).join('')
    : `<option value="">${h('Nenhum terminal do Ponte aberto')}</option>`;
  imageTerminalTitles.clear(); sessions.forEach(session => imageTerminalTitles.set(session.id, session.title));
  select.value = sessions.some(session => session.id === previous) ? previous : (sessions.length ? sessions[0].id : '');
  renderImageChoice();
}
async function loadRecentImages() {
  const list = $('#image-list');
  try {
    const { images } = await (await api('/images')).json();
    list.innerHTML = images.length ? images.slice(0,8).map(image => `<article class="image-item"><div><strong>${escaped(image.name)}</strong><span><time data-i18n-date="${escaped(image.createdAt)}">${escaped(recordingDate(image.createdAt))}</time> · <span data-i18n-bytes="${Number(image.bytes)}">${escaped(formatBytes(image.bytes))}</span></span></div><button class="button small" data-image-use="${escaped(image.id)}" data-image-mime="${escaped(image.mime)}" data-image-path="${escaped(image.path)}">${h('Usar')}</button><button class="button small danger-subtle" data-image-delete="${escaped(image.id)}">${h('Apagar')}</button></article>`).join('') : `<p class="hint">${h('Nenhuma imagem enviada ainda.')}</p>`;
  } catch { list.innerHTML = `<p class="hint">${h('Não foi possível carregar os envios.')}</p>`; }
}
function openImageDialog() {
  const dialog = $('#image-dialog');
  if (!dialog.open) dialog.showModal();
  renderImageChoice();
  loadImageTerminals(); loadRecentImages();
}
async function uploadCurrentImage() {
  const item = currentImage();
  if (item.uploaded) return item.uploaded;
  imageResult(t('Enviando imagem…'));
  const response = await api('/images', { method:'POST', headers:{'Content-Type':item.mime}, body:item.blob, timeout:90000 });
  item.uploaded = await response.json();
  return item.uploaded;
}
async function sendImage(kind) {
  const item = currentImage();
  if (!item || imageBusy) return;
  const terminal = $('#image-terminal');
  if (kind === 'paste' && !terminal.value) { imageResult(t('Abra um terminal na aba Terminais para colar o caminho.'), true); return; }
  imageBusy = true; renderImageChoice();
  try {
    const uploaded = await uploadCurrentImage();
    if (kind === 'copy') {
      await api(`/images/${encodeURIComponent(uploaded.id)}/copy`, { method:'POST' });
      imageResult(t('Copiada no PC. Cole com Ctrl+V onde quiser.'));
    } else if (kind === 'paste') {
      await api(`/images/${encodeURIComponent(uploaded.id)}/paste`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({terminal:terminal.value}) });
      imageResult(t('Caminho colado em {terminal}. Confira e aperte Enter lá.',{terminal:imageTerminalTitles.get(terminal.value) || terminal.value}));
    } else imageResult(t('Salva no PC: {path}',{path:uploaded.path}));
    loadRecentImages();
  } catch (error) {
    if (error && error.errorCode === 'IMAGE_NOT_FOUND') item.uploaded = null;
    imageResult(imageFailure(error), true);
  } finally { imageBusy = false; renderImageChoice(); }
}
// Screenshots shared from another app are read by the Android shell and held
// in memory until this page fetches each one once from the shell itself.
async function receiveSharedImages() {
  if (!token || !window.PonteNative || typeof window.PonteNative.sharedImages !== 'function') return;
  let shared = [];
  try { shared = JSON.parse(window.PonteNative.sharedImages()) || []; } catch { return; }
  const items = [];
  for (const entry of shared) {
    try {
      const response = await fetch(`/__ponte_shared/${encodeURIComponent(entry.id)}`, { cache:'no-store' });
      if (!response.ok) continue;
      const blob = await response.blob();
      items.push({blob, name:entry.name || 'print', mime:entry.mime, uploaded:null});
    } catch {}
  }
  if (!items.length) return;
  setImageQueue(items);
  openImageDialog();
}
$('#image-open').addEventListener('click', openImageDialog);
$('#image-close').addEventListener('click', () => $('#image-dialog').close());
$('#image-pick').addEventListener('click', () => $('#image-file').click());
$('#image-pick-other').addEventListener('click', () => $('#image-file').click());
$('#image-file').addEventListener('change', event => { acceptImageFiles([...event.target.files]); event.target.value = ''; });
$('#image-copy').addEventListener('click', () => sendImage('copy'));
$('#image-paste').addEventListener('click', () => sendImage('paste'));
$('#image-save').addEventListener('click', () => sendImage('save'));
$('#image-terminal').addEventListener('change', renderImageChoice);
$('#image-refresh').addEventListener('click', () => { loadRecentImages(); loadImageTerminals(); });
$('#image-prev').addEventListener('click', () => { imageIndex = (imageIndex + imageQueue.length - 1) % imageQueue.length; imageResult(''); renderImageChoice(); });
$('#image-next').addEventListener('click', () => { imageIndex = (imageIndex + 1) % imageQueue.length; imageResult(''); renderImageChoice(); });
$('#image-list').addEventListener('click', async event => {
  const use = event.target.closest('[data-image-use]');
  const remove = event.target.closest('[data-image-delete]');
  if (use) {
    use.disabled = true;
    try {
      const id = use.dataset.imageUse;
      const blob = await (await api(`/images/${encodeURIComponent(id)}`)).blob();
      setImageQueue([{blob, name:`${id}`, mime:use.dataset.imageMime, uploaded:{id, path:use.dataset.imagePath}}]);
    } catch (error) { toast(error,true); }
    finally { use.disabled = false; }
  }
  if (remove) {
    remove.disabled = true;
    try {
      const id = remove.dataset.imageDelete;
      await api(`/images/${encodeURIComponent(id)}`, { method:'DELETE' });
      imageQueue.forEach(item => { if (item.uploaded && item.uploaded.id === id) item.uploaded = null; });
      toast(t('Imagem apagada do PC.')); loadRecentImages();
    } catch (error) { toast(error,true); remove.disabled = false; }
  }
});
window.addEventListener('ponte-native-shared', receiveSharedImages);
receiveSharedImages();

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
  agentAlertsForget();
  if (screenshotURL) URL.revokeObjectURL(screenshotURL);
  screenshotURL = null; $('#screen-image').removeAttribute('src'); $('#screen-image').hidden = true; $('#screen-empty').hidden = false;
  for (const url of audioURLs.values()) URL.revokeObjectURL(url);
  audioURLs.clear(); audioLoaded = false; audioSignature = ''; workspaceSignature = ''; screenWorkspaceSignature = ''; windowSignature = ''; monitorSignature = '';
  $('#connection-dialog').close();
  history.replaceState(null,'',location.pathname+location.search);
  showPairing(); connectOverTailscale();
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
  const ownedText = '#toast,#pair-error,#record-error,#record-state,#record-hint,#install-hint,#connection-banner-text,#terminal-status,#image-result,#agent-reply-status';
  $$(ownedText).forEach(element => { element.textContent = t(element.textContent); });
  const bannerError = i18n.read($('#connection-banner-text'));
  setConnection(connected,bannerError);
  if (state) { renderedAllOnce = false; renderState(); updateCapabilities(); renderDesktopTerminals(); renderFleet(); }
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
  const signature = JSON.stringify([presets,lights?.preset,lights?.sleeping,lights?.incomplete,connected,i18n.language]);
  if (section.dataset.signature === signature) return;
  section.setAttribute('data-signature',signature);
  $('#lights-presets').innerHTML = presets.map(preset => `<button class="workspace lights-preset ${lights && !lights.sleeping && lights.preset === preset ? 'active' : ''}" data-action="lights.preset" data-preset="${escaped(preset)}" aria-pressed="${String(!!lights && !lights.sleeping && lights.preset === preset)}"${connected ? '' : ' disabled'}><span class="lights-swatch" data-preset="${escaped(preset)}"></span>${escaped(names[preset] || preset)}</button>`).join('');
  $('#lights-status').textContent = !lights ? t("Estado das luzes indisponível.") : lights.sleeping ? (lights.incomplete && lights.incomplete.length ? t('Luzes apagadas, menos: {devices}. Toque em Apagar luzes de novo ou em Restaurar luzes.',{devices:lights.incomplete.join(', ')}) : t("Luzes apagadas. Toque em um preset ou em Restaurar.")) : t('Luzes acesas no preset {preset}.',{preset:names[lights.preset] || lights.preset});
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
// Home "Start working": one request opens a phone text session already running
// Claude, Codex or a shell, then shows it on the Terminals page. The request is
// typed or dictated into the field first, so it can be reviewed before starting.
let startAgent = ['claude','codex','shell','ssh'].indexOf(savedPreference('ponte-start-agent')) >= 0 ? savedPreference('ponte-start-agent') : 'claude';
let startBusy = false;
let startProjectsToken = '', startProjects = [], startHosts = [];
// The session's place: a ~/Projects folder, or for SSH one of the machines the
// controlled device lists in its private config (ssh.hosts). Shared by Home and Dev.
function fillPlaceSelect(select, agent, projects, hosts) {
  if (agent === 'ssh') {
    const wanted = savedPreference('ponte-start-host');
    select.innerHTML = hosts.map(item => `<option value="${escaped(item.host)}">${escaped(item.label === item.host ? item.host : `${item.label} · ${item.host}`)}</option>`).join('');
    select.value = hosts.some(item => item.host === wanted) ? wanted : (hosts[0] ? hosts[0].host : '');
    return;
  }
  const wanted = savedPreference('ponte-start-project');
  select.innerHTML = `<option value="" data-i18n="Pasta pessoal (~)">${escaped(t('Pasta pessoal (~)'))}</option>${projects.map(name => `<option value="${escaped(name)}">${escaped(name)}</option>`).join('')}`;
  select.value = projects.indexOf(wanted) >= 0 ? wanted : '';
}
function savePlace(agent, value) { savePreference(agent === 'ssh' ? 'ponte-start-host' : 'ponte-start-project', value); }
// A saved SSH choice falls back to Terminal on a device without SSH machines.
const startAgentNow = () => startAgent === 'ssh' && !startHosts.length ? 'shell' : startAgent;
// Recent ~/Projects folders and SSH machines are fetched once per pairing and
// device, when Home shows.
async function loadStartProjects() {
  const key = `${token}|${targetNode}`;
  if (!token || startProjectsToken === key) return;
  const requestToken = startProjectsToken = key;
  try {
    const { projects, hosts } = await (await api('/terminals?projects=1',{timeout:8000})).json();
    if (requestToken !== `${token}|${targetNode}` || !Array.isArray(projects)) return;
    startProjects = projects; startHosts = Array.isArray(hosts) ? hosts : [];
    renderStartAgents(true);
  } catch { if (requestToken === `${token}|${targetNode}`) startProjectsToken = ''; }
}
$('#start-project').addEventListener('change',event => savePlace(startAgentNow(),event.target.value));
function renderStartAgents(refill = false) {
  const agent = startAgentNow();
  $('#start-ssh').hidden = !startHosts.length;
  $$('[data-start-agent]').forEach(button => button.setAttribute('aria-checked',String(button.dataset.startAgent === agent)));
  const label = $('#start-project-label'), place = agent === 'ssh' ? 'MÁQUINA' : 'PASTA';
  if (refill || label.getAttribute('data-i18n') !== place) { label.setAttribute('data-i18n', place); label.textContent = t(place); fillPlaceSelect($('#start-project'), agent, startProjects, startHosts); }
  $('#start-go').disabled = startBusy;
}
$$('[data-start-agent]').forEach(button => button.addEventListener('click',() => { startAgent = button.dataset.startAgent; savePreference('ponte-start-agent',startAgent); renderStartAgents(); }));
renderStartAgents();
$('#start-dictate').addEventListener('click',() => {
  toggleDictation($('#start-dictate'), $('#start-dictate-status'), async blob => {
    const text = await uploadDictation('/dictate', blob);
    if (text) { const box = $('#start-prompt'); box.value = box.value ? `${box.value} ${text}` : text; }
    return text;
  });
});
$('#start-go').addEventListener('click',async () => {
  if (startBusy) return;
  if (!connected || !token) { toast(t("Reconecte ao PC para usar este controle."), true); return; }
  // A shell (or an SSH session) runs its first line as typed, so it goes as one line.
  const agent = startAgentNow(), raw = $('#start-prompt').value;
  const prompt = (agent === 'shell' || agent === 'ssh' ? raw.replace(/\s*\n\s*/g,' ') : raw).trim();
  const body = {...devSessionSize(),agent};
  if (prompt) body.prompt = prompt;
  if ($('#start-project').value) body[agent === 'ssh' ? 'host' : 'project'] = $('#start-project').value;
  startBusy = true; renderStartAgents();
  dictationStatus($('#start-dictate-status'),'');
  const requestToken = token;
  try {
    const session = await (await api('/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    if (token !== requestToken) return;
    if ($('#start-prompt').value === raw) $('#start-prompt').value = '';
    toast(t('Abrindo {title}…',{title:session.title}));
    terminalSessions.push(session); selectTerminal(session.id); terminalPaused = false; navigate('terminais');
  } catch (error) { if (token === requestToken) dictationStatus($('#start-dictate-status'),error,true); }
  finally { startBusy = false; renderStartAgents(); }
});
window.addEventListener('popstate', () => { const page = location.hash.slice(1); if (token && page) navigate(page); });

// Dev: an agent terminal on the whole screen. It reads the same private tmux
// session as Terminals, with colours (format=ansi), sized to the phone's own
// character grid, and with the keys Claude Code uses a tap away.
const DEV_FONT_MIN = 9, DEV_FONT_MAX = 22, DEV_FONT_DEFAULT = 12, DEV_LINE_HEIGHT = 1.25;
const DEV_TEXT_LIMIT = 16000;
const ANSI_16 = ['#20231e','#e8766b','#a6d189','#e5c07b','#7fb4f0','#c9a0f0','#6fcfd6','#d7dccd','#6b7563','#ff9187','#c3f09a','#ffd68a','#9fcbff','#e1bcff','#8ee6ee','#ffffff'];
// xterm's 256 colours: 16 named, a 6×6×6 cube, then 24 greys.
function ansiColor(index) {
  if (index < 16) return ANSI_16[index];
  const hex = value => (value < 16 ? '0' : '') + value.toString(16);
  if (index < 232) { const n = index - 16, step = value => value ? value * 40 + 55 : 0; return `#${hex(step(Math.floor(n / 36)))}${hex(step(Math.floor(n / 6) % 6))}${hex(step(n % 6))}`; }
  const grey = 8 + (index - 232) * 10; return `#${hex(grey)}${hex(grey)}${hex(grey)}`;
}
function sgrApply(style, source) {
  const params = source === '' ? [0] : source.replace(/:/g,';').split(';').map(value => value === '' ? -1 : Number(value));
  for (let i = 0; i < params.length; i++) {
    const code = params[i] < 0 ? 0 : params[i];
    if (code === 0) { style.fg = style.bg = null; style.bold = style.dim = style.italic = style.underline = style.inverse = style.strike = false; }
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) style.bold = style.dim = false;
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.fg = ANSI_16[code - 30];
    else if (code === 39) style.fg = null;
    else if (code >= 40 && code <= 47) style.bg = ANSI_16[code - 40];
    else if (code === 49) style.bg = null;
    else if (code >= 90 && code <= 97) style.fg = ANSI_16[code - 82];
    else if (code >= 100 && code <= 107) style.bg = ANSI_16[code - 92];
    else if (code === 38 || code === 48) {
      let color = null;
      if (params[i + 1] === 5 && params[i + 2] >= 0 && params[i + 2] < 256) { color = ansiColor(params[i + 2]); i += 2; }
      else if (params[i + 1] === 2) {
        // 38;2;r;g;b, or the colon form 38:2::r:g:b with an empty colour space.
        let j = i + 2; if (params[j] === -1 && params.length - j > 3) j++;
        const rgb = [params[j], params[j + 1], params[j + 2]];
        if (rgb.every(value => value >= 0 && value < 256)) color = `rgb(${rgb.join(',')})`;
        i = j + 2;
      } else break;
      if (color) { if (code === 38) style.fg = color; else style.bg = color; }
    }
  }
}
function devStyle(style) {
  const fg = style.inverse ? (style.bg || 'var(--dev-bg)') : style.fg, bg = style.inverse ? (style.fg || 'var(--dev-fg)') : style.bg;
  const css = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (style.bold) css.push('font-weight:700');
  if (style.dim) css.push('opacity:.6');
  if (style.italic) css.push('font-style:italic');
  if (style.underline || style.strike) css.push(`text-decoration:${[style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].join(' ').trim()}`);
  return css.join(';');
}
// Terminal cells: wide East Asian characters and emoji take two, combining
// marks none. Enough to put the cursor where tmux says it is.
function devCellWidth(code) {
  if (code >= 0x300 && code <= 0x36f || code === 0x200d || code >= 0xfe00 && code <= 0xfe0f) return 0;
  if (code >= 0x1100 && code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe30 && code <= 0xfe4f || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300 && code <= 0x1faff || code >= 0x20000 && code <= 0x3fffd) return 2;
  return 1;
}
// Claude Code draws these symbols, which no font on the phone has (Droid Sans
// Mono, Roboto, Noto Symbols; ⏸ only as a wide colour emoji): each becomes a
// one-cell look-alike the phone can draw, so columns stay aligned.
const DEV_GLYPHS = {'\u23f4':'\u25c2','\u23f5':'\u25b8','\u23f6':'\u25b4','\u23f7':'\u25be','\u23f8':'\u2016','\u23fa':'\u25cf','\u23f9':'\u25a0','\u23bf':'\u2514'};
const DEV_GLYPH_PATTERN = /[\u23f4-\u23f8\u23fa\u23f9\u23bf]/g;
// Only SGR survives from the server; anything else that slips through is
// dropped, and every character is escaped before it becomes HTML.
function ansiToHtml(text, cursor, rows) {
  const lines = String(text || '').replace(/\n$/,'').split('\n');
  const cursorLine = cursor && cursor.visible && rows > 0 ? lines.length - rows + cursor.y : -1;
  return lines.map((line, index) => {
    const style = {fg:null,bg:null,bold:false,dim:false,italic:false,underline:false,inverse:false,strike:false};
    let html = '', column = 0, cursorDone = index !== cursorLine;
    const flush = (chunk, css) => { if (chunk) html += css ? `<span style="${css}">${escaped(chunk)}</span>` : escaped(chunk); };
    for (const part of line.split(/(\x1b\[[0-9;:]*m)/)) {
      if (/^\x1b\[[0-9;:]*m$/.test(part)) { sgrApply(style, part.slice(2,-1)); continue; }
      const clean = part.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[^[\]]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'').replace(DEV_GLYPH_PATTERN, ch => DEV_GLYPHS[ch]);
      const css = devStyle(style);
      if (cursorDone) { flush(clean, css); column += [...clean].reduce((sum, ch) => sum + devCellWidth(ch.codePointAt(0)), 0); continue; }
      let chunk = '';
      for (const ch of clean) {
        if (!cursorDone && column >= cursor.x) { flush(chunk, css); chunk = ''; html += `<span class="dev-cursor">${escaped(ch)}</span>`; cursorDone = true; column += devCellWidth(ch.codePointAt(0)); continue; }
        chunk += ch; column += devCellWidth(ch.codePointAt(0));
      }
      flush(chunk, css);
    }
    if (!cursorDone) html += `${' '.repeat(Math.max(0, cursor.x - column))}<span class="dev-cursor"> </span>`;
    return html;
  }).join('\n');
}
function devGrid(width, height, cellWidth, cellHeight) {
  if (!(width > 0 && height > 0 && cellWidth > 0 && cellHeight > 0)) return null;
  return { cols: Math.max(20, Math.min(240, Math.floor(width / cellWidth))), rows: Math.max(8, Math.min(100, Math.floor(height / cellHeight))) };
}
function devKeyPayload(button) {
  if (button.dataset.devKey) return { key: button.dataset.devKey };
  if (button.dataset.devText) return { text: button.dataset.devText };
  return null;
}
let devFont = Number(savedPreference('ponte-dev-font', String(DEV_FONT_DEFAULT)));
if (!(devFont >= DEV_FONT_MIN && devFont <= DEV_FONT_MAX)) devFont = DEV_FONT_DEFAULT;
let devId = '', devSessions = [], devHash = '', devHashId = '', devTimer, devGeneration = 0, devBusy = false;
let devLastInput = 0, devIdleDelay = 1000, devFollow = true, devGridNow = null, devPane = null, devBox = '', devResizeTimer, devAgent = 'claude', devProjects = [], devHosts = [], devProjectsToken = '';
function devVisible() { return currentPage === 'dev' && !!token && !document.hidden && !nativePaused; }
function devStatus(message, error = false) { dictationStatus($('#dev-status'), message, error); }
// The character grid the screen box holds at the current font, or an estimate
// from the window when Dev was never shown (the Home and Terminals buttons).
function devMeasure() {
  const screen = $('#dev-screen'), probe = $('#dev-measure');
  const box = probe && probe.getBoundingClientRect ? probe.getBoundingClientRect() : null;
  const cellWidth = box && box.width ? box.width / 20 : devFont * 0.6, cellHeight = box && box.height ? box.height : devFont * DEV_LINE_HEIGHT;
  if (screen && screen.clientWidth && screen.clientHeight) return devGrid(screen.clientWidth - 16, screen.clientHeight - 12, cellWidth, cellHeight);
  const width = Number(window.innerWidth), height = Number(window.visualViewport && window.visualViewport.height || window.innerHeight);
  return devGrid(Math.min(width, 1160) - 40, height - 300, cellWidth, cellHeight);
}
function devSessionSize() { return devMeasure() || {cols:40,rows:24}; }
function devSortSessions(sessions) {
  const rank = session => /^(Claude|Codex) /.test(session.title || '') ? 0 : 1;
  return sessions.slice().sort((a, b) => rank(a) - rank(b) || String(a.title).localeCompare(String(b.title)));
}
function devRenderSessions() {
  const select = $('#dev-session');
  select.innerHTML = devSessions.length ? devSessions.map(session => `<option value="${escaped(session.id)}">${escaped(session.title)}</option>`).join('') : `<option value="" data-i18n="Nenhuma sessão">${escaped(t('Nenhuma sessão'))}</option>`;
  select.value = devId;
  const project = savedPreference('ponte-start-project') || devProjects[0] || '';
  $('#dev-empty-label').textContent = t('Novo Claude em {project}',{project:project || '~'});
  $('#dev-empty').hidden = !!devId;
  ['#dev-open-pc','#dev-send','#dev-paste','#dev-dictate','#dev-attach'].forEach(selector => { $(selector).disabled = !devId; });
  $$('[data-dev-key],[data-dev-text]').forEach(button => { button.disabled = !devId; });
  $('#dev-font-down').disabled = devFont <= DEV_FONT_MIN; $('#dev-font-up').disabled = devFont >= DEV_FONT_MAX;
}
function devSelect(id) {
  devId = id; devHash = ''; devHashId = ''; devFollow = true;
  devPane = null; $('#dev-output').innerHTML = ''; devRenderSize(); $('#dev-live').hidden = true;
  if (id) savePreference('ponte-dev-session', id);
  devRenderSessions();
}
async function devLoadSessions() {
  try {
    const listing = await (await api('/terminals',{timeout:8000})).json();
    devSessions = devSortSessions(listing.sessions || []);
  } catch (error) { devStatus(error, true); return; }
  if (!devSessions.some(session => session.id === devId)) {
    const saved = savedPreference('ponte-dev-session');
    devSelect((devSessions.find(session => session.id === saved) || devSessions[0] || {}).id || '');
  } else devRenderSessions();
}
async function devLoadProjects() {
  const key = `${token}|${targetNode}`;
  if (!token || devProjectsToken === key) return;
  const requestToken = devProjectsToken = key;
  try {
    const { projects, hosts } = await (await api('/terminals?projects=1',{timeout:8000})).json();
    if (requestToken !== `${token}|${targetNode}` || !Array.isArray(projects)) return;
    devProjects = projects; devHosts = Array.isArray(hosts) ? hosts : [];
    if (devAgent === 'ssh' && !devHosts.length) devAgent = 'shell';
    devRenderAgents();
    devRenderSessions();
  } catch { if (requestToken === `${token}|${targetNode}`) devProjectsToken = ''; }
}
// Output is polled only while Dev is on screen: fast for a few seconds after
// each input, then 1 s, backing off to 3 s while nothing changes.
function devDelay() {
  if (Date.now() - devLastInput < 8000) return 350;
  return devIdleDelay;
}
function devSchedule(generation) {
  clearTimeout(devTimer);
  if (generation === devGeneration && devVisible()) devTimer = setTimeout(() => devRead(generation), devDelay());
}
async function devRead(generation) {
  if (generation !== devGeneration || !devVisible()) return;
  const id = devId, requestToken = token;
  if (!id) { devSchedule(generation); return; }
  try {
    const since = devHash && devHashId === id ? `&since=${encodeURIComponent(devHash)}` : '';
    const view = await (await api(`/terminals/${encodeURIComponent(id)}?format=ansi${since}`,{timeout:8000})).json();
    if (generation !== devGeneration || id !== devId || requestToken !== token || !devVisible()) return;
    if (view.cols && view.rows) { devPane = {id, cols:view.cols, rows:view.rows}; devRenderSize(); }
    if (view.unchanged === true || typeof view.text !== 'string') devIdleDelay = Math.min(3000, Math.round(devIdleDelay * 1.5));
    else {
      devIdleDelay = 1000;
      const screen = $('#dev-screen');
      $('#dev-output').innerHTML = ansiToHtml(view.text, view.cursor, view.rows);
      if (devFollow) screen.scrollTop = screen.scrollHeight;
    }
    devHash = view.hash || ''; devHashId = id;
  } catch (error) {
    if (generation !== devGeneration || requestToken !== token) return;
    if (error && (error.errorCode === 'TERMINAL_NOT_FOUND' || error.errorCode === 'TERMINAL_CHANGED')) { devSelect(''); devLoadSessions(); }
    else devStatus(error, true);
  }
  devSchedule(generation);
}
function updateDevNavigation() {
  clearTimeout(devTimer);
  const generation = ++devGeneration;
  if (!devVisible()) return;
  devApplyFont(); devLoadProjects();
  devLoadSessions().then(() => { devRefit(true); devRead(generation); });
}
function devApplyFont() {
  $('#page-dev').style.setProperty('--dev-font', `${devFont}px`);
  $('#dev-font-down').disabled = devFont <= DEV_FONT_MIN; $('#dev-font-up').disabled = devFont >= DEV_FONT_MAX;
}
// The pane takes the phone's grid only on the tab's own layout events: entering
// the tab, choosing a session, a tap on the size badge (forced), and rotating,
// the keyboard or the font (the grid changed). A read never resizes: a session
// opened on the PC follows the PC window until the phone asks for it back.
function devRefit(force = false) {
  const grid = devMeasure();
  if (!grid) return;
  const changed = !devGridNow || grid.cols !== devGridNow.cols || grid.rows !== devGridNow.rows;
  devGridNow = grid;
  devRenderSize();
  if (changed || force) devQueueResize();
}
// The badge shows the pane size; when it is not the phone's grid (the PC
// window sized it) the lines scroll sideways and a tap fits the pane back.
function devRenderSize() {
  const badge = $('#dev-size'), pane = devPane && devPane.id === devId ? devPane : null, grid = devGridNow;
  const other = !!(pane && grid && (pane.cols !== grid.cols || pane.rows !== grid.rows));
  const size = pane ? `${pane.cols}×${pane.rows}` : '';
  badge.textContent = !other ? size : pane.cols > grid.cols || pane.rows > grid.rows ? t('PC {size} · ajustar',{size}) : t('{size} · ajustar',{size});
  badge.disabled = !other;
  badge.classList.toggle('dev-size-other', other);
}
function devQueueResize() {
  clearTimeout(devResizeTimer);
  devResizeTimer = setTimeout(async () => {
    const id = devId, grid = devGridNow;
    if (!id || !grid || !devVisible()) return;
    const session = devSessions.find(item => item.id === id), pane = devPane && devPane.id === id ? devPane : session;
    if (pane && pane.cols === grid.cols && pane.rows === grid.rows) return;
    try {
      await api(`/terminals/${encodeURIComponent(id)}/resize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(grid)});
      if (session) { session.cols = grid.cols; session.rows = grid.rows; }
      if (devId === id) { devPane = {id, cols:grid.cols, rows:grid.rows}; devRenderSize(); }
      devHash = ''; devLastInput = Date.now();
    } catch (error) { devStatus(error, true); }
  }, 300);
}
async function devInput(body) {
  const id = devId;
  if (!id || !connected || !token) return false;
  devLastInput = Date.now();
  try {
    await api(`/terminals/${encodeURIComponent(id)}/input`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    devStatus('');
    devFollow = true; devSchedule(devGeneration);
    return true;
  } catch (error) {
    devStatus(error, true);
    return false;
  }
}
function devGrow() {
  const box = $('#dev-input');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight || 0, 5 * 22 + 20)}px`;
}
async function devSend(withEnter) {
  const box = $('#dev-input'), typed = box.value, text = typed.replace(/\r\n?/g,'\n').replace(/\n+$/,'');
  if (!devId || devBusy || !text.trim()) return;
  if (text.length > DEV_TEXT_LIMIT) { devStatus(t('Texto longo demais: até {max} caracteres.',{max:DEV_TEXT_LIMIT}), true); return; }
  devBusy = true;
  const sent = await devInput(withEnter ? {text, enter:true} : {text});
  devBusy = false;
  if (sent && box.value === typed) { box.value = ''; devGrow(); }
}
async function devCreate(agent, project) {
  if (devBusy || !connected || !token) return;
  devBusy = true; devStatus('');
  const body = {...devSessionSize(), agent};
  if (project) body[agent === 'ssh' ? 'host' : 'project'] = project;
  try {
    const session = await (await api('/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
    devSessions = devSortSessions(devSessions.concat([session]));
    $('#dev-new-panel').hidden = true; $('#dev-new').setAttribute('aria-expanded','false');
    devSelect(session.id); devLastInput = Date.now(); devSchedule(devGeneration);
  } catch (error) { devStatus(error, true); }
  finally { devBusy = false; }
}
function devRenderAgents() {
  $('#dev-ssh').hidden = !devHosts.length;
  $$('[data-dev-agent]').forEach(button => button.setAttribute('aria-checked',String(button.dataset.devAgent === devAgent)));
  fillPlaceSelect($('#dev-project'), devAgent, devProjects, devHosts);
}
$('#dev-session').addEventListener('change', event => { devSelect(event.target.value); updateDevNavigation(); });
$('#dev-size').addEventListener('click', () => devRefit(true));
$('#dev-status').addEventListener('click', () => devStatus(''));
$('#dev-new').addEventListener('click', () => { const panel = $('#dev-new-panel'); panel.hidden = !panel.hidden; $('#dev-new').setAttribute('aria-expanded',String(!panel.hidden)); devLoadProjects(); });
$$('[data-dev-agent]').forEach(button => button.addEventListener('click', () => { devAgent = button.dataset.devAgent; devRenderAgents(); }));
$('#dev-project').addEventListener('change', event => savePlace(devAgent, event.target.value));
$('#dev-create').addEventListener('click', () => devCreate(devAgent, $('#dev-project').value));
$('#dev-empty-start').addEventListener('click', () => devCreate('claude', savedPreference('ponte-start-project') || devProjects[0] || ''));
$('#dev-keys').addEventListener('click', event => {
  const button = event.target.closest('[data-dev-key],[data-dev-text]');
  const payload = button && devKeyPayload(button);
  if (!payload || button.disabled) return;
  try { if (navigator.vibrate) navigator.vibrate(8); } catch {}
  devInput(payload);
});
$('#dev-send').addEventListener('click', () => devSend(true));
$('#dev-paste').addEventListener('click', () => devSend(false));
$('#dev-input').addEventListener('input', devGrow);
$('#dev-dictate').addEventListener('click', () => {
  toggleDictation($('#dev-dictate'), $('#dev-status'), async blob => {
    // As in Terminals: the transcript lands in the field to review, not in the agent.
    const text = await uploadDictation('/dictate', blob);
    if (text) { const box = $('#dev-input'); box.value = box.value ? `${box.value} ${text}` : text; devGrow(); }
    return text;
  });
});
$('#dev-attach').addEventListener('click', () => $('#dev-file').click());
$('#dev-file').addEventListener('change', async event => {
  const file = event.target.files && event.target.files[0], id = devId;
  event.target.value = '';
  if (!file || !id) return;
  if (IMAGE_TYPES.indexOf(file.type) < 0) { devStatus(i18n.apiMessage('UNSUPPORTED_IMAGE_FORMAT'), true); return; }
  if (file.size > IMAGE_MAX_BYTES) { devStatus(i18n.apiMessage('IMAGE_TOO_LARGE'), true); return; }
  devStatus(t('Enviando imagem…'));
  try {
    const uploaded = await (await api('/images',{method:'POST',headers:{'Content-Type':file.type},body:file,timeout:90000})).json();
    await api(`/images/${encodeURIComponent(uploaded.id)}/paste`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({terminal:id})});
    devStatus(t('Imagem anexada: o caminho foi colado na sessão.'));
    devLastInput = Date.now(); devSchedule(devGeneration);
  } catch (error) { devStatus(imageFailure(error), true); }
});
$('#dev-font-down').addEventListener('click', () => { devFont = Math.max(DEV_FONT_MIN, devFont - 1); savePreference('ponte-dev-font', String(devFont)); devApplyFont(); devRefit(); });
$('#dev-font-up').addEventListener('click', () => { devFont = Math.min(DEV_FONT_MAX, devFont + 1); savePreference('ponte-dev-font', String(devFont)); devApplyFont(); devRefit(); });
// Only a finger (or wheel) stops following the output; a box that changed
// size (rotation, keyboard) keeps following and snaps back to the end.
let devTouchedAt = 0;
['touchstart','wheel','pointerdown'].forEach(name => $('#dev-screen').addEventListener(name, () => { devTouchedAt = Date.now(); }, {passive:true}));
$('#dev-screen').addEventListener('scroll', () => {
  const screen = $('#dev-screen');
  const atEnd = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 8;
  if (atEnd) devFollow = true;
  else if (Date.now() - devTouchedAt < 1500) devFollow = false;
  else if (devFollow) screen.scrollTop = screen.scrollHeight;
  $('#dev-live').hidden = devFollow;
});
$('#dev-live').addEventListener('click', () => { const screen = $('#dev-screen'); devFollow = true; screen.scrollTop = screen.scrollHeight; $('#dev-live').hidden = true; });
// The window lands on the owner's screen, so each session asks once; the
// sessions already confirmed are remembered (the newest 16 ids).
function devOpenConfirmed() {
  let ids; try { ids = JSON.parse(savedPreference('ponte-dev-open-ok', '[]')); } catch { ids = []; }
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)) : [];
}
async function devOpenOnPc() {
  const id = devId;
  if (!id) return;
  const confirmed = devOpenConfirmed().filter(other => other !== id);
  savePreference('ponte-dev-open-ok', JSON.stringify(confirmed.concat(id).slice(-16)));
  try { await api(`/terminals/${encodeURIComponent(id)}/open`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); devStatus(t('Aberta numa janela do PC.')); }
  catch (error) { devStatus(error, true); }
}
$('#dev-open-pc').addEventListener('click', () => {
  if (!devId) return;
  if (devOpenConfirmed().indexOf(devId) >= 0) devOpenOnPc();
  else $('#dev-open-dialog').showModal();
});
$('#dev-open-cancel').addEventListener('click', () => $('#dev-open-dialog').close());
$('#dev-open-confirm').addEventListener('click', () => { $('#dev-open-dialog').close(); devOpenOnPc(); });
// Scrollbars coming and going (a wider PC pane) change the content box but not
// the box itself, so they never count as a layout change.
if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
  if (!devVisible()) return;
  const screen = $('#dev-screen'), box = `${screen.offsetWidth}×${screen.offsetHeight}`;
  if (devFollow) screen.scrollTop = screen.scrollHeight;
  if (box !== devBox) { devBox = box; devRefit(); }
}).observe($('#dev-screen'));
window.addEventListener('resize', () => { if (devVisible()) devRefit(); });
document.addEventListener('visibilitychange', updateDevNavigation);
window.addEventListener('pagehide', () => { clearTimeout(devTimer); devGeneration++; });
window.addEventListener('ponte-native-resume', updateDevNavigation);
devApplyFont(); devRenderAgents(); devRenderSessions();

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
  agentAlertsSync(); agentOpenFromNative();
  pollState();
}
updateInstalledState();
if (token) enterApp();
else { showPairing(); connectOverTailscale(); }
setInterval(pollState,4000);
// No service worker: a live remote gains nothing from an offline cache and a
// stale one only pinned old code. Register the kill-switch sw once to evict any
// worker a previous build left behind, then rely on the network from then on.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.getRegistrations?.().then(regs => {
    if (regs && regs.length) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }).catch(() => {});
  try { caches?.keys?.().then(keys => keys.filter(key => key.startsWith('ponte-static-')).forEach(key => caches.delete(key))); } catch {}
}

// Ponte mobile shortcuts: a configurable palette of Omarchy system shortcuts
// (Super combos) and safe preset actions, kept apart from the terminal key
// bar. It never encodes terminal input and never types the word "Super":
// every combo leaves as one `keyboard.combo` desktop action, which the server
// presses and releases in a single call (backend/desktop.mjs), so no key can
// stay held on the PC. Integration hooks: see docs/mobile-shortcuts.md.
(function (root) {
  'use strict';
  const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];
  // Same names as the server's allowlist (backend/desktop.mjs COMBO_KEYS).
  const KEYS = [
    ...'QWERTYUIOPASDFGHJKLZXCVBNM1234567890'.split(''),
    'Return', 'Space', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Left', 'Right', 'Up', 'Down',
    'Comma', 'Period', 'Slash', 'Minus', 'Equal', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'Print',
  ];
  const KEY_LABELS = { Return: '⏎', Space: 'Espaço', Tab: 'Tab', Escape: 'Esc', BackSpace: '⌫', Delete: 'Del', Left: '←', Right: '→', Up: '↑', Down: '↓', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=', Print: 'Print' };
  const COMBO = /^Super(\+Ctrl)?(\+Alt)?(\+Shift)?\+([A-Za-z0-9]{1,9})$/;

  // The one canonical form: Super first, then Ctrl, Alt, Shift, then the key.
  function comboOf(modifiers, key) {
    const held = new Set(modifiers || []);
    if ([...held].some(name => !MODIFIERS.includes(name)) || !KEYS.includes(key)) throw new Error('COMBO_NOT_ALLOWED');
    return ['Super', ...MODIFIERS.filter(name => held.has(name)), key].join('+');
  }
  function parseCombo(combo) {
    const match = typeof combo === 'string' ? COMBO.exec(combo) : null;
    if (!match || !KEYS.includes(match[4])) return null;
    return { modifiers: MODIFIERS.filter((_, i) => match[i + 1]), key: match[4] };
  }
  const isCombo = combo => !!parseCombo(combo);
  const comboLabel = combo => {
    const parsed = parseCombo(combo);
    if (!parsed) return '';
    return ['Super', ...parsed.modifiers, KEY_LABELS[parsed.key] || parsed.key].join(' + ');
  };

  // Defaults: Omarchy binds as read from `hyprctl -j binds` on 2026-10-20
  // (labels are the bind descriptions, in Portuguese). Order = menu order:
  // the five Lucas asked for first. Not a usage ranking; there is no sensor.
  const DEFAULT_SHORTCUTS = Object.freeze([
    { id: 'fullscreen', combo: 'Super+F', label: 'Tela cheia', group: 'janela' },
    { id: 'close', combo: 'Super+W', label: 'Fechar janela ou encerrar bancada', group: 'janela' },
    { id: 'move-ws-1', combo: 'Super+Shift+1', label: 'Mover janela para o workspace 1', group: 'workspace' },
    { id: 'move-ws-2', combo: 'Super+Shift+2', label: 'Mover janela para o workspace 2', group: 'workspace' },
    { id: 'apps', combo: 'Super+Space', label: 'Menu de apps', group: 'apps' },
    { id: 'terminal', combo: 'Super+Return', label: 'Terminal', group: 'apps' },
    { id: 'ws-1', combo: 'Super+1', label: 'Ir para o workspace 1', group: 'workspace' },
    { id: 'ws-2', combo: 'Super+2', label: 'Ir para o workspace 2', group: 'workspace' },
    { id: 'ws-3', combo: 'Super+3', label: 'Ir para o workspace 3', group: 'workspace' },
    { id: 'move-ws-3', combo: 'Super+Shift+3', label: 'Mover janela para o workspace 3', group: 'workspace' },
    { id: 'ws-next', combo: 'Super+Tab', label: 'Próximo workspace', group: 'workspace' },
    { id: 'ws-former', combo: 'Super+Ctrl+Tab', label: 'Workspace anterior (último usado)', group: 'workspace' },
    { id: 'focus-left', combo: 'Super+Left', label: 'Focar janela à esquerda', group: 'janela' },
    { id: 'focus-right', combo: 'Super+Right', label: 'Focar janela à direita', group: 'janela' },
    { id: 'float', combo: 'Super+T', label: 'Alternar janela flutuante/lado a lado', group: 'janela' },
    { id: 'split', combo: 'Super+J', label: 'Alternar divisão da janela', group: 'janela' },
    { id: 'scratchpad', combo: 'Super+S', label: 'Alternar scratchpad', group: 'janela' },
    { id: 'browser', combo: 'Super+Shift+B', label: 'Navegador', group: 'apps' },
    { id: 'files', combo: 'Super+Shift+F', label: 'Gerenciador de arquivos', group: 'apps' },
    { id: 'copy', combo: 'Super+C', label: 'Copiar (universal)', group: 'apps' },
    { id: 'paste', combo: 'Super+V', label: 'Colar (universal)', group: 'apps' },
    { id: 'system-menu', combo: 'Super+Escape', label: 'Menu do sistema', group: 'sistema' },
    { id: 'keybindings', combo: 'Super+K', label: 'Lista de atalhos', group: 'sistema' },
    { id: 'dismiss', combo: 'Super+Comma', label: 'Dispensar a última notificação', group: 'sistema' },
  ]);
  const GROUPS = [['janela', 'Janela'], ['workspace', 'Workspaces'], ['apps', 'Apps'], ['sistema', 'Sistema'], ['meus', 'Meus atalhos']];
  // Preset actions: a fixed id the server maps to a fixed program. No prompt,
  // no text, no wildcard ever reaches it from here.
  const PRESET_ACTIONS = Object.freeze([
    { id: 'open-pi', label: 'Abrir terminal com Pi', group: 'acoes', terminal: Object.freeze({ agent: 'pi' }) },
  ]);
  const CUSTOM_LIMIT = 24;
  const STORAGE_KEY = 'ponte-shortcuts';

  // A catalog = defaults (minus hidden ids) + the user's own combos. Only
  // ids, combos and short labels are kept; nothing sensitive is stored.
  function createCatalog(saved) {
    const config = { hidden: [], custom: [] };
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.hidden)) config.hidden = saved.hidden.filter(id => DEFAULT_SHORTCUTS.some(item => item.id === id));
      if (Array.isArray(saved.custom)) for (const item of saved.custom.slice(0, CUSTOM_LIMIT)) {
        const label = typeof item?.label === 'string' ? item.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
        if (isCombo(item?.combo) && !config.custom.some(other => other.combo === item.combo)) config.custom.push({ id: `custom-${config.custom.length}`, combo: item.combo, label: label || comboLabel(item.combo), group: 'meus' });
      }
    }
    return {
      config,
      items: () => [...DEFAULT_SHORTCUTS.filter(item => !config.hidden.includes(item.id)), ...config.custom],
      add(combo, label) {
        if (!isCombo(combo)) throw new Error('COMBO_NOT_ALLOWED');
        if (config.custom.length >= CUSTOM_LIMIT) throw new Error('CUSTOM_LIMIT');
        if (!config.custom.some(item => item.combo === combo)) config.custom.push({ id: `custom-${config.custom.length}`, combo, label: String(label || '').trim().slice(0, 60) || comboLabel(combo), group: 'meus' });
      },
      hide(id) { if (DEFAULT_SHORTCUTS.some(item => item.id === id) && !config.hidden.includes(id)) config.hidden.push(id); },
      serialize: () => JSON.stringify({ hidden: config.hidden, custom: config.custom.map(({ combo, label }) => ({ combo, label })) }),
    };
  }

  // The request bodies the app sends; the module never calls fetch itself.
  const comboAction = combo => { if (!isCombo(combo)) throw new Error('COMBO_NOT_ALLOWED'); return { type: 'keyboard.combo', combo }; };
  function presetRequest(id, target, { cols = 80, rows = 24 } = {}) {
    const preset = PRESET_ACTIONS.find(item => item.id === id);
    if (!preset) throw new Error('ACTION_NOT_ALLOWED');
    if (!target || typeof target.name !== 'string' || !target.name) throw new Error('TARGET_REQUIRED');
    return { method: 'POST', path: '/terminals', node: typeof target.id === 'string' ? target.id : '', body: { cols, rows, ...preset.terminal } };
  }

  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // Mount the Super button + palette inside `host`. The app supplies:
  //   send(action)        -> Promise; posts {type:'keyboard.combo', combo} to /api/action (the app's actionResult)
  //   openPreset(request) -> Promise; POSTs request.body to /api/terminals on request.node via the app's api()
  //   target()            -> {id,name} of the machine the phone is driving ('' id = this PC), or null
  //   storage             -> optional localStorage-like object for the user's catalog
  function mountShortcuts(host, { send, openPreset, target, storage, onStatus } = {}) {
    if (!host || typeof send !== 'function') throw new Error('SHORTCUTS_MOUNT');
    let saved = null;
    try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
    const catalog = createCatalog(saved);
    const draft = new Set();
    let busy = false;
    const status = text => { const line = host.querySelector('[data-shortcut-status]'); if (line) line.textContent = text; onStatus?.(text); };
    const persist = () => { try { storage?.setItem(STORAGE_KEY, catalog.serialize()); } catch {} };

    function render(open) {
      const items = catalog.items();
      const groups = GROUPS.map(([id, title]) => {
        const rows = items.filter(item => item.group === id);
        if (!rows.length) return '';
        return `<section class="shortcut-group"><h3>${escape(title)}</h3>${rows.map(item =>
          `<button type="button" class="shortcut-item" data-combo="${escape(item.combo)}" aria-label="${escape(item.label)} (${escape(comboLabel(item.combo))})"><span>${escape(item.label)}</span><kbd>${escape(comboLabel(item.combo))}</kbd></button>`).join('')}</section>`;
      }).join('');
      const where = target?.();
      const actions = PRESET_ACTIONS.map(action =>
        `<button type="button" class="shortcut-item shortcut-action" data-preset="${escape(action.id)}"${where ? '' : ' disabled'}><span>${escape(action.label)}</span><kbd>${escape(where ? where.name : 'sem máquina')}</kbd></button>`).join('');
      const mods = MODIFIERS.map(name => `<button type="button" class="shortcut-mod" data-mod="${name}" aria-pressed="${draft.has(name)}">${name}</button>`).join('');
      const keys = KEYS.map(key => `<option value="${key}">${escape(KEY_LABELS[key] || key)}</option>`).join('');
      host.innerHTML =
        `<button type="button" class="shortcut-super" data-shortcut-super aria-expanded="${!!open}" aria-controls="shortcut-palette">⌘ Atalhos</button>` +
        `<div id="shortcut-palette" class="shortcut-palette" role="dialog" aria-label="Atalhos do sistema"${open ? '' : ' hidden'}>` +
        `<p class="shortcut-status" data-shortcut-status aria-live="polite"></p>` +
        `<section class="shortcut-group"><h3>Ações</h3>${actions}</section>${groups}` +
        `<details class="shortcut-compose"><summary>Montar atalho</summary><div class="shortcut-mods">${mods}</div>` +
        `<select data-shortcut-key aria-label="Tecla">${keys}</select>` +
        `<button type="button" class="shortcut-item" data-shortcut-send>Enviar Super + …</button>` +
        `<button type="button" class="shortcut-item" data-shortcut-save>Salvar em Meus atalhos</button></details></div>`;
    }

    async function run(combo) {
      if (busy) return;
      busy = true; status(`Enviando ${comboLabel(combo)}…`);
      try { await send(comboAction(combo)); status(`Enviado: ${comboLabel(combo)}`); }
      catch (error) { status(`Falhou: ${error?.message || error}`); }
      finally { busy = false; }
    }
    const draftCombo = () => comboOf([...draft], host.querySelector('[data-shortcut-key]')?.value || 'Q');

    host.addEventListener('click', async event => {
      const button = event.target?.closest?.('button');
      if (!button || button.disabled) return;
      const palette = host.querySelector('.shortcut-palette');
      const flag = name => button.getAttribute(name) !== null;
      if (flag('data-shortcut-super')) {
        const open = palette?.hidden ?? true;
        render(open); return;
      }
      const data = button.dataset || {};
      if (data.combo) return run(data.combo);
      if (data.mod) { draft.has(data.mod) ? draft.delete(data.mod) : draft.add(data.mod); button.setAttribute('aria-pressed', String(draft.has(data.mod))); return; }
      if (data.preset) {
        if (busy) return;
        const where = target?.();
        let request;
        try { request = presetRequest(data.preset, where); } catch (error) { status(error.message === 'TARGET_REQUIRED' ? 'Escolha a máquina antes.' : error.message); return; }
        busy = true; status(`Abrindo em ${where.name}…`);
        try { await openPreset(request); status(`Aberto em ${where.name}.`); }
        catch (error) { status(`Falhou: ${error?.message || error}`); }
        finally { busy = false; }
        return;
      }
      if (flag('data-shortcut-send')) return run(draftCombo());
      if (flag('data-shortcut-save')) {
        try { catalog.add(draftCombo()); persist(); render(true); status('Salvo em Meus atalhos.'); }
        catch (error) { status(error.message); }
      }
    });
    render(false);
    return { catalog, open: () => render(true), close: () => render(false), refresh: () => render(!(host.querySelector('.shortcut-palette')?.hidden ?? true)) };
  }

  root.PonteShortcuts = { MODIFIERS, KEYS, DEFAULT_SHORTCUTS, PRESET_ACTIONS, GROUPS, STORAGE_KEY, CUSTOM_LIMIT, comboOf, parseCombo, isCombo, comboLabel, createCatalog, comboAction, presetRequest, mountShortcuts };
})(typeof window !== 'undefined' ? window : globalThis);

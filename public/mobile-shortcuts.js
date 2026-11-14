// Shared keyboard contract. Node and the WebView load this same file.
(function (root) {
  'use strict';
  const modifierCodes = Object.freeze({ Super: 125, Ctrl: 29, Alt: 56, Shift: 42 });
  const keyCodes = Object.freeze({
    ...Object.fromEntries('QWERTYUIOP'.split('').map((key, i) => [key, 16 + i])),
    ...Object.fromEntries('ASDFGHJKL'.split('').map((key, i) => [key, 30 + i])),
    ...Object.fromEntries('ZXCVBNM'.split('').map((key, i) => [key, 44 + i])),
    ...Object.fromEntries('1234567890'.split('').map((key, i) => [key, 2 + i])),
    Return: 28, Space: 57, Tab: 15, Escape: 1, BackSpace: 14, Delete: 111,
    Left: 105, Right: 106, Up: 103, Down: 108, Home: 102, End: 107, PageUp: 104, PageDown: 109,
    Comma: 51, Period: 52, Slash: 53, Minus: 12, Equal: 13,
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`F${i + 1}`, 59 + i])), F11: 87, F12: 88, Print: 99,
  });
  const MODIFIERS = Object.freeze(Object.keys(modifierCodes)), KEYS = Object.freeze(Object.keys(keyCodes));
  const KEY_LABELS = { Return: 'Enter', Space: 'Espaço', Escape: 'Esc', BackSpace: '⌫', Delete: 'Del', Left: '←', Right: '→', Up: '↑', Down: '↓', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=' };
  function comboOf(modifiers, key) {
    if (!Array.isArray(modifiers) || !Object.prototype.hasOwnProperty.call(keyCodes, key) || modifiers.some(m => !MODIFIERS.includes(m)) || new Set(modifiers).size !== modifiers.length) throw Error('COMBO_NOT_ALLOWED');
    return [...MODIFIERS.filter(m => modifiers.includes(m)), key].join('+');
  }
  function parseCombo(combo) {
    if (typeof combo !== 'string' || combo.length > 48) return null;
    const parts = combo.split('+'), key = parts.pop();
    try { if (comboOf(parts, key) !== combo) return null; } catch { return null; }
    return { modifiers: parts, key };
  }
  const isCombo = combo => !!parseCombo(combo);
  const comboLabel = combo => { const parsed = parseCombo(combo); return parsed ? [...parsed.modifiers, KEY_LABELS[parsed.key] || parsed.key].join(' + ') : ''; };
  function codes(combo) {
    const parsed = parseCombo(combo);
    if (!parsed) throw Error('COMBO_NOT_ALLOWED');
    return [...parsed.modifiers.map(m => modifierCodes[m]), keyCodes[parsed.key]];
  }
  root.PonteCombo = Object.freeze({ MODIFIERS, KEYS, KEY_LABELS, comboOf, parseCombo, isCombo, comboLabel, codes });
})(typeof window !== 'undefined' ? window : globalThis);

// Ponte mobile shortcuts: a configurable palette of Omarchy system shortcuts
// (Super combos) and safe preset actions, kept apart from the terminal key
// bar. It never encodes terminal input and never types the word "Super":
// every combo leaves as one `keyboard.combo` desktop action, which the server
// presses and releases in a single call (backend/desktop.mjs), so no key can
// stay held on the PC. Integration hooks: see docs/mobile-shortcuts.md.
(function (root) {
  'use strict';
  const { MODIFIERS, KEYS, KEY_LABELS, comboOf, parseCombo, isCombo, comboLabel } = root.PonteCombo;

  // Defaults: Omarchy binds as read from `hyprctl -j binds` on 2026-10-20
  // (labels are the bind descriptions, in Portuguese). Order = menu order:
  // the five Lucas asked for first. Not a usage ranking; there is no sensor.
  const DEFAULT_SHORTCUTS = Object.freeze([
    { id: 'fullscreen', combo: 'Super+F', label: 'Tela cheia', group: 'principais' },
    { id: 'close', combo: 'Super+W', label: 'Fechar janela ou encerrar bancada', group: 'principais' },
    { id: 'move-ws-1', combo: 'Super+Shift+1', label: 'Mover janela para o workspace 1', group: 'principais' },
    { id: 'move-ws-2', combo: 'Super+Shift+2', label: 'Mover janela para o workspace 2', group: 'principais' },
    { id: 'apps', combo: 'Super+Space', label: 'Menu de apps', group: 'principais' },
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
  const GROUPS = [['principais', 'Principais'], ['janela', 'Janela'], ['workspace', 'Workspaces'], ['apps', 'Apps'], ['sistema', 'Sistema'], ['meus', 'Meus atalhos']];
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
        if (isCombo(item?.combo) && !config.custom.some(other => other.combo === item.combo) && !DEFAULT_SHORTCUTS.some(other => other.combo === item.combo && !config.hidden.includes(other.id))) config.custom.push({ id: `custom-${config.custom.length}`, combo: item.combo, label: label || comboLabel(item.combo), group: 'meus' });
      }
    }
    let sequence = config.custom.length;
    const items = () => [...DEFAULT_SHORTCUTS.filter(item => !config.hidden.includes(item.id)), ...config.custom];
    return {
      config,
      items,
      add(combo, label, id = '') {
        if (!isCombo(combo)) throw new Error('COMBO_NOT_ALLOWED');
        if (items().some(item => item.combo === combo && item.id !== id)) throw new Error('DUPLICATE_COMBO');
        const existing = config.custom.find(item => item.id === id);
        if (!existing && config.custom.length >= CUSTOM_LIMIT) throw new Error('CUSTOM_LIMIT');
        const clean = String(label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || comboLabel(combo);
        if (existing) { existing.combo = combo; existing.label = clean; }
        else {
          if (DEFAULT_SHORTCUTS.some(item => item.id === id) && !config.hidden.includes(id)) config.hidden.push(id);
          while (config.custom.some(item => item.id === `custom-${sequence}`)) sequence++;
          config.custom.push({ id: `custom-${sequence++}`, combo, label: clean, group: 'meus' });
        }
      },
      remove(id) {
        const index = config.custom.findIndex(item => item.id === id);
        if (index >= 0) config.custom.splice(index, 1);
        else if (DEFAULT_SHORTCUTS.some(item => item.id === id) && !config.hidden.includes(id)) config.hidden.push(id);
      },
      hide(id) { this.remove(id); },
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
    let catalog = createCatalog(saved);
    const draft = new Set(['Super']);
    let busy = false, editing = null, query = '';
    const status = text => { const line = host.querySelector('[data-shortcut-status]'); if (line) line.textContent = text; onStatus?.(text); };
    const errorText = error => ({ DUPLICATE_COMBO: 'Essa combinação já está na lista.', CUSTOM_LIMIT: 'Limite de 24 atalhos próprios.', COMBO_NOT_ALLOWED: 'Escolha modificadores e uma tecla válida.', STORAGE_FAILED: 'Não foi salvo. O armazenamento deste navegador está indisponível.' }[error.message] || error.message);
    const persist = mutate => {
      const next = createCatalog(JSON.parse(catalog.serialize()));
      next.config.custom.forEach(item => { item.id = catalog.config.custom.find(old => old.combo === item.combo)?.id || item.id; });
      mutate(next);
      try { if (!storage) throw Error(); storage.setItem(STORAGE_KEY, next.serialize()); }
      catch { throw Error('STORAGE_FAILED'); }
      catalog = next;
    };

    function render(open) {
      const items = catalog.items().filter(item => `${item.label} ${item.combo}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const groups = GROUPS.map(([id, title]) => {
        const rows = items.filter(item => item.group === id);
        if (!rows.length) return '';
        return `<details class="shortcut-group"${id === 'principais' || id === 'meus' || query ? ' open' : ''}><summary>${escape(title)} · ${rows.length}</summary>${rows.map(item =>
          `<div class="shortcut-row"><button type="button" class="shortcut-item" data-combo="${escape(item.combo)}" aria-label="${escape(item.label)} (${escape(comboLabel(item.combo))})"><span>${escape(item.label)}</span><kbd>${escape(comboLabel(item.combo))}</kbd></button><button type="button" class="shortcut-edit" data-edit="${escape(item.id)}" aria-label="Editar ${escape(item.label)}">Editar</button></div>`).join('')}</details>`;
      }).join('');
      const where = target?.();
      const actions = PRESET_ACTIONS.map(action =>
        `<button type="button" class="shortcut-item shortcut-action" data-preset="${escape(action.id)}"${where ? '' : ' disabled'}><span>${escape(action.label)}</span><kbd>${escape(where ? where.name : 'sem máquina')}</kbd></button>`).join('');
      const mods = MODIFIERS.map(name => `<button type="button" class="shortcut-mod" data-mod="${name}" aria-pressed="${draft.has(name)}">${name}</button>`).join('');
      const keys = KEYS.map(key => `<option value="${key}">${escape(KEY_LABELS[key] || key)}</option>`).join('');
      host.innerHTML =
        `<button type="button" class="shortcut-super" data-shortcut-super aria-label="Atalhos" aria-expanded="${!!open}" aria-controls="shortcut-palette"><span class="shortcut-glyph" aria-hidden="true">⌘</span> <span>Atalhos</span></button>` +
        `<div id="shortcut-palette" class="shortcut-palette" role="dialog" aria-label="Atalhos do sistema"${open ? '' : ' hidden'}>` +
        `<div class="shortcut-heading"><strong>Atalhos</strong><button type="button" data-shortcut-new>Novo</button><button type="button" data-shortcut-close aria-label="Fechar atalhos">Fechar</button></div>` +
        `<p class="shortcut-status" data-shortcut-status aria-live="polite"></p>` +
        `<section class="shortcut-compose"${editing === null ? ' hidden' : ''}><label>Nome<input data-shortcut-name maxlength="60" value="${escape(editing?.label || 'Novo atalho')}"></label><div class="shortcut-mods">${mods}</div>` +
        `<label>Tecla<select data-shortcut-key aria-label="Tecla">${keys}</select></label><output data-shortcut-preview></output>` +
        `<div class="shortcut-editor-actions"><button type="button" data-shortcut-save>Salvar</button><button type="button" data-shortcut-send>Enviar</button>${editing?.id ? '<button type="button" data-shortcut-remove>Remover</button>' : ''}<button type="button" data-shortcut-cancel>Voltar</button></div></section>` +
        `<div class="shortcut-catalog"${editing !== null ? ' hidden' : ''}><label>Buscar atalho<input type="search" data-shortcut-search value="${escape(query)}"></label>${groups}<details class="shortcut-group"><summary>Ações do Ponte</summary>${actions}</details><p class="shortcut-origin">Presets do Ponte. Editar aqui não altera os atalhos do Omarchy.</p></div></div>`;
      host.querySelector('[data-shortcut-key]').value = editing?.key || 'F';
      updatePreview();
    }

    async function run(combo) {
      if (busy) return;
      busy = true; status(`Enviando ${comboLabel(combo)}…`);
      try { await send(comboAction(combo)); status(`Enviado: ${comboLabel(combo)}`); }
      catch (error) { status(`Falhou: ${error?.message || error}`); }
      finally { busy = false; }
    }
    const draftCombo = () => comboOf([...draft], host.querySelector('[data-shortcut-key]')?.value || 'F');
    function updatePreview() { host.querySelector('[data-shortcut-preview]').textContent = comboLabel(draftCombo()); }
    const close = () => { render(false); host.querySelector('[data-shortcut-super]').focus(); onStatus?.(''); };
    host.addEventListener('change', event => { if (event.target?.getAttribute('data-shortcut-key') !== null) updatePreview(); });
    host.addEventListener('input', event => {
      if (event.target?.getAttribute('data-shortcut-search') === null) return;
      query = event.target.value;
      render(true); host.querySelector('[data-shortcut-search]').focus();
    });
    host.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); event.stopPropagation(); } });

    host.addEventListener('click', async event => {
      const button = event.target?.closest?.('button');
      if (!button || button.disabled) return;
      const palette = host.querySelector('.shortcut-palette');
      const flag = name => button.getAttribute(name) !== null;
      if (flag('data-shortcut-super')) {
        const open = palette?.hidden ?? true;
        render(open); onStatus?.(''); return;
      }
      const data = button.dataset || {};
      if (flag('data-shortcut-close')) return close();
      if (flag('data-shortcut-new') || data.edit) {
        const item = catalog.items().find(item => item.id === data.edit);
        editing = item ? { ...item, ...parseCombo(item.combo) } : { label: 'Novo atalho', key: 'F' };
        draft.clear(); (editing.modifiers || ['Super']).forEach(m => draft.add(m));
        // A new shortcut opens with the placeholder name selected, so the first
        // key replaces it. An existing name is never selected: typing there
        // would wipe a name the person chose.
        render(true); const name = host.querySelector('[data-shortcut-name]'); name.focus(); if (!item) name.select?.(); return;
      }
      if (flag('data-shortcut-cancel')) { editing = null; render(true); return; }
      if (flag('data-shortcut-remove')) {
        try { persist(next => next.remove(editing.id)); editing = null; render(true); status('Atalho removido.'); }
        catch (error) { status(errorText(error)); }
        return;
      }
      if (data.combo) return run(data.combo);
      if (data.mod) { draft.has(data.mod) ? draft.delete(data.mod) : draft.add(data.mod); button.setAttribute('aria-pressed', String(draft.has(data.mod))); updatePreview(); return; }
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
        try {
          const combo = draftCombo(), label = host.querySelector('[data-shortcut-name]').value;
          persist(next => next.add(combo, label, editing?.id));
          editing = null; render(true); status('Salvo em Meus atalhos.');
        } catch (error) { status(errorText(error)); }
      }
    });
    render(false);
    return { get catalog() { return catalog; }, open: () => { render(true); onStatus?.(''); }, close, refresh: () => render(!(host.querySelector('.shortcut-palette')?.hidden ?? true)) };
  }

  root.PonteShortcuts = { MODIFIERS, KEYS, DEFAULT_SHORTCUTS, PRESET_ACTIONS, GROUPS, STORAGE_KEY, CUSTOM_LIMIT, comboOf, parseCombo, isCombo, comboLabel, createCatalog, comboAction, presetRequest, mountShortcuts };
})(typeof window !== 'undefined' ? window : globalThis);

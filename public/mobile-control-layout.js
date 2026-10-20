// Editable layout of the phone's floating controls and shortcut rows.
// Plain script (no build): defines globalThis.PonteControlLayout. Nothing here
// listens to touches until the owner enters the edit mode on purpose, so the
// remote drag and the pinch on the PC screen stay exactly as they were.
// Stored: ids and fractions only, never labels, typed text or tokens.
(function (root) {
  'use strict';
  const VERSION = 1;
  const PREFIX = 'ponte-control-layout.v1.';
  const ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
  const MAX_BYTES = 8192, MAX_ITEMS = 32, MAX_LIST = 64;
  const MARGIN = 8, GAP = 8, NUDGE = 8, DRAG_SLOP = 10, MIN_TARGET = 44;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
  const unit = value => clamp(value, 0, 1);

  function emptyState() { return { v: VERSION, pos: { portrait: {}, landscape: {} }, order: {} }; }
  function storageKey(layoutId, deviceId) {
    if (!ID_RE.test(String(layoutId || ''))) throw new TypeError('layoutId');
    return PREFIX + layoutId + (deviceId && ID_RE.test(String(deviceId)) ? `.${deviceId}` : '');
  }
  // Whatever is in storage (old, foreign, cut, edited by hand) comes back as a
  // valid state or as the default; it never throws.
  function parseStored(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_BYTES) return emptyState();
    try { return clean(JSON.parse(raw)); } catch { return emptyState(); }
  }
  // Keeps only the known shape: ids that match ID_RE, finite numbers in 0..1.
  function clean(data) {
    const state = emptyState();
    if (!data || typeof data !== 'object' || data.v !== VERSION) return state;
    for (const orientation of ['portrait', 'landscape']) {
      const source = data.pos && typeof data.pos === 'object' ? data.pos[orientation] : null;
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const id of Object.keys(source).slice(0, MAX_ITEMS)) {
        const at = source[id];
        if (ID_RE.test(id) && at && finite(at.x) && finite(at.y)) state.pos[orientation][id] = { x: unit(at.x), y: unit(at.y) };
      }
    }
    const order = data.order && typeof data.order === 'object' && !Array.isArray(data.order) ? data.order : {};
    for (const list of Object.keys(order).slice(0, MAX_ITEMS)) {
      if (!ID_RE.test(list) || !Array.isArray(order[list])) continue;
      const ids = [...new Set(order[list].filter(id => typeof id === 'string' && ID_RE.test(id)))].slice(0, MAX_LIST);
      if (ids.length) state.order[list] = ids;
    }
    return state;
  }
  function isEmpty(state) {
    return !Object.keys(state.pos.portrait).length && !Object.keys(state.pos.landscape).length && !Object.keys(state.order).length;
  }
  function serialize(state) {
    const text = JSON.stringify(clean({ v: VERSION, pos: state.pos, order: state.order }));
    return text.length > MAX_BYTES ? null : text;
  }
  function cloneState(state) { return clean(JSON.parse(JSON.stringify(state))); }
  const orientationOf = (width, height) => (width > height ? 'landscape' : 'portrait');

  // The rectangle the controls may use: the visual viewport minus the system
  // insets (notch, gesture bar), a margin, and whatever must stay uncovered
  // (bottom nav, typing bar, the edit bar itself).
  function safeArea({ width, height, offsetTop = 0, offsetLeft = 0, insets = {}, avoid = [] }) {
    const area = {
      left: offsetLeft + (insets.left || 0) + MARGIN, top: offsetTop + (insets.top || 0) + MARGIN,
      right: offsetLeft + width - (insets.right || 0) - MARGIN, bottom: offsetTop + height - (insets.bottom || 0) - MARGIN,
    };
    const middle = offsetTop + height / 2;
    for (const rect of avoid) {
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
      if (rect.top + rect.height / 2 >= middle) area.bottom = Math.min(area.bottom, rect.top - GAP);
      else area.top = Math.max(area.top, rect.top + rect.height + GAP);
    }
    if (area.bottom - area.top < MIN_TARGET) area.bottom = area.top + MIN_TARGET;
    return area;
  }
  function toFraction(box, area) {
    const freeX = area.right - area.left - box.width, freeY = area.bottom - area.top - box.height;
    return { x: freeX > 0 ? unit((box.left - area.left) / freeX) : 0, y: freeY > 0 ? unit((box.top - area.top) / freeY) : 0 };
  }
  function clampBox(box, area) {
    return { ...box, left: clamp(box.left, area.left, area.right - box.width), top: clamp(box.top, area.top, area.bottom - box.height) };
  }
  function fromFraction(fraction, size, area) {
    const box = { width: size.width, height: size.height, left: area.left + fraction.x * (area.right - area.left - size.width), top: area.top + fraction.y * (area.bottom - area.top - size.height) };
    return clampBox(box, area);
  }
  const overlaps = (a, b) => a.left < b.left + b.width + GAP && b.left < a.left + a.width + GAP && a.top < b.top + b.height + GAP && b.top < a.top + a.height + GAP;
  const inside = (box, area) => box.left >= area.left - 0.5 && box.top >= area.top - 0.5 && box.left + box.width <= area.right + 0.5 && box.top + box.height <= area.bottom + 0.5;
  // Puts box where it touches nothing in fixed, as close as possible to where
  // it was asked to be. Candidates: beside each fixed box, then a scan of the
  // area. With no room at all it stays clamped (and overlapping) rather than
  // leaving the screen.
  function placeFree(box, fixed, area) {
    const start = clampBox(box, area);
    if (!fixed.some(other => overlaps(start, other))) return start;
    const candidates = [];
    for (const other of fixed) {
      candidates.push({ left: start.left, top: other.top - GAP - box.height }, { left: start.left, top: other.top + other.height + GAP },
        { left: other.left - GAP - box.width, top: start.top }, { left: other.left + other.width + GAP, top: start.top });
    }
    for (let top = area.top; top <= area.bottom - box.height; top += box.height + GAP)
      for (let left = area.right - box.width; left >= area.left; left -= box.width + GAP) candidates.push({ left, top });
    let best = null, bestDistance = Infinity;
    for (const at of candidates) {
      const candidate = { ...box, left: at.left, top: at.top };
      if (!inside(candidate, area) || fixed.some(other => overlaps(candidate, other))) continue;
      const distance = Math.hypot(candidate.left - start.left, candidate.top - start.top);
      if (distance < bestDistance) { best = candidate; bestDistance = distance; }
    }
    return best || start;
  }
  // Order to draw a list in. Locked ids keep their slots; saved ids come in the
  // saved order; ids the catalog gained since then go right after their
  // catalog neighbour; ids the catalog lost are dropped; an id that is not
  // available (permission, capability) is never shown because of a saved order.
  function orderIds(saved, catalog, locked = [], available = () => true) {
    const base = [...new Set((catalog || []).filter(id => typeof id === 'string'))];
    const lockedSet = new Set(locked), inBase = new Set(base);
    const movable = base.filter(id => !lockedSet.has(id));
    const result = (saved || []).filter((id, index, all) => inBase.has(id) && !lockedSet.has(id) && all.indexOf(id) === index);
    for (const id of movable) {
      if (result.includes(id)) continue;
      let at = 0;
      for (let index = movable.indexOf(id) - 1; index >= 0; index--) {
        const found = result.indexOf(movable[index]);
        if (found >= 0) { at = found + 1; break; }
      }
      result.splice(at, 0, id);
    }
    base.forEach((id, index) => { if (lockedSet.has(id)) result.splice(index, 0, id); });
    return result.filter(id => available(id));
  }

  function mount(options) {
    const doc = options.document || root.document, win = options.window || root;
    const storage = options.storage !== undefined ? options.storage : (() => { try { return win.localStorage; } catch { return null; } })();
    const key = storageKey(options.layoutId, options.deviceId);
    const t = typeof options.t === 'function' ? options.t : text => text;
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    const enabled = typeof options.enabled === 'function' ? options.enabled
      : () => !!(win.matchMedia && (win.matchMedia('(pointer: coarse)').matches || win.matchMedia('(max-width: 700px)').matches));
    const floats = (options.floats || []).filter(item => item && ID_RE.test(item.id) && item.element);
    // A list's element may be a function: the app rebuilds its rows with
    // innerHTML, so the container is looked up again every time.
    const lists = (options.lists || []).filter(item => item && ID_RE.test(item.id) && item.element).map(list => ({
      itemSelector: '[data-shortcut]', idOf: element => element.getAttribute('data-shortcut'), locked: [], ...list, root: null, entry: null,
    }));
    // Order a list goes back to when nothing is saved: catalog() if given (the
    // app's own order), else the order it had when the edit mode started.
    function rootOf(list) {
      const element = typeof list.element === 'function' ? list.element() : list.element;
      list.root = element || null;
      return list.root;
    }
    const itemsOf = list => (list.root ? Array.from(list.root.querySelectorAll(list.itemSelector)) : []);
    lists.forEach(rootOf);
    const avoid = typeof options.avoid === 'function' ? options.avoid : () => [];
    const read = () => { try { return parseStored(storage && storage.getItem(key)); } catch { return emptyState(); } };
    let saved = read(), draft = null, layer = null, selected = '', drag = null, opener = null, frame = 0;
    const listeners = [];
    const listen = (target, name, handler, opts) => { if (!target || !target.addEventListener) return; target.addEventListener(name, handler, opts); listeners.push([target, name, handler, opts]); };
    const current = () => draft || saved;
    const visible = element => !!element && !element.hidden && element.isConnected !== false && rectOf(element).width > 0;
    function rectOf(element) {
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
      return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { left: 0, top: 0, width: 0, height: 0 };
    }
    function viewport() {
      const vv = win.visualViewport;
      return { width: (vv && vv.width) || win.innerWidth || 0, height: (vv && vv.height) || win.innerHeight || 0, offsetTop: (vv && vv.offsetTop) || 0, offsetLeft: (vv && vv.offsetLeft) || 0 };
    }
    function insets() {
      if (typeof options.insets === 'function') return options.insets();
      let probe = doc.querySelector && doc.querySelector('.pcl-probe');
      if (!probe && doc.createElement) { probe = doc.createElement('div'); probe.className = 'pcl-probe'; probe.setAttribute('aria-hidden', 'true'); doc.body.appendChild(probe); }
      const style = probe && win.getComputedStyle ? win.getComputedStyle(probe) : null;
      const px = name => (style ? parseFloat(style[name]) || 0 : 0);
      return { top: px('paddingTop'), right: px('paddingRight'), bottom: px('paddingBottom'), left: px('paddingLeft') };
    }
    // The frame positions are stored against never counts the edit bar, so a
    // button stays at the same pixel after Save or Cancel takes the bar away;
    // area(true) adds the bar only to keep a dragged button out from under it.
    function area(underBar) {
      const port = viewport();
      const blockers = [...avoid(), ...(underBar && layer ? [layer.querySelector('.pcl-bar')] : [])].filter(visible).map(rectOf);
      return { ...safeArea({ ...port, insets: insets(), avoid: blockers }), orientation: orientationOf(port.width, port.height) };
    }
    function clearStyle(element) {
      for (const name of ['position', 'left', 'top', 'right', 'bottom', 'margin']) element.style[name] = '';
      element.removeAttribute('data-pcl-placed');
    }
    function setBox(element, box) {
      Object.assign(element.style, { position: 'fixed', left: `${Math.round(box.left)}px`, top: `${Math.round(box.top)}px`, right: 'auto', bottom: 'auto', margin: '0' });
      element.setAttribute('data-pcl-placed', 'true');
    }
    const ancestors = element => { const chain = []; for (let node = element; node && node !== doc; node = node.parentElement) chain.push(node); return chain; };
    const floatOf = target => { const chain = ancestors(target); return floats.find(item => chain.includes(item.element)) || null; };
    function listItemOf(target) {
      for (const node of ancestors(target)) {
        const list = lists.find(entry => rootOf(entry) && ancestors(node).includes(entry.root) && Array.from(itemsOf(entry)).includes(node));
        if (list) { const id = list.idOf(node); return ID_RE.test(String(id)) && !list.locked.includes(id) ? { list, id, element: node } : null; }
      }
      return null;
    }
    // Floats first become fixed (their flex siblings then settle), then each
    // saved one is put inside the safe area, away from the ones already shown.
    function applyFloats() {
      const shown = floats.filter(item => visible(item.element));
      floats.forEach(item => clearStyle(item.element));
      const state = current();
      if (!enabled() || (!draft && isEmpty(state))) return;
      const zone = area(), reach = layer ? area(true) : zone, saved = state.pos[zone.orientation];
      const placed = shown.filter(item => saved[item.id]);
      const sizes = new Map(placed.map(item => [item.id, rectOf(item.element)]));
      placed.forEach(item => setBox(item.element, { ...sizes.get(item.id), left: zone.left, top: zone.top }));
      const fixed = shown.filter(item => !saved[item.id]).map(item => rectOf(item.element));
      for (const item of placed) {
        const box = placeFree(clampBox(fromFraction(saved[item.id], sizes.get(item.id), zone), reach), fixed, reach);
        setBox(item.element, box); fixed.push(box);
      }
    }
    function applyLists() {
      for (const list of lists) {
        if (!rootOf(list)) continue;
        const fallback = typeof list.catalog === 'function' ? list.catalog() : list.entry;
        const ids = (enabled() && current().order[list.id]) || fallback;
        if (!ids) continue;
        const parents = new Map();
        for (const element of itemsOf(list)) {
          if (list.locked.includes(list.idOf(element))) continue;
          const group = parents.get(element.parentElement) || []; group.push(element); parents.set(element.parentElement, group);
        }
        for (const [parent, items] of parents) {
          const byId = new Map(items.map(element => [list.idOf(element), element]));
          const wanted = orderIds(ids, items.map(element => list.idOf(element))).map(id => byId.get(id));
          if (wanted.length !== items.length || wanted.every((element, index) => element === items[index])) continue;
          const markers = items.map(element => { const mark = doc.createComment ? doc.createComment('') : doc.createElement('i'); parent.insertBefore(mark, element); return mark; });
          markers.forEach((mark, index) => { parent.insertBefore(wanted[index], mark); parent.removeChild(mark); });
        }
      }
    }
    // onChange only fires when the layout itself changed (not on every resize),
    // so the app can redraw a list with order() without a loop.
    function apply(reason) {
      applyFloats(); applyLists(); markSelection();
      if (reason) onChange({ reason, editing: !!layer });
    }
    function schedule() {
      if (frame) return;
      const run = () => { frame = 0; apply(); };
      frame = win.requestAnimationFrame ? win.requestAnimationFrame(run) : (run(), 0);
    }
    for (const target of [win, win.visualViewport]) for (const name of ['resize', 'scroll', 'orientationchange']) listen(target, name, schedule);
    if (!isEmpty(saved)) schedule();

    // ---- Edit mode: only entered on purpose, always leaves with one tap ----
    const editListeners = [];
    const editListen = (target, name, handler) => { target.addEventListener(name, handler, { capture: true, passive: false }); editListeners.push([target, name, handler]); };
    const selectable = () => [...floats.filter(item => visible(item.element)).map(item => ({ key: `f:${item.id}`, element: item.element })),
      ...lists.flatMap(list => (rootOf(list), itemsOf(list)).filter(element => visible(element) && !list.locked.includes(list.idOf(element)))
        .map(element => ({ key: `l:${list.id}:${list.idOf(element)}`, element })))];
    function markSelection() {
      for (const entry of selectable()) entry.element.setAttribute('data-pcl-selected', String(!!layer && entry.key === selected));
      if (!layer) return;
      const entry = selectable().find(item => item.key === selected);
      const name = entry ? entry.element.getAttribute('aria-label') || entry.element.getAttribute('title') || entry.element.textContent : '';
      layer.status.textContent = entry ? t('Selecionado: {name}').replace('{name}', String(name).trim()) : t('Arraste um botão ou escolha com Próximo.');
      const isList = selected.startsWith('l:');
      layer.before.hidden = !isList; layer.after.hidden = !isList;
    }
    const domOrder = list => itemsOf(list).map(element => list.idOf(element)).filter(id => ID_RE.test(String(id)) && !list.locked.includes(id));
    function storeFloat(item, box) {
      const zone = area();
      draft.pos[zone.orientation][item.id] = toFraction(box, zone);
    }
    function storeList(list) { draft.order[list.id] = domOrder(list); }
    function nudge(dx, dy) {
      if (!selected.startsWith('f:')) return;
      const item = floats.find(entry => `f:${entry.id}` === selected);
      if (!item) return;
      const box = rectOf(item.element);
      storeFloat(item, clampBox({ ...box, left: box.left + dx, top: box.top + dy }, area(true)));
      apply('move');
    }
    function step(direction) {
      const [, listId, id] = selected.split(':'), list = lists.find(entry => entry.id === listId);
      if (!list || !rootOf(list)) return;
      const items = itemsOf(list).filter(element => !list.locked.includes(list.idOf(element)));
      const index = items.findIndex(element => list.idOf(element) === id), other = items[index + direction];
      if (index < 0 || !other || other.parentElement !== items[index].parentElement) return;
      other.parentElement.insertBefore(items[index], direction < 0 ? other : other.nextSibling);
      const moved = items[index];
      storeList(list); apply('order');
      const fresh = itemsOf(list).find(element => list.idOf(element) === id) || moved;
      try { fresh.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
    }
    function cycle() {
      const all = selectable();
      if (!all.length) return;
      const index = all.findIndex(entry => entry.key === selected);
      selected = all[(index + 1) % all.length].key; markSelection();
    }
    function node(tag, className, attrs = {}, text = '') {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      for (const name of Object.keys(attrs)) element.setAttribute(name, attrs[name]);
      if (text) element.textContent = text;
      return element;
    }
    const button = (text, action, label, extra = '') => node('button', `pcl-button${extra}`, { type: 'button', 'data-pcl': action, ...(label ? { 'aria-label': label } : {}) }, text);
    function buildLayer() {
      const element = node('div', 'pcl-layer');
      const bar = node('div', 'pcl-bar', { role: 'toolbar', 'aria-label': t('Organizar botões') });
      const first = node('div', 'pcl-row'), second = node('div', 'pcl-row');
      first.append(button(t('Salvar'), 'save', '', ' primary'), button(t('Cancelar'), 'cancel'), button(t('Restaurar padrão'), 'reset'));
      const before = button(t('Antes'), 'before', t('Mover para antes')), after = button(t('Depois'), 'after', t('Mover para depois'));
      second.append(button(t('Próximo'), 'next', t('Selecionar o próximo botão')), button('←', 'left', t('Mover para a esquerda')), button('↑', 'up', t('Mover para cima')),
        button('↓', 'down', t('Mover para baixo')), button('→', 'right', t('Mover para a direita')), before, after);
      const status = node('p', 'pcl-status', { role: 'status', 'aria-live': 'polite' });
      bar.append(first, second, status);
      element.append(node('div', 'pcl-veil', { 'aria-hidden': 'true' }), bar);
      return Object.assign(element, { status, before, after });
    }
    function onLayerClick(event) {
      const action = event.target.closest && event.target.closest('[data-pcl]');
      if (!action) return;
      const name = action.getAttribute('data-pcl');
      if (name === 'save') save(); else if (name === 'cancel') cancel(); else if (name === 'reset') reset(); else if (name === 'next') cycle();
      else if (name === 'before') step(-1); else if (name === 'after') step(1);
      else nudge(name === 'left' ? -NUDGE : name === 'right' ? NUDGE : 0, name === 'up' ? -NUDGE : name === 'down' ? NUDGE : 0);
    }
    // While editing, a press on a control moves it; it never reaches the
    // control's own handler (no shortcut, no scroll, no key sent to the PC).
    function swallow(event) { event.preventDefault(); event.stopPropagation(); if (event.stopImmediatePropagation) event.stopImmediatePropagation(); }
    function onDown(event) {
      if (layer && layer.contains(event.target)) return;
      const float = floatOf(event.target), entry = float ? null : listItemOf(event.target);
      if (!float && !entry) return;
      swallow(event);
      const element = float ? float.element : entry.element;
      selected = float ? `f:${float.id}` : `l:${entry.list.id}:${entry.id}`;
      drag = { float, entry, element, x: event.clientX, y: event.clientY, box: rectOf(element), moved: false, pointerId: event.pointerId };
      element.setAttribute('data-pcl-dragging', 'true');
      markSelection();
    }
    function onMove(event) {
      if (!drag || (drag.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
      swallow(event);
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      if (drag.float) { setBox(drag.element, clampBox({ ...drag.box, left: drag.box.left + dx, top: drag.box.top + dy }, area(true))); return; }
      const siblings = Array.from(drag.element.parentElement.children).filter(node => node !== drag.element && node.matches(drag.entry.list.itemSelector) && !drag.entry.list.locked.includes(drag.entry.list.idOf(node)));
      const over = siblings.find(node => { const rect = rectOf(node); return event.clientX >= rect.left && event.clientX <= rect.left + rect.width; });
      if (over) { const rect = rectOf(over); over.parentElement.insertBefore(drag.element, event.clientX < rect.left + rect.width / 2 ? over : over.nextSibling); }
    }
    function onUp(event) {
      if (!drag) return;
      swallow(event);
      const done = drag; drag = null;
      done.element.removeAttribute('data-pcl-dragging');
      if (done.moved && done.float) storeFloat(done.float, rectOf(done.element));
      if (done.moved && done.entry) storeList(done.entry.list);
      apply(done.moved ? (done.float ? 'move' : 'order') : '');
    }
    // Touch and mouse compatibility events of a press on a control (or any
    // press while dragging) are swallowed too, so nothing underneath reacts.
    function onCompat(event) { if (layer && layer.contains(event.target)) return; if (drag || floatOf(event.target) || listItemOf(event.target)) swallow(event); }
    function onClick(event) { if (layer && layer.contains(event.target)) return; if (floatOf(event.target) || listItemOf(event.target) || (event.target.closest && event.target.closest('.pcl-veil'))) swallow(event); }
    function onKey(event) { if (event.key === 'Escape') { swallow(event); cancel(); } }
    function enter() {
      if (layer || !enabled()) return false;
      draft = cloneState(saved);
      lists.forEach(list => { rootOf(list); list.entry = domOrder(list); });
      opener = doc.activeElement || null;
      layer = buildLayer();
      (options.layerParent || doc.body).appendChild(layer);
      doc.body.setAttribute('data-control-layout-editing', 'true');
      layer.addEventListener('click', onLayerClick);
      editListen(doc, 'pointerdown', onDown); editListen(doc, 'pointermove', onMove);
      for (const name of ['pointerup', 'pointercancel']) editListen(doc, name, onUp);
      for (const name of ['touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup']) editListen(doc, name, onCompat);
      editListen(doc, 'click', onClick); editListen(doc, 'keydown', onKey); editListen(doc, 'contextmenu', onClick);
      selected = ''; apply('enter');
      const first = layer.querySelector('[data-pcl="save"]');
      if (first && first.focus) first.focus();
      return true;
    }
    function leave(reason) {
      if (!layer) return;
      while (editListeners.length) { const [target, name, handler] = editListeners.pop(); target.removeEventListener(name, handler, { capture: true }); }
      if (drag) { drag.element.removeAttribute('data-pcl-dragging'); drag = null; }
      layer.remove ? layer.remove() : layer.parentElement.removeChild(layer);
      layer = null; draft = null; selected = '';
      doc.body.removeAttribute('data-control-layout-editing');
      apply(reason || 'cancel');
      lists.forEach(list => { list.entry = null; });
      if (opener && opener.focus && opener.isConnected !== false) { try { opener.focus(); } catch {} }
      opener = null;
    }
    function save() {
      if (!draft) return false;
      const text = isEmpty(draft) ? null : serialize(draft);
      if (!isEmpty(draft) && !text) { if (layer) layer.status.textContent = t('Não deu para salvar neste aparelho.'); return false; }
      try { if (!storage) throw new Error('storage'); if (text) storage.setItem(key, text); else storage.removeItem(key); }
      catch { if (layer) layer.status.textContent = t('Não deu para salvar neste aparelho.'); return false; }
      saved = parseStored(text);
      leave('save');
      return true;
    }
    function cancel() { leave(); }
    // Back to the shipped layout. In the edit mode it is a draft (Cancel
    // brings the owner's layout back); outside it, it is immediate.
    function reset() {
      if (layer) { draft = emptyState(); apply('reset'); return true; }
      try { if (storage) storage.removeItem(key); } catch {}
      saved = emptyState(); apply('reset');
      return true;
    }
    return {
      enter, save, cancel, reset,
      editing: () => !!layer,
      refresh: schedule,
      // Re-applies now, without onChange: for the app right after it redrew a list.
      apply: () => apply(),
      order: (listId, catalog, available) => {
        const list = lists.find(entry => entry.id === listId);
        const ids = enabled() ? current().order[listId] : null;
        return orderIds(ids || [], catalog, list ? list.locked : [], typeof available === 'function' ? available : () => true);
      },
      boxes: () => floats.filter(item => visible(item.element)).map(item => ({ id: item.id, ...rectOf(item.element) })),
      snapshot: () => cloneState(current()),
      destroy() {
        leave();
        while (listeners.length) { const [target, name, handler, opts] = listeners.pop(); target.removeEventListener(name, handler, opts); }
        floats.forEach(item => clearStyle(item.element));
      },
    };
  }

  root.PonteControlLayout = { mount, parseStored, serialize, storageKey, safeArea, toFraction, fromFraction, clampBox, placeFree, overlaps, orderIds, orientationOf, emptyState };
})(typeof globalThis !== 'undefined' ? globalThis : this);

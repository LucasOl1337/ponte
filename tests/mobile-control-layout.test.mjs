import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { makeLayoutDom, el, fire } from './helpers/layout-dom.mjs';

// Editable layout of the phone's floating controls. Fixed cases only, one per
// concrete situation (no generated inputs). Ids and numbers are synthetic.
const source = await readFile(new URL('../public/mobile-control-layout.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/mobile-control-layout.css', import.meta.url), 'utf8');
// Same realm as the test, so deepEqual compares plain objects.
function load() { vm.runInThisContext(source, { filename: 'mobile-control-layout.js' }); return globalThis.PonteControlLayout; }
const L = load();
const KEY = 'ponte-control-layout.v1.screen';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial)), writes = [];
  return { data, writes, getItem: name => (data.has(name) ? data.get(name) : null), setItem(name, value) { writes.push([name, value]); data.set(name, String(value)); }, removeItem: name => data.delete(name) };
}
// A 390x844 phone: the rail of 44px buttons on the right above the bottom nav,
// a key row at the bottom with the three locked keys and four movable ones.
function rig({ width = 390, height = 844, stored, storage, enabled = () => true } = {}) {
  const { document, window } = makeLayoutDom({ width, height });
  const rail = el(document, 'div', { class: 'screen-fabs' });
  const ids = ['scroll', 'monitor', 'rotate', 'keyboard', 'dictate'];
  const fabs = Object.fromEntries(ids.map((id, index) => [id, el(document, 'button', { id: `screen-${id}`, 'aria-label': `Botão ${id}` }, { left: width - 58, top: height - 400 + index * 52, width: 44, height: 44 }, rail)]));
  const shortcut = [];
  fabs.keyboard.addEventListener('click', () => shortcut.push('keyboard'));
  const bar = el(document, 'div', { 'data-key-bar': 'screen' });
  const head = el(document, 'div', { class: 'key-head' }, null, bar), tail = el(document, 'div', { class: 'key-tail' }, null, bar);
  const keys = {};
  ['enter', 'esc', 'ctrl-c'].forEach((id, index) => { keys[id] = el(document, 'button', { 'data-shortcut': id }, { left: 8 + index * 52, top: height - 60, width: 44, height: 44 }, head); });
  ['tab', 'up', 'down', 'ctrl-z'].forEach((id, index) => { keys[id] = el(document, 'button', { 'data-shortcut': id }, { left: 170 + index * 52, top: height - 60, width: 44, height: 44 }, tail); });
  bar.addEventListener('click', event => { const button = event.target.closest('[data-shortcut]'); if (button) shortcut.push(button.getAttribute('data-shortcut')); });
  const nav = el(document, 'nav', { class: 'bottom-nav' }, { left: 16, top: height - 92, width: width - 32, height: 72 });
  const store = storage || memoryStorage(stored === undefined ? {} : { [KEY]: stored });
  const changes = [];
  const layout = L.mount({
    document, window, storage: store, layoutId: 'screen', enabled, insets: () => ({ top: 24, right: 0, bottom: 16, left: 0 }),
    floats: ids.map(id => ({ id: `screen.${id}`, element: fabs[id] })),
    lists: [{ id: 'screen.keys', element: () => document.querySelector('[data-key-bar]'), locked: ['enter', 'esc', 'ctrl-c'] }],
    avoid: () => [nav], onChange: change => changes.push(change),
  });
  window.flush();
  const tailIds = () => tail.children.map(node => node.getAttribute('data-shortcut'));
  const button = action => document.querySelector(`[data-pcl="${action}"]`);
  return { document, window, layout, fabs, keys, tail, tailIds, nav, store, shortcut, changes, button };
}
const box = element => element.getBoundingClientRect();
const area = { left: 8, top: 32, right: 382, bottom: 744 };
const drag = (r, element, dx, dy, id = 1) => {
  const start = box(element), x = start.left + 20, y = start.top + 20;
  fire(element, 'pointerdown', { clientX: x, clientY: y, pointerId: id });
  fire(element, 'pointermove', { clientX: x + dx / 2, clientY: y + dy / 2, pointerId: id });
  fire(element, 'pointermove', { clientX: x + dx, clientY: y + dy, pointerId: id });
  fire(element, 'pointerup', { clientX: x + dx, clientY: y + dy, pointerId: id });
  return fire(element, 'click', { clientX: x + dx, clientY: y + dy });
};

test('safe area leaves the insets, the margin and the bottom nav out', () => {
  const zone = L.safeArea({ width: 390, height: 844, insets: { top: 24, bottom: 16 }, avoid: [{ left: 16, top: 752, width: 358, height: 72 }] });
  assert.deepEqual(zone, { left: 8, top: 32, right: 382, bottom: 744 });
  const keyboard = L.safeArea({ width: 390, height: 500, offsetTop: 0, insets: { top: 24 }, avoid: [{ left: 0, top: 440, width: 390, height: 60 }] });
  assert.equal(keyboard.bottom, 432, 'typing bar above the soft keyboard stays uncovered');
  const tiny = L.safeArea({ width: 390, height: 120, avoid: [{ left: 0, top: 60, width: 390, height: 60 }] });
  assert.equal(tiny.bottom - tiny.top, 44, 'never smaller than one target');
});

test('a box is clamped inside the area and fractions round trip', () => {
  const size = { width: 44, height: 44 };
  assert.deepEqual(L.clampBox({ ...size, left: -50, top: 2000 }, area), { ...size, left: 8, top: 700 });
  assert.deepEqual(L.clampBox({ ...size, left: 1000, top: -5 }, area), { ...size, left: 338, top: 32 });
  const at = { ...size, left: 120, top: 400 };
  const fraction = L.toFraction(at, area);
  assert.ok(fraction.x > 0 && fraction.x < 1 && fraction.y > 0 && fraction.y < 1);
  const back = L.fromFraction(fraction, size, area);
  assert.ok(Math.abs(back.left - 120) < 1e-9 && Math.abs(back.top - 400) < 1e-9);
  const landscape = { left: 8, top: 8, right: 836, bottom: 382 };
  const turned = L.fromFraction({ x: 1, y: 1 }, size, landscape);
  assert.deepEqual([turned.left, turned.top], [792, 338], 'the corner stays the corner after rotation');
});

test('placeFree moves a box off the others and keeps it inside', () => {
  const size = { width: 44, height: 44 };
  const other = { left: 300, top: 400, width: 44, height: 44 };
  const placed = L.placeFree({ ...size, left: 302, top: 402 }, [other], area);
  assert.equal(L.overlaps(placed, other), false);
  assert.ok(placed.left >= area.left && placed.left + 44 <= area.right && placed.top >= area.top && placed.top + 44 <= area.bottom);
  assert.ok(Math.hypot(placed.left - 302, placed.top - 402) <= 60, 'lands next to where it was asked');
  const free = L.placeFree({ ...size, left: 20, top: 40 }, [other], area);
  assert.deepEqual([free.left, free.top], [20, 40], 'a free spot is kept as is');
});

test('parseStored never throws and keeps only ids and finite numbers', () => {
  const empty = L.emptyState();
  for (const raw of [null, '', '{', 'null', '[]', '"x"', '{"v":2,"pos":{"portrait":{"a":{"x":0.5,"y":0.5}}}}', '{"v":"1"}', 'x'.repeat(9000)]) assert.deepEqual(L.parseStored(raw), empty, String(raw).slice(0, 30));
  const state = L.parseStored(JSON.stringify({
    v: 1, extra: 'drop', token: 'secret-value',
    pos: { portrait: { 'screen.rotate': { x: 1.7, y: -2 }, 'Bad Id!': { x: 0.1, y: 0.1 }, 'screen.keyboard': { x: 'NaN', y: 0.1 }, 'screen.scroll': { x: 0.25, y: 0.5, label: 'texto digitado' } }, landscape: [] },
    order: { 'screen.keys': ['up', 'up', 'ctrl-z', 7, '<b>', 'tab'], 'bad list': ['tab'], other: 'tab' },
  }));
  assert.deepEqual(state, { v: 1, pos: { portrait: { 'screen.rotate': { x: 1, y: 0 }, 'screen.scroll': { x: 0.25, y: 0.5 } }, landscape: {} }, order: { 'screen.keys': ['up', 'ctrl-z', 'tab'] } });
  assert.doesNotMatch(L.serialize(state), /secret|texto|label|extra/);
});

test('serialize refuses what would not fit in 8 KB', () => {
  const state = L.emptyState();
  for (let i = 0; i < 32; i++) state.order[`list-${i}`] = Array.from({ length: 64 }, (_, n) => `key-${String(n).padStart(40, '0')}`);
  assert.equal(L.serialize(state), null);
});

test('orderIds follows the saved order and the catalog it is drawn from', () => {
  const catalog = ['enter', 'esc', 'ctrl-c', 'tab', 'up', 'down', 'ctrl-z'], locked = ['enter', 'esc', 'ctrl-c'];
  assert.deepEqual(L.orderIds(['ctrl-z', 'tab', 'up', 'down'], catalog, locked), ['enter', 'esc', 'ctrl-c', 'ctrl-z', 'tab', 'up', 'down']);
  assert.deepEqual(L.orderIds(['enter', 'ctrl-z', 'tab', 'up', 'down'], catalog, locked), ['enter', 'esc', 'ctrl-c', 'ctrl-z', 'tab', 'up', 'down'], 'locked ids cannot be moved by storage');
  // up follows tab, ctrl-z follows down, f5 follows ctrl-z: each id missing
  // from the saved order sits right after the one before it in the catalog.
  assert.deepEqual(L.orderIds(['down', 'tab'], [...catalog, 'f5'], locked), ['enter', 'esc', 'ctrl-c', 'down', 'ctrl-z', 'f5', 'tab', 'up'], 'new ids sit after their catalog neighbour');
  assert.deepEqual(L.orderIds(['gone', 'down', 'tab', 'up', 'ctrl-z'], catalog, locked), ['enter', 'esc', 'ctrl-c', 'down', 'tab', 'up', 'ctrl-z'], 'removed ids are dropped');
  assert.deepEqual(L.orderIds(['ctrl-z', 'tab'], catalog, locked, id => id !== 'ctrl-z'), ['enter', 'esc', 'ctrl-c', 'tab', 'up', 'down'], 'an unavailable id is not shown because of a saved order');
  assert.deepEqual(L.orderIds([], catalog, locked), catalog);
});

test('storage key is per layout and device, rejects odd ids', () => {
  assert.equal(L.storageKey('screen'), KEY);
  assert.equal(L.storageKey('screen', 'node-2'), `${KEY}.node-2`);
  assert.equal(L.storageKey('screen', '../x'), KEY);
  assert.throws(() => L.storageKey('Screen Layout'));
});

test('normal mode: no edit listeners, no placement, shortcuts work', () => {
  const r = rig();
  assert.equal(r.layout.editing(), false);
  assert.equal(r.document.listeners.length, 0, 'nothing listens on the document outside the edit mode');
  assert.equal(r.fabs.rotate.style.position, undefined);
  fire(r.fabs.keyboard, 'click'); fire(r.keys.tab, 'click');
  assert.deepEqual(r.shortcut, ['keyboard', 'tab']);
  assert.deepEqual(r.changes, [], 'mounting fires no change');
});

test('dragging a floating control moves it, stays inside, does not fire it', () => {
  const r = rig();
  assert.equal(r.layout.enter(), true);
  assert.ok(r.document.listeners.length > 0);
  assert.ok(r.document.querySelector('.pcl-veil'), 'the veil covers the PC screen while arranging');
  const click = drag(r, r.fabs.keyboard, -600, -2000);
  assert.deepEqual(r.shortcut, [], 'the drag never reached the shortcut');
  assert.equal(click.defaultPrevented, true);
  const at = box(r.fabs.keyboard);
  assert.deepEqual([at.left, at.top], [8, 32], 'clamped to the top left of the safe area');
  fire(r.fabs.dictate, 'pointerdown', { clientX: 300, clientY: 650, pointerId: 2 });
  fire(r.fabs.dictate, 'pointerup', { clientX: 302, clientY: 651, pointerId: 2 });
  fire(r.fabs.dictate, 'click', {});
  assert.equal(r.fabs.dictate.getAttribute('data-pcl-selected'), 'true', 'a tap selects');
  assert.deepEqual(r.shortcut, []);
  assert.ok(r.layout.save());
  assert.equal(r.document.listeners.length, 0, 'all edit listeners are gone after saving');
  assert.equal(r.document.querySelector('.pcl-layer'), null);
  fire(r.fabs.keyboard, 'click');
  assert.deepEqual(r.shortcut, ['keyboard'], 'after saving the control works again');
  const stored = JSON.parse(r.store.data.get(KEY));
  assert.deepEqual(Object.keys(stored), ['v', 'pos', 'order']);
  assert.deepEqual(stored.pos.portrait['screen.keyboard'], { x: 0, y: 0 });
  assert.doesNotMatch(r.store.data.get(KEY), /Botão|aria|label/);
  assert.deepEqual(r.changes.map(change => change.reason), ['enter', 'move', 'save']);
});

test('saved positions come back on the next mount and avoid each other', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 0, y: 0 }, 'screen.keyboard': { x: 0, y: 0 } }, landscape: {} }, order: {} });
  const r = rig({ stored });
  const a = box(r.fabs.rotate), b = box(r.fabs.keyboard);
  assert.equal(r.fabs.rotate.style.position, 'fixed');
  assert.equal(L.overlaps(a, b), false, 'two controls saved on the same spot do not stack');
  for (const at of [a, b]) assert.ok(at.left >= 8 && at.top >= 32 && at.left + 44 <= 382 && at.top + 44 <= 744);
});

test('rotation re-applies the landscape slot, keyboard space is respected', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 0, y: 1 } }, landscape: { 'screen.rotate': { x: 1, y: 0 } } }, order: {} });
  const r = rig({ stored });
  assert.deepEqual([box(r.fabs.rotate).left, box(r.fabs.rotate).top], [8, 700], 'portrait slot: bottom left, above the nav');
  assert.ok(box(r.fabs.rotate).top + 44 <= r.nav.box.top - 8, 'above the bottom nav');
  r.nav.box = { left: 16, top: 298, width: 812, height: 72 };
  r.window.resize(844, 390);
  const turned = box(r.fabs.rotate);
  assert.deepEqual([turned.left, turned.top], [844 - 8 - 44, 24 + 8], 'landscape slot: top right');
  r.nav.box = { left: 16, top: 772, width: 358, height: 72 };
  r.window.resize(390, 500);
  r.nav.box = { left: 0, top: 440, width: 390, height: 60 };
  r.window.resize(390, 500);
  const typing = box(r.fabs.rotate);
  assert.equal(typing.top, 388, 'stays above the typing bar with the keyboard open');
  assert.deepEqual(r.changes, [], 'resizes alone fire no change');
});

test('reordering a list keeps locked keys in place and stores ids only', () => {
  const r = rig();
  r.layout.enter();
  fire(r.keys['ctrl-z'], 'pointerdown', { clientX: 340, clientY: 800, pointerId: 3 });
  fire(r.keys['ctrl-z'], 'pointerup', { clientX: 340, clientY: 800, pointerId: 3 });
  for (let i = 0; i < 3; i++) fire(r.button('before'), 'click');
  assert.deepEqual(r.tailIds(), ['ctrl-z', 'tab', 'up', 'down']);
  fire(r.button('before'), 'click');
  assert.deepEqual(r.tailIds(), ['ctrl-z', 'tab', 'up', 'down'], 'cannot pass the first slot');
  fire(r.keys.enter, 'pointerdown', { clientX: 20, clientY: 800, pointerId: 4 });
  fire(r.keys.enter, 'pointerup', { clientX: 20, clientY: 800, pointerId: 4 });
  fire(r.keys.enter, 'click');
  assert.deepEqual(r.shortcut, ['enter'], 'a locked key is not taken by the edit mode');
  r.layout.save();
  assert.deepEqual(JSON.parse(r.store.data.get(KEY)).order, { 'screen.keys': ['ctrl-z', 'tab', 'up', 'down'] });
  assert.deepEqual(r.layout.order('screen.keys', ['enter', 'esc', 'ctrl-c', 'tab', 'up', 'down', 'ctrl-z', 'f5']), ['enter', 'esc', 'ctrl-c', 'ctrl-z', 'f5', 'tab', 'up', 'down'], 'a key new to the catalog follows its neighbour');
});

test('dragging a key across the row reorders it without sending it', () => {
  const r = rig();
  r.layout.enter();
  drag(r, r.keys.tab, 160, 0);
  assert.deepEqual(r.tailIds(), ['up', 'down', 'ctrl-z', 'tab'], 'dropped past the middle of the last key');
  assert.deepEqual(r.shortcut, []);
  r.layout.save();
  assert.deepEqual(JSON.parse(r.store.data.get(KEY)).order['screen.keys'], ['up', 'down', 'ctrl-z', 'tab']);
});

test('the app redrawing the row keeps the saved order', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: {}, landscape: {} }, order: { 'screen.keys': ['down', 'up', 'tab', 'ctrl-z'] } });
  const r = rig({ stored });
  assert.deepEqual(r.tailIds(), ['down', 'up', 'tab', 'ctrl-z']);
  const bar = r.document.querySelector('[data-key-bar]');
  bar.remove();
  const fresh = el(r.document, 'div', { 'data-key-bar': 'screen' });
  const tail = el(r.document, 'div', { class: 'key-tail' }, null, fresh);
  for (const id of ['tab', 'up', 'down', 'ctrl-z', 'f5']) el(r.document, 'button', { 'data-shortcut': id }, { left: 0, top: 0, width: 44, height: 44 }, tail);
  r.layout.apply();
  assert.deepEqual(tail.children.map(node => node.getAttribute('data-shortcut')), ['down', 'up', 'tab', 'ctrl-z', 'f5']);
  assert.deepEqual(r.changes, [], 'apply() after a redraw fires no change (no redraw loop)');
});

test('cancel throws the draft away and Escape cancels', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 0.5, y: 0.5 } }, landscape: {} }, order: {} });
  const r = rig({ stored });
  const before = box(r.fabs.rotate);
  r.layout.enter();
  drag(r, r.fabs.rotate, -100, -100);
  assert.notDeepEqual(box(r.fabs.rotate), before);
  fire(r.button('cancel'), 'click');
  assert.equal(r.layout.editing(), false);
  assert.deepEqual(box(r.fabs.rotate), before);
  assert.equal(r.store.writes.length, 0, 'cancel writes nothing');
  r.layout.enter();
  drag(r, r.fabs.rotate, 50, 0);
  fire(r.document.body, 'keydown', { key: 'Escape' });
  assert.equal(r.layout.editing(), false);
  assert.deepEqual(box(r.fabs.rotate), before);
  assert.equal(r.document.listeners.length, 0);
});

test('reset in the edit mode is a draft until saved, then clears storage', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 0, y: 0 } }, landscape: {} }, order: { 'screen.keys': ['ctrl-z', 'tab', 'up', 'down'] } });
  const r = rig({ stored });
  assert.deepEqual(r.tailIds(), ['ctrl-z', 'tab', 'up', 'down']);
  r.layout.enter();
  fire(r.button('reset'), 'click');
  assert.equal(r.fabs.rotate.style.position, '', 'shipped place while the draft is empty');
  fire(r.button('cancel'), 'click');
  assert.equal(r.fabs.rotate.style.position, 'fixed', 'cancel brings the owner layout back');
  r.layout.enter();
  fire(r.button('reset'), 'click');
  fire(r.button('save'), 'click');
  assert.equal(r.store.data.has(KEY), false, 'an empty layout leaves no key behind');
  assert.equal(r.fabs.rotate.style.position, '');
});

test('the arrow buttons nudge the selected control by 8px', () => {
  const r = rig();
  r.layout.enter();
  fire(r.button('next'), 'click');
  assert.equal(r.fabs.scroll.getAttribute('data-pcl-selected'), 'true');
  const start = box(r.fabs.scroll);
  fire(r.button('left'), 'click'); fire(r.button('up'), 'click');
  const moved = box(r.fabs.scroll);
  assert.deepEqual([moved.left, moved.top], [start.left - 8, start.top - 8]);
  assert.match(r.document.querySelector('.pcl-status').textContent, /Botão scroll/);
});

test('a broken storage does not break the screen', () => {
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('denied'); } };
  const r = rig({ storage: throwing });
  r.layout.enter();
  drag(r, r.fabs.rotate, -40, -40);
  assert.equal(r.layout.save(), false);
  assert.equal(r.layout.editing(), true, 'stays in the edit mode so nothing is lost silently');
  assert.match(r.document.querySelector('.pcl-status').textContent, /Não deu para salvar/);
  r.layout.cancel();
  const bad = rig({ stored: '{"v":1,"pos":' });
  assert.equal(bad.fabs.rotate.style.position, undefined);
});

test('off on desktop: no edit mode, saved layout not applied', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 0, y: 0 } }, landscape: {} }, order: { 'screen.keys': ['ctrl-z', 'tab', 'up', 'down'] } });
  const r = rig({ stored, enabled: () => false });
  assert.equal(r.layout.enter(), false);
  assert.notEqual(r.fabs.rotate.style.position, 'fixed');
  assert.deepEqual(r.tailIds(), ['tab', 'up', 'down', 'ctrl-z']);
  assert.deepEqual(r.layout.order('screen.keys', ['enter', 'tab', 'up']), ['enter', 'tab', 'up']);
});

test('destroy removes every listener and inline position', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 0, y: 0 } }, landscape: {} }, order: {} });
  const r = rig({ stored });
  r.layout.enter();
  r.layout.destroy();
  assert.equal(r.document.listeners.length, 0);
  assert.equal(r.window.listeners.length, 0);
  assert.equal(r.fabs.rotate.style.position, '');
});

test('a saved corner keeps its spot at 320, 390 and 430 wide, inside the area', () => {
  const stored = JSON.stringify({ v: 1, pos: { portrait: { 'screen.rotate': { x: 1, y: 0 }, 'screen.keyboard': { x: 0, y: 1 } }, landscape: {} }, order: {} });
  for (const width of [320, 390, 430]) {
    const r = rig({ width, stored });
    const rotate = box(r.fabs.rotate), keyboard = box(r.fabs.keyboard), nav = box(r.nav);
    assert.equal(rotate.left + rotate.width, width - 8, `${width}: right edge on the margin`);
    assert.equal(rotate.top, 32, `${width}: under the top inset`);
    assert.equal(keyboard.left, 8, `${width}: left edge on the margin`);
    assert.ok(keyboard.top + keyboard.height <= nav.top, `${width}: above the bottom nav`);
  }
  const r = rig({ width: 430, stored });
  r.window.resize(320, 844);
  const rotate = box(r.fabs.rotate);
  assert.equal(rotate.left + rotate.width, 312, 'a live resize to 320 re-clamps');
});

test('a button dragged up to the edit bar stays at the same pixel after Save', () => {
  const r = rig();
  r.layout.enter();
  r.document.querySelector('.pcl-bar').box = { left: 8, top: 24, width: 374, height: 150 };
  drag(r, r.fabs.rotate, -300, -800);
  const during = box(r.fabs.rotate);
  assert.ok(during.top >= 174, 'kept out from under the edit bar while editing');
  fire(r.button('save'), 'click');
  const after = box(r.fabs.rotate);
  assert.deepEqual([after.left, after.top], [during.left, during.top]);
});

test('the edit bar is safe-area aware and has 44px targets', () => {
  assert.match(css, /\.pcl-bar\{[^}]*env\(safe-area-inset-top/);
  assert.match(css, /\.pcl-button\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css, /\.pcl-veil\{[^}]*pointer-events:auto/);
  assert.match(css, /\.pcl-probe\{[^}]*env\(safe-area-inset-bottom/);
});

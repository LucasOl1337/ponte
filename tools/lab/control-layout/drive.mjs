#!/usr/bin/env node
// Browser proof of public/mobile-control-layout.js on the lab page
// (tools/lab/control-layout/index.html), driven through CDP with real touch
// events in an emulated phone. Prints one JSON line per check and writes
// screenshots to OUT (default ./control-layout-shots).
//
//   python3 -m http.server 8817 --bind 127.0.0.1 &      # from the repo root
//   CDP_URL=http://127.0.0.1:19081 OUT=/tmp/shots node tools/lab/control-layout/drive.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
const pageUrl = process.env.PAGE_URL || 'http://127.0.0.1:8817/tools/lab/control-layout/index.html';
const out = process.env.OUT || 'control-layout-shots';
mkdirSync(out, { recursive: true });

const pages = await (await fetch(`${endpoint}/json`)).json();
let target = pages.find(p => p.type === 'page' && p.url.startsWith(pageUrl.split('?')[0]));
if (!target) target = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++seq; pending.set(n, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))); ws.send(JSON.stringify({ id: n, method, params })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const results = [];
function check(name, ok, detail = {}) { const line = { check: name, ok: !!ok, ...detail }; results.push(line); console.log(JSON.stringify(line)); }
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(out, `${name}.png`); writeFileSync(file, Buffer.from(data, 'base64')); return file;
}
const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 })) });
async function tap(x, y) { await touch('touchStart', [[x, y]]); await sleep(50); await touch('touchEnd', []); await sleep(120); }
async function drag(x0, y0, x1, y1, steps = 14) {
  await touch('touchStart', [[x0, y0]]); await sleep(60);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await sleep(16); }
  await touch('touchEnd', []); await sleep(200);
}
const rect = selector => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const hits = () => evaluate('window.labHits.slice()');
const overlap = (a, b) => a && b && a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

async function phone(width, height, { clear = false } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true, screenOrientation: width > height ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  if (clear) await evaluate('localStorage.clear()');
  await send('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 50; i++) { await sleep(100); if (await evaluate('document.body?.dataset.labReady === "true"').catch(() => false)) break; }
  await sleep(250);
}
// Every visible float sits inside the viewport, off the bottom nav and the
// composer, and off each other.
async function layoutSane(label) {
  const state = await evaluate(`(() => {
    const box = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
    const shown = e => e && !e.hidden && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none';
    const floats = window.labLayout.boxes();
    const nav = document.querySelector('.bottom-nav'), composer = document.querySelector('#screen-composer');
    return { floats, vw: innerWidth, vh: innerHeight, nav: shown(nav) ? box(nav) : null, composer: shown(composer) ? box(composer) : null };
  })()`);
  const problems = [];
  for (const f of state.floats) {
    if (f.left < 0 || f.top < 0 || f.left + f.width > state.vw + 0.5 || f.top + f.height > state.vh + 0.5) problems.push(`${f.id} fora da tela`);
    if (overlap(f, state.nav)) problems.push(`${f.id} sobre a navegação`);
    if (overlap(f, state.composer)) problems.push(`${f.id} sobre o compositor`);
    for (const g of state.floats) if (g.id < f.id && overlap(f, g)) problems.push(`${f.id} sobre ${g.id}`);
  }
  check(`layout-sane:${label}`, problems.length === 0, { problems, floats: state.floats.map(f => `${f.id}@${Math.round(f.left)},${Math.round(f.top)}`) });
}

// 1. Default layout at 390x844: the module changes nothing until edited.
await phone(390, 844, { clear: true });
const defaultKeyboard = await rect('#screen-keyboard');
check('default-untouched', await evaluate(`!document.querySelector('[data-pcl-placed]') && !localStorage.length`), { keyboard: defaultKeyboard });
await layoutSane('390-padrao');
await shot('01-390-padrao');

// 2. Outside the edit mode a tap on a FAB is the FAB's own action.
await tap(defaultKeyboard.cx, defaultKeyboard.cy);
check('tap-outside-edit-fires', (await hits()).includes('screen-keyboard'), { hits: await hits() });
await evaluate('window.labHits.length = 0');

// 3. Edit mode: drag the keyboard FAB to the upper left; no action fires.
const organize = await rect('#organize');
await tap(organize.cx, organize.cy);
check('enter-edit', await evaluate('document.body.dataset.controlLayoutEditing === "true" && !!document.querySelector(".pcl-bar")'));
await shot('02-390-editando');
await drag(defaultKeyboard.cx, defaultKeyboard.cy, 60, 170);
const moved = await rect('#screen-keyboard');
check('drag-moves-float', Math.abs(moved.cx - 60) < 30 && Math.abs(moved.cy - 170) < 30, { moved });
await tap(moved.cx, moved.cy);
const scroll = await rect('#screen-scroll');
await tap(scroll.cx, scroll.cy);
check('edit-swallows-actions', (await hits()).length === 0, { hits: await hits() });
await shot('03-390-arrastado');

// 4. Save persists, reload restores it.
const saveButton = await rect('.pcl-button[data-pcl="save"]');
await tap(saveButton.cx, saveButton.cy);
const stored = await evaluate('JSON.stringify(Object.fromEntries(Object.entries(localStorage)))');
check('save-writes-storage', /screen\.keyboard/.test(stored) && !/screen-keyboard|Teclado|keyboard\b.*label/i.test(stored.replace(/screen\.keyboard/g, '')), { stored });
check('save-leaves-edit', await evaluate('!document.body.dataset.controlLayoutEditing && !document.querySelector(".pcl-layer")'));
await phone(390, 844);
const restored = await rect('#screen-keyboard');
check('reload-restores', Math.abs(restored.cx - moved.cx) < 4 && Math.abs(restored.cy - moved.cy) < 4, { restored });
await tap(restored.cx, restored.cy);
check('moved-fab-still-works', (await hits()).includes('screen-keyboard'), { hits: await hits() });
await evaluate('window.labHits.length = 0');
await layoutSane('390-salvo');
await shot('04-390-salvo-recarregado');

// 5. Other widths keep the saved spot proportionally, inside the safe area.
for (const [w, h] of [[320, 680], [360, 780], [430, 932]]) {
  await phone(w, h);
  const kb = await rect('#screen-keyboard');
  check(`width-${w}-placed`, kb.left < w / 2 && kb.top < h / 2, { kb });
  await layoutSane(`${w}-salvo`);
  await shot(`05-${w}-salvo`);
}

// 6. Cancel brings the saved layout back; Esc too.
await phone(390, 844);
const before = await rect('#screen-keyboard');
await evaluate('window.labLayout.enter()');
const inEdit = await rect('#screen-keyboard');
await drag(inEdit.cx, inEdit.cy, 300, 400);
const cancelButton = await rect('.pcl-button[data-pcl="cancel"]');
await tap(cancelButton.cx, cancelButton.cy);
const afterCancel = await rect('#screen-keyboard');
check('cancel-restores', Math.abs(afterCancel.cx - before.cx) < 4 && Math.abs(afterCancel.cy - before.cy) < 4, { afterCancel });
await evaluate('window.labLayout.enter()');
await drag(inEdit.cx, inEdit.cy, 300, 400);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(150);
const afterEsc = await rect('#screen-keyboard');
check('esc-cancels', await evaluate('!document.querySelector(".pcl-layer")') && Math.abs(afterEsc.cy - before.cy) < 4, { afterEsc });

// 7. Key row: with the composer open, drag the last movable key to the front
// of the tail; locked keys (Enter, Esc, ^C) stay put.
await evaluate('window.labComposer(true)');
await sleep(150);
await layoutSane('390-compositor');
await evaluate('window.labLayout.enter()');
await sleep(100);
const tailIds = () => evaluate(`Array.from(document.querySelectorAll('#screen-key-row .key-tail [data-shortcut]')).map(e => e.dataset.shortcut)`);
const headIds = () => evaluate(`Array.from(document.querySelectorAll('#screen-key-row .key-head [data-shortcut]')).map(e => e.dataset.shortcut)`);
const tail0 = await tailIds();
const first = await rect('#screen-key-row .key-tail [data-shortcut="tab"]');
const down = await rect('#screen-key-row .key-tail [data-shortcut="down"]');
await drag(first.cx, first.cy, down.cx + down.width * 0.3, down.cy, 18);
const tail1 = await tailIds();
check('drag-reorders-keys', tail1.join() !== tail0.join() && tail1.indexOf('tab') > tail0.indexOf('tab'), { tail0, tail1 });
const lockedTry = await rect('#screen-key-row .key-head [data-shortcut="esc"]');
await drag(lockedTry.cx, lockedTry.cy, lockedTry.cx + 120, lockedTry.cy);
check('locked-keys-stay', (await headIds()).join() === 'enter,esc,ctrl-c', { head: await headIds() });
check('edit-swallows-keys', (await hits()).length === 0, { hits: await hits() });
await shot('06-390-teclas-editando');
await evaluate('window.labLayout.save()');
await sleep(100);
await phone(390, 844);
await evaluate('window.labComposer(true)');
await sleep(150);
const tail2 = await tailIds();
check('key-order-persists', tail2.join() === tail1.join(), { tail2 });
const tabKey = await rect('#screen-key-row .key-tail [data-shortcut="tab"]');
await tap(tabKey.cx, tabKey.cy);
check('moved-key-still-works', (await hits()).includes('tab'), { hits: await hits() });
await evaluate('window.labHits.length = 0');
await shot('07-390-teclas-salvas');

// 8. Keyboard open: the visual viewport shrinks (emulated as a short screen)
// and the composer sits on top of it; saved floats move up, never under it.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 470, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
await evaluate('window.labKeyboard(true); window.labComposer(true)');
await sleep(300);
await layoutSane('390-teclado-aberto');
await shot('08-390-teclado-aberto');
await evaluate('window.labKeyboard(false); window.labComposer(false)');

// 9. Landscape keeps its own positions: portrait's move does not leak in,
// and a landscape move is saved apart from it.
await phone(844, 390);
const landscapeKeyboard = await rect('#screen-keyboard');
await layoutSane('844-paisagem-padrao');
await shot('09-paisagem-padrao');
await evaluate('window.labLayout.enter()');
await drag(landscapeKeyboard.cx, landscapeKeyboard.cy, 420, 120);
await shot('10-paisagem-editando');
await evaluate('window.labLayout.save()');
await sleep(100);
const snap = await evaluate('window.labLayout.snapshot()');
check('landscape-separate', !!snap.pos.landscape['screen.keyboard'] && !!snap.pos.portrait['screen.keyboard']
  && JSON.stringify(snap.pos.landscape['screen.keyboard']) !== JSON.stringify(snap.pos.portrait['screen.keyboard']), { snap });
await layoutSane('844-paisagem-salvo');
await shot('11-paisagem-salvo');

// 10. Rotation applies the matching saved layout without a reload.
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
await sleep(400);
const rotated = await rect('#screen-keyboard');
check('rotate-applies-portrait', Math.abs(rotated.cx - restored.cx) < 4 && Math.abs(rotated.cy - restored.cy) < 4, { rotated });

// 11. Restore default from the edit mode, then Save: storage is cleared and
// the rail is back where styles.css puts it.
await evaluate('window.labLayout.enter()');
const resetButton = await rect('.pcl-button[data-pcl="reset"]');
await tap(resetButton.cx, resetButton.cy);
const saveAgain = await rect('.pcl-button[data-pcl="save"]');
await tap(saveAgain.cx, saveAgain.cy);
const back = await rect('#screen-keyboard');
check('reset-default', await evaluate('!localStorage.length && !document.querySelector("[data-pcl-placed]")') && Math.abs(back.cy - defaultKeyboard.cy) < 2, { back });
await shot('12-390-restaurado');

await send('Emulation.clearDeviceMetricsOverride');
await evaluate('localStorage.clear()');
const failed = results.filter(r => !r.ok);
writeFileSync(join(out, 'checks.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
console.log(JSON.stringify({ total: results.length, failed: failed.map(r => r.check) }));
ws.close();
process.exit(failed.length ? 1 : 0);

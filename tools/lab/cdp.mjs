#!/usr/bin/env node
// Drive the Ponte page in a debuggable Chrome (emulator or a phone's Chrome
// with USB debugging) through CDP: real multi-touch gestures and exact layout
// readings, which adb "input" cannot produce.
//
//   adb -s SERIAL forward tcp:9222 localabstract:chrome_devtools_remote
//   tools/lab/cdp.mjs eval 'screenScale'
//   tools/lab/cdp.mjs pinch 540 1073 150 500      # centre, start/end distance (device px)
//   tools/lab/cdp.mjs tap 540 1073
//   tools/lab/cdp.mjs drag 300 900 600 1100 [holdMs]  # one finger press-and-move
//   tools/lab/cdp.mjs two-drag 540 1000 540 800     # two fingers moving together (scroll/pan)
//   tools/lab/cdp.mjs hold-drag 300 900 700 1000 700 700 [holdMs]  # rest finger A, then drag B (scroll under A)
//   tools/lab/cdp.mjs rect                          # image rect + monitor + scale, as JSON
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
const pages = await (await fetch(`${endpoint}/json`)).json();
// CDP_PAGE picks this lab's tab when several labs share one browser.
const wanted = new RegExp(process.env.CDP_PAGE || '8799|ponte', 'i');
const page = pages.find(p => p.type === 'page' && wanted.test(p.url)) || (process.env.CDP_PAGE ? null : pages.find(p => p.type === 'page'));
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result?.result?.value; };
// CDP touch points are in CSS px; adb/screenshots speak device px.
const dpr = await evaluate('window.devicePixelRatio');
const css = v => v / dpr;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x: css(x), y: css(y), id: i, radiusX: 3, radiusY: 3, force: 1 })) });
const [cmd, ...rest] = process.argv.slice(2); const n = rest.map(Number);
async function pinch(cx, cy, d0, d1, steps = 16, orientation = 'h') {
  const at = d => orientation === 'h' ? [[cx - d / 2, cy], [cx + d / 2, cy]] : [[cx, cy - d / 2], [cx, cy + d / 2]];
  await touch('touchStart', at(d0));
  for (let i = 1; i <= steps; i++) { await touch('touchMove', at(d0 + (d1 - d0) * i / steps)); await sleep(16); }
  await touch('touchEnd', []);
}
async function tap(x, y) { await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []); }
async function drag(x0, y0, x1, y1, hold = 0, steps = 12) {
  await touch('touchStart', [[x0, y0]]); if (hold) await sleep(hold);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await sleep(30); }
  await sleep(60); await touch('touchEnd', []);
}
async function twoDrag(x0, y0, x1, y1, steps = 12, gap = 120) {
  const at = (x, y) => [[x - gap / 2, y], [x + gap / 2, y]];
  await touch('touchStart', at(x0, y0));
  for (let i = 1; i <= steps; i++) { await touch('touchMove', at(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)); await sleep(30); }
  await touch('touchEnd', []);
}
// Finger A lands and rests; after holdMs finger B lands and drags while A stays.
async function holdDrag(ax, ay, bx0, by0, bx1, by1, hold = 400, steps = 12) {
  await touch('touchStart', [[ax, ay]]); await sleep(hold);
  await touch('touchStart', [[ax, ay], [bx0, by0]]);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[ax, ay], [bx0 + (bx1 - bx0) * i / steps, by0 + (by1 - by0) * i / steps]]); await sleep(30); }
  await sleep(60); await touch('touchEnd', []);
}
const rectExpr = `(() => { const r = document.querySelector('#screen-image').getBoundingClientRect(); const p = document.querySelector('#screen-preview').getBoundingClientRect(); const d = window.devicePixelRatio; return { dpr: d, scale: typeof screenScale === 'number' ? screenScale : null, image: { x: r.left * d, y: r.top * d, w: r.width * d, h: r.height * d }, preview: { x: p.left * d, y: p.top * d, w: p.width * d, h: p.height * d }, natural: [document.querySelector('#screen-image').naturalWidth, document.querySelector('#screen-image').naturalHeight], monitor: document.querySelector('#monitor-select')?.value, mode: document.querySelector('#screen-stage')?.getAttribute('data-screen-mode') }; })()`;
import { readFileSync } from 'node:fs';
const labDir = process.env.PONTE_LAB_DIR || `${process.cwd()}/.work/lab`;
const monitorSize = (process.env.PONTE_LAB_MONITOR || '1920x1080').split('x').map(Number);
function lastClick() {
  try {
    const lines = readFileSync(`${labDir}/events.jsonl`, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { const e = JSON.parse(lines[i]); if (e.tool === 'ydotool' && e.args[0] === 'click' && /^0xc[01]$/i.test(e.args[1])) return e; }
  } catch {}
  return null;
}
// Tap at fractions of the *visible* part of the image and compare with where
// the server put the cursor; exact expectation from the live image rect.
async function tapCheck(label, fractions, tolerance = 3) {
  const r = await evaluate(rectExpr);
  const vis = { x: Math.max(r.image.x, r.preview.x), y: Math.max(r.image.y, r.preview.y) };
  vis.w = Math.min(r.image.x + r.image.w, r.preview.x + r.preview.w) - vis.x; vis.h = Math.min(r.image.y + r.image.h, r.preview.y + r.preview.h) - vis.y;
  let worst = 0, misses = 0;
  for (const [fx, fy] of fractions) {
    const tx = vis.x + fx * (vis.w - 1), ty = vis.y + fy * (vis.h - 1);
    const ex = Math.round((tx - r.image.x) / r.image.w * monitorSize[0]), ey = Math.round((ty - r.image.y) / r.image.h * monitorSize[1]);
    const before = lastClick();
    await tap(tx, ty);
    let event = null;
    for (let i = 0; i < 60; i++) { await sleep(50); event = lastClick(); if (event && (!before || event.t !== before.t)) break; event = null; }
    if (!event) { misses++; console.log(`${label} tap ${fx},${fy}: no click reached the server`); continue; }
    const err = Math.max(Math.abs(event.cursor.x - ex), Math.abs(event.cursor.y - ey)); worst = Math.max(worst, err);
    if (err > tolerance) misses++;
    console.log(`${label} tap ${fx},${fy} expected (${ex},${ey}) got (${event.cursor.x},${event.cursor.y}) err ${err}px${err > tolerance ? '  <-- MISS' : ''}`);
    await sleep(200);
  }
  console.log(`${label}: scale ${r.scale} natural ${r.natural.join('x')} worst ${worst}px, ${misses} misses`);
  return misses;
}
switch (cmd) {
  case 'tap-check': process.exitCode = await tapCheck(rest[0] || 'taps', [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.3, 0.7], [0.7, 0.3]]) ? 1 : 0; break;
  case 'eval': console.log(JSON.stringify(await evaluate(rest.join(' ')))); break;
  case 'text': await send('Input.insertText', { text: rest.join(' ') }); break;
  case 'key': { const key = rest[0]; const codes = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27 }; const params = { key, code: key, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0 }; await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(key === 'Enter' ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }); break; }
  case 'click': await evaluate(`document.querySelector(${JSON.stringify(rest[0])}).click(), 1`); break;
  case 'rect': console.log(JSON.stringify(await evaluate(rectExpr))); break;
  case 'pinch': await pinch(n[0], n[1], n[2], n[3], n[4] || 16, rest[5] || 'h'); break;
  case 'tap': await tap(n[0], n[1]); break;
  case 'drag': await drag(n[0], n[1], n[2], n[3], n[4] || 0); break;
  case 'two-drag': await twoDrag(n[0], n[1], n[2], n[3]); break;
  case 'hold-drag': await holdDrag(n[0], n[1], n[2], n[3], n[4], n[5], n[6] || 400); break;
  default: console.error('unknown command'); process.exit(1);
}
ws.close();

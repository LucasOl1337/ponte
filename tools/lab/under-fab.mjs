#!/usr/bin/env node
// The owner's case: a PC target sits right under the floating mic. Zoom in,
// pan toward it with real two-finger touches until the view stops moving, then
// tap where the target is and check whether the click reached the PC.
//
//   CDP_URL=... LAB_URL='http://127.0.0.1:PORT/#pair=TOKEN' PONTE_LAB_DIR=... \
//     tools/lab/under-fab.mjs --target 3390,1400 [--quality sharp] [--zoom max|N] [--landscape] [--keyboard] [--shot out.png]
//
// Run the lab with PONTE_LAB_TARGET_D=3330,1330,100,80 (a button in the
// bottom-right corner of a 3440x1440 monitor) so the target is drawn and named.
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
const labUrl = process.env.LAB_URL;
const labDir = process.env.PONTE_LAB_DIR || `${process.cwd()}/.work/lab`;
let [dw, dh, dpr] = opt('--device', '394x853x3.25').split('x').map(Number);
if (args.includes('--landscape')) [dw, dh] = [dh, dw];
const keyboard = args.includes('--keyboard');
const [tx, ty] = opt('--target', '3380,1370').split(',').map(Number);
const zoomArg = opt('--zoom', 'max');
const shot = opt('--shot', '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const version = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}, sessionId) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (method, params) => send(method, params, sessionId);
const evaluate = async expr => { const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
const touch = (type, points) => s('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 3, radiusY: 3, force: 1 })) });
// While zoomed, one finger pans the view (two fingers sent through CDP arrive
// as one pointermove per finger, so their spacing wobbles and reads as a pinch).
async function drag(x0, y0, x1, y1, steps = 14) {
  await touch('touchStart', [[x0, y0]]);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); await sleep(16); }
  await touch('touchEnd', []);
  await sleep(120);
}
function clicks() {
  try { return readFileSync(`${labDir}/events.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.tool === 'ydotool' && e.args[0] === 'click' && /^0xc[01]$/i.test(e.args[1])); }
  catch { return []; }
}
const where = `(() => {
  const monitor = selectedMonitor(); const img = screenSurface().getBoundingClientRect();
  const x = img.left + ${tx} / monitor.width * img.width, y = img.top + ${ty} / monitor.height * img.height;
  const under = document.elementFromPoint(x, y);
  const name = under ? (under.id ? '#' + under.id : (under.closest('button')?.id ? '#' + under.closest('button').id : under.className || under.tagName)) : null;
  return { x, y, under: name, reachesStream: !!under && !!under.closest('#screen-preview') && !under.closest('button'), pan: [Math.round(screenPanX), Math.round(screenPanY)], scale: +screenScale.toFixed(2), base: [Math.round(screenBaseW), Math.round(screenBaseH)], preview: [screenPreviewSize().w, screenPreviewSize().h], surface: [img.left, img.top, img.width, img.height].map(Math.round) };
})()`;
const report = { device: [dw, dh, dpr], target: [tx, ty], steps: [] };
try {
  await s('Network.enable');
  await s('Network.setBypassServiceWorker', { bypass: true });
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Emulation.setDeviceMetricsOverride', { width: dw, height: keyboard ? Math.round(dh * 0.6) : dh, deviceScaleFactor: dpr, mobile: true, screenOrientation: dw > dh ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Page.enable');
  await s('Page.navigate', { url: labUrl });
  await sleep(2500);
  await evaluate(`location.hash = '#tela'`);
  for (let i = 0; i < 40; i++) { if (await evaluate(`document.querySelector('#screen-stage')?.getAttribute('data-screen-mode') === 'live' && !!document.querySelector('#screen-image').naturalWidth`)) break; await sleep(250); }
  report.version = await evaluate('typeof UI_VERSION === "string" ? UI_VERSION : null');
  const quality = opt('--quality', '');
  if (quality) {
    // A sharper profile streams more pixels, so the page allows a deeper zoom.
    await evaluate(`(() => { const select = document.querySelector('#live-quality'); select.value = ${JSON.stringify(quality)}; select.dispatchEvent(new Event('change')); return 1; })()`);
    await sleep(1500);
    for (let i = 0; i < 40; i++) { if (await evaluate(`document.querySelector('#screen-stage')?.getAttribute('data-screen-mode') === 'live' && screenNaturalSize().w > 2000`)) break; await sleep(250); }
    await evaluate('applyScreenZoom(); 1');
  }
  if (keyboard) {
    // The IME shrinks the viewport by ~40%; the page sees a keyboard against the taller baseline.
    await evaluate(`viewportBaseline = { width: ${dw}, height: ${dh} }; openScreenComposer(); syncRemoteViewport(); 1`);
    await sleep(500);
  }
  report.quality = await evaluate(`[document.querySelector('#live-quality').value, screenNaturalSize().w, screenMaxScale]`);
  report.atOne = await evaluate(where);
  const zoom = zoomArg === 'max' ? await evaluate('screenMaxScale') : Number(zoomArg);
  await evaluate(`zoomScreenAround(${zoom}); 1`);
  await sleep(300);
  // Pan toward the target (bottom-right): the finger moves up and left, many
  // strokes, until the view stops moving.
  const rect = await evaluate(`(() => { const r = document.querySelector('#screen-preview').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const cx = rect[0] + rect[2] * 0.45, cy = rect[1] + rect[3] * 0.45;
  let last = '';
  for (let i = 0; i < 14; i++) {
    await drag(cx + 80, cy + 80, cx - 80, cy - 80);
    const now = await evaluate(where);
    report.steps.push(now);
    const key = JSON.stringify(now.pan);
    if (key === last) break;
    last = key;
  }
  const final = report.steps.at(-1);
  report.final = final;
  const before = clicks().length;
  // Tap exactly where the target is, whatever is on top there.
  await touch('touchStart', [[final.x, final.y]]); await sleep(40); await touch('touchEnd', []);
  await sleep(1200);
  const after = clicks();
  const fresh = after.slice(before);
  report.clickReachedPC = fresh.length > 0;
  report.clickTarget = fresh.at(-1)?.target ?? null;
  report.clickCursor = fresh.at(-1)?.cursor ?? null;
  if (shot) {
    await sleep(900);
    const { result } = await s('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(result.data, 'base64'));
    report.shot = shot;
  }
  console.log(JSON.stringify(report, null, 1));
} finally {
  await send('Target.closeTarget', { targetId });
  ws.close();
}

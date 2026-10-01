#!/usr/bin/env node
// What floats over the streamed monitor on the Screen tab, and how much of the
// visible image each piece covers. Drives a desktop Chromium (an agent bench,
// never the owner's browser) through CDP with phone emulation, against a lab.
//
//   CDP_URL=http://127.0.0.1:PORT LAB_URL='http://127.0.0.1:8861/#pair=TOKEN' \
//     tools/lab/overlays.mjs [--device 394x853x3.25] [--landscape] [--keyboard] [--zoom 3] [--message] [--shot out.png] [--json]
//
// --keyboard opens the typing bar and shrinks the visual viewport by the
// height of a phone keyboard (40% of the screen), the way the IME does.
// --target X,Y (monitor px) also reports whether that monitor pixel is under a
// control, and whether any pan can bring it into a free spot.
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const flag = name => args.includes(name);
const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
const labUrl = process.env.LAB_URL;
if (!labUrl) { console.error('LAB_URL is required'); process.exit(2); }
let [dw, dh, dpr] = opt('--device', '394x853x3.25').split('x').map(Number);
if (flag('--landscape')) [dw, dh] = [dh, dw];
const keyboard = flag('--keyboard');
const zoom = Number(opt('--zoom', '1'));
const shot = opt('--shot', '');
const target = opt('--target', '');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const version = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = event => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}, sessionId) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
// Own tab, closed at the end: the bench browser may hold other pages.
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (method, params) => send(method, params, sessionId);
const evaluate = async expr => { const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };
try {
  const height = keyboard ? Math.round(dh * 0.6) : dh;
  await s('Emulation.setDeviceMetricsOverride', { width: dw, height, deviceScaleFactor: dpr, mobile: true, screenOrientation: dw > dh ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Mobile Safari/537.36' });
  await s('Network.enable');
  await s('Network.setBypassServiceWorker', { bypass: true });
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Page.enable');
  await s('Page.navigate', { url: labUrl.replace(/#.*/, '') + (labUrl.includes('#pair=') ? labUrl.slice(labUrl.indexOf('#pair=')) : '') });
  await sleep(2500);
  await evaluate(`location.hash = '#tela'`);
  // Wait for a live frame.
  for (let i = 0; i < 40; i++) { if (await evaluate(`document.querySelector('#screen-stage')?.getAttribute('data-screen-mode') === 'live' && !!document.querySelector('#screen-image').naturalWidth`)) break; await sleep(250); }
  if (keyboard) {
    // The IME shrinks the viewport; keep a taller baseline so the page sees a keyboard.
    await evaluate(`viewportBaseline = { width: ${dw}, height: ${dh} }; openScreenComposer(); syncRemoteViewport(); 1`);
    await sleep(400);
  }
  if (zoom > 1) { await evaluate(`zoomScreenAround(${zoom}); 1`); await sleep(300); }
  // --message shows a long "you said" bubble and a toast, the worst case for reading.
  if (flag('--message')) {
    await evaluate(`dictationStatus(document.querySelector('#screen-dictate-status'), 'Você disse: abre o terminal do projeto ponte e roda os testes de novo, depois manda o resultado pro Lucas no canal da rodada', false, true); toast('Copiado para a área de transferência do PC'); 1`);
    await sleep(300);
  }
  const report = await evaluate(`(() => {
    const box = el => { if (!el || el.hidden) return null; const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden') return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height, opacity: Number(st.opacity) } : null; };
    const inter = (a, b) => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h); return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null; };
    const preview = box(document.querySelector('#screen-preview'));
    const image = box(screenSurface());
    const visible = preview && image ? inter(preview, image) : null;
    const items = {
      fabs: '.screen-fabs', scroll: '#screen-scroll', monitor: '#screen-switch-monitor', rotate: '#screen-rotate', keyboard: '#screen-keyboard', mic: '#screen-dictate',
      workspaces: '#screen-workspaces', dictation: '#screen-dictate-status', toast: '#toast', composer: '#screen-composer', nav: '#bottom-nav', note: '#live-note', handle: '#screen-fabs-handle',
    };
    const out = {};
    for (const [name, selector] of Object.entries(items)) {
      const b = box(document.querySelector(selector));
      if (!b) continue;
      const hit = visible ? inter(b, visible) : null;
      out[name] = { box: [b.x, b.y, b.w, b.h].map(Math.round), coversImagePx2: hit ? Math.round(hit.w * hit.h) : 0, coversImagePct: hit && visible ? +(100 * hit.w * hit.h / (visible.w * visible.h)).toFixed(1) : 0, opacity: b.opacity };
    }
    return { viewport: [innerWidth, innerHeight, devicePixelRatio], visualViewport: [visualViewport.width, visualViewport.height], preview: preview && [preview.x, preview.y, preview.w, preview.h].map(Math.round), image: image && [image.x, image.y, image.w, image.h].map(Math.round), visible: visible && [visible.x, visible.y, visible.w, visible.h].map(Math.round), scale: screenScale, pan: [Math.round(screenPanX), Math.round(screenPanY)], body: { keyboard: document.body.dataset.keyboardOpen, composer: document.body.dataset.screenComposer }, items: out };
  })()`);
  if (target) {
    const [tx, ty] = target.split(',').map(Number);
    report.target = await evaluate(`(() => {
      const monitor = selectedMonitor(); const img = screenSurface().getBoundingClientRect();
      const x = img.left + ${tx} / monitor.width * img.width, y = img.top + ${ty} / monitor.height * img.height;
      const under = document.elementFromPoint(x, y);
      return { client: [Math.round(x), Math.round(y)], topElement: under ? (under.id || under.className || under.tagName) : null, reachesStream: !!under && !!under.closest('#screen-preview') && !under.closest('button') };
    })()`);
  }
  if (shot) {
    const { result } = await s('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(shot, Buffer.from(result.data, 'base64'));
    report.shot = shot;
  }
  console.log(flag('--json') ? JSON.stringify(report) : JSON.stringify(report, null, 1));
} finally {
  await send('Target.closeTarget', { targetId });
  ws.close();
}

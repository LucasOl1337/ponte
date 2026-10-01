#!/usr/bin/env node
// The phone's Auto over a simulated link: what the page shows, second by
// second, and how readable it is. A client that behaves like public/app.js
// with Auto chosen (the video with acks and no stage limit, JPEG Sharp from
// /api/stream, and the page's own createAutoChooser read out of app.js to pick
// between them) talks to an in-process lab server with the fake desktop tools
// (tools/lab/bin: the synthetic monitor, never the real screen).
//
//   RD_LINK_CLIENT=tools/lab/auto-measure.mjs tools/lab/rd-link.sh --plan 0:2500kbit --seconds 60 --timeline
//
// Options: --size 3440x1440, --seconds, --plan/--netem (as rd-measure.mjs,
// inside rd-link.sh only), --port, --start video|jpeg, --legible-db 27,
// --timeline, --video-only (the page before Auto could pick JPEG).
// Readability is the PSNR of a block of still text (22% × 9% of the monitor at 2%,10%: clear of the lab's targets, cursor, terminal and
// band) against what the picture is made from: the backdrop for the video,
// the synthetic monitor's lossless PNG for the JPEG frames. With
// PONTE_RD_LAB_BACKDROP from text-backdrop.sh, 27 dB is as readable as Sharp.
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const seconds = Math.min(Number(opt('seconds', 30)), 600);
const [mw, mh] = String(opt('size', '3440x1440')).split('x').map(Number);
const plan = String(opt('plan', '')).split(',').filter(Boolean).map(step => { const [at, rate] = step.split(':'); return { at: Number(at), rate }; });
const netem = opt('netem', 'delay 12ms loss 1% limit 150');
const threshold = Number(opt('legible-db', 27));
if ((plan.length || opt('netem')) && !process.env.PONTE_LAB_NETNS) { console.error('--plan/--netem only run inside tools/lab/rd-link.sh'); process.exit(2); }

// The fake desktop: fake grim/hyprctl first on PATH and a Wayland display that
// does not exist, so nothing can reach the owner's screen.
const lab = await mkdtemp(path.join(os.tmpdir(), 'ponte-auto-measure-'));
const backdrop = process.env.PONTE_RD_LAB_BACKDROP || path.join(root, 'docs/assets/desktop-control.png');
Object.assign(process.env, { PATH: `${path.join(root, 'tools/lab/bin')}:${process.env.PATH}`, WAYLAND_DISPLAY: 'ponte-lab-none', PONTE_LAB_DIR: lab, PONTE_LAB_MONITOR: `${mw}x${mh}`, PONTE_LAB_BACKDROP: backdrop, PONTE_RD_LAB_BACKDROP: backdrop });
const { createApp } = await import('../../server.mjs');
const { connect } = await import('../../backend/ws.mjs');
const { parseVideoHeader } = await import('../../backend/rd.mjs');

// The page's chooser, as the page has it.
const appSource = await readFile(path.join(root, 'public/app.js'), 'utf8');
const context = vm.createContext({ Math, Number, String, Date });
vm.runInContext(`${appSource.slice(appSource.indexOf('const LIVE_LADDER ='), appSource.indexOf('\nfunction applyLiveProfile('))}\nglobalThis.create = createAutoChooser; globalThis.linkKbps = jpegLinkKbps;`, context);
const chooser = context.create();
if (opt('start') === 'jpeg') { chooser.start(); for (let i = 0; i < 2; i++) chooser.video(false); }

await mkdir(path.join(lab, 'public'));
await writeFile(path.join(lab, 'public', 'index.html'), '');
const token = 'measure_token_with_at_least_thirty_two_chars';
const app = await createApp({
  rootDir: lab, dataDir: path.join(lab, 'private'), token,
  rdOptions: { captureMode: 'lab', labScene: 'desktop', inputMode: 'off', clipboard: { watch: () => () => {}, write: async () => {} }, kbps: Number(opt('kbps', 12000)), log: { info() {}, error: console.error } },
});
await new Promise(resolve => app.server.listen(Number(opt('port', 0)), '127.0.0.1', resolve));
const port = app.server.address().port;

const tc = args => { try { execFileSync('tc', args, { stdio: 'ignore' }); } catch { console.error(`tc ${args.join(' ')} failed`); } };
const shape = rate => tc(['qdisc', 'change', 'dev', 'lo', 'parent', '1:1', 'handle', '10:', 'netem', ...netem.split(' '), ...(rate && rate !== 'none' ? ['rate', rate] : [])]);
if (process.env.PONTE_LAB_NETNS && (plan.length || opt('netem'))) shape(plan[0]?.rate);

const t0 = Date.now();
const since = () => (Date.now() - t0) / 1000;
const shown = [];        // { at, kind: 'video'|'jpeg', width, index } every frame put on screen
const units = [];        // H.264 of every video run, in arrival order
const jpegs = [];        // sampled JPEG frames { at, data }
const switches = [];
let mode = null, ws = null, request = null, bytesThisSecond = 0, room = undefined;

function startVideo() {
  mode = 'video'; switches.push({ s: since(), to: 'video' });
  chooser.start();
  let native = true, width = 0, ackSeq = 0, ackSent = 0, lastAckAt = -Infinity, ackTimer = null;
  const sendAck = () => { ackTimer = null; if (ackSeq === ackSent || !ws) return; lastAckAt = performance.now(); ackSent = ackSeq; ws.send(JSON.stringify({ t: 'ack', seq: ackSeq })); };
  connect(`ws://127.0.0.1:${port}/api/rd`).then(socket => {
    if (mode !== 'video') { socket.close(); return; }
    ws = socket;
    socket.send(JSON.stringify({ t: 'hello', v: 1, token, maxFps: 60, caps: { ack: true, key: true }, monitor: 'LAB-1', input: false }));
    socket.on('message', (data, binary) => {
      if (ws !== socket) return;
      if (!binary) {
        const m = JSON.parse(data);
        if (m.t === 'ready') { width = m.width; const monitor = m.monitors?.find(item => item.name === m.monitor); native = !(Number(monitor?.width) > Number(m.width)); }
        return;
      }
      const h = parseVideoHeader(data);
      if (h.seq > ackSeq) { ackSeq = h.seq; const wait = lastAckAt + 50 - performance.now(); if (!ackTimer) { if (wait <= 0) sendAck(); else ackTimer = setTimeout(sendAck, wait); } }
      units.push(Buffer.from(data.subarray(16)));
      shown.push({ at: Date.now(), kind: 'video', width, index: units.length - 1 });
      bytesThisSecond += data.length;
      if (!flag('video-only') && chooser.video(native) === 'jpeg') { ws = null; socket.close(); startJpeg(); }
    });
  }).catch(error => console.error('video', error.message));
}

function startJpeg() {
  mode = 'jpeg'; switches.push({ s: since(), to: 'jpeg' });
  let windowAt = Date.now(), windowBytes = 0, windowCapture = 0, lastSampled = -Infinity, pending = Buffer.alloc(0);
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stream?monitor=LAB-1&fps=15&scale=1&q=40', headers: { Authorization: `Bearer ${token}` } }, res => {
    windowAt = Date.now(); windowBytes = 0; windowCapture = 0;
    res.on('data', chunk => {
      if (request !== req) return;
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const head = pending.indexOf('\r\n\r\n');
        if (head < 0) break;
        const length = /Content-Length:\s*(\d+)/i.exec(pending.subarray(0, head).toString('latin1'));
        if (!length) { pending = pending.subarray(head + 4); continue; }
        const end = head + 4 + Number(length[1]);
        if (pending.length < end) break;
        const capture = /X-Capture-Ms:\s*(\d+)/i.exec(pending.subarray(0, head).toString('latin1'));
        if (capture) windowCapture += Number(capture[1]);
        const frame = pending.subarray(head + 4, end);
        pending = pending.subarray(end);
        const at = Date.now();
        windowBytes += frame.length; bytesThisSecond += frame.length;
        shown.push({ at, kind: 'jpeg', width: mw });
        if (at - lastSampled >= 250) { lastSampled = at; jpegs.push({ at, data: Buffer.from(frame) }); }
      }
    });
  });
  req.on('error', () => {});
  request = req;
  const window = setInterval(() => {
    if (request !== req) { clearInterval(window); return; }
    if (Date.now() - windowAt < 3000) return;
    const kbps = context.linkKbps(windowBytes, Date.now() - windowAt, windowCapture);
    windowAt = Date.now(); windowBytes = 0; windowCapture = 0; room = Math.round(kbps);
    if (chooser.jpeg(kbps) === 'video') { clearInterval(window); request = null; req.destroy(); startVideo(); }
  }, 1000);
}

const timeline = [];
let planIndex = 1;
const ticker = setInterval(() => {
  const second = Math.round(since());
  while (planIndex < plan.length && second >= plan[planIndex].at) shape(plan[planIndex++].rate);
  if (ws && mode === 'video') ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
  const session = app.rd.sessions[0];
  timeline.push({ s: second, link: plan.filter(step => step.at <= second).at(-1)?.rate ?? null, mode, kbps: Math.round(bytesThisSecond * 8 / 1000),
    encoder: mode === 'video' && session?.capture?.params ? `${session.capture.params.scale ? session.capture.params.scale.width : 'native'}/${session.capture.params.kbps}` : undefined, room });
  bytesThisSecond = 0; room = undefined;
}, 1000);

if (opt('start') === 'jpeg') startJpeg(); else startVideo();
await new Promise(r => setTimeout(r, seconds * 1000));
clearInterval(ticker);
mode = 'done'; ws?.close(); request?.destroy(); request = null;
await new Promise(r => setTimeout(r, 300));

// Readability of what was on screen.
const even = v => Math.round(v) & ~1;
const box = { x: even(mw * 0.023), y: even(mh * 0.1), w: even(mw * 0.221), h: even(mh * 0.09) };
const crop = `scale=${mw}:${mh}:flags=bicubic,format=yuv420p,crop=${box.w}:${box.h}:${box.x}:${box.y},format=gray`;
const size = box.w * box.h;
const ffmpegGray = (args, input) => new Promise(resolve => {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'quiet', ...args, '-vf', crop, '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks = []; child.stdout.on('data', c => chunks.push(c)); child.stdin.on('error', () => {});
  child.stdin.end(input); child.once('close', () => resolve(Buffer.concat(chunks)));
});
const psnr = (frame, reference) => { let sum = 0; for (let i = 0; i < size; i++) { const d = frame[i] - reference[i]; sum += d * d; } return 10 * Math.log10(255 * 255 / Math.max(1e-9, sum / size)); };
const scores = [];
const videoRef = await ffmpegGray(['-i', backdrop, '-frames:v', '1'], Buffer.alloc(0));
const videoFrames = shown.filter(f => f.kind === 'video');
if (units.length) {
  // Every fourth video frame (one frame per unit, in arrival order).
  const every = 4;
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'quiet', '-f', 'h264', '-i', 'pipe:0', '-fps_mode', 'passthrough', '-vf', `select='not(mod(n\\,${every}))',${crop}`, '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let pending = Buffer.alloc(0), index = 0;
  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= size) { const f = videoFrames[index * every]; if (f) scores.push({ at: f.at, kind: 'video', db: psnr(pending.subarray(0, size), videoRef) }); index++; pending = pending.subarray(size); }
  });
  child.stdin.on('error', () => {}); child.stdin.end(Buffer.concat(units));
  await new Promise(resolve => child.once('close', resolve));
}
if (jpegs.length) {
  const png = execFileSync(path.join(root, 'tools/lab/bin/grim'), ['-t', 'png', '-'], { maxBuffer: 64 << 20, env: process.env });
  const jpegRef = await ffmpegGray(['-f', 'png_pipe', '-i', 'pipe:0'], png);
  const gray = await ffmpegGray(['-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0'], Buffer.concat(jpegs.map(j => j.data)));
  for (let i = 0; i < jpegs.length && (i + 1) * size <= gray.length; i++) scores.push({ at: jpegs[i].at, kind: 'jpeg', db: psnr(gray.subarray(i * size, (i + 1) * size), jpegRef) });
}
// Each second: the worst picture shown in it; a second with nothing new keeps the last.
const perSecond = new Map();
for (const score of scores) { const s = Math.ceil((score.at - t0) / 1000); perSecond.set(s, Math.min(perSecond.get(s) ?? Infinity, score.db)); }
let last = null;
for (const row of timeline) { if (perSecond.has(row.s)) last = perSecond.get(row.s); row.db = last === null ? null : Math.round(last * 10) / 10; }
const rows = timeline.filter(row => row.db !== null);
const from = rows.find((row, i) => rows.slice(i).every(later => later.db >= threshold));
const readableShare = rows.length ? Math.round(rows.filter(row => row.db >= threshold).length / timeline.length * 1000) / 10 : 0;
const jpegFrames = shown.filter(f => f.kind === 'jpeg');
const report = {
  size: `${mw}x${mh}`, ...(plan.length ? { plan: opt('plan'), netem } : {}), seconds,
  firstReadableS: rows.find(row => row.db >= threshold)?.s ?? null, readableFromS: from?.s ?? null, readableShare,
  thresholdDb: threshold, switches, videoFrames: videoFrames.length, jpegFrames: jpegFrames.length,
  jpegFps: jpegFrames.length > 1 ? Math.round((jpegFrames.length - 1) / ((jpegFrames.at(-1).at - jpegFrames[0].at) / 1000) * 10) / 10 : null,
};
await app.close();
report.server = app.rd.metrics;
await rm(lab, { recursive: true, force: true });
console.log(JSON.stringify(report, null, 2));
if (flag('timeline')) for (const row of timeline) console.log(JSON.stringify(row));
process.exit(0);

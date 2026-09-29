#!/usr/bin/env node
// Measures a remote-desktop stream as a client sees it: delivered fps, bitrate,
// keyframe/delta sizes, frame latency (server send → arrival, same clock when
// local) and, with the lab pattern, glass-to-glass of the server (capture time
// painted in the band → send). In-process runs also print the server's own
// numbers (PES arrival → WebSocket send).
//
//   node tools/lab/rd-measure.mjs --lab [--seconds 8] [--fps 60] [--kbps 4000] [--size 1920x1080] [--scene desktop]
//   node tools/lab/rd-measure.mjs --gsr DP-3 [--seconds 8]      # real capture, view-only (input off)
//   node tools/lab/rd-measure.mjs --url ws://127.0.0.1:8799/api/rd --token-file .work/lab/data/token [--band]
//   tools/lab/rd-link.sh --plan 0:2500kbit --client old --seconds 60 --timeline   # over a simulated internet link
//
// --client old behaves like the page's rd.js up to 0.1.0-alpha.29: a ping and
// a stats report (fps, kbps, rtt, queue, drops, latency, p95) every second
// after the first ready. Without --client only pings go out, as before.
// --plan and --netem reshape the link during the run and only work inside
// rd-link.sh's private network namespace.
//
// Real captures are for short runs only (≤ 10 s); longer ones go through the
// agent-bench queue. Nothing here sends input.
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from '../../backend/ws.mjs';
import { parseVideoHeader } from '../../backend/rd.mjs';
import { BAND, readBand } from '../../backend/rd-capture.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const seconds = Math.min(Number(opt('seconds', 8)), flag('gsr') ? 10 : 600);
const epochNow = () => performance.timeOrigin + performance.now();
const client = opt('client', null);
const plan = String(opt('plan', '')).split(',').filter(Boolean).map(step => { const [at, rate] = step.split(':'); return { at: Number(at), rate }; });
const netem = opt('netem', 'delay 12ms loss 1% limit 150');
const warmup = Number(opt('warmup', 5));
if ((plan.length || opt('netem')) && !process.env.PONTE_LAB_NETNS) { console.error('--plan/--netem only run inside tools/lab/rd-link.sh'); process.exit(2); }

let url, token, app, root, band = flag('band') || flag('lab');
if (flag('lab') || flag('gsr')) {
  const { createApp } = await import('../../server.mjs');
  root = await mkdtemp(path.join(os.tmpdir(), 'ponte-rd-measure-'));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'index.html'), '');
  token = 'measure_token_with_at_least_thirty_two_chars';
  const [w, h] = String(opt('size', '1920x1080')).split('x').map(Number);
  const lab = flag('lab');
  const readMonitors = lab ? async () => [{ name: 'LAB-1', x: 0, y: 0, width: w, height: h, scale: 1, transform: 0, focused: true }] : undefined;
  app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token,
    rdOptions: {
      captureMode: lab ? 'lab' : 'gsr', inputMode: 'off', ...(readMonitors ? { readMonitors } : {}),
      ...(opt('scene') ? { labScene: opt('scene') } : {}),
      clipboard: { watch: () => () => {}, write: async () => {} },
      ...(opt('kbps') ? { kbps: Number(opt('kbps')) } : {}), log: { info() {}, error: console.error },
    },
  });
  await new Promise(resolve => app.server.listen(Number(opt('port', 0)), '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${app.server.address().port}/api/rd`;
} else {
  url = opt('url');
  token = (await readFile(opt('token-file'), 'utf8')).trim();
}
const port = Number(new URL(url).port);

const tc = args => { try { execFileSync('tc', args, { stdio: 'ignore' }); } catch { console.error(`tc ${args.join(' ')} failed`); } };
const shape = rate => tc(['qdisc', 'change', 'dev', 'lo', 'parent', '1:1', 'handle', '10:', 'netem', ...netem.split(' '), ...(rate && rate !== 'none' ? ['rate', rate] : [])]);
if (process.env.PONTE_LAB_NETNS && (plan.length || opt('netem'))) shape(plan[0]?.rate);

const ws = await connect(url);
const frames = [], texts = [];
const units = [];
// What the page keeps (rd.js): the last rtt, the clock offset from the ping
// with the smallest round trip, and send → arrival latencies for 5 s.
let rtt = null, clockOffset = 0, readyAt = null;
const pingSamples = [], latencies = [];
let secondFrames = 0, secondBytes = 0;
ws.on('message', (data, binary) => {
  const at = epochNow();
  if (binary) {
    const h = parseVideoHeader(data);
    frames.push({ ...h, at, bytes: data.length - 16 });
    if (band) units.push(Buffer.from(data.subarray(16)));
    secondFrames++; secondBytes += data.length;
    latencies.push({ at, value: at + clockOffset - h.sentAt });
    return;
  }
  const message = JSON.parse(data);
  texts.push({ at, ...message });
  if (message.t === 'ready' && readyAt === null) { readyAt = at; if (client) ws.send(JSON.stringify({ t: 'ping', c: epochNow() })); }
  if (message.t === 'pong' && typeof message.c === 'number' && typeof message.s === 'number') {
    const sample = { rtt: at - message.c, offset: message.s - (message.c + (at - message.c) / 2) };
    pingSamples.push(sample); if (pingSamples.length > 10) pingSamples.shift();
    rtt = sample.rtt;
    clockOffset = pingSamples.reduce((best, item) => item.rtt < best.rtt ? item : best).offset;
  }
});
ws.send(JSON.stringify({ t: 'hello', v: 1, token, maxFps: Number(opt('fps', 60)), ...(opt('gsr') ? { monitor: opt('gsr') } : {}) }));

const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100; };
const kernel = () => {
  try {
    const out = execFileSync('ss', ['-tinH', 'sport', '=', `:${port}`], { encoding: 'utf8' });
    const notsent = /notsent:(\d+)/.exec(out), delivery = /delivery_rate (\d+)bps/.exec(out);
    return { notsent: notsent ? Number(notsent[1]) : 0, deliveryKbps: delivery ? Math.round(Number(delivery[1]) / 1000) : null };
  } catch { return {}; }
};
const t0 = epochNow();
const timeline = [];
let planIndex = 1;
const ticker = setInterval(() => {
  const now = epochNow();
  const second = Math.round((now - t0) / 1000);
  while (planIndex < plan.length && second >= plan[planIndex].at) shape(plan[planIndex++].rate);
  if (!client) ws.send(JSON.stringify({ t: 'ping', c: now }));
  else if (readyAt !== null) {
    ws.send(JSON.stringify({ t: 'ping', c: now }));
    while (latencies.length && latencies[0].at < now - 5000) latencies.shift();
    const values = latencies.map(item => item.value).sort((a, b) => a - b);
    const report = { t: 'stats', fps: secondFrames, kbps: Math.round(secondBytes * 8 / 1000), rtt: rtt === null ? null : Math.round(rtt * 10) / 10, queue: 0, drops: 0 };
    if (values.length) { report.latency = Math.round(values.reduce((s, v) => s + v, 0) / values.length * 10) / 10; report.p95 = Math.round(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] * 10) / 10; }
    ws.send(JSON.stringify(report));
  }
  if (flag('timeline')) {
    const session = app?.rd.sessions[0];
    const params = session?.capture?.params;
    timeline.push({ s: second, link: plan.filter(step => step.at <= second).at(-1)?.rate ?? null, fps: secondFrames, kbps: Math.round(secondBytes * 8 / 1000), rtt: rtt === null ? null : Math.round(rtt),
      encoder: params ? `${params.fps}/${params.kbps}${params.scale ? `/${params.scale}` : ''}` : null, nodeBuffer: session ? session.ws.bufferedAmount : null, ...kernel() });
  }
  secondFrames = 0; secondBytes = 0;
}, 1000);
const t1 = Date.now();
while (!frames.length && Date.now() - t1 < 10000) await new Promise(r => setTimeout(r, 10));
const firstFrameMs = Date.now() - t1;
// --switch NAME: halfway through, change monitor (the same name restarts the
// encoder) and time the gap until the new run's first frame.
let switchAt = null;
const remaining = seconds * 1000 - (epochNow() - t0);
if (opt('switch')) {
  await new Promise(r => setTimeout(r, remaining / 2));
  switchAt = epochNow();
  ws.send(JSON.stringify({ t: 'monitor', name: opt('switch') }));
  await new Promise(r => setTimeout(r, remaining / 2));
} else await new Promise(r => setTimeout(r, Math.max(0, remaining)));
clearInterval(ticker);
const session = app?.rd.sessions[0];
ws.close();
await new Promise(r => setTimeout(r, 300));

const stats = values => ({ p50: pct(values, 0.5), p95: pct(values, 0.95), max: pct(values, 1) });
const ready = texts.find(m => m.t === 'ready');
const span = frames.length > 1 ? (frames.at(-1).at - frames[0].at) / 1000 : 1;
const keys = frames.filter(f => f.keyframe), deltas = frames.filter(f => !f.keyframe);
const avg = list => list.length ? Math.round(list.reduce((s, f) => s + f.bytes, 0) / list.length) : null;
const pongs = texts.filter(m => m.t === 'pong').map(m => m.at - m.c);
const gaps = frames.slice(1).map((f, i) => ({ at: f.at, gap: f.at - frames[i].at }));
const freezes = gaps.filter(g => g.gap > 250);
const report = {
  url: app ? '(in-process)' : url, ready: ready && { monitor: ready.monitor, width: ready.width, height: ready.height, fps: ready.fps, codec: ready.codec },
  ...(client ? { client } : {}), ...(plan.length ? { plan: opt('plan'), netem } : {}), ...(opt('scene') ? { scene: opt('scene') } : {}),
  firstFrameMs, frames: frames.length, seconds: Math.round(span * 10) / 10,
  fps: Math.round((frames.length - 1) / span * 10) / 10,
  kbps: Math.round(frames.reduce((s, f) => s + f.bytes, 0) * 8 / span / 1000),
  keyframes: keys.length, avgKeyBytes: avg(keys), avgDeltaBytes: avg(deltas),
  frameGapMs: stats(gaps.map(g => g.gap)),
  freezes: { over250ms: freezes.length, longestMs: Math.round(Math.max(0, ...freezes.map(f => f.gap))), totalMs: Math.round(freezes.reduce((s, f) => s + f.gap, 0)) },
  sendToArrivalMs: stats(frames.map(f => f.at - f.sentAt)),
  rttMs: stats(pongs),
  ...(session ? { restarts: session.metrics.restarts, serverDropped: session.metrics.dropped } : {}),
};
if (switchAt) {
  // The new run opens with a keyframe (a new ready only comes when the monitor or stream shape changes).
  const again = texts.filter(m => m.t === 'ready')[1];
  const next = frames.find(f => f.at > switchAt && f.keyframe);
  const last = frames.filter(f => f.at <= (next?.at ?? Infinity) && f !== next).at(-1);
  Object.assign(report, { switchTo: opt('switch'), switchReadyMs: again ? Math.round(again.at - switchAt) : null, switchToKeyframeMs: next ? Math.round(next.at - switchAt) : null, switchGapMs: next && last ? Math.round(next.at - last.at) : null });
}

if (band && units.length) {
  // Decode what arrived and read the capture time out of each frame's band.
  const width = BAND.bits * BAND.cell, size = width * BAND.cell;
  const decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'quiet', '-f', 'h264', '-i', 'pipe:0', '-fps_mode', 'passthrough', '-vf', `crop=${width}:${BAND.cell}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks = [];
  decoder.stdout.on('data', chunk => chunks.push(chunk));
  decoder.stdin.on('error', () => {});
  decoder.stdin.end(Buffer.concat(units));
  await new Promise(resolve => decoder.once('close', resolve));
  const gray = Buffer.concat(chunks);
  const glass = [], stamped = [];
  for (let i = 0; i * size + size <= gray.length && i < frames.length; i++) {
    const stamp = readBand(gray.subarray(i * size, i * size + size), width);
    if (Math.abs(stamp - frames[i].sentAt) > 60000) continue; // not a lab stream
    glass.push(frames[i].sentAt - stamp);
    stamped.push({ at: frames[i].at, value: frames[i].at - stamp, keyframe: frames[i].keyframe });
  }
  if (glass.length) {
    // After the warm-up: how late frames are, how often over half a second,
    // and the stretches that stay over it for more than a second.
    const settled = stamped.filter(f => f.at - t0 >= warmup * 1000);
    const late = [];
    let run = null;
    for (const f of settled) {
      if (f.value > 500) { run = run || { from: f.at, to: f.at }; run.to = f.at; }
      else if (run) { late.push(run); run = null; }
    }
    if (run) late.push(run);
    const long = late.filter(r => r.to - r.from > 1000);
    Object.assign(report, {
      bandFrames: glass.length, captureToSendMs: stats(glass), captureToArrivalMs: stats(stamped.map(f => f.value)),
      settled: { afterSeconds: warmup, captureToArrivalMs: stats(settled.map(f => f.value)), over500msShare: settled.length ? Math.round(settled.filter(f => f.value > 500).length / settled.length * 1000) / 10 : null,
        stretchesOver500msLongerThan1s: long.length, longestStretchMs: Math.round(Math.max(0, ...late.map(r => r.to - r.from))),
        freezesOver250ms: freezes.filter(f => f.at - t0 >= warmup * 1000).length },
    });
    for (const row of timeline) {
      const inSecond = stamped.filter(f => f.at >= t0 + (row.s - 1) * 1000 && f.at < t0 + row.s * 1000);
      row.c2aP95 = pct(inSecond.map(f => f.value), 0.95);
      row.keys = inSecond.filter(f => f.keyframe).length;
    }
  }
}

if (app) {
  await app.close();
  report.server = app.rd.metrics.at(-1);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
if (flag('timeline')) for (const row of timeline) console.log(JSON.stringify(row));
process.exit(0);

#!/usr/bin/env node
// Measures a remote-desktop stream as a client sees it: delivered fps, bitrate,
// keyframe/delta sizes, frame latency (server send → arrival, same clock when
// local) and, with the lab pattern, glass-to-glass of the server (capture time
// painted in the band → send). In-process runs also print the server's own
// numbers (PES arrival → WebSocket send).
//
//   node tools/lab/rd-measure.mjs --lab [--seconds 8] [--fps 60] [--kbps 4000] [--size 1920x1080]
//   node tools/lab/rd-measure.mjs --gsr DP-3 [--seconds 8]      # real capture, view-only (input off)
//   node tools/lab/rd-measure.mjs --url ws://127.0.0.1:8799/api/rd --token-file .work/lab/data/token [--band]
//
// Real captures are for short runs only (≤ 10 s); longer ones go through the
// agent-bench queue. Nothing here sends input.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from '../../backend/ws.mjs';
import { parseVideoHeader } from '../../backend/rd.mjs';
import { BAND, readBand } from '../../backend/rd-capture.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const flag = name => argv.includes(`--${name}`);
const seconds = Math.min(Number(opt('seconds', 8)), flag('gsr') ? 10 : 600);
const epochNow = () => performance.timeOrigin + performance.now();

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
      clipboard: { watch: () => () => {}, write: async () => {} },
      ...(opt('kbps') ? { kbps: Number(opt('kbps')) } : {}), log: { info() {}, error: console.error },
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${app.server.address().port}/api/rd`;
} else {
  url = opt('url');
  token = (await readFile(opt('token-file'), 'utf8')).trim();
}

const ws = await connect(url);
const frames = [], texts = [];
const units = [];
ws.on('message', (data, binary) => {
  const at = epochNow();
  if (binary) { const h = parseVideoHeader(data); frames.push({ ...h, at, bytes: data.length - 16 }); if (band) units.push(Buffer.from(data.subarray(16))); }
  else texts.push({ at, ...JSON.parse(data) });
});
ws.send(JSON.stringify({ t: 'hello', v: 1, token, maxFps: Number(opt('fps', 60)), ...(opt('gsr') ? { monitor: opt('gsr') } : {}) }));
const pinger = setInterval(() => ws.send(JSON.stringify({ t: 'ping', c: epochNow() })), 1000);
const t0 = Date.now();
while (!frames.length && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 10));
const firstFrameMs = Date.now() - t0;
// --switch NAME: halfway through, change monitor (the same name restarts the
// encoder) and time the gap until the new run's first frame.
let switchAt = null;
if (opt('switch')) {
  await new Promise(r => setTimeout(r, seconds * 500));
  switchAt = epochNow();
  ws.send(JSON.stringify({ t: 'monitor', name: opt('switch') }));
  await new Promise(r => setTimeout(r, seconds * 500));
} else await new Promise(r => setTimeout(r, seconds * 1000));
clearInterval(pinger);
ws.close();
await new Promise(r => setTimeout(r, 300));

const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100; };
const stats = values => ({ p50: pct(values, 0.5), p95: pct(values, 0.95), max: pct(values, 1) });
const ready = texts.find(m => m.t === 'ready');
const span = frames.length > 1 ? (frames.at(-1).at - frames[0].at) / 1000 : 1;
const keys = frames.filter(f => f.keyframe), deltas = frames.filter(f => !f.keyframe);
const avg = list => list.length ? Math.round(list.reduce((s, f) => s + f.bytes, 0) / list.length) : null;
const pongs = texts.filter(m => m.t === 'pong').map(m => m.at - m.c);
const report = {
  url: app ? '(in-process)' : url, ready: ready && { monitor: ready.monitor, width: ready.width, height: ready.height, fps: ready.fps, codec: ready.codec },
  firstFrameMs, frames: frames.length, seconds: Math.round(span * 10) / 10,
  fps: Math.round((frames.length - 1) / span * 10) / 10,
  kbps: Math.round(frames.reduce((s, f) => s + f.bytes, 0) * 8 / span / 1000),
  keyframes: keys.length, avgKeyBytes: avg(keys), avgDeltaBytes: avg(deltas),
  frameGapMs: stats(frames.slice(1).map((f, i) => f.at - frames[i].at)),
  sendToArrivalMs: stats(frames.map(f => f.at - f.sentAt)),
  rttMs: stats(pongs),
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
  const decoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-vf', `crop=${width}:${BAND.cell}:0:0,format=gray`, '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const chunks = [];
  decoder.stdout.on('data', chunk => chunks.push(chunk));
  decoder.stdin.end(Buffer.concat(units));
  await new Promise(resolve => decoder.once('close', resolve));
  const gray = Buffer.concat(chunks);
  const glass = [], glassArrival = [];
  for (let i = 0; i * size + size <= gray.length && i < frames.length; i++) {
    const stamp = readBand(gray.subarray(i * size, i * size + size), width);
    if (Math.abs(stamp - frames[i].sentAt) > 60000) continue; // not a lab stream
    glass.push(frames[i].sentAt - stamp); glassArrival.push(frames[i].at - stamp);
  }
  if (glass.length) Object.assign(report, { bandFrames: glass.length, captureToSendMs: stats(glass), captureToArrivalMs: stats(glassArrival) });
}

if (app) {
  await app.close();
  report.server = app.rd.metrics.at(-1);
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
process.exit(0);

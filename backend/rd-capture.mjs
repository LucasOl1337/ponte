// Screen capture for remote desktop: gpu-screen-recorder (or, in the lab, an
// ffmpeg test pattern) writes H.264 in MPEG-TS to stdout, and this module takes
// the TS apart into H.264 access units in Annex B, ready for WebCodecs.
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { closeSync, constants as fsConstants, mkdtempSync, openSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TS = 188;
export const BAND = { bits: 44, cell: 16 }; // lab time band: 44 cells of 16x16 px, top-left, MSB first, white = 1

// ---------------------------------------------------------------- H.264 bits

// NAL units of an Annex B buffer: [{ type, start, end }] where start is the
// first byte after the start code.
const START_CODE = Buffer.from([0, 0, 1]);
export function nalUnits(data) {
  const units = [];
  let start = -1;
  for (let i = data.indexOf(START_CODE); i >= 0; i = data.indexOf(START_CODE, i + 3)) {
    if (start >= 0) units.push({ type: data[start] & 0x1f, start, end: i - (i > start && data[i - 1] === 0 ? 1 : 0) });
    start = i + 3;
  }
  if (start >= 0 && start < data.length) units.push({ type: data[start] & 0x1f, start, end: data.length });
  return units;
}

// Keeps everything but filler data (type 12: CBR padding that NVENC adds and
// that is pure waste on the wire), each NAL behind a 4-byte start code.
export function stripFiller(data, units = nalUnits(data)) {
  if (!units.some(unit => unit.type === 12)) return data;
  const kept = units.filter(unit => unit.type !== 12);
  const out = Buffer.allocUnsafe(kept.reduce((sum, unit) => sum + 4 + unit.end - unit.start, 0));
  let offset = 0;
  for (const unit of kept) {
    out.writeUInt32BE(1, offset); offset += 4;
    offset += data.copy(out, offset, unit.start, unit.end);
  }
  return out;
}

function unescapeRbsp(data) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= 2 && data[i] === 3 && data[i - 1] === 0 && data[i - 2] === 0 && out.length >= 2 && out[out.length - 1] === 0 && out[out.length - 2] === 0) continue;
    out.push(data[i]);
  }
  return Buffer.from(out);
}

class Bits {
  constructor(data) { this.data = data; this.pos = 0; }
  bit() { const byte = this.data[this.pos >> 3]; if (byte === undefined) throw new Error('SPS truncated'); const value = (byte >> (7 - (this.pos & 7))) & 1; this.pos++; return value; }
  bits(n) { let value = 0; for (let i = 0; i < n; i++) value = value * 2 + this.bit(); return value; }
  ue() { let zeros = 0; while (!this.bit()) { if (++zeros > 31) throw new Error('bad exp-Golomb'); } return (2 ** zeros - 1) + this.bits(zeros); }
  se() { const value = this.ue(); return value & 1 ? (value + 1) / 2 : -value / 2; }
}

// Profile, level and coded size from a sequence parameter set (the NAL
// payload after its one-byte header). codec is the WebCodecs string.
export function parseSps(nal) {
  const hex = value => value.toString(16).padStart(2, '0');
  const profile = nal[1], constraints = nal[2], level = nal[3];
  const r = new Bits(unescapeRbsp(nal.subarray(1)));
  r.bits(24); r.ue();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue(); r.ue(); r.bit();
    if (r.bit()) {
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!r.bit()) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + r.se() + 256) % 256; last = next || last; }
      }
    }
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  r.ue(); r.bit();
  const widthMbs = r.ue() + 1, heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit();
  let width = widthMbs * 16, height = (2 - frameMbsOnly) * heightMapUnits * 16;
  if (r.bit()) {
    const [left, right, top, bottom] = [r.ue(), r.ue(), r.ue(), r.ue()];
    const cropX = chroma === 0 || chroma === 3 ? 1 : 2;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    width -= (left + right) * cropX; height -= (top + bottom) * cropY;
  }
  return { profile, constraints, level, width, height, codec: `avc1.${hex(profile)}${hex(constraints)}${hex(level)}` };
}

// ---------------------------------------------------------------- MPEG-TS

// Adaptation field bytes that are neither flags nor a known field are
// stuffing, and libavformat (ffmpeg and gpu-screen-recorder) only stuffs the
// packet that carries the end of a PES: so an access unit can leave as soon as
// its last packet arrives instead of waiting one frame for the next PES start.
function stuffed(packet) {
  const length = packet[4];
  if (length === 0) return true;
  const flags = packet[5];
  let known = 1;
  if (flags & 0x10) known += 6;
  if (flags & 0x08) known += 6;
  if (flags & 0x04) known += 1;
  if (flags & 0x02) known += 1 + (packet[4 + 1 + known] ?? 0);
  return length > known && !(flags & 0x01);
}

// Feeds on stdout chunks; calls onUnit({ data, keyframe, sps, pts, firstAt,
// lastAt, early }) once per PES of the H.264 stream. Resynchronizes on garbage
// (gpu-screen-recorder prints its output path on stdout).
export class TsDemuxer {
  constructor(onUnit, { now = () => performance.now() } = {}) {
    this.onUnit = onUnit; this.now = now;
    this.rest = Buffer.alloc(0);
    this.pmtPid = -1; this.videoPid = -1;
    this.pes = null;
    this.stats = { packets: 0, resyncs: 0, units: 0, early: 0 };
  }

  push(chunk) {
    const at = this.now();
    let data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let i = 0;
    while (data.length - i >= TS) {
      if (data[i] !== 0x47 || (data.length - i >= 2 * TS && data[i + TS] !== 0x47)) {
        const next = data.indexOf(0x47, i + 1);
        this.stats.resyncs++;
        if (next < 0) { i = data.length; break; }
        i = next; continue;
      }
      this.packet(data.subarray(i, i + TS), at);
      i += TS;
    }
    this.rest = Buffer.from(data.subarray(i));
  }

  packet(p, at) {
    this.stats.packets++;
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    const start = (p[1] & 0x40) !== 0;
    const afc = (p[3] >> 4) & 3;
    if (!(afc & 1)) return;
    let offset = 4;
    if (afc & 2) offset += 1 + p[4];
    if (offset >= TS) return;
    const payload = p.subarray(offset);
    if (pid === 0 && start) this.readPat(payload);
    else if (pid === this.pmtPid && start) this.readPmt(payload);
    else if (pid === this.videoPid) {
      if (start) { this.finish(false); this.pes = { parts: [], firstAt: at }; }
      if (!this.pes) return;
      this.pes.parts.push(Buffer.from(payload));
      this.pes.lastAt = at;
      if (afc & 2 && stuffed(p)) this.finish(true);
    }
  }

  section(payload) {
    const pointer = payload[0];
    const table = payload.subarray(1 + pointer);
    const length = ((table[1] & 0x0f) << 8) | table[2];
    return table.subarray(0, Math.min(table.length, 3 + length - 4)); // without CRC
  }

  readPat(payload) {
    const table = this.section(payload);
    for (let i = 8; i + 4 <= table.length; i += 4) {
      const program = table.readUInt16BE(i);
      if (program !== 0) { this.pmtPid = ((table[i + 2] & 0x1f) << 8) | table[i + 3]; return; }
    }
  }

  readPmt(payload) {
    const table = this.section(payload);
    const infoLength = ((table[10] & 0x0f) << 8) | table[11];
    for (let i = 12 + infoLength; i + 5 <= table.length;) {
      const type = table[i], pid = ((table[i + 1] & 0x1f) << 8) | table[i + 2];
      const esLength = ((table[i + 3] & 0x0f) << 8) | table[i + 4];
      if (type === 0x1b) { this.videoPid = pid; return; }
      i += 5 + esLength;
    }
  }

  finish(early) {
    const pes = this.pes;
    this.pes = null;
    if (!pes?.parts.length) return;
    const raw = pes.parts.length === 1 ? pes.parts[0] : Buffer.concat(pes.parts);
    if (raw.length < 9 || raw[0] !== 0 || raw[1] !== 0 || raw[2] !== 1) return;
    const flags = raw[7], headerLength = raw[8];
    let pts = null;
    if (flags & 0x80 && headerLength >= 5) {
      const b = raw.subarray(9);
      pts = ((b[0] >> 1) & 0x07) * 2 ** 30 + ((b[1] << 7) | (b[2] >> 1)) * 2 ** 15 + ((b[3] << 7) | (b[4] >> 1));
    }
    const es = raw.subarray(9 + headerLength);
    const units = nalUnits(es);
    if (!units.length) return;
    const spsUnit = units.find(unit => unit.type === 7);
    let sps = null;
    if (spsUnit) { try { sps = parseSps(es.subarray(spsUnit.start, spsUnit.end)); } catch {} }
    const keyframe = units.some(unit => unit.type === 5) || units.find(unit => unit.type !== 9)?.type === 7;
    this.stats.units++;
    if (early) this.stats.early++;
    this.onUnit({ data: stripFiller(es, units), keyframe, sps, pts, firstAt: pes.firstAt, lastAt: pes.lastAt, doneAt: this.now(), early, rawBytes: es.length });
  }

  // End of stream: the last PES has no successor to close it.
  end() { this.finish(false); }
}

// ---------------------------------------------------------------- encoders

const clampInt = (value, low, high, fallback) => Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Math.round(Number(value)))) : fallback;

// The lab's desktop scene: a real desktop screenshot, a terminal scrolling
// source code and a moving cursor, with a one-second-plus VBV so keyframes and
// deltas come out the size gpu-screen-recorder makes them (1080p at 2 Mbps:
// ~110 KB keyframes, a few KB per delta). The test pattern changes every pixel
// every frame and its keyframes are ten times smaller than the real ones.
const LAB_BACKDROP = fileURLToPath(new URL('../docs/assets/desktop-control.png', import.meta.url));
const LAB_TEXT = fileURLToPath(import.meta.url);
function labDesktop(w, h, fps, backdrop = LAB_BACKDROP, text = LAB_TEXT) {
  if (/['\\\n]/.test(text)) throw new Error('lab text path cannot hold quotes or backslashes');
  // The text is drawn once on a tall sheet and a terminal-sized window of it
  // scrolls: drawing it every frame costs enough CPU to make the pacing uneven.
  const tw = Math.round(w * 0.45) & ~1, th = Math.round(h * 0.36) & ~1, sheet = 8000;
  const inputs = ['-loop', '1', '-framerate', String(fps), '-i', backdrop, '-f', 'lavfi', '-i', `color=c=0x0d1117:s=${tw}x${sheet}:r=${fps}`];
  const graph = `[1:v]drawtext=font=monospace:expansion=none:textfile='${text}':fontsize=${Math.max(10, Math.round(h / 72))}:fontcolor=0xc8d0c0:line_spacing=5:x=14:y=${th},`
    + `trim=end_frame=1,loop=loop=-1:size=1,setpts=N/${fps}/TB,crop=${tw}:${th}:0:'mod(t*60\\,${sheet - th})'[term];`
    + `[0:v]scale=${w}:${h},format=yuv420p[bg];`
    + `[bg][term]overlay=x=${Math.round(w * 0.04)}:y=${Math.round(h * 0.58)},`
    + `drawbox=x='${w}*0.55+${w}*0.2*sin(t*0.9)':y='${h}*0.35+${h}*0.15*cos(t*0.7)':w=14:h=22:color=white:t=fill`;
  return { inputs, graph };
}

// The command line for one capture. `lab` needs the monitor size; the real
// capture takes the monitor by name (KMS, no portal, no picker). `scene` picks
// the lab picture: 'pattern' (testsrc2) or 'desktop'. `scale` ({ width,
// height }) is a box the picture shrinks into, keeping its aspect (gsr -s);
// `keyint` is in seconds (gsr takes under 500).
export function captureCommand({ mode = 'gsr', monitor, width = 1920, height = 1080, fps = 60, kbps = 10000, keyint = 1, scale = null, scene = 'pattern', backdrop, text } = {}) {
  fps = clampInt(fps, 1, 120, 60); kbps = clampInt(kbps, 250, 100000, 10000);
  keyint = Math.max(0.1, Math.min(499, Number(keyint) || 1));
  const box = scale && Number.isFinite(scale.width) && Number.isFinite(scale.height) ? { width: clampInt(scale.width, 2, 7680, 1920) & ~1, height: clampInt(scale.height, 2, 4320, 1080) & ~1 } : null;
  if (mode === 'lab') {
    const w = clampInt(width, 704, 7680, 1920) & ~1, h = clampInt(height, 64, 4320, 1080) & ~1;
    const desktop = scene === 'desktop' ? labDesktop(w, h, fps, backdrop, text) : null;
    const inputs = desktop ? desktop.inputs : ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`];
    // Wall-clock ms goes into the frame's timestamp (RTCTIME) right after
    // `realtime` releases it, then the band paints it bit by bit.
    const bit = `mod(floor(round(T*1000)/pow(2,${BAND.bits - 1}-floor(X/${BAND.cell}))),2)`;
    const shrink = box ? `,scale=${box.width}:${box.height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p` : '';
    const graph = `${desktop ? desktop.graph : '[0:v]format=yuv420p'}${shrink},realtime,settb=1/1000,setpts=RTCTIME/1000,split[a][b];`
      + `[b]crop=${BAND.bits * BAND.cell}:${BAND.cell}:0:0,geq=lum='255*${bit}':cb=128:cr=128[band];`
      + `[a][band]overlay=0:0,setpts=N/FRAME_RATE/TB[v]`;
    const bufsize = desktop ? kbps * 2 : Math.max(100, Math.round(kbps / fps * 2));
    return ['ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs,
      '-filter_complex', graph, '-map', '[v]', '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', String(Math.max(1, Math.round(fps * keyint))),
      '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${bufsize}k`,
      '-f', 'mpegts', '-flush_packets', '1', '-muxdelay', '0', 'pipe:1']];
  }
  if (typeof monitor !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(monitor)) throw new Error('invalid monitor name');
  return ['gpu-screen-recorder', ['-w', monitor, '-c', 'mpegts', '-k', 'h264', '-f', String(fps), '-fm', 'cfr', '-bm', 'cbr', '-q', String(kbps),
    '-tune', 'performance', '-keyint', String(keyint), ...(box ? ['-s', `${box.width}x${box.height}`] : []), '-cursor', 'yes', '-v', 'no']];
}

// gpu-screen-recorder opens /dev/stdout by path, and on the socketpair Node
// gives a child for 'pipe' that open() fails with ENXIO. A FIFO is a real pipe:
// both ends are opened here (the read end non-blocking, so it is polled like a
// socket and never parks a threadpool thread) and its name is gone at once.
export function realPipe() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ponte-rd-'));
  try {
    const fifo = path.join(dir, 'video');
    if (spawnSync('mkfifo', ['-m', '600', fifo]).status !== 0) throw new Error('mkfifo failed');
    const readFd = openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const writeFd = openSync(fifo, fsConstants.O_WRONLY);
    return { readFd, writeFd };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// One running encoder at a time. restart() swaps monitor, bitrate or fps; the
// new process always opens with a keyframe. onUnit gets each access unit with
// the parameters of the run that made it.
export function createCapture({ mode = 'gsr', scene, env = process.env, spawn = spawnChild, onUnit, onExit = () => {}, log = console } = {}) {
  let child = null, params = null, generation = 0;
  function start(next) {
    stop();
    params = { ...next };
    // PONTE_RD_LAB_BACKDROP: another picture under the lab's desktop scene (e.g. small native text).
    const [command, args] = captureCommand({ mode, scene, ...(mode === 'lab' && env.PONTE_RD_LAB_BACKDROP ? { backdrop: env.PONTE_RD_LAB_BACKDROP } : {}), ...params });
    const run = ++generation;
    const startedAt = performance.now();
    const { readFd, writeFd } = realPipe();
    let current;
    try { current = spawn(command, args, { stdio: ['ignore', writeFd, 'pipe'], env }); }
    catch (error) { closeSync(readFd); throw error; }
    finally { closeSync(writeFd); }
    child = current;
    const video = new net.Socket({ fd: readFd, readable: true, writable: false });
    current.video = video;
    const demuxer = new TsDemuxer(unit => { if (run === generation) onUnit({ ...unit, params, startedAt }); });
    current.demuxer = demuxer;
    let stderr = '';
    video.on('data', chunk => demuxer.push(chunk));
    video.on('error', () => {});
    current.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    current.once('error', error => { video.destroy(); if (run === generation) { child = null; onExit({ code: null, error, stderr }); } });
    current.once('close', (code, signal) => {
      // A helper the encoder spawned may still hold the write end: do not wait for EOF.
      setTimeout(() => { video.destroy(); demuxer.end(); }, 50);
      if (run !== generation) return;
      child = null;
      if (stderr.trim()) log.error?.(`[rd] ${command} exited (${code ?? signal}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
      onExit({ code, signal, stderr });
    });
    return current;
  }
  function stop() {
    generation++;
    const old = child;
    child = null;
    if (!old) return;
    // gpu-screen-recorder finishes its file on SIGINT; on a pipe nothing is lost
    // by being quick, and a stuck encoder must not hold the next one's GPU slot.
    old.kill('SIGINT');
    const timer = setTimeout(() => old.kill('SIGKILL'), 800);
    timer.unref?.();
    old.once?.('close', () => clearTimeout(timer));
  }
  return {
    start, stop,
    restart: changes => start({ ...params, ...changes }),
    get params() { return params; },
    get running() { return !!child; },
    get child() { return child; },
  };
}

// Reads the lab band out of a decoded grayscale row block (width x 16).
export function readBand(gray, width) {
  let value = 0;
  const y = BAND.cell >> 1;
  for (let i = 0; i < BAND.bits; i++) value = value * 2 + (gray[y * width + i * BAND.cell + (BAND.cell >> 1)] > 128 ? 1 : 0);
  return value;
}

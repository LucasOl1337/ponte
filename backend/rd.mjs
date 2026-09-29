// Remote-desktop sessions over /api/rd (WebSocket): H.264 access units out,
// raw keyboard and pointer in, clipboard both ways. One session holds the
// input of this target at a time; a new one takes over and the previous gets
// {"t":"taken"}. The message shapes are the contract in the mesh design (§5).
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import { createCapture } from './rd-capture.mjs';
import { createRdInput } from './rd-input.mjs';
import { createRateControl, scaleBox } from './rd-rate.mjs';
import { copyToClipboard } from './images.mjs';
import { connect, pipe } from './ws.mjs';
import { commandExists, runCommand } from './process.mjs';

export const RD_VERSION = 1;
export const HEADER_BYTES = 16;
export const MAX_CLIP_BYTES = 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const AUTHED_MAX_MESSAGE = MAX_CLIP_BYTES + 64 * 1024; // a clip may be 1 MiB; before the hello only 64 KiB
const epochNow = () => performance.timeOrigin + performance.now();

// Video message header, big-endian (DataView's default): u8 type = 1,
// u8 flags (bit0 keyframe), u16 reserved, u32 seq, f64 server send time (ms epoch).
export function videoHeader(seq, keyframe, sentAt = epochNow()) {
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = 1; header[1] = keyframe ? 1 : 0;
  header.writeUInt32BE(seq >>> 0, 4);
  header.writeDoubleBE(sentAt, 8);
  return header;
}
export function parseVideoHeader(buffer) {
  return { type: buffer[0], keyframe: (buffer[1] & 1) === 1, seq: buffer.readUInt32BE(4), sentAt: buffer.readDoubleBE(8) };
}

// Bitrate and frame rate on the LAN follow the link. Congestion (non-key
// frames dropped because the socket queue is over its ceiling, or the client
// saying its decoder falls behind) that lasts steps the encoder down; a long
// calm steps it back up. Outside the LAN the session moves to the steps of
// rd-rate.mjs instead.
export function createAdaptation({ fps = 60, kbps = 12000, minKbps = 1500, maxKbps = 20000, wanKbps = 6000, now = () => performance.now() } = {}) {
  const ceiling = { fps, kbps: Math.min(kbps, maxKbps) };
  let current = { ...ceiling };
  let events = [], lastChange = now(), calmSince = now();
  const limit = () => ({ fps: ceiling.fps, kbps: maxKbps });
  return {
    get current() { return { ...current }; },
    congestion() { events.push(now()); calmSince = now(); },
    stats(report = {}) {
      if (Number(report.queue) > 3 || (Number(report.fps) > 0 && Number(report.fps) < current.fps * 0.6)) this.congestion();
    },
    // Called about once a second; returns the new { fps, kbps } or null.
    tick(buffered = 0, lowWater = 32 * 1024) {
      const t = now();
      events = events.filter(at => t - at < 3000);
      const cap = limit();
      let next = null;
      if (current.kbps > cap.kbps || current.fps > cap.fps) next = { fps: Math.min(current.fps, cap.fps), kbps: Math.min(current.kbps, cap.kbps) };
      else if (t - lastChange < 3000) return null;
      else if (events.length >= 3) {
        const kbps = Math.max(minKbps, Math.round(current.kbps * 0.6));
        next = { kbps, fps: kbps <= wanKbps ? Math.min(current.fps, 30) : current.fps };
      } else if (t - calmSince > 10000 && buffered < lowWater && (current.kbps < Math.min(ceiling.kbps, cap.kbps) || current.fps < cap.fps)) {
        const kbps = Math.min(ceiling.kbps, cap.kbps, Math.round(current.kbps * 1.25));
        next = { kbps, fps: kbps > wanKbps ? cap.fps : current.fps };
      }
      if (!next || (next.kbps === current.kbps && next.fps === current.fps)) return null;
      current = next; lastChange = t; calmSince = t; events = [];
      return { ...current };
    },
  };
}

// WebSocket pings before the first frame: the queue is still empty, so this is
// the link's own round trip, the smallest of three so one Wi-Fi hiccup does not
// count. Browsers and the relaying node answer pings by themselves, so every
// client version gets measured. null: no answer within `timeout` in all.
export async function probeRtt(ws, { count = 3, timeout = 1000 } = {}) {
  if (typeof ws.ping !== 'function') return 0;
  const deadline = performance.now() + timeout;
  let best = null;
  for (let i = 0; i < count; i++) {
    const rtt = await new Promise(resolve => {
      const payload = randomBytes(8), started = performance.now();
      const done = value => { clearTimeout(timer); ws.off?.('pong', onPong); resolve(value); };
      const onPong = data => { if (Buffer.from(data).equals(payload)) done(performance.now() - started); };
      const timer = setTimeout(() => done(null), Math.max(0, deadline - performance.now()));
      ws.on('pong', onPong);
      if (!ws.ping(payload)) done(null);
    });
    if (rtt === null) break;
    best = best === null ? rtt : Math.min(best, rtt);
  }
  return best;
}

// Text clipboard of the target: a `wl-paste --watch` notifier only while a
// session lives, and a bounded read on each change.
export function createClipboard({ env = process.env, spawn = spawnChild, runner = runCommand, write = copyToClipboard } = {}) {
  return {
    watch(onText) {
      const child = spawn('wl-paste', ['--type', 'text', '--watch', 'echo', 'changed'], { stdio: ['ignore', 'pipe', 'ignore'], env });
      let reading = Promise.resolve(), stopped = false;
      child.once('error', () => {});
      child.stdout.on('data', () => {
        reading = reading.then(async () => {
          if (stopped) return;
          try {
            const text = await runner('wl-paste', ['--no-newline', '--type', 'text'], { env, timeout: 2000, maxBuffer: MAX_CLIP_BYTES });
            if (!stopped) onText(String(text));
          } catch {} // empty, not text, or over 1 MiB
        });
      });
      return () => { stopped = true; child.kill('SIGTERM'); };
    },
    write: text => write('text/plain;charset=utf-8', Buffer.from(text), env),
  };
}

async function uinputWritable() {
  try { await access('/dev/uinput', constants.W_OK); return true; } catch { return false; }
}
async function evdevInstalled(python, env) {
  try { await runCommand(python, ['-c', 'import evdev'], { env, timeout: 5000 }); return true; } catch { return false; }
}

// Options: PONTE_RD_CAPTURE=lab (ffmpeg test pattern; PONTE_RD_LAB_SCENE=desktop
// for a desktop-like picture), PONTE_RD_INPUT=dry-run
// (+ PONTE_RD_INPUT_LOG), PONTE_RD_ABS=layout|output, PONTE_RD_KBPS, PONTE_RD_FPS.
// Under `node --test` input is always dry-run and capture always lab: a test
// must never create a real uinput device on a developer's desktop.
export function createRemoteDesktop({
  env = process.env, readMonitors, node = {}, spawn = spawnChild, clipboard, log = console,
  captureMode = env.PONTE_RD_CAPTURE === 'lab' ? 'lab' : 'gsr', labScene = env.PONTE_RD_LAB_SCENE === 'desktop' ? 'desktop' : 'pattern',
  inputMode = env.PONTE_RD_INPUT === 'dry-run' ? 'dry-run' : env.PONTE_RD_INPUT === 'off' ? 'off' : 'uinput',
  inputLog = env.PONTE_RD_INPUT_LOG, mapping = env.PONTE_RD_ABS === 'output' ? 'output' : 'layout',
  kbps = Number(env.PONTE_RD_KBPS) || (captureMode === 'lab' ? 4000 : 12000), maxFps = Number(env.PONTE_RD_FPS) || 60,
  python = 'python3', createInput = createRdInput, makeCapture = createCapture, now = () => performance.now(), exists = commandExists, probe = probeRtt,
} = {}) {
  if (env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) {
    if (inputMode === 'uinput') inputMode = 'dry-run';
    captureMode = 'lab';
  }
  const clip = clipboard || createClipboard({ env, spawn });
  const sessions = new Set();
  let holder = null, closed = false;
  let capsCache = null;
  const metrics = [];

  async function capabilities() {
    if (capsCache && now() - capsCache.at < 60000) return capsCache.value;
    const video = captureMode === 'lab' ? await exists('ffmpeg', env) : await exists('gpu-screen-recorder', env);
    const input = inputMode === 'off' ? false
      : inputMode === 'dry-run' ? await exists(python, env)
      : (await evdevInstalled(python, env)) && await uinputWritable();
    const value = { video, input, rd: video && input };
    capsCache = { at: now(), value };
    return value;
  }

  function nodeInfo() {
    const info = typeof node === 'function' ? node() : node;
    return { id: info?.id ?? null, name: info?.name || os.hostname(), os: info?.os || process.platform };
  }

  // The first message must be the hello, with the token (a browser cannot set
  // Authorization on a WebSocket). Anything the client sends while the hello
  // is being checked waits in order. `route(hello, req, principal)` may name
  // another node ({ url, ca, token }): the hello goes there with that node's
  // token and the two connections are spliced, owner sessions only.
  function accept(ws, req, { authorize, route }) {
    if (closed) { ws.close(1001, 'restarting'); return; }
    let state = 'hello', session = null;
    const early = [];
    const timer = setTimeout(() => ws.close(1008, 'hello timeout'), HELLO_TIMEOUT_MS);
    ws.once('close', () => { clearTimeout(timer); if (session) { session.end('closed'); sessions.delete(session); } });
    ws.on('message', (data, binary) => {
      if (state === 'open') { if (!binary) session.message(data); return; }
      if (state === 'hello') { state = 'checking'; hello(data, binary); return; }
      if (early.length < 256 && !binary) early.push(data);
    });
    async function hello(data, binary) {
      clearTimeout(timer);
      let message = null;
      if (!binary) { try { message = JSON.parse(data); } catch {} }
      if (!message || message.t !== 'hello' || message.v !== RD_VERSION) { refuse(ws, 'INVALID_HELLO', 1002); return; }
      let principal = null;
      try { principal = await authorize(message.token, req); } catch {}
      if (!principal) { refuse(ws, 'PAIRING_REQUIRED', 1008); return; }
      let target = null;
      try { target = route ? await route(message, req, principal) : null; }
      catch (error) { refuse(ws, error.code || 'MESH_PEER_NOT_FOUND', 1008); return; }
      if (target) { await relay(target, message, principal); return; }
      const caps = await capabilities();
      if (ws.readyState !== 'open') return;
      if (!caps.video) { refuse(ws, 'RD_UNAVAILABLE', 1011); return; }
      ws.maxMessage = AUTHED_MAX_MESSAGE;
      session = new Session(ws, message, principal, caps);
      sessions.add(session);
      try { await session.start(); }
      catch (error) { log.error?.(`[rd] session failed: ${error.message}`); refuse(ws, error.code || 'RD_UNAVAILABLE', 1011); return; }
      if (ws.readyState !== 'open') { session.end('closed'); sessions.delete(session); return; }
      state = 'open';
      for (const text of early.splice(0)) session.message(text);
    }
    // The far node answers the hello first (its ready, or why not); only then
    // are the two joined, so a dead link can be told apart from a busy one.
    async function relay(target, message, principal) {
      if (principal.kind !== 'owner') { refuse(ws, 'MESH_OWNER_ONLY', 1008); return; } // no A → B → C
      let upstream;
      try { upstream = await connect(target.url, { ca: target.ca, checkServerIdentity: target.checkServerIdentity, timeout: 5000 }); }
      catch (error) { refuse(ws, target.failure?.(error) || 'MESH_PEER_UNREACHABLE', 1011); return; }
      if (ws.readyState !== 'open') { upstream.terminate(); return; }
      ws.once('close', () => { if (state !== 'relayed') upstream.terminate(); });
      upstream.once('close', () => { if (state !== 'relayed') refuse(ws, 'PEER_OFFLINE', 1011); });
      upstream.once('message', (reply, binary) => {
        let answer = null;
        if (!binary) { try { answer = JSON.parse(reply); } catch {} }
        if (answer?.t === 'error' && answer.code === 'PAIRING_REQUIRED') {
          // The far node no longer knows this node's token: the link is dead.
          target.revoked?.();
          upstream.terminate(); refuse(ws, target.revoked ? 'PEER_REVOKED' : 'PAIRING_REQUIRED', 1008); return;
        }
        if (ws.readyState !== 'open' || upstream.readyState !== 'open') { upstream.terminate(); refuse(ws, 'PEER_OFFLINE', 1011); return; }
        ws.send(reply);
        for (const text of early.splice(0)) upstream.send(text);
        state = 'relayed';
        pipe(ws, upstream);
      });
      upstream.send(JSON.stringify({ ...message, token: target.token }));
    }
  }

  function refuse(ws, code, closeCode) {
    if (ws.readyState !== 'open') return;
    ws.send(JSON.stringify({ t: 'error', code }));
    ws.close(closeCode, code);
  }

  class Session {
    constructor(ws, hello, principal, caps) {
      this.ws = ws; this.principal = principal; this.caps = caps;
      this.fps = Math.max(1, Math.min(maxFps, Math.round(Number(hello.maxFps) || maxFps)));
      this.requestedMonitor = typeof hello.monitor === 'string' ? hello.monitor : null;
      this.adapt = createAdaptation({ fps: this.fps, kbps, now });
      // What the page can do beyond the first protocol version, and its stage size.
      const announced = hello.caps && typeof hello.caps === 'object' ? hello.caps : {};
      this.page = { ack: announced.ack === true, key: announced.key === true };
      const view = hello.view && typeof hello.view === 'object' ? hello.view : null;
      this.view = view && Number.isFinite(view.width) && view.width >= 320 && view.width <= 16384 ? { width: Math.round(view.width), height: Math.round(Number(view.height) || 0) } : null;
      this.control = createRateControl({ maxFps: this.fps, caps: this.page, view: this.view, now });
      this.seq = 0; this.waitKey = true; this.announced = null; this.ended = false; this.shedding = false;
      this.failures = 0; this.lastUnitAt = now();
      this.metrics = { startedAt: epochNow(), frames: 0, keyframes: 0, bytes: 0, keyBytes: 0, dropped: 0, restarts: 0, reasons: {}, decisions: [], pesToSend: [], lastToSend: [], early: 0 };
    }

    async start() {
      const [monitors, rtt] = await Promise.all([readMonitors(), probe(this.ws)]);
      this.monitors = monitors;
      this.control.open(rtt);
      this.openRtt = rtt;
      const pick = this.monitors.find(m => m.name === this.requestedMonitor) || this.monitors.find(m => m.focused) || this.monitors[0];
      if (!pick) throw Object.assign(new Error('no monitor'), { code: 'MONITORS_UNAVAILABLE' });
      this.monitor = pick.name;
      if (this.ended) return;
      if (holder && holder !== this) holder.take();
      holder = this;
      if (this.caps.input) {
        this.input = createInput({ python, dryRun: inputMode === 'dry-run', logFile: inputLog, mapping, env, spawn, now, log });
        this.input.setMonitors(this.monitors);
        this.input.start();
      }
      this.capture = makeCapture({ mode: captureMode, scene: labScene, env, spawn, log, onUnit: unit => this.unit(unit), onExit: info => this.captureExit(info) });
      this.capture.start(this.captureParams(pick));
      this.stopClipboard = clip.watch(text => {
        if (this.ended || text === this.lastClip || Buffer.byteLength(text) > MAX_CLIP_BYTES) return;
        this.lastClip = text;
        this.sendJson({ t: 'clip', text });
      });
      this.timer = setInterval(() => this.tick(), 1000);
      this.timer.unref?.();
    }

    captureParams(monitor) {
      const wan = this.control.params();
      const { fps, kbps: rate } = wan || this.adapt.current;
      return { monitor: monitor.name, width: monitor.width, height: monitor.height, fps, kbps: rate, keyint: wan ? wan.keyint : 1, scale: wan ? scaleBox(monitor, wan.maxWidth) : null };
    }

    // One encoder restart for a decision of the rate control.
    apply(decision) {
      if (!decision || this.ended) return;
      if (decision.reason === 'shed') { this.shedding = true; return; }
      this.shedding = false;
      // What the old run still has to send only delays the new keyframe.
      this.waitKey = true;
      this.metrics.restarts++;
      this.metrics.reasons[decision.reason] = (this.metrics.reasons[decision.reason] || 0) + 1;
      this.metrics.decisions.push({ at: epochNow(), reason: decision.reason, step: this.control.step });
      if (this.metrics.decisions.length > 50) this.metrics.decisions.shift();
      const monitor = this.monitors.find(m => m.name === this.monitor) || this.monitors[0];
      this.capture.restart(this.captureParams(monitor));
    }

    unit(unit) {
      if (this.ended) return;
      this.lastUnitAt = now();
      this.failures = 0;
      const params = unit.params;
      if (!this.announced || this.announced.monitor !== params.monitor || (unit.sps && (unit.sps.codec !== this.announced.codec || unit.sps.width !== this.announced.width || unit.sps.height !== this.announced.height))) {
        if (!unit.keyframe || !unit.sps) return; // a decoder can only start at a keyframe with its SPS
        this.announce(unit.sps, params);
      }
      // Shedding: the lowest step still overflows the link; nothing goes out
      // until its queue drains and a new run starts with a keyframe.
      if (this.shedding) { this.waitKey = true; this.metrics.dropped++; return; }
      const buffered = this.ws.bufferedAmount;
      const bytesPerSecond = params.kbps * 125;
      // A keyframe can be larger than the ceiling on its own (1080p at 12 Mbps:
      // ~350 KB against 150 KB), and the deltas right behind it used to be
      // dropped until the next keyframe: a second frozen on a fast LAN. For up
      // to a second, the ceiling leaves room for that keyframe's own bytes, and
      // only the last keyframe's.
      const keyRoom = this.lastKey && now() - this.lastKey.at <= 1000 ? this.lastKey.bytes : 0;
      if (unit.keyframe) {
        if (buffered > bytesPerSecond) { this.drop(true); return; } // a whole second queued: even a keyframe would be late
        this.waitKey = false;
      } else if (this.waitKey || buffered > Math.max(128 * 1024, bytesPerSecond / 10) + keyRoom) {
        // One missing delta breaks every frame up to the next keyframe.
        const over = !this.waitKey;
        this.waitKey = true; this.drop(over); return;
      }
      const sentAt = epochNow();
      const seq = ++this.seq;
      this.ws.send(videoHeader(seq, unit.keyframe, sentAt), unit.data);
      if (unit.keyframe) this.lastKey = { at: now(), bytes: unit.data.length + HEADER_BYTES };
      const decision = this.control.sent(unit.data.length + HEADER_BYTES, unit.keyframe, seq);
      const m = this.metrics;
      m.frames++; m.bytes += unit.data.length;
      if (unit.keyframe) { m.keyframes++; m.keyBytes += unit.data.length; }
      if (unit.early) m.early++;
      const sentPerf = now();
      if (m.pesToSend.length < 20000) { m.pesToSend.push(sentPerf - unit.firstAt); m.lastToSend.push(sentPerf - unit.lastAt); }
      this.apply(decision);
    }

    // Outside the LAN the next natural keyframe can be minutes away: a delta
    // dropped for congestion asks the rate control for a new run at once.
    drop(congestion) {
      this.metrics.dropped++;
      this.adapt.congestion();
      if (congestion) this.apply(this.control.drop());
    }

    announce(sps, params) {
      const monitors = this.monitors.map(m => ({ name: m.name, x: m.x, y: m.y, width: m.width, height: m.height, scale: m.scale, focused: !!m.focused }));
      const input = !!this.input;
      this.announced = { monitor: params.monitor, codec: sps.codec, width: sps.width, height: sps.height };
      this.sendJson({
        t: 'ready', v: RD_VERSION, node: nodeInfo(), monitors, monitor: params.monitor,
        width: sps.width, height: sps.height, fps: params.fps, codec: sps.codec,
        input: { abs: input, rel: input, keys: input, clipboard: true },
      });
    }

    captureExit(info) {
      if (this.ended) return;
      this.failures++;
      if (this.failures > 3) { log.error?.('[rd] capture keeps failing'); refuse(this.ws, 'CAPTURE_FAILED', 1011); return; }
      setTimeout(() => { if (!this.ended) { this.metrics.restarts++; this.capture.restart({}); } }, 300 * this.failures).unref?.();
    }

    tick() {
      if (this.ended) return;
      if (this.capture.running && now() - this.lastUnitAt > 5000) { this.lastUnitAt = now(); this.metrics.restarts++; this.capture.restart({}); return; }
      if (this.control.mode === 'lan') {
        const next = this.adapt.tick(this.ws.bufferedAmount);
        if (next) { this.metrics.restarts++; this.capture.restart(next); }
      }
      this.apply(this.control.tick());
    }

    sendJson(value) { if (this.ws.readyState === 'open') this.ws.send(JSON.stringify(value)); }

    async message(text) {
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m !== 'object' || this.ended) return;
      const input = holder === this ? this.input : null;
      input?.alive();
      const num = value => typeof value === 'number' && Number.isFinite(value);
      switch (m.t) {
        case 'key': if (typeof m.code === 'string' && m.code.length <= 32) input?.key(m.code, m.down === true); break;
        case 'move': if (num(m.x) && num(m.y)) input?.move(this.monitor, m.x, m.y); break;
        case 'rel': if (num(m.dx) && num(m.dy)) input?.rel(m.dx, m.dy); break;
        case 'btn': if (Number.isInteger(m.b) && m.b >= 0 && m.b <= 4) input?.button(m.b, m.down === true); break;
        case 'wheel': if (num(m.dx ?? 0) && num(m.dy ?? 0)) input?.wheel(m.dx ?? 0, m.dy ?? 0); break;
        case 'release': input?.release(); break;
        case 'ping': this.sendJson({ t: 'pong', c: m.c, s: epochNow() }); break;
        case 'stats': this.adapt.stats(m); this.clientStats = m; this.apply(this.control.stats(m)); break;
        // Pages that announced caps.ack / caps.key: the last frame that arrived,
        // and a decoder that lost its reference and needs a keyframe.
        case 'ack': this.apply(this.control.ack(m.seq)); break;
        case 'keyframe': this.apply(this.control.key()); break;
        case 'clip':
          if (typeof m.text !== 'string' || Buffer.byteLength(m.text) > MAX_CLIP_BYTES || m.text === this.lastClip) break;
          this.lastClip = m.text;
          try { await clip.write(m.text); } catch { this.sendJson({ t: 'error', code: 'CLIPBOARD_UNAVAILABLE' }); }
          break;
        case 'monitor': {
          if (typeof m.name !== 'string') break;
          try { this.monitors = await readMonitors(); } catch {}
          const target = this.monitors.find(item => item.name === m.name);
          if (!target) { this.sendJson({ t: 'error', code: 'INVALID_MONITOR' }); break; }
          this.input?.release();
          this.input?.setMonitors(this.monitors);
          this.monitor = target.name;
          this.waitKey = true;
          this.metrics.restarts++;
          this.capture.restart(this.captureParams(target));
          break;
        }
        default: break;
      }
    }

    take() {
      this.sendJson({ t: 'taken' });
      this.end('taken');
      this.ws.close(4001, 'taken');
    }

    end(reason) {
      if (this.ended) return;
      this.ended = true;
      clearInterval(this.timer);
      this.capture?.stop();
      this.input?.stop();
      this.stopClipboard?.();
      if (holder === this) holder = null;
      const summary = summarize(this.metrics);
      metrics.push(summary);
      if (metrics.length > 20) metrics.shift();
      const reasons = Object.entries(this.metrics.reasons).map(([key, count]) => `${key} ${count}`).join(', ');
      const link = this.control.mode === 'lan' ? 'LAN' : `WAN step ${this.control.step}`;
      log.info?.(`[rd] session ${reason}: ${summary.frames} frames, ${summary.fps} fps, ${summary.kbps} kbps, pes→send p50 ${summary.pesToSendP50} ms, ${link}, open rtt ${this.openRtt === null ? '–' : Math.round(this.openRtt)} ms, restarts ${summary.restarts}${reasons ? ` (${reasons})` : ''}`);
    }
  }

  return {
    accept, capabilities,
    get sessions() { return [...sessions]; },
    get holder() { return holder; },
    metrics,
    async close() {
      closed = true;
      for (const session of sessions) { session.end('shutdown'); session.ws.close(1001, 'restarting'); }
    },
  };
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 100) / 100;
};
export function summarize(m) {
  const seconds = Math.max(0.001, (epochNow() - m.startedAt) / 1000);
  const deltas = m.frames - m.keyframes;
  return {
    seconds: Math.round(seconds * 10) / 10, frames: m.frames, keyframes: m.keyframes, dropped: m.dropped, restarts: m.restarts,
    fps: Math.round(m.frames / seconds * 10) / 10, kbps: Math.round(m.bytes * 8 / seconds / 1000),
    avgKeyBytes: m.keyframes ? Math.round(m.keyBytes / m.keyframes) : null, avgDeltaBytes: deltas ? Math.round((m.bytes - m.keyBytes) / deltas) : null,
    pesToSendP50: percentile(m.pesToSend, 0.5), pesToSendP95: percentile(m.pesToSend, 0.95),
    lastPacketToSendP50: percentile(m.lastToSend, 0.5), lastPacketToSendP95: percentile(m.lastToSend, 0.95),
    earlyShare: m.frames ? Math.round(m.early / m.frames * 1000) / 1000 : null,
  };
}

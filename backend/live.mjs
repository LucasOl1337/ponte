import { ApiError } from './process.mjs';

export const LIVE_BOUNDARY = 'ponte-frame';
export const MAX_LIVE_FRAME_BYTES = 8 * 1024 * 1024;

function parseRegionPart(query, key) {
  if (!query.has(key)) return undefined;
  const raw = query.get(key);
  if (raw === '' || !/^-?\d+$/.test(raw)) throw new ApiError(400, 'INVALID_REGION');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 32767) throw new ApiError(400, 'INVALID_REGION');
  return value;
}

export function parseLiveOptions(query) {
  const fields = ['monitor', 'fps', 'scale', 'q', 'x', 'y', 'w', 'h'];
  for (const key of fields) if (query.getAll(key).length > 1) throw new ApiError(400, 'REPEATED_PARAMETER');
  const fps = query.has('fps') ? Number(query.get('fps')) : 10;
  const scale = query.has('scale') ? Number(query.get('scale')) : 0.5;
  const quality = query.has('q') ? Number(query.get('q')) : 65;
  if (!Number.isInteger(fps) || fps < 1 || fps > 20) throw new ApiError(400, 'INVALID_FRAME_RATE');
  // grim scales on the CPU (~60 ms at 0.5), while a full-size JPEG takes ~10 ms:
  // scale 1 with a lower quality is the fast profile, not the expensive one.
  if (!Number.isFinite(scale) || scale < 0.2 || scale > 1) throw new ApiError(400, 'INVALID_SCALE');
  if (!Number.isInteger(quality) || quality < 30 || quality > 90) throw new ApiError(400, 'INVALID_QUALITY');
  const monitor = query.get('monitor') ?? undefined;
  if (monitor !== undefined && (monitor.length < 1 || monitor.length > 150 || /[\u0000-\u001f\u007f]/.test(monitor))) throw new ApiError(400, 'INVALID_MONITOR');
  const x = parseRegionPart(query, 'x');
  const y = parseRegionPart(query, 'y');
  const w = parseRegionPart(query, 'w');
  const h = parseRegionPart(query, 'h');
  const given = [x, y, w, h].map(value => value !== undefined);
  if (given.some(Boolean) !== given.every(Boolean)) throw new ApiError(400, 'INVALID_REGION');
  let region;
  if (x !== undefined) {
    if (x < 0 || y < 0 || w < 1 || h < 1) throw new ApiError(400, 'INVALID_REGION');
    region = { x, y, w, h };
  }
  return { monitor, fps, scale, quality, region };
}

function aborted() { return new ApiError(499, 'STREAM_ENDED'); }

function wait(ms, signal) {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

// At most three streams can wait here, and never more than one capture per
// stream. The global cap bounds capture CPU/memory even in a three-monitor view.
function createCaptureSlots(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const task = queue.shift();
      task.signal.removeEventListener('abort', task.cancel);
      if (task.signal.aborted) { task.reject(aborted()); continue; }
      active++;
      Promise.resolve().then(() => task.capture(task.signal)).then(task.resolve, task.reject).finally(() => { active--; pump(); });
    }
  };
  return (capture, signal) => {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const task = { capture, signal, resolve, reject };
      task.cancel = () => { const index = queue.indexOf(task); if (index >= 0) queue.splice(index, 1); reject(aborted()); };
      signal.addEventListener('abort', task.cancel, { once: true });
      queue.push(task); pump();
    });
  };
}

function validateFrame(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_LIVE_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ApiError(503, 'INVALID_JPEG_FRAME');
}

export async function writeLiveFrame(res, bytes, signal, { timeout = 5000, now = Date.now } = {}) {
  if (signal.aborted || res.destroyed) throw aborted();
  validateFrame(bytes);
  const header = Buffer.from(`--${LIVE_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\nX-Frame-Timestamp: ${now()}\r\n\r\n`);
  const packet = Buffer.concat([header, bytes, Buffer.from('\r\n')]);
  if (res.write(packet)) return;
  // Never accumulate frames behind a slow receiver. Only resume after its
  // current frame drains, so the stream self-throttles to the phone's real
  // bandwidth; only a receiver that stalls past the timeout is disconnected.
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); res.off('drain', drained); res.off('close', closed); res.off('error', closed); signal.removeEventListener('abort', closed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(aborted()); };
    const timer = setTimeout(() => { cleanup(); reject(new ApiError(408, 'STREAM_TOO_SLOW')); }, timeout);
    res.once('drain', drained); res.once('close', closed); res.once('error', closed);
    signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || res.destroyed) closed();
  });
}

function peerCount(sessions, peer) { let n = 0; for (const s of sessions) if (s.peer === peer) n++; return n; }

export function createLiveStreaming(desktop, { maxStreams = 4, maxPerPeer = 2, maxCaptures = 2, slowClientTimeout = 15000 } = {}) {
  const sessions = new Set();
  const capture = createCaptureSlots(maxCaptures);
  let closing = false;

  async function stream(req, res, query) {
    const options = parseLiveOptions(query);
    if (closing) throw new ApiError(503, 'SERVER_RESTARTING');
    // Slots are scarce (each stream runs its own capture loop). A device that
    // reconnects replaces its own earlier stream, so a half-open zombie never
    // locks it out; and a preview open on the PC itself (loopback) yields to a
    // remote phone. Never evict another remote device: two phones taking turns
    // killing each other just look like "reconnecting" forever on both.
    const peer = req.socket?.remoteAddress;
    const isLoopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const oldestOfPeer = () => { for (const candidate of sessions) if (candidate.peer === peer) return candidate; return null; };
    // No single peer may hold more than maxPerPeer slots: a device reopening
    // its screen (or leaking tabs) replaces its own oldest instead of starving a
    // second device out of the remaining slots.
    while (peerCount(sessions, peer) >= maxPerPeer) { const own = oldestOfPeer(); if (!own) break; sessions.delete(own); own.abort(); }
    while (sessions.size >= maxStreams) {
      let victim = oldestOfPeer();
      if (!victim) for (const candidate of sessions) if (isLoopback(candidate.peer)) { victim = candidate; break; }
      if (!victim) throw new ApiError(429, 'STREAM_LIMIT_REACHED');
      sessions.delete(victim);
      victim.abort();
    }
    const controller = new AbortController();
    controller.peer = peer;
    const { signal } = controller;
    sessions.add(controller);
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      const source = await desktop.prepareLive({ ...options, signal });
      if (signal.aborted) throw aborted();
      let started = performance.now();
      let frame = await capture(source.capture, signal);
      if (signal.aborted) throw aborted();
      validateFrame(frame);
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${LIVE_BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Accel-Buffering': 'no', 'X-Live-Max-Fps': String(options.fps),
      });
      res.flushHeaders();
      while (!signal.aborted) {
        await writeLiveFrame(res, frame, signal, { timeout: slowClientTimeout });
        frame = null;
        await wait(Math.max(0, 1000 / options.fps - (performance.now() - started)), signal);
        started = performance.now();
        frame = await capture(source.capture, signal);
      }
    } catch (error) {
      if (!res.headersSent && !signal.aborted) throw error;
      if (!res.destroyed) res.destroy();
    } finally {
      controller.abort();
      res.off('close', disconnect);
      sessions.delete(controller);
    }
  }

  function close() { closing = true; for (const controller of sessions) controller.abort(); }
  return { stream, close };
}

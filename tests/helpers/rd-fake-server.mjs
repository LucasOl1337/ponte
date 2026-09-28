// A stand-in for the node's /api/rd (DESENHO.md §5) so the remote desktop
// client can be exercised without the real server: serves public/, answers the
// hello with a ready and streams access units cut from an Annex B .h264 file
// made by ffmpeg, with the 16-byte header. Every text message the client sends
// is kept in `received` (and printed as JSON lines when run from the shell).
//
//   node tests/helpers/rd-fake-server.mjs --h264 clip.h264 [--port 8798] [--token T] [--fps 30]
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Annex B → access units. A new unit starts at an access unit delimiter (9), or
// at SPS/PPS/SEI or a slice with first_mb_in_slice = 0 after a slice.
export function accessUnits(bytes) {
  const nals = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
      const start = i; i += bytes[i + 2] === 1 ? 3 : 4;
      nals.push({ start, header: i });
    }
  }
  const units = [];
  let current = null, sawSlice = false;
  nals.forEach((nal, index) => {
    const end = index + 1 < nals.length ? nals[index + 1].start : bytes.length;
    const type = bytes[nal.header] & 0x1f;
    const firstSlice = (type === 1 || type === 5) && (bytes[nal.header + 1] & 0x80);
    if (!current || type === 9 || (sawSlice && (type === 7 || type === 8 || type === 6 || firstSlice))) {
      current = { parts: [], key: false }; units.push(current); sawSlice = false;
    }
    current.parts.push(bytes.subarray(nal.start, end));
    if (type === 5) current.key = true;
    if (type === 1 || type === 5) sawSlice = true;
  });
  return units.map(unit => ({ key: unit.key, data: Buffer.concat(unit.parts) }));
}

// Codec string from the first SPS: avc1.PPCCLL.
export function codecString(bytes) {
  for (let i = 0; i + 7 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 7) {
      return `avc1.${[bytes[i + 4], bytes[i + 5], bytes[i + 6]].map(value => value.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return 'avc1.42e01e';
}

export function videoMessage(unit, seq, sendTime, littleEndian = false) {
  const header = Buffer.alloc(16);
  header.writeUInt8(1, 0); header.writeUInt8(unit.key ? 1 : 0, 1);
  if (littleEndian) { header.writeUInt32LE(seq >>> 0, 4); header.writeDoubleLE(sendTime, 8); }
  else { header.writeUInt32BE(seq >>> 0, 4); header.writeDoubleBE(sendTime, 8); }
  return Buffer.concat([header, unit.data]);
}

function frame(opcode, payload) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

// Client frames: masked, possibly fragmented. Returns complete messages.
function reader(onMessage) {
  let buffer = Buffer.alloc(0), fragments = [], fragmentOpcode = 0;
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = buffer[0] & 0x80, opcode = buffer[0] & 0x0f, masked = buffer[1] & 0x80;
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskAt = offset; if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i & 3)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0) { fragments.push(payload); if (fin) { onMessage(fragmentOpcode, Buffer.concat(fragments)); fragments = []; } }
      else if (opcode >= 8 || fin) onMessage(opcode, payload);
      else { fragmentOpcode = opcode; fragments = [payload]; }
    }
  };
}

export async function startFakeRd({ h264, token = 'synthetic-rd-token', fps = 30, port = 0, host = '127.0.0.1', littleEndian = false, monitors, mesh = null, log = null } = {}) {
  const bytes = h264 ? await readFile(h264) : Buffer.alloc(0);
  const units = accessUnits(bytes);
  const codec = codecString(bytes);
  const displays = monitors || [
    { name: 'LAB-1', x: 0, y: 0, width: 320, height: 180, scale: 1, focused: true },
    { name: 'LAB-2', x: 320, y: 0, width: 320, height: 180, scale: 1, focused: false },
  ];
  const received = [];
  const sessions = new Set();
  let active = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    if (url.pathname === '/api/mesh') {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (!mesh) { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(mesh)); return;
    }
    const name = url.pathname === '/' ? 'rd.html' : url.pathname.slice(1);
    if (!/^[\w.-]+$/.test(name) || !types[path.extname(name)]) { res.writeHead(404).end(); return; }
    try { const body = await readFile(path.join(publicDir, name)); res.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store' }).end(body); }
    catch { res.writeHead(404).end(); }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://fake');
    if (url.pathname !== '/api/rd' || !req.headers['sec-websocket-key']) { socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const session = { socket, query: Object.fromEntries(url.searchParams), monitor: null, timer: null, seq: 0, index: 0, closed: false };
    sessions.add(session);
    const sendText = value => { if (!session.closed) socket.write(frame(1, Buffer.from(JSON.stringify(value)))); };
    const close = (code = 1000) => {
      if (session.closed) return;
      clearInterval(session.timer);
      const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
      socket.write(frame(8, payload)); session.closed = true; socket.end(); sessions.delete(session);
      if (active === session) active = null;
    };
    session.sendText = sendText; session.close = close;
    const stream = () => {
      clearInterval(session.timer);
      // Start on a keyframe.
      session.index = Math.max(0, units.findIndex(unit => unit.key));
      session.timer = setInterval(() => {
        if (!units.length || session.closed) return;
        const unit = units[session.index];
        session.index = (session.index + 1) % units.length;
        socket.write(frame(2, videoMessage(unit, session.seq++, Date.now(), littleEndian)));
      }, 1000 / fps);
    };
    const ready = () => sendText({ t: 'ready', v: 1, node: { id: '0123456789abcdef', name: 'notebook-teste', os: 'linux' }, monitors: displays.map(monitor => ({ ...monitor, focused: monitor.name === session.monitor })), monitor: session.monitor, width: displays.find(monitor => monitor.name === session.monitor).width, height: displays.find(monitor => monitor.name === session.monitor).height, fps, codec, input: { abs: true, rel: true, keys: true, clipboard: true } });
    socket.on('data', reader((opcode, payload) => {
      if (opcode === 8) { close(); return; }
      if (opcode === 9) { socket.write(frame(10, payload)); return; }
      if (opcode !== 1) return;
      let message; try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
      received.push(message); log?.(message);
      if (message.t === 'hello') {
        if (message.token !== token) { sendText({ t: 'error', code: 'PAIRING_REQUIRED' }); close(4401); return; }
        if (active && active !== session) { active.sendText({ t: 'taken' }); active.close(4409); }
        active = session;
        session.monitor = displays.some(monitor => monitor.name === message.monitor) ? message.monitor : displays[0].name;
        ready(); stream();
      } else if (message.t === 'ping') sendText({ t: 'pong', c: message.c, s: Date.now() });
      else if (message.t === 'monitor' && displays.some(monitor => monitor.name === message.name)) { session.monitor = message.name; ready(); stream(); }
      else if (message.t === 'clip' && message.echo !== false) { /* a real target would set its clipboard */ }
    }));
    socket.on('close', () => { session.closed = true; clearInterval(session.timer); sessions.delete(session); if (active === session) active = null; });
    socket.on('error', () => {});
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const address = server.address();
  return {
    port: address.port, url: `http://${host}:${address.port}`, received, units, codec, sessions,
    sendAll: value => { for (const session of sessions) session.sendText(value); },
    close: () => new Promise(resolve => { for (const session of sessions) { session.close(1001); session.socket.destroy(); } server.close(resolve); server.closeAllConnections(); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
  const fake = await startFakeRd({ h264: option('h264'), port: Number(option('port', 8798)), token: option('token', 'synthetic-rd-token'), fps: Number(option('fps', 30)), log: message => { if (message.t !== 'ping' && message.t !== 'stats') console.log(JSON.stringify(message)); } });
  console.log(`fake rd: ${fake.url}/rd.html#pair=${option('token', 'synthetic-rd-token')} (${fake.units.length} units, ${fake.codec})`);
}

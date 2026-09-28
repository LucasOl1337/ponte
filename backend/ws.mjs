// WebSocket (RFC 6455) without dependencies: the server side for /api/rd and a
// client that a node uses to reach another node. No extensions (no
// permessage-deflate: H.264 does not compress and text messages are tiny).
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 64 * 1024;
const CLIENT_MAX_MESSAGE = 16 * 1024 * 1024;
const CLOSE_WAIT_MS = 2000;

export const acceptKey = key => createHash('sha1').update(key + GUID).digest('base64');

function frameHeader(opcode, length, { fin = true, mask = null } = {}) {
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (mask ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(length, 2);
  else if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (mask) mask.copy(header, 2 + extra);
  return header;
}

function applyMask(data, mask) {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ mask[i & 3];
  return out;
}

const validCloseCode = code => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
const utf8 = new TextDecoder('utf-8', { fatal: true });

// One open connection, either side. Events: 'message' (string | Buffer,
// isBinary), 'ping', 'pong', 'close' (code, reason), 'error'.
export class WebSocketConnection extends EventEmitter {
  constructor(socket, { client = false, maxMessage = client ? CLIENT_MAX_MESSAGE : MAX_MESSAGE, head } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.maxMessage = maxMessage;
    this.readyState = 'open';
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // { opcode, parts, size } while a fragmented message arrives
    this.closeSent = false;
    this.closeInfo = null;
    this.onData = chunk => this.receive(chunk);
    socket.setNoDelay?.(true);
    socket.setTimeout?.(0);
    socket.on('data', this.onData);
    // A reset link is reported by 'close'; 'error' is only for a listener that wants it.
    socket.on('error', error => { if (this.listenerCount('error')) this.emit('error', error); });
    socket.once('close', () => this.finish());
    if (head?.length) queueMicrotask(() => this.receive(head));
  }

  // Bytes queued in the socket and not yet handed to the kernel: the sender's
  // measure of a slow link (the video path drops non-key frames above a ceiling).
  get bufferedAmount() { return this.socket.writableLength; }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.readyState !== 'closed' && this.socket.listenerCount('data') && this.parseFrame());
  }

  parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f, offset = 2;
    if (rsv) return this.fail(1002, 'reserved bits');
    if (masked === this.client) return this.fail(1002, this.client ? 'masked server frame' : 'unmasked client frame');
    const control = opcode >= 8;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return this.fail(1002, 'unknown opcode');
    if (control && (!fin || length > 125)) return this.fail(1002, 'bad control frame');
    if (length === 126) {
      if (b.length < 4) return false;
      length = b.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.fail(1009, 'message too big');
      length = Number(big); offset = 10;
    }
    if (!control) {
      const already = this.fragments?.size || 0;
      if (already + length > this.maxMessage) return this.fail(1009, 'message too big');
    }
    const maskKey = masked ? b.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (b.length < offset + length) return false;
    let payload = b.subarray(offset, offset + length);
    if (maskKey) payload = applyMask(payload, maskKey);
    this.buffer = b.subarray(offset + length);
    if (control) { this.control(opcode, payload); return true; }
    if (opcode === 0 && !this.fragments) return this.fail(1002, 'continuation without start');
    if (opcode !== 0 && this.fragments) return this.fail(1002, 'new message inside a fragmented one');
    if (opcode !== 0) this.fragments = { opcode, parts: [], size: 0 };
    this.fragments.parts.push(Buffer.from(payload));
    this.fragments.size += payload.length;
    if (!fin) return true;
    const { opcode: kind, parts, size } = this.fragments;
    this.fragments = null;
    const data = parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
    if (kind === 1) {
      let text;
      try { text = utf8.decode(data); } catch { return this.fail(1007, 'invalid UTF-8'); }
      this.emit('message', text, false);
    } else this.emit('message', data, true);
    return true;
  }

  control(opcode, payload) {
    if (opcode === 9) { this.writeFrame(10, payload); this.emit('ping', payload); return; }
    if (opcode === 10) { this.emit('pong', payload); return; }
    // Close: answer with the same code, then the server hangs up.
    let code = 1005, reason = '';
    if (payload.length === 1) return this.fail(1002, 'bad close payload');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      try { reason = utf8.decode(payload.subarray(2)); } catch { return this.fail(1007, 'invalid UTF-8'); }
      if (!validCloseCode(code)) return this.fail(1002, 'bad close code');
    }
    this.closeInfo = { code, reason };
    if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : code, '');
    this.readyState = 'closing';
    if (!this.client) this.socket.end();
    else this.closeTimer ??= setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS).unref();
  }

  fail(code, reason) {
    if (this.readyState === 'open') {
      this.closeInfo = { code, reason };
      this.sendClose(code, reason);
      this.readyState = 'closing';
    }
    this.buffer = Buffer.alloc(0);
    this.socket.end();
    this.closeTimer ??= setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS).unref();
    return false;
  }

  finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    clearTimeout(this.closeTimer);
    const { code, reason } = this.closeInfo || { code: 1006, reason: '' };
    this.emit('close', code, reason);
  }

  // Writes one frame; `parts` lets a caller send header + payload without
  // copying them together (the client side has to copy to mask anyway).
  writeFrame(opcode, ...parts) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    if (this.client) {
      const mask = randomBytes(4);
      const body = applyMask(parts.length === 1 ? parts[0] : Buffer.concat(parts, length), mask);
      this.socket.write(frameHeader(opcode, length, { mask }));
      return this.socket.write(body);
    }
    this.socket.cork();
    let ok = this.socket.write(frameHeader(opcode, length));
    for (const part of parts) ok = this.socket.write(part);
    process.nextTick(() => this.socket.uncork());
    return ok;
  }

  // A string goes as text, bytes as binary. Several buffers make one binary
  // message. Returns false once the socket buffers (see bufferedAmount).
  send(data, ...more) {
    if (this.readyState !== 'open') return false;
    if (typeof data === 'string') return this.writeFrame(1, Buffer.from(data));
    return this.writeFrame(2, data, ...more);
  }

  ping(data = Buffer.alloc(0)) { return this.readyState === 'open' && this.writeFrame(9, Buffer.from(data)); }

  sendClose(code, reason) {
    this.closeSent = true;
    const text = Buffer.from(String(reason || '')).subarray(0, 123);
    const payload = Buffer.alloc(2 + text.length);
    payload.writeUInt16BE(code, 0); text.copy(payload, 2);
    this.writeFrame(8, payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 'open') return;
    this.closeInfo ??= { code, reason };
    this.sendClose(code, reason);
    this.readyState = 'closing';
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS).unref();
    if (!this.client) this.socket.end();
  }

  terminate() { this.socket.destroy(); }

  // Hands the socket over (see pipe): stops parsing and returns the bytes that
  // arrived after the last whole frame.
  detach() {
    this.socket.off('data', this.onData);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

function writeHttpError(socket, status, text) {
  if (socket.destroyed) return;
  const body = `${text}\n`;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  setTimeout(() => socket.destroy(), 1000).unref();
}
export const rejectUpgrade = (socket, status = 400, text = 'Bad Request') => writeHttpError(socket, status, text);

// Completes the handshake from an http(s) server's 'upgrade' event, or answers
// 400 and returns null. The caller has already checked Host, Origin and path.
export function acceptUpgrade(req, socket, head, options = {}) {
  const header = name => String(req.headers[name] || '');
  const key = header('sec-websocket-key');
  if (req.method !== 'GET' || header('upgrade').toLowerCase() !== 'websocket'
    || !header('connection').toLowerCase().split(',').some(item => item.trim() === 'upgrade')
    || header('sec-websocket-version') !== '13'
    || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  return new WebSocketConnection(socket, { ...options, client: false, head });
}

// A client connection to ws:// or wss://. For a node with its own CA, pass
// `ca` (and `checkServerIdentity` when the certificate names an IP).
export function connect(url, { ca, checkServerIdentity, headers = {}, maxMessage, timeout = 10000, rejectUnauthorized = true } = {}) {
  const target = new URL(url);
  if (!['ws:', 'wss:'].includes(target.protocol)) return Promise.reject(new Error('ws:// or wss:// only'));
  const secure = target.protocol === 'wss:';
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || (secure ? 443 : 80);
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, ca, checkServerIdentity, rejectUnauthorized, ALPNProtocols: ['http/1.1'], ...(net.isIP(host) ? {} : { servername: host }) })
      : net.connect({ host, port });
    const key = randomBytes(16).toString('base64');
    let response = Buffer.alloc(0), settled = false;
    const timer = setTimeout(() => fail(new Error('WebSocket handshake timed out')), timeout);
    const cleanup = () => { clearTimeout(timer); socket.off('data', data); socket.off('error', fail); socket.off('close', closed); };
    function fail(error) { if (settled) return; settled = true; cleanup(); socket.destroy(); reject(error); }
    function closed() { fail(new Error('connection closed during the WebSocket handshake')); }
    function data(chunk) {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0) { if (response.length > 16384) fail(new Error('handshake response too large')); return; }
      const lines = response.subarray(0, end).toString('latin1').split('\r\n');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0])?.[1];
      const fields = new Map(lines.slice(1).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]; }));
      if (status !== '101') return fail(Object.assign(new Error(`WebSocket handshake refused: ${status || 'no status'}`), { status: Number(status) || 0 }));
      if (fields.get('sec-websocket-accept') !== acceptKey(key)) return fail(new Error('bad Sec-WebSocket-Accept'));
      settled = true; cleanup();
      resolve(new WebSocketConnection(socket, { client: true, maxMessage, head: response.subarray(end + 4) }));
    }
    socket.on('data', data);
    socket.once('error', fail);
    socket.once('close', closed);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      socket.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
  });
}

// Joins a server-side connection (from a browser) to a client-side one (to
// another node) byte for byte: the browser's frames are already masked and the
// far node's are not, which is exactly what each receiving end expects, so
// nothing is decoded or re-framed. Call it between whole messages (after the
// hello was rewritten, for instance); a half-received fragmented message is
// not carried over.
export function pipe(a, b) {
  if (a.client === b.client) throw new Error('pipe joins one server-side and one client-side connection');
  for (const side of [a, b]) if (side.readyState !== 'open') throw new Error('both connections must be open');
  const restA = a.detach(), restB = b.detach();
  if (restA.length) b.socket.write(restA);
  if (restB.length) a.socket.write(restB);
  a.socket.pipe(b.socket);
  b.socket.pipe(a.socket);
  const hangUp = () => { a.socket.destroy(); b.socket.destroy(); };
  a.socket.once('close', hangUp);
  b.socket.once('close', hangUp);
  return { close: hangUp };
}

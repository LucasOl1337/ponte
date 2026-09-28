import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { acceptUpgrade, acceptKey, connect, pipe, MAX_MESSAGE } from '../backend/ws.mjs';

// A server whose connections are handed to `onConnection`.
async function wsServer(t, onConnection) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => { const ws = acceptUpgrade(req, socket, head); if (ws) onConnection(ws, req); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/ws`, port: server.address().port };
}
const echo = ws => ws.on('message', (data, binary) => ws.send(binary ? data : `echo:${data}`));

// A raw client for frames a well-behaved library would never send.
async function rawClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const key = randomBytes(16).toString('base64');
  socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let data = Buffer.alloc(0);
  socket.on('data', chunk => { data = Buffer.concat([data, chunk]); });
  const until = async (predicate, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (predicate(data)) return data; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('timed out');
  };
  const head = await until(d => d.includes('\r\n\r\n'));
  assert.match(head.toString('latin1'), /^HTTP\/1\.1 101/);
  assert.ok(head.toString('latin1').includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`));
  const skip = head.indexOf('\r\n\r\n') + 4;
  const frames = () => parseFrames(data.subarray(skip));
  return { socket, until: (predicate, ms) => until(() => predicate(frames()), ms), frames };
}
function frame(opcode, payload, { fin = true, mask = true } = {}) {
  payload = Buffer.from(payload);
  const key = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | len])
    : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  if (!mask) return Buffer.concat([head, payload]);
  return Buffer.concat([head, key, Buffer.from(payload.map((byte, i) => byte ^ key[i & 3]))]);
}
function parseFrames(buffer) {
  const frames = [];
  let i = 0;
  while (i + 2 <= buffer.length) {
    let len = buffer[i + 1] & 0x7f, offset = i + 2;
    if (len === 126) { len = buffer.readUInt16BE(i + 2); offset += 2; }
    else if (len === 127) { len = Number(buffer.readBigUInt64BE(i + 2)); offset += 8; }
    if (offset + len > buffer.length) break;
    const payload = buffer.subarray(offset, offset + len);
    frames.push({ opcode: buffer[i] & 0x0f, fin: !!(buffer[i] & 0x80), masked: !!(buffer[i + 1] & 0x80), payload, code: (buffer[i] & 0x0f) === 8 && len >= 2 ? payload.readUInt16BE(0) : undefined });
    i = offset + len;
  }
  return frames;
}

test('handshake, text and binary both ways with our own client', async t => {
  const { url } = await wsServer(t, echo);
  const ws = await connect(url);
  ws.send('olá');
  const [text, binaryFlag] = await once(ws, 'message');
  assert.equal(text, 'echo:olá'); assert.equal(binaryFlag, false);
  const bytes = randomBytes(70000); // 64-bit length on the way back, 16-bit+ from the client
  ws.send(bytes.subarray(0, 60000));
  const [back, isBinary] = await once(ws, 'message');
  assert.equal(isBinary, true); assert.deepEqual(back, bytes.subarray(0, 60000));
  ws.close(1000, 'done');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1000);
});

test("Node's global WebSocket talks to the server: text, binary, several buffers in one message, server close code", async t => {
  let serverSide;
  const { url } = await wsServer(t, ws => { serverSide = ws; echo(ws); });
  const client = new WebSocket(url);
  client.binaryType = 'arraybuffer';
  const messages = [];
  client.onmessage = event => messages.push(event.data);
  await new Promise((resolve, reject) => { client.onopen = resolve; client.onerror = reject; });
  client.send('hi');
  client.send(new Uint8Array([1, 2, 3]));
  await new Promise(r => setTimeout(r, 100));
  serverSide.send(Buffer.from([9, 9]), Buffer.from([8, 8, 8]));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(messages[0], 'echo:hi');
  assert.deepEqual([...new Uint8Array(messages[1])], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(messages[2])], [9, 9, 8, 8, 8]);
  const closed = new Promise(resolve => { client.onclose = resolve; });
  serverSide.close(4001, 'taken');
  const event = await closed;
  assert.equal(event.code, 4001); assert.equal(event.reason, 'taken');
});

test('the client closes with a code the server sees; bufferedAmount reflects the socket queue', async t => {
  let serverSide;
  const closedOnServer = new Promise(resolve => wsServer(t, ws => { serverSide = ws; ws.on('close', (code, reason) => resolve({ code, reason })); }).then(({ url }) => {
    const client = new WebSocket(url);
    client.onopen = () => client.close(4000, 'bye');
  }));
  assert.deepEqual(await closedOnServer, { code: 4000, reason: 'bye' });
  assert.equal(serverSide.bufferedAmount, 0);
});

test('a fragmented text message with a ping in the middle is reassembled and the ping answered', async t => {
  const got = [];
  const { port } = await wsServer(t, ws => ws.on('message', (data, binary) => got.push({ data, binary })));
  const raw = await rawClient(port);
  raw.socket.write(Buffer.concat([
    frame(1, 'frag', { fin: false }),
    frame(9, 'are you there'),
    frame(0, 'men', { fin: false }),
    frame(0, 'tado'),
  ]));
  await raw.until(frames => frames.some(f => f.opcode === 10));
  const pong = raw.frames().find(f => f.opcode === 10);
  assert.equal(pong.payload.toString(), 'are you there');
  assert.equal(pong.masked, false);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(got, [{ data: 'fragmentado', binary: false }]);
});

test('an unmasked client frame is a protocol error (1002)', async t => {
  const { port } = await wsServer(t, () => {});
  const raw = await rawClient(port);
  raw.socket.write(frame(1, 'plain', { mask: false }));
  await raw.until(frames => frames.some(f => f.opcode === 8));
  assert.equal(raw.frames().find(f => f.opcode === 8).code, 1002);
});

test('a message over 64 KiB closes with 1009, also when it only grows past the limit through fragments', async t => {
  const { port } = await wsServer(t, () => {});
  const whole = await rawClient(port);
  whole.socket.write(frame(2, Buffer.alloc(MAX_MESSAGE + 1)));
  await whole.until(frames => frames.some(f => f.opcode === 8));
  assert.equal(whole.frames().find(f => f.opcode === 8).code, 1009);
  const pieces = await rawClient(port);
  pieces.socket.write(Buffer.concat([frame(2, Buffer.alloc(40000), { fin: false }), frame(0, Buffer.alloc(40000))]));
  await pieces.until(frames => frames.some(f => f.opcode === 8));
  assert.equal(pieces.frames().find(f => f.opcode === 8).code, 1009);
  // Exactly the limit is fine.
  let received;
  const { port: port2 } = await wsServer(t, ws => ws.on('message', data => { received = data.length; }));
  const exact = await rawClient(port2);
  exact.socket.write(frame(2, Buffer.alloc(MAX_MESSAGE)));
  for (let i = 0; i < 100 && received === undefined; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(received, MAX_MESSAGE);
});

test('invalid UTF-8 in a text message closes with 1007; a bad close code with 1002', async t => {
  const { port } = await wsServer(t, () => {});
  const bad = await rawClient(port);
  bad.socket.write(frame(1, Buffer.from([0xc3, 0x28])));
  await bad.until(frames => frames.some(f => f.opcode === 8));
  assert.equal(bad.frames().find(f => f.opcode === 8).code, 1007);
  const code = await rawClient(port);
  const payload = Buffer.alloc(2); payload.writeUInt16BE(1005);
  code.socket.write(frame(8, payload));
  await code.until(frames => frames.some(f => f.opcode === 8));
  assert.equal(code.frames().find(f => f.opcode === 8).code, 1002);
});

test('a request that is not a WebSocket handshake gets 400', async t => {
  const { port } = await wsServer(t, () => assert.fail('must not accept'));
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const [chunk] = await once(socket, 'data');
  assert.match(chunk.toString(), /^HTTP\/1\.1 400/);
  socket.destroy();
});

test('pipe joins a browser connection to a connection to another node, byte for byte, after a rewritten hello', async t => {
  // The far node echoes and reports the hello it saw.
  const far = await wsServer(t, ws => {
    ws.once('message', hello => { ws.send(`far saw ${hello}`); echo(ws); });
  });
  // The home node reads the browser's hello, swaps the token, then splices.
  const home = await wsServer(t, ws => {
    ws.once('message', async hello => {
      const upstream = await connect(far.url);
      upstream.send(JSON.stringify({ ...JSON.parse(hello), token: 'peer-token' }));
      pipe(ws, upstream);
    });
  });
  const browser = new WebSocket(home.url);
  const messages = [];
  browser.binaryType = 'arraybuffer';
  browser.onmessage = event => messages.push(event.data);
  const closed = new Promise(resolve => { browser.onclose = resolve; });
  await new Promise(resolve => { browser.onopen = resolve; });
  browser.send(JSON.stringify({ t: 'hello', token: 'owner-token' }));
  await new Promise(r => setTimeout(r, 150));
  browser.send('ping 1');
  browser.send(new Uint8Array(100000).fill(7)); // bigger than 64 KiB: the far node's limit decides, not the relay
  browser.send(new Uint8Array(1000).fill(7));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(messages[0], 'far saw {"t":"hello","token":"peer-token"}');
  assert.equal(messages[1], 'echo:ping 1');
  const event = await closed;
  assert.equal(event.code, 1009); // the far node refused the 100 kB message and the close came through the splice
});

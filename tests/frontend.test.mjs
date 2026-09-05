import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Evaluate the production parser alone: no DOM initialization, network access,
// actual monitor capture or microphone permission is involved in these tests.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const parserSource = source.slice(source.indexOf('const MAX_FRAME_BYTES ='), source.indexOf('\nfunction screenIsVisible()'));
const MAX_FRAME = 8 * 1024 * 1024;
const timestamp = 1770000000000;

function harness(onFrame = () => {}) {
  let allocated = 0;
  let copied = 0;
  const TrackedArray = new Proxy(Uint8Array, {
    construct(target, args) {
      const array = Reflect.construct(target, args);
      allocated += array.byteLength;
      Object.defineProperty(array, 'set', { value(input, offset) {
        copied += input.byteLength;
        return Uint8Array.prototype.set.call(this, input, offset);
      } });
      return array;
    },
  });
  const context = vm.createContext({ Uint8Array: TrackedArray, TextDecoder, Date, t: key => key });
  vm.runInContext(`${parserSource}\nglobalThis.Parser = MjpegParser;`, context);
  return { parser: new context.Parser(onFrame), allocated: () => allocated, copied: () => copied };
}

function packet(size = 32, frameTimestamp = timestamp) {
  const bytes = Buffer.alloc(size, 0x61);
  bytes[0] = 255; bytes[1] = 216; bytes[size - 2] = 255; bytes[size - 1] = 217;
  return Buffer.concat([
    Buffer.from(`--ponte-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${size}\r\nX-Frame-Timestamp: ${frameTimestamp}\r\n\r\n`),
    bytes, Buffer.from('\r\n'),
  ]);
}

test('MJPEG reconstructs headers, timestamps and multiple frames at every split boundary', () => {
  const input = Buffer.concat([packet(32), packet(64, timestamp + 100)]);
  for (let split = 0; split <= input.length; split++) {
    const frames = [];
    const { parser } = harness((bytes, at) => frames.push({ length: bytes.length, at }));
    parser.push(input.subarray(0, split));
    parser.push(input.subarray(split));
    assert.deepEqual(frames, [{ length: 32, at: timestamp }, { length: 64, at: timestamp + 100 }], `split ${split}`);
  }
});

test('MJPEG accepts one-byte fragments and does not emit a partial image', () => {
  const frames = [];
  const { parser } = harness(bytes => frames.push(bytes.length));
  const input = packet(128);
  for (let index = 0; index < input.length - 3; index++) parser.push(input.subarray(index, index + 1));
  assert.equal(frames.length, 0);
  parser.push(input.subarray(input.length - 3));
  assert.deepEqual(frames, [128]);
});

test('MJPEG accepts valid frames whose combined transport chunk exceeds the per-frame cap', () => {
  const size = 4 * 1024 * 1024 + 40000;
  const frames = [];
  const h = harness(bytes => frames.push(bytes.length));
  h.parser.push(Buffer.concat([packet(size), packet(size)]));
  assert.deepEqual(frames, [size, size]);
  assert.ok(h.allocated() <= size * 2 + 8192);
  assert.ok(h.copied() <= size * 2);
});

test('MJPEG accepts an 8 MiB frame tail coalesced with the next frame', () => {
  const frames = [];
  const { parser } = harness(bytes => frames.push(bytes.length));
  const first = packet(MAX_FRAME);
  parser.push(first.subarray(0, first.length - 64));
  parser.push(Buffer.concat([first.subarray(first.length - 64), packet(128 * 1024 - 300)]));
  assert.deepEqual(frames, [MAX_FRAME, 128 * 1024 - 300]);
});

test('MJPEG allocates and copies linearly for a large frame split into 4 KiB chunks', () => {
  const size = 2 * 1024 * 1024;
  const frames = [];
  const h = harness(bytes => frames.push(bytes.length));
  const input = packet(size);
  for (let offset = 0; offset < input.length; offset += 4096) h.parser.push(input.subarray(offset, offset + 4096));
  assert.deepEqual(frames, [size]);
  assert.ok(h.allocated() <= size + 8192, `allocated ${h.allocated()} for ${size} image bytes`);
  assert.ok(h.copied() <= size, `copied ${h.copied()} for ${size} image bytes`);
});

test('MJPEG rejects malformed or oversized frame headers before allocating a body', () => {
  for (const length of ['0', '3', '8388609', '9007199254740992', 'nope']) {
    const h = harness(() => assert.fail('must not emit'));
    assert.throws(() => h.parser.push(Buffer.from(`--ponte-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`)), /Tamanho/);
    assert.ok(h.allocated() <= 8192);
  }
  assert.throws(() => harness().parser.push(Buffer.from('x'.repeat(8193))), /Cabeçalho/);
  assert.throws(() => harness().parser.push(Buffer.from('--wrong\r\nContent-Type: image/jpeg\r\nContent-Length: 32\r\n\r\n')), /Formato/);
  assert.throws(() => harness().parser.push(Buffer.from('--ponte-frame\r\nContent-Type: text/html\r\nContent-Length: 32\r\n\r\n')), /Formato/);
});

test('MJPEG rejects a body without JPEG markers', () => {
  const input = packet(32);
  input[input.length - 3] = 0;
  assert.throws(() => harness().parser.push(input), /JPEG/);
});


test('Android permission dialog keeps the pending microphone request, while background closes it', () => {
  const handlerSource = source.slice(source.indexOf("window.addEventListener('ponte-native-pause'"), source.indexOf("window.addEventListener('hashchange'"));
  let listener;
  const calls = [];
  const context = vm.createContext({
    window: {addEventListener: (_event, callback) => { listener = callback; }},
    leaveScreen: () => calls.push('screen'), stopDrag: () => calls.push('drag'),
    cancelPendingRecording: () => calls.push('pending'), stopRecording: () => calls.push('recording'), closeMicrophone: () => calls.push('microphone'),
  });
  vm.runInContext(handlerSource, context);
  listener({detail: {awaitingMicrophonePermission: true}});
  assert.deepEqual(calls, ['screen', 'drag']);
  calls.length = 0;
  listener({});
  assert.deepEqual(calls, ['screen', 'drag', 'pending', 'recording', 'microphone']);
});

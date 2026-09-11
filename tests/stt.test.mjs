import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { createTranscriber, normalizeTranscript, validateDictationAudio, MAX_DICTATION_BYTES } from '../backend/stt.mjs';

const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);

// A fake Sussurro answers on a private socket exactly like the real IPC:
// one line in, one JSON line out. Nothing here loads a model.
async function fakeSussurro(t, respond) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-stt-'));
  const socketPath = path.join(root, 'sussurro.sock');
  const requests = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const line = buffer.split('\n')[0];
      requests.push(line);
      const answer = respond(line);
      if (answer !== null) socket.end(`${answer}\n`);
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, socketPath, requests };
}

test('dictation audio is validated by declared type and magic bytes before any provider runs', () => {
  assert.throws(() => validateDictationAudio(webm, 'text/plain'), error => error.code === 'UNSUPPORTED_AUDIO_FORMAT');
  assert.throws(() => validateDictationAudio(Buffer.alloc(4), 'audio/webm'), error => error.code === 'EMPTY_RECORDING');
  assert.throws(() => validateDictationAudio(Buffer.alloc(64, 7), 'audio/webm'), error => error.code === 'AUDIO_FORMAT_MISMATCH');
  assert.throws(() => validateDictationAudio(Buffer.alloc(MAX_DICTATION_BYTES + 1), 'audio/webm'), error => error.code === 'AUDIO_TOO_LARGE');
  assert.deepEqual(validateDictationAudio(webm, 'audio/webm;codecs=opus'), { mime: 'audio/webm', extension: 'webm' });
  assert.equal(normalizeTranscript('  ls\u0000 -la\n\n/home\u2028 \t'), 'ls -la /home');
  assert.equal(normalizeTranscript(null), '');
});

test('Sussurro is preferred, receives a private temporary file, and the file is removed afterwards', async t => {
  const fake = await fakeSussurro(t, line => {
    const file = line.replace(/^transcribe /, '');
    return JSON.stringify({ ok: true, text: `  echo  ${path.basename(file).endsWith('.webm') ? 'webm' : 'other'} \n`, dur: 1.5 });
  });
  const dataDir = path.join(fake.root, 'data');
  let fetched = 0;
  const transcriber = createTranscriber(dataDir, { env: { PONTE_SUSSURRO_SOCKET: fake.socketPath, HOME: fake.root }, fetchImpl: async () => { fetched++; throw new Error('never'); } });
  assert.equal(await transcriber.available(), true);
  assert.equal(transcriber.provider, 'sussurro');
  const result = await transcriber.transcribe(webm, 'audio/webm');
  assert.deepEqual(result, { text: 'echo webm', provider: 'sussurro', duration: 1.5 });
  assert.equal(fetched, 0);
  assert.match(fake.requests[0], new RegExp(`^transcribe ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/dictation/[a-f0-9]{16}\\.webm$`));
  assert.deepEqual(await readdir(path.join(dataDir, 'dictation')), []);
  assert.equal(((await lstat(path.join(dataDir, 'dictation'))).mode & 0o777), 0o700);
});

test('empty or malformed provider answers become stable API errors and nothing is typed', async t => {
  const fake = await fakeSussurro(t, line => line.includes('.ogg') ? 'not json' : JSON.stringify({ ok: true, text: '   ' }));
  const transcriber = createTranscriber(path.join(fake.root, 'data'), { env: { PONTE_SUSSURRO_SOCKET: fake.socketPath, PONTE_STT_URL: '' } });
  await assert.rejects(transcriber.transcribe(webm, 'audio/webm'), error => error.status === 422 && error.code === 'STT_EMPTY');
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32, 2)]);
  await assert.rejects(transcriber.transcribe(ogg, 'audio/ogg'), error => error.status === 502 && error.code === 'STT_FAILED');
});

test('the OpenAI-compatible endpoint is the fallback with multipart audio, and no provider reports unavailable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-stt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/health')) return { ok: true };
    const file = options.body.get('file');
    assert.equal(file.type, 'audio/webm');
    assert.equal(options.body.get('language'), 'pt');
    return { ok: true, json: async () => ({ text: 'ls -la' }) };
  };
  const transcriber = createTranscriber(path.join(root, 'data'), { env: { PONTE_SUSSURRO_SOCKET: path.join(root, 'missing.sock'), PONTE_STT_URL: 'http://127.0.0.1:3900/v1/audio/transcriptions' }, fetchImpl });
  assert.equal(await transcriber.available(), true);
  assert.equal(transcriber.provider, 'http');
  assert.deepEqual(await transcriber.transcribe(webm, 'audio/webm'), { text: 'ls -la', provider: 'http', duration: null });
  assert.equal(requests.filter(item => item.options.method === 'POST').length, 1);
  const none = createTranscriber(path.join(root, 'data'), { env: { PONTE_SUSSURRO_SOCKET: path.join(root, 'missing.sock'), PONTE_STT_URL: '' } });
  assert.equal(await none.available(), false);
  await assert.rejects(none.transcribe(webm, 'audio/webm'), error => error.status === 503 && error.code === 'STT_UNAVAILABLE');
});

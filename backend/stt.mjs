import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, lstat } from 'node:fs/promises';
import { ApiError } from './process.mjs';

export const MAX_DICTATION_BYTES = 25 * 1024 * 1024;
const formats = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' };

// Dictation audio is transcribed locally and never stored by Ponte. Two
// providers are supported: the Sussurro IPC socket (faster-whisper already
// loaded on the GPU, ~300 ms) and an OpenAI-compatible endpoint such as
// OmniVoice Studio on loopback. Both are optional; capabilities report which.
export function validateDictationAudio(body, contentType) {
  const mime = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!Object.hasOwn(formats, mime)) throw new ApiError(415, 'UNSUPPORTED_AUDIO_FORMAT');
  if (!Buffer.isBuffer(body) || body.length < 12) throw new ApiError(400, 'EMPTY_RECORDING');
  if (body.length > MAX_DICTATION_BYTES) throw new ApiError(413, 'AUDIO_TOO_LARGE');
  const signatureValid = (
    (mime === 'audio/webm' && body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) ||
    (mime === 'audio/ogg' && body.subarray(0, 4).toString() === 'OggS') ||
    (mime === 'audio/mp4' && body.subarray(4, 8).toString() === 'ftyp') ||
    (mime === 'audio/wav' && body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WAVE')
  );
  if (!signatureValid) throw new ApiError(415, 'AUDIO_FORMAT_MISMATCH');
  return { mime, extension: formats[mime] };
}

// Terminal and keyboard input reject control characters; a transcript is plain
// prose, so it is normalized to one line before it can be typed anywhere.
export function normalizeTranscript(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function ipcRequest(socketPath, command, timeout, connect) {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    const chunks = [];
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; client.destroy();
      if (error) reject(error); else resolve(value);
    };
    client.setTimeout(timeout, () => finish(new ApiError(504, 'STT_FAILED')));
    client.once('connect', () => client.write(`${command}\n`));
    client.on('data', chunk => { chunks.push(chunk); if (chunk[chunk.length - 1] === 10) finish(null, Buffer.concat(chunks).toString('utf8')); });
    client.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    client.once('error', error => finish(Object.assign(new ApiError(503, 'STT_UNAVAILABLE'), { cause: error })));
  });
}

export function createTranscriber(dataDir, { env = process.env, fetchImpl = globalThis.fetch, connect = net.createConnection, timeout = 60000 } = {}) {
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
  const sussurroSocket = env.PONTE_SUSSURRO_SOCKET === '' ? null : (env.PONTE_SUSSURRO_SOCKET || path.join(runtimeDir, 'sussurro.sock'));
  const httpUrl = env.PONTE_STT_URL === '' ? null : (env.PONTE_STT_URL || 'http://127.0.0.1:3900/v1/audio/transcriptions');
  const language = /^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(env.PONTE_STT_LANGUAGE || '') ? env.PONTE_STT_LANGUAGE : 'pt';
  const directory = path.join(dataDir, 'dictation');
  let availability = { checkedAt: 0, value: false, provider: null };

  async function sussurroReady() {
    if (!sussurroSocket) return false;
    try { return (await lstat(sussurroSocket)).isSocket(); } catch { return false; }
  }

  async function httpReady() {
    if (!httpUrl || !fetchImpl) return false;
    try {
      const health = new URL('/health', httpUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try { return (await fetchImpl(health, { signal: controller.signal })).ok; } finally { clearTimeout(timer); }
    } catch { return false; }
  }

  async function available() {
    if (Date.now() - availability.checkedAt < 20000) return availability.value;
    const provider = await sussurroReady() ? 'sussurro' : await httpReady() ? 'http' : null;
    availability = { checkedAt: Date.now(), value: !!provider, provider };
    return availability.value;
  }

  async function viaSussurro(body, extension) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${randomBytes(8).toString('hex')}.${extension}`);
    await writeFile(file, body, { mode: 0o600, flag: 'wx' });
    try {
      const raw = await ipcRequest(sussurroSocket, `transcribe ${file}`, timeout, connect);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new ApiError(502, 'STT_FAILED'); }
      if (!parsed || parsed.ok !== true || typeof parsed.text !== 'string') throw new ApiError(502, 'STT_FAILED');
      return { text: parsed.text, provider: 'sussurro', duration: Number(parsed.dur) || null };
    } finally { await unlink(file).catch(() => {}); }
  }

  async function viaHttp(body, mime, extension) {
    const form = new FormData();
    form.append('file', new Blob([body], { type: mime }), `dictation.${extension}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    form.append('language', language.slice(0, 2));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try { response = await fetchImpl(httpUrl, { method: 'POST', body: form, signal: controller.signal }); }
    catch { throw new ApiError(503, 'STT_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
    if (!response.ok) throw new ApiError(502, 'STT_FAILED');
    let parsed;
    try { parsed = await response.json(); } catch { throw new ApiError(502, 'STT_FAILED'); }
    if (!parsed || typeof parsed.text !== 'string') throw new ApiError(502, 'STT_FAILED');
    return { text: parsed.text, provider: 'http', duration: null };
  }

  async function transcribe(body, contentType) {
    const { mime, extension } = validateDictationAudio(body, contentType);
    let result;
    if (await sussurroReady()) {
      try { result = await viaSussurro(body, extension); }
      catch (error) { if (!(error instanceof ApiError && error.code === 'STT_UNAVAILABLE') || !httpUrl) throw error; }
    }
    if (!result) {
      if (!httpUrl || !fetchImpl) throw new ApiError(503, 'STT_UNAVAILABLE');
      result = await viaHttp(body, mime, extension);
    }
    const text = normalizeTranscript(result.text);
    if (!text) throw new ApiError(422, 'STT_EMPTY');
    return { ...result, text };
  }

  return { transcribe, available, get provider() { return availability.provider; } };
}

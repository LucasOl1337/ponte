import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { ApiError, runCommand, spawnPlayback } from './process.mjs';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const formats = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' };
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

export async function createAudioStore(dataDir, { runner = runCommand, playback = spawnPlayback, env = process.env } = {}) {
  const directory = path.join(dataDir, 'audio');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Audio storage must be a private directory, not a symlink.');
  let playing;

  async function get(id) {
    if (!validId(id)) throw new ApiError(404, 'AUDIO_NOT_FOUND');
    try {
      const metadataPath = path.join(directory, `${id}.json`);
      const metaStat = await lstat(metadataPath);
      if (!metaStat.isFile() || metaStat.size > 2048) throw new Error('Invalid metadata');
      const meta = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (meta.id !== id || !Object.hasOwn(formats, meta.mime) || typeof meta.createdAt !== 'string' || !Number.isFinite(Date.parse(meta.createdAt))) throw new Error('Invalid metadata');
      const file = path.join(directory, `${id}.${formats[meta.mime]}`);
      const fileStat = await lstat(file);
      if (!fileStat.isFile() || fileStat.size > MAX_AUDIO_BYTES) throw new Error('Invalid recording');
      return { recording: { id, name: String(meta.name).slice(0, 120), createdAt: meta.createdAt, size: fileStat.size, mime: meta.mime }, file };
    } catch { throw new ApiError(404, 'AUDIO_NOT_FOUND'); }
  }

  async function list() {
    const entries = (await readdir(directory)).filter(name => name.endsWith('.json'));
    const recordings = [];
    for (const entry of entries) {
      try { recordings.push((await get(entry.slice(0, -5))).recording); } catch {}
    }
    recordings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { recordings };
  }

  async function upload(body, contentType) {
    const mime = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!Object.hasOwn(formats, mime)) throw new ApiError(415, 'UNSUPPORTED_AUDIO_FORMAT');
    if (!Buffer.isBuffer(body) || body.length < 12) throw new ApiError(400, 'EMPTY_RECORDING');
    if (body.length > MAX_AUDIO_BYTES) throw new ApiError(413, 'AUDIO_TOO_LARGE');
    const signatureValid = (
      (mime === 'audio/webm' && body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) ||
      (mime === 'audio/ogg' && body.subarray(0, 4).toString() === 'OggS') ||
      (mime === 'audio/mp4' && body.subarray(4, 8).toString() === 'ftyp') ||
      (mime === 'audio/wav' && body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WAVE')
    );
    if (!signatureValid) throw new ApiError(415, 'AUDIO_FORMAT_MISMATCH');
    const current = (await list()).recordings;
    if (current.length >= 200 || current.reduce((sum, item) => sum + item.size, 0) + body.length > 500 * 1024 * 1024) throw new ApiError(507, 'AUDIO_STORAGE_FULL');
    const id = randomUUID();
    const file = path.join(directory, `${id}.${formats[mime]}`);
    const metadataPath = path.join(directory, `${id}.json`);
    const createdAt = new Date().toISOString();
    const recording = { id, name: `Audio ${createdAt.slice(0, 19).replace('T', ' ')}`, createdAt, size: body.length, mime };
    await writeFile(file, body, { mode: 0o600, flag: 'wx' });
    try {
      const probe = JSON.parse(await runner('ffprobe', [
        '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'matroska,webm,ogg,mov,wav',
        '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file,
      ], { timeout: 6000, maxBuffer: 65536, env }));
      if (!Array.isArray(probe.streams) || !probe.streams.some(s => s.codec_type === 'audio') || probe.streams.some(s => s.codec_type === 'video')) throw new ApiError(415, 'AUDIO_ONLY_REQUIRED');
      if (Number(probe.format?.duration) > 1800) throw new ApiError(413, 'AUDIO_TOO_LONG');
      await writeFile(metadataPath, JSON.stringify(recording), { mode: 0o600, flag: 'wx' });
      return { ok: true, recording };
    } catch (error) {
      await unlink(file).catch(() => {});
      await unlink(metadataPath).catch(() => {});
      if (error instanceof ApiError && error.status !== 503) throw error;
      throw new ApiError(415, 'INVALID_RECORDING');
    }
  }

  function stop() {
    if (playing) { const child = playing; playing = null; child.kill('SIGKILL'); }
    return { ok: true };
  }

  async function play(id) {
    const { file } = await get(id);
    stop();
    const child = playback(file, () => { if (playing === child) playing = null; }, env);
    playing = child;
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new ApiError(503, 'PLAYBACK_FAILED')));
    });
    return { ok: true };
  }

  return { list, get, upload, play, stop, close: stop };
}

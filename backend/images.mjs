import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { ApiError } from './process.mjs';

// Images sent from the phone (screenshots, photos) land in a private inbox.
// Nothing leaves it on its own: copying to the PC clipboard or pasting the
// path into a terminal are separate requests the user picks after the upload.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_KEEP_COUNT = 30;
export const IMAGE_KEEP_BYTES = 200 * 1024 * 1024;
const formats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const mimeOf = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const idPattern = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const filePattern = /^(\d{8}-\d{6}-[0-9a-f]{8})\.(png|jpg|webp)$/;

function signatureValid(mime, body) {
  if (mime === 'image/png') return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  return body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
}

function stamp(date) {
  const two = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

// wl-copy forks a child that keeps serving the selection; only the parent's
// exit is awaited, and its stdout/stderr are not captured so the surviving
// child cannot hold a pipe open. The image goes in through stdin.
export function copyToClipboard(mime, bytes, env = process.env) {
  if (!env.WAYLAND_DISPLAY) return Promise.reject(new ApiError(503, 'CLIPBOARD_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    let done = false;
    const child = spawn('wl-copy', ['--type', mime], { shell: false, stdio: ['pipe', 'ignore', 'ignore'], env });
    const finish = (error) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new ApiError(503, 'CLIPBOARD_UNAVAILABLE')); }, 5000);
    child.once('error', () => finish(new ApiError(503, 'CLIPBOARD_UNAVAILABLE')));
    child.once('exit', code => finish(code === 0 ? null : new ApiError(503, 'CLIPBOARD_UNAVAILABLE')));
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

export async function createImageInbox(dataDir, { clipboard = copyToClipboard, terminals, env = process.env, now = () => new Date() } = {}) {
  const directory = path.join(dataDir, 'inbox');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Image inbox must be a private directory, not a symlink.');

  async function get(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new ApiError(404, 'IMAGE_NOT_FOUND');
    for (const extension of Object.keys(mimeOf)) {
      const file = path.join(directory, `${id}.${extension}`);
      let info;
      try { info = await lstat(file); } catch { continue; }
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) break;
      return { file, image: { id, name: `${id}.${extension}`, path: file, bytes: info.size, mime: mimeOf[extension], createdAt: new Date(info.mtimeMs).toISOString() } };
    }
    throw new ApiError(404, 'IMAGE_NOT_FOUND');
  }

  async function list() {
    const images = [];
    for (const entry of await readdir(directory)) {
      const match = entry.match(filePattern);
      if (!match) continue;
      try { images.push((await get(match[1])).image); } catch {}
    }
    images.sort((a, b) => b.id.localeCompare(a.id));
    return { images, keep: { count: IMAGE_KEEP_COUNT, bytes: IMAGE_KEEP_BYTES } };
  }

  // Oldest first out, never the one just written.
  async function prune(keepId) {
    const { images } = await list();
    let total = 0, count = 0;
    for (const image of images) {
      count++; total += image.bytes;
      if (image.id !== keepId && (count > IMAGE_KEEP_COUNT || total > IMAGE_KEEP_BYTES)) await unlink(image.path).catch(() => {});
    }
  }

  async function upload(body, contentType) {
    const mime = String(contentType == null ? '' : contentType).split(';', 1)[0].trim().toLowerCase();
    if (!Object.hasOwn(formats, mime)) throw new ApiError(415, 'UNSUPPORTED_IMAGE_FORMAT');
    if (!Buffer.isBuffer(body) || body.length < 16) throw new ApiError(400, 'EMPTY_IMAGE');
    if (body.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'IMAGE_TOO_LARGE');
    if (!signatureValid(mime, body)) throw new ApiError(415, 'IMAGE_FORMAT_MISMATCH');
    const id = `${stamp(now())}-${randomBytes(4).toString('hex')}`;
    const file = path.join(directory, `${id}.${formats[mime]}`);
    await writeFile(file, body, { mode: 0o600, flag: 'wx' });
    await prune(id);
    return { ok: true, id, path: file, bytes: body.length, mime, name: path.basename(file) };
  }

  async function remove(id) {
    const { file } = await get(id);
    await unlink(file);
    return { ok: true };
  }

  async function copy(id) {
    const { file, image } = await get(id);
    await clipboard(image.mime, await readFile(file), env);
    return { ok: true, mime: image.mime };
  }

  // The path goes in as pasted text, never followed by Enter: the user reads
  // the prompt and sends it. Agents such as Claude Code and Codex attach an
  // image when its path is pasted.
  async function paste(id, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'terminal' || typeof value.terminal !== 'string') throw new ApiError(400, 'INVALID_IMAGE_TARGET');
    const { file } = await get(id);
    const text = /^[A-Za-z0-9._/@+-]+$/.test(file) ? file : `'${file.replace(/'/g, "'\\''")}'`;
    await terminals.input(value.terminal, { text });
    return { ok: true, text, entered: false };
  }

  return { list, get, upload, remove, copy, paste };
}

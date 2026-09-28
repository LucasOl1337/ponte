import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, symlink, chmod } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { createImageInbox, copyToClipboard, MAX_IMAGE_BYTES, IMAGE_KEEP_COUNT } from '../backend/images.mjs';

const TOKEN = 'test_token_with_at_least_thirty_two_characters';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40)]);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-images-'));
  const publicDir = path.join(root, 'public');
  const dataDir = path.join(root, 'private');
  await mkdir(publicDir); await mkdir(dataDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Ponte</title>');
  const copies = [], inputs = [];
  const clipboard = async (mime, bytes) => { copies.push({ mime, bytes }); };
  const terminals = {
    async input(id, value) {
      if (id !== 'a'.repeat(24)) { const error = new Error('missing'); error.status = 404; throw error; }
      inputs.push({ id, value }); return { ok: true };
    },
    close() {},
  };
  const desktop = { close() {} };
  const app = await createApp({ rootDir: root, dataDir, token: TOKEN, desktop, terminals, clipboard, trustedHosts: [] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const request = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers } });
  const upload = (body, type) => request('/api/images', { method: 'POST', headers: { 'Content-Type': type }, body });
  return { root, dataDir, base, request, upload, copies, inputs };
}

test('image upload checks type, magic bytes and size, and stores a private file under the inbox', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(png, 'image/gif')).status, 415);
  assert.equal((await f.upload(png, 'text/plain')).status, 415);
  assert.equal((await f.upload(jpeg, 'image/png')).status, 415, 'JPEG bytes declared as PNG');
  assert.equal((await (await f.upload(Buffer.from('<svg onload=alert(1)>xxxxxxxx'), 'image/png')).json()).errorCode, 'IMAGE_FORMAT_MISMATCH');
  assert.equal((await f.upload(Buffer.alloc(4), 'image/png')).status, 400);
  assert.equal((await f.upload(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png')).status, 413);
  assert.equal((await fetch(`${f.base}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 401, 'pairing required');
  for (const [body, type, ext] of [[png, 'image/png', 'png'], [jpeg, 'image/jpeg; charset=binary', 'jpg'], [webp, 'image/webp', 'webp']]) {
    const response = await f.upload(body, type);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.match(result.id, /^\d{8}-\d{6}-[0-9a-f]{8}$/);
    assert.equal(result.path, path.join(f.dataDir, 'inbox', `${result.id}.${ext}`));
    assert.equal(result.bytes, body.length);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(result.path), body);
    assert.deepEqual(Buffer.from(await (await f.request(`/api/images/${result.id}`)).arrayBuffer()), body);
  }
  assert.equal((await stat(path.join(f.dataDir, 'inbox'))).mode & 0o777, 0o700);
  const { images } = await (await f.request('/api/images')).json();
  assert.equal(images.length, 3);
  assert.deepEqual(images.map(image => image.mime).sort(), ['image/jpeg', 'image/png', 'image/webp']);
  assert.deepEqual(f.copies, [], 'nothing reaches the clipboard without a request');
  assert.deepEqual(f.inputs, [], 'nothing reaches a terminal without a request');
});

test('copy sends the stored bytes to the clipboard with the image type; paste types the path without Enter', async t => {
  const f = await fixture(t);
  const { id, path: file } = await (await f.upload(jpeg, 'image/jpeg')).json();
  const copy = await f.request(`/api/images/${id}/copy`, { method: 'POST' });
  assert.equal(copy.status, 200);
  assert.equal(f.copies.length, 1);
  assert.equal(f.copies[0].mime, 'image/jpeg');
  assert.deepEqual(f.copies[0].bytes, jpeg);
  const paste = (value, type = 'application/json') => f.request(`/api/images/${id}/paste`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(value) });
  const pasted = await paste({ terminal: 'a'.repeat(24) });
  assert.equal(pasted.status, 200);
  assert.deepEqual(await pasted.json(), { ok: true, text: file, entered: false });
  assert.deepEqual(f.inputs, [{ id: 'a'.repeat(24), value: { text: file } }], 'exactly one text input, no Enter key and no enter flag');
  assert.equal((await paste({ terminal: 'a'.repeat(24), enter: true })).status, 400);
  assert.equal((await paste({})).status, 400);
  assert.equal((await paste({ terminal: 'a'.repeat(24) }, 'text/plain')).status, 415);
  assert.equal(f.inputs.length, 1);
  assert.equal((await f.request('/api/images/20260101-000000-deadbeef/copy', { method: 'POST' })).status, 404);
  assert.equal((await f.request('/api/images/..%2Ftoken/copy', { method: 'POST' })).status, 404);
  assert.equal(f.copies.length, 1);
});

test('images can be listed and deleted; ids cannot traverse or follow symlinks', async t => {
  const f = await fixture(t);
  const { id } = await (await f.upload(png, 'image/png')).json();
  assert.equal((await f.request(`/api/images/${id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await f.request('/api/images')).json()).images, []);
  assert.equal((await f.request(`/api/images/${id}`, { method: 'DELETE' })).status, 404);
  await symlink(path.join(f.dataDir, 'token'), path.join(f.dataDir, 'inbox', '20260101-000000-deadbeef.png'));
  assert.equal((await f.request('/api/images/20260101-000000-deadbeef')).status, 404);
  assert.equal((await f.request('/api/images/20260101-000000-deadbeef/copy', { method: 'POST' })).status, 404);
  assert.deepEqual((await (await f.request('/api/images')).json()).images, []);
  assert.deepEqual(f.copies, []);
});

test('the inbox keeps only the newest images', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let second = 0;
  const inbox = await createImageInbox(root, { now: () => new Date(2026, 8, 28, 10, 0, second++) });
  const ids = [];
  for (let index = 0; index < IMAGE_KEEP_COUNT + 3; index++) ids.push((await inbox.upload(png, 'image/png')).id);
  const kept = (await inbox.list()).images.map(image => image.id);
  assert.equal(kept.length, IMAGE_KEEP_COUNT);
  assert.deepEqual(kept, ids.slice(3).reverse());
  assert.equal((await readdir(path.join(root, 'inbox'))).length, IMAGE_KEEP_COUNT);
});

test('wl-copy receives the image on stdin with its type and a forked server cannot stall the request', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ponte-wlcopy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log');
  // Like the real wl-copy: read stdin, then fork a child that keeps serving
  // (here: sleeps with inherited stdout/stderr) while the parent exits.
  await writeFile(path.join(dir, 'wl-copy'), `#!/bin/sh\nprintf '%s ' "$@" > "${log}.args"\ncat > "${log}.bytes"\n(sleep 30 &)\nexit 0\n`);
  await chmod(path.join(dir, 'wl-copy'), 0o755);
  const env = { PATH: `${dir}:/usr/bin:/bin`, WAYLAND_DISPLAY: 'wayland-test' };
  const started = Date.now();
  await copyToClipboard('image/png', png, env);
  assert.ok(Date.now() - started < 3000, 'resolved on the parent exit');
  assert.equal(await readFile(`${log}.args`, 'utf8'), '--type image/png ');
  assert.deepEqual(await readFile(`${log}.bytes`), png);
  await assert.rejects(copyToClipboard('image/png', png, { PATH: env.PATH }), error => error.code === 'CLIPBOARD_UNAVAILABLE');
  await writeFile(path.join(dir, 'wl-copy'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');
  await assert.rejects(copyToClipboard('image/png', png, env), error => error.status === 503 && error.code === 'CLIPBOARD_UNAVAILABLE');
});

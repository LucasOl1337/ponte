import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { makeDocument, makeWindow } from './helpers/dom.mjs';

const [source, htmlSource, i18nSource] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/i18n.js', import.meta.url), 'utf8'),
]);
const TERMINAL = 'b'.repeat(24);
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness({ shared = [], sessions = [{ id: TERMINAL, title: 'Terminal 1' }] } = {}) {
  const document = makeDocument(htmlSource);
  const window = makeWindow();
  const calls = [];
  let taken = false;
  if (shared) window.PonteNative = { sharedImages() { const value = taken ? [] : shared; taken = true; return JSON.stringify(value); }, showKeyboard() {}, hideKeyboard() {} };
  const respond = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, blob: async () => new Blob([Buffer.from('png')], { type: 'image/png' }) });
  const context = vm.createContext({
    document, window,
    localStorage: { getItem: key => key === 'ponte-pair-token' ? 'synthetic-token' : null, setItem() {}, removeItem() {} },
    navigator: { language: 'pt-BR', languages: ['pt-BR'], userAgent: 'Test' },
    location: { hash: '#inicio', pathname: '/', search: '' },
    history: { replaceState() {} },
    CustomEvent: class { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } },
    Intl, Date, Error, TypeError, TextDecoder, Uint8Array, AbortController, URL, Blob, performance, JSON,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (path, options = {}) => {
      const method = options.method || 'GET';
      calls.push({ path, method, body: options.body, headers: options.headers || {} });
      if (path.startsWith('/__ponte_shared/')) return respond(null);
      if (path === '/api/state') return respond({ hostname: 'lab', capabilities: {}, monitors: [], workspaces: [], windows: [] });
      if (path === '/api/terminals') return respond({ available: true, sessions });
      if (path === '/api/images' && method === 'GET') return respond({ images: [] });
      if (path === '/api/images' && method === 'POST') return respond({ ok: true, id: '20260928-101500-0a0b0c0d', path: '/state/inbox/20260928-101500-0a0b0c0d.png', bytes: 3 }, 201);
      return respond({ ok: true });
    },
  });
  vm.runInContext(i18nSource, context);
  vm.runInContext(source, context);
  return { window, document, calls, el: selector => document.querySelector(selector), run: code => vm.runInContext(code, context), writes: () => calls.filter(call => call.method !== 'GET') };
}

test('a shared screenshot opens the destination sheet with a preview and sends nothing on its own', async () => {
  const h = harness({ shared: [{ id: 'c0ffee', mime: 'image/png', name: 'Screenshot.png', bytes: 3 }] });
  await flush();
  assert.ok(h.calls.some(call => call.path === '/__ponte_shared/c0ffee'), 'bytes fetched from the shell');
  assert.equal(h.el('#image-dialog').open, true);
  assert.equal(h.el('#image-chosen').hidden, false);
  assert.match(h.el('#image-preview').src, /^blob:/);
  assert.deepEqual(h.writes(), [], 'no upload, copy or paste before a destination is chosen');
  h.window.dispatchEvent({ type: 'ponte-native-shared' });
  await flush();
  assert.equal(h.calls.filter(call => call.path.startsWith('/__ponte_shared/')).length, 1, 'each shared image is taken once');
});

test('Copy uploads once with the image type and then asks the PC to copy it', async () => {
  const h = harness({ shared: [{ id: 'c0ffee', mime: 'image/png', name: 'Screenshot.png', bytes: 3 }] });
  await flush();
  h.el('#image-copy').click(); await flush();
  const writes = h.writes();
  assert.equal(writes[0].path, '/api/images');
  assert.equal(writes[0].headers['Content-Type'], 'image/png');
  assert.equal(writes[1].path, '/api/images/20260928-101500-0a0b0c0d/copy');
  assert.match(h.el('#image-result').textContent, /Ctrl\+V/);
  h.el('#image-save').click(); await flush();
  assert.equal(h.writes().filter(call => call.path === '/api/images').length, 1, 'the same image is not uploaded twice');
  assert.match(h.el('#image-result').textContent, /\/state\/inbox\/20260928-101500-0a0b0c0d\.png/);
});

test('Paste sends the path to the chosen Ponte terminal without Enter, and needs a terminal', async () => {
  const h = harness({ shared: [{ id: 'c0ffee', mime: 'image/png', name: 'Screenshot.png', bytes: 3 }] });
  await flush();
  assert.equal(h.el('#image-terminal').value, TERMINAL);
  h.el('#image-paste').click(); await flush();
  const paste = h.writes().find(call => call.path.endsWith('/paste'));
  assert.deepEqual(JSON.parse(paste.body), { terminal: TERMINAL });
  assert.match(h.el('#image-result').textContent, /Terminal 1/);

  const none = harness({ shared: [{ id: 'c0ffee', mime: 'image/png', name: 'Screenshot.png', bytes: 3 }], sessions: [] });
  await flush();
  assert.equal(none.el('#image-paste').disabled, true);
  none.run("sendImage('paste')"); await flush();
  assert.deepEqual(none.writes(), []);
});

test('the Home button opens the sheet empty in a plain browser, without the Android shell', async () => {
  const h = harness({ shared: null });
  await flush();
  assert.equal(h.el('#image-dialog').open, undefined);
  h.el('#image-open').click(); await flush();
  assert.equal(h.el('#image-dialog').open, true);
  assert.equal(h.el('#image-empty').hidden, false);
  assert.equal(h.el('#image-chosen').hidden, true);
  assert.deepEqual(h.writes(), []);
});

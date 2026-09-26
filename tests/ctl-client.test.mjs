import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, stat, lstat, rm, chmod, symlink, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError, createClient, validateOrigin } from '../bin/ctl-client.mjs';

const TOKEN = 'ctl_fixture_private_token_1234567890_-';
const run = promisify(execFile);
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const errorIs = (code, exitCode, status) => error => {
  assert.ok(error instanceof CliError);
  assert.equal(error.code, code);
  assert.equal(error.exitCode, exitCode);
  if (status !== undefined) assert.equal(error.status, status);
  assert.ok(!error.message.includes(TOKEN));
  return true;
};

async function fixture(t, handler = (_req, res) => json(res, { ok: true }), host = '127.0.0.1') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ponte-ctl-client-'));
  const env = { HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_STATE_HOME: path.join(directory, 'state') };
  const tokenFile = path.join(directory, 'token');
  const configFile = path.join(env.XDG_CONFIG_HOME, 'ponte/config.json');
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, headers: req.headers });
    Promise.resolve(handler(req, res)).catch(error => { res.destroy(); t.diagnostic(error.message); });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const port = server.address().port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const client = overrides => createClient({ url, tokenFile, ...overrides }, env);
  const config = async value => {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    return configFile;
  };
  return { directory, env, tokenFile, configFile, config, server, url, port, client, requests };
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail('Fixture condition did not become true before its deadline.');
}
const missing = file => assert.rejects(lstat(file), error => error.code === 'ENOENT');

test('CliError exposes the documented error contract', () => {
  const minimal = new CliError('TEST', 'safe');
  assert.ok(minimal instanceof Error);
  assert.equal(minimal.name, 'CliError');
  assert.equal(minimal.exitCode, 1);
  assert.equal(minimal.status, undefined);
  const full = new CliError('PAIRING_REQUIRED', 'safe', 5, 401);
  assert.equal(full.code, 'PAIRING_REQUIRED');
  assert.equal(full.message, 'safe');
  assert.equal(full.exitCode, 5);
  assert.equal(full.status, 401);
});

test('explicit endpoint and token bypass malformed or explicitly missing user config', async t => {
  const f = await fixture(t);
  await f.config('{broken config containing secret');
  for (const PONTE_CONFIG of [f.configFile, path.join(f.directory, 'not-there')]) {
    const client = await createClient({ url: f.url, tokenFile: f.tokenFile }, { ...f.env, PONTE_CONFIG, OMARCHY_REMOTE_PORT: 'invalid' });
    assert.deepEqual(await client.request({ path: '/api/state' }), { ok: true });
  }
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('token reads are lazy, refreshed for each authenticated request, never required for health', async t => {
  const f = await fixture(t, (req, res) => json(res, { healthy: req.headers.authorization === undefined }));
  await rm(f.tokenFile);
  const client = await f.client();
  assert.deepEqual(await client.request({ path: '/api/health', auth: false }), { healthy: true });
  await assert.rejects(client.request({ path: '/api/state' }), errorIs('TOKEN_FILE', 2));
  assert.equal(f.requests.length, 1);
  await writeFile(f.tokenFile, TOKEN, { mode: 0o600 });
  await client.request({ path: '/api/state' });
  const nextToken = 'z'.repeat(32);
  await writeFile(f.tokenFile, nextToken);
  await client.request({ path: '/api/state' });
  assert.equal(f.requests.at(-1).headers.authorization, `Bearer ${nextToken}`);
  await chmod(f.tokenFile, 0o644);
  assert.deepEqual(await client.request({ path: '/api/health', auth: false }), { healthy: true });
  const noToken = await createClient({ url: f.url }, { ...f.env, PONTE_CONFIG: path.join(f.directory, 'missing-config') });
  await noToken.request({ path: '/api/health', auth: false });
  await assert.rejects(noToken.request({ path: '/api/state' }), errorIs('CONFIG_ERROR', 2));
});

test('private token file rejects symlinks, directories, unsafe modes, oversized and malformed values', async t => {
  const f = await fixture(t);
  const client = await f.client();
  for (const mode of [0o644, 0o640, 0o400, 0o700, 0o1600]) {
    await chmod(f.tokenFile, mode);
    await assert.rejects(client.request({ path: '/api/state' }), errorIs('TOKEN_FILE', 2));
    assert.equal((await stat(f.tokenFile)).mode & 0o7777, mode, 'client does not repair permissions');
  }
  await chmod(f.tokenFile, 0o600);
  for (const value of ['x'.repeat(31), 'x'.repeat(129), TOKEN + '!secret', 'x'.repeat(257), TOKEN + '\n' + TOKEN, `\u0000${TOKEN}`]) {
    await writeFile(f.tokenFile, value);
    await assert.rejects(client.request({ path: '/api/state' }), errorIs('TOKEN_FILE', 2));
  }
  const actual = path.join(f.directory, 'actual');
  await rename(f.tokenFile, actual);
  await writeFile(actual, TOKEN);
  await symlink(actual, f.tokenFile);
  await assert.rejects(client.request({ path: '/api/state' }), errorIs('TOKEN_FILE', 2));
  await rm(f.tokenFile);
  await mkdir(f.tokenFile);
  await assert.rejects(client.request({ path: '/api/state' }), errorIs('TOKEN_FILE', 2));
  assert.equal(f.requests.length, 0);
});

test('token boundaries match the server, including a trailing newline', async t => {
  const f = await fixture(t);
  const client = await f.client();
  for (const value of ['a'.repeat(32), 'A_-0'.repeat(32)]) {
    await writeFile(f.tokenFile, value + '\n');
    await client.request({ path: '/api/state' });
    assert.equal(f.requests.at(-1).headers.authorization, `Bearer ${value}`);
  }
});

test('URL validation rejects unsafe origins and disguised nonliteral HTTP loopbacks', async t => {
  const f = await fixture(t);
  for (const url of ['http://remote.example', 'http://127.1', 'http://127.0.0.2', 'http://2130706433', 'http://0x7f000001',
    'http://0177.0.0.1', 'http://localhost.', 'http://[0:0:0:0:0:0:0:1]', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd',
    'https://name:secret@example.com', 'https://@example.com', 'https://example.com/path', 'https://example.com/.',
    'https://example.com//', 'https://example.com/?', 'https://example.com/#', 'https://example.com?q=x',
    'https://example.com#token', 'https://example.com\\path', ' http://localhost', 'http://local\nhost', 'http://localhost\n',
    'http://localhost:0', 'http://localhost:65536', 'http://localhost:', '', undefined, null]) {
    if (url === undefined) continue;
    await assert.rejects(createClient({ url, tokenFile: f.tokenFile }, f.env), errorIs('INVALID_URL', 2), String(url));
  }
  for (const url of [f.url, f.url + '/', 'http://localhost:1234', 'http://[::1]:1234', 'https://remote.example:8788']) {
    assert.equal(typeof (await createClient({ url, tokenFile: f.tokenFile }, f.env)).request, 'function');
  }
  assert.equal(f.requests.length, 0);
});

test('validateOrigin is a pure synchronous validator available to dry-run', () => {
  assert.equal(validateOrigin('https://example.com:443').origin, 'https://example.com');
  assert.equal(validateOrigin('http://[::1]:8787').hostname, '[::1]');
  assert.throws(() => validateOrigin('http://127.1'), errorIs('INVALID_URL', 2));
});

test('settings supply endpoint and default token through XDG, PONTE_CONFIG and environment overrides', async t => {
  const f = await fixture(t);
  const dataDir = path.join(f.directory, 'private');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'token'), TOKEN, { mode: 0o600 });
  await f.config({ schemaVersion: 1, http: { host: '127.0.0.1', port: f.port }, dataDir });
  await (await createClient({}, f.env)).request({ path: '/api/state' });
  const movedConfig = path.join(f.directory, 'custom-config.json');
  await rename(f.configFile, movedConfig);
  await (await createClient({}, { ...f.env, PONTE_CONFIG: movedConfig })).request({ path: '/api/state' });
  const override = await createClient({}, { ...f.env, OMARCHY_REMOTE_PORT: String(f.port), OMARCHY_REMOTE_DATA: dataDir });
  await override.request({ path: '/api/state' });
  assert.equal(f.requests.length, 3);
  for (const request of f.requests) assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  await f.config('{');
  await assert.rejects(createClient({}, f.env), errorIs('CONFIG_ERROR', 2));
  await assert.rejects(createClient({}, { ...f.env, PONTE_CONFIG: path.join(f.directory, 'absent') }), errorIs('CONFIG_ERROR', 2));
});

test('default configured IPv6 endpoint is bracketed correctly', async t => {
  const f = await fixture(t, (_req, res) => json(res, { ipv6: true }), '::1');
  await f.config({ schemaVersion: 1, http: { host: '::1', port: f.port }, dataDir: f.directory });
  const client = await createClient({}, f.env);
  assert.deepEqual(await client.request({ path: '/api/state' }), { ipv6: true });
});

test('request supports JSON, strings, buffers, query strings and explicit content types', async t => {
  const f = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    json(res, { method: req.method, path: req.url, body: Buffer.concat(chunks).toString('base64'), type: req.headers['content-type'] });
  });
  const client = await f.client();
  for (const [body, contentType, expected, type] of [
    [{ text: 'ação', nested: [1] }, undefined, Buffer.from('{"text":"ação","nested":[1]}'), 'application/json'],
    ['olá', undefined, Buffer.from('olá'), 'text/plain; charset=utf-8'],
    [Buffer.from([0, 255, 1]), 'audio/ogg', Buffer.from([0, 255, 1]), 'audio/ogg'],
  ]) {
    assert.deepEqual(await client.request({ method: 'POST', path: '/api/action?name=a%20b', body, contentType }), {
      method: 'POST', path: '/api/action?name=a%20b', body: expected.toString('base64'), type,
    });
  }
});

test('invalid request values fail as usage errors before network access', async t => {
  const f = await fixture(t);
  for (const timeout of [0, -1, 120001, Infinity, 1.2, '15000']) await assert.rejects(f.client({ timeout }), errorIs('INVALID_OPTIONS', 2));
  await assert.rejects(f.client({ signal: {} }), errorIs('INVALID_OPTIONS', 2));
  const client = await f.client();
  const cyclic = {}; cyclic.self = cyclic;
  for (const options of [null, [], 42, { path: '/não-codificado' }, { path: 'https://elsewhere' }, { path: '//elsewhere' }, { path: '/api/health\r\nX: y' }, { path: '/x#secret' },
    { path: '/x\\y' }, { path: '/api/action', body: cyclic }, { path: '/x', body: 12 }, { path: '/x', method: 'GET\r\n' },
    { path: '/x', contentType: 'text/plain\r\nX: y' }, { path: '/x', auth: 'false' }, { path: '/x', durationMs: 10 }]) {
    await assert.rejects(client.request(options), errorIs('INVALID_REQUEST', 2));
  }
  await assert.rejects(client.request({ path: '/x', output: '' }), errorIs('OUTPUT_FILE', 2));
  assert.equal(f.requests.length, 0);
});

test('HTTP errors preserve only trusted codes and safe messages, with unauthorized exit 5', async t => {
  let reply;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(reply.status, { 'Content-Type': reply.type || 'application/json' });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
  const client = await f.client();
  for (const [status, body, code] of [
    [401, { errorCode: 'PAIRING_REQUIRED', error: TOKEN }, 'PAIRING_REQUIRED'],
    [403, { code: 'HOST_NOT_ALLOWED', error: TOKEN }, 'HOST_NOT_ALLOWED'],
    [503, { error: 'SERVER_RESTARTING' }, 'SERVER_RESTARTING'],
    [500, { code: TOKEN, error: `<html>${TOKEN}</html>` }, 'HTTP_ERROR'],
    [401, `<html>${TOKEN}</html>`, 'UNAUTHORIZED'],
    [418, { code: 'COMMAND_FAILED', error: TOKEN, errorParameters: { command: TOKEN } }, 'COMMAND_FAILED'],
  ]) {
    reply = { status, body };
    await assert.rejects(client.request({ path: '/api/state' }), errorIs(code, [401, 403].includes(status) ? 5 : 6, status));
  }
  reply = { status: 500, type: 'text/html', body: TOKEN };
  await assert.rejects(client.request({ path: '/x' }), errorIs('HTTP_ERROR', 6, 500));
  reply = { status: 500, body: ' '.repeat(70 * 1024) + TOKEN };
  await assert.rejects(client.request({ path: '/x' }), errorIs('HTTP_ERROR', 6, 500));
});

test('redirects are refused without following Location or retrying', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { Location: `/api/action?token=${TOKEN}` }); res.end(); });
  const client = await f.client();
  await assert.rejects(client.request({ method: 'POST', path: '/api/action', body: { action: 'click' } }), errorIs('REDIRECT_REFUSED', 6, 307));
  assert.equal(f.requests.length, 1);
});

test('truncated error bodies still report the known HTTP status safely', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': 1000 });
    res.write('{"error":"');
    const timer = setTimeout(() => res.destroy(), 20);
    res.once('close', () => clearTimeout(timer));
  });
  const client = await f.client();
  await assert.rejects(client.request({ path: '/x' }), errorIs('UNAUTHORIZED', 5, 401));
});

test('deadline covers missing headers and an active, unfinished response body without retries', async t => {
  for (const body of [false, true]) {
    const f = await fixture(t, (_req, res) => {
      if (!body) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"pending":"');
      const timer = setInterval(() => res.write('.'), 10);
      res.once('close', () => clearInterval(timer));
    });
    const client = await f.client({ timeout: 100 });
    const start = performance.now();
    await assert.rejects(client.request({ path: '/api/state' }), errorIs('TIMEOUT', 4));
    assert.ok(performance.now() - start < 1500);
    assert.equal(f.requests.length, 1);
  }
});

test('unavailable transport is exit 3 with a safe diagnostic and no retry', async t => {
  const f = await fixture(t, (_req, res) => res.destroy(new Error(TOKEN)));
  const client = await f.client();
  await assert.rejects(client.request({ path: '/api/state' }), errorIs('UNAVAILABLE', 3));
  assert.equal(f.requests.length, 1);
  await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(client.request({ path: '/api/state' }), errorIs('UNAVAILABLE', 3));
});

test('JSON success requires valid JSON content type and object, with a 32 MiB cap', async t => {
  let type = 'text/html', body = `<html>${TOKEN}</html>`, length;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': type, ...(length ? { 'Content-Length': length } : {}) });
    res.end(body);
  });
  const client = await f.client();
  for (const [nextType, nextBody] of [['text/html', TOKEN], ['application/json', '{'], ['application/json', 'null'], ['application/json', '12']]) {
    type = nextType; body = nextBody;
    await assert.rejects(client.request({ path: '/api/state' }), errorIs('INVALID_RESPONSE', 6, 200));
  }
  type = 'application/json'; body = '{}'; length = 32 * 1024 * 1024 + 1;
  await assert.rejects(client.request({ path: '/api/state' }), errorIs('RESPONSE_TOO_LARGE', 6, 200));
  length = undefined; type = 'application/vnd.ponte+json';
  assert.deepEqual(await client.request({ path: '/api/state' }), {});
});

test('binary downloads use exclusive mode 0600 and return absolute path, size and type', async t => {
  const data = Buffer.from([255, 216, 0, 42, 255, 217]);
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(data); });
  const client = await f.client();
  const absolute = path.join(f.directory, 'shot.jpg');
  const output = path.relative(process.cwd(), absolute);
  assert.deepEqual(await client.request({ path: '/api/screenshot', output }), { output: absolute, bytes: data.length, contentType: 'image/jpeg' });
  assert.deepEqual(await readFile(absolute), data);
  assert.equal((await stat(absolute)).mode & 0o777, 0o600);
  await assert.rejects(client.request({ path: '/api/screenshot', output }), errorIs('OUTPUT_EXISTS', 2));
  assert.deepEqual(await readFile(absolute), data);
  const link = path.join(f.directory, 'link');
  await symlink(absolute, link);
  await assert.rejects(client.request({ path: '/api/screenshot', output: link }), errorIs('OUTPUT_EXISTS', 2));
  assert.ok((await lstat(link)).isSymbolicLink());
  const dangling = path.join(f.directory, 'dangling');
  await symlink(path.join(f.directory, 'no-target'), dangling);
  await assert.rejects(client.request({ path: '/api/screenshot', output: dangling }), errorIs('OUTPUT_EXISTS', 2));
  assert.ok((await lstat(dangling)).isSymbolicLink());
});

test('status, content type and declared size are validated before an output is created', async t => {
  let status = 401, type = 'application/json', length;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(status, { 'Content-Type': type, ...(length ? { 'Content-Length': length } : {}) });
    res.end(JSON.stringify({ errorCode: 'PAIRING_REQUIRED', error: TOKEN }));
  });
  const client = await f.client();
  const output = path.join(f.directory, 'output');
  await assert.rejects(client.request({ path: '/x', output }), errorIs('PAIRING_REQUIRED', 5, 401));
  await missing(output);
  status = 200;
  for (const badType of ['text/html', 'application/json', '']) {
    type = badType;
    await assert.rejects(client.request({ path: '/x', output }), errorIs('INVALID_RESPONSE', 6));
    await missing(output);
  }
  type = 'image/jpeg'; length = 32 * 1024 * 1024 + 1;
  await assert.rejects(client.request({ path: '/x', output }), errorIs('RESPONSE_TOO_LARGE', 6));
  await missing(output);
});

test('incomplete downloads are removed after transport failure and whole-response deadline', async t => {
  for (const disconnect of [false, true]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': 1000 });
      res.write('partial');
      if (disconnect) {
        const timer = setTimeout(() => res.destroy(), 30);
        res.once('close', () => clearTimeout(timer));
      }
    });
    const output = path.join(f.directory, 'partial.jpg');
    const client = await f.client({ timeout: 150 });
    await assert.rejects(client.request({ path: '/x', output }), errorIs(disconnect ? 'UNAVAILABLE' : 'TIMEOUT', disconnect ? 3 : 4));
    await missing(output);
  }
});

test('external AbortSignal cancels active requests and removes only its own partial output', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.write('partial'); });
  const controller = new AbortController();
  const client = await f.client({ signal: controller.signal });
  const output = path.join(f.directory, 'cancelled');
  const pending = assert.rejects(client.request({ path: '/x', output }), errorIs('CANCELLED', 130));
  await waitFor(async () => (await stat(output).catch(() => null))?.size > 0);
  controller.abort(new Error(TOKEN));
  await pending;
  await missing(output);
  const count = f.requests.length;
  await assert.rejects(client.request({ path: '/x' }), errorIs('CANCELLED', 130));
  assert.equal(f.requests.length, count, 'pre-aborted signal sends nothing');
});

test('cleanup preserves replacement files and replacement symlinks at the output path', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.write('partial'); });
  for (const replacementLink of [false, true]) {
    const controller = new AbortController();
    const client = await f.client({ signal: controller.signal });
    const output = path.join(f.directory, `replaced-${replacementLink}`);
    const moved = output + '.old';
    const pending = assert.rejects(client.request({ path: '/x', output }), errorIs('CANCELLED', 130));
    await waitFor(async () => (await stat(output).catch(() => null))?.size > 0);
    await rename(output, moved);
    if (replacementLink) await symlink(moved, output);
    else await writeFile(output, 'someone else');
    controller.abort();
    await pending;
    if (replacementLink) assert.ok((await lstat(output)).isSymbolicLink());
    else assert.equal(await readFile(output, 'utf8'), 'someone else');
  }
});

test('duration timer gracefully finishes a bounded, incrementally written stream with data', async t => {
  const type = 'multipart/x-mixed-replace; boundary=ponte-frame';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': type });
    res.write('frame\n');
    const timer = setInterval(() => res.write('frame\n'), 10);
    res.once('close', () => clearInterval(timer));
  });
  const client = await f.client({ timeout: 2000 });
  const output = path.join(f.directory, 'stream.mjpeg');
  let settled = false;
  const start = performance.now();
  const pending = client.request({ path: '/api/stream', output, durationMs: 200 }).finally(() => { settled = true; });
  await waitFor(async () => (await stat(output).catch(() => null))?.size > 0);
  assert.equal(settled, false, 'data is on disk while the stream is still open');
  const result = await pending;
  assert.ok(performance.now() - start >= 170);
  assert.ok(performance.now() - start < 1500);
  assert.equal(result.output, output);
  assert.equal(result.durationMs, 200);
  assert.equal(result.contentType, type);
  assert.equal(result.bytes, (await stat(output)).size);
  assert.ok(result.bytes >= 6);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('duration with no data fails, premature connection failure fails, and timeout wins over duration', async t => {
  for (const mode of ['empty', 'disconnect', 'timeout']) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=x' });
      res.flushHeaders();
      if (mode !== 'empty') res.write('frame');
      if (mode === 'disconnect') {
        const timer = setTimeout(() => res.destroy(), 20);
        res.once('close', () => clearTimeout(timer));
      }
    });
    const client = await f.client({ timeout: mode === 'timeout' ? 60 : 2000 });
    const output = path.join(f.directory, 'stream');
    const [code, exit] = mode === 'empty' ? ['INVALID_RESPONSE', 6] : mode === 'timeout' ? ['TIMEOUT', 4] : ['UNAVAILABLE', 3];
    await assert.rejects(client.request({ path: '/x', output, durationMs: 150 }), errorIs(code, exit));
    await missing(output);
  }
});

test('external cancellation is never a successful duration-limited stream', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=x' });
    res.write('frame');
  });
  const controller = new AbortController();
  const client = await f.client({ signal: controller.signal });
  const output = path.join(f.directory, 'cancelled-stream');
  const pending = assert.rejects(client.request({ path: '/x', output, durationMs: 1000 }), errorIs('CANCELLED', 130));
  await waitFor(async () => (await stat(output).catch(() => null))?.size > 0);
  controller.abort();
  await pending;
  await missing(output);
});

test('chunked JSON, binary and streams enforce actual byte limits and remove partial output', async t => {
  for (const kind of ['json', 'binary', 'stream']) {
    const limit = (kind === 'stream' ? 128 : 32) * 1024 * 1024;
    const f = await fixture(t, async (_req, res) => {
      res.writeHead(200, { 'Content-Type': kind === 'json' ? 'application/json' : kind === 'binary' ? 'image/jpeg' : 'multipart/x-mixed-replace; boundary=x' });
      const chunk = Buffer.alloc(256 * 1024, 32);
      let written = 0;
      while (!res.destroyed && written <= limit) {
        const more = res.write(chunk); written += chunk.length;
        if (!more) {
          await new Promise(resolve => {
            const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); };
            res.once('drain', finish); res.once('close', finish);
          });
        }
      }
      if (!res.destroyed) res.end();
    });
    const client = await f.client({ timeout: 10000 });
    const output = kind === 'json' ? undefined : path.join(f.directory, kind);
    await assert.rejects(client.request({ path: '/x', output }), errorIs('RESPONSE_TOO_LARGE', 6));
    if (output) await missing(output);
  }
});

test('HTTPS keeps certificate verification, accepts explicit CA and scopes config CA to its exact origin', async t => {
  const f = await fixture(t);
  const caFile = path.join(f.directory, 'cert.pem');
  const keyFile = path.join(f.directory, 'key.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyFile, '-out', caFile, '-subj', '/CN=Ponte ctl fixture',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { timeout: 10000 });
  const server = https.createServer({ key: await readFile(keyFile), cert: await readFile(caFile) }, (_req, res) => json(res, { tls: true }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `https://127.0.0.1:${server.address().port}`;
  await f.config('{invalid');
  const env = { ...f.env, PONTE_CONFIG: f.configFile };
  const secure = await createClient({ url, tokenFile: f.tokenFile, caFile }, env);
  assert.deepEqual(await secure.request({ path: '/api/state' }), { tls: true });
  const health = await createClient({ url, caFile }, env);
  assert.deepEqual(await health.request({ path: '/api/health', auth: false }), { tls: true });
  const untrusted = await createClient({ url, tokenFile: f.tokenFile }, env);
  await assert.rejects(untrusted.request({ path: '/api/health', auth: false }), errorIs('TLS_ERROR', 3));
  const moduleUrl = new URL('../bin/ctl-client.mjs', import.meta.url).href;
  const script = `import {createClient} from ${JSON.stringify(moduleUrl)};
    const client = await createClient({url:${JSON.stringify(url)},tokenFile:${JSON.stringify(f.tokenFile)}}, {});
    try { await client.request({path:'/api/health',auth:false}); process.exitCode=1; }
    catch (error) { if(error.code!=='TLS_ERROR'||error.exitCode!==3) process.exitCode=2; }`;
  const hardened = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...f.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, timeout: 10000,
  });
  assert.equal(hardened.stdout, '', 'the module never writes to stdout');
  const wrongName = await createClient({ url: url.replace('127.0.0.1', 'localhost'), tokenFile: f.tokenFile, caFile }, env);
  await assert.rejects(wrongName.request({ path: '/api/health', auth: false }), errorIs('TLS_ERROR', 3));
  const badCa = await createClient({ url, tokenFile: f.tokenFile, caFile: path.join(f.directory, 'missing-ca') }, env);
  await assert.rejects(badCa.request({ path: '/x' }), errorIs('CA_FILE', 2));
  await f.config({ schemaVersion: 1, dataDir: f.directory, nativeTls: {
    host: '100.64.0.1', port: 8788, certFile: caFile, keyFile, caFile: path.join(f.directory, 'missing-config-ca'),
  } });
  const matching = await createClient({ url: 'https://100.64.0.1:8788' }, f.env);
  await assert.rejects(matching.request({ path: '/x', auth: false }), errorIs('CA_FILE', 2), 'matches before any network request');
  const otherOrigin = await createClient({ url }, f.env);
  await assert.rejects(otherOrigin.request({ path: '/api/health', auth: false }), errorIs('TLS_ERROR', 3), 'config CA is not loaded for another origin');
});

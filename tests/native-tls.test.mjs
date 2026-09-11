import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createApp, isTailscaleIpv4Bind } from '../server.mjs';

const run = promisify(execFile);
const TOKEN = 'native_tls_test_token_with_at_least_32_characters';

test('native bind only accepts canonical addresses within the Tailscale IPv4 range', () => {
  for (const value of ['100.64.0.1', '100.80.90.100', '100.127.255.254']) assert.equal(isTailscaleIpv4Bind(value), true);
  for (const value of [undefined, '', '0.0.0.0', '127.0.0.1', '100.63.255.255', '100.128.0.0', '100.064.71.120', '100.099.71.120', '100.64.0.01', '100.64.0.1.example', '::']) assert.equal(isTailscaleIpv4Bind(value), false, String(value));
});

test('native TLS requires the dedicated certificate, validates names, authenticates API, and closes unfinished handshakes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-native-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/index.html'), '<title>Ponte</title>');
  const certFile = path.join(root, 'server.crt');
  const keyFile = path.join(root, 'server.key');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=Ponte test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { timeout: 10000 });
  const cert = await readFile(certFile);
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN, env: {},
    nativeTls: { cert, key: await readFile(keyFile) },
    desktop: { getState: async () => ({ hostname: 'test-pc' }), close: async () => {} },
    audio: { close: async () => {} },
  });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => app.nativeServer.listen(0, '127.0.0.1', resolve));
  const port = app.nativeServer.address().port;
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: url, ca: cert, agent: false, ...options }, res => {
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString() }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Test request timed out')));
    req.on('error', reject); req.end();
  });

  assert.equal((await request('/api/health')).status, 200);
  await assert.rejects(request('/api/health', { ca: undefined }), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  await assert.rejects(request('/api/health', { servername: 'wrong.example' }), error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal((await request('/api/state')).status, 401);
  assert.deepEqual(JSON.parse((await request('/api/state', { headers: { Authorization: `Bearer ${TOKEN}` } })).body), { hostname: 'test-pc', version: '0.1.0-alpha.13' });
  assert.equal((await request('/api/state', { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/state', { servername: '', headers: { Authorization: `Bearer ${TOKEN}`, Host: 'evil.example' } })).status, 403);
  assert.equal((await request('/server.key')).status, 404);

  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  await new Promise(resolve => raw.once('connect', resolve));
  const socketClosed = new Promise(resolve => raw.once('close', resolve));
  const started = performance.now();
  await app.close(); await socketClosed;
  assert.ok(performance.now() - started < 1500, 'shutdown must not wait for a stalled TLS handshake');
  assert.equal(app.server.listening, false);
  assert.equal(app.nativeServer.listening, false);
});

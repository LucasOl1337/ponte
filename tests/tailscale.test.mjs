import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { createTailscaleIdentity, normalizePeerAddress } from '../backend/tailscale.mjs';

const run = promisify(execFile);
const TOKEN = 'tailnet_autopair_test_token_at_least_32_chars';
const OWNER = 2739214731048881;
const whois = (address, node) => JSON.stringify({ Node: { Addresses: [`${address}/32`], ...node } });

test('peer addresses are normalized to a bare IP for whois', () => {
  assert.equal(normalizePeerAddress('::ffff:100.111.221.82'), '100.111.221.82');
  assert.equal(normalizePeerAddress('100.111.221.82'), '100.111.221.82');
  assert.equal(normalizePeerAddress('[fd7a:115c:a1e0::ae2e:dd53]'), 'fd7a:115c:a1e0::ae2e:dd53');
  assert.equal(normalizePeerAddress('not-an-ip'), null);
  assert.equal(normalizePeerAddress(''), null);
});

test('a peer owned by the same tailnet user authorizes; others do not, and results are cached', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args[2]);
    const address = args[2];
    if (address === '100.100.100.100') return whois(address, { User: OWNER });        // this PC
    if (address === '100.111.221.82') return whois(address, { User: OWNER });        // the owner's phone
    if (address === '100.88.0.9') return whois(address, { User: 55 });               // a shared machine
    if (address === '100.88.0.10') return whois(address, { User: OWNER, Tags: ['tag:server'] }); // tagged, no human owner
    throw new Error('not found');
  };
  const identity = createTailscaleIdentity({ runner, selfAddress: '100.100.100.100', env: {} });
  await identity.ready;
  assert.equal(identity.ownerUserId, OWNER);
  assert.equal(await identity.authorize('::ffff:100.111.221.82'), true);
  assert.equal(await identity.authorize('100.88.0.9'), false);
  assert.equal(await identity.authorize('100.88.0.10'), false, 'tagged device never auto-pairs');
  assert.equal(await identity.authorize('bogus'), false);
  const before = calls.length;
  await identity.authorize('100.111.221.82');
  assert.equal(calls.length, before, 'a repeated peer is served from cache');
});

test('auto-pairing is disabled when the owner cannot be resolved or PONTE_TAILSCALE_AUTO=0', async () => {
  const failing = createTailscaleIdentity({ runner: async () => { throw new Error('tailscale down'); }, selfAddress: '100.100.100.100', env: {} });
  await failing.ready;
  assert.equal(await failing.authorize('100.111.221.82'), false);
  const off = createTailscaleIdentity({ runner: async () => whois('100.100.100.100', { User: OWNER }), selfAddress: '100.100.100.100', env: { PONTE_TAILSCALE_AUTO: '0' } });
  assert.equal(off.available, false);
  assert.equal(await off.authorize('100.111.221.82'), false);
});

test('GET /api/pair hands the key to an owner device over the tailnet and denies everyone else', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-autopair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/index.html'), '<title>Ponte</title>');
  const certFile = path.join(root, 'server.crt'), keyFile = path.join(root, 'server.key');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=Ponte test', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 10000 });
  const cert = await readFile(certFile);
  let owned = true;
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKEN, env: {},
    nativeTls: { cert, key: await readFile(keyFile) },
    desktop: { getState: async () => ({ hostname: 'test-pc' }), close: async () => {} },
    audio: { close: async () => {} },
    tailnetIdentity: { available: true, ready: Promise.resolve(), ownerUserId: OWNER, authorize: async () => owned },
  });
  t.after(() => app.close());
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => app.nativeServer.listen(0, '127.0.0.1', resolve));
  const nativePort = app.nativeServer.address().port, loopPort = app.server.address().port;
  const httpsGet = (port, url) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: url, ca: cert, agent: false }, res => {
      const data = []; res.on('data', c => data.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString() }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
  });
  // Owner device over the tailnet TLS listener: gets the real token.
  const ok = await httpsGet(nativePort, '/api/pair');
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).token, TOKEN);
  // The same token then authenticates a real request.
  assert.equal((await new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: nativePort, path: '/api/state', ca: cert, agent: false, headers: { Authorization: `Bearer ${TOKEN}` } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end();
  })).status, 200);
  // A device the daemon does not recognize as the owner is denied.
  owned = false;
  assert.equal((await httpsGet(nativePort, '/api/pair')).status, 403);
  // health advertises auto-pairing only on the native listener.
  assert.equal(JSON.parse((await httpsGet(nativePort, '/api/health')).body).autoPair, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { createDesktop } from '../backend/desktop.mjs';
import { createMesh } from '../backend/mesh.mjs';
import { createTailscaleIdentity } from '../backend/tailscale.mjs';

const run = promisify(execFile);
const TOKENS = { a: 'mesh_owner_token_a_with_at_least_32_characters', b: 'mesh_owner_token_b_with_at_least_32_characters' };

// A private CA and a leaf for 127.0.0.1, like `./ponte setup` makes for 100.x.
async function certificates(dir) {
  const file = name => path.join(dir, name);
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-keyout', file('ca.key'), '-out', file('ca.crt'),
    '-subj', '/CN=Ponte test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { timeout: 15000 });
  await writeFile(file('leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
  await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', file('server.key'), '-out', file('server.csr'), '-subj', '/CN=Ponte server'], { timeout: 15000 });
  await run('openssl', ['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-set_serial', '7', '-days', '1', '-sha256', '-extfile', file('leaf.ext'), '-out', file('server.crt')], { timeout: 15000 });
  return { ca: await readFile(file('ca.crt'), 'utf8'), cert: await readFile(file('server.crt')), key: await readFile(file('server.key')) };
}

function fakeDesktop(hostname) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'hyprctl') {
      if (args[1] === 'monitors') return JSON.stringify([{ name: 'DP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true, dpmsStatus: true }]);
      if (args[1] === 'clients' || args[1] === 'workspaces') return '[]';
      if (args[1] === 'activewindow') return '{}';
    }
    if (command === 'grim') return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    if (command === 'wpctl') return 'Volume: 0.5\n';
    return 'ok';
  };
  const desktop = createDesktop({ runner, exists: async () => true, env: {}, log: { warn() {}, error() {}, log() {} } });
  const getState = desktop.getState;
  desktop.getState = async (...args) => ({ ...await getState(...args), hostname, wakeOnLan: { mac: 'aa:bb:cc:dd:ee:ff', interface: 'eth0' } });
  return { desktop, calls };
}

// One node: its own dataDir, CA, owner token, loopback HTTP and tailnet TLS
// listener (both on 127.0.0.1 here). Discovery and the whois are injected.
async function node(t, { key, name, discover, identity, meshOptions = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ponte-mesh-${key}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/index.html'), '<title>Ponte</title>');
  const tls = await certificates(root);
  const { desktop, calls } = fakeDesktop(name);
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKENS[key], env: {}, nativeTls: { cert: tls.cert, key: tls.key }, caPem: tls.ca,
    desktop, audio: { close: async () => {} }, tailnetIdentity: identity,
    meshOptions: { name, enabled: true, discover, pollInterval: 40, ...meshOptions },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => app.nativeServer.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(close);
  const httpPort = app.server.address().port, nativePort = app.nativeServer.address().port;
  // The owner's own client: loopback HTTP with the owner token.
  const local = async (url, { method = 'GET', body, token = TOKENS[key], signal } = {}) => {
    const response = await fetch(`http://127.0.0.1:${httpPort}${url}`, { method, signal, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return response;
  };
  // Another node talking to this one over TLS, pinned to this node's CA.
  const remote = (url, { method = 'GET', body, token, localAddress, ca = tls.ca } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: '127.0.0.1', port: nativePort, path: url, method, ca, agent: false, localAddress,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(payload);
  });
  return { app, mesh: app.mesh, calls, local, remote, close, nativePort, httpPort, tls, dataDir: app.dataDir, name };
}

const owner = { available: true, ready: Promise.resolve(), ownerUserId: 1, authorize: async address => address === '127.0.0.1' };
const json = async response => ({ status: response.status, body: await response.json() });
async function until(check, what, timeout = 4000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function twoNodes(t, options = {}) {
  let a, b;
  a = await node(t, { key: 'a', name: 'pc-teste', identity: options.identityA || owner, discover: async () => [{ ip: '127.0.0.1', port: b.nativePort }] });
  b = await node(t, { key: 'b', name: 'notebook-teste', identity: options.identityB || owner, discover: async () => [{ ip: '127.0.0.1', port: a.nativePort }], meshOptions: options.meshB });
  return { a, b };
}

async function pairAtoB(a, b) {
  const asked = await json(await a.local('/api/mesh/pair', { method: 'POST', body: { peer: 'notebook-teste' } }));
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'pending');
  assert.match(asked.body.code, /^\d{6}$/);
  const approved = await json(await b.local('/api/action', { method: 'POST', body: { type: 'mesh.approve', code: asked.body.code } }));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await until(async () => (await json(await a.local('/api/mesh'))).body.peers.find(peer => peer.id === b.mesh.id && peer.paired), 'A to hold the link');
  return asked.body.code;
}

test('identity: a stable random id and the given name in node.json, private', async t => {
  const { a } = await twoNodes(t);
  const saved = JSON.parse(await readFile(path.join(a.dataDir, 'node.json'), 'utf8'));
  assert.match(saved.id, /^[a-f0-9]{16}$/);
  assert.deepEqual(saved, { id: a.mesh.id, name: 'pc-teste' });
  assert.equal((await stat(path.join(a.dataDir, 'node.json'))).mode & 0o777, 0o600);
  const hello = await a.remote('/api/mesh/hello');
  assert.equal(hello.status, 200);
  assert.deepEqual(Object.keys(hello.json).sort(), ['caPem', 'name', 'nodeId', 'nodeName', 'os', 'version']);
  assert.equal(hello.json.name, 'Ponte'); assert.equal(hello.json.nodeId, a.mesh.id); assert.equal(hello.json.caPem, a.tls.ca);
  const again = await createMesh({ dataDir: a.dataDir, enabled: false, env: {} });
  assert.equal(again.id, a.mesh.id, 'the id survives a restart');
});

test('pair, approve on the target, then relay state, an action and the MJPEG stream through the home node', async t => {
  const { a, b } = await twoNodes(t);
  const found = await json(await a.local('/api/mesh'));
  assert.equal(found.body.self.name, 'pc-teste');
  assert.deepEqual(found.body.peers.map(peer => [peer.name, peer.online, peer.paired]), [['notebook-teste', true, false]]);
  // Nothing approves itself: the request waits on B with the code A shows.
  const asked = await json(await a.local('/api/mesh/pair', { method: 'POST', body: { peer: 'notebook-teste' } }));
  const pending = await json(await b.local('/api/mesh'));
  assert.deepEqual(pending.body.requests.map(item => [item.name, item.code, item.ip]), [['pc-teste', asked.body.code, '127.0.0.1']]);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await json(await a.local('/api/mesh'))).body.peers[0].pairing.status, 'pending');
  assert.equal((await json(await a.local('/api/mesh'))).body.peers[0].pairing.code, asked.body.code);
  assert.equal((await b.local('/api/mesh/approve', { method: 'POST', body: { code: '000000' === asked.body.code ? '111111' : '000000' } })).status, 404);
  assert.equal((await b.local('/api/mesh/approve', { method: 'POST', body: { code: asked.body.code } })).status, 200);
  await until(async () => (await json(await a.local('/api/mesh'))).body.peers.find(peer => peer.paired), 'the link');

  // What each side keeps: A the token and B's CA, B only a hash bound to A.
  const linkFile = path.join(a.dataDir, 'mesh.json'), grantFile = path.join(b.dataDir, 'mesh.json');
  assert.equal((await stat(linkFile)).mode & 0o777, 0o600);
  assert.equal((await stat(grantFile)).mode & 0o777, 0o600);
  const link = JSON.parse(await readFile(linkFile, 'utf8')).peers[0];
  assert.equal(link.peerId, b.mesh.id); assert.equal(link.caPem, b.tls.ca); assert.equal(link.ip, '127.0.0.1'); assert.equal(link.port, b.nativePort);
  const grants = await readFile(grantFile, 'utf8');
  assert.equal(grants.includes(link.token), false, 'B never stores the peer token itself');
  assert.equal(JSON.parse(grants).grants[0].nodeId, a.mesh.id);

  // Relayed state: B's desktop, A's version and mesh, no MAC for the phone's proxy.
  const state = await json(await a.local(`/api/state?node=${b.mesh.id}`));
  assert.equal(state.status, 200);
  assert.equal(state.body.hostname, 'notebook-teste');
  assert.equal(state.body.node.id, b.mesh.id); assert.equal(state.body.node.name, 'notebook-teste');
  assert.equal(state.body.mesh.self.id, a.mesh.id); assert.equal(state.body.mesh.target, b.mesh.id);
  assert.equal(JSON.stringify(state.body).includes('aa:bb:cc:dd:ee:ff'), false);
  const home = await json(await a.local('/api/state'));
  assert.equal(home.body.hostname, 'pc-teste');
  assert.equal(home.body.wakeOnLan.mac, 'aa:bb:cc:dd:ee:ff', 'the home node itself still reports its MAC');

  // A relayed action runs on B's desktop only.
  const before = a.calls.length;
  const action = await a.local(`/api/action?node=${b.mesh.id}`, { method: 'POST', body: { type: 'workspace.focus', id: 3 } });
  assert.equal(action.status, 200, await action.clone().text());
  const focused = call => call[0] === 'hyprctl' && call.join(' ').includes('workspace = "3"');
  assert.ok(b.calls.some(focused), JSON.stringify(b.calls.slice(-3)));
  assert.equal(a.calls.slice(before).some(focused), false);

  // The MJPEG stream flows through, frame by frame.
  const controller = new AbortController();
  const stream = await a.local(`/api/stream?node=${b.mesh.id}&monitor=DP-1&fps=10&scale=0.5`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /^multipart\/x-mixed-replace/);
  const reader = stream.body.getReader();
  let seen = Buffer.alloc(0);
  while (seen.indexOf(Buffer.from([0xff, 0xd8])) < 0) { const { value, done } = await reader.read(); if (done) break; seen = Buffer.concat([seen, Buffer.from(value)]); }
  assert.ok(seen.indexOf(Buffer.from([0xff, 0xd8])) >= 0, 'a JPEG frame arrived through the relay');
  controller.abort();
  assert.ok(b.calls.some(call => call[0] === 'grim'), 'B captured the frame');

  // Errors from B keep their meaning; node= equal to self stays local.
  assert.equal((await a.local(`/api/nothing?node=${b.mesh.id}`)).status, 404);
  assert.equal((await json(await a.local(`/api/state?node=${a.mesh.id}`))).body.hostname, 'pc-teste');
  assert.equal((await a.local('/api/state?node=0123456789abcdef')).status, 404, 'an unknown node');
  assert.equal((await a.local(`/api/state?node=${b.mesh.id}&node=${b.mesh.id}`)).status, 400);
});

test('the peer token: controls like the owner, but never manages pairings, never chains, never from another address', async t => {
  const { a, b } = await twoNodes(t);
  await pairAtoB(a, b);
  const token = JSON.parse(await readFile(path.join(a.dataDir, 'mesh.json'), 'utf8')).peers[0].token;
  const direct = await b.remote('/api/state', { token });
  assert.equal(direct.status, 200);
  assert.equal(direct.json.hostname, 'notebook-teste');
  assert.equal(direct.json.mesh, undefined, 'a peer does not see who else is paired');
  assert.equal((await b.remote('/api/state', { token, localAddress: '127.0.0.2' })).json.errorCode, 'MESH_PEER_ADDRESS');
  assert.equal((await b.remote('/api/mesh', { token })).json.errorCode, 'MESH_OWNER_ONLY');
  for (const type of ['mesh.approve', 'mesh.deny', 'mesh.revoke', 'mesh.pair']) {
    assert.equal((await b.remote('/api/action', { method: 'POST', token, body: { type, code: '123456', peer: 'pc-teste' } })).json.errorCode, 'MESH_OWNER_ONLY', type);
  }
  assert.equal((await b.remote('/api/mesh/approve', { method: 'POST', token, body: { code: '123456' } })).json.errorCode, 'MESH_OWNER_ONLY');
  // Chain A→B→C: B holds a link of its own (to A here), still no relay for a peer.
  const back = await json(await b.local('/api/mesh/pair', { method: 'POST', body: { peer: 'pc-teste' } }));
  await a.local('/api/mesh/approve', { method: 'POST', body: { code: back.body.code } });
  await until(async () => (await json(await b.local('/api/mesh'))).body.peers.find(peer => peer.paired), 'B to hold its own link');
  assert.equal((await json(await b.local(`/api/state?node=${a.mesh.id}`))).body.hostname, 'pc-teste', 'B owner relays fine');
  assert.equal((await b.remote(`/api/state?node=${a.mesh.id}`, { token })).json.errorCode, 'MESH_CHAIN_DENIED');
  // Only on the tailnet listener: the loopback one never takes a peer token.
  assert.equal((await fetch(`http://127.0.0.1:${b.httpPort}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal(b.app.authenticate(token, { ponteNative: true, socket: { remoteAddress: '::ffff:127.0.0.1' } }).kind, 'peer');
  assert.equal(b.app.authenticate(TOKENS.b, {}).kind, 'owner');
  // lastSeen moves with use.
  assert.ok((await json(await b.local('/api/mesh'))).body.controllers.find(item => item.id === a.mesh.id).lastSeen);
});

test('revoking cuts at once and an offline peer is reported, both as clear errors on the home node', async t => {
  const { a, b } = await twoNodes(t);
  await pairAtoB(a, b);
  assert.equal((await a.local(`/api/state?node=${b.mesh.id}`)).status, 200);
  const revoked = await json(await b.local('/api/action', { method: 'POST', body: { type: 'mesh.revoke', peer: 'pc-teste' } }));
  assert.equal(revoked.body.revoked.controller, true);
  const cut = await json(await a.local(`/api/state?node=${b.mesh.id}`));
  assert.equal(cut.status, 403); assert.equal(cut.body.errorCode, 'PEER_REVOKED'); assert.match(cut.body.error, /notebook-teste/);
  assert.equal((await json(await b.local('/api/mesh'))).body.controllers.length, 0);
  assert.equal((await json(await a.local('/api/mesh'))).body.peers[0].paired, false, 'A forgets a link the peer refused');
  // Pair again, then B goes away.
  await pairAtoB(a, b);
  assert.equal((await a.local(`/api/state?node=${b.mesh.id}`)).status, 200);
  await b.close();
  const offline = await json(await a.local(`/api/state?node=${b.mesh.id}`));
  assert.equal(offline.status, 502); assert.equal(offline.body.errorCode, 'PEER_OFFLINE');
  await a.mesh.refresh();
  assert.deepEqual((await json(await a.local('/api/mesh'))).body.peers.map(peer => [peer.name, peer.online, peer.paired]), [['notebook-teste', false, true]]);
  // Forgetting the link on A is also a revoke.
  assert.equal((await a.local('/api/mesh/revoke', { method: 'POST', body: { peer: 'notebook-teste' } })).status, 200);
  assert.equal((await json(await a.local('/api/mesh'))).body.peers.length, 0);
});

test('a CA other than the pinned one is refused', async t => {
  const { a, b } = await twoNodes(t);
  await pairAtoB(a, b);
  // Swap the pinned CA for another node's CA: B's leaf no longer verifies.
  const file = path.join(a.dataDir, 'mesh.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.peers[0].caPem = a.tls.ca;
  await a.close();
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
  const again = await createMesh({ dataDir: a.dataDir, enabled: false, env: {} });
  t.after(() => again.close());
  const res = { headers: {}, headersSent: false, destroyed: false, once() {}, off() {}, writeHead() {}, end() {} };
  const req = { method: 'GET', headers: {}, pipe() {} };
  await assert.rejects(again.relay(req, res, b.mesh.id, '/api/state'), error => error.code === 'PEER_UNTRUSTED');
});

test('denied requests end without a link', async t => {
  const { a, b } = await twoNodes(t);
  const asked = await json(await a.local('/api/action', { method: 'POST', body: { type: 'mesh.pair', peer: b.mesh.id } }));
  assert.equal(asked.body.status, 'pending');
  assert.equal((await b.local('/api/action', { method: 'POST', body: { type: 'mesh.deny', code: asked.body.code } })).status, 200);
  const peer = await until(async () => (await json(await a.local('/api/mesh'))).body.peers.find(item => item.pairing?.status === 'denied'), 'the denial');
  assert.equal(peer.paired, false);
  assert.equal((await a.local(`/api/state?node=${b.mesh.id}`)).status, 404);
  assert.equal((await b.local('/api/action', { method: 'POST', body: { type: 'mesh.approve', code: asked.body.code } })).status, 404, 'a denied code cannot be approved later');
});

test('requests: only the owner\'s untagged devices, at most 5 pending, 10 minutes, secret-bound outcome', async t => {
  const OWNER = 7;
  let whois = { Node: { User: OWNER, Tags: ['tag:server'] } };
  const identity = createTailscaleIdentity({ selfAddress: '100.100.100.1', env: {}, retryInterval: 0, ttl: 0,
    runner: async (_command, args) => JSON.stringify(args[2] === '100.100.100.1' ? { Node: { User: OWNER } } : whois) });
  let clock = Date.now();
  const { b } = await twoNodes(t, { identityB: identity, meshB: { now: () => clock } });
  const ask = (nodeId, secret = 's'.repeat(40)) => b.remote('/api/mesh/requests', { method: 'POST', body: { nodeId, nodeName: 'notebook-teste', secret } });
  assert.equal((await ask('0000000000000001')).json.errorCode, 'MESH_NOT_OWNER', 'a tagged device');
  whois = { Node: { User: OWNER + 1 } };
  assert.equal((await ask('0000000000000001')).json.errorCode, 'MESH_NOT_OWNER', 'another tailnet user');
  whois = { Node: { User: OWNER } };
  assert.equal((await ask('nothex')).json.errorCode, 'MESH_INVALID_REQUEST');
  assert.equal((await ask('0000000000000001', 'short')).json.errorCode, 'MESH_INVALID_REQUEST');
  assert.equal((await ask(b.mesh.id)).json.errorCode, 'MESH_INVALID_REQUEST', 'not from itself');
  const made = [];
  for (let i = 1; i <= 5; i++) { const answer = await ask(`000000000000000${i}`); assert.equal(answer.status, 200); made.push(answer.json); }
  assert.equal(new Set(made.map(item => item.code)).size, 5);
  assert.equal((await ask('0000000000000006')).json.errorCode, 'MESH_TOO_MANY_REQUESTS');
  // Asking again from the same node replaces its own pending request.
  assert.equal((await ask('0000000000000005')).status, 200);
  const status = (id, secret) => b.remote(`/api/mesh/requests/${id}`, { token: secret });
  assert.equal((await status(made[0].id, 's'.repeat(40))).json.status, 'pending');
  assert.equal((await status(made[0].id, 'x'.repeat(40))).status, 404, 'a wrong secret learns nothing');
  assert.equal((await status(made[0].id, 's'.repeat(40))).json.token, undefined);
  // Never over the loopback listener.
  assert.equal((await fetch(`http://127.0.0.1:${b.httpPort}/api/mesh/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  // Approve one: the token comes once, to the secret holder only.
  await b.local('/api/mesh/approve', { method: 'POST', body: { code: made[1].code } });
  const approved = await status(made[1].id, 's'.repeat(40));
  assert.equal(approved.json.status, 'approved'); assert.match(approved.json.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(approved.json.nodeId, b.mesh.id);
  assert.equal((await status(made[1].id, 's'.repeat(40))).status, 404, 'collected once');
  clock += 10 * 60 * 1000 + 1;
  assert.equal((await status(made[0].id, 's'.repeat(40))).status, 404, 'expired after 10 minutes');
  assert.equal((await json(await b.local('/api/mesh'))).body.requests.length, 0);
  assert.equal((await ask('0000000000000009')).status, 200, 'room again after expiry');
});

test('discovery lists online, untagged tailnet peers of the same owner that answer hello', async t => {
  const { b } = await twoNodes(t);
  const status = {
    Self: { HostName: 'pc-teste', UserID: 1 },
    Peer: {
      good: { HostName: 'notebook-teste', Online: true, UserID: 1, TailscaleIPs: ['127.0.0.1', 'fd7a::1'] },
      asleep: { HostName: 'dormindo', Online: false, UserID: 1, TailscaleIPs: ['127.0.0.4'] },
      tagged: { HostName: 'servidor', Online: true, UserID: 1, Tags: ['tag:server'], TailscaleIPs: ['127.0.0.5'] },
      shared: { HostName: 'de-outro', Online: true, UserID: 2, TailscaleIPs: ['127.0.0.3'] },
    },
  };
  const asked = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-mesh-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mesh = await createMesh({
    dataDir: root, env: {}, probePort: b.nativePort,
    runner: async (command, args) => { assert.deepEqual([command, ...args], ['tailscale', 'status', '--json']); return JSON.stringify(status); },
    identity: { authorize: async ip => { asked.push(ip); return ip !== '127.0.0.3'; } },
  });
  t.after(() => mesh.close());
  const listed = await mesh.list();
  assert.equal(listed.self.name, 'pc-teste', 'the tailnet host name');
  assert.deepEqual(listed.peers.map(peer => [peer.id, peer.name, peer.online, peer.paired]), [[b.mesh.id, 'notebook-teste', true, false]]);
  assert.deepEqual(asked.sort(), ['127.0.0.1', '127.0.0.3'], 'offline and tagged peers are not even asked');
  // The /api/state view comes from the cache and never waits.
  const started = performance.now();
  assert.equal(mesh.view().peers.length, 1);
  assert.ok(performance.now() - started < 50);
});

test('./ponte mesh lists, pairs, approves and revokes through the local server', async t => {
  const { a, b } = await twoNodes(t);
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const cli = async (target, args) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ponte-mesh-cli-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const config = path.join(home, 'config.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, dataDir: target.dataDir, http: { host: '127.0.0.1', port: target.httpPort }, trustedHosts: [] }), { mode: 0o600 });
    const env = { HOME: home, PATH: process.env.PATH, PONTE_CONFIG: config, http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
    return run('python3', [path.join(root, 'ponte'), 'mesh', ...args], { env, timeout: 15000 }).catch(error => error);
  };
  const listed = await cli(a, ['list']);
  assert.match(listed.stdout, /This device: pc-teste/);
  assert.match(listed.stdout, /notebook-teste\s+online\s+available/);
  const asked = await cli(a, ['pair', 'notebook-teste', '--no-wait']);
  const code = /Code (\d{6})/.exec(asked.stdout)?.[1];
  assert.ok(code, asked.stdout + asked.stderr);
  assert.match((await cli(b, ['list'])).stdout, new RegExp(`pc-teste \\(127\\.0\\.0\\.1\\) asks to control this device, code ${code}`));
  const wrong = await cli(b, ['approve', code === '000000' ? '111111' : '000000']);
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /No pending request has this code/);
  assert.match((await cli(b, ['approve', code])).stdout, /Approved: pc-teste can now control this device/);
  await until(async () => (await json(await a.local('/api/mesh'))).body.peers.find(peer => peer.paired), 'the link');
  assert.match((await cli(a, ['list'])).stdout, /notebook-teste\s+online\s+paired/);
  const json2 = JSON.parse((await cli(b, ['--json', 'list'])).stdout);
  assert.equal(json2.controllers[0].name, 'pc-teste');
  assert.match((await cli(b, ['revoke', 'pc-teste'])).stdout, /Revoked: pc-teste/);
  const offline = await cli({ dataDir: a.dataDir, httpPort: 9 }, ['list']);
  assert.equal(offline.code, 1); assert.match(offline.stderr, /not answering/);
});

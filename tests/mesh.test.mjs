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
import { connect as connectWs } from '../backend/ws.mjs';
import { parseVideoHeader } from '../backend/rd.mjs';

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
async function node(t, { key, name, discover, identity, meshOptions = {}, rdOptions, notify, appOptions = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ponte-mesh-${key}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public/index.html'), '<title>Ponte</title>');
  const tls = await certificates(root);
  const { desktop, calls } = fakeDesktop(name);
  const app = await createApp({
    rootDir: root, dataDir: path.join(root, 'private'), token: TOKENS[key], env: {}, nativeTls: { cert: tls.cert, key: tls.key }, caPem: tls.ca,
    desktop, audio: { close: async () => {} }, tailnetIdentity: identity,
    meshOptions: { name, enabled: true, discover, pollInterval: 40, ...meshOptions }, rdOptions, notify, ...appOptions,
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
  a = await node(t, { key: 'a', name: 'pc-teste', identity: options.identityA || owner, discover: async () => [{ ip: '127.0.0.1', port: b.nativePort }], meshOptions: options.meshA, appOptions: options.appA });
  b = await node(t, { key: 'b', name: 'notebook-teste', identity: options.identityB || owner, discover: async () => [{ ip: '127.0.0.1', port: a.nativePort }], meshOptions: options.meshB, rdOptions: options.rdB, notify: options.notifyB, appOptions: options.appB });
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
  assert.deepEqual(Object.keys(hello.json).sort(), ['caPem', 'kind', 'name', 'nodeId', 'nodeName', 'os', 'version']);
  assert.ok(['pc', 'notebook', 'server'].includes(hello.json.kind));
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

test('./ponte mesh --json pair prints one JSON document, pending or paired', async t => {
  const { a, b } = await twoNodes(t);
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const cliFor = async target => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ponte-mesh-json-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const config = path.join(home, 'config.json');
    await writeFile(config, JSON.stringify({ schemaVersion: 1, dataDir: target.dataDir, http: { host: '127.0.0.1', port: target.httpPort }, trustedHosts: [] }), { mode: 0o600 });
    const env = { HOME: home, PATH: process.env.PATH, PONTE_CONFIG: config, http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' };
    return args => run('python3', [path.join(root, 'ponte'), 'mesh', ...args], { env, timeout: 15000 }).catch(error => error);
  };
  const onA = await cliFor(a), onB = await cliFor(b);
  // Waiting: the code goes to stderr and stdout carries only the final answer.
  const waiting = onA(['--json', 'pair', 'notebook-teste']);
  const request = await until(async () => (await json(await b.local('/api/mesh'))).body.requests[0], 'the request on B');
  assert.equal((await json(await b.local('/api/action', { method: 'POST', body: { type: 'mesh.approve', code: request.code } }))).status, 200);
  const paired = await waiting;
  assert.equal(paired.code ?? 0, 0, paired.stderr);
  assert.match(paired.stderr, new RegExp(`Code ${request.code}`));
  assert.deepEqual(JSON.parse(paired.stdout), { ok: true, status: 'paired', peer: { id: b.mesh.id, name: 'notebook-teste' } });
  const again = await onA(['--json', 'pair', 'notebook-teste']);
  assert.equal(JSON.parse(again.stdout).status, 'paired');
  // --no-wait, the other way round: the pending answer with its code.
  const pending = await onB(['--json', 'pair', 'pc-teste', '--no-wait']);
  assert.equal(pending.code ?? 0, 0, pending.stderr);
  const asked = JSON.parse(pending.stdout);
  assert.equal(asked.status, 'pending');
  assert.match(asked.code, /^\d{6}$/);
  assert.equal(asked.peer.name, 'pc-teste');
});

test('./ponte ctl --node drives a paired device through the home node, by name or id', async t => {
  const { a, b } = await twoNodes(t);
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const home = await mkdtemp(path.join(os.tmpdir(), 'ponte-ctl-node-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const tokenFile = path.join(home, 'token');
  await writeFile(tokenFile, TOKENS.a, { mode: 0o600 });
  const env = { HOME: home, PATH: process.env.PATH, PONTE_CONFIG: path.join(home, 'missing.json'), PONTE_NODE: process.execPath, LANG: 'C.UTF-8' };
  const ctl = async args => {
    const result = await run('python3', [path.join(root, 'ponte'), 'ctl', '--url', `http://127.0.0.1:${a.httpPort}`, '--token-file', tokenFile, ...args], { env, timeout: 15000 }).catch(error => error);
    return { code: result.code ?? 0, body: JSON.parse(result.stdout) };
  };
  const unpaired = await ctl(['state', '--node', 'notebook-teste']);
  assert.equal(unpaired.code, 2);
  assert.equal(unpaired.body.error.code, 'MESH_PEER_NOT_PAIRED');
  assert.match(unpaired.body.error.message, /ponte mesh pair notebook-teste/);
  assert.match((await ctl(['state', '--node', 'tablet'])).body.error.message, /none is paired yet/);
  await pairAtoB(a, b);

  assert.equal((await ctl(['state', '--node', 'notebook-teste'])).body.data.hostname, 'notebook-teste');
  assert.equal((await ctl(['state', '--node', 'NOTEBOOK-TESTE'])).body.data.node.id, b.mesh.id, 'names match without case');
  assert.equal((await ctl(['state', '--node', b.mesh.id])).body.data.hostname, 'notebook-teste', 'an id needs no lookup');
  assert.equal((await ctl(['state', '--node', 'pc-teste'])).body.data.hostname, 'pc-teste', 'the home node by its own name stays local');
  assert.equal((await ctl(['state'])).body.data.hostname, 'pc-teste');

  const before = a.calls.length;
  assert.deepEqual((await ctl(['volume', 'set', '--value', '0.25', '--node', 'notebook-teste'])).body, { schemaVersion: 1, ok: true, data: { ok: true } });
  assert.ok(b.calls.some(call => call.join(' ') === 'wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.250'), 'the action ran on B');
  assert.equal(a.calls.slice(before).some(call => call[0] === 'wpctl'), false, 'and not on A');

  const missing = await ctl(['state', '--node', 'tablet']);
  assert.equal(missing.code, 2);
  assert.match(missing.body.error.message, /paired: notebook-teste/);
  const health = await ctl(['health', '--node', 'notebook-teste']);
  assert.equal(health.code, 2);
  assert.match(health.body.error.message, /state --node/);
  const byId = await ctl(['volume', 'mute', '--node', b.mesh.id, '--dry-run']);
  assert.equal(byId.body.data.path, `/api/action?node=${b.mesh.id}`);
  const byName = await ctl(['volume', 'mute', '--node', 'notebook-teste', '--dry-run']);
  assert.equal(byName.body.data.path, '/api/action');
  assert.equal(byName.body.data.node, 'notebook-teste', 'a name is resolved only when connected');
});

// A fake screen on B: one keyframe with its SPS every 30 ms, and an input
// device that only records what it was told.
function fakeRd() {
  const input = [];
  const makeCapture = ({ onUnit }) => {
    let timer = null;
    return {
      running: true,
      start(params) { this.params = params; timer = setInterval(() => onUnit({ data: Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]), keyframe: true, sps: { codec: 'avc1.640034', width: 1920, height: 1080 }, params: { ...this.params, fps: 60, kbps: 4000 }, firstAt: performance.now(), lastAt: performance.now() }), 30); },
      restart(params) { this.params = { ...this.params, ...params }; },
      stop() { clearInterval(timer); this.running = false; },
    };
  };
  const createInput = () => ({ setMonitors() {}, start() {}, stop() {}, alive() {}, release() { input.push(['release']); }, key: (code, down) => input.push(['key', code, down]), move() {}, rel() {}, button() {}, wheel() {} });
  const monitors = [{ name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, focused: true }];
  return { input, rdOptions: { makeCapture, createInput, inputMode: 'uinput', exists: async () => true, readMonitors: async () => monitors, clipboard: { watch: () => () => {}, write: async () => {} }, log: { info() {}, error() {} } } };
}

// The owner's browser on A's loopback, reading messages in order.
async function rdClient(port, query) {
  const ws = await connectWs(`ws://127.0.0.1:${port}/api/rd${query}`, { maxMessage: 8 * 1024 * 1024 });
  const inbox = [], waiters = [];
  ws.on('message', (data, binary) => { inbox.push(binary ? { video: parseVideoHeader(data) } : JSON.parse(data)); waiters.splice(0).forEach(wake => wake()); });
  ws.on('close', () => waiters.splice(0).forEach(wake => wake()));
  const next = async (match, what) => {
    const started = Date.now();
    for (;;) {
      const index = inbox.findIndex(match);
      if (index >= 0) return inbox.splice(index, 1)[0];
      if (ws.readyState !== 'open' || Date.now() - started > 4000) throw new Error(`no ${what}: ${JSON.stringify(inbox.slice(0, 3))}`);
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 100); });
    }
  };
  return { ws, next };
}

test('rd relay: the owner on A drives B through /api/rd?node=, B sees a peer and says so; chains, strangers and dead links are refused', async t => {
  const b1 = fakeRd(), notices = [];
  const { a, b } = await twoNodes(t, { rdB: b1.rdOptions, notifyB: text => notices.push(text) });
  const offline = await rdClient(a.httpPort, `?node=${b.mesh.id}`);
  offline.ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKENS.a }));
  assert.equal((await offline.next(m => m.t === 'error', 'error')).code, 'MESH_PEER_NOT_FOUND');
  await pairAtoB(a, b);

  const client = await rdClient(a.httpPort, `?node=${b.mesh.id}&monitor=DP-1`);
  client.ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKENS.a, maxFps: 60 }));
  client.ws.send(JSON.stringify({ t: 'key', code: 'KeyA', down: true }));
  const ready = await client.next(m => m.t === 'ready', 'ready');
  assert.equal(ready.node.id, b.mesh.id);
  assert.equal(ready.node.name, 'notebook-teste');
  assert.equal(ready.monitor, 'DP-1');
  const frame = await client.next(m => m.video, 'video');
  assert.equal(frame.video.keyframe, true);
  client.ws.send(JSON.stringify({ t: 'key', code: 'KeyA', down: false }));
  client.ws.send(JSON.stringify({ t: 'ping', c: 1 }));
  assert.equal((await client.next(m => m.t === 'pong', 'pong')).c, 1);
  assert.deepEqual(b1.input.filter(item => item[0] === 'key'), [['key', 'KeyA', true], ['key', 'KeyA', false]], 'input sent before and after ready reaches B in order');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /pc-teste/);
  client.ws.close();

  // A peer token is never relayed further, and the owner token of B means nothing on A.
  const peerToken = a.mesh.connection(b.mesh.id).token;
  const chain = await connectWs(`wss://127.0.0.1:${b.nativePort}/api/rd?node=${a.mesh.id}`, { ca: b.tls.ca });
  const chainReply = new Promise(resolve => chain.once('message', data => resolve(JSON.parse(data))));
  chain.send(JSON.stringify({ t: 'hello', v: 1, token: peerToken }));
  assert.equal((await chainReply).code, 'MESH_CHAIN_DENIED');
  const stranger = await rdClient(a.httpPort, `?node=${b.mesh.id}`);
  stranger.ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKENS.b }));
  assert.equal((await stranger.next(m => m.t === 'error', 'error')).code, 'PAIRING_REQUIRED');

  // B revokes: A's next attempt says so and forgets the link.
  const revoked = await json(await b.local('/api/action', { method: 'POST', body: { type: 'mesh.revoke', peer: 'pc-teste' } }));
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const late = await rdClient(a.httpPort, `?node=${b.mesh.id}`);
  late.ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKENS.a }));
  assert.equal((await late.next(m => m.t === 'error', 'error')).code, 'PEER_REVOKED');
  assert.equal(a.mesh.isPeer(b.mesh.id), false);
});

// The device list (ADR 0002) on two real nodes: the fleet is a stub here (the
// real one would read this machine's tailnet and ~/.ssh/config).
test('devices: the home node lists itself and its paired node with kind and routes; owner only, never relayed', async t => {
  const fleet = { overview: async () => ({ tailnet: { state: 'Running' }, machines: [] }) };
  const app = { fleet, devicesOptions: { adb: false } };
  const { a, b } = await twoNodes(t, { meshA: { kind: 'pc' }, meshB: { kind: 'notebook' }, appA: app, appB: app });
  assert.equal((await b.remote('/api/mesh/hello')).json.kind, 'notebook');
  const before = await json(await a.local('/api/devices?deep=1'));
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.v, 1);
  assert.deepEqual(before.body.devices.map(item => [item.name, item.kind, item.routes[0].state]), [['pc-teste', 'pc', 'self'], ['notebook-teste', 'notebook', 'available']]);
  assert.deepEqual(before.body.devices[1].can.pair, { ok: true, via: 'ponte' });
  await pairAtoB(a, b);
  const listing = await json(await a.local('/api/action', { method: 'POST', body: { type: 'devices.list', deep: true } }));
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const notebook = listing.body.devices.find(item => item.id === b.mesh.id);
  assert.equal(notebook.status, 'online');
  assert.deepEqual(notebook.can.control, { ok: true, via: 'ponte' });
  // B sees who controls it.
  const seen = await json(await b.local('/api/devices'));
  assert.deepEqual(seen.body.devices.find(item => item.id === a.mesh.id).routes[0].controlsMe, true);
  // Old formats do not change: /api/mesh peers carry no kind or address.
  const mesh = await json(await a.local('/api/mesh'));
  for (const field of ['kind', 'ip']) assert.equal(field in mesh.body.peers[0], false, field);
  assert.equal('kind' in mesh.body.self, false);
  // Never relayed, never for a peer.
  assert.equal((await json(await a.local(`/api/devices?node=${b.mesh.id}`))).body.errorCode, 'MESH_INVALID_REQUEST');
  assert.equal((await json(await a.local(`/api/action?node=${b.mesh.id}`, { method: 'POST', body: { type: 'devices.list' } }))).body.errorCode, 'MESH_OWNER_ONLY');
  const token = JSON.parse(await readFile(path.join(a.dataDir, 'mesh.json'), 'utf8')).peers[0].token;
  assert.equal((await b.remote('/api/devices', { token })).json.errorCode, 'MESH_OWNER_ONLY');
  assert.equal((await b.remote('/api/action', { method: 'POST', token, body: { type: 'devices.list' } })).json.errorCode, 'MESH_OWNER_ONLY');
});

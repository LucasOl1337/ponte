import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { isIPv4 } from 'node:net';
import { constants } from 'node:fs';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { ApiError, runCommand } from './process.mjs';
import { normalizePeerAddress } from './tailscale.mjs';

// The mesh: every Omarchy node runs this same server. A node the owner is
// holding (the "home" node: the PC for the phone, 127.0.0.1 for a desktop
// browser) keeps the links to the other nodes and relays requests to them, so
// a client never has to trust another node's private CA or hold its key.
//
// Pairing is explicit and approved on the target: A asks B, B shows a 6-digit
// code, the owner approves on B itself, and A collects a peer token that B
// keeps only as a hash bound to A's node id and tailnet address. A pins B's CA
// on first contact (the tailnet already vouches that 100.x is that machine).

const ID = /^[a-f0-9]{16}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const CODE = /^\d{6}$/;
const PEM = /^-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/;
export const REQUEST_TTL = 10 * 60 * 1000;
export const MAX_PENDING = 5;
const HELLO_TIMEOUT = 1500;
const DISCOVERY_TTL = 30000;
const CONNECT_TIMEOUT = 5000;
const RESPONSE_TIMEOUT = 70000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const FORWARD_REQUEST = ['content-type', 'content-length', 'accept', 'accept-language', 'accept-encoding', 'range', 'if-none-match'];
const FORWARD_RESPONSE = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'vary', 'content-range',
  'accept-ranges', 'content-disposition', 'x-live-max-fps', 'retry-after', 'content-language'];
const CERTIFICATE_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|UNABLE_TO_GET_ISSUER|SIGNATURE/;

const sha256 = value => createHash('sha256').update(value).digest();
const cleanName = (value, fallback = 'Ponte') => {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 64) : '';
  return text || fallback;
};
const cleanOs = value => (typeof value === 'string' ? value.replace(/[^\w .-]/g, '').slice(0, 24) : '') || 'linux';
const isTailnetOrLoopback = ip => isIPv4(ip);

async function writePrivateJson(file, value) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function readPrivateJson(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077)) throw new Error(`${path.basename(file)} must be a private regular file (0600).`);
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

// One JSON request to a node over TLS. `caPem` pins the peer's CA; without it
// (only for the public hello) the certificate is not verified at all.
function tlsJson({ ip, port, caPem, method = 'GET', target, token, body, timeout = CONNECT_TIMEOUT, maxBytes = 64 * 1024, agent = false }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Host: `${ip}:${port}`, Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const request = https.request({ host: ip, port, method, path: target, headers, agent,
      ...(caPem ? { ca: caPem } : { rejectUnauthorized: false }) }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxBytes) request.destroy(new Error('response too large')); else chunks.push(chunk); });
      response.on('end', () => {
        clearTimeout(timer);
        let value = null;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: response.statusCode, body: value });
      });
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeout);
    request.on('error', error => { clearTimeout(timer); reject(error); });
    request.end(payload);
  });
}

const peerFailure = (error, name) => new ApiError(502, CERTIFICATE_ERRORS.test(String(error?.code || '')) ? 'PEER_UNTRUSTED' : 'PEER_OFFLINE', { name });

export async function createMesh({
  dataDir, env = process.env, runner = runCommand, identity, version = 'dev', caPem = null, selfPort = null,
  probePort = null, name = null, discover = null, enabled = true, pollInterval = 2000, now = () => Date.now(),
} = {}) {
  const nodeFile = path.join(dataDir, 'node.json');
  const meshFile = path.join(dataDir, 'mesh.json');
  const binary = env.PONTE_TAILSCALE_BIN || 'tailscale';
  const port = probePort || Number(env.PONTE_MESH_PORT) || selfPort || 8788;
  const selfOs = cleanOs(env.PONTE_NODE_OS || process.platform);

  // Identity: a random id that never changes and the tailnet host name.
  let node = await readPrivateJson(nodeFile).catch(() => null);
  if (!node || !ID.test(node.id)) node = { id: randomBytes(8).toString('hex'), name: cleanName(name || os.hostname()) };
  if (name) node.name = cleanName(name);
  await writePrivateJson(nodeFile, { id: node.id, name: node.name });

  // Links I hold (peers I control) and grants I gave (nodes that control me).
  const peers = new Map();
  const grants = new Map();
  const stored = await readPrivateJson(meshFile).catch(() => null);
  for (const item of Array.isArray(stored?.peers) ? stored.peers : []) {
    if (ID.test(item?.peerId) && isTailnetOrLoopback(item.ip) && Number.isInteger(item.port) && typeof item.token === 'string' && PEM.test(item.caPem || '')) {
      peers.set(item.peerId, { peerId: item.peerId, name: cleanName(item.name), ip: item.ip, port: item.port, caPem: item.caPem, token: item.token, os: cleanOs(item.os), version: String(item.version || ''), pairedAt: item.pairedAt || null });
    }
  }
  for (const item of Array.isArray(stored?.grants) ? stored.grants : []) {
    if (ID.test(item?.nodeId) && isTailnetOrLoopback(item.ip) && /^[a-f0-9]{64}$/.test(item.tokenHash || '')) {
      grants.set(item.nodeId, { nodeId: item.nodeId, name: cleanName(item.name), ip: item.ip, tokenHash: item.tokenHash, approvedAt: item.approvedAt || null, lastSeen: item.lastSeen || null });
    }
  }

  let saving = Promise.resolve();
  let seenTimer = null;
  function save() {
    const snapshot = {
      schemaVersion: 1,
      peers: [...peers.values()],
      grants: [...grants.values()],
    };
    saving = saving.catch(() => {}).then(() => writePrivateJson(meshFile, snapshot));
    return saving;
  }
  // lastSeen changes on every request of a peer; it is written at most once a minute.
  function touch(grant) {
    grant.lastSeen = new Date(now()).toISOString();
    if (seenTimer) return;
    seenTimer = setTimeout(() => { seenTimer = null; save().catch(() => {}); }, 60000);
    seenTimer.unref?.();
  }

  // ---------------------------------------------------------------- discovery
  const discovered = new Map();
  let discoveredAt = 0;
  let discovering = null;

  async function hello(ip, probe = port) {
    const { status, body } = await tlsJson({ ip, port: probe, target: '/api/mesh/hello', timeout: HELLO_TIMEOUT });
    if (status !== 200 || body?.name !== 'Ponte' || !ID.test(body.nodeId || '') || !PEM.test(body.caPem || '')) throw new Error('not a Ponte node');
    return { id: body.nodeId, name: cleanName(body.nodeName), version: String(body.version || '').slice(0, 40), os: cleanOs(body.os), caPem: body.caPem, ip, port: probe };
  }

  // Online tailnet peers without tags, owned by the owner of this node. The
  // owner check is the same whois as the phone's auto-pairing.
  async function tailnetCandidates() {
    const status = JSON.parse(await runner(binary, ['status', '--json'], { env, timeout: 2500, maxBuffer: 4 * 1024 * 1024 }));
    const host = cleanName(status?.Self?.HostName, '');
    if (host && !name && host !== node.name) { node.name = host; writePrivateJson(nodeFile, { id: node.id, name: node.name }).catch(() => {}); }
    const candidates = [];
    for (const peer of Object.values(status?.Peer || {})) {
      if (!peer?.Online || (Array.isArray(peer.Tags) && peer.Tags.length)) continue;
      const ip = (peer.TailscaleIPs || []).find(address => isIPv4(address));
      if (!ip) continue;
      if (identity && !await (identity.sameOwner || identity.authorize)(ip).catch(() => false)) continue;
      candidates.push({ ip, port });
    }
    return candidates;
  }

  function refresh() {
    if (!enabled) return Promise.resolve();
    if (discovering) return discovering;
    discovering = (async () => {
      let candidates = [];
      try { candidates = discover ? await discover() : await tailnetCandidates(); } catch { candidates = []; }
      const found = await Promise.all(candidates.map(item => hello(item.ip, item.port || port).catch(() => null)));
      discovered.clear();
      for (const item of found) if (item && item.id !== node.id) discovered.set(item.id, item);
      // A paired node that answers from a new address keeps its pinned CA.
      let moved = false;
      for (const item of discovered.values()) {
        const peer = peers.get(item.id);
        if (peer && (peer.ip !== item.ip || peer.port !== item.port)) { peer.ip = item.ip; peer.port = item.port; dropAgent(item.id); moved = true; }
        if (peer) { peer.name = item.name; peer.os = item.os; peer.version = item.version; }
      }
      if (moved) await save().catch(() => {});
      discoveredAt = now();
    })().finally(() => { discovering = null; });
    return discovering;
  }
  // The cached view never waits: a stale cache is renewed in the background.
  function kick() { if (enabled && now() - discoveredAt > DISCOVERY_TTL) refresh().catch(() => {}); }

  // ------------------------------------------------------ requests to me (B)
  const requests = new Map();
  function purge() {
    for (const [id, entry] of requests) if (entry.expiresAt <= now()) requests.delete(id);
  }
  function uniqueCode() {
    for (;;) {
      const code = String(randomInt(0, 1000000)).padStart(6, '0');
      if (![...requests.values()].some(entry => entry.code === code)) return code;
    }
  }

  async function createRequest(remoteAddress, body) {
    const address = normalizePeerAddress(remoteAddress);
    if (!address || !identity || !await (identity.sameOwner || identity.authorize)(address).catch(() => false)) throw new ApiError(403, 'MESH_NOT_OWNER');
    if (!body || typeof body !== 'object' || !ID.test(body.nodeId || '') || !SECRET.test(body.secret || '') || body.nodeId === node.id) throw new ApiError(400, 'MESH_INVALID_REQUEST');
    purge();
    for (const [id, entry] of requests) if (entry.nodeId === body.nodeId && entry.status === 'pending') requests.delete(id);
    if ([...requests.values()].filter(entry => entry.status === 'pending').length >= MAX_PENDING) throw new ApiError(429, 'MESH_TOO_MANY_REQUESTS');
    const entry = {
      id: randomBytes(8).toString('hex'), code: uniqueCode(), nodeId: body.nodeId, name: cleanName(body.nodeName),
      ip: address, secretHash: sha256(body.secret), status: 'pending', expiresAt: now() + REQUEST_TTL, token: null,
    };
    requests.set(entry.id, entry);
    return { id: entry.id, code: entry.code, expiresAt: entry.expiresAt, nodeId: node.id, nodeName: node.name };
  }

  function requestStatus(remoteAddress, id, secret) {
    purge();
    const entry = requests.get(id);
    const address = normalizePeerAddress(remoteAddress);
    const candidate = sha256(typeof secret === 'string' ? secret : '');
    if (!entry || entry.ip !== address || !timingSafeEqual(candidate, entry.secretHash)) throw new ApiError(404, 'MESH_REQUEST_NOT_FOUND');
    if (entry.status === 'pending') return { status: 'pending', expiresAt: entry.expiresAt };
    requests.delete(id);
    if (entry.status === 'denied') return { status: 'denied' };
    return { status: 'approved', token: entry.token, nodeId: node.id, nodeName: node.name };
  }

  function byCode(code) {
    purge();
    const value = String(code ?? '').trim();
    const entry = CODE.test(value) ? [...requests.values()].find(item => item.code === value && item.status === 'pending') : null;
    if (!entry) throw new ApiError(404, 'MESH_CODE_NOT_FOUND');
    return entry;
  }

  async function approve(code) {
    const entry = byCode(code);
    const token = randomBytes(32).toString('base64url');
    grants.set(entry.nodeId, { nodeId: entry.nodeId, name: entry.name, ip: entry.ip, tokenHash: sha256(token).toString('hex'), approvedAt: new Date(now()).toISOString(), lastSeen: null });
    await save();
    entry.status = 'approved'; entry.token = token;
    return { ok: true, approved: { nodeId: entry.nodeId, name: entry.name } };
  }

  function deny(code) {
    const entry = byCode(code);
    entry.status = 'denied';
    return { ok: true, denied: { nodeId: entry.nodeId, name: entry.name } };
  }

  // Accepts a peer token (never the owner's) and returns the grant. The token
  // only works from the address it was approved for.
  function authorizePeer(token, remoteAddress) {
    if (typeof token !== 'string' || !token || !grants.size) return null;
    const hash = sha256(token);
    let match = null;
    for (const grant of grants.values()) if (timingSafeEqual(hash, Buffer.from(grant.tokenHash, 'hex'))) match = grant;
    if (!match) return null;
    if (normalizePeerAddress(remoteAddress) !== match.ip) throw new ApiError(403, 'MESH_PEER_ADDRESS');
    touch(match);
    return { nodeId: match.nodeId, name: match.name, ip: match.ip };
  }

  // ------------------------------------------------- my requests to others (A)
  const outgoing = new Map();
  function resolvePeer(value, pool) {
    const text = String(value ?? '').trim();
    if (!text) throw new ApiError(404, 'MESH_PEER_NOT_FOUND');
    if (ID.test(text) && pool.some(item => item.id === text)) return pool.find(item => item.id === text);
    const named = pool.filter(item => item.name.toLowerCase() === text.toLowerCase());
    if (named.length > 1) throw new ApiError(409, 'MESH_PEER_AMBIGUOUS');
    if (!named.length) throw new ApiError(404, 'MESH_PEER_NOT_FOUND');
    return named[0];
  }

  async function pair(value) {
    if (!discovered.size || !resolveSafe(value, [...discovered.values()])) await refresh();
    const target = resolvePeer(value, [...discovered.values()]);
    if (peers.has(target.id)) return { ok: true, status: 'paired', peer: { id: target.id, name: target.name } };
    const current = outgoing.get(target.id);
    if (current?.status === 'pending' && current.expiresAt > now()) return { ok: true, status: 'pending', code: current.code, peer: { id: target.id, name: target.name } };
    // Pin the CA the node presents now (trust on first use over the tailnet).
    let fresh;
    try { fresh = await hello(target.ip, target.port); } catch (error) { throw peerFailure(error, target.name); }
    if (fresh.id !== target.id) throw new ApiError(404, 'MESH_PEER_NOT_FOUND');
    const secret = randomBytes(32).toString('base64url');
    let answer;
    try {
      answer = await tlsJson({ ip: fresh.ip, port: fresh.port, caPem: fresh.caPem, method: 'POST', target: '/api/mesh/requests', body: { nodeId: node.id, nodeName: node.name, secret } });
    } catch (error) { throw peerFailure(error, fresh.name); }
    if (answer.status !== 200 || !CODE.test(answer.body?.code || '') || !ID.test(answer.body?.id || '')) {
      const code = typeof answer.body?.errorCode === 'string' && answer.body.errorCode.startsWith('MESH_') ? answer.body.errorCode : 'MESH_INVALID_REQUEST';
      throw new ApiError(answer.status >= 400 && answer.status < 500 ? answer.status : 502, code);
    }
    const entry = { ...fresh, secret, requestId: answer.body.id, code: answer.body.code, status: 'pending', expiresAt: now() + REQUEST_TTL, timer: null };
    outgoing.set(fresh.id, entry);
    schedule(entry);
    return { ok: true, status: 'pending', code: entry.code, peer: { id: fresh.id, name: fresh.name } };
  }
  function resolveSafe(value, pool) { try { return resolvePeer(value, pool); } catch { return null; } }

  function schedule(entry) {
    clearTimeout(entry.timer);
    if (closed) return;
    entry.timer = setTimeout(() => poll(entry).catch(() => {}), pollInterval);
    entry.timer.unref?.();
  }
  // Settled outcomes stay visible for a minute so the page that asked sees them.
  function settle(entry, status) {
    entry.status = status; entry.secret = null;
    const timer = setTimeout(() => { if (outgoing.get(entry.id) === entry) outgoing.delete(entry.id); }, 60000);
    timer.unref?.();
  }
  async function poll(entry) {
    if (outgoing.get(entry.id) !== entry || entry.status !== 'pending') return;
    if (entry.expiresAt <= now()) { settle(entry, 'expired'); return; }
    let answer;
    try {
      answer = await tlsJson({ ip: entry.ip, port: entry.port, caPem: entry.caPem, target: `/api/mesh/requests/${entry.requestId}`, token: entry.secret });
    } catch { schedule(entry); return; }
    if (outgoing.get(entry.id) !== entry) return;
    if (answer.status === 404) { settle(entry, 'expired'); return; }
    const result = answer.body?.status;
    if (answer.status === 200 && result === 'approved' && typeof answer.body.token === 'string' && answer.body.nodeId === entry.id) {
      peers.set(entry.id, { peerId: entry.id, name: entry.name, ip: entry.ip, port: entry.port, caPem: entry.caPem, token: answer.body.token, os: entry.os, version: entry.version, pairedAt: new Date(now()).toISOString() });
      await save();
      settle(entry, 'paired');
      return;
    }
    if (answer.status === 200 && result === 'denied') { settle(entry, 'denied'); return; }
    schedule(entry);
  }

  async function revoke(value) {
    const pool = [
      ...[...peers.values()].map(item => ({ id: item.peerId, name: item.name })),
      ...[...grants.values()].map(item => ({ id: item.nodeId, name: item.name })),
    ];
    const unique = [...new Map(pool.map(item => [item.id, item])).values()];
    const target = resolvePeer(value, unique);
    const removed = { controlled: peers.delete(target.id), controller: grants.delete(target.id) };
    const pending = outgoing.get(target.id);
    if (pending) { clearTimeout(pending.timer); outgoing.delete(target.id); }
    dropAgent(target.id);
    await save();
    return { ok: true, revoked: { id: target.id, name: target.name, ...removed } };
  }

  // ------------------------------------------------------------------ views
  function peerList() {
    const list = new Map();
    for (const item of discovered.values()) list.set(item.id, { id: item.id, name: item.name, os: item.os, version: item.version, online: true, paired: false });
    for (const item of peers.values()) {
      const seen = discovered.get(item.peerId);
      list.set(item.peerId, { id: item.peerId, name: seen?.name || item.name, os: seen?.os || item.os, version: seen?.version || item.version, online: !!seen, paired: true });
    }
    for (const item of outgoing.values()) {
      const entry = list.get(item.id) || { id: item.id, name: item.name, os: item.os, version: item.version, online: discovered.has(item.id), paired: peers.has(item.id) };
      entry.pairing = { status: item.status, ...(item.status === 'pending' ? { code: item.code } : {}) };
      list.set(item.id, entry);
    }
    for (const item of list.values()) item.controlsMe = grants.has(item.id);
    return [...list.values()].sort((a, b) => Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name));
  }
  function requestList() {
    purge();
    return [...requests.values()].filter(item => item.status === 'pending')
      .map(item => ({ id: item.id, code: item.code, nodeId: item.nodeId, name: item.name, ip: item.ip, expiresAt: item.expiresAt }));
  }
  const controllerList = () => [...grants.values()].map(item => ({ id: item.nodeId, name: item.name, ip: item.ip, approvedAt: item.approvedAt, lastSeen: item.lastSeen }));
  const self = () => ({ id: node.id, name: node.name, os: selfOs, version });

  // The light view for /api/state: from the cache, never waiting on the network.
  function view() {
    kick();
    return { self: self(), peers: peerList(), requests: requestList(), controllers: controllerList() };
  }
  // Worth a place in /api/state: discovery runs here or something is linked.
  const active = () => enabled || peers.size > 0 || grants.size > 0 || requestList().length > 0 || outgoing.size > 0;

  async function list({ wait = true } = {}) {
    if (wait && enabled && (!discoveredAt || now() - discoveredAt > DISCOVERY_TTL)) {
      await Promise.race([refresh(), new Promise(resolve => { const timer = setTimeout(resolve, 2500); timer.unref?.(); })]);
    }
    return { self: self(), peers: peerList(), requests: requestList(), controllers: controllerList() };
  }

  function hellobody() {
    return { name: 'Ponte', nodeId: node.id, nodeName: node.name, version, os: selfOs, caPem: caPem ? String(caPem) : null };
  }

  // ------------------------------------------------------------------ relay
  const agents = new Map();
  function agentFor(peer) {
    let agent = agents.get(peer.peerId);
    if (!agent) { agent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, ca: peer.caPem }); agents.set(peer.peerId, agent); }
    return agent;
  }
  function dropAgent(id) { agents.get(id)?.destroy(); agents.delete(id); }

  function connection(peerId) {
    const peer = peers.get(peerId);
    if (!peer) throw new ApiError(404, 'MESH_PEER_NOT_FOUND');
    return { id: peer.peerId, name: peer.name, host: peer.ip, port: peer.port, ca: peer.caPem, token: peer.token };
  }

  // Streams one /api/* request to a paired peer with its peer token. The body
  // and the response flow through (MJPEG and long-poll included); `transform`
  // gets a parsed JSON 200 body instead (the /api/state rewrite).
  function relay(req, res, peerId, target, { transform, retry = true } = {}) {
    const peer = peers.get(peerId);
    if (!peer) return Promise.reject(new ApiError(404, 'MESH_PEER_NOT_FOUND'));
    const headers = { host: `${peer.ip}:${peer.port}`, authorization: `Bearer ${peer.token}` };
    for (const name of FORWARD_REQUEST) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    if (transform) delete headers['accept-encoding'];
    const bodyless = ['GET', 'HEAD', 'DELETE'].includes(req.method) && !req.headers['content-length'] && !req.headers['transfer-encoding'];
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(connectTimer); clearTimeout(responseTimer); error ? reject(error) : resolve(); };
      const upstream = https.request({ host: peer.ip, port: peer.port, method: req.method, path: target, headers, agent: agentFor(peer) });
      const connectTimer = setTimeout(() => upstream.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT);
      const responseTimer = setTimeout(() => upstream.destroy(Object.assign(new Error('response timeout'), { code: 'ETIMEDOUT' })), RESPONSE_TIMEOUT);
      upstream.on('socket', socket => {
        if (upstream.reusedSocket || !socket.connecting) clearTimeout(connectTimer);
        else socket.once('secureConnect', () => clearTimeout(connectTimer));
      });
      const hangUp = () => upstream.destroy();
      res.once('close', hangUp);
      upstream.on('error', error => {
        res.off('close', hangUp);
        if (settled) return;
        if (res.headersSent || res.destroyed) { res.destroy(); finish(); return; }
        // A kept-alive socket the peer closed meanwhile: one fresh try for bodyless requests.
        if (retry && bodyless && upstream.reusedSocket && error.code === 'ECONNRESET') {
          settled = true; clearTimeout(connectTimer); clearTimeout(responseTimer);
          relay(req, res, peerId, target, { transform, retry: false }).then(resolve, reject); return;
        }
        finish(peerFailure(error, peer.name));
      });
      upstream.on('response', async response => {
        clearTimeout(connectTimer); clearTimeout(responseTimer);
        // The peer no longer knows this token: the link is dead, so it is
        // forgotten and the node shows up again as one to ask.
        if (response.statusCode === 401) {
          response.resume();
          if (peers.get(peerId) === peer) { peers.delete(peerId); dropAgent(peerId); save().catch(() => {}); }
          finish(new ApiError(403, 'PEER_REVOKED', { name: peer.name })); return;
        }
        try {
          if (transform && response.statusCode === 200 && /json/.test(String(response.headers['content-type']))) {
            const chunks = []; let size = 0;
            for await (const chunk of response) { size += chunk.length; if (size > MAX_STATE_BYTES) throw new Error('state too large'); chunks.push(chunk); }
            const value = transform(JSON.parse(Buffer.concat(chunks).toString('utf8')), peer);
            const body = Buffer.from(JSON.stringify(value));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
            res.end(body);
          } else {
            const out = {};
            for (const name of FORWARD_RESPONSE) if (response.headers[name] !== undefined) out[name] = response.headers[name];
            res.writeHead(response.statusCode, out);
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            await pipeline(response, res);
          }
          finish();
        } catch (error) {
          if (!res.headersSent) finish(peerFailure(error, peer.name));
          else { res.destroy(); finish(); }
        } finally { res.off('close', hangUp); }
      });
      if (bodyless) upstream.end(); else req.pipe(upstream);
    });
  }

  let closed = false;
  async function close() {
    closed = true;
    for (const entry of outgoing.values()) clearTimeout(entry.timer);
    for (const id of [...agents.keys()]) dropAgent(id);
    if (seenTimer) { clearTimeout(seenTimer); seenTimer = null; await save().catch(() => {}); }
    await saving.catch(() => {});
  }

  return {
    get id() { return node.id; },
    get name() { return node.name; },
    get enabled() { return enabled; },
    hello: hellobody, refresh, view, list, active, createRequest, requestStatus, approve, deny, revoke, pair,
    authorizePeer, relay, connection, isPeer: id => peers.has(id), close,
    // mesh.* actions from /api/action (the phone reaches no /api/mesh route).
    async action(value) {
      if (value.type === 'mesh.pair') return pair(value.peer ?? value.id);
      if (value.type === 'mesh.approve') return approve(value.code);
      if (value.type === 'mesh.deny') return deny(value.code);
      if (value.type === 'mesh.revoke') return revoke(value.peer ?? value.id);
      if (value.type === 'mesh.list') return list();
      throw new ApiError(400, 'MESH_INVALID_REQUEST');
    },
  };
}

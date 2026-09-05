import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, realpath, lstat, open, chmod, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createDesktop } from './backend/desktop.mjs';
import { createAudioStore, MAX_AUDIO_BYTES } from './backend/audio.mjs';
import { ApiError } from './backend/process.mjs';
import { createLiveStreaming } from './backend/live.mjs';
import { defaultPaths, loadSettings, isTailscaleIpv4Bind } from './backend/config.mjs';
import { message, publicErrorParameters, requestLocale } from './backend/i18n.mjs';
export { isTailscaleIpv4Bind } from './backend/config.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const staticTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const inside = (root, child) => child === root || child.startsWith(`${root}${path.sep}`);

async function initializeToken(dataDir, publicDir, suppliedToken) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const actualDir = await realpath(dataDir);
  const actualPublic = await realpath(publicDir).catch(() => path.resolve(publicDir));
  if (inside(actualPublic, actualDir)) throw new Error('Private state must be outside public/.');
  await chmod(actualDir, 0o700);
  const tokenFile = path.join(actualDir, 'token');
  let handle;
  try {
    handle = await open(tokenFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${suppliedToken || randomBytes(32).toString('base64url')}\n`);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await handle?.close(); }
  const tokenStat = await lstat(tokenFile);
  if (!tokenStat.isFile() || tokenStat.size > 256) throw new Error('Invalid token file.');
  await chmod(tokenFile, 0o600);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('Invalid pairing token.');
  return { token, dataDir: actualDir };
}

function authority(value) {
  if (typeof value !== 'string' || value.length > 255 || /[\s/@?#\\]/u.test(value)) return null;
  try {
    const match = value.match(/^(\[[a-f0-9:]+\]|[^:]+)(?::([0-9]{1,5}))?$/i);
    if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return null;
    const parsed = new URL(`http://${value}`);
    if (parsed.pathname !== '/' || !parsed.hostname) return null;
    // Preserve the explicitly supplied port: URL(http://…) would erase :80,
    // which must remain distinct when validating an https browser origin.
    const hostname = parsed.hostname.toLowerCase();
    const port = match[2] ? String(Number(match[2])) : '';
    return { host: hostname + (port ? `:${port}` : ''), hostname, port };
  } catch { return null; }
}

function createRequestGuard(trustedHosts) {
  const trusted = new Set();
  for (const item of trustedHosts) {
    const parsed = authority(item.trim());
    if (!parsed) throw new Error('Trusted hosts must be hostnames, optionally with a port, without a URL scheme.');
    trusted.add(parsed.host);
    if (!parsed.port) trusted.add(`${parsed.hostname}:443`);
  }
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  const allowed = (item) => item && (local.has(item.hostname) || trusted.has(item.host));
  return (req) => {
    const host = authority(req.headers.host);
    if (!allowed(host)) throw new ApiError(403, 'HOST_NOT_ALLOWED');
    if (req.headers.origin !== undefined) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw new ApiError(403, 'ORIGIN_NOT_ALLOWED'); }
      const originHost = authority(origin.host);
      const secure = origin.protocol === 'https:' || (origin.protocol === 'http:' && local.has(originHost?.hostname));
      const sameHost = originHost?.host === host.host || (origin.protocol === 'https:' && `${originHost?.hostname}:443` === host.host);
      if (!secure || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !allowed(originHost) || !sameHost) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');
    }
  };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req, maxBytes, timeout = 15000) {
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > maxBytes)) {
    const error = new ApiError(413, 'PAYLOAD_TOO_LARGE'); error.close = true; throw error;
  }
  return new Promise((resolve, reject) => {
    let size = 0, finished = false;
    const chunks = [];
    const timer = setTimeout(() => fail(new ApiError(408, 'UPLOAD_TIMEOUT')), timeout);
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('aborted', abort); req.off('error', abort); };
    const fail = (error) => { if (finished) return; finished = true; cleanup(); req.pause(); error.close = true; reject(error); };
    const data = (chunk) => { size += chunk.length; if (size > maxBytes) fail(new ApiError(413, 'PAYLOAD_TOO_LARGE')); else chunks.push(chunk); };
    const end = () => { if (finished) return; finished = true; cleanup(); resolve(Buffer.concat(chunks, size)); };
    const abort = () => fail(new ApiError(400, 'UPLOAD_INTERRUPTED'));
    req.on('data', data); req.once('end', end); req.once('aborted', abort); req.once('error', abort);
  });
}

function createLimits() {
  let tokens = 200, last = Date.now(), actions = 0, tail = Promise.resolve(), stopping = false;
  const inFlight = new Map();
  return {
    request() {
      const now = Date.now(); tokens = Math.min(200, tokens + (now - last) * 0.12); last = now;
      if (tokens < 1) throw new ApiError(429, 'RATE_LIMITED');
      tokens--;
    },
    async only(key, limit, callback) {
      if ((inFlight.get(key) || 0) >= limit) throw new ApiError(429, 'OPERATION_BUSY');
      inFlight.set(key, (inFlight.get(key) || 0) + 1);
      try { return await callback(); } finally { inFlight.set(key, inFlight.get(key) - 1); }
    },
    async action(callback) {
      if (stopping) throw new ApiError(503, 'SERVER_RESTARTING');
      if (actions >= 24) throw new ApiError(429, 'ACTION_QUEUE_FULL');
      actions++;
      const result = tail.then(() => {
        if (stopping) throw new ApiError(503, 'SERVER_RESTARTING');
        return callback();
      });
      tail = result.catch(() => {});
      try { return await result; } finally { actions--; }
    },
    stop() { stopping = true; },
    async drain() { await tail; },
  };
}

export async function createApp(options = {}) {
  const rootDir = path.resolve(options.rootDir || projectRoot);
  const publicDir = path.join(rootDir, 'public');
  const env = options.env || process.env;
  const settings = options.settings;
  const initialized = await initializeToken(path.resolve(options.dataDir || settings?.dataDir || env.OMARCHY_REMOTE_DATA || defaultPaths(env).dataDir), publicDir, options.token);
  const tokenBytes = Buffer.from(initialized.token);
  const guard = createRequestGuard(options.trustedHosts || settings?.trustedHosts || (env.OMARCHY_REMOTE_TRUSTED_HOSTS || '').split(',').filter(Boolean));
  const desktop = options.desktop || createDesktop({ env });
  const audio = options.audio || await createAudioStore(initialized.dataDir, { env });
  const limits = createLimits();
  const live = createLiveStreaming(desktop);
  const activeRequests = new Set();
  let shuttingDown = false, closingPromise;

  async function serveFile(res, file, mime) {
    const metadata = await lstat(file);
    if (!metadata.isFile()) throw new ApiError(404, 'FILE_NOT_FOUND');
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': metadata.size, 'Cache-Control': 'no-store' });
    await pipeline(createReadStream(file), res);
  }

  async function staticFile(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!relative || relative.includes('\\') || relative.split('/').some(segment => !segment || segment.startsWith('.')) || !Object.hasOwn(staticTypes, path.extname(relative))) throw new ApiError(404, 'FILE_NOT_FOUND');
    let actual;
    try { actual = await realpath(path.join(publicDir, relative)); } catch { throw new ApiError(404, 'FILE_NOT_FOUND'); }
    const publicActual = await realpath(publicDir);
    if (!inside(publicActual, actual)) throw new ApiError(404, 'FILE_NOT_FOUND');
    if (req.method === 'HEAD') {
      const info = await lstat(actual);
      if (!info.isFile()) throw new ApiError(404, 'FILE_NOT_FOUND');
      res.writeHead(200, { 'Content-Type': staticTypes[path.extname(relative)], 'Content-Length': info.size, 'Cache-Control': 'no-store' }); res.end(); return;
    }
    await serveFile(res, actual, staticTypes[path.extname(relative)]);
  }

  const handleRequest = async (req, res) => {
    const locale = requestLocale(req);
    let finishRequest;
    const pending = new Promise(resolve => { finishRequest = resolve; });
    activeRequests.add(pending);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Language', locale);
    res.setHeader('Vary', 'Accept-Language');
    try {
      if (shuttingDown) throw new ApiError(503, 'SERVER_RESTARTING');
      guard(req); limits.request();
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new ApiError(400, 'INVALID_URL');
      const rawPath = req.url.split('?', 1)[0];
      let pathname;
      try { pathname = decodeURIComponent(rawPath); } catch { throw new ApiError(400, 'INVALID_URL'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '.' || part === '..')) throw new ApiError(404, 'FILE_NOT_FOUND');
      const query = new URL(req.url, 'http://localhost').searchParams;
      // Pairing links may be opened from a different site. Public navigation
      // is allowed; cross-site requests to the private API are still rejected.
      if (pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'CROSS_SITE_NOT_ALLOWED');
      if (pathname === '/api/health' && req.method === 'GET') { json(res, 200, { name: 'Ponte', requiresPairing: true }); return; }
      if (!pathname.startsWith('/api/')) { await staticFile(req, res, pathname); return; }
      const provided = req.headers.authorization;
      const candidate = Buffer.from(typeof provided === 'string' && provided.startsWith('Bearer ') ? provided.slice(7) : '');
      if (candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes)) throw new ApiError(401, 'PAIRING_REQUIRED');
      if (pathname === '/api/state' && req.method === 'GET') {
        json(res, 200, await limits.only('state', 2, () => desktop.getState({ locale }))); return;
      }
      if (pathname === '/api/action' && req.method === 'POST') {
        if (String(req.headers['content-type']).split(';', 1)[0].trim() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED');
        await limits.only('body', 8, async () => {
          const body = await readBody(req, 24 * 1024);
          let value; try { value = JSON.parse(body.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON'); }
          json(res, 200, await limits.action(() => desktop.action(value)));
        }); return;
      }
      if (pathname === '/api/screenshot' && req.method === 'GET') {
        const bytes = await limits.only('screenshot', 1, () => desktop.screenshot(query.get('monitor') ?? undefined));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); res.end(bytes); return;
      }
      if (pathname === '/api/stream' && req.method === 'GET') {
        await live.stream(req, res, query); return;
      }
      if (pathname === '/api/audio' && req.method === 'GET') { json(res, 200, await limits.only('audio-list', 2, () => audio.list())); return; }
      if (pathname === '/api/audio' && req.method === 'POST') {
        const result = await limits.only('audio-write', 1, async () => audio.upload(await readBody(req, MAX_AUDIO_BYTES, 60000), req.headers['content-type']));
        json(res, 201, result); return;
      }
      if (pathname === '/api/audio/stop' && req.method === 'POST') { json(res, 200, await limits.only('play', 1, () => audio.stop())); return; }
      const audioRoute = pathname.match(/^\/api\/audio\/([^/]+)(\/play)?$/);
      if (audioRoute && audioRoute[2] && req.method === 'POST') { json(res, 200, await limits.only('play', 1, () => audio.play(audioRoute[1]))); return; }
      if (audioRoute && !audioRoute[2] && req.method === 'GET') {
        await limits.only('download', 3, async () => {
          const { file, recording } = await audio.get(audioRoute[1]);
          res.setHeader('Content-Disposition', `inline; filename="audio-${recording.id}"`);
          await serveFile(res, file, recording.mime);
        }); return;
      }
      throw new ApiError(404, 'ROUTE_NOT_FOUND');
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (error?.close) res.setHeader('Connection', 'close');
      const status = error instanceof ApiError ? error.status : 500;
      const errorCode = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      const errorParameters = error instanceof ApiError ? publicErrorParameters(errorCode, error.parameters) : {};
      json(res, status, { errorCode, errorParameters, error: message(errorCode, locale, errorParameters) });
    } finally {
      activeRequests.delete(pending); finishRequest();
    }
  };
  const server = http.createServer(handleRequest);
  let nativeTls = options.nativeTls;
  const certFile = settings?.nativeTls?.certFile || env.OMARCHY_REMOTE_TLS_CERT;
  const keyFile = settings?.nativeTls?.keyFile || env.OMARCHY_REMOTE_TLS_KEY;
  if (!nativeTls && (certFile || keyFile)) {
    if (!certFile || !keyFile) throw new Error('Native TLS requires both certificate and key.');
    const [certPath, keyPath, publicPath] = await Promise.all([
      realpath(certFile), realpath(keyFile), realpath(publicDir),
    ]);
    if (inside(publicPath, certPath) || inside(publicPath, keyPath)) throw new Error('TLS files must be outside public/.');
    nativeTls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  }
  // The Android app trusts this PC's dedicated certificate. No public CA,
  // certificate-warning exception or tailnet account login is needed here.
  const nativeServer = nativeTls ? https.createServer({ ...nativeTls, minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, handleRequest) : null;
  const servers = [server, nativeServer].filter(Boolean);
  const sockets = new Set();
  for (const listener of servers) {
    listener.headersTimeout = 12000;
    listener.requestTimeout = 75000;
    listener.keepAliveTimeout = 5000;
    listener.maxHeadersCount = 40;
    listener.maxRequestsPerSocket = 1000;
    listener.maxConnections = 64;
    listener.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }
  async function close() {
    if (closingPromise) return closingPromise;
    shuttingDown = true;
    limits.stop();
    live.close();
    closingPromise = (async () => {
      const closed = Promise.all(servers.map(listener => new Promise(resolve => listener.close(() => resolve()))));
      // Abort unfinished bodies/downloads; their handlers still join the drain.
      // An action already executing finishes before the final release, while
      // queued actions are canceled by limits.stop().
      for (const listener of servers) listener.closeAllConnections();
      // Also terminate connections that have not finished a TLS handshake.
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...activeRequests]);
      await limits.drain();
      await Promise.resolve(desktop.close?.()).catch(() => {});
      await audio.close?.();
      await closed;
    })();
    return closingPromise;
  }
  return { server, nativeServer, close, dataDir: initialized.dataDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = await loadSettings();
  const app = await createApp({ settings });
  const { port, host } = settings.http;
  app.server.listen(port, host, () => console.log(`Ponte listening on ${host}:${port}`));
  let closing = false;
  let nativeRetry;
  if (app.nativeServer) {
    const nativeHost = settings.nativeTls.host;
    if (!isTailscaleIpv4Bind(nativeHost)) {
      throw new Error('The native listener must bind an explicit Tailscale IPv4 address.');
    }
    const nativePort = settings.nativeTls.port;
    if (!Number.isInteger(nativePort) || nativePort < 1 || nativePort > 65535) throw new Error('Invalid native TLS port.');
    const listenNative = () => {
      if (!closing && !app.nativeServer.listening) app.nativeServer.listen(nativePort, nativeHost);
    };
    app.nativeServer.on('listening', () => console.log(`Ponte Android TLS listening on ${nativeHost}:${nativePort}`));
    app.nativeServer.on('error', error => {
      if (!['EADDRNOTAVAIL', 'EADDRINUSE'].includes(error.code)) throw error;
      console.error(`Ponte Android listener waiting: ${error.code}`);
      clearTimeout(nativeRetry);
      if (!closing) { nativeRetry = setTimeout(listenNative, 5000); nativeRetry.unref(); }
    });
    listenNative();
  }
  const shutdown = async () => {
    if (closing) return; closing = true;
    clearTimeout(nativeRetry);
    const force = setTimeout(() => process.exit(1), 15000); force.unref();
    await app.close(); clearTimeout(force); process.exit(0);
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}

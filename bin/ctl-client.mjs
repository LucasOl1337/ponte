import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { loadSettings } from '../backend/config.mjs';
import { message, messages } from '../backend/i18n.mjs';

const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_STREAM = 128 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;
const MAX_TIMEOUT = 120000;

export class CliError extends Error {
  constructor(code, message, exitCode = 1, status) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    if (status !== undefined) this.status = status;
  }
}

const usage = (code, message) => new CliError(code, message, 2);
const invalidResponse = (message, status) => new CliError('INVALID_RESPONSE', message, 6, status);

function origin(value) {
  // Inspect the original authority as well as URL's result: URL normalizes
  // shorthand/octal/hex IPv4, dot paths, backslashes and empty query markers.
  const match = typeof value === 'string' && value.match(/^(https?):\/\/(\[[^\]\s]+\]|[^:/?#\\@\s]+)(?::([0-9]+))?\/?$/i);
  let parsed;
  try { if (match?.[0] === value) parsed = new URL(value); } catch {}
  if (!parsed || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) {
    throw usage('INVALID_URL', 'Use an HTTP(S) origin without credentials, path, query or fragment.');
  }
  if (parsed.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(match[2].toLowerCase())) {
    throw usage('INVALID_URL', 'HTTP is allowed only on literal loopback addresses or localhost. Use HTTPS remotely.');
  }
  return parsed;
}

export { origin as validateOrigin };

function filePath(value, code) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw usage(code, 'A valid file path is required.');
  }
  return path.resolve(value);
}

function milliseconds(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT) {
    throw usage('INVALID_OPTIONS', `${name} must be an integer from 1 to ${MAX_TIMEOUT} milliseconds.`);
  }
  return value;
}

async function readCredential(file, maxBytes, privateToken = false) {
  let handle;
  try {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (privateToken ? constants.O_NOFOLLOW : 0);
    handle = await open(file, flags);
    const valid = info => info.isFile() && info.size <= maxBytes && (!privateToken
      || ((info.mode & 0o7777) === 0o600 && (!process.getuid || info.uid === process.getuid())));
    if (!valid(await handle.stat())) throw new Error();
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes || !valid(await handle.stat())) throw new Error();
    return buffer.subarray(0, size);
  } catch {
    throw usage(privateToken ? 'TOKEN_FILE' : 'CA_FILE', privateToken
      ? 'Token must be a regular, user-owned mode 0600 file, not a symlink, with at most 256 bytes.'
      : 'Cannot read the CA file. Use a regular certificate file of at most 1 MiB.');
  } finally { await handle?.close().catch(() => {}); }
}

function mimeType(response) {
  const value = response.headers['content-type'];
  return typeof value === 'string' && value.length <= 1024 ? value.split(';', 1)[0].trim().toLowerCase() : '';
}
const isJson = type => /^application\/(?:json|[a-z0-9.+-]+\+json)$/.test(type);
const isBinary = type => /^(?:(?:image|audio|video)\/[a-z0-9.+-]+|application\/(?:octet-stream|ogg)|multipart\/x-mixed-replace)$/.test(type);

function httpError(status, data) {
  // Never echo free-form server errors, parameters, HTML, or even arbitrary
  // machine codes: any of these could contain a pairing token. Only the local
  // server's public error vocabulary is trusted for diagnostic text.
  const code = [data?.errorCode, data?.code, data?.error].find(value => typeof value === 'string' && Object.hasOwn(messages, value));
  const unauthorized = status === 401 || status === 403;
  return new CliError(code || (unauthorized ? 'UNAUTHORIZED' : 'HTTP_ERROR'),
    code ? `HTTP ${status}: ${message(code)}` : `Server returned HTTP ${status}.`, unauthorized ? 5 : 6, status);
}

async function errorBody(response) {
  if (!isJson(mimeType(response))) return;
  let size = 0;
  const chunks = [];
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_ERROR) return;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch {}
}

function transportError(error) {
  if (error instanceof CliError) return error;
  const tls = /^(?:ERR_TLS_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(?:VERIFY|GET_ISSUER))/.test(error?.code || '');
  return new CliError(tls ? 'TLS_ERROR' : 'UNAVAILABLE', tls
    ? 'TLS certificate verification failed. Check the server identity and CA file.'
    : 'Could not reach Ponte or the connection was interrupted.', 3);
}

/** No I/O on import, no logging, no redirects, no retries, and no automatic pairing. */
export async function createClient(options = {}, env = process.env) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw usage('INVALID_OPTIONS', 'Client options must be an object.');
  const timeout = milliseconds(options.timeout ?? 15000, 'timeout');
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw usage('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  let settingsPromise;
  const settings = () => settingsPromise ??= loadSettings(env).catch(() => {
    throw usage('CONFIG_ERROR', 'Cannot load Ponte settings. Check the private config or supply --url and --token-file.');
  });
  const explicitUrl = options.url !== undefined;
  const independent = explicitUrl && options.tokenFile !== undefined;
  const endpoint = explicitUrl ? origin(options.url) : await (async () => {
    const { http: { host, port } } = await settings();
    return origin(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  })();
  const configuredToken = options.tokenFile;
  const configuredCa = options.caFile;

  async function request(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw usage('INVALID_REQUEST', 'Request options must be an object.');
    const { method = 'GET', path: route, body, contentType, auth = true, output, durationMs } = input;
    if (typeof method !== 'string' || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw usage('INVALID_REQUEST', 'Unsupported HTTP method.');
    if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[^\x21-\x7e]|[\\#]/.test(route)) {
      throw usage('INVALID_REQUEST', 'Request path must be an absolute local path without a fragment.');
    }
    if (typeof auth !== 'boolean') throw usage('INVALID_REQUEST', 'auth must be a boolean.');
    const destination = output === undefined ? undefined : filePath(output, 'OUTPUT_FILE');
    if (durationMs !== undefined) {
      milliseconds(durationMs, 'durationMs');
      if (!destination) throw usage('INVALID_REQUEST', 'A stream duration requires an output file.');
    }
    let payload;
    if (body !== undefined) {
      try {
        if (Buffer.isBuffer(body)) payload = body;
        else if (typeof body === 'string') payload = Buffer.from(body);
        else if (typeof body === 'object') payload = Buffer.from(JSON.stringify(body));
        else throw new Error();
      } catch { throw usage('INVALID_REQUEST', 'Request body must be a Buffer, string or JSON-serializable object.'); }
      if (payload.length > MAX_RESPONSE) throw usage('INVALID_REQUEST', 'Request body exceeds 32 MiB.');
    }
    const headers = { Accept: destination ? '*/*' : 'application/json', 'Accept-Encoding': 'identity' };
    if (payload !== undefined || contentType !== undefined) {
      const type = contentType ?? (Buffer.isBuffer(body) ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
      if (typeof type !== 'string' || !type || type.length > 1024 || /[^\x20-\x7e]/.test(type)) throw usage('INVALID_REQUEST', 'Invalid request content type.');
      headers['Content-Type'] = type;
    }
    if (payload !== undefined) headers['Content-Length'] = payload.length;

    const controller = new AbortController();
    const durationStop = new Error('Capture interval completed.');
    let failure, req, response, handle, identity, durationTimer, durationReached = false, bytes = 0, success = false;
    const fail = error => { failure ??= error; controller.abort(); };
    const cancel = () => fail(new CliError('CANCELLED', 'Request cancelled.', 130));
    const expires = performance.now() + timeout;
    const timedOut = () => fail(new CliError('TIMEOUT', 'Request deadline exceeded.', 4));
    const deadline = setTimeout(timedOut, timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const check = () => {
      if (performance.now() >= expires) timedOut();
      if (failure) throw failure;
    };
    try {
      check();
      let ca;
      if (endpoint.protocol === 'https:') {
        let caFile = configuredCa;
        if (caFile === undefined && !independent) {
          const tls = (await settings()).nativeTls;
          if (tls && endpoint.origin === origin(`https://${tls.host}:${tls.port}`).origin) caFile = tls.caFile;
        }
        if (caFile !== undefined) ca = await readCredential(filePath(caFile, 'CA_FILE'), 1024 * 1024);
      }
      check();
      if (auth) {
        const tokenFile = filePath(configuredToken ?? path.join((await settings()).dataDir, 'token'), 'TOKEN_FILE');
        const token = (await readCredential(tokenFile, 256, true)).toString('utf8').trim();
        if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw usage('TOKEN_FILE', 'Token file does not contain a valid pairing token.');
        headers.Authorization = `Bearer ${token}`;
      }
      check();
      response = await new Promise((resolve, reject) => {
        const transport = endpoint.protocol === 'https:' ? https : http;
        req = transport.request(endpoint, {
          method, path: route, headers, agent: false, signal: controller.signal,
          // Explicit true also defeats NODE_TLS_REJECT_UNAUTHORIZED=0.
          ...(endpoint.protocol === 'https:' ? { ca, rejectUnauthorized: true } : {}),
        }, res => {
          // The deadline can fire while opening an output file, before its
          // async iterator has installed an error listener.
          res.on('error', () => {});
          resolve(res);
        });
        req.once('error', reject);
        req.once('upgrade', (res, socket) => {
          socket.destroy();
          reject(invalidResponse('Protocol upgrades are not supported.', res.statusCode));
        });
        req.end(payload);
      });
      check();
      const status = response.statusCode;
      if (status >= 300 && status < 400) throw new CliError('REDIRECT_REFUSED', 'Redirects are not followed.', 6, status);
      if (status < 200 || status >= 300) throw httpError(status, await errorBody(response).catch(() => undefined));
      const type = mimeType(response);
      if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') {
        throw invalidResponse('Unexpected encoded response.', status);
      }
      if (destination ? !isBinary(type) : !isJson(type)) throw invalidResponse('Unexpected response content type.', status);
      const streaming = destination && (durationMs !== undefined || type === 'multipart/x-mixed-replace');
      const limit = streaming ? MAX_STREAM : MAX_RESPONSE;
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
        throw new CliError('RESPONSE_TOO_LARGE', `Response exceeds ${limit / 1024 / 1024} MiB.`, 6, status);
      }
      if (destination) {
        try {
          handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          identity = await handle.stat();
          await handle.chmod(0o600);
        } catch (error) {
          throw usage(error.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_FILE', error.code === 'EEXIST'
            ? 'Output already exists. Choose a new file, including when the existing path is a symlink.' : 'Cannot create a private output file.');
        }
      }
      check();
      if (durationMs !== undefined) {
        durationTimer = setTimeout(() => {
          durationReached = true;
          response.destroy(durationStop);
          controller.abort();
        }, durationMs);
      }
      const chunks = [];
      try {
        for await (const chunk of response) {
          check();
          if (bytes + chunk.length > limit) throw new CliError('RESPONSE_TOO_LARGE', `Response exceeds ${limit / 1024 / 1024} MiB.`, 6, status);
          if (handle) {
            try {
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
                if (!bytesWritten) throw new Error();
                offset += bytesWritten;
              }
            } catch { throw usage('OUTPUT_FILE', 'Cannot write the output file.'); }
          } else chunks.push(chunk);
          bytes += chunk.length;
        }
      } catch (error) {
        // Only our duration timer can turn an interrupted stream into success.
        // Disk errors, external cancellation and the whole-request deadline win.
        if (!durationReached || error !== durationStop) throw error;
      }
      check();
      if (destination) {
        if (!bytes) throw invalidResponse('The response contained no data.', status);
        try { await handle.close(); handle = undefined; } catch { throw usage('OUTPUT_FILE', 'Cannot finish the output file.'); }
        const current = await lstat(destination).catch(() => null);
        if (!current?.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw usage('OUTPUT_FILE', 'Output file changed during the request.');
        check();
        success = true;
        return { output: destination, bytes, contentType: response.headers['content-type'], ...(durationMs !== undefined ? { durationMs } : {}) };
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); } catch { throw invalidResponse('Server returned invalid JSON.', status); }
      if (!result || typeof result !== 'object') throw invalidResponse('Server did not return a JSON object.', status);
      check();
      return result;
    } catch (error) {
      throw failure || transportError(error);
    } finally {
      clearTimeout(deadline);
      clearTimeout(durationTimer);
      signal?.removeEventListener('abort', cancel);
      response?.destroy();
      req?.destroy();
      await handle?.close().catch(() => {});
      if (identity && !success) {
        // Never remove a preexisting file or a replacement installed by someone
        // else while the request was running (including a replacement symlink).
        const current = await lstat(destination).catch(() => null);
        if (current?.isFile() && current.dev === identity.dev && current.ino === identity.ino) await unlink(destination).catch(() => {});
      }
    }
  }
  return { request };
}

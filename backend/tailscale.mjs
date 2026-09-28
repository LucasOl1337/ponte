import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { runCommand, ApiError } from './process.mjs';

// Identity-based auto-pairing. A device already on the owner's tailnet does not
// need to type a key: the Tailscale daemon already authenticated it, and
// `tailscale whois` maps the peer's address to the tailnet user that owns it.
// When that user is the same one that owns this PC, the phone is handed the
// pairing token automatically. Any other peer (a machine shared with you by
// someone else) still falls back to the typed key.

// A TLS socket reports the peer as an IPv4, an IPv4-mapped IPv6 (::ffff:a.b.c.d)
// or a native tailnet IPv6. whois wants the bare address.
export function normalizePeerAddress(remoteAddress) {
  if (typeof remoteAddress !== 'string' || !remoteAddress) return null;
  let address = remoteAddress.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) address = mapped[1];
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  return isIP(address) ? address : null;
}

const PHONE_OS = new Set(['android', 'ios']);
const isLoopback = address => address === '::1' || /^127\.\d+\.\d+\.\d+$/.test(address || '');

// Browser auto-pairing through `tailscale serve`. Serve terminates HTTPS on the
// tailnet name, proxies to the loopback listener and adds Tailscale-User-Login
// for the tailnet user behind the request. It strips any copy the client sent,
// and Funnel (public) traffic never carries it. On its own the header could be
// forged by any local process, so it only counts when the other end of the
// loopback connection is a socket owned by root, which here is tailscaled.
// /proc/net/tcp lists that socket with our listener as its remote end.
export function loopbackSocketOwner(peerPort, serverPort, read = readFileSync) {
  if (!Number.isInteger(peerPort) || !Number.isInteger(serverPort)) return null;
  const loopbackHex = /^([0-9A-F]{6}7F|0{16}FFFF0000[0-9A-F]{6}7F|0{24}01000000)$/i;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = read(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 8) continue;
      const [localAddress, localPort] = fields[1].split(':');
      const [remoteAddress, remotePort] = fields[2].split(':');
      if (parseInt(localPort, 16) !== peerPort || parseInt(remotePort, 16) !== serverPort) continue;
      if (!loopbackHex.test(localAddress) || !loopbackHex.test(remoteAddress)) continue;
      const uid = Number(fields[7]);
      return Number.isInteger(uid) ? uid : null;
    }
  }
  return null;
}

export function createTailscaleIdentity({ runner = runCommand, selfAddress, env = process.env, ttl = 15000, timeout = 2500, retryInterval = 5000, socketOwner = loopbackSocketOwner } = {}) {
  const binary = env.PONTE_TAILSCALE_BIN || 'tailscale';
  const disabled = env.PONTE_TAILSCALE_AUTO === '0';
  let ownerUserId = null;
  let ownerLogin = null;
  let ownerResolved = false;
  let ownerAttemptAt = 0;
  const cache = new Map();

  async function whoisProfile(address) {
    const raw = await runner(binary, ['whois', '--json', address], { env, timeout, maxBuffer: 256 * 1024 });
    const parsed = JSON.parse(raw);
    // Tagged devices (servers, CI) have no human owner and must not auto-pair.
    if (Array.isArray(parsed?.Node?.Tags) && parsed.Node.Tags.length) return null;
    const user = parsed?.Node?.User ?? parsed?.UserProfile?.ID;
    if (typeof user !== 'number' || user <= 0) return null;
    const login = parsed?.UserProfile?.LoginName;
    const os = parsed?.Node?.Hostinfo?.OS;
    return { user, login: typeof login === 'string' && login ? login : null, os: typeof os === 'string' ? os.toLowerCase() : '' };
  }

  // The daemon is often still coming up when this service starts at login
  // (the TLS listener itself waits for the tailnet address), so a failed whois
  // must not latch auto-pairing off for the life of the process. Only a real
  // answer is final; a failure is retried on the next request, throttled so a
  // stopped daemon is not hammered on every pairing attempt.
  async function resolveOwner() {
    if (disabled) return ownerUserId;
    return resolveOwnerAlways();
  }
  async function resolveOwnerAlways() {
    if (ownerResolved) return ownerUserId;
    if (!selfAddress) { ownerResolved = true; return null; }
    const now = Date.now();
    if (now - ownerAttemptAt < retryInterval) return ownerUserId;
    ownerAttemptAt = now;
    try {
      const owner = await whoisProfile(selfAddress);
      ownerUserId = owner?.user ?? null;
      ownerLogin = owner?.login ?? null;
      ownerResolved = true;
    } catch { ownerUserId = null; ownerLogin = null; }
    return ownerUserId;
  }

  // Resolve at startup so a later failure to reach the daemon cannot silently
  // turn auto-pairing off while the tailnet is actually healthy.
  const ready = resolveOwner().catch(() => null);

  // The peer's tailnet profile when it belongs to this PC's owner, else null.
  async function ownerDevice(remoteAddress) {
    const owner = await resolveOwnerAlways();
    if (!owner) return null;
    const address = normalizePeerAddress(remoteAddress);
    if (!address) return null;
    const now = Date.now();
    const hit = cache.get(address);
    if (hit && now - hit.at < ttl) return hit.value;
    let value = null;
    try { const profile = await whoisProfile(address); value = profile?.user === owner ? profile : null; } catch { value = null; }
    cache.set(address, { at: now, value });
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return value;
  }

  // Another node of the mesh must still be the owner's (explicit pairing
  // then decides); that check does not depend on key-free auto-pairing.
  async function sameOwner(remoteAddress) { return !!await ownerDevice(remoteAddress); }

  // The key-free /api/pair hands out the owner token, so only the phone app
  // gets it. Another computer of the owner (a mesh node) must be approved on
  // this PC instead: a device controls another only where it was authorized.
  async function authorize(remoteAddress) {
    if (disabled) return false;
    const device = await ownerDevice(remoteAddress);
    return !!device && PHONE_OS.has(device.os);
  }

  // A browser reaching the loopback listener through Serve: the login Serve
  // stamped on the request must be the PC owner's, and the connection must
  // come from tailscaled itself (see loopbackSocketOwner).
  async function authorizeServe({ remoteAddress, remotePort, localPort, login } = {}) {
    if (disabled || typeof login !== 'string' || !login) return false;
    if (!isLoopback(normalizePeerAddress(remoteAddress))) return false;
    if (socketOwner(remotePort, localPort) !== 0) return false;
    await resolveOwner();
    return !!ownerLogin && login.toLowerCase() === ownerLogin.toLowerCase();
  }

  return { authorize, authorizeServe, sameOwner, ready, get available() { return !disabled; }, get ownerUserId() { return ownerUserId; } };
}

// Kept in one place so the route and its test agree on the shape.
export function pairingRejection() {
  return new ApiError(403, 'AUTOPAIR_DENIED');
}

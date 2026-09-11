import { isIP } from 'node:net';
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

export function createTailscaleIdentity({ runner = runCommand, selfAddress, env = process.env, ttl = 15000, timeout = 2500 } = {}) {
  const binary = env.PONTE_TAILSCALE_BIN || 'tailscale';
  const disabled = env.PONTE_TAILSCALE_AUTO === '0';
  let ownerUserId = null;
  let ownerResolved = false;
  const cache = new Map();

  async function whoisUser(address) {
    const raw = await runner(binary, ['whois', '--json', address], { env, timeout, maxBuffer: 256 * 1024 });
    const parsed = JSON.parse(raw);
    // Tagged devices (servers, CI) have no human owner and must not auto-pair.
    if (Array.isArray(parsed?.Node?.Tags) && parsed.Node.Tags.length) return null;
    const user = parsed?.Node?.User ?? parsed?.UserProfile?.ID;
    return typeof user === 'number' && user > 0 ? user : null;
  }

  async function resolveOwner() {
    if (ownerResolved || disabled) return ownerUserId;
    ownerResolved = true;
    if (!selfAddress) return null;
    try { ownerUserId = await whoisUser(selfAddress); } catch { ownerUserId = null; }
    return ownerUserId;
  }

  // Resolve at startup so a later failure to reach the daemon cannot silently
  // turn auto-pairing off while the tailnet is actually healthy.
  const ready = resolveOwner().catch(() => null);

  async function authorize(remoteAddress) {
    if (disabled) return false;
    const owner = await resolveOwner();
    if (!owner) return false;
    const address = normalizePeerAddress(remoteAddress);
    if (!address) return false;
    const now = Date.now();
    const hit = cache.get(address);
    if (hit && now - hit.at < ttl) return hit.value;
    let value = false;
    try { value = (await whoisUser(address)) === owner; } catch { value = false; }
    cache.set(address, { at: now, value });
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return value;
  }

  return { authorize, ready, get available() { return !disabled; }, get ownerUserId() { return ownerUserId; } };
}

// Kept in one place so the route and its test agree on the shape.
export function pairingRejection() {
  return new ApiError(403, 'AUTOPAIR_DENIED');
}

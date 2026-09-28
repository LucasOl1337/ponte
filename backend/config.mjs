import os from 'node:os';
import path from 'node:path';
import { isIPv4 } from 'node:net';
import { lstat, readFile } from 'node:fs/promises';

export function isTailscaleIpv4Bind(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const octets = value.split('.').map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
}
// SSH hosts this node may open as Ponte terminals: aliases from the owner's
// ~/.ssh/config, listed on purpose in the private config. The phone picks one
// of these names; it never sends a hostname, user or option of its own.
export const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SSH_HOST_LIMIT = 16;
export function sshHosts(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > SSH_HOST_LIMIT) throw new Error(`ssh.hosts must be a list of at most ${SSH_HOST_LIMIT} SSH aliases.`);
  const hosts = value.map(entry => {
    const { host, label } = typeof entry === 'string' ? { host: entry } : entry || {};
    if (typeof host !== 'string' || !SSH_HOST_PATTERN.test(host)) throw new Error('Each ssh.hosts entry needs an SSH alias (letters, digits, dot, dash, underscore).');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 40 || /[\u0000-\u001f\u007f<>]/.test(label))) throw new Error(`The label of SSH host ${host} must be 1–40 plain characters.`);
    return { host, label: label === undefined ? host : label.trim() };
  });
  if (new Set(hosts.map(item => item.host)).size !== hosts.length) throw new Error('ssh.hosts lists an alias twice.');
  return hosts;
}

function port(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port from 1 to 65535.`);
  return value;
}

export function defaultPaths(env = process.env) {
  const home = absolute(env.HOME || os.homedir(), 'HOME');
  const configHome = absolute(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'XDG_CONFIG_HOME');
  const stateHome = absolute(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'XDG_STATE_HOME');
  return {
    configFile: absolute(env.PONTE_CONFIG || path.join(configHome, 'ponte/config.json'), 'PONTE_CONFIG'),
    dataDir: path.join(stateHome, 'ponte'),
  };
}

export function runtimeSettings(config = {}, env = process.env) {
  const defaults = defaultPaths(env);
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) throw new Error('Unsupported Ponte configuration schema.');
  const host = env.OMARCHY_REMOTE_BIND || config.http?.host || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('The HTTP listener must bind a loopback address. Use native TLS for remote access.');
  const settings = {
    configFile: defaults.configFile,
    dataDir: absolute(env.OMARCHY_REMOTE_DATA || config.dataDir || defaults.dataDir, 'dataDir'),
    http: { host, port: port(env.OMARCHY_REMOTE_PORT !== undefined ? Number(env.OMARCHY_REMOTE_PORT) : (config.http?.port ?? 8787), 'HTTP port') },
    trustedHosts: env.OMARCHY_REMOTE_TRUSTED_HOSTS !== undefined ? env.OMARCHY_REMOTE_TRUSTED_HOSTS.split(',').filter(Boolean) : (config.trustedHosts || []),
    nativeTls: null,
    sshHosts: sshHosts(config.ssh?.hosts),
  };
  if (!Array.isArray(settings.trustedHosts) || settings.trustedHosts.some(value => typeof value !== 'string')) throw new Error('trustedHosts must be an array of hostnames.');
  const tls = config.nativeTls;
  if (tls || env.OMARCHY_REMOTE_TLS_CERT || env.OMARCHY_REMOTE_TLS_KEY) {
    const host = env.OMARCHY_REMOTE_NATIVE_BIND || tls?.host;
    if (!isTailscaleIpv4Bind(host)) throw new Error('The native listener requires a canonical Tailscale IPv4 address.');
    settings.nativeTls = {
      host,
      port: port(env.OMARCHY_REMOTE_NATIVE_PORT !== undefined ? Number(env.OMARCHY_REMOTE_NATIVE_PORT) : (tls?.port ?? 8788), 'Native TLS port'),
      certFile: absolute(env.OMARCHY_REMOTE_TLS_CERT || tls?.certFile, 'nativeTls.certFile'),
      keyFile: absolute(env.OMARCHY_REMOTE_TLS_KEY || tls?.keyFile, 'nativeTls.keyFile'),
      ...(tls?.caFile ? { caFile: absolute(tls.caFile, 'nativeTls.caFile') } : {}),
    };
  }
  return settings;
}

export async function loadSettings(env = process.env) {
  const { configFile } = defaultPaths(env);
  let config = {};
  try {
    const info = await lstat(configFile);
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Ponte config must be a regular private file owned by this user, mode 0600.');
    config = JSON.parse(await readFile(configFile, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.schemaVersion !== 1) throw new Error('Invalid Ponte configuration.');
  } catch (error) {
    if (error.code !== 'ENOENT' || env.PONTE_CONFIG) throw error;
  }
  return runtimeSettings(config, env);
}

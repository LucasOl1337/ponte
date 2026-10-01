// Two-node mesh lab: two real Ponte servers in one process, each with its own
// dataDir, CA, owner token and fake desktop (the lab tools, a synthetic
// monitor titled with the node's name). Both TLS listeners sit on 127.0.0.1,
// discovery points each node at the other and the tailnet whois answers
// "same owner" for 127.0.0.1, so pairing and relaying run the production code.
//
//
// The fleet and the device list see a synthetic tailnet, SSH config and adb
// (tools/lab/net/): made-up names on documentation addresses, never the
// machine's real ones.
//
//   node tools/lab/mesh.mjs      # pc-teste on :8799, notebook-teste on :8797
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../../server.mjs';
import { createDesktop } from '../../backend/desktop.mjs';
import { parseAdbDevices } from '../../backend/devices.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.PONTE_LAB_MESH_DIR || path.join(root, '.work/lab-mesh');
const nodes = [
  // pc-teste holds the phone link: its adb sees celular-teste over the tailnet.
  { key: 'a', name: 'pc-teste', kind: 'pc', http: Number(process.env.PONTE_LAB_PORT_A || 8799), native: Number(process.env.PONTE_LAB_NATIVE_A || 8798), monitor: '1920x1080',
    adb: 'List of devices attached\n192.0.2.3:5555 device product:lab model:Celular_teste device:lab\n' },
  { key: 'b', name: 'notebook-teste', kind: 'notebook', http: Number(process.env.PONTE_LAB_PORT_B || 8797), native: Number(process.env.PONTE_LAB_NATIVE_B || 8796), monitor: '1366x768', adb: '' },
];

async function certificates(dir) {
  const file = name => path.join(dir, name);
  try { await access(file('server.crt')); } catch {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-keyout', file('ca.key'), '-out', file('ca.crt'),
      '-subj', '/CN=Ponte lab CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    await writeFile(file('leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', file('server.key'), '-out', file('server.csr'), '-subj', '/CN=Ponte lab server']);
    await run('openssl', ['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-set_serial', String(Date.now()), '-days', '30', '-sha256', '-extfile', file('leaf.ext'), '-out', file('server.crt')]);
  }
  return { ca: await readFile(file('ca.crt'), 'utf8'), cert: await readFile(file('server.crt')), key: await readFile(file('server.key')) };
}

const identity = { available: true, ready: Promise.resolve(), ownerUserId: 1, authorize: async address => /^(::ffff:)?127\.0\.0\.1$/.test(address || '') };
const apps = [];
for (const node of nodes) {
  const dir = path.join(base, node.key);
  const env = {
    ...process.env, PONTE_LAB_DIR: dir, PONTE_LAB_MONITOR: node.monitor, PONTE_LAB_TITLE: node.name, PONTE_LAB_ACCEL: '1',
    PATH: `${root}/tools/lab/bin:${process.env.PATH}`, WAYLAND_DISPLAY: 'ponte-lab-none', PONTE_SUSSURRO_SOCKET: '', PONTE_STT_URL: '',
    MAGMA_LIGHTS_CONTROLLER: path.join(dir, 'no-magma/controller.py'), YDOTOOL_SOCKET: path.join(dir, 'input.sock'),
    PONTE_TAILSCALE_BIN: path.join(root, 'tools/lab/net/tailscale'), PONTE_SSH_BIN: path.join(root, 'tools/lab/net/ssh'),
  };
  await mkdir(path.join(dir, 'data'), { recursive: true, mode: 0o700 });
  await run('python3', ['-c', 'import socket,sys,os\np=sys.argv[1]\nif not os.path.exists(p): socket.socket(socket.AF_UNIX).bind(p)', env.YDOTOOL_SOCKET]);
  const tls = await certificates(path.join(dir, 'tls'));
  const desktop = createDesktop({ env });
  const getState = desktop.getState;
  desktop.getState = async (...args) => ({ ...await getState(...args), hostname: node.name });
  const other = nodes.find(item => item !== node);
  const app = await createApp({
    dataDir: path.join(dir, 'data'), env, desktop, nativeTls: { cert: tls.cert, key: tls.key }, caPem: tls.ca, tailnetIdentity: identity,
    trustedHosts: [`127.0.0.1:${node.http}`, `localhost:${node.http}`],
    meshOptions: { name: node.name, kind: node.kind, enabled: true, discover: async () => [{ ip: '127.0.0.1', port: other.native }] },
    fleetOptions: { sshConfigFile: path.join(root, 'tools/lab/net/ssh_config') },
    devicesOptions: { adb: async () => parseAdbDevices(node.adb) },
  });
  await new Promise(resolve => app.server.listen(node.http, '127.0.0.1', resolve));
  await new Promise(resolve => app.nativeServer.listen(node.native, '127.0.0.1', resolve));
  const token = (await readFile(path.join(dir, 'data/token'), 'utf8')).trim();
  console.log(`${node.name}: http://127.0.0.1:${node.http}/#pair=${token}  (tailnet TLS 127.0.0.1:${node.native}, id ${app.mesh.id})`);
  apps.push(app);
}
const stop = async () => { await Promise.allSettled(apps.map(app => app.close())); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);

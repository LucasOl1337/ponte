#!/usr/bin/env node
/**
 * HTTP só em 127.0.0.1, com createApp real e todas as dependências de PC fake.
 * Reinicia a fixture ao subir. Não executa comandos, modelos, captura ou entrada.
 *
 *   node tools/lab/agents-panel-server.mjs .work/agents-panel 8817
 *   node tools/lab/agents-panel-server.mjs .work/agents-panel-before 8818 --root-dir .work/baseline
 *   node tools/lab/agents-panel-fixture.mjs append .work/agents-panel
 *
 * --root-dir é a pasta que contém public/ (somente leitura). O backend continua
 * sendo deste worktree. A comparação antes/depois troca só os assets servidos.
 * O pai do PATH da fixture precisa existir. Todo estado privado fica nesse PATH.
 * O token impresso é público, fictício e serve só pra este lab de loopback.
 */
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createApp } from '../../server.mjs';
import { createAgents } from '../../backend/agents.mjs';
import { ApiError } from '../../backend/process.mjs';
import { seed } from './agents-panel-fixture.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN = 'ponte_agents_panel_public_lab_token_0000';
const CAPS = { mouse: false, keyboard: false, screenshot: false, audio: false, live: false, lights: false, lock: false, rd: false, stt: false };
const noOperation = async () => { throw new ApiError(503, 'AGENT_UNAVAILABLE'); };
const close = async () => {};

// initializeToken cria seu estado privado. Recuse links preexistentes antes
// de delegar a ele, pra nenhuma escrita poder sair do PATH do lab.
async function checkPrivateFiles(file) {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isDirectory()) {
    for (const entry of await readdir(file)) await checkPrivateFiles(path.join(file, entry));
  } else if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Estado privado inseguro: ${file}`);
}

/** Inicia um lab HTTP. port=0 escolhe porta efêmera para checks isolados. */
export async function start({ root, port = 8817, rootDir = PROJECT_ROOT } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Porta inválida (0..65535).');
  const assets = path.resolve(rootDir);
  const index = path.join(assets, 'public', 'index.html');
  if (!(await lstat(index)).isFile()) throw new Error('--root-dir precisa conter public/index.html.');
  const { procRoot, home } = await seed(root);
  const labRoot = path.dirname(home);
  const dataDir = path.join(labRoot, 'server-data');
  await checkPrivateFiles(dataDir);
  const manifest = JSON.parse(await readFile(path.join(labRoot, 'agents-panel.json'), 'utf8'));
  const runner = async (command, args) => {
    if (command === 'hyprctl' && args.join(' ') === '-j clients') return '[]';
    throw new Error(`Comando proibido no lab: ${command}`);
  };
  const agents = createAgents({ procRoot, home, runner, env: {}, cacheMs: 0 });
  const state = {
    hostname: 'agents-panel-lab', uptime: 3600, activeWindow: null,
    monitors: [], workspaces: [], windows: [], volume: { value: 0, muted: true },
    capabilities: CAPS, warningCodes: [], warnings: [],
    wakeOnLan: { mac: null, interface: null, enabled: false, instructions: 'Lab sem hardware.' },
    power: { wakeOnLan: { mac: null, interface: null, enabled: false } },
    session: { locked: false, lockAvailable: false },
    textInput: { available: false, focused: null }, lights: null,
  };
  const desktop = {
    getState: async () => structuredClone(state), capabilities: async () => ({ ...CAPS }),
    textInputFocused: async () => ({ available: false, focused: null }),
    action: noOperation, screenshot: noOperation, prepareLive: noOperation, close,
  };
  const terminals = {
    list: async () => ({ available: true, sessions: [] }),
    projects: async () => ({ projects: manifest.workspaces.map(team => ({ name: team.name, path: path.resolve(labRoot, team.terminals[0].cwd) })), hosts: [] }),
    create: noOperation, input: noOperation, read: noOperation, resize: noOperation,
    open: noOperation, remove: noOperation, close,
  };
  const mesh = {
    id: 'lab-node-agents-panel', name: 'Agents panel lab',
    active: () => false, view: () => ({ enabled: false, peers: [] }),
    list: async () => ({ enabled: false, peers: [], requests: [] }),
    hello: () => ({ name: 'Agents panel lab', pairing: false }),
    authorizePeer: () => null, connection: noOperation, relay: noOperation,
    createRequest: noOperation, requestStatus: noOperation, action: noOperation, close,
  };
  const app = await createApp({
    rootDir: assets, dataDir, token: TOKEN,
    env: {}, trustedHosts: [], agents, desktop, terminals, mesh,
    nativeTls: null, notify: () => {},
    tailnetIdentity: { available: false, authorize: async () => false, authorizeServe: async () => false },
    transcriber: { available: async () => false, transcribe: noOperation },
    audio: { list: async () => ({ clips: [] }), upload: noOperation, get: noOperation, remove: noOperation, play: noOperation, stop: noOperation, close },
    images: { list: async () => ({ images: [] }), upload: noOperation, get: noOperation, remove: noOperation, copy: noOperation, paste: noOperation },
    fleet: {
      overview: async () => ({ machines: [] }), sessions: async () => ({ sessions: [] }),
      probe: noOperation, handoff: noOperation, resume: noOperation,
      job: noOperation, jobs: () => ({ jobs: [] }), wait: noOperation,
    },
    rd: { capabilities: async () => ({ rd: false }), accept: ws => ws.close(1008, 'Lab sem desktop'), close },
  });
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
    });
  } catch (error) { await app.close(); throw error; }
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, url: `${base}/#pair=${TOKEN}`, token: TOKEN, procRoot, home, rootDir: assets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { positionals, values } = parseArgs({ options: { 'root-dir': { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
    if (values.help) console.log('Uso: node tools/lab/agents-panel-server.mjs PATH [PORTA=8817] [--root-dir PASTA_COM_PUBLIC]');
    else {
      if (!positionals[0] || positionals.length > 2) throw new Error('Informe PATH [PORTA=8817] [--root-dir PASTA_COM_PUBLIC].');
      if (positionals[1] !== undefined && !/^\d{1,5}$/.test(positionals[1])) throw new Error('Porta inválida.');
      const lab = await start({ root: positionals[0], port: positionals[1] === undefined ? 8817 : Number(positionals[1]), rootDir: values['root-dir'] || PROJECT_ROOT });
      console.log(`Agents panel lab: ${lab.url}`);
      console.log(`Assets (só leitura): ${lab.rootDir}/public`);
      console.log(`Append ao vivo: node tools/lab/agents-panel-fixture.mjs append ${JSON.stringify(path.dirname(lab.home))}`);
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await lab.app.close(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } catch (error) { console.error(`Lab: ${error.message}`); process.exitCode = 1; }
}

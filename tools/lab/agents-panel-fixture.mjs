#!/usr/bin/env node
/**
 * Fixture de arquivos, sem processos, servidor, comandos externos ou HOME real.
 *
 *   node tools/lab/agents-panel-fixture.mjs seed .work/agents-panel
 *   node tools/lab/agents-panel-fixture.mjs append .work/agents-panel
 *
 * O pai do PATH precisa existir. seed aceita pasta vazia ou uma fixture anterior
 * e reinicia os transcripts conhecidos. append só cresce o journal do JCode A
 * da Equipe Aurora. As duas operações recusam symlinks nos caminhos de escrita.
 *
 * Uso no harness (não altere process.env.HOME):
 *   const { procRoot, home } = await seed(root);
 *   const runner = async (command, args) => {
 *     if (command === 'hyprctl' && args.join(' ') === '-j clients') return '[]';
 *     throw new Error(`Comando inesperado no lab: ${command}`);
 *   };
 *   const agents = createAgents({ procRoot, home, runner });
 *   // Injete agents em createApp({ ...dependenciasFake, agents }).
 *
 * Schema em PATH/agents-panel.json: schemaVersion, fixture, workspaces[] com
 * id/name/terminals[]. Cada terminal tem nodeId, shellPid, pid, kind, name,
 * role, branch, sessionId e caminhos RELATIVOS ao PATH (cwd/transcript/snapshot).
 * Esperado: 8 agentes, 2 Claude + 4 JCode + 2 Codex, em 2 equipes de 4.
 * Cada Claude Code é regente (isManager) ligado a JCode A, JCode B e Codex.
 * Os nomes se repetem entre equipes, mas workspace/node/session ids são únicos.
 * Um servidor JCode órfão, com ids herdados, e filhos Codex code-mode não contam.
 *
 * Árvore consumida pelo scanner:
 *   proc/stat, proc/<pid>/{stat,cmdline,environ,cwd -> HOME lab,fd/3 -> rollout}
 *   home/.maestri/workspaces/<uuid>/workspace.json (payload.nodes/connections)
 *   home/.maestri/roles/<uuid>/role.json e .git (gitdir relativo de worktree)
 *   home/Projects/<equipe>/.git/{HEAD,worktrees/<role>/HEAD}
 *   home/.claude/sessions/<pid>.json e projects/<cwd-codificado>/<uuid>.jsonl
 *   home/.jcode/client_sessions/<pid>, sessions/session_lab_*.{json,journal.jsonl}
 *   home/.codex/sessions/2000/01/01/rollout-2000-01-01T00-00-00-<uuid>.jsonl
 *
 * UUIDs, PIDs, modelos, nomes, mensagens e branches são inventados. Os únicos
 * caminhos absolutos gerados são derivados do PATH recebido, nunca do homedir.
 * Não é um dump completo dos vendors, só os campos que createAgents lê.
 */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, readlink, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MARKER = 'agents-panel.json';
const FIXTURE = 'ponte-agents-panel';
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TEAMS = [
  { slug: 'aurora', name: 'Equipe Aurora', id: uuid(0x100), base: 5100 },
  { slug: 'boreal', name: 'Equipe Boreal', id: uuid(0x200), base: 6100 },
];
const MEMBERS = [
  { kind: 'claude', name: 'Claude Code', slug: 'regente', role: 'Regente', model: 'lab-claude' },
  { kind: 'jcode', name: 'JCode A', slug: 'jcode-a', role: 'Implementação', model: 'lab-jcode-build' },
  { kind: 'jcode', name: 'JCode B', slug: 'jcode-b', role: 'Revisão', model: 'lab-jcode-review' },
  { kind: 'codex', name: 'Codex', slug: 'codex', role: 'Validação', model: 'lab-codex' },
];
const APP_PID = 4100;
const SERVER_PID = 4200;
const START = 30000; // 300 s depois do boot sintético, com CLK_TCK=100.
const APPEND_SESSION = 'session_lab_aurora_jcode_a';
const APPEND_JOURNAL = `home/.jcode/sessions/${APPEND_SESSION}.journal.jsonl`;
const json = value => `${JSON.stringify(value)}\n`;
const jsonl = values => values.map(json).join('');

async function info(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Verifica também os ancestrais do PATH antes de criar qualquer coisa. O pai
// deve existir, para a CLI nunca criar uma pasta fora do argumento recebido.
async function checkDirectory(dir) {
  const parent = path.dirname(dir);
  if (parent !== dir) await checkDirectory(parent);
  const stat = await info(dir);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Diretório ausente ou inseguro: ${dir}`);
}

async function storage(argument, create = false) {
  if (typeof argument !== 'string' || !argument.trim() || argument.includes('\0')) throw new Error('Informe um PATH de lab explícito.');
  const root = path.resolve(argument);
  if (root === path.parse(root).root) throw new Error('A raiz do filesystem não é um PATH de lab.');
  await checkDirectory(path.dirname(root));
  const stat = await info(root);
  if (!stat && create) await mkdir(root);
  else if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`PATH ausente ou inseguro: ${root}`);

  function target(relative) {
    const file = path.resolve(root, relative);
    if (file === root || !file.startsWith(`${root}${path.sep}`)) throw new Error('Caminho fora da fixture.');
    return file;
  }
  async function parents(file, make) {
    const parts = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await info(current);
      if (!stat && make) await mkdir(current);
      else if (!stat) return;
      else if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Diretório inseguro: ${current}`);
    }
  }
  async function regular(relative, make = false) {
    const file = target(relative);
    await parents(file, make);
    const stat = await info(file);
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Arquivo inseguro: ${file}`);
    return file;
  }
  async function write(relative, text, append = false) {
    const file = await regular(relative, !append);
    const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (append ? constants.O_APPEND : constants.O_CREAT | constants.O_TRUNC);
    const handle = await open(file, flags, 0o600);
    try { await handle.writeFile(text); } finally { await handle.close(); }
  }
  async function link(relative, destination, make = true) {
    const file = target(relative), dest = target(destination);
    await parents(file, make);
    const stat = await info(file);
    if (stat) {
      if (!stat.isSymbolicLink() || await readlink(file) !== dest) throw new Error(`Link inesperado: ${file}`);
    } else if (make) await symlink(dest, file);
  }
  return { root, target, regular, write, link };
}

function procStat(pid, comm, ppid, tty = 0) {
  // Campos de proc(5): ppid=4, tty_nr=7, utime=14, stime=15, starttime=22.
  const fields = Array(50).fill('0');
  fields[0] = 'S'; fields[1] = String(ppid); fields[2] = String(pid); fields[3] = String(pid);
  fields[4] = String(tty); fields[5] = '-1'; fields[15] = '20'; fields[17] = '1'; fields[19] = String(START);
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

/** Prepara arquivos sintéticos e retorna os dois caminhos para createAgents. */
export async function seed(root) {
  const store = await storage(root, true);
  const existing = await readdir(store.root);
  if (existing.length) {
    await store.regular(MARKER);
    let marker;
    try { marker = JSON.parse(await readFile(store.target(MARKER), 'utf8')); } catch { throw new Error('seed exige pasta vazia ou fixture anterior.'); }
    if (marker.fixture !== FIXTURE || marker.schemaVersion !== 1) throw new Error('PATH já contém dados que não são desta fixture.');
  }
  const home = store.target('home'), procRoot = store.target('proc');
  const files = new Map(), links = new Map();
  const file = (relative, value) => files.set(relative, typeof value === 'string' ? value : json(value));
  const at = Date.now();
  const timestamp = offset => new Date(at + offset).toISOString();
  const processFile = (pid, comm, ppid, { cwd = 'home', argv = [comm], ids = null, fd = null, tty = 0 } = {}) => {
    file(`proc/${pid}/stat`, procStat(pid, comm, ppid, tty));
    file(`proc/${pid}/cmdline`, `${argv.join('\0')}\0`);
    const env = ids ? [`MAESTRI_WORKSPACE_ID=${ids.workspace}`, `MAESTRI_TERMINAL_ID=${ids.terminal}`] : [];
    file(`proc/${pid}/environ`, env.length ? `${env.join('\0')}\0` : '');
    links.set(`proc/${pid}/cwd`, cwd);
    if (fd) links.set(`proc/${pid}/fd/3`, fd);
  };
  file('proc/stat', `cpu 1 0 0 1\nbtime ${Math.floor(at / 1000) - 3600}\n`);
  processFile(APP_PID, 'maestri-app', 1);
  // Servidor compartilhado fora da árvore do app, mesmo com ids herdados.
  processFile(SERVER_PID, 'jcode-linux-x86', 1, {
    argv: ['jcode', 'serve'], ids: { workspace: TEAMS[0].id, terminal: uuid(0x102) },
  });
  const workspaces = [];
  for (const [teamIndex, team] of TEAMS.entries()) {
    const project = `home/Projects/${team.slug}`;
    const terminals = [], nodes = [], connections = [];
    file(`${project}/.git/HEAD`, `ref: refs/heads/lab/${team.slug}\n`);
    for (const [index, member] of MEMBERS.entries()) {
      const nodeId = uuid((teamIndex + 1) * 0x100 + index + 1);
      const roleId = uuid((teamIndex + 1) * 0x100 + index + 0x10);
      const sessionId = member.kind === 'jcode' ? `session_lab_${team.slug}_${member.slug.replaceAll('-', '_')}` : uuid((teamIndex + 1) * 0x100 + index + 0x20);
      const shellPid = team.base + index * 10, pid = shellPid + 1;
      const cwd = index === 0 ? project : `home/.maestri/roles/${roleId}`;
      const branch = index === 0 ? `lab/${team.slug}` : `lab/${team.slug}/${member.slug}`;
      if (index > 0) {
        file(`${cwd}/role.json`, { id: roleId, name: member.role });
        const gitdir = `${project}/.git/worktrees/${member.slug}`;
        file(`${cwd}/.git`, `gitdir: ${path.relative(store.target(cwd), store.target(gitdir))}\n`);
        file(`${gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
      }
      const argv = [member.kind, '--model', member.model, '--effort', 'high'];
      if (member.kind === 'jcode') argv.push('--provider-profile', 'lab-provider');
      const ids = { workspace: team.id, terminal: nodeId };
      processFile(shellPid, 'bash', APP_PID, { cwd, ids, tty: 34816 + teamIndex * 4 + index });
      let transcript, snapshot = null;
      if (member.kind === 'claude') {
        const absoluteCwd = store.target(cwd);
        file(`home/.claude/sessions/${pid}.json`, {
          pid, sessionId, cwd: absoluteCwd, procStart: String(START), name: member.name,
          status: teamIndex === 0 ? 'waiting' : 'busy', statusUpdatedAt: at - 10000,
          ...(teamIndex === 0 ? { waitingFor: 'Revisar o plano sintético' } : {}),
        });
        transcript = `home/.claude/projects/${absoluteCwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`;
        file(transcript, jsonl([
          { type: 'user', timestamp: timestamp(-30000), message: { role: 'user', content: `Coordene a rodada de lab da ${team.name}.` } },
          { type: 'assistant', timestamp: timestamp(-20000), message: { role: 'assistant', model: member.model, stop_reason: 'end_turn', content: [{ type: 'text', text: teamIndex === 0 ? 'Plano de lab pronto. Tô esperando a revisão antes de seguir.' : 'Tô coordenando implementação, revisão e validação da equipe de lab.' }] } },
        ]));
      } else if (member.kind === 'jcode') {
        const meta = { provider_key: 'lab-provider', model: member.model, reasoning_effort: 'high', title: `${member.name} · ${team.name}`, working_dir: store.target(cwd) };
        const message = (number, role, content, offset) => ({ id: `message_lab_${team.slug}_${index}_${number}`, role, content, timestamp: timestamp(offset) });
        const initial = message(1, 'user', [{ type: 'text', text: index === 1 ? 'Implemente o agrupamento sintético por equipe.' : 'Revise os nomes repetidos entre equipes no lab.' }], -25000);
        const reply = message(2, 'assistant', [{ type: 'text', text: index === 1 ? 'Tô ajustando o agrupamento da equipe de lab.' : 'Revisão de lab pronta: nomes iguais continuam separados pelo workspace.' }], -15000);
        snapshot = `home/.jcode/sessions/${sessionId}.json`;
        transcript = `home/.jcode/sessions/${sessionId}.journal.jsonl`;
        file(snapshot, { id: sessionId, messages: [initial, reply], ...meta });
        // A dobra snapshot/journal repete uma mensagem. O scanner deve deduplicar.
        const updates = index === 1 ? [
          { meta, append_messages: [reply] },
          { append_messages: [message(3, 'assistant', [{ type: 'tool_use', id: `tool_lab_${team.slug}`, name: 'apply_patch', input: { path: 'src/group-lab.mjs', description: 'Agrupar cartões sintéticos por workspace' } }], -5000)] },
        ] : [{ meta }]; // JCode B está pronto e tem mensagens só no snapshot.
        file(transcript, jsonl(updates));
        file(`home/.jcode/client_sessions/${pid}`, `${sessionId}\n`);
      } else {
        transcript = `home/.codex/sessions/2000/01/01/rollout-2000-01-01T00-00-00-${sessionId}.jsonl`;
        file(transcript, jsonl([
          { type: 'session_meta', timestamp: timestamp(-25000), payload: { id: sessionId, cwd: store.target(cwd) } },
          { type: 'turn_context', timestamp: timestamp(-24000), payload: { model: member.model, effort: 'high' } },
          { type: 'response_item', timestamp: timestamp(-23000), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Valide a contagem dos agentes sintéticos.' }] } },
          { type: 'event_msg', timestamp: timestamp(-22000), payload: { type: 'task_started' } },
          { type: 'response_item', timestamp: timestamp(-12000), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Validação de lab pronta: quatro terminais de agente nesta equipe, sem contar os helpers.' }] } },
          { type: 'event_msg', timestamp: timestamp(-10000), payload: { type: 'task_complete' } },
        ]));
        // Um helper com nome de agente não pode virar outro terminal.
        processFile(pid + 1, 'codex', pid, { cwd, argv: ['codex-code-mode'], ids, fd: transcript });
      }
      processFile(pid, member.kind === 'jcode' ? 'jcode-linux-x86' : member.kind, shellPid, { cwd, argv, ids, fd: member.kind === 'codex' ? transcript : null });
      nodes.push({ id: nodeId, content: { terminal: { _0: { id: nodeId, name: member.name, agentType: member.kind, isManager: index === 0, command: argv.join(' ') } } } });
      if (index > 0) connections.push({ id: uuid((teamIndex + 1) * 0x100 + index + 0x30), terminalIdA: uuid((teamIndex + 1) * 0x100 + 1), terminalIdB: nodeId });
      terminals.push({ nodeId, shellPid, pid, kind: member.kind, name: member.name, role: member.role, branch, sessionId, cwd, transcript, snapshot });
    }
    file(`home/.maestri/workspaces/${team.id}/workspace.json`, { payload: { id: team.id, name: team.name, nodes, connections } });
    workspaces.push({ id: team.id, name: team.name, terminals });
  }
  file(MARKER, {
    fixture: FIXTURE, schemaVersion: 1, workspaces,
    ignoredPids: [SERVER_PID, ...TEAMS.map(team => team.base + 32)],
    expectedCounts: { agents: 8, automated: 0, working: 3, waiting: 1, terminals: 0, maestri: 8, byKind: { claude: 2, jcode: 4, codex: 2 } },
    appendTarget: { sessionId: APPEND_SESSION, journal: APPEND_JOURNAL },
  });
  // Preflight completo antes de sobrescrever qualquer arquivo da fixture.
  for (const relative of files.keys()) await store.regular(relative);
  for (const [relative, dest] of links) await store.link(relative, dest, false);
  for (const [relative, content] of files) await store.write(relative, content);
  for (const [relative, dest] of links) await store.link(relative, dest);
  return { procRoot, home };
}

/** Acrescenta uma resposta final ao JCode A da Equipe Aurora, sem reseed. */
export async function append(root) {
  const store = await storage(root);
  await store.regular(MARKER);
  const marker = JSON.parse(await readFile(store.target(MARKER), 'utf8'));
  if (marker.fixture !== FIXTURE || marker.schemaVersion !== 1) throw new Error('PATH não é uma fixture do painel de agentes.');
  await store.regular(APPEND_JOURNAL);
  const journal = await readFile(store.target(APPEND_JOURNAL), 'utf8');
  let sequence = 0;
  for (const line of journal.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    for (const message of entry.append_messages || []) {
      const match = /^message_lab_append_(\d+)$/.exec(message.id || '');
      if (match) sequence = Math.max(sequence, Number(match[1]));
    }
  }
  const messageId = `message_lab_append_${sequence + 1}`;
  const message = {
    id: messageId, role: 'assistant', timestamp: new Date().toISOString(),
    content: [{ type: 'text', text: `Mensagem de lab ${sequence + 1}: agrupamento da Equipe Aurora pronto, sem duplicar servidor ou helper.` }],
  };
  await store.write(APPEND_JOURNAL, `${journal.endsWith('\n') ? '' : '\n'}${json({ append_messages: [message] })}`, true);
  return { sessionId: APPEND_SESSION, messageId, journal: APPEND_JOURNAL };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, ...extra] = process.argv.slice(2);
  if (!['seed', 'append'].includes(command) || !root || extra.length) {
    console.error('Uso: node tools/lab/agents-panel-fixture.mjs seed|append PATH');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await (command === 'seed' ? seed(root) : append(root)))); }
    catch (error) { console.error(`Fixture: ${error.message}`); process.exitCode = 1; }
  }
}

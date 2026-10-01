import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, readFile, readlink, lstat, open } from 'node:fs/promises';
import { ApiError, runCommand } from './process.mjs';

// Every terminal and coding agent running on the PC, read from /proc and the
// compositor's client list. Only reads: nothing here writes to a process, a
// transcript or an agent's own files. Typing a reply goes through the same
// desktop and terminal paths the phone already uses.

const AGENT_NAMES = new Set(['claude', 'codex', 'jcode', 'grok', 'hermes', 'opencode', 'gemini', 'pi', 'omp', 'aider', 'crush', 'goose', 'amp', 'qwen', 'cursor-agent', 'devin', 'copilot', 'agy', 'droid']);
const WRAPPERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);
// Shared servers and sandboxes carry an agent's name but are not a terminal
// someone talks to: the JCode server (`jcode serve`), Codex's app-server
// daemon, exec-server and sandbox helpers, a Hermes gateway. They still count
// as agents for nesting, so what they start is never listed on its own.
const SERVER_ARGS = new Set(['serve', 'app-server', 'exec-server', 'mcp-server', 'sandbox', 'daemon', 'gateway']);
const TERMINAL_CLASS = /terminal|alacritty|kitty|ghostty|foot|wezterm|konsole|xterm/i;
// Claude Code 2.1.x animates its window title with these two frames while a
// turn runs and shows ✳ when it stops (constants d2/c2 in its bundle).
const TITLE_WORKING = /^[◐◑]\s*/u;
const TITLE_IDLE = /^✳\s*/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^(p-\d{1,10}-\d{1,20}|w-[0-9a-f]{1,32})$/;
const JCODE_SESSION = /^session_[a-z0-9_]{1,120}$/;
const CPU_WORKING = 0.05; // share of one core between two scans
const RECENT_WRITE_MS = 20000;
const TAIL_BYTES = 512 * 1024;
const MESSAGE_LIMIT = 40;
const MESSAGE_CHARS = 3000;
const TRANSCRIPT_BYTES = 96 * 1024;
const SUMMARY_BYTES = 96 * 1024;

export function parseStat(text) {
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const fields = text.slice(close + 2).split(' ');
  const pid = Number(text.slice(0, open).trim());
  // Field N of proc(5) is fields[N - 3] once pid and comm are removed.
  return { pid, comm: text.slice(open + 1, close), ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), start: Number(fields[19]) };
}

export function agentKind(comm, argv = []) {
  // JCode's binary is jcode-linux-x86_64.bin; the kernel keeps 15 characters.
  if (comm.startsWith('jcode')) return 'jcode';
  if (AGENT_NAMES.has(comm)) return comm;
  if (WRAPPERS.has(comm) && argv[1]) {
    const name = path.basename(argv[1]).replace(/\.(c?js|mjs|ts|py)$/, '');
    if (AGENT_NAMES.has(name)) return name;
  }
  return null;
}

export function agentServer(argv = []) {
  if (argv.includes('-p') || argv.includes('--print')) return false;
  if (/sandbox|code-mode/.test(path.basename(argv[0] || ''))) return true;
  // Do not mistake the literal prompt `claude -p serve` for a server.
  for (let i = 1; i < argv.length; i++) {
    if (['-m', '--model', '--provider', '--provider-profile', '-c', '--effort', '--reasoning-effort'].includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    return SERVER_ARGS.has(argv[i]);
  }
  return false;
}

// Tokenize saved commands for labels only, never execute or expand them.
function splitCommand(text) {
  const words = text.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) || [];
  return words.map(word => /^['"]/.test(word) ? word.slice(1, -1) : word);
}

// A snapshot can be over 100 MB and contains no newlines. Recover complete
// message objects from its bounded tail without parsing the entire file.
export function jcodeSnapshotLines(text) {
  const lines = [];
  const starts = /\{\s*"id"\s*:\s*"message_[a-zA-Z0-9_]+"/g;
  let match;
  while ((match = starts.exec(text))) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = match.index; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const message = JSON.parse(text.slice(match.index, i + 1));
          if (Array.isArray(message.content) && ['user', 'assistant'].includes(message.role)) lines.push(JSON.stringify({ append_messages: [message] }));
        } catch {}
        starts.lastIndex = i + 1;
        break;
      }
    }
  }
  return lines;
}

// Model, effort and provider as the agent was started: -m/--model,
// --effort, Codex's -c model_reasoning_effort=, JCode's --provider-profile.
export function modelFromArgv(argv = []) {
  const out = {};
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => inline ?? argv[++index];
    if (flag === '-m' || flag === '--model') out.model = value();
    else if (flag === '--effort' || flag === '--reasoning-effort') out.effort = value();
    else if (flag === '--provider-profile' || flag === '--provider') { const v = value(); if (!out.provider || flag === '--provider-profile') out.provider = v; }
    else if (flag === '-c' && /^model_reasoning_effort=/.test(argv[index + 1] || '')) out.effort = argv[++index].split('=')[1].replace(/^"|"$/g, '');
    else if (flag === '-c' && /^model=/.test(argv[index + 1] || '')) out.model = argv[++index].split('=')[1].replace(/^"|"$/g, '');
  }
  for (const key of Object.keys(out)) { if (typeof out[key] !== 'string' || !out[key]) delete out[key]; else out[key] = out[key].slice(0, 80); }
  return out;
}

const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function toolLine(name, input) {
  const value = input && typeof input === 'object' ? input : {};
  const detail = value.description || value.command || value.file_path || value.path || value.pattern || value.url || value.query || value.prompt || '';
  return clip(oneLine(`${name}${detail ? `: ${detail}` : ''}`), 200);
}

// Transcript lines are the agent's own JSON; anything unexpected is skipped.
export function claudeMessages(lines) {
  const out = [];
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isMeta || entry.isSidechain || !entry.message) continue;
    const at = Date.parse(entry.timestamp) || null;
    const content = entry.message.content;
    if (entry.type === 'user') {
      const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map(part => part?.type === 'text' ? part.text : part?.type === 'image' ? '[imagem]' : null) : [];
      const text = parts.filter(part => typeof part === 'string' && part.trim() && !part.trimStart().startsWith('<')).join('\n').trim();
      if (text) out.push({ role: 'user', text: clip(text, MESSAGE_CHARS), at });
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) out.push({ role: 'assistant', text: clip(part.text.trim(), MESSAGE_CHARS), at });
        else if (part?.type === 'tool_use' && typeof part.name === 'string') out.push({ role: 'tool', text: toolLine(part.name, part.input), at });
      }
    }
  }
  return out;
}

export function codexMessages(lines) {
  const out = [];
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const item = entry?.type === 'response_item' ? entry.payload : null;
    if (!item) continue;
    const at = Date.parse(entry.timestamp) || null;
    if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant') && Array.isArray(item.content)) {
      const text = item.content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n').trim();
      // Codex injects its own context as user messages wrapped in tags.
      if (!text || (item.role === 'user' && (text.startsWith('<') || text.startsWith('# AGENTS.md')))) continue;
      out.push({ role: item.role, text: clip(text, MESSAGE_CHARS), at });
    } else if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.name === 'string') {
      let input = item.input ?? item.arguments;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
      out.push({ role: 'tool', text: toolLine(item.name, input), at });
    }
  }
  return out;
}

// JCode appends one JSON object per change to <session>.journal.jsonl:
// { meta: { model, provider_key, title, working_dir, ... }, append_messages: [
//   { role, content: [{ type: text|tool_use|tool_result, ... }], timestamp } ] }.
// Its own system reminders arrive as user text wrapped in tags.
export function jcodeMessages(lines) {
  const out = [];
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    for (const message of Array.isArray(entry?.append_messages) ? entry.append_messages : []) {
      const at = Date.parse(message?.timestamp) || null;
      const content = Array.isArray(message?.content) ? message.content : [];
      if (message?.role === 'user') {
        const text = content.map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').filter(part => part.trim() && !part.trimStart().startsWith('<')).join('\n').trim();
        if (text) out.push({ role: 'user', text: clip(text, MESSAGE_CHARS), at });
      } else if (message?.role === 'assistant') {
        for (const part of content) {
          // A turn that only thought writes an empty think block.
          const text = part?.type === 'text' && typeof part.text === 'string' ? part.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
          if (text) out.push({ role: 'assistant', text: clip(text, MESSAGE_CHARS), at });
          else if (part?.type === 'tool_use' && typeof part.name === 'string') out.push({ role: 'tool', text: toolLine(part.name, part.input), at });
        }
      }
    }
  }
  return out;
}

export const MESSAGE_PARSERS = { claude: claudeMessages, codex: codexMessages, jcode: jcodeMessages };

// What a transcript says about now, from its last lines only: the turn
// (an unanswered tool call or a request still being answered is a turn in
// progress; a final assistant text closes it), the last thing done, and the
// model the agent reported. Nothing here is guessed from CPU.
export function transcriptSummary(format, lines) {
  let turn = null, model = null, effort = null, provider = null, title = null, lastAt = null;
  const pending = new Set();
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (format === 'claude') {
      if (!entry || entry.isSidechain || entry.isMeta || !entry.message) continue;
      const content = entry.message.content;
      if (entry.type === 'assistant') {
        if (typeof entry.message.model === 'string' && !entry.message.model.startsWith('<')) model = entry.message.model;
        const parts = Array.isArray(content) ? content : [];
        for (const part of parts) if (part?.type === 'tool_use' && part.id) pending.add(part.id);
        if (parts.some(part => part?.type === 'tool_use')) turn = 'working';
        else if (parts.some(part => part?.type === 'text' && String(part.text || '').trim())) turn = entry.message.stop_reason === 'end_turn' || entry.message.stop_reason == null ? 'done' : 'working';
      } else if (entry.type === 'user') {
        const parts = Array.isArray(content) ? content : [];
        for (const part of parts) if (part?.type === 'tool_result') pending.delete(part.tool_use_id);
        if (typeof content === 'string' ? content.trim() && !content.trimStart().startsWith('<') : parts.some(part => part?.type === 'tool_result' || (part?.type === 'text' && !String(part.text || '').trimStart().startsWith('<')))) turn = 'working';
      }
    } else if (format === 'codex') {
      const payload = entry?.payload;
      if (entry?.type === 'turn_context' && payload) { if (typeof payload.model === 'string') model = payload.model; if (typeof payload.effort === 'string') effort = payload.effort; }
      else if (entry?.type === 'event_msg' && payload?.type === 'task_started') turn = 'working';
      else if (entry?.type === 'event_msg' && (payload?.type === 'task_complete' || payload?.type === 'turn_aborted')) turn = 'done';
    } else if (format === 'jcode') {
      const meta = entry?.meta;
      if (meta && typeof meta === 'object') {
        if (typeof meta.model === 'string') model = meta.model;
        if (typeof meta.provider_key === 'string') provider = meta.provider_key;
        if (typeof meta.reasoning_effort === 'string') effort = meta.reasoning_effort;
        if (typeof meta.title === 'string') title = meta.title;
      }
      for (const message of Array.isArray(entry?.append_messages) ? entry.append_messages : []) {
        const parts = Array.isArray(message?.content) ? message.content : [];
        if (message.role === 'assistant') {
          for (const part of parts) if (part?.type === 'tool_use' && part.id) pending.add(part.id);
          turn = parts.some(part => part?.type === 'tool_use') ? 'working' : 'done';
        } else if (message.role === 'user') {
          for (const part of parts) if (part?.type === 'tool_result') pending.delete(part.tool_use_id);
          if (parts.some(part => part?.type === 'tool_result' || (part?.type === 'text' && !String(part.text || '').trimStart().startsWith('<')))) turn = 'working';
        }
      }
    }
  }
  const messages = (MESSAGE_PARSERS[format] || (() => []))(lines);
  const last = messages.at(-1) || null;
  if (last?.at) lastAt = last.at;
  // The newest assistant text says what it is doing; a tool call after it is
  // the action in progress.
  const activity = last ? { role: last.role, text: clip(oneLine(last.text), 160), at: last.at } : null;
  if (pending.size && turn !== 'done') turn = 'working';
  return { turn, model: model?.slice(0,120) || null, effort: effort?.slice(0,40) || null, provider: provider?.slice(0,80) || null, title: title?.slice(0,200) || null, activity, lastAt };
}

export function lastMessages(messages, limit = MESSAGE_LIMIT, maxBytes = TRANSCRIPT_BYTES) {
  const kept = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0 && kept.length < limit; index--) {
    bytes += Buffer.byteLength(messages[index].text) + 40;
    if (bytes > maxBytes && kept.length) break;
    kept.unshift(messages[index]);
  }
  return { messages: kept, truncated: kept.length < messages.length };
}

const shortPath = (dir, home) => dir === home ? '~' : dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;

export function createAgents(options = {}) {
  const procRoot = options.procRoot || '/proc';
  const home = options.home || os.homedir();
  const runner = options.runner || runCommand;
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const cacheMs = options.cacheMs ?? 1500;
  const ponteSocket = options.dataDir ? path.join(options.dataDir, 'terminals', 'tmux.sock') : null;
  const ticksPerSecond = options.ticksPerSecond || 100;
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex', 'sessions');
  const jcodeDir = path.join(home, '.jcode');
  let bootMs = options.bootMs ?? null;
  let cache = null, inflight = null, lastScanMs = 0;
  const cpu = new Map();
  const codexFiles = new Map();
  const privateInfo = new Map();
  const canvasCache = new Map();
  const summaries = new Map();
  const fileTails = new Map();
  const transcriptViews = new Map();

  async function smallFile(file, max = 64 * 1024) {
    const info = await lstat(file);
    if (!info.isFile() || info.size > max) throw new Error('unexpected file');
    return readFile(file, 'utf8');
  }
  async function boot() {
    if (bootMs !== null) return bootMs;
    try { bootMs = Number(/^btime (\d+)$/m.exec(await readFile(path.join(procRoot, 'stat'), 'utf8'))[1]) * 1000; } catch { bootMs = 0; }
    return bootMs;
  }
  const argvOf = async pid => { try { return (await readFile(path.join(procRoot, String(pid), 'cmdline'), 'utf8')).split('\0').filter(Boolean); } catch { return []; } };
  const cwdOf = async pid => { try { return await readlink(path.join(procRoot, String(pid), 'cwd')); } catch { return ''; } };

  async function clients() {
    try {
      const list = JSON.parse(await runner('hyprctl', ['-j', 'clients'], { env, timeout: 2500 }));
      return Array.isArray(list) ? list.filter(item => item?.address && Number.isInteger(item.pid)) : [];
    } catch { return []; }
  }

  async function ponteSessions(needed) {
    if (!needed || !ponteSocket) return new Map();
    const clean = { ...env }; delete clean.TMUX; delete clean.TMUX_PANE;
    try {
      const text = await runner('tmux', ['-S', ponteSocket, '-N', 'list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'], { env: clean, timeout: 2000 });
      const map = new Map();
      for (const line of String(text).trim().split('\n')) {
        const [name, pid] = line.split('\t');
        const match = /^ponte_([a-f0-9]{24})$/.exec(name || '');
        if (match && /^\d+$/.test(pid || '')) map.set(Number(pid), match[1]);
      }
      return map;
    } catch { return new Map(); }
  }

  async function claudeSession(pid, start) {
    try {
      const value = JSON.parse(await smallFile(path.join(claudeDir, 'sessions', `${pid}.json`)));
      // A recycled pid would carry another process's file.
      if (String(value.procStart) !== String(start) || !UUID.test(String(value.sessionId))) return null;
      return value;
    } catch { return null; }
  }

  function claudeTranscript(cwd, sessionId) {
    const file = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
    return path.dirname(path.dirname(file)) === path.join(claudeDir, 'projects') ? file : null;
  }

  async function newestClaudeFile(cwd, sinceMs) {
    const dir = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    let best = null;
    try {
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.jsonl') || !UUID.test(name.slice(0, -6))) continue;
        const info = await lstat(path.join(dir, name));
        if (info.isFile() && info.mtimeMs >= sinceMs && (!best || info.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, name), mtimeMs: info.mtimeMs };
      }
    } catch {}
    return best?.file || null;
  }

  // Codex keeps its rollout open while it writes; otherwise the rollout is the
  // first one created in the process's cwd after it started.
  async function codexTranscript(pids, cwd, startMs, key) {
    if (codexFiles.has(key)) return codexFiles.get(key);
    for (const pid of pids) {
      try {
        const dir = path.join(procRoot, String(pid), 'fd');
        for (const fd of await readdir(dir)) {
          const target = await readlink(path.join(dir, fd)).catch(() => '');
          if (target.startsWith(`${codexDir}/`) && /\/rollout-[^/]+\.jsonl$/.test(target)) { codexFiles.set(key, target); return target; }
        }
      } catch {}
    }
    const days = new Set([startMs, now()].map(ms => { const d = new Date(ms); return path.join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); }));
    let best = null;
    for (const day of days) {
      let names = [];
      try { names = await readdir(path.join(codexDir, day)); } catch { continue; }
      for (const name of names) {
        const match = /^rollout-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)-.+\.jsonl$/.exec(name);
        if (!match) continue;
        const created = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime();
        if (created < startMs - 5000 || (best && created >= best.created)) continue;
        const file = path.join(codexDir, day, name);
        try {
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          let head;
          try { const buffer = Buffer.alloc(16384); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); head = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]; } finally { await handle.close(); }
          if (JSON.parse(head)?.payload?.cwd === cwd) best = { file, created };
        } catch {}
      }
    }
    if (best) codexFiles.set(key, best.file);
    return best?.file || null;
  }

  // Maestri keeps one canvas per workspace in ~/.maestri/workspaces/<id>/
  // workspace.json: its name, every terminal node (canvas name, agent type,
  // command) and the ropes between terminals. A rope goes from the terminal
  // that recruited (terminalIdA) to the recruit (terminalIdB), so a terminal
  // with ropes going out leads that team. Parsed again only when it changed.
  async function maestriCanvas(workspaceId) {
    const file = path.join(home, '.maestri', 'workspaces', workspaceId, 'workspace.json');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) return null;
      const cached = canvasCache.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.canvas;
      const payload = JSON.parse(await readFile(file, 'utf8'))?.payload || {};
      const terminals = new Map();
      for (const node of Array.isArray(payload.nodes) ? payload.nodes : []) {
        const terminal = node?.content?.terminal?._0;
        if (!terminal || typeof terminal.id !== 'string' || !UUID.test(terminal.id)) continue;
        terminals.set(terminal.id.toLowerCase(), {
          name: oneLine(terminal.name).slice(0, 80) || null,
          agentType: typeof terminal.agentType === 'string' ? terminal.agentType.slice(0, 40) : null,
          maestro: terminal.isManager === true,
          command: typeof terminal.command === 'string' ? terminal.command.slice(0, 2000) : '',
        });
      }
      const recruits = new Map(), leader = new Map();
      for (const rope of Array.isArray(payload.connections) ? payload.connections : []) {
        const a = String(rope?.terminalIdA || '').toLowerCase(), b = String(rope?.terminalIdB || '').toLowerCase();
        if (a === b || !terminals.has(a) || !terminals.has(b)) continue;
        if (!recruits.has(a)) recruits.set(a, []);
        recruits.get(a).push(b);
        if (!leader.has(b)) leader.set(b, a);
      }
      const canvas = { name: oneLine(payload.name).slice(0, 80) || null, terminals, recruits, leader };
      canvasCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, canvas });
      return canvas;
    } catch { return null; }
  }

  // Only the two Maestri ids are taken from a process environment.
  async function maestriIds(pid) {
    const ids = {};
    try {
      for (const entry of (await readFile(path.join(procRoot, String(pid), 'environ'), 'utf8')).split('\0')) {
        const match = /^MAESTRI_(WORKSPACE|TERMINAL)_ID=([0-9a-f-]{36})$/i.exec(entry);
        if (match && UUID.test(match[2])) ids[match[1].toLowerCase()] = match[2].toLowerCase();
      }
    } catch { return null; }
    return ids.workspace && ids.terminal ? ids : null;
  }

  // A recruit started with a Maestri role runs inside .maestri/roles/<id>/.
  async function roleName(cwd) {
    const match = /^(.*\/\.maestri\/roles\/[0-9a-f-]{36})(\/|$)/i.exec(cwd || '');
    if (!match) return null;
    try { return oneLine(JSON.parse(await smallFile(path.join(match[1], 'role.json'), 512 * 1024))?.name).slice(0, 80) || null; } catch { return null; }
  }

  // The branch checked out where the agent works, from .git/HEAD (a worktree
  // has a .git file pointing at its own HEAD). Never runs git.
  async function gitBranch(dir, cache) {
    if (!dir) return null;
    if (cache.has(dir)) return cache.get(dir);
    let current = dir, branch = null;
    for (let depth = 0; depth < 16; depth++) {
      const dotgit = path.join(current, '.git');
      let head = null;
      try {
        const info = await lstat(dotgit);
        if (info.isDirectory()) head = path.join(dotgit, 'HEAD');
        else if (info.isFile()) { const match = /^gitdir: (.+)$/m.exec(await smallFile(dotgit, 4096)); if (match) head = path.resolve(current, match[1].trim(), 'HEAD'); }
      } catch {}
      if (head) {
        try {
          const text = (await smallFile(head, 4096)).trim();
          const ref = /^ref: refs\/heads\/(.+)$/.exec(text);
          branch = ref ? ref[1].slice(0, 120) : /^[0-9a-f]{7,64}$/.test(text) ? text.slice(0, 8) : null;
        } catch {}
        break;
      }
      const parent = path.dirname(current);
      if (parent === current || current === home) break;
      current = parent;
    }
    cache.set(dir, branch);
    return branch;
  }

  // A JCode client names its session in ~/.jcode/client_sessions/<pid>,
  // written when it starts; one older than the process belongs to a recycled pid.
  async function jcodeSession(pid, startedAt) {
    try {
      const file = path.join(jcodeDir, 'client_sessions', String(pid));
      const info = await lstat(file);
      if (!info.isFile() || info.size > 512 || (startedAt && info.mtimeMs < startedAt - 5000)) return null;
      const id = (await readFile(file, 'utf8')).trim();
      return JCODE_SESSION.test(id) ? id : null;
    } catch { return null; }
  }

  async function readTail(file, bytes) {
    if (!file) return null;
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const length = Math.min(stat.size, bytes);
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const previous = fileTails.get(file);
      if (previous?.key === key && previous.buffer.length >= length) return { ...previous, text: previous.buffer.subarray(-length).toString('utf8'), cut: stat.size > length };
      let buffer;
      // JSONL grows at the end. Keep bytes (not decoded text) so a UTF-8
      // character or partial JSON record split between writes is preserved.
      let appendOnly = false;
      if (file.endsWith('.jsonl') && previous && previous.ino === stat.ino && previous.dev === stat.dev && stat.size > previous.size && stat.size - previous.size < bytes && previous.buffer.length >= Math.min(previous.size, bytes)) {
        // A truncate/rewrite can keep the same inode and final record. Verify
        // the entire retained window, not just its last bytes, before reusing
        // it. Work remains bounded by bytes even for a huge transcript.
        const checkpoint = Buffer.alloc(previous.buffer.length);
        const { bytesRead } = await handle.read(checkpoint,0,checkpoint.length,previous.size-checkpoint.length);
        appendOnly = bytesRead === checkpoint.length && checkpoint.equals(previous.buffer);
      }
      if (appendOnly) {
        const append = Buffer.alloc(stat.size - previous.size);
        const { bytesRead } = await handle.read(append, 0, append.length, previous.size);
        buffer = Buffer.concat([previous.buffer,append.subarray(0,bytesRead)]).subarray(-length);
      } else {
        buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
        buffer = buffer.subarray(0,bytesRead);
      }
      const result = { buffer, key, ino:stat.ino, dev:stat.dev, cut:stat.size > length, size:stat.size, mtimeMs:stat.mtimeMs };
      fileTails.set(file,result);
      return { ...result, text:buffer.toString('utf8') };
    } catch { return null; } finally { await handle?.close(); }
  }
  const tailLines = tail => { if (!tail) return []; const lines = tail.text.split('\n'); if (tail.cut) lines.shift(); return lines.filter(Boolean); };

  // JCode's recent messages: the journal, plus the end of the snapshot when
  // the journal was just folded into it. Same shape for both.
  async function jcodeLines(info, bytes, need) {
    const journal = await readTail(info.transcript, bytes);
    const lines = tailLines(journal);
    const ids = new Set();
    for (const line of lines) { try { for (const message of JSON.parse(line)?.append_messages || []) if (message?.id) ids.add(message.id); } catch {} }
    let snapshot = null;
    if (ids.size < need || !lines.length) {
      snapshot = await readTail(info.snapshot, bytes);
      if (snapshot) {
        const meta = {};
        const model = /"provider_key":"([^"\\]{1,80})","model":"([^"\\]{1,120})"/.exec(snapshot.text.slice(-65536));
        if (model) { meta.provider_key = model[1]; meta.model = model[2]; }
        const before = jcodeSnapshotLines(snapshot.text).filter(line => !ids.has(JSON.parse(line).append_messages[0].id));
        lines.unshift(...(meta.model ? [JSON.stringify({ meta })] : []), ...before);
      }
    }
    const updatedAt = Math.max(journal?.mtimeMs || 0, snapshot?.mtimeMs || 0) || null;
    return { lines, updatedAt, cut: !!(journal?.cut || snapshot?.cut) };
  }

  // The list reads only the end of each transcript, and again only when it grew.
  async function summarize(info) {
    if (!info.transcript) return null;
    const stats = await Promise.all([info.transcript, info.snapshot].map(async file => { try { const s = await lstat(file || ''); return s.isFile() ? `${s.size}:${s.mtimeMs}` : '-'; } catch { return '-'; } }));
    const key = stats.join('|');
    const cached = summaries.get(info.transcript);
    if (cached && cached.key === key) return cached.summary;
    let lines;
    if (info.format === 'jcode') lines = (await jcodeLines(info, SUMMARY_BYTES, 1)).lines;
    else lines = tailLines(await readTail(info.transcript, SUMMARY_BYTES));
    const summary = transcriptSummary(info.format, lines);
    summaries.set(info.transcript, { key, summary });
    return summary;
  }

  async function mtime(file) { try { const info = await lstat(file); return info.isFile() ? info.mtimeMs : null; } catch { return null; } }

  async function scan() {
    const started = performance.now();
    const scanAt = now();
    const bootAt = await boot();
    const names = (await readdir(procRoot)).filter(name => /^\d+$/.test(name));
    const procs = new Map();
    await Promise.all(names.map(async name => {
      try { const stat = parseStat(await readFile(path.join(procRoot, name, 'stat'), 'utf8')); if (stat) procs.set(stat.pid, stat); } catch {}
    }));
    const windows = await clients();
    const windowByPid = new Map();
    for (const item of windows) windowByPid.set(item.pid, windowByPid.has(item.pid) ? 'shared' : item);
    const ancestors = pid => { const chain = []; let current = procs.get(pid)?.ppid; while (current > 1 && chain.length < 64 && procs.has(current)) { chain.push(procs.get(current)); current = procs.get(current).ppid; } return chain; };
    const children = new Map();
    for (const proc of procs.values()) { if (!children.has(proc.ppid)) children.set(proc.ppid, []); children.get(proc.ppid).push(proc.pid); }
    const toMs = start => bootAt ? Math.round(bootAt + start * 1000 / ticksPerSecond) : null;

    const candidates = [];
    for (const proc of procs.values()) {
      if (!AGENT_NAMES.has(proc.comm) && !WRAPPERS.has(proc.comm) && !proc.comm.startsWith('jcode')) continue;
      const argv = await argvOf(proc.pid);
      const kind = agentKind(proc.comm, argv);
      if (kind) candidates.push({ ...proc, kind, argv, server: agentServer(argv) });
    }
    const agentPids = new Set(candidates.map(item => item.pid));
    // An agent started by another agent (a wrapper, a sub-agent, a server's
    // helper) belongs to it; a shared server is nobody's terminal.
    const agents = candidates.filter(item => !item.server && !ancestors(item.pid).some(parent => agentPids.has(parent.pid)));
    const needsPonte = agents.some(item => ancestors(item.pid).some(parent => parent.comm.startsWith('tmux')));
    const panes = await ponteSessions(needsPonte);

    // Every terminal on a Maestri canvas is a shell the app started with the
    // canvas's two ids. A process elsewhere that inherited ids (a daemon some
    // terminal once started) is not under the app and is not a terminal.
    const maestriShells = new Map();
    for (const proc of procs.values()) {
      const parent = procs.get(proc.ppid);
      if (!parent || !/maestri/i.test(parent.comm) || /maestri/i.test(proc.comm)) continue;
      const ids = await maestriIds(proc.pid);
      if (ids) maestriShells.set(proc.pid, ids);
    }
    const canvases = new Map();
    for (const ids of maestriShells.values()) if (!canvases.has(ids.workspace)) canvases.set(ids.workspace, await maestriCanvas(ids.workspace));
    const liveShellIds = new Set([...maestriShells.values()].map(ids => `${ids.workspace}:${ids.terminal}`));
    const agentIds = new Map();
    for (const agent of agents) {
      const shell = ancestors(agent.pid).find(parent => maestriShells.has(parent.pid));
      const ids = shell ? maestriShells.get(shell.pid) : await maestriIds(agent.pid);
      if (ids) {
        agentIds.set(agent.pid, ids);
        if (!canvases.has(ids.workspace)) canvases.set(ids.workspace, await maestriCanvas(ids.workspace));
      }
    }
    // A restarted app may leave the old shell alive. The new live canvas
    // terminal wins over the orphan with the same ids.
    agents.sort((a,b) => Number(ancestors(b.pid).some(parent => maestriShells.has(parent.pid))) - Number(ancestors(a.pid).some(parent => maestriShells.has(parent.pid))));
    const identity = ids => {
      const canvas = canvases.get(ids.workspace);
      const node = canvas?.terminals.get(ids.terminal);
      if (!canvas || !node) return { workspace: canvas?.name || null, name: null, lead: false, team: 0, reportsTo: null, agentType: null, command: '' };
      const team = (canvas.recruits.get(ids.terminal) || []).length;
      const leader = canvas.leader.get(ids.terminal);
      return { workspaceId: ids.workspace, workspace: canvas.name, name: node.name, maestro: node.maestro, lead: team > 0, team, reportsTo: leader ? canvas.terminals.get(leader)?.name || null : null, agentType: node.agentType, command: node.command };
    };
    const publicMaestri = (value, role) => value ? { workspaceId: value.workspaceId, workspace: value.workspace, name: value.name, maestro: !!value.maestro, lead: value.lead, team: value.team, reportsTo: value.reportsTo, role: role || null } : null;
    const branches = new Map();

    const items = [];
    const usedWindows = new Set();
    const usedShells = new Set();
    const usedMaestriIds = new Set();
    const seen = new Set();
    const summarized = new Set();
    for (const agent of agents) {
      const chain = ancestors(agent.pid);
      const id = `p-${agent.pid}-${agent.start}`;
      seen.add(id);
      const startedAt = toMs(agent.start);
      const cwd = await cwdOf(agent.pid);
      const previous = cpu.get(id);
      cpu.set(id, { ticks: agent.ticks, at: scanAt });
      const cpuShare = previous && scanAt > previous.at ? (agent.ticks - previous.ticks) / ticksPerSecond / ((scanAt - previous.at) / 1000) : null;

      let where = { type: 'none' };
      const host = chain.find(parent => windowByPid.has(parent.pid));
      const paneShell = chain.find(parent => panes.has(parent.pid));
      const shell = chain.find(parent => maestriShells.has(parent.pid));
      const ids = agentIds.get(agent.pid);
      if (ids) {
        const key = `${ids.workspace}:${ids.terminal}`;
        if (!shell && liveShellIds.has(key)) continue;
        if (usedMaestriIds.has(key)) continue;
        usedMaestriIds.add(key);
      }
      if (paneShell) where = { type: 'ponte', session: panes.get(paneShell.pid) };
      else if (host) {
        const win = windowByPid.get(host.pid);
        if (win === 'shared') where = { type: 'window', shared: true };
        else {
          const terminal = TERMINAL_CLASS.test(String(win.class));
          where = { type: /maestri/i.test(String(win.class)) ? 'maestri' : terminal ? 'terminal' : 'app', address: String(win.address), class: String(win.class).slice(0, 100), app: String(win.title || win.class).slice(0, 200), workspace: { id: Number(win.workspace?.id) || 0, name: String(win.workspace?.name ?? '').slice(0, 50) }, monitor: Number.isInteger(win.monitor) ? win.monitor : null };
          if (terminal) usedWindows.add(win.address);
        }
      } else if (shell || chain.some(parent => /maestri/i.test(parent.comm))) where = { type: 'maestri' };
      if (shell && where.type !== 'ponte' && where.type !== 'maestri') where = { type: 'maestri' };
      if (shell) usedShells.add(shell.pid);
      const maestri = ids ? identity(ids) : null;
      const windowTitle = where.type === 'terminal' ? String(windowByPid.get(host.pid).title || '') : '';

      let transcript = null, format = null, session = null, snapshot = null;
      if (agent.kind === 'claude') {
        session = await claudeSession(agent.pid, agent.start);
        format = 'claude';
        if (session) transcript = claudeTranscript(cwd, session.sessionId);
        else if (cwd && agents.filter(other => other.kind === 'claude').length) {
          const sameCwd = [];
          for (const other of agents) if (other.kind === 'claude' && !(await claudeSession(other.pid, other.start)) && await cwdOf(other.pid) === cwd) sameCwd.push(other);
          if (sameCwd.length === 1) transcript = await newestClaudeFile(cwd, startedAt || 0);
        }
      } else if (agent.kind === 'codex' && cwd) {
        format = 'codex';
        const family = [agent.pid, ...(children.get(agent.pid) || [])];
        transcript = await codexTranscript(family, cwd, startedAt || 0, id);
      } else if (agent.kind === 'jcode') {
        const name = await jcodeSession(agent.pid, startedAt);
        if (name) {
          format = 'jcode';
          transcript = path.join(jcodeDir, 'sessions', `${name}.journal.jsonl`);
          snapshot = path.join(jcodeDir, 'sessions', `${name}.json`);
        }
      }
      let written = transcript ? await mtime(transcript) : null;
      if (snapshot) { const other = await mtime(snapshot); if (other !== null && (written === null || other > written)) written = other; }
      if (transcript && written === null) transcript = snapshot = null;
      privateInfo.set(id, { transcript, format, snapshot, sessionId: session?.sessionId || null });
      const summary = transcript ? await summarize({ transcript, format, snapshot }) : null;
      if (transcript) summarized.add(transcript);

      let state, since = null, waitingFor = null;
      // JCode holds a sleep inhibitor ("Jcode is streaming or processing
      // active work") as a child of the client for as long as a turn runs.
      const jcodeBusy = agent.kind === 'jcode' && (children.get(agent.pid) || []).some(pid => procs.get(pid)?.comm === 'systemd-inhibit');
      if (session && ['busy', 'idle', 'waiting'].includes(session.status)) {
        state = { busy: 'working', idle: 'idle', waiting: 'waiting' }[session.status];
        since = Number(session.statusUpdatedAt) || null;
        if (state === 'waiting' && typeof session.waitingFor === 'string') waitingFor = session.waitingFor.slice(0, 80);
      } else if (agent.kind === 'jcode') state = jcodeBusy || summary?.turn === 'working' ? 'working' : 'idle';
      else if (TITLE_WORKING.test(windowTitle)) state = 'working';
      else if (TITLE_IDLE.test(windowTitle)) state = 'idle';
      else if (agent.kind === 'codex' && summary?.turn) state = summary.turn === 'working' ? 'working' : 'idle';
      else state = (cpuShare !== null && cpuShare >= CPU_WORKING) || (written && scanAt - written < RECENT_WRITE_MS) ? 'working' : 'idle';
      // An idle agent that already did something in this process is ready for
      // the next request, not merely stopped. Claude creates its transcript on
      // the first message, so a fresh session has none; a resumed one has an
      // old transcript and counts once it was written or its status moved
      // after this process started. Codex and JCode close a turn explicitly.
      if (state === 'idle' && written !== null && startedAt) {
        if (agent.kind === 'claude' && (written > startedAt || (session && Number(session.statusUpdatedAt) > startedAt))) state = 'ready';
        else if (agent.kind !== 'claude' && summary?.turn === 'done' && written > startedAt) state = 'ready';
      }
      if (!since) since = written || startedAt;

      const detached = !!ids && !shell;
      const headless = detached || agent.argv.some(arg => arg === '-p' || arg === '--print' || arg === 'exec');
      const title = oneLine(windowTitle.replace(TITLE_WORKING, '').replace(TITLE_IDLE, '')) || oneLine(maestri?.name) || oneLine(session?.name) || (cwd ? path.basename(cwd) : agent.kind);
      const launched = modelFromArgv(agent.argv);
      const canvasLaunch = maestri?.command ? modelFromArgv(splitCommand(maestri.command)) : {};
      const modelName = summary?.model || launched.model || canvasLaunch.model || null;
      const model = modelName ? { name: modelName, effort: launched.effort || summary?.effort || canvasLaunch.effort || null, provider: launched.provider || summary?.provider || canvasLaunch.provider || null } : null;
      items.push({
        id, kind: agent.kind, pid: agent.pid, title: clip(title, 200), cwd: shortPath(cwd, home), branch: await gitBranch(cwd, branches), state, waitingFor, since, startedAt, where, headless, detached,
        maestri: publicMaestri(maestri, await roleName(cwd)), model, activity: summary?.activity || null,
        transcript: !!transcript, canReply: where.type === 'ponte' || (where.type === 'terminal' && !!where.address),
      });
    }
    // Maestri terminals with no agent in them (a shell, an ssh session).
    for (const [pid, ids] of maestriShells) {
      if (usedShells.has(pid)) continue;
      const maestri = identity(ids);
      const key = `${ids.workspace}:${ids.terminal}`;
      if (usedMaestriIds.has(key)) continue;
      usedMaestriIds.add(key);
      // Existing APKs whitelist p-/w- ids. Use the shell's pid/start too.
      const id = `p-${pid}-${procs.get(pid).start}`;
      if (!ID.test(id)) continue;
      privateInfo.set(id, { transcript: null, format: null, snapshot: null });
      const cwd = await cwdOf(pid);
      items.push({
        id, kind: 'terminal', pid, title: clip(oneLine(maestri.name) || 'Terminal', 200), cwd: shortPath(cwd, home), branch: null, state: 'terminal', waitingFor: null, since: toMs(procs.get(pid).start), startedAt: toMs(procs.get(pid).start),
        where: { type: 'maestri' }, headless: false, maestri: publicMaestri(maestri, null), model: null, activity: null, transcript: false, canReply: false,
      });
    }
    for (const win of windows) {
      if (!TERMINAL_CLASS.test(String(win.class)) || usedWindows.has(win.address)) continue;
      const id = `w-${String(win.address).replace(/^0x/i, '').toLowerCase()}`;
      if (!ID.test(id)) continue;
      privateInfo.set(id, { transcript: null, format: null, snapshot: null });
      items.push({
        id, kind: 'terminal', pid: win.pid, title: clip(oneLine(win.title) || String(win.class), 200), cwd: '', branch: null, state: 'terminal', waitingFor: null, since: null, startedAt: null,
        where: { type: 'terminal', address: String(win.address), class: String(win.class).slice(0, 100), workspace: { id: Number(win.workspace?.id) || 0, name: String(win.workspace?.name ?? '').slice(0, 50) }, monitor: Number.isInteger(win.monitor) ? win.monitor : null },
        headless: false, maestri: null, model: null, activity: null, transcript: false, canReply: false,
      });
    }
    for (const key of cpu.keys()) if (!seen.has(key)) { cpu.delete(key); codexFiles.delete(key); }
    for (const key of privateInfo.keys()) if (!items.some(item => item.id === key)) privateInfo.delete(key);
    for (const key of summaries.keys()) if (!summarized.has(key)) summaries.delete(key);
    const liveFiles = new Set([...privateInfo.values()].flatMap(info => [info.transcript,info.snapshot]).filter(Boolean));
    for (const key of fileTails.keys()) if (!liveFiles.has(key)) fileTails.delete(key);
    for (const key of transcriptViews.keys()) if (!seen.has(key)) transcriptViews.delete(key);
    const order = { waiting: 0, working: 1, ready: 2, idle: 3, terminal: 4 };
    items.sort((a, b) => order[a.state] - order[b.state] || (b.since || 0) - (a.since || 0));
    // The numbers the phone shows: every agent someone talks to (automated
    // ones apart), how many are mid-turn or waiting, and plain terminals.
    const live = items.filter(item => item.kind !== 'terminal');
    const interactive = live.filter(item => !item.headless);
    const byKind = {};
    for (const item of interactive) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    const counts = {
      agents: interactive.length, automated: live.length - interactive.length,
      working: interactive.filter(item => item.state === 'working').length, waiting: interactive.filter(item => item.state === 'waiting').length,
      terminals: items.length - live.length, maestri: interactive.filter(item => item.maestri).length, byKind,
    };
    lastScanMs = Math.round((performance.now() - started) * 10) / 10;
    return { items, counts, scannedAt: scanAt, scanMs: lastScanMs };
  }

  async function list({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.scannedAt < cacheMs) return cache;
    if (inflight) return inflight;
    inflight = scan().then(result => { cache = result; return result; }).finally(() => { inflight = null; });
    return inflight;
  }

  async function find(id, fresh) {
    if (typeof id !== 'string' || !ID.test(id)) throw new ApiError(404, 'AGENT_NOT_FOUND');
    const item = (await list({ fresh })).items.find(entry => entry.id === id);
    if (!item) throw new ApiError(404, 'AGENT_NOT_FOUND');
    return item;
  }

  async function transcript(id, { since = null, cached = false, fresh = false } = {}) {
    const item = cached ? cache.items.find(item => item.id === id) : await find(id, fresh);
    const info = privateInfo.get(id);
    if (!info?.transcript && !since) return { id,available:false,messages:[],truncated:false,updatedAt:null };
    const stamps = await Promise.all([info?.transcript,info?.snapshot].map(async file => {
      try { const stat = await lstat(file || ''); return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : '-'; } catch { return '-'; }
    }));
    const cursor = createHash('sha256').update(JSON.stringify([id,info?.transcript,info?.snapshot,stamps])).digest('hex').slice(0,32);
    const base = { id,kind:item.kind,title:item.title,state:item.state,cursor,available:!!info?.transcript && stamps.some(stamp => stamp !== '-') };
    if (since === cursor) return { ...base,unchanged:true,messages:[],updatedAt:null,truncated:false };
    if (!base.available) return { ...base,reset:true,messages:[],truncated:false,updatedAt:null };
    const history = transcriptViews.get(id) || [];
    const prior = history.find(view => view.cursor === since);
    const stored = history.find(view => view.cursor === cursor);
    if (stored) return transcriptDelta(base,stored,prior);
    let lines, updatedAt, cut;
    if (info.format === 'jcode') ({ lines, updatedAt, cut } = await jcodeLines(info, TAIL_BYTES, MESSAGE_LIMIT));
    else {
      const tail = await readTail(info.transcript, TAIL_BYTES);
      if (!tail) return { ...base,available:false,reset:true,messages:[],truncated:false,updatedAt:null };
      lines = tailLines(tail); updatedAt = tail.mtimeMs; cut = tail.cut;
    }
    const parsed = (MESSAGE_PARSERS[info.format] || (() => []))(lines);
    const result = lastMessages(parsed);
    const view = { cursor,messages:result.messages,truncated:result.truncated || cut,updatedAt };
    history.push(view);
    if (history.length > 4) history.shift();
    transcriptViews.set(id,history);
    return transcriptDelta(base,view,prior);
  }

  function transcriptDelta(base, view, prior) {
    let overlap = 0;
    if (prior) {
      for (let n = Math.min(prior.messages.length,view.messages.length); n > 0; n--) {
        if (JSON.stringify(prior.messages.slice(-n)) === JSON.stringify(view.messages.slice(0,n))) { overlap = n; break; }
      }
    }
    const reset = !prior || (prior.messages.length > 0 && overlap === 0);
    return { ...base,available:true,reset,messages:reset ? view.messages : view.messages.slice(overlap),truncated:view.truncated,updatedAt:view.updatedAt };
  }

  async function transcriptRead(id,query = {}) {
    // The open conversation only needs its own process and files, not a scan
    // of every process on the PC. Verify pid start so a recycled pid cannot
    // inherit the previous transcript, then use the cached path.
    const item = cache?.items.find(item => item.id === id);
    if (item && privateInfo.get(id)?.transcript && /^p-/.test(id)) {
      const expected = Number(id.split('-')[2]);
      let stat;
      try { stat = parseStat(await readFile(path.join(procRoot,String(item.pid),'stat'),'utf8')); } catch {}
      if (!stat || stat.start !== expected) throw new ApiError(404,'AGENT_NOT_FOUND');
      const info = privateInfo.get(id);
      if (info.format === 'jcode') {
        const session = await jcodeSession(item.pid,item.startedAt);
        if (!session || info.transcript !== path.join(jcodeDir,'sessions',`${session}.journal.jsonl`)) return transcript(id,{...query,fresh:true});
      } else if (info.format === 'claude') {
        const session = await claudeSession(item.pid,expected);
        if ((session?.sessionId || null) !== info.sessionId) return transcript(id,{...query,fresh:true});
      }
      return transcript(id,{...query,cached:true});
    }
    // A new session may create its first transcript after the dialog opens.
    // The list's short cache must not hide that file on the next request.
    return transcript(id,{...query,fresh:!!item && !privateInfo.get(id)?.transcript});
  }

  // Answering an agent in a PC window focuses that window and types there, so
  // the target is resolved again and the focus is verified before any key.
  async function reply(id, value, { desktop, terminals, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'text')) throw new ApiError(400, 'INVALID_TEXT');
    const text = value.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 4000 || /[\u0000-\u001f\u007f]/u.test(text)) throw new ApiError(400, 'INVALID_TEXT');
    const item = await find(id, true);
    if (!item.canReply) throw new ApiError(409, 'AGENT_NOT_INTERACTIVE');
    if (item.where.type === 'ponte') {
      await terminals.input(item.where.session, { text, enter: true });
      return { ok: true, via: 'session' };
    }
    const locked = await runner('omarchy-shell', ['lock', 'isLocked'], { env, timeout: 2500 }).then(out => String(out).trim() === 'true', () => false);
    if (locked) throw new ApiError(423, 'AGENT_PC_LOCKED');
    await desktop.action({ type: 'window.focus', address: item.where.address });
    let focused = false;
    for (let attempt = 0; attempt < 8 && !focused; attempt++) {
      if (attempt) await delay(60);
      try { focused = JSON.parse(await runner('hyprctl', ['-j', 'activewindow'], { env, timeout: 1500 }))?.address === item.where.address; } catch {}
    }
    if (!focused) throw new ApiError(409, 'AGENT_FOCUS_FAILED');
    await desktop.action({ type: 'keyboard.text', text, enter: true });
    return { ok: true, via: 'window' };
  }

  return { list, transcript:transcriptRead, reply, get lastScanMs() { return lastScanMs; } };
}

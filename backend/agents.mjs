import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { readdir, readFile, readlink, lstat, open } from 'node:fs/promises';
import { ApiError, runCommand } from './process.mjs';

// Every terminal and coding agent running on the PC, read from /proc and the
// compositor's client list. Only reads: nothing here writes to a process, a
// transcript or an agent's own files. Typing a reply goes through the same
// desktop and terminal paths the phone already uses.

const AGENT_NAMES = new Set(['claude', 'codex', 'grok', 'opencode', 'gemini', 'pi', 'aider', 'crush', 'goose', 'amp', 'qwen', 'cursor-agent']);
const WRAPPERS = new Set(['node', 'bun', 'deno', 'python', 'python3']);
const TERMINAL_CLASS = /terminal|alacritty|kitty|ghostty|foot|wezterm|konsole|xterm/i;
// Claude Code 2.1.x animates its window title with these two frames while a
// turn runs and shows ✳ when it stops (constants d2/c2 in its bundle).
const TITLE_WORKING = /^[◐◑]\s*/u;
const TITLE_IDLE = /^✳\s*/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^(p-\d{1,10}-\d{1,20}|w-[0-9a-f]{1,32})$/;
const CPU_WORKING = 0.05; // share of one core between two scans
const RECENT_WRITE_MS = 20000;
const TAIL_BYTES = 512 * 1024;
const MESSAGE_LIMIT = 40;
const MESSAGE_CHARS = 3000;
const TRANSCRIPT_BYTES = 96 * 1024;

export function parseStat(text) {
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const fields = text.slice(close + 2).split(' ');
  const pid = Number(text.slice(0, open).trim());
  // Field N of proc(5) is fields[N - 3] once pid and comm are removed.
  return { pid, comm: text.slice(open + 1, close), ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), start: Number(fields[19]) };
}

export function agentKind(comm, argv = []) {
  if (AGENT_NAMES.has(comm)) return comm;
  if (WRAPPERS.has(comm) && argv[1]) {
    const name = path.basename(argv[1]).replace(/\.(c?js|mjs|ts|py)$/, '');
    if (AGENT_NAMES.has(name)) return name;
  }
  return null;
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
  let bootMs = options.bootMs ?? null;
  let cache = null, inflight = null, lastScanMs = 0;
  const cpu = new Map();
  const codexFiles = new Map();
  const privateInfo = new Map();
  const maestriNames = new Map();

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

  // A Maestri terminal's canvas name ("Trilho") is the clearest title. Only the
  // two Maestri ids are taken from the process environment.
  async function maestriName(pid) {
    let ids = {};
    try {
      for (const entry of (await readFile(path.join(procRoot, String(pid), 'environ'), 'utf8')).split('\0')) {
        const match = /^MAESTRI_(WORKSPACE|TERMINAL)_ID=([0-9a-f-]{36})$/i.exec(entry);
        if (match && UUID.test(match[2])) ids[match[1].toLowerCase()] = match[2];
      }
    } catch { return null; }
    if (!ids.workspace || !ids.terminal) return null;
    const file = path.join(home, '.maestri', 'workspaces', ids.workspace, 'workspace.json');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) return null;
      let cached = maestriNames.get(file);
      if (!cached || cached.mtimeMs !== info.mtimeMs) {
        const names = new Map();
        for (const node of JSON.parse(await readFile(file, 'utf8'))?.payload?.nodes || []) {
          const terminal = node?.content?.terminal?._0;
          if (terminal && typeof terminal.id === 'string' && typeof terminal.name === 'string') names.set(terminal.id, terminal.name);
        }
        cached = { mtimeMs: info.mtimeMs, names };
        maestriNames.set(file, cached);
      }
      return cached.names.get(ids.terminal) || null;
    } catch { return null; }
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

    const candidates = [];
    for (const proc of procs.values()) {
      if (!AGENT_NAMES.has(proc.comm) && !WRAPPERS.has(proc.comm)) continue;
      const argv = await argvOf(proc.pid);
      const kind = agentKind(proc.comm, argv);
      if (kind) candidates.push({ ...proc, kind, argv });
    }
    const agentPids = new Set(candidates.map(item => item.pid));
    // An agent started by another agent (a wrapper, a sub-agent) belongs to it.
    const agents = candidates.filter(item => !ancestors(item.pid).some(parent => agentPids.has(parent.pid)));
    const needsPonte = agents.some(item => ancestors(item.pid).some(parent => parent.comm.startsWith('tmux')));
    const panes = await ponteSessions(needsPonte);

    const items = [];
    const usedWindows = new Set();
    const seen = new Set();
    for (const agent of agents) {
      const chain = ancestors(agent.pid);
      const id = `p-${agent.pid}-${agent.start}`;
      seen.add(id);
      const startedAt = bootAt ? Math.round(bootAt + agent.start * 1000 / ticksPerSecond) : null;
      const cwd = await cwdOf(agent.pid);
      const previous = cpu.get(id);
      cpu.set(id, { ticks: agent.ticks, at: scanAt });
      const cpuShare = previous && scanAt > previous.at ? (agent.ticks - previous.ticks) / ticksPerSecond / ((scanAt - previous.at) / 1000) : null;

      let where = { type: 'none' };
      const host = chain.find(parent => windowByPid.has(parent.pid));
      const paneShell = chain.find(parent => panes.has(parent.pid));
      if (paneShell) where = { type: 'ponte', session: panes.get(paneShell.pid) };
      else if (host) {
        const win = windowByPid.get(host.pid);
        if (win === 'shared') where = { type: 'window', shared: true };
        else {
          const terminal = TERMINAL_CLASS.test(String(win.class));
          where = { type: /maestri/i.test(String(win.class)) ? 'maestri' : terminal ? 'terminal' : 'app', address: String(win.address), class: String(win.class).slice(0, 100), app: String(win.title || win.class).slice(0, 200), workspace: { id: Number(win.workspace?.id) || 0, name: String(win.workspace?.name ?? '').slice(0, 50) }, monitor: Number.isInteger(win.monitor) ? win.monitor : null };
          if (terminal) usedWindows.add(win.address);
        }
      } else if (chain.some(parent => /maestri/i.test(parent.comm))) where = { type: 'maestri' };
      const windowTitle = where.type === 'terminal' ? String(windowByPid.get(host.pid).title || '') : '';

      let transcript = null, format = null, session = null;
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
      }
      const written = transcript ? await mtime(transcript) : null;
      if (transcript && written === null) transcript = null;
      privateInfo.set(id, { transcript, format });

      let state, since = null, waitingFor = null;
      if (session && ['busy', 'idle', 'waiting'].includes(session.status)) {
        state = { busy: 'working', idle: 'idle', waiting: 'waiting' }[session.status];
        since = Number(session.statusUpdatedAt) || null;
        if (state === 'waiting' && typeof session.waitingFor === 'string') waitingFor = session.waitingFor.slice(0, 80);
      } else if (TITLE_WORKING.test(windowTitle)) state = 'working';
      else if (TITLE_IDLE.test(windowTitle)) state = 'idle';
      else state = (cpuShare !== null && cpuShare >= CPU_WORKING) || (written && scanAt - written < RECENT_WRITE_MS) ? 'working' : 'idle';
      if (!since) since = written || startedAt;

      const headless = agent.argv.some(arg => arg === '-p' || arg === '--print' || arg === 'exec');
      const canvasName = where.type === 'maestri' ? await maestriName(agent.pid) : null;
      const title = oneLine(windowTitle.replace(TITLE_WORKING, '').replace(TITLE_IDLE, '')) || oneLine(canvasName) || oneLine(session?.name) || (cwd ? path.basename(cwd) : agent.kind);
      items.push({
        id, kind: agent.kind, pid: agent.pid, title: clip(title, 200), cwd: shortPath(cwd, home), state, waitingFor, since, startedAt, where, headless,
        transcript: !!transcript, canReply: where.type === 'ponte' || (where.type === 'terminal' && !!where.address),
      });
    }
    for (const win of windows) {
      if (!TERMINAL_CLASS.test(String(win.class)) || usedWindows.has(win.address)) continue;
      const id = `w-${String(win.address).replace(/^0x/i, '').toLowerCase()}`;
      if (!ID.test(id)) continue;
      privateInfo.set(id, { transcript: null, format: null });
      items.push({
        id, kind: 'terminal', pid: win.pid, title: clip(oneLine(win.title) || String(win.class), 200), cwd: '', state: 'terminal', waitingFor: null, since: null, startedAt: null,
        where: { type: 'terminal', address: String(win.address), class: String(win.class).slice(0, 100), workspace: { id: Number(win.workspace?.id) || 0, name: String(win.workspace?.name ?? '').slice(0, 50) }, monitor: Number.isInteger(win.monitor) ? win.monitor : null },
        headless: false, transcript: false, canReply: false,
      });
    }
    for (const key of cpu.keys()) if (!seen.has(key)) { cpu.delete(key); codexFiles.delete(key); }
    for (const key of privateInfo.keys()) if (!items.some(item => item.id === key)) privateInfo.delete(key);
    const order = { waiting: 0, working: 1, idle: 2, terminal: 3 };
    items.sort((a, b) => order[a.state] - order[b.state] || (b.since || 0) - (a.since || 0));
    lastScanMs = Math.round((performance.now() - started) * 10) / 10;
    return { items, scannedAt: scanAt, scanMs: lastScanMs };
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

  async function transcript(id) {
    const item = await find(id, false);
    const info = privateInfo.get(id);
    if (!info?.transcript) return { id, available: false, messages: [], truncated: false, updatedAt: null };
    let handle, text = '', updatedAt = null, cut = false;
    try {
      handle = await open(info.transcript, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a file');
      updatedAt = stat.mtimeMs;
      const length = Math.min(stat.size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
      text = buffer.subarray(0, bytesRead).toString('utf8');
      cut = stat.size > length;
    } catch { return { id, available: false, messages: [], truncated: false, updatedAt: null }; }
    finally { await handle?.close(); }
    const lines = text.split('\n');
    if (cut) lines.shift();
    const parsed = (info.format === 'codex' ? codexMessages : claudeMessages)(lines.filter(Boolean));
    const result = lastMessages(parsed);
    return { id, kind: item.kind, title: item.title, state: item.state, available: true, messages: result.messages, truncated: result.truncated || cut, updatedAt };
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

  return { list, transcript, reply, get lastScanMs() { return lastScanMs; } };
}

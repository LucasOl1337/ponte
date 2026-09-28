import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, realpath, stat } from 'node:fs/promises';
import { ApiError, commandExists, runCommand } from './process.mjs';

export const TERMINAL_LIMIT = 4;
export const TERMINAL_TEXT_LIMIT = 64 * 1024;
// A coloured capture (format=ansi) keeps its SGR codes, so it gets more room.
export const TERMINAL_ANSI_LIMIT = 192 * 1024;
export const PROJECT_LIMIT = 8;
export const TERMINAL_INPUT_LIMIT = 16000;
const idPattern = /^[a-f0-9]{24}$/;
const panePattern = /^%\d+$/;
const windowPattern = /^@\d+$/;
const hashPattern = /^[A-Za-z0-9_-]{1,64}$/;
const format = '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}\t#{pane_in_mode}';
// The coloured read also asks where the cursor is, relative to the visible
// pane, and whether a full-screen app switched to the alternate screen.
const cursorFormat = `${format}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}`;
// A session can start an agent CLI instead of a bare shell. Only these fixed
// program names run; the phone chooses a key, never a command.
const agents = Object.freeze({ shell: { title: 'Terminal' }, claude: { title: 'Claude', program: 'claude' }, codex: { title: 'Codex', program: 'codex' } });
const titlePattern = /^(Terminal|Claude|Codex) [1-4]$/;
const projectPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
// The agent runs as the pane's own argv (tmux execs it without a shell): the
// program and the prompt are "$@", never parsed as shell text. When the agent
// exits, the pane falls back to the user's login shell instead of vanishing.
const agentLauncher = ['/bin/sh', '-c', '"$@"; exec "${SHELL:-/bin/sh}" -l', 'ponte-agent'];
// Stable key names for the phone, mapped to tmux key names. The keys Claude
// Code and a shell use: Shift+Tab cycles Claude's mode, Ctrl+O/R/T its views.
const keys = Object.freeze({
  Enter: 'Enter', Tab: 'Tab', ShiftTab: 'BTab', Escape: 'Escape', BackSpace: 'BSpace', Delete: 'DC',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage', Interrupt: 'C-c',
  'Ctrl+A': 'C-a', 'Ctrl+D': 'C-d', 'Ctrl+E': 'C-e', 'Ctrl+L': 'C-l', 'Ctrl+O': 'C-o',
  'Ctrl+R': 'C-r', 'Ctrl+T': 'C-t', 'Ctrl+U': 'C-u', 'Ctrl+W': 'C-w', 'Ctrl+Z': 'C-z',
});

function fields(value, names, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw new ApiError(400, code);
}

function dimensions(value, extra = []) {
  fields(value, ['cols', 'rows', ...extra], 'INVALID_TERMINAL_SIZE');
  if (!Number.isInteger(value.cols) || value.cols < 20 || value.cols > 240 || !Number.isInteger(value.rows) || value.rows < 8 || value.rows > 100) throw new ApiError(400, 'INVALID_TERMINAL_SIZE');
  return value;
}

function validText(text) {
  return typeof text === 'string' && text.length >= 1 && text.length <= 4000 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text) && text.isWellFormed();
}

// Typed input may hold line breaks (a request of several lines for an
// agent); every other control character is still refused.
function validInput(text) {
  return typeof text === 'string' && text.length >= 1 && text.length <= TERMINAL_INPUT_LIMIT && !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/u.test(text) && text.isWellFormed();
}

// What a new session starts: which agent, an optional first request, and an
// optional project folder by name. Everything is checked before tmux runs.
function sessionStart(value) {
  const agent = Object.hasOwn(value, 'agent') ? value.agent : 'shell';
  if (typeof agent !== 'string' || !Object.hasOwn(agents, agent)) throw new ApiError(400, 'AGENT_NOT_ALLOWED');
  let prompt;
  if (Object.hasOwn(value, 'prompt')) {
    prompt = value.prompt;
    // An agent receives the request as one argv word, so line breaks are safe
    // there; a shell gets it typed like the composer, one line only. A leading
    // dash would be read by the agent CLI as an option, not as the request.
    const text = typeof prompt === 'string' && agent !== 'shell' ? prompt.replace(/\n/g, ' ') : prompt;
    if (!validText(text) || !prompt.trim() || (agent !== 'shell' && /^\s*-/.test(prompt))) throw new ApiError(400, 'INVALID_PROMPT');
  }
  if (Object.hasOwn(value, 'project') && (typeof value.project !== 'string' || !projectPattern.test(value.project))) throw new ApiError(400, 'PROJECT_NOT_ALLOWED');
  return { agent, prompt, project: value.project };
}

// A capture taken with -e carries tmux's own SGR codes and, since tmux 3.4,
// OSC 8 hyperlinks. Only SGR (colours and attributes) reaches the phone; every
// other escape sequence, string command or control is removed whole, so the
// phone's renderer never sees cursor movement, titles, clipboard or links.
const ansiToken = /\x1b\[([0-9;:]{0,64})m|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|\x1b[\]PX^_][^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|[\x90\x98\x9d\x9e\x9f][^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|\x1b[\x20-\x2f]*[\x30-\x7e]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export function sanitizeAnsi(text) {
  return text.replace(ansiToken, (match, sgr) => sgr === undefined ? '' : match);
}

function validateId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new ApiError(404, 'TERMINAL_NOT_FOUND');
}

function parseCursor(fields) {
  const [x, y, visible, alternate, extra] = fields;
  if (extra !== undefined || !/^\d+$/.test(x || '') || !/^\d+$/.test(y || '') || !/^[01]$/.test(visible || '') || !/^[01]$/.test(alternate || '')) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
  return { cursor: { x: Number(x), y: Number(y), visible: visible === '1' }, alternate: alternate === '1' };
}

function parsePanes(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [name, windowId, paneId, cols, rows, inMode, extra] = line.split('\t');
    if (extra !== undefined || !windowPattern.test(windowId || '') || !panePattern.test(paneId || '') || !/^\d+$/.test(cols || '') || !/^\d+$/.test(rows || '') || !/^[01]$/.test(inMode || '')) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    return { name, windowId, paneId, cols: Number(cols), rows: Number(rows), inMode: inMode === '1' };
  });
}

function socketAlive(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const finish = (error) => {
      client.destroy();
      if (!error) resolve(true);
      else if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(new ApiError(503, 'TERMINAL_UNAVAILABLE'));
    };
    client.setTimeout(1000, () => finish(new Error('timeout')));
    client.once('connect', () => finish());
    client.once('error', finish);
  });
}

// A separate socket and registry keep every target independent of the user's
// existing tmux servers. No command connects to the default tmux socket.
export function createTerminals(dataDir, options = {}) {
  const runner = options.runner || runCommand;
  const exists = options.exists || commandExists;
  const probe = options.probe || socketAlive;
  const env = { ...(options.env || process.env) };
  delete env.TMUX; delete env.TMUX_PANE;
  for (const name of Object.keys(env)) if (name.startsWith('OMARCHY_REMOTE_')) delete env[name];
  const shellDirectory = path.isAbsolute(env.HOME || '') ? env.HOME : os.homedir();
  const projectsDirectory = options.projectsDir || path.join(shellDirectory, 'Projects');
  const directory = path.join(dataDir, 'terminals');
  const socketPath = path.join(directory, 'tmux.sock');
  const registryPath = path.join(directory, 'sessions.json');
  const controller = new AbortController();
  let initialized, registry = [], liveSessionCount = 0, tail = Promise.resolve(), readTail = Promise.resolve(), pending = 0, stopping = false;

  async function privateFile(file, required = false) {
    let info;
    try { info = await lstat(file); } catch (error) { if (!required && error.code === 'ENOENT') return null; throw error; }
    if (info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    return info;
  }

  async function initialize() {
    if (Buffer.byteLength(socketPath) > 100) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await privateFile(directory, true);
    if (!dir.isDirectory() || await realpath(directory) !== path.resolve(directory)) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    const info = await privateFile(registryPath);
    if (!info) return;
    if (!info.isFile() || info.size > 4096) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    const handle = await open(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let saved;
    try { saved = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.sessions) || saved.sessions.length > TERMINAL_LIMIT || saved.sessions.some(item => !item || !idPattern.test(item.id) || !panePattern.test(item.paneId) || !windowPattern.test(item.windowId) || !titlePattern.test(item.title)) || new Set(saved.sessions.map(item => item.id)).size !== saved.sessions.length) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    registry = saved.sessions.map(({ id, title, paneId, windowId }) => ({ id, title, paneId, windowId }));
  }

  async function save() {
    const temporary = `${registryPath}.${randomBytes(6).toString('hex')}`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, sessions: registry })); } finally { await handle.close(); }
    await rename(temporary, registryPath);
  }

  async function command(args, input, maxBuffer = 512 * 1024) {
    if (stopping) throw new ApiError(503, 'SERVER_RESTARTING');
    try {
      return await runner('tmux', ['-u', '-S', socketPath, '-f', '/dev/null', ...args], { env, input, timeout: 2500, maxBuffer, signal: controller.signal });
    } catch { throw new ApiError(503, stopping ? 'SERVER_RESTARTING' : 'TERMINAL_UNAVAILABLE'); }
  }

  async function discardNewSession(id) {
    validateId(id);
    // A new-session response may be interrupted after the shell was created.
    // This cleanup must outlive the aborted request and finish before close.
    await runner('tmux', ['-u', '-S', socketPath, '-f', '/dev/null', 'kill-session', '-t', `=ponte_${id}`], { env, timeout: 2500, maxBuffer: 16 * 1024 }).catch(() => {});
  }

  // Two lanes: commands that change a session (create, input, resize, remove)
  // run one at a time in order; reads and listings run in their own lane, so
  // typed input never waits behind the phone's output polling. The read lane
  // never rewrites the registry.
  async function run(callback, lane = 'write') {
    if (stopping) throw new ApiError(503, 'SERVER_RESTARTING');
    if (pending >= 12) throw new ApiError(429, 'OPERATION_BUSY');
    pending++;
    const result = (lane === 'read' ? readTail : tail).then(async () => {
      if (stopping) throw new ApiError(503, 'SERVER_RESTARTING');
      if (!await exists('tmux', env)) return callback(false);
      initialized ||= initialize();
      await initialized;
      const socketInfo = await privateFile(socketPath);
      if (socketInfo && !socketInfo.isSocket()) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
      return callback(true);
    });
    if (lane === 'read') readTail = result.catch(() => {}); else tail = result.catch(() => {});
    try { return await result; } finally { pending--; }
  }

  async function sessions(prune = true) {
    const panes = await probe(socketPath) ? parsePanes(await command(['-N', 'list-panes', '-a', '-F', format])) : [];
    const remaining = registry.filter(item => panes.some(pane => pane.name === `ponte_${item.id}`));
    if (prune) {
      liveSessionCount = new Set(panes.map(pane => pane.name)).size;
      if (remaining.length !== registry.length) { registry = remaining; await save(); }
    }
    return remaining.map(item => {
      const matches = panes.filter(pane => pane.name === `ponte_${item.id}`);
      const pane = matches.length === 1 && matches[0];
      const valid = pane && pane.paneId === item.paneId && pane.windowId === item.windowId;
      return { ...item, valid, cols: valid ? pane.cols : 0, rows: valid ? pane.rows : 0, inMode: valid ? pane.inMode : false };
    });
  }

  async function target(id, available, prune = true) {
    if (!available) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
    const item = (await sessions(prune)).find(item => item.id === id);
    if (!item) throw new ApiError(404, 'TERMINAL_NOT_FOUND');
    if (!item.valid) throw new ApiError(409, 'TERMINAL_CHANGED');
    return item;
  }

  const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
  const summary = ({ id, title, cols, rows, inMode }) => ({
    id, title, cols, rows, inMode,
    attachCommand: `env -u TMUX -u TMUX_PANE tmux -u -S ${shellQuote(socketPath)} -f /dev/null attach-session -t ${shellQuote(`=ponte_${id}`)}`,
  });

  // A project is a direct child folder of ~/Projects, after resolving links.
  async function projectDirectory(name) {
    if (name === undefined) return shellDirectory;
    try {
      const parent = await realpath(projectsDirectory);
      const resolved = await realpath(path.join(parent, name));
      if (path.dirname(resolved) === parent && (await stat(resolved)).isDirectory()) return resolved;
    } catch {}
    throw new ApiError(400, 'PROJECT_NOT_ALLOWED');
  }

  async function sendToPane(item, args) {
    // -F tests a tmux format, without invoking a shell. The command branches
    // contain only fixed words and verified pane IDs, never input text.
    const output = await command(['if-shell', '-F', '-t', item.paneId, '#{pane_in_mode}', 'display-message -p PONTE_INPUT_BLOCKED', args.join(' ')]);
    if (output.trim() === 'PONTE_INPUT_BLOCKED') throw new ApiError(409, 'TERMINAL_IN_COPY_MODE');
    if (output.trim() === 'PONTE_NO_BRACKETED_PASTE') throw new ApiError(409, 'MULTILINE_NOT_SUPPORTED');
    if (output.trim()) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
  }

  async function pasteText(item, text, enter) {
    // One character is typed as a key, not pasted: a TUI in bracketed-paste
    // mode takes a pasted "1" as text, never as the answer to its 1/2/3 menu.
    // Its UTF-8 bytes go as hex words, so no input text reaches tmux parsing.
    if ([...text].length === 1 && text !== '\n') {
      await sendToPane(item, ['send-keys', '-H', '-t', item.paneId, ...[...Buffer.from(text)].map(byte => byte.toString(16).padStart(2, '0'))]);
      if (enter) await sendToPane(item, ['send-keys', '-t', item.paneId, 'Enter']);
      return;
    }
    // Serialized operations reuse one private buffer, so an interrupted
    // client cannot accumulate unbounded named tmux buffers.
    const buffer = 'ponte_input';
    try {
      await command(['load-buffer', '-b', buffer, '-'], text);
      const paste = ['paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', item.paneId];
      // Several lines go only to a program that asked for bracketed paste right
      // now (a prompt reading input): it receives them as one paste. Without
      // it a shell would run each line as it arrives. The flag is tested in
      // the same tmux command as the paste, so it cannot change in between.
      // (Quoted: in a tmux command string an unquoted # starts a comment.)
      if (text.includes('\n')) await sendToPane(item, ['if-shell', '-F', '-t', item.paneId, "'#{bracket_paste_flag}'", '{', ...paste, '}', '{', 'display-message', '-p', 'PONTE_NO_BRACKETED_PASTE', '}']);
      else await sendToPane(item, paste);
      if (enter) await sendToPane(item, ['send-keys', '-t', item.paneId, 'Enter']);
    }
    catch (error) { await command(['delete-buffer', '-b', buffer]).catch(() => {}); throw error; }
  }
  // The coloured read: one tmux call checks the pane, reads the cursor and
  // captures with -e. The ansi text is cut at a line boundary; tmux closes
  // every line's attributes itself, so no line depends on an earlier one.
  function readAnsi(id, since) {
    return run(async available => {
      if (!available) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
      let item = registry.find(entry => entry.id === id), result;
      const capture = async paneId => {
        const output = await command(['display-message', '-p', '-t', paneId, cursorFormat, ';', 'capture-pane', '-p', '-e', '-t', paneId, '-S', '-1000'], undefined, 4 * 1024 * 1024);
        const newline = output.indexOf('\n');
        if (newline < 0) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
        const fields = output.slice(0, newline).split('\t');
        const [pane, extra] = parsePanes(fields.slice(0, 6).join('\t'));
        return { pane, extra, ...parseCursor(fields.slice(6)), capture: output.slice(newline + 1) };
      };
      const matches = (read, entry) => !read.extra && read.pane.name === `ponte_${id}` && read.pane.paneId === entry.paneId && read.pane.windowId === entry.windowId;
      if (item) {
        try { const read = await capture(item.paneId); if (matches(read, item)) result = read; } catch {}
      }
      if (!result) {
        item = await target(id, available, false);
        result = await capture(item.paneId);
        if (!matches(result, item)) throw new ApiError(409, 'TERMINAL_CHANGED');
      }
      item = { ...item, cols: result.pane.cols, rows: result.pane.rows, inMode: result.pane.inMode };
      const bytes = Buffer.from(sanitizeAnsi(result.capture));
      const offset = bytes.length > TERMINAL_ANSI_LIMIT ? bytes.indexOf(0x0a, bytes.length - TERMINAL_ANSI_LIMIT - 1) + 1 : 0;
      const text = offset > 0 ? bytes.subarray(offset).toString('utf8') : offset === 0 && bytes.length <= TERMINAL_ANSI_LIMIT ? bytes.toString('utf8') : '';
      const { cursor, alternate } = result;
      // The hash covers the cursor too: a cursor that moved is a change.
      const hash = createHash('sha256').update(`${text}\u0000${cursor.x},${cursor.y},${cursor.visible ? 1 : 0},${alternate ? 1 : 0}`).digest('base64url').slice(0, 22);
      const answer = { ...summary(item), cursor, alternate, hash };
      return since === hash ? { ...answer, unchanged: true } : { ...answer, text };
    }, 'read');
  }

  return {
    // The most recently changed project folders, by name only, for the phone
    // to offer as the new session's folder. It never needs tmux.
    async projects() {
      let parent, entries;
      try { parent = await realpath(projectsDirectory); entries = await readdir(parent, { withFileTypes: true }); } catch { return { projects: [] }; }
      const dated = await Promise.all(entries.filter(entry => entry.isDirectory() && projectPattern.test(entry.name)).map(async entry => {
        try { return { name: entry.name, changed: (await stat(path.join(parent, entry.name))).mtimeMs }; } catch { return null; }
      }));
      return { projects: dated.filter(Boolean).sort((a, b) => b.changed - a.changed || a.name.localeCompare(b.name)).slice(0, PROJECT_LIMIT).map(item => item.name) };
    },
    list() {
      return run(async available => ({ available, sessions: available ? (await sessions(false)).filter(item => item.valid).map(summary) : [], limit: TERMINAL_LIMIT }), 'read');
    },
    create(value) {
      const { cols, rows } = dimensions(value, ['agent', 'prompt', 'project']);
      const start = sessionStart(value);
      const { program } = agents[start.agent];
      return run(async available => {
        if (!available) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
        await sessions();
        if (liveSessionCount >= TERMINAL_LIMIT) throw new ApiError(409, 'TERMINAL_LIMIT_REACHED');
        const directory = await projectDirectory(start.project);
        if (program && !await exists(program, env)) throw new ApiError(503, 'AGENT_UNAVAILABLE', { agent: agents[start.agent].title });
        const id = randomBytes(12).toString('hex');
        // One number per slot, whatever runs in it: Claude 1, Terminal 2, Codex 3.
        const number = [1, 2, 3, 4].find(number => !registry.some(item => item.title.endsWith(` ${number}`)));
        const title = `${agents[start.agent].title} ${number}`;
        const launch = program ? ['--', ...agentLauncher, program, ...(start.prompt === undefined ? [] : [start.prompt])] : [];
        let pane;
        try {
          const output = await command([
            'start-server', ';', 'set-option', '-g', 'set-clipboard', 'off',
            ';', 'set-option', '-g', 'history-limit', '1000', ';', 'set-option', '-g', 'status', 'off',
            ';', 'new-session', '-d', '-P', '-F', format, '-s', `ponte_${id}`, '-n', 'terminal', '-c', directory, '-x', String(cols), '-y', String(rows), ...launch,
          ]);
          const parsed = parsePanes(output);
          [pane] = parsed;
          if (parsed.length !== 1 || pane.name !== `ponte_${id}`) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
          registry.push({ id, title, paneId: pane.paneId, windowId: pane.windowId });
          await save();
          // A shell's first line is typed like the composer does; the pty holds
          // it until the shell reads its input, then Enter runs it.
          if (!program && start.prompt !== undefined) await pasteText(pane, start.prompt, true);
        } catch (error) {
          registry = registry.filter(item => item.id !== id);
          await discardNewSession(id);
          throw error;
        }
        return summary({ id, title, ...pane });
      });
    },
    // `since` is the hash of the text the phone already shows: when nothing
    // changed only the hash comes back, not up to 64 KiB of the same text.
    // format=ansi keeps the colours (SGR only) and adds the cursor and the
    // alternate-screen flag; without it the answer is the plain text as always.
    read(id, options = {}) {
      validateId(id);
      const since = typeof options.since === 'string' && hashPattern.test(options.since) ? options.since : null;
      if (options.format === 'ansi') return readAnsi(id, since);
      return run(async available => {
        if (!available) throw new ApiError(503, 'TERMINAL_UNAVAILABLE');
        let item = registry.find(entry => entry.id === id), capture;
        if (item) {
          // One tmux call proves the pane still belongs to this session and
          // captures it; anything unexpected takes the full listing below.
          try {
            const output = await command(['display-message', '-p', '-t', item.paneId, format, ';', 'capture-pane', '-p', '-t', item.paneId, '-S', '-1000']);
            const newline = output.indexOf('\n');
            const [pane, extra] = parsePanes(output.slice(0, newline));
            if (newline > 0 && !extra && pane.name === `ponte_${id}` && pane.paneId === item.paneId && pane.windowId === item.windowId) {
              item = { ...item, cols: pane.cols, rows: pane.rows, inMode: pane.inMode };
              capture = output.slice(newline + 1);
            }
          } catch {}
        }
        if (capture === undefined) {
          item = await target(id, available, false);
          capture = await command(['capture-pane', '-p', '-t', item.paneId, '-S', '-1000']);
        }
        const clean = capture.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
        const bytes = Buffer.from(clean);
        let offset = Math.max(0, bytes.length - TERMINAL_TEXT_LIMIT);
        while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
        const text = bytes.subarray(offset).toString('utf8');
        const hash = createHash('sha256').update(text).digest('base64url').slice(0, 22);
        return since === hash ? { ...summary(item), hash, unchanged: true } : { ...summary(item), hash, text };
      }, 'read');
    },
    input(id, value) {
      validateId(id);
      fields(value, ['text', 'key', 'enter'], 'INVALID_TERMINAL_INPUT');
      const textInput = Object.hasOwn(value, 'text');
      const keyInput = Object.hasOwn(value, 'key');
      // Exactly one of text/key; `enter` is an optional flag that goes with text
      // so the phone can paste a command AND run it in one serialized operation,
      // instead of a separate keypress that a busy client could drop.
      if (textInput === keyInput) throw new ApiError(400, 'INVALID_TERMINAL_INPUT');
      if (keyInput && Object.hasOwn(value, 'enter')) throw new ApiError(400, 'INVALID_TERMINAL_INPUT');
      if (Object.hasOwn(value, 'enter') && typeof value.enter !== 'boolean') throw new ApiError(400, 'INVALID_TERMINAL_INPUT');
      if (textInput && !validInput(value.text)) throw new ApiError(400, 'TERMINAL_TEXT_INVALID');
      if (keyInput && (typeof value.key !== 'string' || !Object.hasOwn(keys, value.key))) throw new ApiError(400, 'KEY_NOT_ALLOWED');
      return run(async available => {
        const item = await target(id, available);
        if (item.inMode) throw new ApiError(409, 'TERMINAL_IN_COPY_MODE');
        if (textInput) await pasteText(item, value.text, value.enter === true);
        else await sendToPane(item, ['send-keys', '-t', item.paneId, keys[value.key]]);
        return { ok: true };
      });
    },
    resize(id, value) {
      validateId(id);
      const { cols, rows } = dimensions(value);
      return run(async available => {
        const item = await target(id, available);
        await command(['resize-window', '-t', item.windowId, '-x', String(cols), '-y', String(rows)]);
        return { ok: true };
      });
    },
    remove(id) {
      validateId(id);
      return run(async available => {
        await target(id, available);
        await command(['kill-session', '-t', `=ponte_${id}`]);
        registry = registry.filter(item => item.id !== id); await save();
        return { ok: true };
      });
    },
    close() { stopping = true; controller.abort(); return Promise.all([tail, readTail]); },
  };
}

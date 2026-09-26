#!/usr/bin/env node
// Public agent interface. Transport and command metadata stay separate so help,
// validation and dry runs never initialize the desktop or read pairing secrets.
import { readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { COMMANDS, ACTIONS, validateParams, validateAction } from './ctl-catalog.mjs';
import { CliError, createClient, validateOrigin } from './ctl-client.mjs';
import { loadSettings } from '../backend/config.mjs';
import { validateDictationAudio } from '../backend/stt.mjs';

const globals = {
  url: { type: 'string', description: 'HTTP loopback or verified HTTPS origin.' },
  'token-file': { type: 'string', description: 'Private pairing-token file, never the token itself.' },
  'ca-file': { type: 'string', description: 'PEM CA for remote HTTPS.' },
  timeout: { type: 'integer', min: 1, max: 120000, description: 'Whole HTTP request deadline in milliseconds (default 15000).' },
  'dry-run': { type: 'boolean', description: 'Validate and print a redacted request without connecting.' },
  yes: { type: 'boolean', description: 'Confirm a destructive operation without a prompt.' },
  pretty: { type: 'boolean', description: 'Indent the JSON envelope.' },
  json: { type: 'boolean', description: 'JSON is the default. With help, return the command catalog.' },
  help: { type: 'boolean', description: 'Show help without reading configuration or connecting.' },
};
const exitCodes = { success: 0, internal: 1, usage: 2, connection: 3, timeout: 4, authentication: 5, api: 6, interrupted: 130 };
const actionInput = 'action TYPE --data JSON | --stdin | --file JSON_FILE';
const legacy = ['setup', 'install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'doctor', 'renew-cert', 'pair', 'serve', 'android-config', 'pc', 'phone'];
const fail = message => { throw new CliError('USAGE', message, 2); };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let pretty = process.argv.includes('--pretty');
let mutation = false;

function emit(value) { process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...value }, null, pretty ? 2 : undefined)}\n`); }

function parse(argv) {
  const booleans = new Set(['stdin', ...Object.entries(globals).filter(([, p]) => p.type === 'boolean').map(([name]) => name)]);
  for (const command of COMMANDS) for (const [name, p] of Object.entries(command.params)) if (p.type === 'boolean') booleans.add(name);
  const words = [], opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '-h') arg = '--help';
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) fail('Short options are not supported except -h. Use --option=value for values beginning with a dash.');
      words.push(arg); continue;
    }
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    if (!/^[a-z][a-z0-9-]*$/.test(name) || Object.hasOwn(opts, name)) fail('Invalid or repeated option. Use each --option once.');
    let value = equals < 0 ? undefined : arg.slice(equals + 1);
    if (value === undefined && booleans.has(name)) {
      value = ['true', 'false'].includes(argv[i + 1]) ? argv[++i] : true;
    } else if (value === undefined) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) fail(`--${name} needs a value.`);
      value = argv[++i];
    }
    opts[name] = value;
  }
  const rawGlobals = {};
  for (const name of Object.keys(globals)) if (Object.hasOwn(opts, name)) { rawGlobals[name] = opts[name]; delete opts[name]; }
  const options = validateParams({ name: 'global options', params: globals }, rawGlobals);
  pretty = options.pretty === true;
  return { words, opts, options };
}

function findCommand(words) { return COMMANDS.find(command => command.name === words.join(' ')); }

function help(words, json = false) {
  const generic = words[0] === 'action';
  const exact = generic ? ACTIONS.get(words[1]) : findCommand(words);
  if (generic && (words.length > 2 || (words[1] && !exact))) fail('Unknown action type. Run ponte ctl schema.');
  const commands = generic ? exact ? [exact] : COMMANDS.filter(c => c.action)
    : words.length ? COMMANDS.filter(c => c.name === words.join(' ') || c.name.startsWith(`${words.join(' ')} `)) : COMMANDS;
  if (words.length && !commands.length && !['action', 'schema', 'config', 'version'].includes(words.join(' '))) fail('Unknown command. Run ponte ctl help.');
  if (json) { emit({ ok: true, data: { commands, globals, exitCodes, actionInput, legacy } }); return; }
  const lines = ['Usage: ponte ctl [global options] <command> [--parameter value]', '',
    'JSON on stdout, including failures. No prompts, no automatic retries.',
    'Use a lab server for input, capture and power tests, not the owner\'s desktop.', ''];
  if (!words.length) lines.push('Offline: help [command], schema [command], config, version',
    'Generic action: action TYPE --data JSON | --stdin | --file JSON_FILE',
    'Text input: --text VALUE | --stdin | --file TEXT_FILE (unlock: --stdin only)', '');
  if (generic) lines.push(`Generic action: ${actionInput}`,
    'JSON uses the original backend fields listed below, not CLI flags.',
    'Passwords only through JSON stdin. Destructive actions still require --yes.',
    ...(exact ? [`Action type: ${words[1]}`] : ['Types: ' + [...ACTIONS.keys()].join(', ')]), '');
  for (const command of commands) {
    lines.push(`  ${command.name.padEnd(24)} ${command.description}${command.confirm ? ' [requires --yes]' : ''}`);
    if (exact) for (const [name, spec] of Object.entries(command.params)) {
      if (name === 'password') { lines.push('    --stdin required (password only through stdin, never --password)'); continue; }
      const constraint = spec.enum ? ` choices=${spec.enum.join('|')}` : `${spec.min !== undefined ? ` min=${spec.min}` : ''}${spec.max !== undefined ? ` max=${spec.max}` : ''}`;
      lines.push(`    --${name} <${spec.type}>${spec.required ? ' required' : ''}${spec.default !== undefined ? ` default=${spec.default}` : ''}${constraint}`);
    }
    if (exact && command.params.text) lines.push('    --stdin or --file PATH may replace --text (choose exactly one source)');
  }
  lines.push('', 'Global options:');
  for (const [name, spec] of Object.entries(globals)) lines.push(`  --${name.padEnd(14)} ${spec.description}`);
  lines.push('', 'See docs/cli.md for safety, files, exit codes and examples.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function readInputFile(file, maxBytes) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail(`Input must be a regular file of at most ${maxBytes} bytes.`);
    // Limit each read too: a concurrently growing file must not bypass stat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > maxBytes) fail(`Input exceeds ${maxBytes} bytes.`);
    return buffer.subarray(0, count);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('INPUT_FILE', 'Could not read a regular input file. Check the path and permissions.', 2);
  } finally { await handle?.close(); }
}

async function stdin(maxBytes = 24 * 1024) {
  if (process.stdin.isTTY) fail('Pipe input through stdin. Interactive prompts are not supported.');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const finish = (error) => {
      clearTimeout(timer); process.stdin.pause(); process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', broken);
      controller.signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const data = chunk => { size += chunk.length; if (size > maxBytes) finish(new CliError('USAGE', 'Stdin exceeds the input limit.', 2)); else chunks.push(chunk); };
    const end = () => finish();
    const broken = () => finish(new CliError('USAGE', 'Could not read stdin.', 2));
    const cancel = () => finish(new CliError('INTERRUPTED', 'Command interrupted.', 130));
    const timer = setTimeout(() => finish(new CliError('TIMEOUT', 'Stdin was not closed within 15 seconds.', 4)), 15000);
    process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.once('error', broken);
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
  });
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { fail('Invalid JSON input. Provide one JSON object.'); }
}

async function actionRequest(words, opts, options) {
  if (words.length !== 2 || !ACTIONS.has(words[1])) fail('Unknown action type. Run ponte ctl schema.');
  const command = ACTIONS.get(words[1]);
  if (command.confirm && !options.yes && !options['dry-run']) throw new CliError('CONFIRMATION_REQUIRED', 'This command requires --yes. Inspect it with --dry-run first.', 2);
  const values = validateParams({ name: 'action', params: { data: { type: 'string' }, file: { type: 'string' }, stdin: { type: 'boolean' } } }, opts);
  if ([values.data !== undefined, values.file !== undefined, values.stdin === true].filter(Boolean).length !== 1) fail('Choose exactly one action input: --data JSON, --file FILE, or --stdin.');
  if (words[1] === 'session.unlock' && !values.stdin) fail('Unlock passwords are accepted only through stdin, never argv or files.');
  const value = parseJSON(values.stdin ? await stdin() : values.file ? (await readInputFile(values.file, 24 * 1024)).toString('utf8') : values.data);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Action data must be an object.');
  if (Object.hasOwn(value, 'type') && value.type !== words[1]) fail('Action data type does not match the requested action.');
  return { command, request: { method: 'POST', path: '/api/action', body: validateAction({ ...value, type: words[1] }) } };
}

async function namedRequest(command, opts, dryRun) {
  const raw = { ...opts };
  const hasText = Object.hasOwn(command.params, 'text');
  const unlock = command.action === 'session.unlock';
  if (Object.hasOwn(raw, 'stdin')) {
    if (!hasText && !unlock) fail('--stdin is not supported by this command.');
    if (![true, 'true'].includes(raw.stdin)) fail('--stdin must be enabled when supplied.');
    if (Object.hasOwn(raw, 'text') || Object.hasOwn(raw, 'password') || Object.hasOwn(raw, 'file')) fail('Choose one input source.');
    let text = await stdin();
    if (unlock || command.name === 'terminals input') text = text.replace(/\r?\n$/, '');
    raw[unlock ? 'password' : 'text'] = text;
    delete raw.stdin;
  } else if (unlock) fail('Unlock requires --stdin. Passwords must not appear in argv.');
  if (hasText && Object.hasOwn(raw, 'file')) {
    if (Object.hasOwn(raw, 'text')) fail('Choose one input source.');
    let text = (await readInputFile(raw.file, 24 * 1024)).toString('utf8');
    if (command.name === 'terminals input') text = text.replace(/\r?\n$/, '');
    raw.text = text; delete raw.file;
  }
  const values = validateParams(command, raw);
  const request = { method: command.method, path: command.path };
  if (command.name === 'health') request.auth = false;
  const fields = {};
  for (const [name, value] of Object.entries(values)) {
    if (request.path.includes(`:${name}`)) { request.path = request.path.replace(`:${name}`, encodeURIComponent(String(value))); continue; }
    if (['output', 'file', 'mime', 'seconds'].includes(name)) continue;
    fields[command.params[name].field || name] = value;
  }
  if (command.kind === 'action' || command.action) request.body = validateAction({ type: command.action, ...fields });
  else if (command.kind === 'upload') {
    const mime = values.mime || ({ '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav' })[path.extname(values.file).toLowerCase()];
    if (!mime) fail('Unknown audio extension. Use --mime audio/webm|audio/ogg|audio/mp4|audio/wav.');
    request.contentType = mime;
    if (Object.hasOwn(fields, 'enter')) fields.enter = fields.enter ? '1' : '0';
    const query = new URLSearchParams(fields).toString();
    if (query) request.path += `?${query}`;
    if (dryRun) request.body = { file: path.resolve(values.file), contentType: mime };
    else {
      request.body = await readInputFile(values.file, 25 * 1024 * 1024);
      try { validateDictationAudio(request.body, mime); } catch { fail('Audio file does not match a supported audio MIME/signature or size.'); }
    }
  } else if (command.method === 'GET') {
    const query = new URLSearchParams(fields).toString();
    if (query) request.path += `?${query}`;
  } else if (Object.keys(fields).length) request.body = fields;
  if (values.output !== undefined) {
    if (values.output === '-') fail('--output must be a file path. Binary stdout is not supported.');
    if (/[\u0000-\u001f\u007f]/.test(values.output)) fail('--output must not contain control characters.');
    request.output = values.output;
  }
  if (command.kind === 'stream') request.durationMs = Math.round(values.seconds * 1000);
  return request;
}

function redacted(request) {
  const safe = { ...request };
  if (safe.body && !Buffer.isBuffer(safe.body)) {
    safe.body = { ...safe.body };
    for (const key of ['password', 'text']) if (Object.hasOwn(safe.body, key)) safe.body[key] = '[REDACTED]';
  }
  return safe;
}

async function main() {
  const { words, opts, options } = parse(process.argv.slice(2));
  if (options.url !== undefined) validateOrigin(options.url);
  if (!words.length || words[0] === 'help' || options.help) {
    if (Object.keys(opts).length) fail('Unexpected help option.');
    help(words[0] === 'help' ? words.slice(1) : words, options.json); return;
  }
  if (['schema', 'version', 'config'].includes(words[0])) {
    if (Object.keys(opts).length) fail('Unexpected local-command option.');
    if (words[0] !== 'schema' && words.length !== 1) fail('Unexpected argument.');
    if (words[0] === 'schema') {
      const generic = words[1] === 'action';
      if (generic && words.length > 3) fail('Unexpected argument.');
      const commands = generic ? words[2] ? [ACTIONS.get(words[2])] : COMMANDS.filter(c => c.action)
        : words.length > 1 ? [findCommand(words.slice(1))] : COMMANDS;
      if (commands.some(c => !c)) fail('Unknown command for schema.');
      emit({ ok: true, data: { commands, globals, exitCodes, actionInput, legacy } });
    } else if (words[0] === 'version') {
      const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      emit({ ok: true, data: { name: 'Ponte', version: pkg.version, cliSchemaVersion: 1 } });
    } else {
      const settings = await loadSettings().catch(() => {
        throw new CliError('CONFIG_ERROR', 'Cannot load Ponte settings. Check the private config path, format and permissions.', 2);
      });
      emit({ ok: true, data: { configFile: settings.configFile, dataDir: settings.dataDir, http: settings.http, nativeTls: settings.nativeTls ? { host: settings.nativeTls.host, port: settings.nativeTls.port, caFile: settings.nativeTls.caFile } : null } });
    }
    return;
  }
  let command, request;
  if (words[0] === 'action') ({ command, request } = await actionRequest(words, opts, options));
  else {
    command = findCommand(words);
    if (!command) fail('Unknown command. Run ponte ctl help or ponte ctl schema.');
    // Refuse a destructive command before reading files/stdin or connecting.
    if (command.confirm && !options.yes && !options['dry-run']) throw new CliError('CONFIRMATION_REQUIRED', 'This command requires --yes. Inspect it with --dry-run first.', 2);
    request = await namedRequest(command, opts, options['dry-run']);
  }
  if (options['dry-run']) { emit({ ok: true, data: { dryRun: true, requiresConfirmation: !!command.confirm, ...redacted(request) } }); return; }
  if (command.confirm && !options.yes) throw new CliError('CONFIRMATION_REQUIRED', 'This command requires --yes. Inspect it with --dry-run first.', 2);
  const client = await createClient({ url: options.url, tokenFile: options['token-file'], caFile: options['ca-file'], timeout: options.timeout ?? Math.max(15000, (request.durationMs || 0) + 5000), signal: controller.signal });
  mutation = request.method !== 'GET';
  const result = await client.request(request);
  if (command.select && !Object.hasOwn(result, command.select)) throw new CliError('INVALID_RESPONSE', 'Server response is missing the requested state field.', 6);
  emit({ ok: true, data: command.select ? result[command.select] : result });
}

try { await main(); }
catch (error) {
  const interrupted = controller.signal.aborted;
  const code = interrupted ? 'INTERRUPTED' : (error.code || 'CLI_ERROR');
  const exitCode = interrupted ? 130 : (error.exitCode || 1);
  const ambiguous = mutation && (interrupted || [3, 4].includes(exitCode));
  emit({ ok: false, error: { code, message: `${interrupted ? 'Command interrupted.' : error.message || 'CLI failed.'}${ambiguous ? ' The operation may have reached the server. Inspect state before retrying.' : ''}`, ...(error.status ? { status: error.status } : {}) } });
  process.exitCode = exitCode;
}

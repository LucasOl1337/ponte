// Pure CLI metadata and validation. Keep this module independent of the server:
// importing a command catalog must never open files or control the desktop.
// Patterns are strings so `ctl schema` can serialize the same restrictions.
const string = (options = {}) => ({ type: 'string', ...options });
const number = (min, max, options = {}) => ({ type: 'number', min, max, ...options });
const integer = (min, max, options = {}) => ({ type: 'integer', min, max, ...options });
const boolean = (options = {}) => ({ type: 'boolean', ...options });
const required = { required: true };
const end = String.raw`(?![\s\S])`;
const monitor = string({ maxLength: 150, pattern: String.raw`^[^\u0000-\u001f\u007f]+${end}` });
const dpmsMonitor = string({
  ...monitor,
  pattern: String.raw`^[^\s;&|\x60$><()"\\\u0000-\u001f\u007f]+${end}`,
});
const address = string({ ...required, pattern: `^0[xX][0-9a-fA-F]{1,32}${end}`, maxLength: 34 });
const terminalId = string({ ...required, pattern: `^[a-f0-9]{24}${end}`, maxLength: 24 });
const audioId = string({
  ...required,
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${end}`,
  maxLength: 36,
});
// The explicit surrogate pair alternative implements isWellFormed() without
// changing Unicode text or requiring a regular-expression flag in the schema.
const linePattern = String.raw`^(?:[^\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff])+${end}`;
const text = string({
  ...required,
  maxLength: 4000,
  pattern: String.raw`^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+${end}`,
});
const lineText = string({ ...required, maxLength: 4000, pattern: linePattern });
const file = string({ ...required, pattern: String.raw`^[^\u0000]+${end}` });
const uploadParams = () => ({
  file: { ...file },
  // The backend accepts parameters (for example audio/webm;codecs=opus)
  // and case-insensitive media types. Never permit header control characters.
  mime: string({ pattern: String.raw`^[ \t]*[aA][uU][dD][iI][oO]/(?:[wW][eE][bB][mM]|[oO][gG][gG]|[mM][pP]4|[wW][aA][vV])[ \t]*(?:;[^\u0000-\u001f\u007f]*)?${end}` }),
});
const pointParams = () => ({
  monitor: { ...monitor, ...required },
  x: integer(0, 32767, required),
  y: integer(0, 32767, required),
});
const fleetMachine = (options = {}) => string({ maxLength: 68, pattern: `^(?:self|ssh:[A-Za-z0-9][A-Za-z0-9._-]{0,63})${end}`, ...options });
const button = string({ ...required, enum: ['left', 'right', 'middle'] });
const workspaceId = integer(1, 100, required);
// Same names, same order as backend/desktop.mjs keyCodes and
// backend/terminals.mjs keys (tests/ctl.test.mjs keeps them equal).
const desktopKeys = [
  'Enter', 'Escape', 'BackSpace', 'Tab', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Copy', 'Paste', 'Undo', 'SelectAll', 'AltTab', 'Super', 'CloseWindow',
  'ShiftTab', 'ShiftEnter', 'Ctrl+Shift+C', 'Ctrl+Shift+V', 'Ctrl+Shift+Z',
  'Ctrl+D', 'Ctrl+F', 'Ctrl+L', 'Ctrl+R', 'Ctrl+S', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Tab', 'F5',
];
const terminalKeys = [
  'Enter', 'Tab', 'ShiftTab', 'Escape', 'BackSpace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Interrupt',
  'Ctrl+A', 'Ctrl+D', 'Ctrl+E', 'Ctrl+J', 'Ctrl+L', 'Ctrl+O',
  'Ctrl+R', 'Ctrl+T', 'Ctrl+U', 'Ctrl+W', 'Ctrl+Z',
];
const dpmsParams = () => ({
  enabled: boolean(),
  state: string({ enum: ['on', 'off'] }),
});
const actionCommand = (name, description, action, params = {}, extra = {}) => ({
  name, description, method: 'POST', path: '/api/action', params, kind: 'action', action, ...extra,
});
const query = (name, description, path, select) => ({
  name, description, method: 'GET', path, params: {}, ...(select ? { select } : {}),
});

/** Named commands. `field` maps a CLI option to its payload/query spelling. */
export const COMMANDS = [
  query('health', 'Read server health and version.', '/api/health'),
  query('state', 'Read the complete desktop state.', '/api/state'),
  query('capabilities', 'Read supported desktop features.', '/api/state', 'capabilities'),
  query('windows', 'List desktop windows.', '/api/state', 'windows'),
  query('workspaces', 'List desktop workspaces.', '/api/state', 'workspaces'),
  query('monitors', 'List monitors and their power state.', '/api/state', 'monitors'),
  query('volume', 'Read volume and mute state.', '/api/state', 'volume'),
  query('lights', 'Read lights state and presets.', '/api/state', 'lights'),
  query('session', 'Read session lock state.', '/api/state', 'session'),
  query('textinput', 'Read whether a text input has focus.', '/api/textinput'),
  query('power', 'Read power and Wake-on-LAN information.', '/api/power'),

  actionCommand('mouse move', 'Move the pointer by relative offsets.', 'mouse.move', {
    dx: number(-1000, 1000, required), dy: number(-1000, 1000, required),
  }),
  actionCommand('mouse click', 'Click a pointer button.', 'mouse.click', { button: { ...button } }),
  actionCommand('mouse click-at', 'Click at a pixel on a monitor.', 'mouse.clickAt', {
    ...pointParams(), button: { ...button },
  }),
  actionCommand('mouse move-to', 'Move the pointer to a pixel on a monitor.', 'mouse.moveTo', pointParams()),
  actionCommand('mouse scroll', 'Scroll by a relative wheel amount.', 'mouse.scroll', { dy: number(-30, 30, required) }),
  actionCommand('mouse drag', 'Hold or release the left pointer button.', 'mouse.drag', { pressed: boolean(required) }),
  actionCommand('mouse drag-start', 'Start dragging at a pixel, optionally holding Super.', 'mouse.dragStartAt', {
    ...pointParams(), modifier: string({ enum: ['super'] }),
  }),
  actionCommand('keyboard text', 'Type text, optionally followed by Enter.', 'keyboard.text', {
    text: { ...text }, enter: boolean({ default: false }),
  }, { input: { sources: ['text', 'stdin', 'file'], field: 'text' } }),
  actionCommand('keyboard key', 'Press a supported desktop key.', 'keyboard.key', { key: string({ ...required, enum: desktopKeys }) }),
  actionCommand('workspace focus', 'Focus a workspace, optionally on a monitor.', 'workspace.focus', {
    id: { ...workspaceId }, monitor: { ...dpmsMonitor },
  }),
  actionCommand('window focus', 'Focus an existing window by address.', 'window.focus', { address: { ...address } }),
  actionCommand('window move', 'Move a window to a workspace without following it.', 'window.moveToWorkspace', {
    address: { ...address }, id: { ...workspaceId },
  }),
  actionCommand('volume set', 'Set desktop volume between zero and one.', 'volume.set', { value: number(0, 1, required) }),
  actionCommand('volume mute', 'Toggle desktop audio mute.', 'volume.mute'),
  actionCommand('media toggle', 'Toggle media playback.', 'media.toggle'),
  actionCommand('media next', 'Skip to the next media track.', 'media.next'),
  actionCommand('media previous', 'Skip to the previous media track.', 'media.previous'),
  actionCommand('app launch', 'Launch an allowed desktop application.', 'app.launch', {
    app: string({ ...required, enum: ['browser', 'terminal', 'files'] }),
  }),
  actionCommand('monitors set', 'Set one monitor on or off with enabled or state.', 'power.dpms', {
    monitor: { ...dpmsMonitor, ...required }, ...dpmsParams(),
  }, { aliases: ['screen.dpms', 'monitor.dpms'] }),
  actionCommand('monitors all', 'Set every monitor on or off with enabled or state.', 'power.dpms_all', dpmsParams()),
  actionCommand('power sleep', 'Turn off monitors and lights, keeping the PC running.', 'power.sleep', {}, { aliases: ['power.smart_sleep'] }),
  actionCommand('power wake', 'Restore monitors and lights.', 'power.wake', {}, { aliases: ['power.restore'] }),
  actionCommand('power suspend', 'Suspend the PC.', 'power.suspend', {}, { confirm: true }),
  actionCommand('power reboot', 'Reboot the PC.', 'power.reboot', {}, { confirm: true }),
  actionCommand('power off', 'Shut down the PC.', 'power.off', {}, { aliases: ['power.poweroff'], confirm: true }),
  actionCommand('lights preset', 'Apply a lights preset.', 'lights.preset', {
    preset: string({ ...required, enum: ['lava', 'brasa', 'oceano', 'aurora', 'floresta', 'lua'] }),
  }),
  actionCommand('lights sleep', 'Turn off the PC lights.', 'lights.sleep'),
  actionCommand('lights restore', 'Restore the saved lights state.', 'lights.restore'),
  actionCommand('lights reapply', 'Reapply the current lights state.', 'lights.reapply'),
  actionCommand('lights screen', 'Enable or disable the PC case screen.', 'lights.screen', { enabled: boolean(required) }),
  actionCommand('session lock', 'Lock the desktop session.', 'session.lock'),
  actionCommand('session unlock', 'Unlock a locked desktop session with a password from stdin.', 'session.unlock', {
    password: string({ ...required, maxLength: 256, pattern: linePattern }),
  }, { input: { sources: ['stdin'], field: 'password' } }),

  query('terminals list', 'List Ponte terminal sessions.', '/api/terminals'),
  query('terminals places', 'List the project folders and SSH machines a new session can start in.', '/api/terminals?projects=1'),
  {
    name: 'terminals create', description: 'Create a Ponte terminal session: a shell, or --agent ssh --host ALIAS for one of the SSH machines in `terminals places`.', method: 'POST', path: '/api/terminals',
    params: {
      cols: integer(20, 240, { default: 80 }), rows: integer(8, 100, { default: 24 }),
      agent: string({ enum: ['shell', 'ssh'] }),
      host: string({ maxLength: 64, pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}${end}` }),
    },
  },
  {
    name: 'terminals read', description: 'Read a Ponte terminal session.', method: 'GET', path: '/api/terminals/:id',
    params: { id: { ...terminalId } },
  },
  {
    name: 'terminals input', description: 'Type one line in a terminal, optionally followed by Enter.', method: 'POST', path: '/api/terminals/:id/input',
    params: { id: { ...terminalId }, text: { ...lineText }, enter: boolean({ default: false }) },
    input: { sources: ['text', 'stdin', 'file'], field: 'text' },
  },
  {
    name: 'terminals key', description: 'Press a supported terminal key.', method: 'POST', path: '/api/terminals/:id/input',
    params: { id: { ...terminalId }, key: string({ ...required, enum: terminalKeys }) },
  },
  {
    name: 'terminals resize', description: 'Resize a Ponte terminal session.', method: 'POST', path: '/api/terminals/:id/resize',
    params: { id: { ...terminalId }, cols: integer(20, 240, required), rows: integer(8, 100, required) },
  },
  {
    name: 'terminals remove', description: 'Remove a Ponte terminal session.', method: 'DELETE', path: '/api/terminals/:id',
    params: { id: { ...terminalId } }, confirm: true,
  },
  {
    name: 'terminals dictate', description: 'Transcribe audio into a terminal, optionally followed by Enter.', method: 'POST', path: '/api/terminals/:id/dictate', kind: 'upload',
    // The transport must serialize enter as ?enter=0 or ?enter=1, not false/true.
    params: { id: { ...terminalId }, ...uploadParams(), enter: boolean({ default: false }) },
  },
  // The fleet: every machine on the tailnet, SSH config and mesh, the health
  // of each route, and agent sessions (Claude Code, Codex, Jcode) anywhere.
  {
    name: 'fleet list', description: 'List machines, their SSH/Tailscale routes and health. --deep checks every SSH route now.', method: 'GET', path: '/api/fleet',
    params: { fresh: boolean(), deep: boolean() }, timeoutMs: 45000,
  },
  {
    name: 'fleet sessions', description: 'List recent Claude Code, Codex and Jcode sessions on every reachable machine.', method: 'GET', path: '/api/fleet/sessions',
    params: { fresh: boolean() }, timeoutMs: 45000,
  },
  {
    name: 'fleet check', description: 'Check every SSH route now: latency and error code per route.', method: 'POST', path: '/api/fleet/check',
    params: {}, timeoutMs: 45000,
  },
  {
    name: 'fleet probe', description: 'Probe one machine: tools, live agents and recent sessions.', method: 'POST', path: '/api/fleet/machines/:machine/probe',
    params: { machine: fleetMachine({ ...required }) }, timeoutMs: 45000,
  },
  {
    name: 'fleet handoff', description: 'Continue an agent session on another machine: sync the project (fast-forward only), copy the session and resume it in a Ponte terminal there. Returns a job; follow it with `fleet job`.', method: 'POST', path: '/api/fleet/handoff',
    params: {
      from: fleetMachine({ ...required }), to: fleetMachine({ default: 'self' }),
      kind: string({ ...required, enum: ['claude', 'codex', 'jcode'] }),
      session: string({ ...required, maxLength: 80, pattern: String.raw`^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session_[a-z0-9]{1,32}_[0-9]{10,16}_[0-9a-f]{8,32})${end}` }),
      git: string({ enum: ['branch', 'changes', 'none'], default: 'branch' }),
      resume: boolean({ default: true }), force: boolean({ default: false }),
      // Only check both ends and report what would happen; copy nothing.
      plan: boolean({ default: false, field: 'dryRun' }),
    },
  },
  query('fleet jobs', 'List recent handoff jobs.', '/api/fleet/jobs'),
  {
    name: 'fleet job', description: 'Read a handoff job; --wait holds the answer until it ends (up to 60 s).', method: 'GET', path: '/api/fleet/jobs/:id',
    params: { id: string({ ...required, pattern: `^[a-f0-9]{16}${end}`, maxLength: 16 }), wait: integer(0, 60, { default: 0 }) },
    timeoutMs: 70000,
  },
  query('audio list', 'List stored audio recordings.', '/api/audio'),
  {
    name: 'audio upload', description: 'Upload an audio recording.', method: 'POST', path: '/api/audio', kind: 'upload',
    params: uploadParams(),
  },
  {
    name: 'audio download', description: 'Download an audio recording to a file.', method: 'GET', path: '/api/audio/:id', kind: 'binary',
    params: { id: { ...audioId }, output: { ...file } },
  },
  {
    name: 'audio play', description: 'Play a stored recording on the PC.', method: 'POST', path: '/api/audio/:id/play',
    params: { id: { ...audioId } },
  },
  {
    name: 'audio stop', description: 'Stop audio playback.', method: 'POST', path: '/api/audio/stop', params: {},
  },
  {
    name: 'dictate', description: 'Transcribe audio without typing the result.', method: 'POST', path: '/api/dictate', kind: 'upload',
    params: uploadParams(),
  },
  {
    name: 'screenshot', description: 'Save a monitor screenshot as JPEG.', method: 'GET', path: '/api/screenshot', kind: 'binary',
    params: { output: { ...file }, monitor: { ...monitor }, scale: number(0.2, 1, { default: 0.65 }) },
  },
  {
    name: 'stream', description: 'Save a bounded multipart JPEG stream, optionally cropped.', method: 'GET', path: '/api/stream', kind: 'stream',
    params: {
      output: { ...file }, monitor: { ...monitor }, fps: integer(1, 20, { default: 10 }),
      scale: number(0.2, 1, { default: 0.5 }), quality: integer(30, 90, { default: 65, field: 'q' }),
      x: integer(0, 32767), y: integer(0, 32767), w: integer(1, 32767), h: integer(1, 32767),
      seconds: number(0.1, 60, { default: 5 }),
    },
  },
];

/** Canonical action types and server aliases point to the same descriptor. */
export const ACTIONS = new Map(COMMANDS.filter(command => command.action).flatMap(command =>
  [command.action, ...(command.aliases || [])].map(type => [type, command])));

function usage(message) {
  return Object.assign(new Error(message), { code: 'USAGE', exitCode: 2 });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function convertParam(name, spec, raw, coerce) {
  let value = raw;
  if (coerce && typeof value === 'string') {
    if (spec.type === 'boolean') {
      if (value === 'true' || value === '1') value = true;
      else if (value === 'false' || value === '0') value = false;
    } else if (spec.type === 'number' || spec.type === 'integer') {
      // Do not accept empty strings, hex, Infinity, or partial parseInt values.
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?![\s\S])/.test(value)) value = Number(value);
    }
  }
  const validType = spec.type === 'integer' ? Number.isSafeInteger(value)
    : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : (spec.type === 'string' || spec.type === 'boolean') && typeof value === spec.type;
  if (!validType) throw usage(`${name} must be ${spec.type === 'integer' ? 'an integer' : `a ${spec.type}`}.`);
  if (typeof value === 'number') {
    if (spec.min !== undefined && value < spec.min) throw usage(`${name} must be at least ${spec.min}.`);
    if (spec.max !== undefined && value > spec.max) throw usage(`${name} must be at most ${spec.max}.`);
  }
  if (typeof value === 'string') {
    if (spec.maxLength !== undefined && value.length > spec.maxLength) throw usage(`${name} must have at most ${spec.maxLength} characters.`);
    if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) throw usage(`${name} has an invalid format.`);
  }
  if (spec.enum && !spec.enum.includes(value)) throw usage(`${name} must be one of: ${spec.enum.join(', ')}.`);
  return value;
}

function validate(command, values, coerce) {
  if (!isRecord(command) || !isRecord(command.params)) throw usage('Invalid command descriptor.');
  if (!isRecord(values)) throw usage('Options must be an object.');
  for (const key of Reflect.ownKeys(values)) {
    if (typeof key !== 'string' || !Object.hasOwn(command.params, key)) throw usage(`Unknown option: --${String(key)}.`);
  }
  const entries = [];
  for (const [name, spec] of Object.entries(command.params)) {
    const supplied = Object.hasOwn(values, name) && values[name] !== undefined;
    if (!supplied && !Object.hasOwn(spec, 'default')) {
      if (spec.required) throw usage(`Missing required option: --${name}.`);
      continue;
    }
    entries.push([name, convertParam(`--${name}`, spec, supplied ? values[name] : spec.default, coerce)]);
  }
  const result = Object.fromEntries(entries);
  // Alternative fields and all-or-none groups cannot be represented by an
  // individual parameter's required flag. Check them here for both entrypoints.
  if ((command.action === 'power.dpms' || command.action === 'power.dpms_all') && result.enabled === undefined && result.state === undefined) {
    throw usage('Provide --enabled or --state.');
  }
  if ((command.action === 'power.dpms' || command.action === 'power.dpms_all') && result.enabled !== undefined && result.state !== undefined && result.enabled !== (result.state === 'on')) {
    throw usage('--enabled and --state must agree.');
  }
  if (command.kind === 'stream') {
    const region = ['x', 'y', 'w', 'h'].filter(key => Object.hasOwn(result, key));
    if (region.length && region.length !== 4) throw usage('Provide --x, --y, --w and --h together.');
  }
  // Live monitor dimensions/existence, session state and audio file contents
  // remain backend checks. The catalog has no I/O or access to desktop state.
  return result;
}

/**
 * Validate CLI option names and values, returning a fresh object with defaults.
 * Numeric and boolean argv strings are converted. Keys stay in CLI spelling:
 * the caller maps `field`, path placeholders and transport-only options.
 */
export function validateParams(command, values = {}) {
  return validate(command, values, true);
}

/**
 * Validate a generic JSON action using original payload field names and strict
 * JSON types. Preserve an accepted alias as its type and never mutate input.
 * Password source restrictions belong to the CLI, not this pure validator.
 */
export function validateAction(value) {
  if (!isRecord(value) || !Object.hasOwn(value, 'type') || typeof value.type !== 'string') throw usage('Action must be an object with a string type.');
  const command = ACTIONS.get(value.type);
  if (!command) throw usage('Unknown action type.');
  const fields = new Map(Object.entries(command.params).map(([name, spec]) => [spec.field || name, name]));
  const entries = [];
  for (const field of Reflect.ownKeys(value)) {
    if (field === 'type') continue;
    if (typeof field !== 'string' || !fields.has(field)) throw usage(`Unknown action field: ${String(field)}.`);
    entries.push([fields.get(field), value[field]]);
  }
  const params = validate(command, Object.fromEntries(entries), false);
  return {
    type: value.type,
    ...Object.fromEntries(Object.entries(params).map(([name, item]) => [command.params[name].field || name, item])),
  };
}

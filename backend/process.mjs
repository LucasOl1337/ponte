import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { message, messages } from './i18n.mjs';

export class ApiError extends Error {
  constructor(status, code, parameters = {}) {
    const errorCode = Object.hasOwn(messages, code) ? code : 'INTERNAL_ERROR';
    super(message(errorCode, 'en', parameters));
    this.status = status; this.code = errorCode; this.parameters = parameters;
  }
}

// What a failed child said, for the server journal and for callers that parse a
// structured answer printed before a non-zero exit. It never reaches the phone:
// ApiError parameters are what the client sees. Long secret-shaped runs are masked.
function failureDetail(error, stdout, stderr) {
  const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  const redact = value => value.replace(/[A-Za-z0-9+/_-]{32,}=*/g, '[redacted]');
  return {
    exitCode: Number.isInteger(error.code) ? error.code : null,
    signal: error.signal || null,
    timedOut: error.killed === true && error.signal === 'SIGKILL',
    stdout: text(stdout).slice(-8192),
    stderr: redact(text(stderr).trim().slice(-600)),
  };
}

// No shell invocation, a timeout on every request-scoped child, and bounded stdout.
export function runCommand(command, args = [], options = {}) {
  const { input, binary = false, timeout = 3500, maxBuffer = 2 * 1024 * 1024, env = process.env, signal } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      shell: false, timeout, maxBuffer, encoding: binary ? 'buffer' : 'utf8', env,
      killSignal: 'SIGKILL', windowsHide: true, signal,
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new ApiError(503, 'COMMAND_FAILED', { command: path.basename(command) }), { detail: failureDetail(error, stdout, stderr) }));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

export async function commandExists(command, env = process.env) {
  for (const dir of (env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    try { await access(path.join(dir, command), constants.X_OK); return true; } catch {}
  }
  return false;
}

export function spawnPlayback(file, onExit, env = process.env) {
  // Only a validated local recording enters ffplay. Restrict demuxers/protocols,
  // disable video, impose a maximum duration, and never inherit request input.
  const child = spawn('ffplay', [
    '-hide_banner', '-loglevel', 'error', '-nodisp', '-vn', '-sn', '-autoexit',
    '-t', '1800', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'matroska,webm,ogg,mov,wav', '-i', file,
  ], { shell: false, stdio: 'ignore', env });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000 + 3000);
  timer.unref();
  const done = () => { clearTimeout(timer); onExit(); };
  child.once('exit', done);
  child.once('error', done);
  return child;
}

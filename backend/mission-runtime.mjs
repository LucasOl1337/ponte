import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ApiError, runCommand } from './process.mjs';

export const missionWorker = fileURLToPath(new URL('./mission-worker.mjs', import.meta.url));
const sourceFile = new URL('./mission-host.py', import.meta.url);
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
export const requestPattern = /^[a-zA-Z0-9_-]{16,80}$/;
export const nativePattern = /^(?:session_[a-z0-9_]+|[a-f0-9-]{36}|\/[\w/ .-]+\.jsonl)$/;

export async function missionCommand(value, source) {
  source ||= await readFile(sourceFile, 'utf8');
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
  const bootstrap = `import base64;exec(base64.b64decode('${Buffer.from(source).toString('base64')}'))`;
  const args = ['-u', '-c', bootstrap, encoded];
  if (value.machine === 'self') return { program: 'python3', args };
  return { program: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', value.machine.slice(4), ['python3', ...args].map(quote).join(' ')] };
}

export function createMissionCapabilities({ env, hosts = [], runner = runCommand } = {}) {
  function machine(id) {
    if (id !== 'self' && !hosts.some(h => `ssh:${h.host}` === id)) throw new ApiError(400, 'SSH_HOST_NOT_ALLOWED');
    return id;
  }
  async function call(value) {
    machine(value.machine);
    const { program, args } = await missionCommand(value);
    try {
      return JSON.parse(await runner(program, args, { env, timeout: 12000, maxBuffer: 256 * 1024 }));
    } catch (error) {
      let code;
      try { code = JSON.parse(error.detail?.stdout || '{}').error; } catch {}
      throw new ApiError(code === 'PROJECT_NOT_ALLOWED' ? 400 : 503, ['PROJECT_NOT_ALLOWED', 'MISSION_OPTION_UNAVAILABLE'].includes(code) ? code : 'MISSION_DESTINATION_UNAVAILABLE');
    }
  }
  return {
    async catalog(id = 'self') {
      const result = await call({ action: 'catalog', machine: id });
      return { ...result, machine: id, machines: [{ id: 'self', label: env?.HOSTNAME || 'Este nó Ponte' }, ...hosts.map(h => ({ id: `ssh:${h.host}`, label: h.label }))] };
    },
    async validate(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['machine', 'harness', 'model', 'provider', 'directory', 'prompt', 'requestId'].includes(k))) throw new ApiError(400, 'INVALID_MISSION');
      if (!requestPattern.test(value.requestId || '') || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000 || /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(value.prompt)) throw new ApiError(400, 'INVALID_MISSION');
      for (const field of ['harness', 'model', 'provider']) if (typeof value[field] !== 'string' || value[field].length > 200 || /[\x00-\x1f]/.test(value[field])) throw new ApiError(400, 'INVALID_MISSION');
      return { ...value, ...await call({ ...value, action: 'validate' }) };
    },
  };
}

export function missionFiles(directory, id) {
  return { config: path.join(directory, `${id}.mission.json`), state: path.join(directory, `${id}.state.json`), output: path.join(directory, `${id}.output.txt`), inbox: path.join(directory, `${id}.inbox.json`) };
}

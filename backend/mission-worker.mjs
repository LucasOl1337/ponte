import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, unlink, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { missionCommand, nativePattern, requestPattern } from './mission-runtime.mjs';

const file = process.argv[2];
const config = JSON.parse(await readFile(file, 'utf8'));
const files = config.files;
const state = { status: 'starting', updatedAt: Date.now(), nativeId: null, effectiveModel: null, effectiveProvider: null, handled: [] };
let output = '', child, failed = false;
async function save() {
  state.updatedAt = Date.now();
  await writeFile(files.state + '.new', JSON.stringify(state), { mode: 0o600 });
  await rename(files.state + '.new', files.state);
}
async function print(text) {
  const clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  output = (output + clean).slice(-192 * 1024);
  process.stdout.write(clean);
  await writeFile(files.output, output, { mode: 0o600 });
}
async function event(value) {
  const nativeId = value.session_id || value.thread_id || (value.type === 'session' ? value.id : null);
  if (nativeId && nativePattern.test(nativeId)) state.nativeId = nativeId;
  if (value.type === 'start' || (value.type === 'system' && value.subtype === 'init')) {
    state.effectiveModel = value.model || null;
    state.effectiveProvider = value.provider || null;
    if (config.harness === 'jcode' && (value.model !== config.model || value.provider !== config.provider)) {
      failed = true;
      await print('\nModelo efetivo diferente do escolhido. Execução interrompida.\n');
      child.kill('SIGTERM');
    }
  }
  if (value.type === 'text_delta') await print(value.text || '');
  if (value.type === 'assistant') for (const block of value.message?.content || []) if (block.type === 'text') await print(block.text + '\n');
  if (value.type === 'item.completed' && value.item?.type === 'agent_message') await print(value.item.text + '\n');
  if (value.type === 'message_update' && value.assistantMessageEvent?.type === 'text_delta') await print(value.assistantMessageEvent.delta || '');
  if (value.type === 'tool_start') await print(`\n[${value.name}]\n`);
  if (value.type === 'error' || value.type === 'ponte_error' || value.is_error) { failed = true; await print(`\n${value.error?.message || value.error || value.result || 'Erro do agente'}\n`); }
  await save();
}
async function turn(request) {
  state.handled.push(request.requestId);
  state.status = 'working'; failed = false;
  await save();
  await print(`\n› ${request.prompt}\n\n`);
  const { program, args } = await missionCommand({ ...config, action: 'run', prompt: request.prompt, resume: state.nativeId });
  child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const result = new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('exit', code => resolve(code)); });
  const errors = [];
  child.stderr.on('data', bytes => { errors.push(bytes.toString()); if (errors.length > 10) errors.shift(); });
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    try { await event(JSON.parse(line)); } catch { if (line) await print(line + '\n'); }
  }
  const code = await result;
  if (code !== 0) { failed = true; await print(errors.join('').slice(-1500).replace(/[A-Za-z0-9+/_-]{40,}/g, '[redacted]')); }
  state.status = failed ? 'error' : 'ready';
  state.exitCode = code;
  await print(failed ? '\nFalha. Nenhuma troca de destino ou provedor foi feita.\n' : '\nResposta concluída. Você pode continuar esta missão.\n');
  await save();
}
await save();
await turn({ requestId: config.requestId, prompt: config.prompt });
// This worker lives in the private tmux pane, independently of HTTP connections.
// An inbox is a single atomic turn, not shell input. No automatic retry after errors.
while (true) {
  let request;
  try { request = JSON.parse(await readFile(files.inbox, 'utf8')); } catch {}
  if (request && requestPattern.test(request.requestId || '') && !state.handled.includes(request.requestId)) {
    await unlink(files.inbox).catch(() => {});
    if (!state.nativeId || state.status === 'error') { await print('\nContinuação indisponível: confira a falha antes de retomar.\n'); }
    else await turn(request);
  }
  await wait(300);
}

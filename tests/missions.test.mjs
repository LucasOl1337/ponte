import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createTerminals } from '../backend/terminals.mjs';
import { createMissionCapabilities, missionCommand, missionFiles } from '../backend/mission-runtime.mjs';

const mission = { machine: 'self', harness: 'jcode', provider: 'configured', model: 'test-model', directory: '/test/project', prompt: 'PONTE_OK\nsem comandos', requestId: 'request_prisma_0001' };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ponte-mission-'));
  const panes = [], calls = [];
  const line = p => [p.name, p.windowId, p.paneId, 80, 24, 0].join('\t');
  const options = { exists: async () => true, probe: async () => panes.length > 0,
    missions: { validate: async v => v, catalog: async id => ({ machine: id }) },
    runner: async (_command, argv) => {
      const args = argv.slice(5); calls.push(args);
      if (args.includes('list-panes')) return panes.map(line).join('\n');
      if (args.includes('new-session')) { const p = { name: args[args.indexOf('-s') + 1], windowId: `@${panes.length}`, paneId: `%${panes.length}` }; panes.push(p); return line(p); }
      return '';
    } };
  const terminals = createTerminals(root, options);
  t.after(async () => { await terminals.close(); await rm(root, { recursive: true, force: true }); });
  return { root, options, panes, calls, terminals, create: v => terminals.create({ cols: 80, rows: 24, mission: v || mission }) };
}
test('one stable terminal for concurrent double tap, retry and server reconstruction', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.create(), f.create()]);
  assert.equal(a.id, b.id); assert.equal(f.panes.length, 1);
  assert.equal(a.title, 'PONTE_OK sem comandos');
  assert.equal(a.mission.machine, 'self'); assert.equal(a.mission.model, 'test-model');
  assert.ok(f.calls.find(args => args.includes('new-session')).includes(process.execPath));
  assert.equal(f.calls.some(args => args.some(word => word.includes('sem comandos'))), false, 'prompt is private data, not shell source');
  const recovered = createTerminals(f.root, f.options);
  t.after(() => recovered.close());
  assert.equal((await recovered.create({ cols: 40, rows: 24, mission })).id, a.id);
  await assert.rejects(f.create({ ...mission, prompt: 'different' }), { code: 'MISSION_REQUEST_CONFLICT' });
});
test('persisted output and terminal ended are distinct from a failed turn', async t => {
  const f = await fixture(t), a = await f.create();
  const files = missionFiles(path.join(f.root, 'terminals'), a.id);
  await writeFile(files.output, 'PONTE_OK\n');
  await writeFile(files.state, JSON.stringify({ status: 'error', effectiveModel: 'test-model', nativeId: 'session_test_1_ab', updatedAt: 12 }));
  const recovered = createTerminals(f.root, f.options); t.after(() => recovered.close());
  assert.equal((await recovered.read(a.id, { format: 'ansi' })).text, 'PONTE_OK\n');
  assert.equal((await recovered.list()).sessions[0].mission.status, 'error');
  f.panes.length = 0;
  assert.equal((await recovered.list()).sessions[0].mission.status, 'ended');
  assert.equal((await recovered.read(a.id)).text, 'PONTE_OK\n');
});
test('continuation is one atomic inbox with deduplicated IDs and refuses failed/running turns', async t => {
  const f = await fixture(t), a = await f.create(), files = missionFiles(path.join(f.root, 'terminals'), a.id);
  const live = { status: 'ready', nativeId: 'session_test_1_ab', handled: [] };
  await writeFile(files.state, JSON.stringify(live));
  const input = { text: 'continue\nthis mission', enter: true, requestId: 'request_prisma_0002' };
  await f.terminals.input(a.id, input);
  assert.equal((await f.terminals.input(a.id, input)).duplicate, true);
  assert.equal(JSON.parse(await readFile(files.inbox)).prompt, input.text);
  await writeFile(files.state, JSON.stringify({ ...live, status: 'working', handled: [input.requestId] }));
  assert.equal((await f.terminals.input(a.id, input)).duplicate, true);
  await assert.rejects(f.terminals.input(a.id, { ...input, requestId: 'request_prisma_0003' }), { code: 'MISSION_NOT_READY' });
});
test('catalog targets only authorized machines and never falls back after SSH failure', async () => {
  const calls = [];
  const caps = createMissionCapabilities({ hosts: [{ host: 'approved', label: 'Approved' }], runner: async (program, args) => { calls.push({ program, args }); throw Error('offline'); } });
  await assert.rejects(caps.catalog('ssh:unapproved'), { code: 'SSH_HOST_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
  await assert.rejects(caps.catalog('ssh:approved'), { code: 'MISSION_DESTINATION_UNAVAILABLE' });
  assert.equal(calls.length, 1); assert.equal(calls[0].program, 'ssh');
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'));
});
test('invalid model and directory are checked on the destination before launch', async () => {
  const caps = createMissionCapabilities({ runner: async () => { throw Object.assign(Error(), { detail: { stdout: JSON.stringify({ error: 'MISSION_OPTION_UNAVAILABLE' }) } }); } });
  await assert.rejects(caps.validate(mission), { code: 'MISSION_OPTION_UNAVAILABLE' });
  await assert.rejects(caps.validate({ ...mission, requestId: '' }), { code: 'INVALID_MISSION' });
  const command = await missionCommand({ ...mission, machine: 'ssh:approved', directory: "/a'; touch /bad; '", prompt: '$(touch /bad)' }, 'print(1)');
  assert.equal(command.args.at(-1).includes('touch /bad'), false);
});

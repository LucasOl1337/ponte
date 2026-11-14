import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDesktop } from '../backend/desktop.mjs';
const sandbox = {};
vm.runInNewContext(await readFile(new URL('../public/screen-context.js', import.meta.url), 'utf8'), sandbox);
const C = sandbox.PonteScreenContext;
const state = {
  monitors: [{ id: 2, name: 'MID', x: 1920, activeWorkspace: 42 }, { id: 0, name: 'LEFT', x: 0, activeWorkspace: 3 }, { id: 8, name: 'RIGHT', x: 5360, activeWorkspace: 7 }],
  workspaces: [{ id: 42, monitor: 'MID' }, { id: 3, monitor: 'LEFT' }, { id: 7, monitor: 'RIGHT' }, { id: 91, monitor: 'MID' }],
  windows: [{ address: '0xab', monitor: 2, workspace: { id: 42 } }, { address: '0xcd', monitor: 8, workspace: { id: 7 } }],
};
test('three monitors use explicit compositor mappings, not numeric ranges', () => {
  assert.deepEqual(Array.from(C.monitors(state), m => m.name), ['LEFT', 'MID', 'RIGHT']);
  assert.deepEqual(Array.from(C.workspaces(state, 'MID'), w => w.id), [42, 91]);
  assert.deepEqual(Array.from(C.windows(state, 'MID'), w => w.address), ['0xab']);
  assert.equal(C.label(state, 'MID'), 'Centro · MID');
  assert.equal(C.windows({ ...state, monitors: [] }, 'MID').length, 0);
  assert.equal(C.windows({ ...state, monitors: state.monitors.filter(m => m.name !== 'MID') }, 'MID').length, 0);
});
test('workspace and window focus fail closed when the expected monitor changed', async () => {
  const calls = [];
  const desktop = createDesktop({ exists: async () => true, runner: async (command, args) => {
    calls.push({ command, args });
    if (command === 'hyprctl' && args[0] === '-j') return JSON.stringify({ monitors: state.monitors, workspaces: state.workspaces, clients: state.windows }[args[1]] || []);
    return 'ok';
  } });
  await assert.rejects(desktop.action({ type: 'workspace.focus', id: 42, monitor: 'RIGHT' }), { code: 'WORKSPACE_MONITOR_CHANGED' });
  await assert.rejects(desktop.action({ type: 'window.focus', address: '0xab', monitor: 'RIGHT' }), { code: 'WINDOW_MONITOR_CHANGED' });
  await assert.rejects(desktop.action({ type: 'window.focus', address: '0xab', monitor: 'GONE' }), { code: 'INVALID_MONITOR' });
  assert.equal(calls.some(c => c.args[0] === 'dispatch' || c.command === 'ydotool'), false);
  await desktop.action({ type: 'workspace.focus', id: 42, monitor: 'MID' });
  await desktop.action({ type: 'window.focus', address: '0xab', monitor: 'MID' });
  assert.deepEqual(calls.filter(c => c.args[0] === 'dispatch').map(c => c.args[1]), ['hl.dsp.focus({ workspace = "42" })', 'hl.dsp.focus({ window = "address:0xab" })']);
  await desktop.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { translateAction, createWindowsTargets } from '../backend/windows.mjs';
import { windowsHosts } from '../backend/config.mjs';

const monitors = [{ name: 'DISPLAY1', x: 0, y: 0, width: 1920, height: 1080 }, { name: 'DISPLAY2', x: 1920, y: 0, width: 1280, height: 1024 }];

test('windows.hosts takes SSH aliases with a label and the agent port', () => {
  assert.deepEqual(windowsHosts([{ host: 'pc-isa', label: 'PC Isa' }]), [{ host: 'pc-isa', label: 'PC Isa', port: 47811 }]);
  assert.deepEqual(windowsHosts(['box']), [{ host: 'box', label: 'box', port: 47811 }]);
  assert.throws(() => windowsHosts([{ host: 'a b' }]));
  assert.throws(() => windowsHosts(['x', 'x']));
});

test('phone actions become agent input ops, monitor points made absolute', () => {
  assert.deepEqual(translateAction({ type: 'mouse.clickAt', monitor: 'DISPLAY2', x: 10, y: 20, button: 'right' }, monitors), [{ op: 'moveTo', x: 1930, y: 20 }, { op: 'click', button: 'right' }]);
  assert.deepEqual(translateAction({ type: 'mouse.scroll', dy: -3 }, monitors), [{ op: 'wheel', dy: -3 }]);
  assert.deepEqual(translateAction({ type: 'keyboard.text', text: 'olá', enter: true }, monitors), [{ op: 'text', text: 'olá' }, { op: 'keys', vks: [0x0D] }]);
  assert.deepEqual(translateAction({ type: 'keyboard.key', key: 'Copy' }, monitors), [{ op: 'keys', vks: [0x11, 0x43] }]);
  assert.deepEqual(translateAction({ type: 'keyboard.combo', combo: 'Ctrl+Home' }, monitors), [{ op: 'keys', vks: [0x11, 0x24] }]);
  assert.deepEqual(translateAction({ type: 'keyboard.combo', combo: 'Super+Shift+S' }, monitors), [{ op: 'keys', vks: [0x5B, 0x10, 0x53] }]);
  assert.deepEqual(translateAction({ type: 'mouse.drag', pressed: false }, monitors), [{ op: 'button', button: 'left', down: false }]);
  for (const bad of [{ type: 'mouse.clickAt', monitor: 'DISPLAY1', x: 1920, y: 0, button: 'left' }, { type: 'mouse.clickAt', monitor: 'NOPE', x: 1, y: 1, button: 'left' },
    { type: 'keyboard.key', key: 'Ctrl+Alt+Delete' }, { type: 'workspace.focus', id: 1 }, { type: 'power.reboot' }]) assert.throws(() => translateAction(bad, monitors));
});

test('a Windows target answers state, actions and frames through its agent', async () => {
  const calls = [];
  const request = async (target, method, route, { body }) => {
    calls.push([target.host, method, route, body]);
    if (route === '/state') return { hostname: 'DESKTOP', monitors: [{ name: 'DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, focused: true }], active: { address: '0x1', title: 'Chrome', class: 'C' } };
    if (route.startsWith('/frame')) return Buffer.from([0xff, 0xd8, 0, 0]);
    return { ok: true };
  };
  const windows = createWindowsTargets({ hosts: [{ host: 'pc-isa', label: 'PC Isa', port: 47811 }], request });
  const target = windows.byNode('ssh:pc-isa');
  assert.equal(windows.byNode('pc isa'), target);
  assert.equal(windows.byNode('ssh:other'), null);
  const state = await windows.state(target, { version: 'v' });
  assert.equal(state.os, 'windows');
  assert.equal(state.monitors[0].name, 'DISPLAY1');
  assert.equal(state.capabilities.live, true);
  assert.equal(state.capabilities.rd, false);
  assert.deepEqual(await windows.action(target, { type: 'mouse.clickAt', monitor: 'DISPLAY1', x: 5, y: 6, button: 'left' }), { ok: true });
  assert.deepEqual(calls.slice(-2).map(call => call[3]), [{ op: 'moveTo', x: 5, y: 6 }, { op: 'click', button: 'left' }]);
  const source = await windows.liveSource(target).prepareLive({ scale: 0.5, quality: 60 });
  assert.equal(source.monitor, 'DISPLAY1');
  assert.equal((await source.capture())[0], 0xff);
  assert.match(calls.at(-1)[2], /^\/frame\?scale=0\.5&q=60&monitor=DISPLAY1$/);
  const listing = windows.decorate({ devices: [{ id: 'ssh:pc-isa', ids: ['ssh:pc-isa', 'tail:pc-isa'], kind: 'other', can: { screen: { ok: false }, control: { ok: false } } }] });
  assert.equal(listing.devices[0].can.control.ok, true);
  assert.equal(listing.devices[0].kind, 'pc');
  windows.close();
});

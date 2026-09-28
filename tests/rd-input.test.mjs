import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { KEY_CODES, BUTTON_CODES, HELPER, absolutePoint, absoluteToLayout, logicalBox, createRdInput } from '../backend/rd-input.mjs';

const hasPython = spawnSync('python3', ['--version']).status === 0;

// The example layout: three monitors side by side at scale 1.
const LAYOUT = [
  { name: 'HDMI-A-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0 },
  { name: 'DP-3', x: 1920, y: 0, width: 3440, height: 1440, scale: 1, transform: 0 },
  { name: 'DP-2', x: 5360, y: 0, width: 2560, height: 1440, scale: 1, transform: 0 },
];

test('KeyboardEvent.code maps to evdev keycodes by physical position, inside the helper key range', () => {
  const expected = {
    KeyA: 30, KeyQ: 16, KeyZ: 44, KeyM: 50, Digit1: 2, Digit0: 11, Enter: 28, Escape: 1, Space: 57, Tab: 15, Backspace: 14,
    F1: 59, F10: 68, F11: 87, F12: 88, F13: 183, F24: 194,
    Numpad0: 82, Numpad5: 76, NumpadEnter: 96, NumpadDivide: 98, NumpadMultiply: 55, NumpadDecimal: 83, NumLock: 69,
    ArrowUp: 103, ArrowDown: 108, ArrowLeft: 105, ArrowRight: 106, Home: 102, End: 107, PageUp: 104, PageDown: 109, Insert: 110, Delete: 111,
    MetaLeft: 125, MetaRight: 126, AltLeft: 56, AltRight: 100, ControlLeft: 29, ControlRight: 97, ShiftLeft: 42, ShiftRight: 54,
    ContextMenu: 127, IntlBackslash: 86, IntlRo: 89, Backquote: 41, Quote: 40, BracketLeft: 26, Slash: 53, Semicolon: 39,
    PrintScreen: 99, ScrollLock: 70, Pause: 119, CapsLock: 58,
    AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115, MediaPlayPause: 164, MediaTrackNext: 163, MediaTrackPrevious: 165, MediaStop: 166,
  };
  for (const [code, keycode] of Object.entries(expected)) assert.equal(KEY_CODES[code], keycode, code);
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.ok(KEY_CODES[`Key${letter}`], letter);
  for (let n = 1; n <= 24; n++) assert.ok(KEY_CODES[`F${n}`], `F${n}`);
  for (const value of Object.values(KEY_CODES)) assert.ok(value >= 1 && value <= 248, `${value} registered by rd-input.py`);
  // Only the legacy OSLeft/OSRight names alias another code.
  const counts = {};
  for (const value of Object.values(KEY_CODES)) counts[value] = (counts[value] || 0) + 1;
  assert.deepEqual(Object.entries(counts).filter(([, n]) => n > 1).map(([v]) => Number(v)).sort(), [125, 126]);
  assert.deepEqual(BUTTON_CODES, [272, 274, 273, 275, 276]); // left, middle, right, back, forward
});

test('absolute pointer, layout mode: three monitors map into one 7920x1440 box and every point stays in its pixel', () => {
  const center = absolutePoint(LAYOUT, 'DP-3', 0.5, 0.5);
  assert.ok(Math.abs(center.layoutX - 3640.5) < 1e-9 && Math.abs(center.layoutY - 720.5) < 1e-9);
  assert.equal(center.x, Math.round(3640.5 / 7920 * 65536));
  assert.equal(center.y, Math.round(720.5 / 1440 * 65536));
  for (const [name, fx, fy, px, py] of [
    ['HDMI-A-1', 0, 0, 0, 0], ['HDMI-A-1', 1, 1, 1919, 1079], ['DP-3', 0, 0, 1920, 0], ['DP-3', 1, 1, 5359, 1439],
    ['DP-3', 0.25, 0.75, 1920 + 860, 1080], ['DP-2', 0, 0.5, 5360, 720], ['DP-2', 1, 0, 7919, 0], ['DP-2', 0.999999, 0.999999, 7919, 1439],
  ]) {
    const point = absolutePoint(LAYOUT, name, fx, fy);
    const x = absoluteToLayout(point.x, 0, 7920), y = absoluteToLayout(point.y, 0, 1440);
    assert.equal(Math.floor(x), px, `${name} ${fx} x → ${x}`);
    assert.equal(Math.floor(y), py, `${name} ${fy} y → ${y}`);
  }
  // Out-of-range fractions clamp to the monitor's edge pixels, never the neighbour.
  assert.equal(Math.floor(absoluteToLayout(absolutePoint(LAYOUT, 'DP-3', 1.7, 0).x, 0, 7920)), 5359);
  assert.equal(Math.floor(absoluteToLayout(absolutePoint(LAYOUT, 'DP-3', -3, 0).x, 0, 7920)), 1920);
  assert.equal(absolutePoint(LAYOUT, 'NOPE', 0.5, 0.5), null);
});

test('absolute pointer, layout mode with a scale 1.5 monitor and a rotated one: logical boxes, as Hyprland computes them', () => {
  const scaled = [
    { name: 'HDMI-A-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0 },
    { name: 'DP-3', x: 1920, y: 0, width: 3440, height: 1440, scale: 1.5, transform: 0 }, // 2293.33 x 960 logical
    { name: 'DP-2', x: 4213, y: 0, width: 2560, height: 1440, scale: 1, transform: 1 },   // rotated: 1440 x 2560
  ];
  assert.deepEqual(logicalBox(scaled[1]), { x: 1920, y: 0, width: 3440 / 1.5, height: 960, pixelWidth: 3440, pixelHeight: 1440 });
  assert.equal(logicalBox(scaled[2]).width, 1440); assert.equal(logicalBox(scaled[2]).height, 2560);
  const boxWidth = 4213 + 1440, boxHeight = 2560;
  // Bottom-right physical pixel of the scaled monitor lands inside its logical box.
  const corner = absolutePoint(scaled, 'DP-3', 1, 1);
  const cx = absoluteToLayout(corner.x, 0, boxWidth), cy = absoluteToLayout(corner.y, 0, boxHeight);
  assert.ok(cx > 1920 + 3440 / 1.5 - 1 && cx < 1920 + 3440 / 1.5, `x ${cx}`);
  assert.ok(cy > 959 && cy < 960, `y ${cy}`);
  // Its centre is at 1920 + 1146.67, 480 in layout coordinates.
  const middle = absolutePoint(scaled, 'DP-3', 0.5, 0.5);
  assert.ok(Math.abs(absoluteToLayout(middle.x, 0, boxWidth) - (1920 + 3440 / 3)) < 0.5);
  assert.ok(Math.abs(absoluteToLayout(middle.y, 0, boxHeight) - 480) < 0.5);
  // The rotated monitor spans the full box height.
  const low = absolutePoint(scaled, 'DP-2', 0.5, 1);
  assert.ok(absoluteToLayout(low.y, 0, boxHeight) > 2559);
});

test('absolute pointer, output mode: the fraction is of the bound monitor only', () => {
  const point = absolutePoint(LAYOUT, 'DP-2', 0.5, 0.5, 'output');
  assert.equal(point.x, Math.round(1280.5 / 2560 * 65536));
  assert.equal(point.y, Math.round(720.5 / 1440 * 65536));
  assert.equal(absolutePoint(LAYOUT, 'DP-2', 1, 1, 'output').x, Math.round(2559.5 / 2560 * 65536));
});

async function readLog(file, predicate, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const lines = (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (predicate(lines) || Date.now() > end) return lines;
    await new Promise(r => setTimeout(r, 25));
  }
}
const events = lines => lines.flatMap(line => line.events.map(([type, code, value]) => `${line.dev}:${code}=${value}`));

test('the helper in dry-run logs the evdev frames it would write, and releases what is held when stopped', { skip: !hasPython }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ponte-rd-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'events.jsonl');
  const input = createRdInput({ dryRun: true, logFile });
  t.after(() => input.stop());
  input.setMonitors(LAYOUT);
  input.start();
  while (!input.ready) await new Promise(r => setTimeout(r, 10));
  input.key('KeyA', true);
  input.key('KeyA', true);           // auto-repeat from the client: ignored
  input.key('NotAKey', true);        // unknown: nothing sent
  input.move('DP-3', 0.5, 0.5);
  input.button(0, true);
  input.button(2, true);
  input.wheel(0, 60); input.wheel(0, 60); // two half notches down = one notch
  input.rel(5, -2);
  input.button(2, false);             // released after a relative move: still on the device that pressed it
  input.key('ShiftLeft', true);
  const lines = await readLog(logFile, l => events(l).includes('ponte-rd-keys:KEY_LEFTSHIFT=1'));
  const seen = events(lines);
  assert.equal(seen.filter(e => e === 'ponte-rd-keys:KEY_A=1').length, 1);
  assert.ok(seen.includes(`ponte-rd-abs:ABS_X=${Math.round(3640.5 / 7920 * 65536)}`));
  assert.ok(seen.includes('ponte-rd-abs:BTN_LEFT=1'), 'buttons go to the device that moved last');
  assert.ok(seen.includes('ponte-rd-abs:BTN_RIGHT=1') && seen.includes('ponte-rd-abs:BTN_RIGHT=0'));
  assert.deepEqual(seen.filter(e => e.includes('WHEEL')), ['ponte-rd-keys:REL_WHEEL_HI_RES=-60', 'ponte-rd-keys:REL_WHEEL_HI_RES=-60', 'ponte-rd-keys:REL_WHEEL=-1']);
  assert.ok(seen.includes('ponte-rd-keys:REL_X=5') && seen.includes('ponte-rd-keys:REL_Y=-2'));
  assert.ok(input.stats.acked >= 8 && input.stats.timed >= 1, JSON.stringify(input.stats));
  input.stop();
  const after = events(await readLog(logFile, l => events(l).includes('ponte-rd-keys:KEY_LEFTSHIFT=0') && events(l).includes('ponte-rd-abs:BTN_LEFT=0')));
  for (const released of ['ponte-rd-keys:KEY_A=0', 'ponte-rd-keys:KEY_LEFTSHIFT=0', 'ponte-rd-abs:BTN_LEFT=0']) assert.ok(after.includes(released), released);
});

test('the helper releases a held key after the watchdog when nothing arrives, and on EOF', { skip: !hasPython }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ponte-rd-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'events.jsonl');
  const quiet = createRdInput({ dryRun: true, logFile, watchdog: 0.3 });
  t.after(() => quiet.stop());
  quiet.key('KeyW', true);
  const started = Date.now();
  const lines = await readLog(logFile, l => events(l).includes('ponte-rd-keys:KEY_W=0'));
  assert.ok(events(lines).includes('ponte-rd-keys:KEY_W=0'));
  assert.ok(Date.now() - started >= 250, 'not before the watchdog');
  quiet.stop();
  // A helper whose stdin just closes (the server died) lets go too.
  const eofLog = path.join(dir, 'eof.jsonl');
  const child = spawn('python3', [HELPER, '--dry-run', '--log', eofLog], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('{"k":42,"v":1}\n{"b":272,"v":1}\n');
  await new Promise(resolve => child.once('close', resolve));
  const eof = events(await readLog(eofLog, () => true));
  assert.deepEqual(eof, ['ponte-rd-keys:KEY_LEFTSHIFT=1', 'ponte-rd-abs:BTN_LEFT=1', 'ponte-rd-keys:KEY_LEFTSHIFT=0', 'ponte-rd-abs:BTN_LEFT=0']);
});

#!/usr/bin/env node
// Passive fcitx5 focus logger. Read only: it polls fcitx5 DebugInfo plus
// `hyprctl cursorpos` and `hyprctl -j activewindow` and appends one JSON line
// per change (focused input context, its program/cap, active window, or the
// pointer resting somewhere new). It never clicks, types, focuses or moves
// anything, so it is safe to run while the owner uses the PC.
//
//   node tools/lab/fcitx-watch.mjs OUT.jsonl [intervalMs=150]
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseFcitxDebugInfo } from '../../backend/textinput.mjs';

const out = process.argv[2];
const interval = Math.max(50, Number(process.argv[3]) || 150);
if (!out) { console.error('usage: fcitx-watch.mjs OUT.jsonl [intervalMs]'); process.exit(2); }

const run = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 1500 }, (error, stdout) => resolve(error ? null : String(stdout))));
let last = '';
async function tick() {
  const [raw, cursor, active] = await Promise.all([
    run('busctl', ['--user', '--timeout=1', 'call', 'org.fcitx.Fcitx5', '/controller', 'org.fcitx.Fcitx.Controller1', 'DebugInfo']),
    run('hyprctl', ['cursorpos']),
    run('hyprctl', ['-j', 'activewindow']),
  ]);
  const parsed = raw ? parseFcitxDebugInfo(raw) : null;
  let window = null;
  try { const w = JSON.parse(active); window = { class: w.class, address: w.address, workspace: w.workspace?.id }; } catch {}
  const focusedIcs = parsed ? parsed.contexts.filter(ic => ic.focus).map(ic => ({ id: ic.id, program: ic.program, cap: ic.cap })) : null;
  const key = JSON.stringify({ focusedIcs, window, cursor: cursor?.trim() });
  if (key === last) return;
  last = key;
  appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), focusedIcs, window, cursor: cursor?.trim() || null }) + '\n');
}
setInterval(() => { tick().catch(() => {}); }, interval);
tick();

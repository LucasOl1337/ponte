#!/usr/bin/env node
// Keyboard decision against a running lab server (tools/lab/run.sh), through
// the real HTTP API and the fake fcitx/hyprctl/ydotool. For each scripted tap
// it prints what the old rule (any IC focused) and the new rule (the tap caused
// the focus, same window) would do with the phone keyboard.
//
//   node tools/lab/keyboard-decision.mjs http://127.0.0.1:8871 TOKEN_FILE
import { readFileSync } from 'node:fs';
import { tapFocusedText } from '../../backend/textinput.mjs';

const [base = 'http://127.0.0.1:8799', tokenFile = '.work/lab/data/token'] = process.argv.slice(2);
const token = readFileSync(tokenFile, 'utf8').trim();
const call = async (path, body) => {
  const response = await fetch(`${base}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${path} ${response.status} ${await response.text()}`);
  return response.json();
};
const monitor = (await call('/state')).monitors[0];
const W = monitor.width, H = monitor.height;
// Same fractions as tools/lab/bin/_lab.py targets().
const at = { A: [0.2, 0.22], B: [0.6, 0.57], C: [0.75, 0.17], D1: [0.15, 0.55], D2: [0.3, 0.68], empty: [0.5, 0.92] };
const steps = [
  ['empty', 'fundo vazio, nada focado'],
  ['D1', 'canvas (ativa a janela do canvas)'],
  ['D2', 'canvas de novo (janela já ativa)'],
  ['D1', 'canvas mais uma vez'],
  ['A', 'campo A (outra janela)'],
  ['empty', 'fundo vazio (campo A continua focado)'],
  ['B', 'campo B'],
  ['C', 'botão C'],
  ['A', 'campo A'],
  // follow_mouse: a phone scroll over the canvas activates its window with no
  // IC focused (Maestri measured: 8 of 51 clicks); the next tap restores it.
  ['scroll:D1', 'rolagem pelo celular em cima do canvas (ativa por hover)'],
  ['D2', 'canvas depois da rolagem (janela já ativa, IC volta)'],
  ['D1', 'canvas de novo'],
  ['scroll:B', 'rolagem em cima do campo B (volta pra janela dos campos)'],
  ['B', 'campo B depois da rolagem'],
];
console.log('passo | alvo | antes -> depois | janela mudou | regra antiga | regra nova');
for (const [step, label] of steps) {
  if (step.startsWith('scroll:')) {
    const [fx, fy] = at[step.slice(7)];
    await call('/action', { type: 'mouse.scroll', monitor: monitor.name, x: Math.round(W * fx), y: Math.round(H * fy), dy: 3 });
    const after = await call('/textinput');
    console.log(`${label} | ${step} | -> ${after.context?.program || '-'} | - | - | -`);
    continue;
  }
  const name = step;
  const [fx, fy] = at[name];
  const tap = await call('/action', { type: 'mouse.clickAt', monitor: monitor.name, x: Math.round(W * fx), y: Math.round(H * fy), button: 'left', textBaseline: true });
  const after = await call('/textinput');
  const old = after.focused === true;
  const now = tap.windowChanged === false && tapFocusedText(tap.textBefore, after.context);
  console.log(`${label} | ${name} | ${tap.textBefore?.program || '-'} -> ${after.context?.program || '-'} | ${tap.windowChanged} | ${old ? 'ABRE' : 'fechado'} | ${now ? 'ABRE' : 'fechado'}`);
}

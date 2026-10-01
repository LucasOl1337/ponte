// The optional Hyprland module that lets Super reach the controlled device.
// Runs only where Hyprland is installed, always on a copy (HYPR_DIR), never on
// the live config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'tools/hypr/ponte-rd-hypr.sh');
const module = readFileSync(path.join(root, 'tools/hypr/ponte_rd.lua'), 'utf8');
const hasHyprland = spawnSync('Hyprland', ['--version']).status === 0;

test('the Lua module follows the title mark the page sets and keeps an emergency exit', () => {
  const client = readFileSync(path.join(root, 'public/rd.js'), 'utf8');
  const mark = client.match(/TITLE_MARK = '([^']+)'/)[1];
  assert.ok(module.includes(`local MARK = "${mark}"`), 'same mark on both sides');
  assert.match(module, /class == "ponte-rd"/, 'matches the window `ponte rd` opens');
  assert.match(module, /hl\.on\("window\.active"/);
  assert.match(module, /hl\.on\("window\.title"/);
  assert.match(module, /SUPER \+ CTRL \+ ALT \+ ESCAPE", hl\.dsp\.submap\("reset"\)/);
});

test('install validates, is idempotent, and remove gives the config back byte for byte', { skip: !hasHyprland && 'no Hyprland here' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ponte-hypr-'));
  const main = path.join(dir, 'hyprland.lua');
  const original = 'hl.config({ general = { gaps_in = 3 } })\n';
  writeFileSync(main, original);
  const run = (...args) => execFileSync(script, args, { env: { ...process.env, HYPR_DIR: dir }, encoding: 'utf8' });
  assert.match(run('status'), /não instalado/);
  assert.match(run('check'), /passa no --verify-config/);
  assert.equal(readFileSync(main, 'utf8'), original, 'check writes nothing');
  run('install');
  assert.ok(existsSync(path.join(dir, 'ponte_rd.lua')));
  assert.equal(readFileSync(main, 'utf8').split('ponte-rd (tools').length, 2);
  assert.match(run('install'), /já instalado/);
  assert.equal(readFileSync(main, 'utf8').split('ponte-rd (tools').length, 2, 'only one line');
  run('remove');
  assert.equal(readFileSync(main, 'utf8'), original);
  assert.ok(!existsSync(path.join(dir, 'ponte_rd.lua')));
  assert.ok(readdirSync(dir).some(name => name.startsWith('hyprland.lua.bak.')), 'backups kept');
  // A broken config is never touched.
  writeFileSync(main, 'hl.on("window.titulo", function() end)\n');
  const broken = spawnSync(script, ['install'], { env: { ...process.env, HYPR_DIR: dir }, encoding: 'utf8' });
  assert.notEqual(broken.status, 0);
  assert.equal(readFileSync(main, 'utf8'), 'hl.on("window.titulo", function() end)\n');
  assert.ok(!existsSync(path.join(dir, 'ponte_rd.lua')));
});

#!/usr/bin/env node
// Aplica uma release local no checkout de onde o ponte-remote.service roda,
// preservando o trabalho não commitado de quem estiver nele.
//
//   node tools/release/apply.mjs --target SHA                 # dry-run (padrão): só lê, confere e conta
//   node tools/release/apply.mjs --target SHA --apply         # backup, avança main, reaplica o WIP, config, restart, saúde
//   ... --apply --apk ARQ --apk-sha256 H --install-apk        # ... e instala o APK pelo ./ponte phone install
//   node tools/release/apply.mjs --rollback DIR               # volta ao estado do backup DIR
//
// Nunca usa stash, reset, checkout de arquivo alheio, push nem merge commit.
// O avanço é fast-forward: update-ref (com o valor antigo conferido) e
// read-tree no índice; na árvore só são escritos os arquivos que a release
// muda. Um arquivo que a release e o WIP mudam recebe o merge de três vias
// (base = HEAD atual, nosso = release, deles = WIP) escrito direto nele; se
// sobrar conflito que não seja inserção ao lado de uma edição, nada é feito.
// Antes de tocar em qualquer coisa, a árvore composta (release + WIP) roda a
// suíte Node numa cópia temporária.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DEFAULTS = {
  checkout: path.join(HOME, 'Projects/ponte'),
  branch: 'main',
  target: '',
  config: process.env.PONTE_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'ponte/config.json'),
  backups: path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'ponte/release-backups'),
  service: 'ponte-remote.service',
};

export function parseArgs(argv) {
  const o = { ...DEFAULTS, apply: false, rollback: '', installApk: false, restart: true, tests: true, apk: '', apkSha256: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} precisa de um valor`); return argv[++i]; };
    if (a === '--apply') o.apply = true;
    else if (a === '--rollback') o.rollback = next();
    else if (a === '--install-apk') o.installApk = true;
    else if (a === '--no-restart') o.restart = false;
    else if (a === '--skip-tests') o.tests = false;
    else if (a === '--checkout') o.checkout = next();
    else if (a === '--branch') o.branch = next();
    else if (a === '--target') o.target = next();
    else if (a === '--config') o.config = next();
    else if (a === '--backups') o.backups = next();
    else if (a === '--apk') o.apk = next();
    else if (a === '--apk-sha256') o.apkSha256 = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`opção desconhecida: ${a}`);
  }
  if (o.apply && o.rollback) throw new Error('--apply e --rollback não andam juntos');
  if (!o.rollback && !o.help && !o.target) throw new Error('--target COMMIT é obrigatório (o commit da release, de preferência o sha completo)');
  if (o.installApk && !o.apk) throw new Error('--install-apk precisa de --apk CAMINHO');
  return o;
}

const sha = data => createHash('sha256').update(data).digest('hex');
// GIT_OPTIONAL_LOCKS=0: git status does not refresh the index, so the dry-run
// writes nothing in the checkout.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
function git(checkout, args, opts = {}) {
  return execFileSync('git', ['-C', checkout, ...args], { env: GIT_ENV, encoding: opts.encoding === undefined ? 'utf8' : opts.encoding, maxBuffer: 64 << 20, input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] });
}
const show = (checkout, rev, p) => git(checkout, ['show', `${rev}:${p}`], { encoding: null });
const z = text => text.split('\0').filter(Boolean);

// git status -z: "XY path" (renames are off, so one path per entry).
function workingState(checkout) {
  const entries = z(git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']));
  const tracked = [], untracked = [], staged = [];
  for (const entry of entries) {
    const x = entry[0], y = entry[1], p = entry.slice(3);
    if (x === '?' && y === '?') untracked.push(p);
    else { if (x !== ' ') staged.push(p); tracked.push({ path: p, deleted: y === 'D' }); }
  }
  return { tracked, untracked, staged };
}

// One conflict hunk is resolvable when one side only inserted lines right
// before or after the base text and the other side edited that base text:
// then both changes are kept. Anything else stays a conflict.
export function resolveHunk(ours, base, theirs) {
  const ends = (side, b) => b.length && side.length > b.length && side.slice(-b.length).join('\n') === b.join('\n');
  const starts = (side, b) => b.length && side.length > b.length && side.slice(0, b.length).join('\n') === b.join('\n');
  if (ends(ours, base) && !ends(theirs, base) && !starts(theirs, base)) return [...ours.slice(0, -base.length), ...theirs];
  if (starts(ours, base) && !ends(theirs, base) && !starts(theirs, base)) return [...theirs, ...ours.slice(base.length)];
  if (ends(theirs, base) && !ends(ours, base) && !starts(ours, base)) return [...theirs.slice(0, -base.length), ...ours];
  if (starts(theirs, base) && !ends(ours, base) && !starts(ours, base)) return [...ours, ...theirs.slice(base.length)];
  return null;
}
export function resolveDiff3(text) {
  const lines = text.split('\n'), out = [], hunks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<< ')) { out.push(lines[i]); continue; }
    const ours = [], base = [], theirs = []; let part = ours; i++;
    for (; i < lines.length && !lines[i].startsWith('>>>>>>> '); i++) {
      if (lines[i].startsWith('||||||| ')) part = base; else if (lines[i] === '=======') part = theirs; else part.push(lines[i]);
    }
    const resolved = resolveHunk(ours, base, theirs);
    hunks.push({ ours: ours.length, base: base.length, theirs: theirs.length, resolved: !!resolved, baseText: base.join('\n').slice(0, 120), theirsText: theirs.join('\n').slice(0, 120) });
    if (!resolved) return { text: null, hunks };
    out.push(...resolved);
  }
  return { text: out.join('\n'), hunks };
}
function merge3(ours, base, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-merge-'));
  try {
    const f = name => path.join(dir, name);
    fs.writeFileSync(f('release'), ours); fs.writeFileSync(f('base'), base); fs.writeFileSync(f('wip'), theirs);
    const r = spawnSync('git', ['merge-file', '-p', '--diff3', f('release'), f('base'), f('wip')], { encoding: null, maxBuffer: 64 << 20 });
    if (r.status === 0) return { content: r.stdout, how: 'limpo', hunks: [] };
    if (r.status < 0 || r.status === null || r.status > 127) throw new Error(`git merge-file falhou: ${r.stderr}`);
    const { text, hunks } = resolveDiff3(r.stdout.toString('utf8'));
    return text === null ? { content: null, how: 'conflito', hunks } : { content: Buffer.from(text), how: 'inserção ao lado de edição', hunks };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export function plan(o) {
  const co = path.resolve(o.checkout), blockers = [], notes = [];
  const branch = git(co, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== o.branch) blockers.push(`o checkout está em ${branch}, não em ${o.branch}`);
  const head = git(co, ['rev-parse', 'HEAD']).trim();
  let target = '';
  try { target = git(co, ['rev-parse', '--verify', `${o.target}^{commit}`]).trim(); } catch { blockers.push(`alvo ${o.target} não existe neste repositório`); }
  const p = { checkout: co, branch, head, target, targetName: o.target, blockers, notes, changed: [], wip: [], untracked: [], merges: [], config: null, version: '', manifest: null };
  if (!target) return p;
  if (head === target) { notes.push('o checkout já está no alvo'); }
  else if (spawnSync('git', ['-C', co, 'merge-base', '--is-ancestor', head, target]).status !== 0) blockers.push(`HEAD ${head.slice(0, 8)} não é ancestral do alvo: integrar antes (sem fast-forward não há aplicação segura)`);
  p.version = JSON.parse(show(co, target, 'package.json').toString('utf8')).version;
  const manifest = show(co, target, 'android/AndroidManifest.xml').toString('utf8');
  p.manifest = { versionCode: Number(/android:versionCode="(\d+)"/.exec(manifest)?.[1]), versionName: /android:versionName="([^"]+)"/.exec(manifest)?.[1] };
  const st = workingState(co);
  if (st.staged.length) blockers.push(`há mudanças no índice (staged), que o read-tree perderia: ${st.staged.join(', ')}`);
  p.changed = head === target ? [] : z(git(co, ['diff', '--name-status', '-z', '--no-renames', head, target])).reduce((acc, item, i, all) => (i % 2 === 0 ? acc.push({ status: item, path: all[i + 1] }) : 0, acc), []);
  const changedMap = new Map(p.changed.map(c => [c.path, c.status]));
  p.untracked = st.untracked;
  for (const w of st.tracked) {
    const status = changedMap.get(w.path);
    const entry = { path: w.path, deleted: w.deleted, releaseChanges: !!status };
    p.wip.push(entry);
    if (!status) continue;
    if (w.deleted || status === 'D') { blockers.push(`${w.path}: apagado de um lado e mudado do outro`); continue; }
    const m = merge3(show(co, target, w.path), show(co, head, w.path), fs.readFileSync(path.join(co, w.path)));
    const wipSha = sha(fs.readFileSync(path.join(co, w.path)));
    p.merges.push({ path: w.path, how: m.how, hunks: m.hunks, wipSha, mergedSha: m.content ? sha(m.content) : '', content: m.content });
    if (!m.content) blockers.push(`${w.path}: conflito entre a release e o WIP que não é inserção ao lado de edição`);
  }
  for (const c of p.changed) {
    if (c.status !== 'A') continue;
    const file = path.join(co, c.path);
    if (fs.existsSync(file) && !changedMap.has(c.path)) continue;
    if (fs.existsSync(file) && !p.wip.some(w => w.path === c.path)) {
      if (!fs.readFileSync(file).equals(show(co, target, c.path))) blockers.push(`${c.path}: a release cria um arquivo que já existe aqui (não rastreado ou ignorado) com outro conteúdo`);
      else notes.push(`${c.path}: já existe aqui igual ao da release, passa a ser rastreado`);
    }
  }
  try {
    const config = JSON.parse(fs.readFileSync(o.config, 'utf8'));
    const android = config.android || {};
    p.config = { file: o.config, current: { versionCode: android.versionCode, versionName: android.versionName }, needsBump: android.versionCode !== undefined && (android.versionCode < p.manifest.versionCode || android.versionName !== p.manifest.versionName) };
    if (android.versionCode !== undefined && android.versionCode > p.manifest.versionCode) blockers.push(`config android.versionCode ${android.versionCode} é maior que o do alvo ${p.manifest.versionCode}`);
  } catch (error) { notes.push(`config ${o.config} não lida (${error.code || error.message}): versão Android do config não será mexida`); }
  if (o.apk) {
    if (!fs.existsSync(o.apk)) blockers.push(`APK ${o.apk} não existe`);
    else { const got = sha(fs.readFileSync(o.apk)); p.apk = { file: path.resolve(o.apk), sha256: got }; if (o.apkSha256 && got !== o.apkSha256) blockers.push(`APK com sha256 ${got}, esperado ${o.apkSha256}`); }
  }
  return p;
}

// The suite on the composed tree (release + WIP), in a throwaway copy.
const childEnv = dir => {
  const env = { ...process.env, PONTE_CONFIG: path.join(dir, 'no-config.json') };
  delete env.NODE_TEST_CONTEXT; // run as its own suite even when called from a test
  return env;
};
export function composedTests(p) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-release-check-'));
  try {
    const archive = execFileSync('git', ['-C', p.checkout, 'archive', p.target], { maxBuffer: 512 << 20 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    for (const w of p.wip) {
      const dest = path.join(dir, w.path), merged = p.merges.find(m => m.path === w.path);
      if (w.deleted) { fs.rmSync(dest, { force: true }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, merged ? merged.content : fs.readFileSync(path.join(p.checkout, w.path)));
    }
    for (const u of p.untracked) { const dest = path.join(dir, u); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(p.checkout, u), dest); }
    const files = fs.readdirSync(path.join(dir, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => path.join('tests', f));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, env: childEnv(dir) });
    const count = key => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
    return { ok: r.status === 0, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), tail: r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').filter(l => /^\s*not ok|Error/.test(l)).slice(0, 20).join('\n') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function report(p, o, tests) {
  const out = [];
  out.push(`Checkout: ${p.checkout} (${p.branch}) HEAD ${p.head.slice(0, 8)}`);
  out.push(`Alvo: ${p.targetName} ${p.target.slice(0, 8)} versão ${p.version}, APK versionCode ${p.manifest?.versionCode} ${p.manifest?.versionName}`);
  out.push(`A release muda ${p.changed.length} arquivo(s).`);
  out.push(`WIP preservado: ${p.wip.length} rastreado(s), ${p.untracked.length} não rastreado(s).`);
  for (const w of p.wip) out.push(`  ${w.deleted ? 'apagado' : 'mudado'}  ${w.path}${w.releaseChanges ? '  (a release também muda: merge)' : ''}`);
  for (const u of p.untracked) out.push(`  novo     ${u}`);
  for (const m of p.merges) {
    out.push(`  merge ${m.path}: ${m.how}`);
    for (const h of m.hunks) out.push(`    trecho: release ${h.ours} linha(s), base ${h.base}, WIP ${h.theirs}${h.resolved ? ' -> mantém a inserção da release e a edição do WIP' : ' -> SEM resolução'}\n      base: ${JSON.stringify(h.baseText)}\n      WIP:  ${JSON.stringify(h.theirsText)}`);
  }
  if (p.config) out.push(`Config ${p.config.file}: android ${p.config.current.versionCode}/${p.config.current.versionName}${p.config.needsBump ? ` -> ${p.manifest.versionCode}/${p.manifest.versionName}` : ' (sem mudança)'}`);
  if (p.apk) out.push(`APK ${p.apk.file} sha256 ${p.apk.sha256}`);
  if (tests) out.push(`Suíte na árvore composta (release + WIP): ${tests.ok ? 'ok' : 'FALHOU'}, ${tests.tests} testes, ${tests.pass} passam, ${tests.fail} falham, ${tests.skipped} pulados${tests.tail ? `\n${tests.tail}` : ''}`);
  p.notes.forEach(n => out.push(`Nota: ${n}`));
  p.blockers.forEach(b => out.push(`BLOQUEIO: ${b}`));
  if (!o.apply && !p.blockers.length && (!tests || tests.ok)) out.push('Dry-run: nada foi alterado. Para aplicar: --apply' + (o.apk ? ' (--install-apk para instalar o APK)' : ''));
  return out.join('\n');
}

function writeAtomic(file, data, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
function backup(p, o) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(o.backups, `${stamp}-${p.head.slice(0, 8)}-to-${p.target.slice(0, 8)}`);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
  fs.chmodSync(o.backups, 0o700);
  fs.writeFileSync(path.join(dir, 'wip.patch'), git(p.checkout, ['diff', '--binary', 'HEAD'], { encoding: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'status.txt'), git(p.checkout, ['status', '--porcelain=v1', '--untracked-files=all']), { mode: 0o600 });
  for (const rel of [...p.wip.filter(w => !w.deleted).map(w => w.path), ...p.untracked]) {
    const dest = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(p.checkout, rel), dest);
    fs.chmodSync(dest, fs.statSync(path.join(p.checkout, rel)).mode & 0o777);
  }
  let configBackup = '';
  if (p.config) { configBackup = path.join(dir, 'config.json'); fs.copyFileSync(p.config.file, configBackup); fs.chmodSync(configBackup, 0o600); }
  const meta = { when: new Date().toISOString(), checkout: p.checkout, branch: p.branch, head: p.head, target: p.target, targetName: p.targetName, version: p.version,
    wip: p.wip.map(w => ({ path: w.path, deleted: w.deleted, merged: p.merges.find(m => m.path === w.path)?.mergedSha || '' })), untracked: p.untracked,
    changed: p.changed, config: p.config ? { file: p.config.file, backup: configBackup } : null };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1), { mode: 0o600 });
  return dir;
}

// Index and branch to the target, then the working tree: release files that
// nobody touched get the target content, WIP files get their merge.
function advance(p) {
  const co = p.checkout, wipSet = new Set(p.wip.map(w => w.path));
  git(co, ['update-ref', '-m', `release: ${p.targetName}`, `refs/heads/${p.branch}`, p.target, p.head]);
  git(co, ['read-tree', p.target]);
  const write = p.changed.filter(c => c.status !== 'D' && !wipSet.has(c.path)).map(c => c.path);
  if (write.length) git(co, ['checkout-index', '-f', '-z', '--stdin'], { input: write.join('\0') });
  for (const c of p.changed) if (c.status === 'D' && !wipSet.has(c.path)) fs.rmSync(path.join(co, c.path), { force: true });
  for (const m of p.merges) { const file = path.join(co, m.path); writeAtomic(file, m.content, fs.statSync(file).mode & 0o777); }
  spawnSync('git', ['-C', co, 'update-index', '-q', '--refresh']);
  const left = new Set(z(git(co, ['diff', '--name-only', '-z', p.target])));
  const expected = new Set(p.wip.filter(w => { const m = p.merges.find(x => x.path === w.path); return w.deleted || !m || !m.content.equals(show(co, p.target, w.path)); }).map(w => w.path));
  const extra = [...left].filter(x => !expected.has(x)), missing = [...expected].filter(x => !left.has(x));
  if (extra.length || missing.length) throw new Error(`árvore depois do avanço difere do esperado: sobrando ${extra.join(', ') || '-'}; faltando ${missing.join(', ') || '-'}`);
}
function bumpConfig(p) {
  if (!p.config?.needsBump) return false;
  const config = JSON.parse(fs.readFileSync(p.config.file, 'utf8'));
  config.android = { ...config.android, versionCode: p.manifest.versionCode, versionName: p.manifest.versionName };
  writeAtomic(p.config.file, JSON.stringify(config, null, 2) + '\n', fs.statSync(p.config.file).mode & 0o777);
  return true;
}
async function health(o, expected) {
  const config = JSON.parse(fs.readFileSync(o.config, 'utf8'));
  const host = config.http?.host || '127.0.0.1', port = config.http?.port || 8787;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/health`;
  let last = '';
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); const j = await r.json(); last = j.version; if (j.version === expected) return { ok: true, url, version: j.version }; } catch (error) { last = error.message; }
    await new Promise(res => setTimeout(res, 1000));
  }
  return { ok: false, url, version: last };
}
function restart(o) {
  const r = spawnSync('systemctl', ['--user', 'restart', o.service], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`systemctl --user restart ${o.service} falhou: ${r.stderr.trim()}`);
}

export function rollback(dir, o, log = console.log) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), co = meta.checkout;
  const head = git(co, ['rev-parse', 'HEAD']).trim();
  if (head !== meta.target) throw new Error(`HEAD ${head.slice(0, 8)} não é o alvo ${meta.target.slice(0, 8)} do backup: alguém mexeu depois, rollback manual`);
  const wipSet = new Set(meta.wip.map(w => w.path));
  const releaseOnly = meta.changed.filter(c => !wipSet.has(c.path)).map(c => c.path);
  if (releaseOnly.length && spawnSync('git', ['-C', co, 'diff', '--quiet', meta.target, '--', ...releaseOnly]).status !== 0) throw new Error('arquivos da release mudaram depois do avanço: rollback manual');
  for (const w of meta.wip) if (w.merged && sha(fs.readFileSync(path.join(co, w.path))) !== w.merged) throw new Error(`${w.path} mudou depois do avanço: rollback manual`);
  git(co, ['update-ref', '-m', `rollback de ${meta.targetName}`, `refs/heads/${meta.branch}`, meta.head, meta.target]);
  git(co, ['read-tree', meta.head]);
  const restore = meta.changed.filter(c => c.status !== 'A' && !wipSet.has(c.path)).map(c => c.path);
  if (restore.length) git(co, ['checkout-index', '-f', '-z', '--stdin'], { input: restore.join('\0') });
  for (const c of meta.changed) if (c.status === 'A' && !wipSet.has(c.path) && !meta.untracked.includes(c.path)) fs.rmSync(path.join(co, c.path), { force: true });
  for (const rel of [...meta.wip.filter(w => !w.deleted).map(w => w.path), ...meta.untracked]) {
    const src = path.join(dir, 'files', rel); writeAtomic(path.join(co, rel), fs.readFileSync(src), fs.statSync(src).mode & 0o777);
  }
  if (meta.config?.backup) writeAtomic(meta.config.file, fs.readFileSync(meta.config.backup), 0o600);
  spawnSync('git', ['-C', co, 'update-index', '-q', '--refresh']);
  const after = git(co, ['status', '--porcelain=v1', '--untracked-files=all']);
  const before = fs.readFileSync(path.join(dir, 'status.txt'), 'utf8');
  if (after !== before) throw new Error(`status depois do rollback difere do backup:\n--- antes\n${before}--- agora\n${after}`);
  log(`Rollback: ${meta.branch} de volta em ${meta.head.slice(0, 8)}, WIP e config restaurados.`);
  return meta;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  if (o.rollback) {
    rollback(path.resolve(o.rollback), o);
    if (o.restart) { restart(o); console.log(`Reiniciado ${o.service}.`); }
    return 0;
  }
  const p = plan(o);
  const tests = o.tests && !p.blockers.length && p.head !== p.target ? composedTests(p) : null;
  console.log(report(p, o, tests));
  if (p.blockers.length || (tests && !tests.ok)) return 2;
  if (!o.apply || p.head === p.target) return 0;
  const again = plan(o);
  if (again.head !== p.head || again.merges.map(m => m.wipSha).join() !== p.merges.map(m => m.wipSha).join() || again.wip.length !== p.wip.length || again.untracked.length !== p.untracked.length) { console.log('BLOQUEIO: o checkout mudou durante a conferência; rode de novo.'); return 2; }
  const dir = backup(p, o);
  console.log(`Backup: ${dir}`);
  try { advance(p); } catch (error) { console.log(`ERRO no avanço: ${error.message}\nRollback: node ${path.relative(process.cwd(), new URL(import.meta.url).pathname)} --rollback ${dir}`); return 3; }
  console.log(`Avançado: ${p.branch} ${p.head.slice(0, 8)} -> ${p.target.slice(0, 8)} (fast-forward local, sem push); WIP reaplicado.`);
  if (bumpConfig(p)) console.log(`Config: android ${p.manifest.versionCode}/${p.manifest.versionName}.`);
  if (o.restart) {
    restart(o);
    const h = await health(o, p.version);
    console.log(h.ok ? `Saúde: ${h.url} responde ${h.version}.` : `ERRO: ${h.url} não respondeu ${p.version} em 30 s (último: ${h.version}). Rollback: --rollback ${dir}`);
    if (!h.ok) return 4;
  } else console.log('Sem restart (--no-restart): o serviço segue com o código antigo até reiniciar.');
  if (o.installApk) {
    const r = spawnSync(path.join(p.checkout, 'ponte'), ['phone', 'install', p.apk.file], { cwd: p.checkout, stdio: 'inherit' });
    if (r.status !== 0) { console.log('ERRO: ./ponte phone install falhou; o servidor já está na versão nova, o APK antigo continua funcionando.'); return 5; }
  } else if (p.apk) console.log(`APK não instalado. Para instalar: ./ponte phone install ${p.apk.file}`);
  console.log(`Rollback, se preciso: node tools/release/apply.mjs --rollback ${dir}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(code => process.exit(code), error => { console.error(`ERRO: ${error.message}`); process.exit(1); });
}

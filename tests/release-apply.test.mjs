// tools/release/apply.mjs on a throwaway git repo: the dry-run changes
// nothing, --apply keeps every uncommitted change of the checkout's owner,
// a real conflict stops before anything is touched, and --rollback restores
// the exact previous state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHunk } from '../tools/release/apply.mjs';

const script = new URL('../tools/release/apply.mjs', import.meta.url).pathname;
const raw = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_OPTIONAL_LOCKS: '0' } });
const run = (cwd, ...args) => raw(cwd, ...args).trim();
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const manifest = (code, name) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android" android:versionCode="${code}" android:versionName="${name}"/>\n`;
const changelog = extra => `# Changelog\n\n## Unreleased\n\n- old entry\n${extra}\n## 0.1.0-alpha.48\n\n- shipped\n`;
const rdTest = (inserted, name) => `import test from 'node:test';\n\ntest('b', () => {});\n\n${inserted}test('${name}', () => {\n  void 0;\n});\n`;

// main at alpha.48 with WIP on three files the release also changes (one of
// them a test where the release inserts a test right before one the WIP
// renames), one WIP-only file and an untracked file; the release on a branch.
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-apply-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const co = path.join(root, 'checkout');
  fs.mkdirSync(co);
  run(co, 'init', '-q', '-b', 'main');
  write(co, 'package.json', '{"version":"0.1.0-alpha.48","type":"module"}\n');
  write(co, 'android/AndroidManifest.xml', manifest(23, '0.1.0-alpha.48'));
  write(co, 'CHANGELOG.md', changelog(''));
  write(co, 'backend/rd.mjs', 'export const a = 1;\n\nexport const b = 2;\n\nexport const c = 3;\n');
  write(co, 'tests/rd.test.mjs', rdTest('', 'old name'));
  write(co, 'docs/setup.md', 'setup\n');
  write(co, 'tests/ok.test.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
  run(co, 'add', '-A'); run(co, 'commit', '-q', '-m', 'base');
  const base = run(co, 'rev-parse', 'HEAD');
  run(co, 'checkout', '-q', '-b', 'release');
  write(co, 'package.json', '{"version":"0.1.0-alpha.49","type":"module"}\n');
  write(co, 'android/AndroidManifest.xml', manifest(25, '0.1.0-alpha.49'));
  write(co, 'CHANGELOG.md', changelog('').replace('## 0.1.0-alpha.48', '## 0.1.0-alpha.49\n\n- new\n\n## 0.1.0-alpha.48'));
  write(co, 'backend/rd.mjs', 'export const a = 1;\n\nexport const b = 2;\n\nexport const c = 3;\nexport const log = true;\n');
  write(co, 'tests/rd.test.mjs', rdTest("test('inserted by the release', () => {});\n\n", 'old name'));
  write(co, 'public/new.js', 'new\n');
  run(co, 'add', '-A'); run(co, 'commit', '-q', '-m', 'release');
  const target = run(co, 'rev-parse', 'HEAD');
  run(co, 'checkout', '-q', 'main');
  write(co, 'CHANGELOG.md', changelog('- wip entry\n'));
  write(co, 'backend/rd.mjs', 'export const a = 10;\n\nexport const b = 2;\n\nexport const c = 3;\n');
  write(co, 'tests/rd.test.mjs', rdTest('', 'renamed by the WIP'));
  write(co, 'docs/setup.md', 'setup, edited\n');
  write(co, 'AGENTS.md', 'untracked notes\n');
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ http: { host: '127.0.0.1', port: 1 }, android: { versionCode: 24, versionName: '0.1.0-alpha.48' } }), { mode: 0o600 });
  return { root, co, base, target, config, backups: path.join(root, 'backups') };
}
const apply = (r, ...args) => spawnSync(process.execPath, [script, '--checkout', r.co, '--target', r.target, '--config', r.config, '--backups', r.backups, '--no-restart', ...args], { encoding: 'utf8' });
const snapshot = r => ({ status: raw(r.co, 'status', '--porcelain=v1', '--untracked-files=all'), head: run(r.co, 'rev-parse', 'HEAD'),
  files: ['CHANGELOG.md', 'backend/rd.mjs', 'tests/rd.test.mjs', 'docs/setup.md', 'AGENTS.md'].map(f => read(r.co, f)), config: fs.readFileSync(r.config, 'utf8'),
  index: fs.statSync(path.join(r.co, '.git/index')).mtimeMs });

test('dry-run reports the WIP and the merges, runs the composed suite, and writes nothing', t => {
  const r = repo(t), before = snapshot(r);
  const out = apply(r);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /WIP preservado: 4 rastreado\(s\), 1 não rastreado\(s\)/);
  assert.match(out.stdout, /merge backend\/rd\.mjs: limpo/);
  assert.match(out.stdout, /merge tests\/rd\.test\.mjs: inserção ao lado de edição/);
  assert.match(out.stdout, /android 24\/0\.1\.0-alpha\.48 -> 25\/0\.1\.0-alpha\.49/);
  assert.match(out.stdout, /Suíte na árvore composta \(release \+ WIP\): ok, 4 testes, 4 passam/);
  assert.match(out.stdout, /Dry-run: nada foi alterado/);
  assert.deepEqual(snapshot(r), before);
  assert.equal(fs.existsSync(r.backups), false);
});

test('--apply fast-forwards main, keeps every WIP change and the untracked file, bumps the config', t => {
  const r = repo(t);
  const out = apply(r, '--apply', '--skip-tests');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(run(r.co, 'rev-parse', 'HEAD'), r.target);
  assert.equal(run(r.co, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(run(r.co, 'cat-file', '-t', 'HEAD^{commit}'), 'commit');
  assert.equal(run(r.co, 'rev-list', '--count', 'HEAD'), '2', 'no merge commit');
  assert.equal(read(r.co, 'package.json'), '{"version":"0.1.0-alpha.49","type":"module"}\n');
  assert.equal(read(r.co, 'public/new.js'), 'new\n');
  assert.equal(read(r.co, 'backend/rd.mjs'), 'export const a = 10;\n\nexport const b = 2;\n\nexport const c = 3;\nexport const log = true;\n');
  assert.equal(read(r.co, 'tests/rd.test.mjs'), rdTest("test('inserted by the release', () => {});\n\n", 'renamed by the WIP'));
  const log = read(r.co, 'CHANGELOG.md');
  assert.match(log, /- wip entry\n\n## 0\.1\.0-alpha\.49\n\n- new\n/);
  assert.equal(read(r.co, 'docs/setup.md'), 'setup, edited\n');
  assert.equal(read(r.co, 'AGENTS.md'), 'untracked notes\n');
  assert.equal(run(r.co, 'diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.deepEqual(raw(r.co, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean).sort(),
    [' M CHANGELOG.md', ' M backend/rd.mjs', ' M docs/setup.md', ' M tests/rd.test.mjs', '?? AGENTS.md'].sort());
  assert.deepEqual(JSON.parse(fs.readFileSync(r.config, 'utf8')).android, { versionCode: 25, versionName: '0.1.0-alpha.49' });
  assert.equal(fs.statSync(r.config).mode & 0o777, 0o600);
  const [dir] = fs.readdirSync(r.backups);
  assert.match(fs.readFileSync(path.join(r.backups, dir, 'wip.patch'), 'utf8'), /renamed by the WIP/);
  assert.match(out.stdout, /Sem restart \(--no-restart\)/);
});

test('--rollback puts main, the WIP, the untracked file and the config back exactly', t => {
  const r = repo(t), before = snapshot(r);
  assert.equal(apply(r, '--apply', '--skip-tests').status, 0);
  const dir = path.join(r.backups, fs.readdirSync(r.backups)[0]);
  const out = spawnSync(process.execPath, [script, '--rollback', dir, '--no-restart'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const after = snapshot(r);
  assert.deepEqual({ ...after, index: 0 }, { ...before, index: 0 });
  assert.equal(fs.existsSync(path.join(r.co, 'public/new.js')), false);
});

test('a WIP edit next to a release insertion keeps both', t => {
  const r = repo(t);
  write(r.co, 'backend/rd.mjs', 'export const a = 1;\n\nexport const b = 2;\n\nexport const c = 30;\n');
  assert.equal(apply(r, '--apply', '--skip-tests').status, 0);
  assert.equal(read(r.co, 'backend/rd.mjs'), 'export const a = 1;\n\nexport const b = 2;\n\nexport const c = 30;\nexport const log = true;\n');
});

test('a WIP edit on the very lines the release edits blocks before anything is written', t => {
  const r = repo(t);
  write(r.co, 'package.json', '{"version":"0.1.0-alpha.48-local","type":"module"}\n');
  const before = snapshot(r);
  const out = apply(r, '--apply');
  assert.equal(out.status, 2);
  assert.match(out.stdout, /BLOQUEIO: package\.json: conflito/);
  assert.deepEqual(snapshot(r), before);
  assert.equal(fs.existsSync(r.backups), false);
});

test('a checkout that moved away from the release base, or staged changes, block', t => {
  const r = repo(t);
  write(r.co, 'docs/other.md', 'x\n'); run(r.co, 'add', 'docs/other.md');
  let out = apply(r);
  assert.equal(out.status, 2);
  assert.match(out.stdout, /mudanças no índice \(staged\)/);
  run(r.co, 'commit', '-q', '-m', 'diverged', '--', 'docs/other.md');
  out = apply(r);
  assert.equal(out.status, 2);
  assert.match(out.stdout, /não é ancestral do alvo/);
});

test('an APK that is not the expected build blocks', t => {
  const r = repo(t);
  const apk = path.join(r.root, 'Ponte.apk');
  fs.writeFileSync(apk, 'apk');
  const out = apply(r, '--apk', apk, '--apk-sha256', '0'.repeat(64), '--skip-tests');
  assert.equal(out.status, 2);
  assert.match(out.stdout, /BLOQUEIO: APK com sha256/);
});

test('resolveHunk keeps an insertion next to an edit and nothing else', () => {
  assert.deepEqual(resolveHunk(['new', '', 'old'], ['old'], ['edited']), ['new', '', 'edited']);
  assert.deepEqual(resolveHunk(['old', 'new'], ['old'], ['edited']), ['edited', 'new']);
  assert.deepEqual(resolveHunk(['edited'], ['old'], ['old', 'wip insertion']), ['edited', 'wip insertion']);
  assert.equal(resolveHunk(['a'], ['old'], ['b']), null);
  assert.equal(resolveHunk(['new', 'old'], ['old'], ['old', 'more']), null);
  assert.equal(resolveHunk(['x'], [], ['y']), null);
});

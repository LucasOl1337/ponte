#!/usr/bin/env node
// Release directory deployment. Never writes the shared checkout or private config.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C',repo,...args], {encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
const read = file => fs.readFileSync(file);
export function snapshot(checkout) {
  const status = git(checkout,'status','--porcelain=v1','-z','--untracked-files=all','--no-renames');
  const files = status.split('\0').filter(Boolean).map(entry => {
    const name = entry.slice(3), file = path.join(checkout,name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Non-regular source: ${name}`);
    return {path:name,sha256:digest(read(file))};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  return {checkout:path.resolve(checkout),head:git(checkout,'rev-parse','HEAD').trim(),status,files};
}
export function verifySource(expected) {
  const actual = snapshot(expected.checkout);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Source checkout changed since preservation inventory. Reconcile before deployment.');
}
export function verifyDeclared(checkout, source, baseCommit, declarations) {
  if (source.files.length !== Object.keys(declarations).length) throw Error('Every WIP file needs a declaration.');
  for (const file of source.files) {
    const item = declarations[file.path];
    if (!item || !item.reason) throw Error(`Undeclared WIP: ${file.path}`);
    if (item.kind === 'already-versioned') {
      if (digest(git(checkout,'show',`${baseCommit}:${file.path}`)) !== file.sha256) throw Error(`Not preserved byte-for-byte: ${file.path}`);
    } else if (item.kind === 'instructions-only' && ['AGENTS.md','CLAUDE.md'].includes(file.path)) continue;
    else if (item.kind === 'multi-client-patch' && ['backend/rd.mjs','tests/rd.test.mjs','tests/rd-ui.test.mjs','tests/helpers/rd-fake-server.mjs','docs/setup.md','CHANGELOG.md'].includes(file.path)) {
      if (digest(git(checkout,'show',`${item.commit}:${file.path}`)) !== item.preservedSha256) throw Error(`Preservation commit changed: ${file.path}`);
    }
    else throw Error(`Invalid WIP treatment: ${file.path}`);
  }
}
function treeFiles(dir, prefix='') {
  return fs.readdirSync(path.join(dir,prefix),{withFileTypes:true}).flatMap(entry => {
    const name = path.join(prefix,entry.name);
    if (entry.isDirectory()) return treeFiles(dir,name);
    if (!entry.isFile()) throw Error(`Non-regular release: ${name}`);
    return [{path:name,sha256:digest(read(path.join(dir,name)))}];
  }).sort((a,b)=>a.path.localeCompare(b.path));
}
export function verifyRelease(plan) {
  for (const file of plan.files) if (digest(read(path.join(plan.release,file.path))) !== file.sha256) throw Error(`Release changed: ${file.path}`);
}
const unit = 'ponte-remote.service';
const env = {...process.env,XDG_RUNTIME_DIR:`/run/user/${process.getuid()}`};
const systemctl = (...args) => execFileSync('systemctl',['--user',...args],{encoding:'utf8',env});
const existsContent = file => fs.existsSync(file) ? read(file).toString('base64') : null;
export function restore(file, base64) {
  if (base64 === null) fs.rmSync(file,{force:true});
  else fs.writeFileSync(file,Buffer.from(base64,'base64'),{mode:0o600});
}
function withLock(run) {
  const dir = path.join(os.homedir(),'.local/state/ponte'); fs.mkdirSync(dir,{recursive:true});
  const file = path.join(dir,'release-directory.lock');
  const fd = fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(fd,String(process.pid)); return run(); }
  finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
export function dropIn(release) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(release)) throw Error('Release path must be absolute without whitespace or systemd specifiers.');
  return `[Service]\nWorkingDirectory=${release}\nExecStart=\nExecStart=/usr/bin/bash ${release}/start.sh\n`;
}
function health(release, version) {
  let reply;
  for (let attempt=0;attempt<20;attempt++) {
    try { reply = JSON.parse(execFileSync(process.execPath,[path.join(release,'bin/ponte-ctl.mjs'),'health'],{encoding:'utf8',env,stdio:['ignore','pipe','pipe'],timeout:3000})); if (reply.ok) break; } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
  }
  if (!reply) throw Error('Service did not answer after restart.');
  if (!reply.ok || reply.data.version !== version) throw Error(`Effective served version is not ${version}`);
  const pid = systemctl('show',unit,'--property=MainPID','--value').trim();
  if (fs.realpathSync(`/proc/${pid}/cwd`) !== release) throw Error('Service did not start from release directory.');
  return {version:reply.data.version,pid};
}
export function main(argv) {
  const options = {};
  for (let i=0;i<argv.length;i++) { const key=argv[i]; if (['--apply','--prepare'].includes(key)) options[key]=true; else if (['--inventory','--target','--release-root','--activate','--rollback'].includes(key)) options[key]=argv[++i]; else throw Error(`Unknown option ${key}`); }
  if (options['--activate'] || options['--rollback']) {
    const planFile = path.resolve(options['--activate'] || options['--rollback']), plan=JSON.parse(read(planFile));
    const rollback=!!options['--rollback'];
    verifySource(plan.source); verifyRelease(plan);
    const expected = rollback ? Buffer.from(plan.dropIn).toString('base64') : plan.previousDropIn;
    if (existsContent(plan.dropInFile) !== expected) throw Error('Drop-in changed. Refusing to overwrite another deployment.');
    if (!rollback && systemctl('cat',unit) !== plan.previousUnit) throw Error('Live unit changed since prepare.');
    if (!options['--apply']) { console.log(JSON.stringify({dryRun:true,action:rollback?'rollback':'activate',target:plan.target,release:plan.release,sourcePreserved:true})); return; }
    withLock(()=>{
      verifySource(plan.source); verifyRelease(plan);
      fs.mkdirSync(path.dirname(plan.dropInFile),{recursive:true});
      if (rollback) restore(plan.dropInFile,plan.previousDropIn);
      else fs.writeFileSync(plan.dropInFile,plan.dropIn,{mode:0o600});
      try { systemctl('daemon-reload'); systemctl('restart',unit); if (!rollback) console.log(JSON.stringify(health(plan.release,plan.version))); }
      catch(error) { if (!rollback) { restore(plan.dropInFile,plan.previousDropIn); systemctl('daemon-reload'); systemctl('restart',unit); } throw error; }
      verifySource(plan.source);
    });
    console.log(JSON.stringify({ok:true,action:rollback?'rolled-back':'activated',plan:planFile})); return;
  }
  if (!options['--inventory'] || !options['--target']) throw Error('Usage: --inventory JSON --target SHA [--prepare] [--release-root DIR], then --activate PLAN [--apply] or --rollback PLAN [--apply]. Default is dry-run.');
  const inventory = JSON.parse(read(options['--inventory'])), {source,baseCommit,preservedCommit,declarations}=inventory;
  verifySource(source); verifyDeclared(source.checkout,source,baseCommit,declarations);
  if (!/^[a-f0-9]{40}$/.test(options['--target'])) throw Error('Use the explicit full target SHA, not HEAD or a moving branch.');
  const target=git(source.checkout,'rev-parse','--verify',`${options['--target']}^{commit}`).trim();
  git(source.checkout,'merge-base','--is-ancestor',preservedCommit,target);
  const version=JSON.parse(git(source.checkout,'show',`${target}:package.json`)).version;
  const release=path.join(options['--release-root'] || path.join(os.homedir(),'.local/share/ponte/releases'),target);
  const text=dropIn(release);
  if (!options['--prepare']) { console.log(JSON.stringify({dryRun:true,target,version,release,wipFiles:source.files.length,sourcePreserved:true})); return; }
  if (fs.existsSync(release)) throw Error('Release already exists. Reuse its plan or choose another release-root, never overwrite.');
  fs.mkdirSync(release,{recursive:true,mode:0o700});
  execFileSync('tar',['-x','-C',release],{input:execFileSync('git',['-C',source.checkout,'archive',target],{maxBuffer:128<<20})});
  const files=treeFiles(release);
  const logs=execFileSync(process.execPath,['--test',...fs.readdirSync(path.join(release,'tests')).filter(f=>f.endsWith('.test.mjs')).map(f=>path.join(release,'tests',f))],{cwd:release,env:{...env,PONTE_CONFIG:path.join(release,'no-config.json')},maxBuffer:64<<20,timeout:240000});
  const planDir=path.join(os.homedir(),'.local/state/ponte/release-plans',target); fs.mkdirSync(planDir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(planDir,'tests.log'),logs,{mode:0o600});
  const dropInFile=path.join(os.homedir(),'.config/systemd/user',`${unit}.d`,'90-ponte-release.conf');
  const plan={target,version,release,files,source,dropInFile,dropIn:text,previousDropIn:existsContent(dropInFile),previousUnit:systemctl('cat',unit),inventory};
  verifyRelease(plan); verifySource(source);
  const planFile=path.join(planDir,'plan.json'); fs.writeFileSync(planFile,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({prepared:true,target,version,release,plan:planFile,next:`node tools/release/directory.mjs --activate ${planFile}` }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { main(process.argv.slice(2)); } catch(error) { console.error(error.message); process.exitCode=1; } }

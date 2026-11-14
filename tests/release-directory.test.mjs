import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { snapshot, verifySource, verifyDeclared, verifyRelease, dropIn, restore } from '../tools/release/directory.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ponte-release-inventory-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init'); git('config','user.email','fixture@example.invalid'); git('config','user.name','Fixture');
  fs.writeFileSync(path.join(dir,'code'),'base\n'); git('add','.'); git('commit','-m','base');
  const base=git('rev-parse','HEAD').trim();
  fs.writeFileSync(path.join(dir,'code'),'wip\n');
  return {dir,base,git};
}
test('release inventory rejects modified source, new undeclared files and changed index', t=>{
  const {dir,git}=fixture(t), initial=snapshot(dir);
  verifySource(initial);
  verifySource({files:initial.files.map(f=>({sha256:f.sha256,path:f.path})),status:initial.status,head:initial.head,checkout:initial.checkout});
  fs.writeFileSync(path.join(dir,'code'),'changed\n');
  assert.throws(()=>verifySource(initial),/changed since/);
  fs.writeFileSync(path.join(dir,'code'),'wip\n'); verifySource(initial);
  fs.writeFileSync(path.join(dir,'another'),'new');
  assert.throws(()=>verifySource(initial),/changed since/);
  fs.unlinkSync(path.join(dir,'another')); git('add','code');
  assert.throws(()=>verifySource(initial),/changed since/);
});
test('declarations must explain every file and cannot disguise arbitrary code as instructions or RD', t=>{
  const {dir,base}=fixture(t), source=snapshot(dir);
  assert.throws(()=>verifyDeclared(dir,source,base,{}),/Every WIP/);
  assert.throws(()=>verifyDeclared(dir,source,base,{code:{kind:'already-versioned',reason:'claim'}}),/Not preserved/);
  assert.throws(()=>verifyDeclared(dir,source,base,{code:{kind:'instructions-only',reason:'claim'}}),/Invalid WIP/);
  assert.throws(()=>verifyDeclared(dir,source,base,{code:{kind:'multi-client-patch',reason:'claim'}}),/Invalid WIP/);
});
test('release file fingerprint catches tampering before activation', t=>{
  const {dir}=fixture(t);
  const plan={release:dir,files:[{path:'code',sha256:createHash('sha256').update('wip\n').digest('hex')}]};
  verifyRelease(plan); fs.writeFileSync(path.join(dir,'code'),'unexpected');
  assert.throws(()=>verifyRelease(plan),/Release changed/);
});
test('rollback restores an existing drop-in byte-for-byte or removes only the newly created one', t=>{
  const {dir}=fixture(t), file=path.join(dir,'release.conf');
  const original='[Service]\nWorkingDirectory=/original\n';
  fs.writeFileSync(file,'new release'); restore(file,Buffer.from(original).toString('base64'));
  assert.equal(fs.readFileSync(file,'utf8'),original);
  restore(file,null); assert.equal(fs.existsSync(file),false);
});
test('drop-in only replaces working directory and start command, preserving env and private config',()=>{
  const text=dropIn('/home/test/releases/abcdef');
  assert.match(text,/ExecStart=\nExecStart=\/usr\/bin\/bash/);
  assert.doesNotMatch(text,/Environment|Config/);
  assert.throws(()=>dropIn('/bad/path%h'),/systemd/);
  assert.throws(()=>dropIn('/bad path'),/systemd/);
});

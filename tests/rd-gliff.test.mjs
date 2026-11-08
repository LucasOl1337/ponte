import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ponte-gliff-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await mkdir(path.join(directory, '.ssh'));
  await writeFile(path.join(directory, '.ssh/config'), 'Host notebook laptop\n HostName example.invalid\n');
  const log = path.join(directory, 'calls.jsonl');
  const stub = `#!/usr/bin/env python3
import json,os,subprocess,sys
from pathlib import Path
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['TEST_LOG'],'a') as f: f.write(json.dumps({'bin':name,'args':args,'config':os.environ.get('XDG_CONFIG_HOME')})+'\\n')
if name=='gliff':
 if args==['--version']: print('gliff 0.4.1'); sys.exit(0)
 if os.environ.get('TEST_GLiff_FAIL'): print('display connection failed',file=sys.stderr); sys.exit(4)
 r=subprocess.run(['ssh','-G','--',args[-1]],capture_output=True,text=True)
 if r.returncode: print(r.stderr,file=sys.stderr); sys.exit(r.returncode)
 r=subprocess.run(['ssh','-T','-o','Compression=no','-o','IPQoS=lowdelay','--',args[-1],args[args.index('--server-bin')+1],'--stdio'])
 sys.exit(r.returncode)
elif '-G' in args: print('remotecommand none')
elif '--stdio' not in args:
 if os.environ.get('TEST_SSH_FAIL'): print('Host key verification failed',file=sys.stderr); sys.exit(255)
 print('gliff-server 0.4.1'); print('[{"instance":"fixture"}]')
`;
  for (const name of ['gliff', 'ssh']) await writeFile(path.join(bin, name), stub, { mode: 0o755 });
  const env = { ...process.env, HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'), PONTE_CONFIG: path.join(directory, 'config/ponte.json'), PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const cli = (args, extra = {}) => exec('python3', [path.join(root, 'ponte'), 'rd', ...args], { cwd: root, env: { ...env, ...extra }, timeout: 10000 });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  return { directory, cli, calls };
}

test('rd native CLI lists offline, checks without launching, then wraps real child SSH argv', async t => {
  const f = await fixture(t);
  const listed = JSON.parse((await f.cli(['--list'])).stdout);
  assert.equal(listed.devices[0].id, 'ssh:notebook');
  await assert.rejects(f.calls(), { code: 'ENOENT' });
  const check = JSON.parse((await f.cli(['ssh:notebook', '--check'])).stdout);
  assert.equal(check.engine, 'gliff');
  assert.equal((await f.calls()).filter(call => call.bin === 'gliff').length, 1, 'only --version, no GUI');
  const opened = await f.cli(['laptop', '--engine', 'gliff', '--monitor', 'DP-3', '--no-clipboard', '--video', 'cpu']);
  assert.match(opened.stdout, /via SSH laptop \(Gliff\)/);
  const calls = await f.calls();
  const gliff = calls.find(call => call.bin === 'gliff' && call.args.includes('--server-bin'));
  assert.deepEqual(gliff.args, ['--server-bin', 'gliff-server', '--output', 'DP-3', '--no-clipboard', '--video', 'cpu', '--', 'laptop']);
  assert.notEqual(gliff.config, path.join(f.directory, 'config'));
  await assert.rejects(stat(gliff.config), { code: 'ENOENT' });
  const stream = calls.find(call => call.bin === 'ssh' && call.args.includes('--stdio'));
  assert.deepEqual(stream.args.slice(0, 4), ['-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes']);
  assert.equal(stream.args[stream.args.indexOf('--') + 1], 'laptop');
});

test('rd native CLI refuses unknown aliases, incompatible options and connection failures without legacy fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(f.cli(['notebook;id']), error => /Unknown SSH device/.test(error.stderr));
  await assert.rejects(f.cli(['notebook', '--engine', 'gliff', '--print-url']), error => /web-only/.test(error.stderr));
  await assert.rejects(f.cli(['notebook', '--headless', '--monitor', 'DP-1']), error => /mutually exclusive/.test(error.stderr));
  await assert.rejects(f.calls(), { code: 'ENOENT' });
  await assert.rejects(f.cli(['notebook'], { TEST_SSH_FAIL: '1' }), error => /never accepts keys automatically/.test(error.stderr));
  assert.equal((await f.calls()).some(call => call.bin === 'gliff' && call.args.includes('--server-bin')), false);
  await assert.rejects(f.cli(['notebook'], { TEST_GLiff_FAIL: '1' }), error => /Gliff exited with code 4: display connection failed/.test(error.stderr));
  assert.equal((await f.calls()).some(call => call.bin === 'chromium'), false);
});

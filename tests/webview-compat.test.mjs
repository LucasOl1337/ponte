import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
// Oldest supported WebView is Chrome 83 (minSdk 26): public scripts must avoid newer APIs.
const banned = [/Object\.hasOwn/, /structuredClone/, /Promise\.any/, /\.replaceAll\(/, /\?\?=/, /\|\|=|&&=/, /\.at\(/, /randomUUID/, /findLast/, /WeakRef/, /FinalizationRegistry/];
test('public scripts avoid post-Chrome-83 APIs', async () => {
 const dir = new URL('../public/', import.meta.url);
 for (const name of (await readdir(dir)).filter(name => name.endsWith('.js'))) {
  const source = await readFile(new URL(name, dir), 'utf8');
  for (const pattern of banned) assert.ok(!pattern.test(source), `${name} uses banned ${pattern}`);
 }
});

test('the interface version constant matches package.json so stale phones reload', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const match = /const UI_VERSION = '([^']+)'/.exec(app);
  assert.ok(match, 'UI_VERSION declared');
  assert.equal(match[1], pkg.version);
});

test('every cache-busting ?v= in the pages matches package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const page of ['index.html', 'rd.html']) {
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const versions = [...html.matchAll(/\?v=([^"'&\s>]+)/g)].map(found => found[1]);
    assert.ok(versions.length, `${page} has versioned assets`);
    assert.deepEqual([...new Set(versions)], [pkg.version], `${page} still loads an older build`);
  }
});

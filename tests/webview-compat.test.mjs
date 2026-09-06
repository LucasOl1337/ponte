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

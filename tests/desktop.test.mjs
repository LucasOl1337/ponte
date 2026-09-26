import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

// The companion CLI/core require only stdlib. GUI tests are deliberately excluded:
// npm test must never create a Qt window or contact a real Android device.
for (const pattern of ['test_bridge.py', 'test_cli.py']) {
  test(`desktop stdlib suite: ${pattern}`, { timeout: 120_000 }, async t => {
    try {
      await run('python3', ['--version'], { cwd: root, timeout: 5_000 });
    } catch (error) {
      if (error.code === 'ENOENT') {
        t.skip('python3 is not installed; desktop stdlib tests require Python 3');
        return;
      }
      throw error;
    }
    let result;
    try {
      result = await run('python3', [
        '-m', 'unittest', 'discover', '-s', 'desktop/tests', '-p', pattern,
      ], {
        cwd: root,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        timeout: 110_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      assert.fail(`${pattern} failed:\n${error.stdout || ''}${error.stderr || error.message}`);
    }
    assert.match(`${result.stdout}${result.stderr}`, /Ran [1-9]\d* tests?\b/,
      `${pattern} must actually discover tests, not silently pass an empty suite`);
  });
}

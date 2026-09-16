import { fileURLToPath } from 'node:url';
import { loadSettings } from '../backend/config.mjs';
import { readNativeTls } from '../backend/tls.mjs';

// ExecCondition exit 1 skips startup without scheduling another restart.
try {
  const settings = await loadSettings();
  await readNativeTls(settings.nativeTls?.certFile, settings.nativeTls?.keyFile,
    fileURLToPath(new URL('../public/', import.meta.url)));
} catch (error) {
  console.error(`Ponte startup blocked: ${error.message}`);
  console.error('Restore the configured files or repair the configuration, then run ./ponte start.');
  process.exitCode = 1;
}

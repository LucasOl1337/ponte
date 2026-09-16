import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';

export async function readNativeTls(certFile, keyFile, publicDir) {
  if (!certFile && !keyFile) return undefined;
  if (!certFile || !keyFile) throw new Error('Native TLS requires both certificate and key.');
  const [certPath, keyPath, publicPath] = await Promise.all([
    realpath(certFile), realpath(keyFile), realpath(publicDir),
  ]);
  const insidePublic = file => file === publicPath || file.startsWith(`${publicPath}${path.sep}`);
  if (insidePublic(certPath) || insidePublic(keyPath)) throw new Error('TLS files must be outside public/.');
  const tls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  createSecureContext(tls);
  return tls;
}

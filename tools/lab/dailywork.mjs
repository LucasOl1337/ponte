// Manual acceptance lab: real Ponte HTTP/UI and real isolated DailyWork API.
// Every PC adapter is synthetic. No desktop, clipboard, agent or tailnet access.
import path from 'node:path';
import { createApp } from '../../server.mjs';
import { createDailyWork } from '../../backend/dailywork.mjs';
const [descriptor, dataDir, portText = '8793'] = process.argv.slice(2);
const port = Number(portText);
if (!descriptor || !dataDir || !path.isAbsolute(descriptor) || !path.isAbsolute(dataDir) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Usage: node tools/lab/dailywork.mjs ABSOLUTE_ISOLATED_DESCRIPTOR ABSOLUTE_PRIVATE_DATA_DIR [PORT]');
const empty = async () => ({ items: [], sessions: [], machines: [], jobs: [] });
const denied = async () => { throw Error('PC actions disabled in DailyWork lab'); };
const app = await createApp({
  env: {}, dataDir, trustedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  dailywork: createDailyWork({ descriptor }),
  desktop: { getState: async () => ({ hostname: 'DailyWork isolado', windows: [], workspaces: [], monitors: [], activeWindow: null, volume: { value: 0, muted: true }, capabilities: {}, warnings: [] }), action: denied },
  audio: { list: empty }, terminals: { list: empty }, images: { list: empty }, agents: { list: empty },
  transcriber: { available: async () => false }, tailnetIdentity: { available: false },
  mesh: { id: 'isolado', name: 'DailyWork isolado', active: () => false, authorizePeer: () => null },
  fleet: { overview: empty, sessions: empty, jobs: empty }, rd: { capabilities: async () => ({ rd: false }), close: async () => {} },
});
app.server.listen(port, '127.0.0.1', () => console.log(`DailyWork lab: http://127.0.0.1:${port}. Pairing token stays in ${dataDir}/token.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });

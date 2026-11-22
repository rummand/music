// Entry point: node server/index.js

import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, () => {
  const mode = config.mock ? 'MOCK mode (no calls to mux)' : `mux ${config.muxBaseUrl} (vision=${config.visionModel}, text=${config.textModel})`;
  console.log(`Noder listening on port ${config.port} — ${mode}`);
});
// The vision model can take up to the mux timeout; keep sockets open long enough.
server.requestTimeout = config.timeoutMs * 2 + 30_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

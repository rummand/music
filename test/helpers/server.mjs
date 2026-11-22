// Start server/index.js as a child process on a free port and wait for /health.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'server', 'index.js');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startServer(extraEnv) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), MUX_MOCK_DELAY_MS: '0', RATE_LIMIT_READ: '0', RATE_LIMIT_EDIT: '0', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited (${child.exitCode}):\n${log}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`server did not start:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    log: () => log,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode != null) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }),
  };
}


import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Dev-only sink for the session log. The browser can't write files, so the
 * client POSTs each decision/log entry to /__log and this appends it to
 * .logs/session-<start>.jsonl — one file per dev-server run, greppable when
 * iterating on the planner prompts. See src/lib/sessionlog.ts.
 */
function logSink(): Plugin {
  return {
    name: 'skuzic-log-sink',
    configureServer(server) {
      const dir = fileURLToPath(new URL('./.logs', import.meta.url));
      mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`,
      );
      server.middlewares.use('/__log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            if (body.trim()) appendFileSync(file, body.trim() + '\n');
            res.statusCode = 204;
          } catch {
            res.statusCode = 500;
          }
          res.end();
        });
      });
    },
  };
}

/**
 * Dev-only writes for the perception lab (src/perception/Lab.tsx): a recorded
 * drawing into test/perception/recordings, an evaluation report into .logs,
 * and the probes' calibration into src/perception/probe-vectors.json.
 */
function perceptionSink(): Plugin {
  return {
    name: 'skuzic-perception-sink',
    configureServer(server) {
      const root = fileURLToPath(new URL('.', import.meta.url));
      server.middlewares.use('/__perception', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const { kind, name, data } = JSON.parse(body);
            if (kind === 'recording') {
              if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('bad name');
              const dir = path.join(root, 'test/perception/recordings');
              mkdirSync(dir, { recursive: true });
              writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data) + '\n');
            } else if (kind === 'report') {
              const dir = path.join(root, '.logs');
              mkdirSync(dir, { recursive: true });
              const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              writeFileSync(path.join(dir, `perception-eval-${stamp}.json`), JSON.stringify(data, null, 1) + '\n');
            } else if (kind === 'calibration') {
              const file = path.join(root, 'src/perception/probe-vectors.json');
              const vectors = JSON.parse(readFileSync(file, 'utf8'));
              for (const [id, c] of Object.entries(data as Record<string, { mu: number; sigma: number }>)) {
                if (!(id in vectors.vectors) || !Number.isFinite(c.mu) || !(c.sigma > 0)) throw new Error('bad calibration');
              }
              vectors.calibration = data;
              writeFileSync(file, JSON.stringify(vectors) + '\n');
            } else {
              throw new Error('unknown kind');
            }
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

/**
 * The hosted demo's key relay (api/gemini.mjs) inside `pnpm dev`, when .env
 * has GEMINI_API_KEY (no VITE_ prefix, so it never reaches the bundle).
 * Without it, dev asks for a key in the app like a fork without one would.
 */
function demoRelay(key: string | undefined): Plugin {
  return {
    name: 'skuzic-demo-relay',
    async configureServer(server) {
      if (!key) return;
      process.env.GEMINI_API_KEY = key;
      // Plain JS for Vercel, so it's loaded by URL rather than type-checked here.
      const { default: relay }: { default: Server } = await import(new URL('./api/gemini.mjs', import.meta.url).href);
      server.middlewares.use((req, res, next) =>
        req.url?.startsWith('/api/gemini') ? relay.emit('request', req, res) : next(),
      );
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url?.startsWith('/api/gemini')) relay.emit('upgrade', req, socket, head);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), logSink(), perceptionSink(), demoRelay(loadEnv(mode, process.cwd(), '').GEMINI_API_KEY)],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173 },
}));

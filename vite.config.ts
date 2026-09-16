import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
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

export default defineConfig({
  plugins: [react(), tailwindcss(), logSink()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173 },
});

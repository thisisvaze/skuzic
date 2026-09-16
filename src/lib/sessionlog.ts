/**
 * Mirror of the in-app action log, written to disk for prompt iteration. Each
 * entry is POSTed to the dev server's /__log middleware (vite.config.ts) and
 * lands in .logs/session-<start>.jsonl. Dev-only and fire-and-forget: in a
 * production build, or if the sink is missing, entries are silently dropped —
 * the instrument must never wait on its own diagnostics.
 */
export function logSession(kind: string, data: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  void fetch('/__log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ts: new Date().toISOString(), kind, ...data }),
  }).catch(() => {});
}

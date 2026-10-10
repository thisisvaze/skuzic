/**
 * The hosted demo's relay (api/gemini.mjs) adds skuzic's own key on the
 * server, so a visitor can play without one. An empty key means "go through
 * the relay"; a key the artist connected goes straight to Google instead.
 */
const RELAY = '/api/gemini';

/** GoogleGenAI options for a key, or for the relay when there is none. */
export function geminiAuth(key: string): { apiKey: string; httpOptions?: { baseUrl: string } } {
  return key ? { apiKey: key } : { apiKey: 'relay', httpOptions: { baseUrl: `${location.origin}${RELAY}` } };
}

/** What the relay offers: the demo key, and Turnstile's site key when it guards it. */
let health: Promise<{ demo?: boolean; turnstile?: string }> | undefined;
const relayHealth = () =>
  (health ??= fetch(`${RELAY}/health`)
    .then((res) => res.json())
    // Plain `pnpm dev` answers with index.html, which isn't JSON.
    .catch(() => ({})));

/** True where the relay holds a key: the hosted site, or `pnpm dev` with GEMINI_API_KEY set. */
export async function relayAvailable(): Promise<boolean> {
  return (await relayHealth()).demo === true;
}

let pass: { until: number; ready: Promise<void> } | undefined;

/**
 * Where the relay is guarded by Cloudflare Turnstile, clears its invisible
 * check and trades the token for an hour's pass, a cookie the relay reads.
 * Await it before each relay call: it's instant while the pass has time left.
 */
export function relayPass(): Promise<void> {
  // Renewed a minute early, so no call lands on a pass that just ran out.
  if (pass && pass.until - Date.now() > 60_000) return pass.ready;
  const next = { until: Infinity, ready: Promise.resolve() };
  next.ready = relayHealth().then(async ({ turnstile: sitekey }) => {
    if (!sitekey) return;
    const res = await fetch(`${RELAY}/pass`, { method: 'POST', body: await turnstileToken(sitekey) });
    if (!res.ok) throw new Error(FAILED);
    next.until = Date.now() + (await res.json()).seconds * 1000;
  });
  // A check that failed is tried afresh on the next call.
  next.ready.catch(() => pass === next && (pass = undefined));
  return (pass = next).ready;
}

const FAILED = "Couldn't check this browser with Cloudflare. Reload the page to try again.";

declare const turnstile: {
  render(box: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
};
let script: Promise<unknown> | undefined;

/** One Turnstile token: no widget at all, unless Cloudflare wants a click from a doubtful visitor. */
async function turnstileToken(sitekey: string): Promise<string> {
  await (script ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=skuzicTurnstile';
    Object.assign(window, { skuzicTurnstile: resolve });
    tag.onerror = () => {
      script = undefined;
      tag.remove();
      reject(new Error(FAILED));
    };
    document.head.append(tag);
  }));
  return new Promise((resolve, reject) => {
    const box = document.body.appendChild(document.createElement('div'));
    // Where the box shows up for the few visitors who do get asked to click.
    box.style.cssText = 'position:fixed;bottom:16px;left:50%;translate:-50%;z-index:100';
    const done = () => {
      turnstile.remove(id);
      box.remove();
    };
    const id = turnstile.render(box, {
      sitekey,
      appearance: 'interaction-only',
      callback: (token: string) => {
        resolve(token);
        setTimeout(done);
      },
      'error-callback': () => {
        reject(new Error(FAILED));
        setTimeout(done);
      },
    });
  });
}

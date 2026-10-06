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

/** True where the relay holds a key: the hosted site, or `pnpm dev` with GEMINI_API_KEY set. */
export async function relayAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${RELAY}/health`);
    return res.ok && (await res.json()).demo === true;
  } catch {
    // Plain `pnpm dev` answers with index.html, which isn't JSON.
    return false;
  }
}

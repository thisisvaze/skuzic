// The demo key, kept on the server. Visitors who haven't connected their own
// Gemini key reach Google through here: Lyria RealTime as a WebSocket relay,
// Reimagine as a plain POST. The key is the GEMINI_API_KEY environment
// variable on Vercel and never reaches the browser. Lyria won't take Google's
// short-lived tokens (tested 2026-10-06), so relaying is the only way to hide it.
//
// vercel.json routes /api/gemini/* here, and vite.config.ts mounts the same
// server in `pnpm dev` when GEMINI_API_KEY is set.
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

const GOOGLE = 'generativelanguage.googleapis.com';
const LYRIA = `wss://${GOOGLE}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic`;
// Only what skuzic itself calls (PLANNER_MODELS in src/llm/planner.ts), so the
// key can't be borrowed for anything else.
const PLAN = /^\/api\/gemini\/v1beta\/models\/(gemini-3\.8-flash|gemini-3\.5-flash-lite):generateContent$/;
const MAX_BODY = 4 * 1024 * 1024;

const key = () => process.env.GEMINI_API_KEY;

// Browsers always send Origin on these requests; only skuzic's own pages may
// spend the key. A script can fake it, so the real limits are Turnstile (below),
// the Firewall rule and the key's quota (see README, "Hosting your own").
function sameSite(req) {
  try {
    return new URL(req.headers.origin).host === (req.headers['x-forwarded-host'] ?? req.headers.host);
  } catch {
    return false;
  }
}

// Cloudflare Turnstile, once TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY are set:
// the page clears an invisible check and trades its token for an hour's pass, a
// cookie signed here, and nothing reaches Google without one.
// ponytail: a pass isn't tied to an IP, so one solved check can be shared for an
// hour; bind it to x-real-ip if that's ever abused.
const turnstile = () => process.env.TURNSTILE_SECRET_KEY;
const PASS_SECONDS = 60 * 60;
const sign = (until) => createHmac('sha256', turnstile()).update(until).digest('base64url');

function passed(req) {
  if (!turnstile()) return true;
  const [, until, mac] = /(?:^|;\s*)skuzic_pass=(\d+)\.([\w-]+)/.exec(req.headers.cookie ?? '') ?? [];
  if (!until || Number(until) < Date.now()) return false;
  const want = Buffer.from(sign(until));
  return mac.length === want.length && timingSafeEqual(Buffer.from(mac), want);
}

async function issuePass(req, res) {
  let token = '';
  for await (const chunk of req) if ((token += chunk).length > 4096) return send(res, 413, { error: 'too large' });
  const check = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: turnstile(), response: token, remoteip: req.headers['x-real-ip'] }),
  }).then((r) => r.json());
  if (!check.success) return send(res, 403, { error: 'Cloudflare turned this browser away' });
  const until = String(Date.now() + PASS_SECONDS * 1000);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'set-cookie',
    `skuzic_pass=${until}.${sign(until)}; Path=/api/gemini; Max-Age=${PASS_SECONDS}; HttpOnly; SameSite=Strict${secure}`,
  );
  send(res, 200, { seconds: PASS_SECONDS });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function plan(req, res, path) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return send(res, 413, { error: 'too large' });
    chunks.push(chunk);
  }
  const upstream = await fetch(`https://${GOOGLE}${path.slice('/api/gemini'.length)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key() },
    body: Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://relay').pathname;
  // The app asks this first, to know whether it can play without a key and
  // whether it needs to clear Turnstile to.
  if (path === '/api/gemini/health')
    return send(res, 200, { demo: !!key(), turnstile: turnstile() && process.env.TURNSTILE_SITE_KEY });
  if (!key()) return send(res, 503, { error: 'no demo key on this deployment' });
  if (req.method === 'POST' && path === '/api/gemini/pass' && turnstile() && sameSite(req))
    return issuePass(req, res).catch(() => send(res, 502, { error: 'Cloudflare did not answer' }));
  if (req.method !== 'POST' || !PLAN.test(path)) return send(res, 404, { error: 'not found' });
  if (!sameSite(req) || !passed(req)) return send(res, 403, { error: 'forbidden' });
  plan(req, res, path).catch(() => send(res, 502, { error: 'Google did not answer' }));
});

// Close codes a server may not send itself become a plain "went away".
const passable = (code) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || code >= 3000;

function relay(client) {
  const google = new WebSocket(`${LYRIA}?key=${key()}`);
  const early = [];
  client.on('message', (data, binary) => {
    if (google.readyState === WebSocket.OPEN) google.send(data, { binary });
    else early.push([data, binary]);
  });
  google.on('open', () => {
    for (const [data, binary] of early) google.send(data, { binary });
    early.length = 0;
  });
  google.on('message', (data, binary) => client.send(data, { binary }));
  // Google's close reason (a quota, a bad prompt) is what the app shows, so pass it on.
  google.on('close', (code, reason) => client.close(passable(code) ? code : 1011, String(reason).slice(0, 100)));
  google.on('error', () => client.close(1011, 'Google closed the stream'));
  client.on('close', () => google.terminate());
  client.on('error', () => google.terminate());
}

const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://relay').pathname;
  if (!key() || !sameSite(req) || !passed(req) || !path.endsWith('.BidiGenerateMusic')) return socket.destroy();
  sockets.handleUpgrade(req, socket, head, relay);
});

export default server;

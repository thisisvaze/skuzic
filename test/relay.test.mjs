// The relay's Turnstile gate: no pass, no key. Runs the real api/gemini.mjs
// with Cloudflare and Google stubbed out, so it needs no network.
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

process.env.GEMINI_API_KEY = 'demo-key';
process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
process.env.TURNSTILE_SITE_KEY = 'site-key';
const { default: server } = await import('../api/gemini.mjs');

const realFetch = fetch;
globalThis.fetch = async (url, init) =>
  String(url).includes('siteverify')
    ? Response.json({ success: JSON.parse(init.body).response === 'person' })
    : Response.json({ candidates: [] });

await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;
const post = (path, body, cookie) =>
  realFetch(`${base}/api/gemini${path}`, { method: 'POST', body, headers: { origin: base, ...(cookie && { cookie }) } });
const plan = (cookie) => post('/v1beta/models/gemini-3.8-flash:generateContent', '{}', cookie);
const signed = (until) =>
  `skuzic_pass=${until}.${createHmac('sha256', 'turnstile-secret').update(String(until)).digest('base64url')}`;

let failures = 0;
function check(name, condition, detail) {
  if (!condition) failures++;
  console.log(condition ? `  ok   ${name}` : `  FAIL ${name}`, condition ? '' : (detail ?? ''));
}

console.log('relay');
const health = await (await realFetch(`${base}/api/gemini/health`)).json();
check('health hands out the site key', health.turnstile === 'site-key', health);
check('no pass, no plan', (await plan()).status === 403);
check('a token Cloudflare rejects gets no pass', (await post('/pass', 'script')).status === 403);
const granted = await post('/pass', 'person');
const cookie = granted.headers.get('set-cookie')?.split(';')[0];
check('a token Cloudflare accepts gets a pass', granted.status === 200 && cookie?.startsWith('skuzic_pass='), cookie);
check('the pass lets a plan through', (await plan(cookie)).status === 200);
check('a forged pass is refused', (await plan(cookie.slice(0, -2) + 'xx')).status === 403);
check('an expired pass is refused', (await plan(signed(Date.now() - 1000))).status === 403);
const music = await new Promise((resolve) => {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/api/gemini/ws/x.BidiGenerateMusic`, { origin: base });
  socket.on('open', () => resolve('open'));
  socket.on('error', () => resolve('refused'));
});
check('no pass, no music stream', music === 'refused', music);

server.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);

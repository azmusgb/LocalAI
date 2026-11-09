'use strict';

// The cross-site request guard in app/server.js: another website open in a LAN browser must not be able to drive
// mutating API routes, while scripts, hooks and same-origin pages (direct on :3080 or through Caddy) keep working.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

let child, dataDir, port;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-csrf-'));
  const off = 'http://127.0.0.1:9';
  let ready;
  ({ child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off }
  }));
  // The tests below send Host and Origin headers with the port, so keep it.
  port = Number(new URL(await ready).port);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// node:http (not fetch) so the Host, Origin and Sec-Fetch-* headers are exactly what a browser or proxy would send.
function request(method, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, method, path: route, headers: { Host: `127.0.0.1:${port}`, Connection: 'keep-alive', ...headers } }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, connection: res.headers.connection }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const JSONH = { 'Content-Type': 'application/json' };
const ROUTES = [
  ['POST', '/api/claude/events', JSON.stringify({ type: 'progress', session: 'csrf-test', message: 'hello' })],
  ['POST', '/api/claude/chat/send', JSON.stringify({ sessionId: 'csrf-test', text: 'hi' })],
  ['POST', '/api/library/update', JSON.stringify({ id: 'none', title: 'x' })],
  ['POST', '/api/conversations/delete', JSON.stringify({ id: 'none' })],
  ['POST', '/api/agents/specialist/run', JSON.stringify({ agentId: 'none', goal: 'x' })],
  ['POST', '/api/agents/plan', JSON.stringify({ goal: 'x' })],
  ['POST', '/api/powershell/create', JSON.stringify({ command: 'x' })],
  ['POST', '/api/powershell/approve', JSON.stringify({ id: 'none' })],
  ['POST', '/api/powershell/request-run', JSON.stringify({ id: 'none' })],
  ['POST', '/api/display/pair/start', JSON.stringify({})],
];
const blocked = r => r.status === 403 && r.json?.error === 'Cross-site request blocked' && r.connection === 'close';

test('a cross-site Origin is rejected on mutating routes', async () => {
  for (const [method, route, body] of ROUTES) {
    const r = await request(method, route, { ...JSONH, Origin: 'http://evil.example' }, body);
    assert.ok(blocked(r), `${method} ${route} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  // Text/plain "simple" form posts, which need no CORS preflight, are the classic case.
  const form = await request('POST', '/api/claude/events', { 'Content-Type': 'text/plain', Origin: 'http://evil.example' }, '{"type":"progress"}');
  assert.ok(blocked(form));
  // Another port on the same host is another origin (n8n, ComfyUI pages).
  const otherPort = await request('POST', '/api/claude/events', { ...JSONH, Origin: 'http://127.0.0.1:5678' }, ROUTES[0][2]);
  assert.ok(blocked(otherPort));
  // An opaque origin (sandboxed iframe, file://) is not ours either.
  const opaque = await request('POST', '/api/claude/events', { ...JSONH, Origin: 'null' }, ROUTES[0][2]);
  assert.ok(blocked(opaque));
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await request(method, '/api/claude/events', { ...JSONH, Origin: 'http://evil.example' }, '{}');
    assert.ok(blocked(r), method);
  }
});

test('Sec-Fetch-Site: cross-site is rejected even without an Origin', async () => {
  for (const [method, route, body] of ROUTES) {
    const r = await request(method, route, { ...JSONH, 'Sec-Fetch-Site': 'cross-site' }, body);
    assert.ok(blocked(r), `${method} ${route}`);
  }
});

test('same-origin browser requests pass: direct on :3080 and through the HTTPS proxy', async () => {
  const cases = [
    { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
    // Through Caddy: Host is preserved (default port omitted by the browser) and X-Forwarded-* are added.
    { Host: '10.0.0.21', Origin: 'https://10.0.0.21', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': '10.0.0.21', 'Sec-Fetch-Site': 'same-origin' },
    { Host: 'localai.home.arpa', Origin: 'https://localai.home.arpa', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'localai.home.arpa' },
    { Host: '10.0.0.21:3080', Origin: 'http://10.0.0.21:3080', 'Sec-Fetch-Site': 'same-origin' },
    // An explicit default port in Host is the same origin.
    { Host: '10.0.0.21:443', Origin: 'https://10.0.0.21' },
    // A proxy that rewrites Host but reports the original in X-Forwarded-Host.
    { Host: 'local-ai-appliance:3080', Origin: 'https://localai.home.arpa', 'X-Forwarded-Host': 'localai.home.arpa' },
    // Case differences in the host name do not matter.
    { Host: 'LocalAI.Home.Arpa', Origin: 'https://localai.home.arpa' },
  ];
  for (const headers of cases) {
    const r = await request('POST', '/api/claude/events', { ...JSONH, ...headers }, ROUTES[0][2]);
    assert.notEqual(r.status, 403, JSON.stringify(headers));
    assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  const send = await request('POST', '/api/claude/chat/send', { ...JSONH, Origin: `http://127.0.0.1:${port}` }, ROUTES[1][2]);
  assert.ok(!blocked(send), JSON.stringify(send.json));
  assert.equal(send.status, 401, 'reaches the chat relay, which wants a paired device');
});

test('requests without Origin or Sec-Fetch-Site (scripts, hooks, curl) pass', async () => {
  for (const [method, route, body] of ROUTES) {
    const r = await request(method, route, JSONH, body);
    assert.ok(!blocked(r), `${method} ${route} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  const ok = await request('POST', '/api/claude/events', JSONH, ROUTES[0][2]);
  assert.equal(ok.status, 201);
  const sameSiteNoOrigin = await request('POST', '/api/claude/events', { ...JSONH, 'Sec-Fetch-Site': 'none' }, ROUTES[0][2]);
  assert.equal(sameSiteNoOrigin.status, 201, 'user-initiated (none) is not cross-site');
});

test('GET is never blocked', async () => {
  for (const route of ['/healthz', '/api/claude/board', '/api/library']) {
    const r = await request('GET', route, { Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(r.status, 200, route);
  }
});

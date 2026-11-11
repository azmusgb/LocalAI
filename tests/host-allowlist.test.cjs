'use strict';

// The DNS-rebinding guard (hostAllowed in app/server/http.js): only host names that can't be an attacker's are answered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const { allowedHosts, hostAllowed } = require('../app/server/http');

test('hostAllowed: IPs, dotless names, private suffixes and the configured names; any other name is refused', () => {
  const allowed = allowedHosts({ LOCALAI_HOST_IP: '10.0.0.81', LOCALAI_REMOTE_NAME: 'localai-pc.tail1234.ts.net', LOCALAI_ALLOWED_HOSTS: 'ai.example.org, Other.Example.NET ' });
  for (const h of [
    '127.0.0.1:3080', 'localhost:3080', 'localhost', '[::1]:3080', '[::1]', '10.0.0.81', '10.0.0.81:443', '192.168.1.9:3080',
    'local-ai-appliance:3080', 'myhost:3080', 'localai.home.arpa', 'LocalAI.Home.Arpa', 'localai.home.arpa.', 'localai.test:3180',
    'pc.local', 'app.localhost:3080', 'localai-pc.tail1234.ts.net', 'LOCALAI-PC.tail1234.ts.net:443', 'ai.example.org', 'other.example.net',
    'router.lan', 'svc.internal', undefined, ''
  ]) assert.equal(hostAllowed(h, allowed), true, String(h));
  for (const h of [
    'evil.example', 'evil.example:3080', 'attacker.com', 'localai.home.arpa.evil.com', 'someone-else.tail9999.ts.net', 'local.evil.com',
    '10.0.0.81.nip.io', 'example.org', 'ai.example.org.attacker.io', 'bad host', 'a/b', 'x@10.0.0.81'
  ]) assert.equal(hostAllowed(h, allowed), false, h);
  assert.ok(allowedHosts({}).has('localai.home.arpa'), 'Caddy\'s default name with nothing set');
  assert.ok(allowedHosts({ LOCALAI_NAME: 'ai.my-house.net' }).has('ai.my-house.net'));
  assert.equal(hostAllowed('ai.my-house.net', allowedHosts({})), false, 'a name of your own must be configured');
});

test('the server answers a rebound name with 421 before any route, and its own names as usual', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-hosts-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, LOCALAI_ALLOWED_HOSTS: 'ai.example.org', OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const port = Number(new URL(await ready).port);
  const request = (method, route, host, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, method, path: route, headers: { Host: host, ...headers } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
  for (const host of [`evil.example:${port}`, 'attacker.com']) {
    for (const route of ['/', '/healthz', '/api/claude/priorities']) {
      const r = await request('GET', route, host);
      assert.equal(r.status, 421, `${host} ${route}`);
      assert.doesNotMatch(r.text, /releaseCommit|<html/i, 'nothing of the app is served');
    }
    // A rebound page is same-origin to the browser, so its POST carries a matching Origin: refused all the same.
    const post = await request('POST', '/api/improve/handoff', host, { 'Content-Type': 'application/json', Origin: `http://${host}` }, '{"text":"x"}');
    assert.equal(post.status, 421);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localai.home.arpa', '10.0.0.81', 'local-ai-appliance:3080', 'ai.example.org']) {
    assert.equal((await request('GET', '/healthz', host)).status, 200, host);
  }
  const prio = JSON.parse((await request('GET', '/api/claude/priorities', `127.0.0.1:${port}`)).text);
  assert.equal(prio.items.length, 0, 'the refused POST handed nothing to Claude');
});

test('the app\'s public registry name (LOCALAI_PUBLIC_HOST, default assistant.rahe-home.duckdns.org) is answered; other public names are not', () => {
  const a = allowedHosts({});
  assert.equal(hostAllowed('assistant.rahe-home.duckdns.org', a), true);
  assert.equal(hostAllowed('evil.com', a), false);
  assert.equal(hostAllowed('pc.rahe-home.duckdns.org', a), false);
  assert.equal(hostAllowed('pc.rahe-home.duckdns.org', allowedHosts({ LOCALAI_PUBLIC_HOST: 'pc.rahe-home.duckdns.org' })), true);
});

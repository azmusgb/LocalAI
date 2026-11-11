'use strict';
// /go/n8n and /go/comfy build their target from the request. Behind the front gate the request's Host is 10.0.0.81 (the
// gate rewrites it) and the name the owner typed is only in X-Forwarded-Host, so the target must come from that.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeb } = require('../app/server/web.js');
const { allowedHosts, hostAllowed } = require('../app/server/http.js');

function go(headers, pathname = '/go/n8n', env = {}) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    const { redirectFor } = createWeb({ hostAllowed, ALLOWED_HOSTS: allowedHosts({ LOCALAI_PUBLIC_HOST: 'assistant.rahe-home.duckdns.org', LOCALAI_NAME: 'localai.home.arpa' }) });
    let status = null, location = null;
    const res = { writeHead(s, h) { status = s; location = h && h.Location; }, end() {} };
    const handled = redirectFor({ headers }, res, pathname);
    return { handled, status, location };
  } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

const GATED = { host: '10.0.0.81', 'x-forwarded-host': 'assistant.rahe-home.duckdns.org' };

test('reproduction: through the gate the link must not point at the rewritten Host 10.0.0.81', () => {
  assert.notEqual(go(GATED).location, 'http://10.0.0.81:5678/');
});

test('through the gate the target uses the forwarded host', () => {
  assert.equal(go(GATED, '/go/n8n').location, 'http://assistant.rahe-home.duckdns.org:5678/');
  assert.equal(go(GATED, '/go/n8n-assistant').location, 'http://assistant.rahe-home.duckdns.org:5678/settings/assistant');
  assert.equal(go(GATED, '/go/comfy').location, 'http://assistant.rahe-home.duckdns.org:8188/mobile/');
});

test('a direct request keeps using its own Host, port stripped', () => {
  assert.equal(go({ host: '10.0.0.81:3080' }).location, 'http://10.0.0.81:5678/');
  assert.equal(go({ host: 'localhost:3080' }, '/go/comfy').location, 'http://localhost:8188/mobile/');
});

test('a forwarded host must pass the same host check as Host; otherwise Host is used', () => {
  const own = 'http://10.0.0.81:5678/';
  for (const bad of ['evil.com', 'a.example', 'evil.com, assistant.rahe-home.duckdns.org', 'evil.example/x', 'a b', '@x', 'x?y', ''])
    assert.equal(go({ host: '10.0.0.81', 'x-forwarded-host': bad }).location, own, JSON.stringify(bad));
  assert.equal(go({ host: '10.0.0.81', 'x-forwarded-host': 'assistant.rahe-home.duckdns.org, evil.com' }).location, 'http://assistant.rahe-home.duckdns.org:5678/', 'the first value counts');
  assert.equal(go({ host: '10.0.0.81', 'x-forwarded-host': 'pc.home.arpa:443' }).location, 'http://pc.home.arpa:5678/', 'a private name is allowed, port dropped');
});

test('LOCALAI_GO_HOST fixes the host whatever the request says', () => {
  assert.equal(go(GATED, '/go/n8n', { LOCALAI_GO_HOST: 'pc.tail1234.ts.net' }).location, 'http://pc.tail1234.ts.net:5678/');
});

test('other paths are not handled', () => {
  assert.equal(go(GATED, '/go/other').handled, false);
});

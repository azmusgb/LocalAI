'use strict';
// /go/n8n and /go/comfy build their target from the request. Behind the front gate the request's Host is 10.0.0.21 (the
// gate rewrites it) and the name the owner typed is only in X-Forwarded-Host, so the target must come from that.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeb } = require('../app/server/web.js');

function go(headers, pathname = '/go/n8n', env = {}) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    const { redirectFor } = createWeb({});
    let status = null, location = null;
    const res = { writeHead(s, h) { status = s; location = h && h.Location; }, end() {} };
    const handled = redirectFor({ headers }, res, pathname);
    return { handled, status, location };
  } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

const GATED = { host: '10.0.0.21', 'x-forwarded-host': 'assistant.rahe-home.duckdns.org' };

test('reproduction: through the gate the link must not point at the rewritten Host 10.0.0.21', () => {
  assert.notEqual(go(GATED).location, 'http://10.0.0.21:5678/');
});

test('through the gate the target uses the forwarded host', () => {
  assert.equal(go(GATED, '/go/n8n').location, 'http://assistant.rahe-home.duckdns.org:5678/');
  assert.equal(go(GATED, '/go/n8n-assistant').location, 'http://assistant.rahe-home.duckdns.org:5678/settings/assistant');
  assert.equal(go(GATED, '/go/comfy').location, 'http://assistant.rahe-home.duckdns.org:8188/mobile/');
});

test('a direct request keeps using its own Host, port stripped', () => {
  assert.equal(go({ host: '10.0.0.21:3080' }).location, 'http://10.0.0.21:5678/');
  assert.equal(go({ host: 'localhost:3080' }, '/go/comfy').location, 'http://localhost:8188/mobile/');
});

test('only the first forwarded host counts, and one that is not a plain host name is ignored', () => {
  assert.equal(go({ host: '10.0.0.21', 'x-forwarded-host': 'a.example, b.example' }).location, 'http://a.example:5678/');
  for (const bad of ['evil.example/x', 'a b', '@x', 'x?y', '']) assert.equal(go({ host: '10.0.0.21', 'x-forwarded-host': bad }).location, 'http://10.0.0.21:5678/', JSON.stringify(bad));
});

test('LOCALAI_GO_HOST fixes the host whatever the request says', () => {
  assert.equal(go(GATED, '/go/n8n', { LOCALAI_GO_HOST: 'pc.tail1234.ts.net' }).location, 'http://pc.tail1234.ts.net:5678/');
});

test('other paths are not handled', () => {
  assert.equal(go(GATED, '/go/other').handled, false);
});

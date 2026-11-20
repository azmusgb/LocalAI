'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFetcher } = require('../app/research/fetcher');

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
function fake(script) { // script: array of { status, headers, chunks, hang } consumed one per request
  const calls = [];
  const transport = (options, onResponse) => {
    calls.push(options);
    const step = script[calls.length - 1];
    const req = new EventEmitter();
    req.setTimeout = () => req; req.destroy = err => { req.destroyed = true; if (err) setImmediate(() => req.emit('error', err)); };
    req.end = () => { if (step.hang) return; setImmediate(() => {
      const res = new EventEmitter(); res.statusCode = step.status; res.headers = step.headers || {}; res.destroy = () => {}; res.resume = () => {};
      onResponse(res); for (const c of step.chunks || []) res.emit('data', Buffer.from(c)); res.emit('end'); }); };
    return req;
  };
  return { transport, calls };
}
const xml = { 'content-type': 'application/atom+xml; charset=utf-8' };
const opts = { allowHosts: ['example.com'] };

test('200 returns the body and validators', async () => {
  const f = fake([{ status: 200, headers: { ...xml, etag: '"a1"', 'last-modified': 'Wed, 18 Nov 2026 10:00:00 GMT' }, chunks: ['<feed/>'] }]);
  const r = await createFetcher({ lookup: PUBLIC, transport: f.transport }).fetchText('https://example.com/feed', opts);
  assert.deepEqual(r, { ok: true, status: 200, body: '<feed/>', etag: '"a1"', lastModified: 'Wed, 18 Nov 2026 10:00:00 GMT', finalUrl: 'https://example.com/feed', bytes: 7 });
  assert.equal(f.calls[0].headers['Accept-Encoding'], 'identity');
  assert.equal(f.calls[0].headers['User-Agent'], 'LocalAI-feed-reader/1');
  assert.equal(f.calls[0].servername, 'example.com');
});
test('the connection is pinned to the vetted address, in both lookup forms', async () => {
  const f = fake([{ status: 200, headers: xml, chunks: ['<feed/>'] }]);
  await createFetcher({ lookup: PUBLIC, transport: f.transport }).fetchText('https://example.com/feed', opts);
  const one = await new Promise(res => f.calls[0].lookup('example.com', {}, (e, address, family) => res([e, address, family])));
  assert.deepEqual(one, [null, '93.184.216.34', 4]);
  const all = await new Promise(res => f.calls[0].lookup('example.com', { all: true }, (e, list) => res([e, list])));
  assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]]);
});
test('validators are sent and 304 is not a failure', async () => {
  const f = fake([{ status: 304, headers: {} }]);
  const r = await createFetcher({ lookup: PUBLIC, transport: f.transport }).fetchText('https://example.com/feed', { ...opts, etag: '"a1"', lastModified: 'x' });
  assert.deepEqual(r, { ok: true, status: 304, notModified: true, finalUrl: 'https://example.com/feed' });
  assert.equal(f.calls[0].headers['If-None-Match'], '"a1"');
  assert.equal(f.calls[0].headers['If-Modified-Since'], 'x');
});
test('a private address is refused before any request', async () => {
  const f = fake([]);
  const r = await createFetcher({ lookup: async () => [{ address: '10.0.0.80', family: 4 }], transport: f.transport }).fetchText('https://example.com/feed', opts);
  assert.equal(r.ok, false); assert.equal(r.code, 'blocked_address'); assert.equal(f.calls.length, 0);
});
test('a redirect off the allow-list is refused; one on it is followed and re-vetted', async () => {
  const off = fake([{ status: 302, headers: { location: 'https://evil.test/x' } }]);
  assert.equal((await createFetcher({ lookup: PUBLIC, transport: off.transport }).fetchText('https://example.com/feed', opts)).code, 'host_not_allowed');
  const http = fake([{ status: 301, headers: { location: 'http://example.com/feed' } }]);
  assert.equal((await createFetcher({ lookup: PUBLIC, transport: http.transport }).fetchText('https://example.com/feed', opts)).code, 'bad_scheme');
  let n = 0; const flip = async () => (++n === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  const rebind = fake([{ status: 302, headers: { location: '/feed2' } }]);
  assert.equal((await createFetcher({ lookup: flip, transport: rebind.transport }).fetchText('https://example.com/feed', opts)).code, 'blocked_address');
  const on = fake([{ status: 302, headers: { location: '/feed2' } }, { status: 200, headers: xml, chunks: ['<feed/>'] }]);
  assert.equal((await createFetcher({ lookup: PUBLIC, transport: on.transport }).fetchText('https://example.com/feed', opts)).finalUrl, 'https://example.com/feed2');
});
test('more than three redirects fails', async () => {
  const f = fake(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })));
  assert.equal((await createFetcher({ lookup: PUBLIC, transport: f.transport }).fetchText('https://example.com/feed', opts)).code, 'too_many_redirects');
});
test('oversize, wrong type, error status and timeout are each their own failure', async () => {
  const mk = step => createFetcher({ lookup: PUBLIC, transport: fake([step]).transport });
  assert.equal((await mk({ status: 200, headers: xml, chunks: ['x'.repeat(60), 'x'.repeat(60)] }).fetchText('https://example.com/feed', { ...opts, maxBytes: 100 })).code, 'too_large');
  assert.equal((await mk({ status: 200, headers: { ...xml, 'content-length': '999' }, chunks: [] }).fetchText('https://example.com/feed', { ...opts, maxBytes: 100 })).code, 'too_large');
  assert.equal((await mk({ status: 200, headers: { 'content-type': 'text/html' }, chunks: ['<html>'] }).fetchText('https://example.com/feed', opts)).code, 'bad_content_type');
  const s = await mk({ status: 503, headers: xml, chunks: [] }).fetchText('https://example.com/feed', opts);
  assert.equal(s.code, 'http_status'); assert.match(s.reason, /503/);
  assert.equal((await mk({ hang: true }).fetchText('https://example.com/feed', { ...opts, timeoutMs: 30 })).code, 'timeout');
});

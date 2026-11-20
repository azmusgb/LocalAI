'use strict';

// One bounded HTTPS GET for research intake. Every hop (the first URL and each redirect) is checked by the guard,
// its host is resolved and vetted, and the connection is pinned to the vetted address so a second DNS answer cannot
// swap it. https only, port 443, at most a few redirects, capped body, one timeout for the whole call, no cookies
// and no credentials. fetchText never rejects: a failure is { ok: false, reason, code }.

const https = require('node:https');
const { GuardError, checkUrl, vetHost } = require('./net-guard');

const USER_AGENT = 'LocalAI-feed-reader/1';
const TYPES = ['application/atom+xml', 'application/rss+xml', 'application/xml', 'text/xml'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class FetchError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'FetchError';
    this.code = code;
  }
}

const fail = (code, reason) => ({ ok: false, reason, code });
const header = (res, name) => {
  const v = res.headers && res.headers[name];
  return Array.isArray(v) ? v[0] : (typeof v === 'string' ? v : '');
};

function createFetcher({ lookup, transport = https.request } = {}) {
  const vetOptions = lookup ? { lookup } : undefined;

  // One request pinned to `pinned`; resolves { redirect } or a final result, rejects with FetchError or a network error.
  function request(url, pinned, headers, maxBytes, track) {
    return new Promise((resolve, reject) => {
      const pin = (_host, options, cb) => {
        if (typeof options === 'function') { cb = options; options = {}; }
        if (options && options.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
        return cb(null, pinned.address, pinned.family);
      };
      const options = { method: 'GET', host: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search,
        lookup: pin, agent: false, headers };
      const req = transport(options, res => {
        const status = res.statusCode;
        res.on('error', reject);
        if (REDIRECTS.has(status) && header(res, 'location')) {
          res.resume();
          return resolve({ redirect: header(res, 'location') });
        }
        if (status === 304) { res.resume(); return resolve({ notModified: true }); }
        if (status !== 200) { req.destroy(); return reject(new FetchError('http_status', `server answered ${status}`)); }
        const type = header(res, 'content-type').trim().toLowerCase();
        if (!TYPES.some(t => type.startsWith(t))) { req.destroy(); return reject(new FetchError('bad_content_type', 'not an Atom or RSS content type')); }
        const declared = Number(header(res, 'content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) { req.destroy(); return reject(new FetchError('too_large', 'response is larger than the limit')); }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(); return reject(new FetchError('too_large', 'response is larger than the limit')); }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({
          body: Buffer.concat(chunks).toString('utf8'), bytes, etag: header(res, 'etag'), lastModified: header(res, 'last-modified'),
        }));
      });
      track(req);
      req.on('error', reject);
      req.end();
    });
  }

  async function run(startUrl, o, state) {
    const { allowHosts, etag, lastModified, maxBytes = 2097152, maxRedirects = 3 } = o;
    let target = startUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = checkUrl(target, { allowHosts });
      const vetted = await vetHost(url.hostname, vetOptions);
      if (state.finished) return null;
      const headers = { 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' };
      if (etag) headers['If-None-Match'] = etag;
      if (lastModified) headers['If-Modified-Since'] = lastModified;
      const r = await request(url, vetted[0], headers, maxBytes, req => { state.req = req; });
      if (r.notModified) return { ok: true, status: 304, notModified: true, finalUrl: url.href };
      if (r.redirect === undefined) {
        return { ok: true, status: 200, body: r.body, etag: r.etag, lastModified: r.lastModified, finalUrl: url.href, bytes: r.bytes };
      }
      try { target = new URL(r.redirect, url.href).href; } catch { throw new GuardError('bad_url', 'redirect to an invalid URL'); }
    }
    throw new FetchError('too_many_redirects', 'too many redirects');
  }

  function fetchText(url, o = {}) {
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 20000;
    return new Promise(resolve => {
      const state = { finished: false, req: null };
      let timer = null;
      const finish = result => {
        if (state.finished) return;
        state.finished = true;
        clearTimeout(timer);
        if (state.req && typeof state.req.destroy === 'function') state.req.destroy();
        resolve(result);
      };
      timer = setTimeout(() => finish(fail('timeout', `no complete answer within ${timeoutMs} ms`)), timeoutMs);
      run(url, o, state).then(result => { if (result) finish(result); }, err => {
        const known = err instanceof GuardError || err instanceof FetchError;
        finish(fail(known ? err.code : 'network', known ? err.message : `request failed: ${err && err.message ? err.message : 'unknown error'}`));
      });
    });
  }

  return { fetchText };
}

module.exports = { createFetcher };

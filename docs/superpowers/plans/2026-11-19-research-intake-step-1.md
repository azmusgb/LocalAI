# Research intake (step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **GATE: do not start.** This plan adds a store and scheduled outbound fetching, which the platform baseline treats as an amendment (pi-hub `AGENTS.md:8-11`). Execute only after the owner has approved the design and amendment A31 (spec §3.12) is merged in pi-hub. Task 0 checks this.

**Goal:** LocalAI can fetch owner-registered Atom/RSS feeds on a schedule through an address guard and store each entry once with provenance, with no model, no page, and nothing running unless switched on.

**Architecture:** Five small CommonJS modules under `app/research/` (address guard, pinned fetcher, feed parser, SQLite store, intake job) and one route module `app/server/research.js`, wired into `app/server.js` beside the journal and driven by its own 30 s interval. Tables are created `IF NOT EXISTS` in the existing database with no `SCHEMA_VERSION` bump, so a rollback still opens it. The whole feature is inert unless `LOCALAI_RESEARCH=on`.

**Tech Stack:** Node ≥ 22.13 built-ins only (`node:sqlite` through `storage.db`, `node:https`, `node:dns`, `node:net` `BlockList`, `node:crypto`), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-11-19-knowledge-loop-design.md` (§3.4–3.7, §3.10, §8.1 phase 1, §10). Executors read both.

## Global Constraints

- No new dependencies, runtime or dev. No build step. `'use strict'` CommonJS, matching `app/journal.js`.
- New tables only via `CREATE TABLE IF NOT EXISTS`; do not change `SCHEMA_VERSION` in `app/storage.js`.
- `LOCALAI_RESEARCH` unset or anything but `on`: the tick makes zero network calls and every route answers `{ enabled: false }` (reads) or 409 `{ error: 'research is off' }` (writes).
- Fetch rules, exact values: `https:` only, port 443 only, host must equal the source's stored host, at most 3 redirects each re-vetted, body cap 2 MiB (2,097,152 bytes) after decoding, total timeout 20,000 ms, request header `Accept-Encoding: identity`, `User-Agent: LocalAI-feed-reader/1`. No cookies, no credentials, no query additions.
- Blocked address ranges, exact: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and any IPv4-mapped IPv6 address whose IPv4 part is blocked. If **any** resolved address is blocked, the host is refused.
- Limits, exact: schedule 60–10,080 minutes per source (default 360); at most 3 sources fetched per tick; at most 200 fetches per local day; at most 200 entries taken per fetch; stored text ≤ 20,000 characters per document, title ≤ 300; newest 2,000 documents kept per source; newest 50 fetch rows kept per source; quarantine after 5 consecutive failures, never resumed automatically; backoff after failure `min(24 h, schedule × 2^failures)`.
- A failed read never alters stored documents or `last_ok_at`, and is never reported as empty: responses carry `{ ok: false, reason }`.
- Stored text passes through `redact` from `app/journal.js` before insert.
- Every `/api/research/*` path is in `GUARDED` in `app/signin.js`. No route accepts an `approved` field.
- Do not touch `app/public/**` (the shell is at its gzip budget; UI is a later plan). Do not edit files in other sessions' worktrees.
- Run `npm test` and `npm run lint` before the PR. Local CI is the gate; merging needs the owner's "merge".

## Review Focus

1. **Host written as a number or with a trailing dot** (`https://2130706433/`, `https://127.1/`, `https://example.com./`, `https://[::ffff:10.0.0.80]/`): refused or normalised before lookup, never connected. Tests in Task 1.
2. **Resolver asked for all addresses** (Node 22 calls `lookup` with `{ all: true }` for happy-eyeballs): the pinned lookup must answer in the array form or the connection silently falls back. Test in Task 2.
3. **Feed that is not a feed** (an HTML error page with status 200, a truncated body, a `<!DOCTYPE` with entity declarations): recorded as a failed fetch with reason `not a feed`, no documents written, no entity expansion. Tests in Task 3 and Task 5.
4. **PC asleep for days**: on wake every source is due at once; the tick still takes 3 per tick, oldest due first, and stops at the daily cap. Test in Task 5.
5. **Source edited to a different host** while documents exist: the allow-list follows the stored URL; old documents keep their original URLs; a redirect from the new host to the old one is refused. Test in Task 5.

---

## File structure

| File | Responsibility |
|---|---|
| `app/research/net-guard.js` | Decide whether a URL and its resolved addresses may be contacted |
| `app/research/fetcher.js` | One bounded HTTPS GET pinned to a vetted address, with redirects |
| `app/research/feed.js` | Turn Atom or RSS text into plain entries; no I/O |
| `app/research/store.js` | Tables and queries for sources, fetches, documents, meta |
| `app/research/intake.js` | Which sources are due, fetch, parse, store, back off, quarantine |
| `app/server/research.js` | HTTP handlers |
| `app/server.js`, `app/signin.js` | Wiring only |
| `tests/research-*.test.cjs` | One file per module |
| `docs/SECURITY.md`, `docs/README.md` | What is fetched, from where, and how to turn it off |

---

### Task 0: Gate and branch

**Files:** none changed.

- [ ] **Step 1: Confirm the amendment is merged**

Run: `cd ~/dev/pi-hub && git fetch -q && git show origin/main:docs/superpowers/specs/2026-11-01-platform-product-architecture-design.md | grep -n "A31"`
Expected: at least one line naming A31 in the Amendments list. If there is none, **stop** and tell the owner; do nothing else in this plan.

- [ ] **Step 2: Create the worktree**

Run: `wt new LocalAI feat/research-intake` and work only in the path it prints.

- [ ] **Step 3: Baseline**

Run: `npm test 2>&1 | tail -5`
Expected: `# fail 0`. If not, stop and report; the failures are not this plan's.

---

### Task 1: Address guard

**Files:**
- Create: `app/research/net-guard.js`
- Test: `tests/research-net-guard.test.cjs`

**Interfaces:**
- Produces:
  - `class GuardError extends Error` with `code` one of `'bad_url' | 'bad_scheme' | 'bad_port' | 'host_not_allowed' | 'ip_literal' | 'blocked_address' | 'dns_failed'`.
  - `isBlockedAddress(ip: string): boolean` — true for any address in the Global Constraints list; true for anything `net.isIP` rejects.
  - `checkUrl(url: string, { allowHosts: string[] }): URL` — throws `GuardError`; returns the parsed URL with hostname lower-cased and one trailing dot removed.
  - `vetHost(hostname: string, { lookup }): Promise<{ address: string, family: 4 | 6 }[]>` — `lookup` has the shape of `dns.promises.lookup(host, { all: true })` and defaults to it; rejects with `GuardError('blocked_address')` if any result is blocked, `'dns_failed'` if lookup throws or returns none.

- [ ] **Step 1: Write the failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuardError, isBlockedAddress, checkUrl, vetHost } = require('../app/research/net-guard');

const code = fn => { try { fn(); } catch (e) { assert.ok(e instanceof GuardError); return e.code; } return 'no error'; };
const allow = { allowHosts: ['example.com'] };

test('blocked ranges', () => {
  for (const ip of ['0.0.0.1', '10.0.0.80', '100.64.0.1', '100.109.178.34', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
    '::ffff:10.0.0.80', '::ffff:127.0.0.1', 'not-an-ip', '']) assert.equal(isBlockedAddress(ip), true, ip);
});
test('public addresses pass', () => {
  for (const ip of ['1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:1.1.1.1']) assert.equal(isBlockedAddress(ip), false, ip);
});
test('checkUrl refuses what it must', () => {
  assert.equal(code(() => checkUrl('not a url', allow)), 'bad_url');
  assert.equal(code(() => checkUrl('http://example.com/feed', allow)), 'bad_scheme');
  assert.equal(code(() => checkUrl('file:///etc/passwd', allow)), 'bad_scheme');
  assert.equal(code(() => checkUrl('https://example.com:8443/feed', allow)), 'bad_port');
  assert.equal(code(() => checkUrl('https://user:pw@example.com/feed', allow)), 'bad_url');
  assert.equal(code(() => checkUrl('https://other.com/feed', allow)), 'host_not_allowed');
  assert.equal(code(() => checkUrl('https://sub.example.com/feed', allow)), 'host_not_allowed');
});
test('checkUrl refuses numeric and literal hosts even when listed', () => {
  for (const u of ['https://2130706433/', 'https://127.1/', 'https://0x7f000001/', 'https://10.0.0.80/', 'https://[::1]/', 'https://[::ffff:10.0.0.80]/'])
    assert.equal(code(() => checkUrl(u, { allowHosts: [new URL(u).hostname] })), 'ip_literal', u);
});
test('checkUrl normalises case and a trailing dot', () => {
  assert.equal(checkUrl('https://EXAMPLE.com./feed', allow).hostname, 'example.com');
  assert.equal(checkUrl('https://example.com:443/feed', allow).port, '');
});
test('vetHost refuses when any address is blocked', async () => {
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.80', family: 4 }];
  await assert.rejects(vetHost('example.com', { lookup: mixed }), e => e.code === 'blocked_address');
  await assert.rejects(vetHost('example.com', { lookup: async () => [] }), e => e.code === 'dns_failed');
  await assert.rejects(vetHost('example.com', { lookup: async () => { throw new Error('ENOTFOUND'); } }), e => e.code === 'dns_failed');
  assert.deepEqual(await vetHost('example.com', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), [{ address: '93.184.216.34', family: 4 }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/research-net-guard.test.cjs`
Expected: FAIL, `Cannot find module '../app/research/net-guard'`.

- [ ] **Step 3: Implement the four exports in `app/research/net-guard.js`**

Use one `net.BlockList` built once from the Global Constraints list (`addSubnet(prefix, bits, 'ipv4' | 'ipv6')`). For a mapped address (`::ffff:a.b.c.d`), test the IPv4 part. `ip_literal` is decided on the WHATWG-parsed hostname: after `new URL`, numeric forms are already canonical dotted quads, so `net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0` catches all of them. Credentials in the URL are `bad_url`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/research-net-guard.test.cjs`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add app/research/net-guard.js tests/research-net-guard.test.cjs
git commit -m "Research intake: address guard for outbound fetches"
```

---

### Task 2: Pinned fetcher

**Files:**
- Create: `app/research/fetcher.js`
- Test: `tests/research-fetcher.test.cjs`

**Interfaces:**
- Consumes: `checkUrl`, `vetHost`, `GuardError` from Task 1.
- Produces: `createFetcher({ lookup?, transport? })` returning `{ fetchText }`.
  - `transport(options, onResponse)` has the shape of `https.request` and defaults to it.
  - `fetchText(url, { allowHosts, etag?, lastModified?, maxBytes = 2097152, timeoutMs = 20000, maxRedirects = 3 }): Promise<Result>`; never rejects.
  - `Result` is one of
    `{ ok: true, status: 200, body: string, etag: string, lastModified: string, finalUrl: string, bytes: number }`,
    `{ ok: true, status: 304, notModified: true, finalUrl: string }`,
    `{ ok: false, reason: string, code: string }` where `code` is a `GuardError` code or one of `'http_status' | 'too_large' | 'timeout' | 'too_many_redirects' | 'bad_content_type' | 'network'`.
  - Accepted content types (prefix match, case-insensitive): `application/atom+xml`, `application/rss+xml`, `application/xml`, `text/xml`. Anything else is `bad_content_type`.

- [ ] **Step 1: Write the failing tests**

A fake transport records the options it was given and replays a scripted response. Put this helper at the top of the test file:

```js
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
```

Tests, each one `test(name, async () => { … })`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/research-fetcher.test.cjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createFetcher` in `app/research/fetcher.js`**

Per hop: `checkUrl` → `vetHost` → one request. The pin is the part the tests do not fully determine, so write it exactly:

```js
const pinned = vetted[0];
const lookup = (_host, options, cb) => {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (options && options.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
  return cb(null, pinned.address, pinned.family);
};
const options = { method: 'GET', host: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search,
  lookup, agent: false, headers };
```

`agent: false` so no pooled socket to an unvetted address is reused. The timeout is one `setTimeout` for the whole call across redirects, not a per-socket idle timer. Count bytes as chunks arrive and destroy the request when the cap is passed. Resolve `Location` against the current URL. Decode the body as UTF-8.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/research-fetcher.test.cjs`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add app/research/fetcher.js tests/research-fetcher.test.cjs
git commit -m "Research intake: bounded HTTPS fetch pinned to a vetted address"
```

---

### Task 3: Feed parser

**Files:**
- Create: `app/research/feed.js`
- Test: `tests/research-feed.test.cjs`

**Interfaces:**
- Produces:
  - `class FeedError extends Error`.
  - `parseFeed(xml: string, { baseUrl: string, maxEntries = 200 }): { kind: 'atom' | 'rss', title: string, entries: Entry[] }`; throws `FeedError('not a feed')` when neither a `<feed` nor an `<rss`/`<rdf:RDF` root is found, or when the text contains `<!DOCTYPE` or `<!ENTITY`.
  - `Entry = { id: string, url: string, title: string, text: string, published: string }` — `published` is an ISO 8601 string or `''`; `text` is plain text (tags stripped, whitespace collapsed); `url` is absolute `https:` or `''`; `id` is the entry's `<id>`/`<guid>`, else its `url`; entries with neither are dropped.

- [ ] **Step 1: Write the failing tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, FeedError } = require('../app/research/feed');
const base = { baseUrl: 'https://example.com/releases.atom' };

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Example &amp; Co releases</title>
 <entry><id>tag:example.com,2026:v2</id><title type="html">v2.0 &lt;b&gt;out&lt;/b&gt;</title>
  <link rel="alternate" href="/releases/v2"/><link rel="self" href="/self"/>
  <updated>2026-11-18T10:00:00Z</updated><published>2026-11-17T09:30:00Z</published>
  <content type="html"><![CDATA[<p>Adds <code>fts5</code> option.</p><script>alert(1)</script>]]></content></entry>
 <entry><id>tag:example.com,2026:v1</id><title>v1.9</title><link href="https://example.com/releases/v1.9"/>
  <updated>2026-10-01T00:00:00Z</updated><summary>Fixes.</summary></entry>
</feed>`;
const RSS = `<rss version="2.0"><channel><title>News</title>
 <item><title>Advisory 12</title><link>https://example.com/a/12</link><guid isPermaLink="false">adv-12</guid>
  <pubDate>Wed, 18 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Patch &amp;amp; restart.&lt;/p&gt;</description></item>
 <item><title>No id</title><link>https://example.com/a/13</link></item>
 <item><title>Nothing to key on</title></item>
</channel></rss>`;

test('atom', () => {
  const f = parseFeed(ATOM, base);
  assert.equal(f.kind, 'atom'); assert.equal(f.title, 'Example & Co releases'); assert.equal(f.entries.length, 2);
  assert.deepEqual(f.entries[0], { id: 'tag:example.com,2026:v2', url: 'https://example.com/releases/v2', title: 'v2.0 out',
    text: 'Adds fts5 option.', published: '2026-11-17T09:30:00.000Z' });
  assert.equal(f.entries[1].published, '2026-10-01T00:00:00.000Z'); // falls back to updated
  assert.equal(f.entries[1].text, 'Fixes.');
});
test('rss', () => {
  const f = parseFeed(RSS, base);
  assert.equal(f.kind, 'rss'); assert.equal(f.entries.length, 2);
  assert.deepEqual(f.entries[0], { id: 'adv-12', url: 'https://example.com/a/12', title: 'Advisory 12', text: 'Patch & restart.', published: '2026-11-18T10:00:00.000Z' });
  assert.equal(f.entries[1].id, 'https://example.com/a/13'); assert.equal(f.entries[1].published, '');
});
test('script and style content never reaches text', () => {
  assert.doesNotMatch(parseFeed(ATOM, base).entries[0].text, /alert/);
});
test('non-https and javascript links become empty', () => {
  const x = ATOM.replace('href="/releases/v2"', 'href="javascript:alert(1)"').replace('https://example.com/releases/v1.9', 'http://example.com/x');
  const f = parseFeed(x, base);
  assert.equal(f.entries[0].url, ''); assert.equal(f.entries[1].url, '');
});
test('not a feed', () => {
  for (const bad of ['', '<html><body>502 Bad Gateway</body></html>', '{"error":true}', ATOM.slice(0, 60),
    '<!DOCTYPE feed [<!ENTITY a "aaaa">]><feed xmlns="http://www.w3.org/2005/Atom"><title>&a;</title></feed>'])
    assert.throws(() => parseFeed(bad, base), FeedError, bad.slice(0, 20));
});
test('unknown entities are left as text, numeric ones decoded', () => {
  const f = parseFeed(ATOM.replace('v1.9</title>', 'v1.9 &#8212; &unknown; &#x41;</title>'), base);
  assert.equal(f.entries[1].title, 'v1.9 — &unknown; A');
});
test('entry cap', () => {
  const many = '<rss><channel><title>t</title>' + Array.from({ length: 300 }, (_, i) => `<item><guid>g${i}</guid><title>t${i}</title></item>`).join('') + '</channel></rss>';
  assert.equal(parseFeed(many, base).entries.length, 200);
  assert.equal(parseFeed(many, { ...base, maxEntries: 5 }).entries.length, 5);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/research-feed.test.cjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `parseFeed` in `app/research/feed.js`**

A tolerant scanner, not a general XML parser: find `<entry>`/`<item>` blocks with a non-greedy regex, read child elements by name ignoring any namespace prefix, unwrap CDATA, decode the five named entities and numeric references once, then for HTML-typed fields decode again and strip tags (dropping `<script>` and `<style>` with their content first). A truncated document whose root never closes is `not a feed` only if it yields no complete entry **and** no closing root tag; the 60-character slice in the test has neither. Dates go through `new Date(…)`; an invalid date is `''`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/research-feed.test.cjs`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add app/research/feed.js tests/research-feed.test.cjs
git commit -m "Research intake: Atom and RSS reader"
```

---

### Task 4: Store

**Files:**
- Create: `app/research/store.js`
- Test: `tests/research-store.test.cjs`

**Interfaces:**
- Consumes: `redact` from `app/journal.js`.
- Produces: `createResearchStore({ db, now })` (`now(): number`, ms) returning:
  - `addSource({ name, url, kind = 'feed', trust = 'unrated', topics = [], scheduleMinutes = 360 }): Source` — throws `Error` with `.status = 400` for: name empty or > 120 chars; url failing `checkUrl(url, { allowHosts: [new URL(url).hostname] })`; kind not `'feed'`; trust not in `['official','primary','secondary','unrated']`; schedule outside 60–10,080; and `.status = 409` when the URL already exists.
  - `updateSource(id, patch): Source | null` — patch keys `name`, `url`, `trust`, `topics`, `scheduleMinutes`, `status` (`'active' | 'paused' | 'retired'`; `'quarantined'` is set only by `recordFetch`; setting `'active'` on a quarantined source clears `failures` and `next_due_at`). Same validation.
  - `listSources(): Source[]`, `getSource(id): Source | null`.
  - `Source = { id, name, url, host, kind, trust, topics: string[], scheduleMinutes, status, failures, lastOkAt, lastFetchAt, lastError, nextDueAt, etag, lastModified, documents: number, createdAt }` (times ISO strings or `''`; `documents` counted on read).
  - `dueSources(limit: number): Source[]` — `status = 'active'` and `nextDueAt` empty or ≤ now, oldest `nextDueAt` first, never-fetched first.
  - `recordFetch(sourceId, { ok, status = 0, reason = '', code = '', bytes = 0, added = 0, revised = 0, etag, lastModified, ms = 0 }): Source` — writes a `research_fetches` row and updates the source by the rules in Global Constraints (success: failures 0, `lastOkAt` now, `nextDueAt` now + schedule; failure: failures + 1, `lastError` reason, backoff, quarantine at 5; a 304 counts as success with `added = 0`). Keeps the newest 50 fetch rows for the source.
  - `saveEntries(sourceId, entries: Entry[]): { added: number, revised: number }` — in one transaction; for each entry, `ref = sourceId + ':' + entry.id`, `hash = sha256(title + '\n' + text)`; no row for `ref` → insert revision 1; newest row has the same hash → nothing; otherwise insert revision n+1. Title clamped to 300, text to 20,000, both through `redact`. Then keeps the newest 2,000 documents for the source.
  - `listDocuments({ sourceId?, q?, limit = 50, before? }): Document[]` — newest first, latest revision of each `ref` only; `q` is an FTS5 match built with `ftsQuery` from `app/journal.js`; limit clamped 1–200.
  - `Document = { id, sourceId, ref, url, title, text, published, fetchedAt, revision, hash }`.
  - `fetchesToday(): number` (rows whose local day equals today's), `listFetches(sourceId, limit = 20)`.
  - `getMeta(key): string | null`, `setMeta(key, value: string): void`.

Tables, exactly:

```sql
CREATE TABLE IF NOT EXISTS research_sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
  kind TEXT NOT NULL, trust TEXT NOT NULL, topics TEXT NOT NULL DEFAULT '[]', schedule_minutes INTEGER NOT NULL, status TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, last_ok_at TEXT NOT NULL DEFAULT '', last_fetch_at TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
  next_due_at TEXT NOT NULL DEFAULT '', etag TEXT NOT NULL DEFAULT '', last_modified TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS research_fetches (seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, at TEXT NOT NULL, day TEXT NOT NULL,
  ok INTEGER NOT NULL, status INTEGER NOT NULL, code TEXT NOT NULL, reason TEXT NOT NULL, bytes INTEGER NOT NULL, added INTEGER NOT NULL,
  revised INTEGER NOT NULL, ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS research_fetches_source ON research_fetches (source_id, seq);
CREATE INDEX IF NOT EXISTS research_fetches_day ON research_fetches (day);
CREATE TABLE IF NOT EXISTS research_documents (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL, ref TEXT NOT NULL,
  revision INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, published TEXT NOT NULL, fetched_at TEXT NOT NULL,
  hash TEXT NOT NULL, UNIQUE (ref, revision));
CREATE INDEX IF NOT EXISTS research_documents_source ON research_documents (source_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS research_documents_fts USING fts5(title, text, content='research_documents', content_rowid='seq', tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS research_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Ids: `src-` and `doc-` plus 12 hex characters from `crypto.randomBytes`. `day` is the local date `YYYY-MM-DD` computed the way `app/journal.js` computes its `day`; accept a `timeZone` option with the same default if that is what it needs.

- [ ] **Step 1: Write the failing tests**

Open a store the way `tests/journal.test.cjs` does:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');

let T = Date.parse('2026-11-19T15:00:00Z');
function open() {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'research-')) });
  return { storage, store: createResearchStore({ db: storage.db, now: () => T, timeZone: 'America/New_York' }) };
}
const src = (store, over = {}) => store.addSource({ name: 'SQLite', url: 'https://example.com/feed.atom', ...over });
const e = (id, title = 'T', text = 'body') => ({ id, url: 'https://example.com/' + id, title, text, published: '2026-11-18T10:00:00.000Z' });
```

Tests (one `test()` each, asserting exactly this):

1. `addSource` returns `status 'active'`, `host 'example.com'`, `scheduleMinutes 360`, `failures 0`, `documents 0`, `nextDueAt ''`, id matching `/^src-[0-9a-f]{12}$/`.
2. `addSource` throws with `status 400` for each of: `name: ''`; `url: 'http://example.com/f'`; `url: 'https://10.0.0.80/f'`; `kind: 'page'`; `trust: 'gospel'`; `scheduleMinutes: 59`; `scheduleMinutes: 10081`. A second add of the same URL throws `status 409`.
3. `saveEntries(id, [e('a'), e('b')])` → `{ added: 2, revised: 0 }`; the same call again → `{ added: 0, revised: 0 }` and `SELECT count(*) FROM research_documents` is 2.
4. `saveEntries(id, [e('a', 'T', 'changed')])` → `{ added: 0, revised: 1 }`; `listDocuments({ sourceId })` has 2 rows, the one for `a` with `revision 2` and `text 'changed'`.
5. Text containing `sk-ant-abcdefghijklmnopqrstuvwxyz0123456789` is stored without that string (the journal's `redact` contract); title of 400 characters is stored as 300; text of 30,000 as 20,000.
6. `listDocuments({ q: 'changed' })` finds the revised document and `listDocuments({ q: 'nomatch' })` returns `[]`; `listDocuments({ q: '"' })` returns `[]` and does not throw.
7. `recordFetch(id, { ok: true, status: 200, added: 2 })`: `failures 0`, `lastOkAt` = now, `nextDueAt` = now + 360 min; `dueSources(10)` is then empty; advance `T` by 361 min and it has 1.
8. Failure path: five `recordFetch(id, { ok: false, reason: 'HTTP 503', code: 'http_status' })` calls. After the first: `failures 1`, `lastError 'HTTP 503'`, `nextDueAt` = now + 720 min, `lastOkAt` unchanged from test 7's pattern (set it with one success first and assert it does not move). After the fourth: `nextDueAt` = now + 1,440 min (the 24 h cap). After the fifth: `status 'quarantined'`, and `dueSources(10)` stays empty however far `T` advances.
9. `updateSource(id, { status: 'active' })` on that quarantined source: `status 'active'`, `failures 0`, `nextDueAt ''`.
10. `updateSource(id, { url: 'https://other.example.org/feed' })`: `host 'other.example.org'`; documents saved earlier keep their `url`.
11. Retention: `saveEntries` with 2,005 distinct entries (two calls) leaves 2,000 documents and FTS finds none of the 5 oldest titles. 60 `recordFetch` calls leave 50 fetch rows.
12. `fetchesToday()` counts only rows of the current local day: record 2, advance `T` by 24 h, record 1 → 1.
13. `setMeta('paused', '1')` then `getMeta('paused') === '1'`; `getMeta('missing') === null`.
14. Reopening: a second `createResearchStore` on the same `storage.db` does not throw and sees the same sources.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/research-store.test.cjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createResearchStore` in `app/research/store.js`**

Follow `app/journal.js` for statement preparation, FTS sync by `AFTER INSERT` / `AFTER DELETE` triggers (add the two triggers for `research_documents`, named `research_documents_ai` and `research_documents_ad`), and transactions (`BEGIN`/`COMMIT` on `db`, synchronous, no awaits inside). Deleting a document for retention must delete its FTS row in the same transaction.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/research-store.test.cjs`
Expected: `# pass 14`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add app/research/store.js tests/research-store.test.cjs
git commit -m "Research intake: sources, fetches and documents store"
```

---

### Task 5: Intake job

**Files:**
- Create: `app/research/intake.js`
- Test: `tests/research-intake.test.cjs`

**Interfaces:**
- Consumes: store (Task 4), `fetchText` (Task 2), `parseFeed`, `FeedError` (Task 3).
- Produces: `createIntake({ store, fetcher, enabled, log = () => {}, perTick = 3, dailyFetches = 200 })` returning:
  - `state(): { enabled: boolean, paused: boolean, running: boolean, fetchesToday: number, dailyFetches: number, lastTickAt: string, sources: { active, paused, quarantined, retired } }`
  - `setPaused(paused: boolean): void` (stored as meta key `paused`, `'1'` or `'0'`; survives restart).
  - `fetchSource(id): Promise<{ ok: true, added, revised, notModified } | { ok: false, reason, code }>` — refuses with `code: 'off' | 'paused' | 'busy' | 'not_found' | 'not_active' | 'daily_cap'` before any network call.
  - `tick(): Promise<{ ran: number, skipped: '' | 'off' | 'paused' | 'busy' | 'daily_cap' }>` — never rejects.

- [ ] **Step 1: Write the failing tests**

Use a real store on a temp directory (helper from Task 4) and a fake fetcher `{ fetchText: async (url, o) => { calls.push({ url, o }); return script(url); } }`.

1. **Off:** `enabled: false` → `tick()` resolves `{ ran: 0, skipped: 'off' }`, `fetchSource` resolves `{ ok: false, code: 'off' }`, fake fetcher call count 0.
2. **Paused:** `setPaused(true)` → `tick()` `{ ran: 0, skipped: 'paused' }`, call count 0; a new `createIntake` on the same store still reports `paused: true`.
3. **Happy path:** one source, fetcher returns the Task 3 Atom fixture → `{ ran: 1, skipped: '' }`; 2 documents; the source has `lastOkAt` set; the fetcher was called with `allowHosts: ['example.com']`, and with the stored `etag`/`lastModified` on the second run after a first response that carried them.
4. **304:** fetcher returns `{ ok: true, status: 304, notModified: true, finalUrl }` → source `failures 0`, document count unchanged, fetch row `ok 1`, `added 0`.
5. **Failed fetch keeps what was there:** after a good run, fetcher returns `{ ok: false, reason: 'HTTP 503', code: 'http_status' }` → documents still 2, `lastOkAt` unchanged, `lastError 'HTTP 503'`, `failures 1`.
6. **Not a feed:** fetcher returns `ok: true, status: 200, body: '<html>502</html>'` → fetch row `ok 0`, `code 'not_a_feed'`, `reason 'not a feed'`, no documents, `failures 1`.
7. **Fetcher throws** (a bug, not a result): `tick()` still resolves; the source records a failure with `code 'internal'`; the next source in the same tick still runs.
8. **Per-tick cap and order after sleep:** 7 active sources all due, `nextDueAt` staggered → first tick runs exactly the 3 oldest-due, second the next 3, third 1.
9. **Daily cap:** `dailyFetches: 4`, 7 sources → first tick 3, second tick 1, third `{ ran: 0, skipped: 'daily_cap' }`; advance the clock one local day → runs again.
10. **No overlap:** a fetcher that awaits a manual promise; call `tick()` twice without awaiting → the second resolves `{ ran: 0, skipped: 'busy' }`; `fetchSource` during it resolves `{ ok: false, code: 'busy' }`.
11. **Quarantine:** five failing ticks (advancing the clock past each backoff) → `status 'quarantined'`; a sixth tick makes no call for it; `fetchSource(id)` → `{ ok: false, code: 'not_active' }`.
12. **Host change:** `updateSource(id, { url: 'https://new.example.org/feed' })` → the next call passes `allowHosts: ['new.example.org']` only.
13. **Pause between sources:** a fetcher whose first call invokes `setPaused(true)` → `tick()` with 3 due sources resolves `{ ran: 1, … }`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/research-intake.test.cjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createIntake` in `app/research/intake.js`**

Sources are fetched one at a time, in order; `enabled`, `paused` and the daily count are re-read before each one. `parseFeed` is called with `baseUrl: result.finalUrl`. Each source's work is wrapped so one failure cannot stop the tick. `saveEntries` and `recordFetch` are called after the network call returns, never inside an awaited transaction.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/research-intake.test.cjs`
Expected: `# pass 13`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add app/research/intake.js tests/research-intake.test.cjs
git commit -m "Research intake: scheduled feed intake with caps, backoff and pause"
```

---

### Task 6: Routes, wiring, sign-in, docs

**Files:**
- Create: `app/server/research.js`
- Modify: `app/server.js` (three places: construct beside line 142; route dispatch beside the `/api/journal` lines near 459; one interval beside line 322)
- Modify: `app/signin.js` (`GUARDED`, lines 15–33)
- Modify: `docs/SECURITY.md`, `docs/README.md`
- Test: `tests/research-routes.test.cjs` (handlers, in process), `tests/research-api.test.cjs` (a spawned server, like `tests/journal-api.test.cjs`), and `tests/signin-report.test.cjs` (extend)

**Interfaces:**
- Consumes: store, intake.
- Produces: `createResearchRoutes({ intake, json, readBody, store, storageError })` returning handlers, each `(req, res, urlObj?)`:

| Handler | Route | Reply |
|---|---|---|
| `apiResearchState` | `GET /api/research/state` | `intake.state()` |
| `apiResearchPause` | `POST /api/research/pause` body `{ paused: boolean }` | 200 `intake.state()`; 400 if `paused` is not a boolean |
| `apiResearchSources` | `GET /api/research/sources` | `{ enabled, sources: Source[] }` |
| `apiResearchSourceAdd` | `POST /api/research/sources` | 200 `{ source }`; 400/409 `{ error }` from the store |
| `apiResearchSourceUpdate` | `POST /api/research/sources/update` body `{ id, …patch }` | 200 `{ source }`; 404 `{ error: 'No such source' }`; 400 |
| `apiResearchSourceFetch` | `POST /api/research/sources/fetch` body `{ id }` | 200 with the `fetchSource` result when `ok`; 409 with it when `code` is `off`, `paused`, `busy`, `not_active` or `daily_cap`; 404 for `not_found`; 502 otherwise |
| `apiResearchDocuments` | `GET /api/research/documents?source=&q=&limit=&before=` | `{ enabled, documents: Document[] }` |

With the feature off: the three GETs answer 200 with `enabled: false` and empty lists (off is a known state, not a failed read); the four POSTs answer 409 `{ error: 'research is off' }`. A store exception goes through `storageError` like the journal routes, never an empty list.

- [ ] **Step 1: Write the failing route tests**

`tests/research-routes.test.cjs` calls the handlers directly with a real store on a temp directory, a fake fetcher, the real `json`, `readBody` and `storageError` from `app/server/http.js`, and minimal fake `req`/`res` objects. Name every route path as a string in the file: `tests/route-coverage.test.cjs` fails for a route in `app/server.js` that no test names. One test per row of the table above for the success reply, plus:

- `pause` with `{ paused: 'yes' }` → 400.
- `sources` add with `{ name: 'x', url: 'https://10.0.0.80/f' }` → 400 and nothing stored.
- `sources/update` with an unknown id → 404.
- `sources/fetch` while paused → 409 with `code: 'paused'`.
- Feature off: each GET → 200 `enabled: false`; each POST → 409.
- A request body with `approved: true` changes nothing about any reply.
- `store.listSources` throwing → the reply is an error status, not `{ sources: [] }`.

- [ ] **Step 2: Write the failing sign-in and end-to-end tests**

In `tests/signin-report.test.cjs`, assert that a request without a device to each of the seven paths is refused in report mode, using that file's existing way of testing a GUARDED route.

`tests/research-api.test.cjs` starts the app with `spawnAppServer` from `tests/spawn-server.cjs` twice (the env block from `tests/journal-api.test.cjs`): without `LOCALAI_RESEARCH`, `GET /api/research/state` answers `enabled: false` and `POST /api/research/sources` answers 409; with `LOCALAI_RESEARCH=on`, adding `https://example.com/feed.atom` answers 200, adding `https://10.0.0.80/feed` answers 400, and `POST /api/research/pause {paused:true}` then `GET /api/research/state` shows `paused: true`. No test fetches from the network.

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/research-routes.test.cjs tests/research-api.test.cjs tests/signin-report.test.cjs`
Expected: FAIL (module not found; 404s from the spawned server; seven sign-in assertions fail).

- [ ] **Step 4: Implement `app/server/research.js`**

- [ ] **Step 5: Wire it in `app/server.js`**

```js
// Research intake (docs/superpowers/specs/2026-11-19-knowledge-loop-design.md): owner-registered feeds, off unless LOCALAI_RESEARCH=on.
const researchStore = require('./research/store').createResearchStore({ db: storage.db, now: clockNow, timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
const researchIntake = require('./research/intake').createIntake({ store: researchStore, fetcher: require('./research/fetcher').createFetcher({}), enabled: process.env.LOCALAI_RESEARCH === 'on', log: m => console.log(`${nowIso()} ${m}`) });
```

The routes line goes with the other `create…Routes` calls (after `json`, `readBody`, `storageError` exist); the seven dispatch lines go beside `/api/journal`; the interval:

```js
setInterval(() => researchIntake.tick().catch(e => console.error(`${nowIso()} Research intake failed:`, e)), 30000).unref?.();
```

If `clockNow` returns something other than epoch milliseconds, adapt at the call site, not in the store.

- [ ] **Step 6: Guard the routes in `app/signin.js`**

Add to `GUARDED`, with the comment:

```js
  // Research intake: the source list and what was read show what the owner follows; the writes start outbound fetches.
  /^\/api\/research\//,
```

- [ ] **Step 7: Document it**

`docs/SECURITY.md`: a section "Research intake" stating the switch, the fetch rules and blocked ranges from Global Constraints, that fetched text is stored as data and reaches no model in this release, and how to stop it (pause route; unset `LOCALAI_RESEARCH`). `docs/README.md`: one index line to the spec.

- [ ] **Step 8: Run everything**

Run: `npm test 2>&1 | tail -6 && npm run lint`
Expected: `# fail 0`; eslint prints nothing.

Run the throwaway-server smoke from `CLAUDE.md` (Test section) on port 3180, once with `LOCALAI_RESEARCH` unset and once `=on`:

```bash
curl -s http://127.0.0.1:3180/api/research/state
```

Expected: `{"enabled":false,…}` then `{"enabled":true,"paused":false,…}` (the host's own loopback request passes sign-in).

- [ ] **Step 9: Commit**

```bash
git add app/server/research.js app/server.js app/signin.js docs/SECURITY.md docs/README.md tests/research-routes.test.cjs tests/research-api.test.cjs tests/signin-report.test.cjs
git commit -m "Research intake: guarded API, wiring behind LOCALAI_RESEARCH"
```

---

### Task 7: Pull request and gate

- [ ] **Step 1: Push the branch and open the PR**

Title (it becomes the release note): `Research intake: Local AI can follow feeds you register (off by default)`.
Body: what it adds; that it ships dark; the spec and amendment links; the test counts from Step 8; and under "Not verified": a fetch of a real feed from the appliance's container (egress from the container is unverified, spec §9.6 Q1).

- [ ] **Step 2: Run local CI**

Run: `npm run ci -- <PR number>` in the background.
Expected: a green `local-ci` check on the PR. Do not ship; merging waits for the owner's "merge".

- [ ] **Step 3: After the owner ships it and sets `LOCALAI_RESEARCH=on`**

Live check, to record on the PR: add one source through the API (the SQLite or Node release feed), `POST /api/research/sources/fetch`, and confirm `GET /api/research/documents` lists entries with `revision 1`. Then confirm a refused address end to end: adding `https://10.0.0.80/feed` answers 400.

---

## What this plan deliberately leaves out

- Any page or shell change (next plan: the Research page as an on-demand module).
- Any model call, findings, promotion to Improve (phase 2).
- A general `jobs` table (spec §3.7): one job kind does not need it; it arrives with the second.
- Replacing `validateExternalUrl` with the guard (follow-up F1): a separate small PR so its risk is reviewed alone.
- robots.txt handling: feeds are published to be polled; it becomes necessary when page fetching is added.

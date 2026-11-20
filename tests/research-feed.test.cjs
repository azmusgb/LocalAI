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
test('a truncated feed that still holds a complete entry is read', () => {
  const f = parseFeed(ATOM.slice(0, ATOM.indexOf('</feed>')), base);
  assert.equal(f.entries.length, 2);
});
test('2 MiB of hostile text parses quickly', () => {
  const MiB2 = 2 * 1024 * 1024;
  const wrap = body => '<rss><channel><title>t</title>' + body + '</channel></rss>';
  const cases = [
    wrap('<item'.repeat(MiB2 / 5)),
    wrap('<item><title>x</title>'.repeat(MiB2 / 22)),
    wrap('<item></item>'.repeat(MiB2 / 13)),
    wrap('<a '.repeat(MiB2 / 3)),
    wrap('<!--'.repeat(MiB2 / 4)),
    wrap('<item><guid>g</guid><description>' + '<a href="'.repeat(MiB2 / 9) + '</description></item>'),
    wrap('<item><guid>g</guid><description>' + '&amp;'.repeat(MiB2 / 5) + '</description></item>'),
    wrap('<item><guid>g</guid><description>' + '<script>'.repeat(MiB2 / 8) + '</description></item>'),
    wrap('<item><guid>g</guid><title>' + ' '.repeat(MiB2) + 'x</title></item>')
  ];
  for (const x of cases) {
    const t0 = Date.now();
    try { parseFeed(x, base); } catch (e) { assert.ok(e instanceof FeedError); }
    assert.ok(Date.now() - t0 < 3000, `slow: ${x.slice(0, 40)}`);
  }
});
test('no tag survives repeated escaping', () => {
  const payloads = [
    ['&amp;amp;lt;script&amp;amp;gt;alert(1)&amp;amp;lt;/script&amp;amp;gt;hi', s => s.endsWith('hi')],
    ['<![CDATA[&amp;lt;img src=x onerror=1&amp;gt;]]>ok', s => s.includes('ok')],
    ['&amp;amp;#60;b&amp;amp;#62;x', s => s === 'x'],
    ['&amp;amp;amp;lt;script&amp;amp;amp;gt;alert(1)&amp;amp;amp;lt;/script&amp;amp;amp;gt;', () => true],
    ['5 &lt; 6 and 7 &gt; 2', s => s === '5 < 6 and 7 > 2']
  ];
  for (const [payload, ok] of payloads) {
    const atom = `<feed><entry><id>a</id><title>${payload}</title><summary>${payload}</summary></entry></feed>`;
    const rss = `<rss><channel><item><guid>a</guid><title>${payload}</title><description>${payload}</description></item></channel></rss>`;
    for (const xml of [atom, rss]) {
      const [e] = parseFeed(xml, base).entries;
      for (const s of [e.title, e.text]) {
        assert.doesNotMatch(s, /<\s*[a-zA-Z/!]/, payload);
        assert.ok(!s.includes('alert(1)'), payload);
        assert.ok(ok(s), `${payload} -> ${s}`);
      }
    }
  }
});
test('repeated escaping is bounded in time', () => {
  const xml = `<rss><channel><item><guid>g</guid><title>${'&amp;lt;'.repeat(100000)}</title></item></channel></rss>`;
  const t0 = Date.now();
  parseFeed(xml, base);
  assert.ok(Date.now() - t0 < 3000);
});
test('published needs a four-digit year', () => {
  const f = parseFeed('<feed><entry><id>a</id><updated>1</updated></entry></feed>', base);
  assert.equal(f.entries[0].published, '');
});

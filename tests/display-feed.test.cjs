'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { buildFeed, jpegUrl, todaySentence, nextSentence } = require('../app/display-feed');
const { spawnAppServer } = require('./spawn-server.cjs');

test('nothing to report is one All clear card', () => {
  const f = buildFeed({ needs: { count: 0, speech: 'Nothing needs you right now.' } });
  assert.deepEqual(f.cards.map((c) => [c.kind, c.title, c.tone]), [['needs', 'All clear', 'ok']]);
});

test('needs, watchdog findings, running work, weather and the latest image become cards in that order', () => {
  const f = buildFeed({
    needs: { count: 2, speech: 'Needs you: 1 approval and 1 failed run. One run is in progress.' },
    watch: [{ severity: 'high', title: 'Mac disk is 97% full' }, { severity: 'medium', title: 'b' }, { severity: 'medium', title: 'c' }],
    running: [{ title: 'Research NAS drives' }, { title: 'x' }],
    weather: '72° and sunny.',
    image: { title: 'A red fox', imageUrl: '/api/images/view?filename=a.png&preview=jpeg%3B80' }
  });
  assert.deepEqual(f.cards.map((c) => c.kind), ['needs', 'watch', 'watch', 'running', 'weather', 'image']);
  assert.equal(f.cards[0].text, '1 approval and 1 failed run.');
  assert.equal(f.cards[1].tone, 'attention');
  assert.equal(f.cards[3].text, 'Research NAS drives · 1 more');
});

test('text is cut to what fits a 480x320 card', () => {
  const f = buildFeed({ needs: { count: 0 }, running: [{ title: 'x'.repeat(300) }] });
  const c = f.cards.find((k) => k.kind === 'running');
  assert.equal([...c.text].length, 90);
  assert.ok(c.text.endsWith('…'));
});

test('the image card says when it was made, when known', () => {
  const at = 1792500000;
  const withAt = buildFeed({ needs: { count: 0 }, image: { title: 'A fox', imageUrl: '/api/images/view?filename=a.png', at } });
  assert.equal(withAt.cards.find((c) => c.kind === 'image').at, at);
  const without = buildFeed({ needs: { count: 0 }, image: { title: 'A fox', imageUrl: '/api/images/view?filename=a.png' } });
  assert.equal('at' in without.cards.find((c) => c.kind === 'image'), false);
});

test('feed v2: every card has an id and the question a tap asks; finished work, the gallery and the fullest disk', () => {
  const now = Date.parse('2026-10-20T14:00:00Z');
  const f = buildFeed({
    now,
    needs: { count: 0 },
    done: [{ id: 'r1', title: 'Research NAS drives\nmore', status: 'completed', finishedAt: '2026-10-20T13:48:00Z' }],
    images: [{ title: 'A fox', imageUrl: '/api/images/view?filename=fox.png', at: 1792500000 }, { title: 'A cat', imageUrl: '/api/images/view?filename=cat.png' }],
    disk: { label: 'C:', freeBytes: 80e9, totalBytes: 1000e9 }
  });
  assert.equal(f.v, 2);
  assert.deepEqual(f.cards.map((c) => [c.kind, c.ask ?? null]), [['needs', 'needs'], ['done', 'today'], ['image', null], ['disk', 'health']]);
  assert.ok(f.cards.every((c) => c.id && c.id.length <= 48));
  assert.equal(f.cards[1].text, 'Research NAS drives · 12 min ago');
  assert.equal(f.cards[2].id, 'image-1792500000');
  assert.equal(f.cards[3].tone, 'attention');
  assert.equal(f.cards[3].percent, 92);
  assert.deepEqual(f.images.map((i) => i.title), ['A fox', 'A cat']);
  assert.equal('at' in f.images[1], false);
  const failed = buildFeed({ now, needs: { count: 0 }, done: [{ id: 'r2', title: 'Build', status: 'failed', finishedAt: '2026-10-20T13:00:00Z' }] });
  assert.deepEqual([failed.cards[1].title, failed.cards[1].tone], ["Didn't finish", 'warning']);
});

test('the signature ignores times and "ago" words, and changes with the cards', () => {
  const { signature } = require('../app/display-feed');
  const base = { needs: { count: 0 }, done: [{ id: 'r', title: 'T', status: 'completed', finishedAt: '2026-10-20T13:48:00Z' }] };
  assert.equal(signature(buildFeed({ ...base, now: Date.parse('2026-10-20T14:00:00Z') })), signature(buildFeed({ ...base, now: Date.parse('2026-10-20T14:30:00Z') })));
  assert.notEqual(signature(buildFeed(base)), signature(buildFeed({ ...base, needs: { count: 1, speech: 'Needs you: 1 approval.' } })));
});

test('ask answers for today and next, with no model', () => {
  assert.equal(todaySentence([]), 'Nothing has finished yet today.');
  assert.equal(todaySentence([{ title: 'A' }, { title: 'B' }]), '2 things finished today: A; B.');
  assert.equal(nextSentence({}), 'Nothing is waiting on you or queued.');
  assert.equal(nextSentence({ approvals: [{ title: 'Deploy' }], queued: [{ title: 'Render' }, { title: 'X' }] }), 'An approval waits: Deploy. 2 queued: Render; X.');
});

test('image links ask ComfyUI for a JPEG; anything else is refused', () => {
  assert.equal(jpegUrl('/api/images/view?filename=a.png&subfolder=&type=output'), '/api/images/view?filename=a.png&subfolder=&type=output&preview=jpeg%3B80');
  assert.equal(jpegUrl('https://evil.example/x.png'), null);
  assert.equal(jpegUrl(null), null);
});

test('materials inventory facts become a materials card with tone and ask', () => {
  const lowFeed = buildFeed({
    needs: { count: 0 },
    materials: {
      summary: { spools: 12, loaded: 4, low: 1, unknown: 0, queue: 1 },
      status: '1 spool low: Bambu PLA Basic'
    }
  });
  const lowCard = lowFeed.cards.find(c => c.kind === 'materials');
  assert.ok(lowCard);
  assert.equal(lowCard.tone, 'warning');
  assert.equal(lowCard.title, 'Materials');
  assert.equal(lowCard.text, '1 spool low: Bambu PLA Basic');
  assert.equal(lowCard.ask, 'health');

  const healthyFeed = buildFeed({
    needs: { count: 0 },
    materials: {
      summary: { spools: 12, loaded: 4, low: 0, unknown: 0, queue: 0 }
    }
  });
  const healthyCard = healthyFeed.cards.find(c => c.kind === 'materials');
  assert.ok(healthyCard);
  assert.equal(healthyCard.tone, 'ok');
  assert.equal(healthyCard.text, '4 spools loaded · 12 in inventory');
});

test('GET /api/display/feed answers cards with no model and no setup', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-feed-'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const r = await fetch(`${base}/api/display/feed`);
  assert.equal(r.status, 200);
  const feed = await r.json();
  assert.ok(Date.parse(feed.at));
  assert.equal(feed.cards[0].kind, 'needs');
  for (const c of feed.cards) { assert.ok([...c.title].length <= 24); assert.ok([...c.text].length <= 90); }
});

test('GET /api/display/ask answers the six fixed questions, and refuses others', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ask-'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  for (const q of ['needs', 'running', 'health', 'today', 'next', 'weather']) {
    const r = await fetch(`${base}/api/display/ask?q=${q}`);
    assert.equal(r.status, 200, q);
    const j = await r.json();
    assert.equal(j.question, q);
    assert.ok(j.answer.length > 5 && [...j.answer].length <= 200, q);
  }
  assert.equal((await (await fetch(`${base}/api/display/ask?q=running`)).json()).answer, 'Nothing is running right now.');
  assert.equal((await fetch(`${base}/api/display/ask?q=delete-everything`)).status, 400);
  // The long poll answers at once when the display's signature is old, with the current one.
  const ev = await (await fetch(`${base}/api/display/events?since=old`)).json();
  assert.equal(ev.changed, true);
  assert.match(ev.sig, /^[0-9a-f]{16}$/);
  // A message posted for the display is in the feed, and changes the long poll's signature.
  const posted = await fetch(`${base}/api/display/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Render done', text: 'The fox', action: { type: 'show', page: 'image' } }) });
  assert.equal(posted.status, 200);
  const feed = await (await fetch(`${base}/api/display/feed`)).json();
  assert.deepEqual(feed.messages.map((m) => [m.title, m.action.page]), [['Render done', 'image']]);
  assert.equal((await (await fetch(`${base}/api/display/events?since=${ev.sig}`)).json()).changed, true);
  assert.equal((await fetch(`${base}/api/display/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'no title' }) })).status, 400);

  // Approvals: the display may decide a low-risk one, never a higher one.
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const low = (await (await post('/api/approvals/create', { title: 'Restart the n8n container', risk: 'low' })).json()).item;
  const high = (await (await post('/api/approvals/create', { title: 'Delete old backups', risk: 'high' })).json()).item;
  assert.ok(low && high, "approvals were created"); {
    const list = (await (await fetch(`${base}/api/display/approvals`)).json()).items;
    assert.equal(list.find((a) => a.id === low.id).decidable, true);
    assert.equal(list.find((a) => a.id === high.id).decidable, false);
    assert.equal((await post('/api/display/approvals/decide', { id: high.id, decision: 'approved' })).status, 403);
    const ok = await post('/api/display/approvals/decide', { id: low.id, decision: 'approved' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'approved');
  }
  assert.equal((await post('/api/display/heartbeat', { version: '12.6.0', uptimeS: 42, rssi: -55, extra: 'dropped' })).status, 200);
  const watch = await (await fetch(`${base}/api/watch`)).json();
  assert.deepEqual([watch.display.version, watch.display.uptimeS, 'extra' in watch.display], ['12.6.0', 42, false]);
});

test('beside a problem the needs card says No approvals, not All clear', () => {
  const clear = buildFeed({ needs: { count: 0 } }).cards[0];
  assert.equal(clear.title, 'All clear');
  const f = buildFeed({ needs: { count: 0 }, watch: [{ id: 'mac-disk', title: 'Mac disk is 92% full', severity: 'medium' }] });
  assert.equal(f.cards[0].title, 'No approvals');
  assert.equal(f.cards[0].text, 'Nothing is waiting for your answer.');
  assert.equal(f.cards[0].tone, 'ok');
  assert.equal(buildFeed({ needs: { count: 0 }, materials: { summary: { spools: 3, loaded: 0, low: 1, unknown: 0, queue: 0 }, status: 'Grey PLA · 100 g left' } }).cards[0].title, 'No approvals');
  assert.equal(buildFeed({ needs: { count: 2, speech: 'Needs you: two approvals.' }, watch: [{ id: 'x', title: 'y' }] }).cards[0].title, 'Needs you');
});

// Pi Hub's one "Needs you" list (GET /api/needs, built by the hub) rides along as feed.needs: the same list on every
// screen, cut like the cards (title 24, detail 90: the display's 28-byte buffers hold a cut title and its 3-byte …) and at most 6. It never becomes cards.
test('needs from Pi Hub are cut and capped at 6', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `pi:thing-${i}`, source: 'pi', tone: i ? 'warn' : 'bad', title: `T${i} ${'x'.repeat(40)}`, detail: 'd'.repeat(200), link: 'http://10.0.0.30/' }));
  const f = buildFeed({ needs: { count: 0 }, piNeeds: { count: 8, items, unread: 0 } });
  assert.equal(f.v, 2);
  assert.equal(f.needs.length, 6);
  assert.equal(f.needsCount, 8, "needsCount is Pi Hub's count, for +N more");
  assert.deepEqual(Object.keys(f.needs[0]).sort(), ['detail', 'id', 'source', 'title', 'tone']);
  assert.deepEqual([f.needs[0].id, f.needs[0].tone, f.needs[0].source], ['pi:thing-0', 'bad', 'pi']);
  assert.equal([...f.needs[0].title].length, 24);
  assert.ok(f.needs[0].title.endsWith('…'));
  assert.equal([...f.needs[0].detail].length, 90);
  assert.ok(f.cards.every((c) => !String(c.id).startsWith('pi:')), 'needs never become cards');
  // Only strings pass; an item without an id or a title is left out, and an unknown tone is warn.
  const odd = buildFeed({ needs: { count: 0 }, piNeeds: { items: [{ id: 'a', tone: 'boom', title: 'A', detail: null }, { id: 'b', title: { x: 1 } }, null, { tone: 'bad', title: 'no id' }, 'str'] } });
  assert.deepEqual(odd.needs, [{ id: 'a', source: '', tone: 'warn', title: 'A', detail: '' }]);
  // The hub answered with nothing: an empty list. The hub is down: no needs at all.
  assert.deepEqual(buildFeed({ needs: { count: 0 }, piNeeds: { count: 0, items: [] } }).needs, []);
  assert.equal('needs' in buildFeed({ needs: { count: 0 }, piNeeds: null }), false);
  assert.equal('needsCount' in buildFeed({ needs: { count: 0 }, piNeeds: null }), false);
  assert.equal(buildFeed({ needs: { count: 0 }, piNeeds: { items: items.slice(0, 2) } }).needsCount, 2, 'no count: the items');
  // A change in the list is news for the display's long poll.
  const { signature } = require('../app/display-feed');
  assert.notEqual(signature(f), signature(buildFeed({ needs: { count: 0 }, piNeeds: { items: items.slice(1) } })));
  assert.notEqual(signature(f), signature(buildFeed({ needs: { count: 0 }, piNeeds: { count: 9, items } })), 'a new count is news');
});

test('needs: a slow Pi Hub is left out, and the feed still answers in time', { timeout: 30000 }, async (t) => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const slow = http.createServer((req, res) => { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"count":0,"items":[]}'); }, 5000); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-feed-'));
  const key = 'wsd_' + 's'.repeat(48);
  fs.writeFileSync(path.join(dataDir, 'workshop-display-key.sha256'), crypto.createHash('sha256').update(key).digest('hex'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead, LOCALAI_BAMBUDDY_URL: 'off', LOCALAI_PI_HUB_URL: `http://127.0.0.1:${slow.address().port}` } });
  t.after(async () => {
    slow.closeAllConnections(); slow.close();
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const started = Date.now();
  const r = await fetch(`${base}/api/display/feed`, { headers: { 'X-LocalAI-Display-Key': key } });
  const took = Date.now() - started;
  assert.equal(r.status, 200);
  const feed = await r.json();
  assert.ok(took < 3500, `feed took ${took} ms`);
  assert.equal('needs' in feed, false);
  assert.equal(feed.cards[0].kind, 'needs');
});

// Pi Hub reads this feed (without a key) to build its Needs you list, and the feed reads Pi Hub's list: only the
// display (its key) gets `needs`, so Pi Hub's read never starts a needs fetch, and one fetch at a time serves the rest.
test('needs: only the display key gets them; Pi Hub\'s unkeyed read makes no /api/needs call; ten at once make one', { timeout: 30000 }, async (t) => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  let needsCalls = 0;
  const hub = http.createServer((req, res) => {
    if (req.url === '/api/needs') {
      needsCalls++;
      return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ count: 11, items: [{ id: 'pi:disk', tone: 'bad', title: 'Disk', detail: 'Full' }], unread: 0 })); }, 300);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-feed-'));
  const key = 'wsd_' + 'n'.repeat(48);
  fs.writeFileSync(path.join(dataDir, 'workshop-display-key.sha256'), crypto.createHash('sha256').update(key).digest('hex'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead, LOCALAI_BAMBUDDY_URL: 'off', LOCALAI_PI_HUB_URL: `http://127.0.0.1:${hub.address().port}` } });
  t.after(async () => {
    hub.closeAllConnections(); hub.close();
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const unkeyed = await (await fetch(`${base}/api/display/feed`)).json();
  assert.equal(needsCalls, 0, 'an unkeyed feed read never fetches the needs');
  assert.equal('needs' in unkeyed, false);
  assert.equal('needsCount' in unkeyed, false);
  const keyed = () => fetch(`${base}/api/display/feed`, { headers: { 'X-LocalAI-Display-Key': key } }).then((r) => r.json());
  await Promise.all(Array.from({ length: 10 }, keyed));
  assert.equal(needsCalls, 1, 'ten keyed feeds at once with the cache expired: one /api/needs call');
  const feed = await keyed();
  assert.deepEqual(feed.needs.map((n) => n.id), ['pi:disk']);
  assert.equal(feed.needsCount, 11);
  assert.equal(needsCalls, 1, 'then cached');
});

// Print lab cards (app/print-lab.js labCards) go in after the needs card, cut like the others.
test('lab cards sit after the needs card; a judge card is not All clear', () => {
  const lab = [{ kind: 'lab', id: 'judge-PR-021-01', title: 'Judge E-021', text: `Look at: ${'the seam '.repeat(20)}`, tone: 'attention', ask: 'lab-judge', run: 'PR-021-01' }];
  const f = buildFeed({ needs: { count: 0 }, weather: 'Sunny.', lab });
  assert.deepEqual(f.cards.map((c) => c.kind), ['needs', 'lab', 'weather']);
  assert.equal(f.cards[0].title, 'No approvals');
  const j = f.cards[1];
  assert.deepEqual([j.id, j.title, j.tone, j.ask, j.run], ['judge-PR-021-01', 'Judge E-021', 'attention', 'lab-judge', 'PR-021-01']);
  assert.equal([...j.text].length, 90);
  const busy = buildFeed({ needs: { count: 0 }, lab: [{ kind: 'lab', id: 'lab-PR-021-01', title: 'Lab · E-021', text: 'The seam', tone: 'busy' }] });
  assert.equal(busy.cards[0].title, 'All clear');
  assert.equal('ask' in busy.cards[1], false);
});

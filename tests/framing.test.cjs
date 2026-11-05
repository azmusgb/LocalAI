'use strict';
// Pi Hub amendment A4, step 7a (Local AI's half): only Pi Hub may frame Local AI; framed by it, Local AI drops its own
// chrome, takes Pi Hub's context from an origin-checked message as text, and posts its route to Pi Hub's origin only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnAppServer } = require('./spawn-server.cjs');
const { HUB_FRAME_ORIGINS, FRAME_POLICY } = require('../app/server/framing');
const framed = require('../app/public/framed');
const askContext = require('../app/public/ask-context');

const HUB = 'https://hub.rahe-home.duckdns.org';

test('the frame policy names self and the two Pi Hub origins, the same list framed.js trusts', () => {
  assert.equal(FRAME_POLICY, "frame-ancestors 'self' https://hub.rahe-home.duckdns.org https://home.home.arpa");
  assert.deepEqual([...framed.HUB_ORIGINS], [...HUB_FRAME_ORIGINS]);
  assert.equal(framed.isHub(HUB), true);
  for (const o of ['https://evil.example', 'http://hub.rahe-home.duckdns.org', 'https://hub.rahe-home.duckdns.org.evil.example', '', null, undefined]) assert.equal(framed.isHub(o), false, String(o));
});

test('every response carries the frame policy: the page, an API, a missing file and a refused host', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-framing-'));
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dir, WORKSPACE_ROOT: dir } });
  t.after(() => child.kill());
  const base = await ready;
  for (const [p, headers] of [['/', {}], ['/healthz', {}], ['/no-such-file.js', {}], ['/healthz', { Host: 'not-an-allowed-host.example' }]]) {
    const r = await fetch(base + p, { headers });
    await r.arrayBuffer();
    assert.equal(r.headers.get('content-security-policy'), FRAME_POLICY, `${p} ${JSON.stringify(headers)} → ${r.status}`);
  }
});

// A window just detailed enough for framed.js: listeners, history, location, a parent that records posts.
function fakeWindow({ inFrame = true, ancestor, referrer = '', hash = '#home' } = {}) {
  const listeners = {}, posts = [], gone = [], classes = new Set();
  const win = {
    listeners, posts, gone, classes,
    location: { hash, ancestorOrigins: ancestor === undefined ? undefined : (ancestor ? [ancestor] : []) },
    history: {
      replaceState(_s, _t, url) { win.location.hash = String(url).slice(String(url).indexOf('#')); },
      pushState(_s, _t, url) { win.location.hash = String(url).slice(String(url).indexOf('#')); },
    },
    document: {
      referrer, readyState: 'loading',
      documentElement: { classList: { add: c => classes.add(c) } },
      addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { dataset: {} },
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    LocalAIAskContext: askContext,
    LocalAIRouter: { go: (h, o) => gone.push([h, o]) },
  };
  win.self = win;
  win.parent = inFrame ? { postMessage: (m, o) => posts.push([m, o]) } : win;
  win.top = inFrame ? win.parent : win;
  return win;
}

test('opened on its own, nothing changes and no message is heard', () => {
  const win = fakeWindow({ inFrame: false, ancestor: HUB });
  const f = framed.create(win); f.start();
  assert.equal(f.active(), false);
  assert.equal(win.classes.size, 0);
  assert.equal(win.listeners.message, undefined);
});

test('framed by Pi Hub (ancestorOrigins, else the referrer): chrome class on, route posted to that origin only', () => {
  for (const opts of [{ ancestor: HUB }, { referrer: 'https://home.home.arpa/assistant?to=work' }]) {
    const win = fakeWindow({ ...opts, hash: '#work' });
    const f = framed.create(win); f.start();
    const origin = opts.ancestor || 'https://home.home.arpa';
    assert.equal(f.active(), true);
    assert.equal(f.origin(), origin);
    assert.ok(win.classes.has('is-framed'));
    assert.deepEqual(win.posts, [[{ type: 'assistant-route', route: 'work' }, origin]]);
    win.history.replaceState(null, '', '/#run/r-1');
    win.history.replaceState(null, '', '/#run/r-1');
    win.location.hash = '#projects'; win.listeners.hashchange.forEach(fn => fn());
    assert.deepEqual(win.posts.map(p => p[0].route), ['work', 'run/r-1', 'projects'], 'each change once, never a repeat');
    assert.ok(win.posts.every(p => p[1] === origin), 'never "*"');
  }
});

test('framed by another site: no chrome change and no posts', () => {
  for (const opts of [{ ancestor: 'https://evil.example' }, { referrer: 'https://evil.example/' }, { ancestor: '' }]) {
    const win = fakeWindow(opts);
    const f = framed.create(win); f.start();
    assert.equal(f.active(), false, JSON.stringify(opts));
    assert.equal(win.classes.size, 0);
    assert.deepEqual(win.posts, []);
  }
});

test('the context message: Pi Hub only, from the parent only, plain text of at most 300 characters', () => {
  const win = fakeWindow({ ancestor: HUB });
  const f = framed.create(win); f.start();
  const send = (data, origin = HUB, source = win.parent) => win.listeners.message.forEach(fn => fn({ data, origin, source }));
  send({ type: 'assistant-context', context: 'Pi Hub › Workshop: <b>printing</b> 42 %' }, 'https://evil.example');
  send({ type: 'assistant-context', context: 'Pi Hub › Workshop: printing' }, HUB, {});
  send({ type: 'assistant-context', context: 42 });
  send({ type: 'something-else', context: 'x' });
  send('assistant-context');
  assert.deepEqual(win.gone, [], 'nothing from another origin, another window or a bad payload');
  send({ type: 'assistant-context', context: 'Pi Hub › Workshop: <b>printing</b>\n42 %' + 'x'.repeat(400) });
  assert.equal(win.gone.length, 1);
  const [h, o] = win.gone[0];
  assert.deepEqual(o, { replace: true });
  assert.ok(h.startsWith('#ask?context='));
  const ctx = decodeURIComponent(h.slice('#ask?context='.length));
  assert.equal(ctx, askContext.clean('Pi Hub › Workshop: <b>printing</b>\n42 %' + 'x'.repeat(400)));
  assert.ok(ctx.length <= 300);
});

test('with no referrer, the first message from Pi Hub to this frame makes it framed', () => {
  const win = fakeWindow({ ancestor: undefined, referrer: '' });
  const f = framed.create(win); f.start();
  assert.equal(f.active(), false);
  win.listeners.message.forEach(fn => fn({ data: { type: 'hello' }, origin: 'https://evil.example', source: win.parent }));
  assert.equal(f.active(), false);
  win.listeners.message.forEach(fn => fn({ data: { type: 'hello' }, origin: HUB, source: win.parent }));
  assert.equal(f.active(), true);
  assert.deepEqual(win.posts, [[{ type: 'assistant-route', route: 'home' }, HUB]]);
});

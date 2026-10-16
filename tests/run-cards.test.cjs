'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCard } = require('../app/run-cards');

const none = { approvalFor: () => null };

test('chat and research runs preview their text', () => {
  const chat = runCard({ id: 'r1', type: 'chat', title: 'Hi', status: 'completed', summary: 'sum', output: { text: 'Hello there' } }, none);
  assert.equal(chat.icon, 'compose');
  assert.deepEqual(chat.preview, { type: 'text', text: 'Hello there' });
  assert.deepEqual(chat.action, { label: 'Open' });
  assert.equal(chat.view, 'ask');
  assert.deepEqual(chat.badge, { label: 'Done', tone: 'good' });
  const res = runCard({ id: 'r2', type: 'research', status: 'running', output: { text: 'x'.repeat(500) } }, none);
  assert.equal(res.icon, 'globe');
  assert.equal(res.view, 'ask');
  assert.equal(res.preview.text.length, 240);
});

test('image runs preview the first image', () => {
  const c = runCard({ id: 'r3', type: 'image', status: 'completed', output: { images: [{ imageUrl: '/a.png' }, { imageUrl: '/b.png' }] } }, none);
  assert.equal(c.icon, 'image');
  assert.deepEqual(c.preview, { type: 'image', src: '/a.png', count: 2 });
  assert.equal(c.view, 'create');
});

test('agent and automation runs', () => {
  const a = runCard({ id: 'legacy-agent:1', type: 'agent', status: 'completed', summary: 'Do a thing' }, none);
  assert.equal(a.icon, 'automate');
  assert.deepEqual(a.preview, { type: 'mission', text: 'Do a thing' });
  assert.equal(a.view, 'agents');
  const u = runCard({ id: 'legacy-automation:1', type: 'automation', status: 'failed', retryable: true }, none);
  assert.equal(u.icon, 'refresh');
  assert.equal(u.view, 'automationStudio');
  assert.equal(u.preview, null);
  assert.deepEqual(u.action, { label: 'Retry' });
  assert.deepEqual(u.badge, { label: 'Failed', tone: 'bad' });
});

test('engineering run awaiting approval carries its approval', () => {
  const run = { id: 'e1', type: 'engineering', status: 'awaiting_approval', meta: { changeId: 'chg-1' } };
  const approval = { id: 'ap1', title: 'Apply change chg-1', detail: 'd', risk: 'high' };
  const c = runCard(run, { approvalFor: r => r.meta.changeId === 'chg-1' ? approval : null, changeFor: () => ({ files: [{ path: 'a.js', operations: [{ type: 'append', content: 'x\ny' }] }] }) });
  assert.equal(c.icon, 'build');
  assert.equal(c.view, 'changes');
  assert.equal(c.approval.risk, 'high');
  assert.equal(c.action.label, 'Review');
  assert.deepEqual(c.preview, { type: 'diff', changeId: 'chg-1', files: [{ path: 'a.js', added: 2, removed: 0 }] });
  assert.equal(runCard(run, none).preview.files, null);
  assert.equal(runCard(run, none).approval, null);
});

test('unknown type and missing output fall back', () => {
  const u = runCard({ id: 'x', type: 'weird', status: 'mystery' }, none);
  assert.equal(u.icon, 'system');
  assert.equal(u.view, 'runs');
  assert.equal(u.preview, null);
  const t = runCard({ id: 'y', type: 'chat', status: 'queued', summary: 'from summary' }, none);
  assert.deepEqual(t.preview, { type: 'text', text: 'from summary' });
  assert.ok(runCard({}, {}).icon);
});

test('engineering preview is a diff stat, never the patch', () => {
  const secret = 'SECRET_PATCH_BODY';
  const run = { id: 'e2', type: 'engineering', status: 'completed', meta: { changeId: 'c2' } };
  const change = { files: [{ path: 'a.js', operations: [{ type: 'replace', find: 'old1\nold2', replace: secret + '\n'.repeat(40) + 'z' }] }, { path: 'b.js', operations: [{ type: 'create', content: secret }] }] };
  const planned = runCard(run, { changeFor: () => change }).preview.files;
  assert.deepEqual(planned.map(f => Object.keys(f)), [['path', 'added', 'removed'], ['path', 'added', 'removed']]);
  assert.deepEqual(planned, [{ path: 'a.js', added: 41, removed: 2 }, { path: 'b.js', added: 1, removed: 0 }]);
  const staged = { ...change, diffs: [{ path: 'a.js', diff: '@@ -1,2 +1,1 @@\n-old1\n-old2\n+' + secret + '\n context', changed: true }] };
  const card = runCard(run, { changeFor: () => staged });
  assert.deepEqual(card.preview.files[0], { path: 'a.js', added: 1, removed: 2 });
  assert.equal(JSON.stringify(card).includes(secret), false);
  assert.equal(JSON.stringify(runCard(run, { changeFor: () => change })).includes(secret), false);
});

test('the badge table in public/ui.js matches run-cards.js', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../app/public/ui.js'), 'utf8');
  const m = src.match(/const STATUS=(\{[^}]*\});/);
  assert.ok(m, 'ui.js defines STATUS');
  assert.deepEqual(JSON.parse(m[1].replace(/([{,])(\w+):/g, '$1"$2":').replace(/'/g, '"')), { ...require('../app/run-cards').STATUS });
});

test('legacy mission and specialist runs are agent cards', () => {
  for (const type of ['mission', 'specialist']) {
    const c = runCard({ id: 'legacy:' + type, type, status: 'completed', summary: 'Do a thing' }, none);
    assert.equal(c.kind, 'agent');
    assert.equal(c.icon, 'automate');
    assert.equal(c.view, 'agents');
    assert.deepEqual(c.preview, { type: 'mission', text: 'Do a thing' });
  }
});

test('workKind maps a run to its Work chip, older mission and specialist runs to missions', () => {
  const { workKind, WORK_CHIPS } = require('../app/run-cards');
  const k = type => workKind({ type });
  assert.deepEqual(['chat', 'research', 'image', 'agent', 'mission', 'specialist', 'engineering', 'automation', 'odd', undefined].map(k),
    ['chats', 'chats', 'images', 'missions', 'missions', 'missions', 'changes', 'other', 'other', 'other']);
  assert.deepEqual([...WORK_CHIPS], ['chats', 'images', 'missions', 'changes', 'other']);
});

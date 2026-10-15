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
  const c = runCard(run, { approvalFor: r => r.meta.changeId === 'chg-1' ? approval : null, changeFor: () => ({ files: [{ path: 'a.js' }] }) });
  assert.equal(c.icon, 'build');
  assert.equal(c.view, 'changes');
  assert.equal(c.approval.risk, 'high');
  assert.equal(c.action.label, 'Review');
  assert.deepEqual(c.preview, { type: 'diff', changeId: 'chg-1', files: [{ path: 'a.js' }] });
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

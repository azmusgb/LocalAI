'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCard, readableTitle } = require('../app/run-cards');

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

test('a finished health check that reports a problem is not Done', () => {
  const run = (summary, status = 'completed') => runCard({ id: 'legacy-automation:2', type: 'automation', status, summary }, none).badge;
  assert.deepEqual(run('Overall: DOWN. Ollama: DOWN; ComfyUI: HEALTHY'), { label: 'Found problems', tone: 'bad' });
  assert.deepEqual(run('Overall: DEGRADED. Ollama: DEGRADED'), { label: 'Found problems', tone: 'attention' });
  assert.deepEqual(run('Overall: HEALTHY. Ollama: HEALTHY'), { label: 'Done', tone: 'good' });
  assert.deepEqual(run('Overall: DOWN. Ollama: DOWN', 'failed'), { label: 'Failed', tone: 'bad' });
  // Only automations are read this way: a chat that quotes the words stays Done.
  assert.deepEqual(runCard({ id: 'c1', type: 'chat', status: 'completed', summary: 'Overall: DOWN' }, none).badge, { label: 'Done', tone: 'good' });
});

test('agent and automation runs', () => {
  const a = runCard({ id: 'legacy-agent:1', type: 'agent', status: 'completed', summary: 'Do a thing' }, none);
  assert.equal(a.icon, 'automate');
  assert.deepEqual(a.preview, { type: 'mission', text: 'Do a thing' });
  assert.equal(a.view, 'agents');
  // A mission that finished without some follow-ups says so before its answer.
  const n = runCard({ id: 'r9', type: 'agent', status: 'completed', summary: 'The answer', output: { missionId: 'm', outcome: 'complete', note: '2 follow-ups ran out of time' } }, none);
  assert.equal(n.summary, '2 follow-ups ran out of time · The answer');
  assert.deepEqual(n.preview, { type: 'mission', text: '2 follow-ups ran out of time · The answer' });
  assert.deepEqual(n.badge, { label: 'Done', tone: 'good' });
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
  assert.deepEqual(['chat', 'research', 'image', 'agent', 'mission', 'specialist', 'spreadsheet', 'engineering', 'automation', 'odd', undefined].map(k),
    ['chats', 'chats', 'images', 'missions', 'missions', 'missions', 'sheets', 'changes', 'other', 'other', 'other']);
  assert.deepEqual([...WORK_CHIPS], ['chats', 'images', 'missions', 'sheets', 'changes', 'other']);  // Spreadsheets became a Work kind (2 Nov, D4)
});

test('a finished engineering run with no files has no preview line; only a running one is "being prepared"', () => {
  for (const status of ['failed', 'cancelled', 'completed']) {
    assert.equal(runCard({ id: 'e3', type: 'engineering', status, meta: { changeId: 'chg-x' } }, { changeFor: () => null }).preview, null, status);
  }
  for (const status of ['running', 'queued']) {
    assert.deepEqual(runCard({ id: 'e4', type: 'engineering', status, meta: {} }).preview, { type: 'diff', changeId: null, files: null }, status);
  }
});

test('readableTitle: a label, else the whole title, else its first words cut at a word, never an instruction prompt', () => {
  // Instructions (a prompt that starts "You are …", like the hub's House questions before they carried a label) never show.
  assert.equal(readableTitle({ type: 'chat', title: 'You are a careful reviewer. Check th…' }), 'Chat');
  assert.equal(readableTitle({ type: 'chat', title: 'Plan the garden' }), 'Plan the garden');
  assert.equal(readableTitle({ type: 'chat', title: 'x'.repeat(200), meta: { label: 'House question' } }), 'House question');
  assert.equal(readableTitle({ type: 'automation', title: 'Hourly Stack & ComfyUI Health Check' }), 'Hourly Stack & ComfyUI Health Check');
  assert.equal(readableTitle({ type: 'chat', title: 'Why does the printer stop at layer 40 when the AMS is on slot 3?' }), 'Why does the printer stop at layer 40 when the AMS is on slot 3?');
  assert.equal(readableTitle({ type: 'research', title: '' }), 'Research');
  // A long first message: the server keeps 69 characters and adds "…"; Recent shows its first words, cut at a word.
  const asked = "What's the best way to dry PETG before printing it on the X2D with the AMS loaded?";
  const server = asked.slice(0, 69).trim() + '…';
  const t = readableTitle({ type: 'chat', title: server });
  assert.equal(t, "What's the best way to dry PETG before printing it on the X2D with…");
  assert.ok(t.length <= 72 && asked.startsWith(t.slice(0, -1)) && asked[t.length - 1] === ' ', t);
  assert.equal(readableTitle({ type: 'chat', title: 'line one\nline two' }), 'line one…');
  assert.equal(readableTitle({ type: 'agent', title: 'Tidy the workshop inventory, then ' + 'y'.repeat(60) }), 'Tidy the workshop inventory, then…');
  // One long word has no word break to cut at: it is cut where it is.
  const long = readableTitle({ type: 'chat', title: 'x'.repeat(69) + '…' });
  assert.ok(long.endsWith('…') && long.length <= 72, long);
  assert.equal(runCard({ type: 'image', title: 'A red fox in the snow at dusk, watercolour, soft light, wide shot, ' + 'z'.repeat(40) }, none).title,
    'A red fox in the snow at dusk, watercolour, soft light, wide shot…');
});

// Pi Hub's House questions from before they carried a label: their stored title is the hub's prompt. Shown as what
// they are, without touching the stored runs.
test('an unlabelled House question from Pi Hub reads "House question"', () => {
  assert.equal(readableTitle({ type: 'chat', title: "You are the voice of a family's home hub on a Raspberry Pi. Answer th…" }), 'House question');
  assert.equal(readableTitle({ type: 'chat', title: 'You are a helpful assistant. Summarise this.' }), 'Chat');
});

// The model coordinator, step 3: every run says where its answer came from (meta.route), with the reason.
test('a run card says where the answer came from', () => {
  const { runCard } = require('../app/run-cards');
  const cloud = runCard({ type: 'research', status: 'completed', meta: { route: { provider: 'groq', model: 'llama-3.3-70b-versatile', class: 'shareable', why: 'Not private: research about public topics' } } });
  assert.deepEqual(cloud.route, { text: 'Answered by Llama 3.3 70B · Groq', why: 'Not private: research about public topics' });
  const local = runCard({ type: 'chat', status: 'completed', meta: { route: { provider: 'ollama', model: 'qwen3', class: 'private', why: 'It looks personal (health, money, legal, family or identity)' } } });
  assert.equal(local.route.text, 'Answered on this PC');
  const mission = runCard({ type: 'agent', status: 'completed', meta: { missionId: 'm1', route: { provider: 'cerebras', model: 'llama-3.3-70b', why: 'x' } } });
  assert.equal(mission.route.text, 'Answered by Llama 3.3 70B · Cerebras');
  const change = runCard({ type: 'engineering', status: 'completed', meta: { changeId: 'chg-1' } }, { changeFor: () => ({ id: 'chg-1', files: [], route: { provider: 'groq', model: 'openai/gpt-oss-120b', why: 'y' } }) });
  assert.equal(change.route.text, 'Answered by GPT-OSS 120B · Groq');
  assert.equal(runCard({ type: 'chat', status: 'completed', meta: {} }).route, null, 'older runs say nothing');
  assert.equal(runCard({ type: 'chat', status: 'completed', meta: { route: 'groq' } }).route, null);
});

test('a Past work run is a prompt card: its question as the title, its answer as the preview, under Chats', () => {
  const { runCard: card, workKind } = require('../app/run-cards');
  const run = { id: 'run-1', type: 'prompt', title: 'what did I ask about PETG', status: 'completed', summary: 'You asked [1].', meta: { mode: 'history' }, output: { text: 'You asked about a bracket [1].', citations: [], entries: [] } };
  const c = card(run);
  assert.equal(c.kind, 'prompt'); assert.equal(c.icon, 'history'); assert.equal(c.view, 'ask');
  assert.equal(c.title, 'what did I ask about PETG');
  assert.deepEqual(c.preview, { type: 'text', text: 'You asked about a bracket [1].' });
  assert.equal(workKind(run), 'chats');
});

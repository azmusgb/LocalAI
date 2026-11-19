'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { createJournal } = require('../app/journal');
const { runEntry, runText, voiceEntry, approvalEntry, powerShellApprovalEntry, releaseEntry, record, recordRelease, RELEASE_SETTING } = require('../app/journal-recorders');

const run = (over = {}) => ({ id: 'run-1', type: 'chat', title: 'Which filament for a bracket?', status: 'completed', createdAt: '2026-10-22T18:00:00.000Z', finishedAt: '2026-10-22T18:01:00.000Z', summary: 'short', input: { prompt: 'Which filament for a bracket?' }, output: { text: 'PETG is a good choice.' }, error: null, meta: {}, ...over });

test('a completed run becomes one entry linking back to it', () => {
  assert.deepEqual(runEntry(run()), {
    at: '2026-10-22T18:01:00.000Z', source: 'run', kind: 'chat', title: 'Which filament for a bracket?',
    body: 'PETG is a good choice.', link: '#run/run-1', ref: 'run:run-1:completed', meta: { status: 'completed', type: 'chat' }
  });
});

test('failed runs keep the error; unfinished runs are not recorded', () => {
  assert.equal(runEntry(run({ status: 'failed', output: null, error: 'Model timed out' })).body, 'Model timed out');
  assert.equal(runEntry(run({ status: 'failed' })).ref, 'run:run-1:failed');
  for (const status of ['queued', 'running', 'streaming', 'awaiting_approval']) assert.equal(runEntry(run({ status })), null);
  assert.equal(runEntry(null), null);
});

test('PowerShell runs are recorded by title only', () => {
  assert.equal(runEntry(run({ type: 'powershell' })).body, '');
  assert.equal(runEntry(run({ meta: { powershell: true } })).body, '');
});

test('runText reads the result in order of preference', () => {
  assert.equal(runText({ output: 'plain' }), 'plain');
  assert.equal(runText({ output: { answer: 'A' } }), 'A');
  assert.equal(runText({ output: { outcome: 'complete' }, summary: 'Mission done' }), 'Mission done');
  assert.equal(runText({ output: { outcome: 'complete' } }), 'complete');
  assert.equal(runText({ output: null, summary: 'Created 2 images' }), 'Created 2 images');
  assert.equal(runText({ output: { images: [] }, summary: 'S', input: { prompt: 'a red fox' } }), 'S\nAsked: a red fox');
});

test('a run that completes twice is recorded once', () => {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'journal-rec-')) });
  const journal = createJournal({ db: storage.db });
  journal.record(runEntry(run()));
  journal.record(runEntry(run({ output: { text: 'Rewritten answer' } })));
  assert.equal(journal.search({}).items.length, 1);
  assert.equal(journal.search({}).items[0].body, 'PETG is a good choice.');
  storage.close();
});

// A Past work answer is made from journal entries: recording it would feed the journal its own summaries, and the
// next ask would cite the answer instead of the work (owner's call; memory-core spec §4 as changed by A28).
test('Past work runs are not recorded back into the journal, whatever their status', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(runEntry(run({ type: 'prompt', status, meta: { mode: 'history' }, output: { text: 'You asked about PETG [1].', citations: [], entries: [] } })), null, status);
  }
  assert.notEqual(runEntry(run({ type: 'prompt', meta: {} })), null, 'only the history mode is left out');
});

// Amendment A28 D2: the journal does not record house things. Prints, films and spools are Bambuddy's and Plex's,
// read through Pi Hub when asked, never kept on the PC.
test('the recorders have no builder for prints, films or materials (A28 D2)', () => {
  const recorders = require('../app/journal-recorders');
  for (const name of Object.keys(recorders)) assert.doesNotMatch(name, /print|watch|film|movie|material|spool/i, name);
  const source = fs.readFileSync(path.join(__dirname, '../app/journal-recorders.js'), 'utf8');
  assert.doesNotMatch(source, /source:\s*['"](?:print|watch|materials)['"]/, 'no entry is built with a house source');
  // The sources it does build are the Assistant's own (A28 D1).
  const sources = [...source.matchAll(/source:\s*['"]([a-z]+)['"]/g)].map(m => m[1]).sort();
  assert.deepEqual(sources, ['approval', 'release', 'run', 'voice']);
});

const fresh = () => {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'journal-rec-')) });
  return { storage, journal: createJournal({ db: storage.db }) };
};
const broken = { record() { throw new Error('disk I/O error'); } };

// Voice: an answer with no run of its own. One a run gave (chat, a looked-up answer) is that run's entry already.
test('a spoken answer without a run becomes one voice entry', () => {
  assert.deepEqual(voiceEntry({ intent: 'time', question: 'what time is it', answer: 'It is 3:04 in the afternoon.', at: 1795536000000 }), {
    at: '2026-11-24T16:00:00.000Z', source: 'voice', kind: 'time', title: 'what time is it', body: 'It is 3:04 in the afternoon.',
    ref: 'voice:1795536000000', meta: { intent: 'time' }
  });
});

test('voice answers a run gave, Past work answers and empty turns are not voice entries', () => {
  const base = { intent: 'chat', question: 'explain WAL mode', answer: 'It is a journal mode.', at: 1795536000000 };
  assert.equal(voiceEntry({ ...base, runId: 'run-9' }), null, 'the run recorder has it');
  assert.equal(voiceEntry({ ...base, intent: 'history', runId: null }), null, 'Past work never re-enters the journal (A28 D5)');
  assert.equal(voiceEntry({ ...base, intent: 'history', runId: 'run-9' }), null);
  assert.equal(voiceEntry({ ...base, answer: '  ' }), null);
  assert.equal(voiceEntry({ ...base, question: '' }), null);
  assert.equal(voiceEntry({ ...base, at: 'not a time' }), null);
  assert.equal(voiceEntry(), null);
});

// Approvals: the same ref the one-time import gives, so neither writes it twice.
test('an approval decision says what was decided and where', () => {
  const item = { id: 'appr-1', title: 'Agent action approval', detail: 'Tidy the downloads folder', status: 'approved', updatedAt: '2026-11-19T10:00:00.000Z', meta: {} };
  assert.deepEqual(approvalEntry(item, { where: 'app' }), {
    at: '2026-11-19T10:00:00.000Z', source: 'approval', kind: 'approved', title: 'Agent action approval',
    body: 'Approved in Local AI.\nTidy the downloads folder', ref: 'approval:appr-1:approved', meta: { approvalId: 'appr-1', by: 'app' }
  });
  const shown = approvalEntry({ ...item, status: 'rejected', detail: '', meta: { changeId: 'chg-1' } }, { where: 'display' });
  assert.equal(shown.body, 'Declined on the Workshop display.');
  assert.equal(shown.ref, 'approval:appr-1:rejected');
  assert.deepEqual(shown.meta, { approvalId: 'appr-1', by: 'display', changeId: 'chg-1' });
  assert.equal(approvalEntry({ ...item, status: 'pending' }), null);
  assert.equal(approvalEntry(null), null);
});

test('an approval for a host command keeps its text out, as PowerShell runs do', () => {
  const item = { id: 'appr-2', title: 'Run a PowerShell script', detail: 'Remove-Item C:\\secret -Recurse', status: 'approved', meta: { powershell: true } };
  assert.equal(approvalEntry(item).body, 'Approved in Local AI.');
  assert.equal(approvalEntry({ ...item, meta: { jobId: 'ps-123' } }).body, 'Approved in Local AI.');
});

// PowerShell Workbench decisions: title and risk only, never the script, its folder or its output.
test('a PowerShell job decision is an approval entry with no command text', () => {
  const job = { id: 'ps-1795536000000-abc1234', script: 'Remove-Item C:\\Projects\\x -Recurse', cwd: 'C:\\Projects', risk: 'high', status: 'approved', updatedAt: '2026-11-19T15:00:00.000Z', stdout: 'secret-output', stderr: '' };
  assert.deepEqual(powerShellApprovalEntry(job), {
    at: '2026-11-19T15:00:00.000Z', source: 'approval', kind: 'approved', title: 'PowerShell job (high risk)',
    body: 'Approved in the PowerShell Workbench.', ref: 'approval:ps-1795536000000-abc1234:approved', meta: { approvalId: job.id, by: 'workbench' }
  });
  const declined = powerShellApprovalEntry({ ...job, status: 'rejected' });
  assert.equal(declined.body, 'Declined in the PowerShell Workbench.');
  assert.doesNotMatch(JSON.stringify([powerShellApprovalEntry(job), declined]), /Remove-Item|Projects|secret-output/);
  assert.equal(powerShellApprovalEntry({ ...job, risk: 'odd' }).title, 'PowerShell job');
});

test('cancelling a job still waiting for approval declines it; other cancels and states are not decisions', () => {
  const job = { id: 'ps-1-a', risk: 'low', status: 'cancelled' };
  const cancelled = powerShellApprovalEntry(job, { cancelledFrom: 'pending_approval' });
  assert.equal(cancelled.ref, 'approval:ps-1-a:rejected', 'the same entry as declining it');
  for (const was of ['approved', 'run_requested', undefined]) assert.equal(powerShellApprovalEntry(job, { cancelledFrom: was }), null, String(was));
  for (const status of ['pending_approval', 'run_requested', 'running', 'completed', 'failed']) assert.equal(powerShellApprovalEntry({ ...job, status }), null, status);
  assert.equal(powerShellApprovalEntry({ ...job, id: 'approval-1', status: 'approved' }), null, 'only Workbench jobs');
  assert.equal(powerShellApprovalEntry(null), null);
});

// Job ids are ps-…, approvals approval-… (makeId), and the one-time import reads only approvals: the refs never meet.
test('PowerShell decision refs cannot collide with approval or import refs', () => {
  const { storage, journal } = fresh();
  const at = '2026-11-19T15:00:00.000Z';
  assert.ok(record(journal, approvalEntry({ id: 'approval-1795536000000-abc1234', title: 'Agent action approval', status: 'approved', meta: {} })));
  assert.ok(record(journal, powerShellApprovalEntry({ id: 'ps-1795536000000-abc1234', risk: 'low', status: 'approved', updatedAt: at })));
  assert.equal(record(journal, powerShellApprovalEntry({ id: 'ps-1795536000000-abc1234', risk: 'low', status: 'approved', updatedAt: at })), null, 'approving twice adds nothing');
  assert.equal(journal.search({ sources: ['approval'] }).items.length, 2);
  storage.close();
});

test('a release entry names the version and lists the release notes', () => {
  const commit = 'a'.repeat(40);
  assert.deepEqual(releaseEntry({ commit, version: '2.0.565', deployedAt: '2026-11-19T09:00:00.000Z', notes: [{ title: 'Past work in the composer', pr: 565 }, { title: 'Faster Home' }] }, { version: '2.0.565' }), {
    at: '2026-11-19T09:00:00.000Z', source: 'release', kind: 'update', title: 'Local AI updated to 2.0.565',
    body: 'Past work in the composer\nFaster Home', ref: `release:${commit}`, meta: { commit, version: '2.0.565' }
  });
  assert.equal(releaseEntry({ commit }, { version: '2.0' }).body, '');
  assert.equal(releaseEntry(null), null);
  assert.equal(releaseEntry({}), null);
});

test('record never throws: a failing journal or builder answers null', () => {
  assert.equal(record(broken, { source: 'voice', kind: 'time', title: 't', ref: 'voice:1' }), null);
  assert.equal(record({ record: () => ({ id: 'x' }) }, () => { throw new Error('bad data'); }), null);
  assert.equal(record(null, { ref: 'x' }), null);
  assert.equal(record({ record: () => { throw new Error('unused'); } }, null), null, 'nothing to record calls nothing');
});

test('the same voice answer or approval decision is recorded once per ref', () => {
  const { storage, journal } = fresh();
  const v = { intent: 'needs', question: 'anything need me', answer: 'Nothing needs you.', at: 1795536000000 };
  assert.ok(record(journal, voiceEntry(v)));
  assert.equal(record(journal, voiceEntry(v)), null);
  const item = { id: 'appr-1', title: 'Agent action approval', status: 'approved', meta: {} };
  assert.ok(record(journal, approvalEntry(item, { where: 'app' })));
  assert.equal(record(journal, approvalEntry(item, { where: 'display' })), null, 'deciding again adds nothing');
  assert.equal(journal.search({}).items.length, 2);
  storage.close();
});

// Release: once per commit, kept in setting journal-release.
test('a release is recorded once: first start, not on restart, again for a new commit', () => {
  const { storage, journal } = fresh();
  const one = { commit: '1'.repeat(40), notes: [{ title: 'Journal recorders' }] };
  const now = () => Date.parse('2026-11-19T12:00:00.000Z');
  assert.ok(recordRelease({ journal, storage, release: one, version: '2.0.566', now }), 'first start with no setting');
  assert.equal(storage.readSetting(RELEASE_SETTING, null).commit, one.commit);
  assert.equal(recordRelease({ journal, storage, release: one, version: '2.0.566', now }), null, 'restart on the same release');
  storage.writeSetting(RELEASE_SETTING, null); // even with the setting lost, the ref keeps it to one entry
  assert.equal(recordRelease({ journal, storage, release: one, version: '2.0.566', now }), null);
  const two = { commit: '2'.repeat(40) };
  assert.ok(recordRelease({ journal, storage, release: two, version: '2.0.567', now }));
  assert.deepEqual(journal.search({ sources: ['release'] }).items.map(i => i.title).sort(), ['Local AI updated to 2.0.566', 'Local AI updated to 2.0.567']);
  assert.equal(recordRelease({ journal, storage, release: null, version: '2.0', now }), null, 'a checkout without release.json records nothing');
  storage.close();
});

test('a release the journal could not take is tried again on the next start', () => {
  const { storage, journal } = fresh();
  const rel = { commit: '3'.repeat(40) };
  assert.equal(recordRelease({ journal: broken, storage, release: rel, version: '2.0.1' }), null);
  assert.equal(storage.readSetting(RELEASE_SETTING, null), null, 'not marked as recorded');
  assert.ok(recordRelease({ journal, storage, release: rel, version: '2.0.1' }));
  storage.close();
});

test('a settings store that fails records nothing and does not throw', () => {
  const { storage, journal } = fresh();
  const rel = { commit: '4'.repeat(40) };
  const unreadable = { readSetting() { throw new Error('database is locked'); }, writeSetting() { throw new Error('unused'); } };
  assert.equal(recordRelease({ journal, storage: unreadable, release: rel, version: '2.0.1' }), null);
  assert.equal(journal.search({}).items.length, 0, 'an unknown last release is not read as none');
  const unwritable = { readSetting: () => null, writeSetting() { throw new Error('read-only'); } };
  assert.doesNotThrow(() => recordRelease({ journal, storage: unwritable, release: rel, version: '2.0.1' }));
  storage.close();
});

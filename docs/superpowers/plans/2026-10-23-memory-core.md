# Memory core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One durable, searchable journal of what happens in Local AI, with recorders, Ask history, ⌘K and History
tab search, and a 9 pm recap.

**Architecture:** `app/journal.js` owns two SQLite tables (`journal`, `journal_fts`, plus `journal_deleted`) in the
appliance database, created `IF NOT EXISTS` without a schema version bump. Recorders call `journal.record()` where
events are already known (run ledger `onTransition`, watchdog tick, a 1-minute journal tick, voice, approvals, start-up).
Routes live in `app/server/journal.js` (the server-split pattern: `createJournalRoutes(ctx)`).

**Tech Stack:** Node 22.13+ built-ins only (`node:sqlite` FTS5, `node:test`), Playwright for browser tests.

**Spec:** `docs/superpowers/specs/2026-10-23-memory-core-design.md`

## Global Constraints

- No new runtime npm dependencies; Node built-ins only.
- Do not change `SCHEMA_VERSION` in `app/storage.js`; journal tables are `CREATE … IF NOT EXISTS`.
- `storage.transaction()` is synchronous; never await inside it.
- Recorders never throw to their caller.
- Title ≤ 200 chars, body ≤ 4000 chars, both redacted before storage.
- Time zone: `process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'` (as `voiceTimeZone`).
- In-app links use the existing hash routes: `#run/<id>` for runs.
- Mutations are `POST` (codebase convention): `POST /api/journal/delete {id}` replaces the spec's `DELETE /api/journal/:id`.
- PR titles are release notes: write them for the owner.

## Review Focus

1. A search string with FTS syntax (`"`, `*`, `NEAR`, `-`, `:`, unbalanced quotes) → treated as plain words, no SQL error.
2. Restart in the middle of the import → next start continues; no duplicates (Task 3 test).
3. A run that transitions to `completed` twice (retry, rewrite) → one entry per `ref`, later text does not duplicate.
4. A deleted entry whose source still exists → never re-imported or re-recorded (Task 1 + Task 3 tests).
5. An older release after rollback opening a database with journal tables → still starts (Task 1 test opens the
   database with the unchanged `Storage` after journal tables exist and runs `check()`).

---

## PR 1 — Journal, run recorder, import, API

### Task 1: Journal module

**Files:**
- Create: `app/journal.js`
- Test: `tests/journal.test.cjs`

**Interfaces:**
- Produces: `createJournal({ db, now = Date.now, timeZone })` →
  `{ record(entry) → {id}|null, remove(id) → boolean, search({q, from, to, sources, limit = 50, before}) → {items, next},
  get(id), countSince(iso), dayOf(iso) → 'YYYY-MM-DD', window(text) → {from, to, rest} }`.
  `entry = {at, source, kind, title, body?, link?, ref, meta?}`. Returned items: `{id, at, day, source, kind, title, body,
  link, meta}`. Also exports `redact(text)`, `ftsQuery(text)`.

- [ ] **Step 1: Write failing tests** in `tests/journal.test.cjs` using a real `Storage` on a temp dir (`storage.db`):
  - `record` stores and returns an id; same `ref` again returns `null` and leaves one row.
  - `search({q:'bracket'})` finds an entry whose body says "PETG bracket" and `porter` matches "brackets".
  - Ranking: of two equal matches, the newer comes first.
  - `search({q:'"NEAR( * -x: ('})` returns `{items: []}` without throwing (Review Focus 1).
  - `remove(id)` → `search` no longer finds it; `record` with the same `ref` returns `null` (tombstone).
  - `redact('token=abc123 and ' + 'a'.repeat(40))` contains `[redacted]` twice and not `abc123`; `-----BEGIN … PRIVATE KEY-----` block is redacted; `Bearer xyz` redacted.
  - Title cut to 200, body to 4000.
  - `window('what did I print yesterday')` with `now` = 2026-10-23T15:00Z, tz `America/New_York` → from `2026-10-22T04:00:00.000Z`, to `2026-10-23T04:00:00.000Z`, `rest` = `'what did I print'`. Also `today`, `last week` (previous Mon–Sun), `saturday` (most recent past Saturday), `in october`, `this month`.
  - Rollback safety (Review Focus 5): after creating a journal, close, open `new Storage({dataDir})` again → no throw, `check()` true.
- [ ] **Step 2:** `node --test tests/journal.test.cjs` → fails (module missing).
- [ ] **Step 3: Implement `app/journal.js`.** Schema exactly as the spec §1, plus
  `CREATE TABLE IF NOT EXISTS journal_deleted (ref TEXT PRIMARY KEY) STRICT`, FTS triggers
  (`journal_ai`, `journal_ad` using the external-content `'delete'` form), indexes `journal_day`, `journal_source_at`.
  Ids: `j-<ms>-<seq base36>`. `ftsQuery`: lowercase words `[\p{L}\p{N}]+`, drop stop words
  (`what when did i my the a an of to in on for was is how long which have`), quote each, last gets `*`, join with
  space (AND); empty → no match. Rank: `ORDER BY bm25(journal_fts) - (julianday(at) - julianday('now')) * 0.02`.
  Without `q`: `ORDER BY at DESC, seq DESC`; cursor `before` = an `at` value. `record` wraps everything in try/catch
  and logs at most once a minute.
- [ ] **Step 4:** `node --test tests/journal.test.cjs` → PASS.
- [ ] **Step 5: Commit** `Journal: one searchable record of what happens`.

### Task 2: Run recorder

**Files:**
- Create: `app/journal-recorders.js`
- Modify: `app/server.js:123` (`onTransition`)
- Test: `tests/journal-recorders.test.cjs`

**Interfaces:**
- Consumes: `journal.record` (Task 1).
- Produces: `runEntry(run) → entry|null` (pure), `runText(run) → string`.

- [ ] **Step 1: Failing tests:** `runEntry` for a completed chat run gives `{source:'run', kind:'chat', title:<run.title>,
  body:<output text>, link:'#run/<id>', ref:'run:<id>:completed', meta:{status:'completed', type:'chat'}}`; a failed run
  body is `run.error`; non-terminal status → `null`; `type: 'powershell'` (and any run with `meta.powershell`) → body `''`;
  `runText` reads, in order: `output` string, `output.text|answer|content|outcome|preview`, `summary`.
  Review Focus 3: two `completed` transitions record once (use a real journal).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; in `server.js` extend `onTransition` to also call
  `journal.record(runEntry(run))` when it returns an entry (after the notifier, inside its own try).
- [ ] **Step 4:** PASS, and `npm test` PASS. **Step 5: Commit** `Journal: every finished run is remembered`.

### Task 3: One-time import

**Files:**
- Create: `app/journal-import.js`
- Modify: `app/server.js` (start it after listen, unref'd)
- Test: `tests/journal-import.test.cjs`

**Interfaces:**
- Produces: `importAll({ storage, journal, runLedger, batch = 200, pause = () => new Promise(r => setImmediate(r)) })`
  → `Promise<{added, done}>`; progress in setting `journal-import-v1` `{done, stage, cursor}`.

- [ ] **Step 1: Failing tests:** seed a temp `Storage` with 2 runs, a conversation with 2 user/assistant pairs,
  a library artifact, an approval decided `approved`, a change `applied`, 2 activities; `importAll` adds 8 entries
  with refs `run:<id>:<status>`, `chat:<convId>:<n>`, `library:<id>`, `approval:<id>:<status>`, `change:<id>:applied`,
  `activity:<id>`; running it again adds 0; a run of status `running` is skipped; with the setting marked
  `{stage:'library'}` it resumes there (Review Focus 2); a deleted entry is not re-imported (Review Focus 4).
- [ ] **Step 2:** FAIL. **Step 3:** implement stages `runs → conversations → library → missions → approvals → changes → activity`,
  reading with `storage.list(collection)` and `runLedger.list({all:true, limit: 100000})`; fields read defensively
  (`title|name`, `content|text|summary|detail`, `createdAt|at|updatedAt`). Run entries reuse `runEntry`.
- [ ] **Step 4:** PASS. **Step 5: Commit** `Journal: bring in past runs, chats, kept items, approvals and changes`.

### Task 4: API

**Files:**
- Create: `app/server/journal.js`
- Modify: `app/server.js` (create, route `GET /api/journal`, `POST /api/journal/delete`)
- Test: `tests/journal-api.test.cjs` (spawns the server on a spare port with a temp `DATA_DIR`, like other API tests)

**Interfaces:**
- Produces: `GET /api/journal?q=&from=&to=&source=a,b&limit=&before=` → `{items, next}`;
  `POST /api/journal/delete {id}` → `{ok:true}` or 404. Also `{items}` include `link`.

- [ ] **Step 1: Failing test:** after a chat run completes on a server whose model URL points at a stub that returns
  "PETG bracket", `GET /api/journal?q=bracket` returns 1 item with `source:'run'`; delete it → 200, search → 0;
  delete again → 404; `limit=999` is capped at 200; bad `from` is ignored.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test` PASS; browser suites on a fresh server PASS.
- [ ] **Step 5: Commit** and open PR 1: **"Local AI starts remembering: one searchable journal of your work"**.
  Run `npm run ci -- <PR>`; merge on green; confirm `/healthz` and `GET https://10.0.0.21/api/journal?limit=5`.

## PR 2 — Recorders (print, watch, materials, voice, approval, release)

### Task 5: Print recorder
- Modify `app/watchdog.js` tick: on `printerState` change, keep `{startedAt}` in its state on `→ printing`; on
  `printing|paused → ended|cancelled|error|idle` call `onPrint({state, startedAt, endedAt, errorCode})`.
  `printEntry(...)` in `app/journal-recorders.js`: kind `printed` (idle after ≥ 95% progress) / `cancelled` / `failed`;
  title "Print finished · 2 h 14 min" etc.; ref `print:<startedAt>`.
- Tests: finished, cancelled, failed with code, display offline mid-print then back printing (no entry), restart
  mid-print (no entry until it ends).

### Task 6: Watch, materials and the journal tick
- Create `app/journal-tick.js`: `createJournalTick({ piHub, materials, journal, now })` with `tick()` every 60 s.
  Watch sessions keyed `title|device`; entry when a session disappears: "Watched *X* on *device*", body finished
  (≥ 90%) or "stopped at N%", `who`; ref `watch:<key>:<startedAt>`. Materials: entry when `low` rises or `loaded`
  changes; ref `materials:<at>`.
- Tests with fake hub/materials sequences: finish, stop at 40%, two devices, hub offline (no entries).

### Task 7: Voice, approval, release
- Voice: in `app/server/voice.js` after an answer is spoken, `record({source:'voice', kind:intent, title:question, body:answer, ref:'voice:<runId|ms>'})`.
- Approval: in `apiApprovalDecide` and the display decide path: ref `approval:<id>:<status>`, body says where.
- Release: at start-up, when `release.commit` ≠ setting `journal-release`, record "Local AI updated to <version>" with
  note titles; ref `release:<commit>`.
- Tests for each through their pure entry builders. Open PR 2: **"Local AI remembers prints, films, spools and what you asked"**.

## PR 3 — Ask history

### Task 8: Ask API
- Create `app/journal-ask.js`: `askHistory({ question, journal, chatOnce, now })` → `{answer, citations:[{n, id, link, title, at}], entries}`.
  Retrieval per spec §4 (`window` → 12 by search, else newest 30 in window). Empty → `{answer:"I don't have anything about that.", citations:[]}` and `chatOnce` not called.
  Prompt: system "Answer only from the numbered entries. Cite them as [n]. If they don't answer the question, say so."
- `POST /api/journal/ask {question}` creates a run (`type:'prompt'`, `meta.mode:'history'`), completes it with
  `output:{text, citations}`.
- Tests: fake `chatOnce`; citations parsed from `[n]`; empty retrieval doesn't call the model; model failure → run failed with entries in output.

### Task 9: Home chip and voice intent
- `app/public/home.js` `MODES`: add `['history', 'Ask history', …]`; sending in that mode posts to `/api/journal/ask`
  and opens `#run/<id>`. Run view shows citations as links under the answer (`app/public/run-bodies.js`).
- `app/voice.js`: `HISTORY` pattern before `CURRENT`; voice handler routes `history` to `askHistory`.
- Tests: `tests/voice.test.cjs` cases ("what did I print yesterday" → history, "when did I last watch Severance" →
  history, "latest news" → current, "what's the weather yesterday" → weather); browser test in `history-ui.mjs`.
  Open PR 3: **"Ask history: what did I…? answered from your own record, by voice too"**.

## PR 4 — Finding things

### Task 10: ⌘K hits and History tab
- `app/public/app.js` `commandPalette`: after 2 chars, debounce 150 ms, `GET /api/journal?q=…&limit=5`; rows below pages,
  plus "Search history for '…'" → `#history?q=…`.
- `view-registry.js`: `{id:'history', parent:'projects', tab:'History', label:'History', …}`; `index.html` section;
  `app/public/history.js`: day groups, search, source chips, Delete through the approval sheet, state helper.
- Tests: `tests/history-ui.mjs` (list, search, filter, delete, palette hits), axe on `#history`; update the deploy
  validator only if it lists view ids. Open PR 4: **"History: search everything Local AI remembers, from ⌘K or Projects"**.

## PR 5 — Evening recap

### Task 11: Recap job, Home card, push, morning brief
- `app/journal-recap.js`: `createRecap({ journal, chatOnce, notifier, busy, now, timeZone })` → `tick()` every minute;
  at ≥ 21:00 local and no recap for today: busy → retry in 15 min until 23:59; model fails → counts sentence; save
  `source:'recap'`, ref `recap:<day>`; push only if ≥ 3 entries that day (notifier respects quiet hours).
- Setting `journal-recap` `{enabled:true, at:'21:00'}`; `apiMorningBrief` adds `yesterday`; Home shows the recap card
  until 10:00 next day.
- Tests: fake clock/model/busy; each branch above. Open PR 5: **"Evening recap: your day in a few lines at 9 pm"**.

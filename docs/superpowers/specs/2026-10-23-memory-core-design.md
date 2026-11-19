# Memory core — design

Date: 2026-10-23 · Status: approved in conversation, spec for review
Roadmap: `2026-10-23-localai-next-roadmap-design.md`, project A.

> **Governing verdict:** Pi Hub amendment A28 (`pi-hub/docs/superpowers/specs/2026-11-19-amendment-a28-memory-core.md`,
> merged) decides what of this spec is built, and wins where they differ: no print, watch or materials recorders (D2),
> house questions read from Pi Hub at ask time (D3), the composer mode is **Past work** (D4), stored text held to D5,
> no History tab (D6) and no evening recap (D7).

## Intent

**Outcome:** Local AI remembers what happens (work, chats, prints, films, spools, voice asks, approvals, releases)
in one durable journal, and answers "what / when did I…" questions from it with links back to the source.

**Success looks like:**
- "When did I last print something, and did it work?" and "what did I watch on Saturday?" get right answers,
  in the composer and by voice.
- ⌘K finds a chat, image prompt or mission by its words, not only pages.
- At 9 pm one notification sums up the day; the morning brief starts with a "Yesterday" line.
- Nothing ages out of the journal; any entry can be deleted.

**Not goals (this project):** embeddings or a vector store (revisit only if FTS misses in practice); a new
top-level page; recording health-check passes, weather or watchdog noise; the print file name (the display's
status feed doesn't carry it; project C adds it).

## What exists today

- The run ledger (`app/run-ledger.js`) keeps the newest 250 runs (pinned or filed runs are kept), and calls
  `onTransition(run, previousStatus)` after every status change. Most other stores are capped at 250–1000 items.
- The watchdog (`app/watchdog.js`) polls the printer through the Workshop display and already tracks
  `printing → ended` transitions; the printer summary has state, progress, minutes left and error code, no file name.
- The Pi hub client (`app/pi-hub.js`) reads Plex's "now playing" on demand for the display; nothing is kept.
- The materials client (`app/materials.js`) has inventory counts (spools, loaded, low), no per-spool events.
- The voice router (`app/voice.js`) is rules-only; its `CURRENT` pattern catches "yesterday" / "last week".
- The Home composer has mode chips (`app/public/home.js`); the ⌘K palette (`app/public/app.js`) searches the
  view registry only. The morning brief (`apiMorningBrief`) returns health, 8 notifications and 8 activities.
- Node's built-in SQLite in the appliance container (Node 22.23) supports FTS5 (checked 2026-10-23).

## Design

### 1. The journal (`app/journal.js`)

One module owns two tables in the existing database:

```sql
CREATE TABLE IF NOT EXISTS journal (
  seq     INTEGER PRIMARY KEY,           -- FTS rowid
  id      TEXT NOT NULL UNIQUE,          -- 'j-…', sorts by time
  at      TEXT NOT NULL,                 -- ISO time the thing happened
  day     TEXT NOT NULL,                 -- local YYYY-MM-DD (appliance TZ)
  source  TEXT NOT NULL,                 -- run | print | watch | materials | voice | approval | release | recap
  kind    TEXT NOT NULL,                 -- e.g. chat, image, mission, printed, failed, watched, low-spool
  title   TEXT NOT NULL,                 -- ≤ 200 chars
  body    TEXT NOT NULL DEFAULT '',      -- ≤ 4000 chars, redacted
  link    TEXT,                          -- in-app route, e.g. '#/run/run-…'
  ref     TEXT NOT NULL UNIQUE,          -- idempotency key, e.g. 'run:run-…:completed'
  meta    TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(meta))
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(
  title, body, content='journal', content_rowid='seq', tokenize='porter unicode61 remove_diacritics 2');
-- plus insert/delete triggers keeping journal_fts in step, and indexes on (day), (source, at)
```

- Tables are created with `IF NOT EXISTS` and **do not bump `SCHEMA_VERSION`**, so Safe Deploy's automatic rollback
  to an older release still opens the database (an older app ignores the extra tables).
- `record({at, source, kind, title, body, link, ref, meta})` is synchronous, ignores a repeated `ref`, and never
  throws to its caller (a failure is logged once per minute at most). Text is cut to size and redacted
  (§6) before it is stored.
- **Delete** removes the row and its FTS entry and keeps the `ref` in a small `journal_deleted(ref)` table, so an
  import or recorder never brings it back.
- `search({q, from, to, sources, limit, before})` → entries ranked by `bm25` with a recency boost, `before` as a
  cursor. Without `q` it lists by time (the History tab). Query text is turned into safe FTS terms (words only,
  prefix match on the last word); it never passes raw FTS syntax through.
- Date words in a question ("today", "yesterday", "last week", "Saturday", "in October", "this month") become
  `from`/`to` in the appliance's time zone; the words are then dropped from the search terms.

### 2. Recorders

Each is a few lines at a point where the event is already known:

| Source | Where | Entry |
|---|---|---|
| run | `RunLedger` `onTransition`, on a terminal status | kind = run kind; title = the ask; body = start of the result (answer text, image prompt, mission outcome, diff stat); status in `meta`; link to the run. Chat turns and GridCraft requests are runs, so they come through here |
| print | watchdog tick, printer state transitions | "Print started" is kept in `meta` only; one entry when it ends: printed / cancelled / failed (+ error code), duration, start and end time |
| watch | new 1-minute tick reading the Pi hub (its cache, so no extra load) | one entry per title + device session, written when it leaves "now playing": "Watched *X* on *device*" with finished (≥ 90%) or "stopped at N%", who |
| materials | same tick, materials summary | only when the low-spool count rises or the loaded count changes |
| voice | the Ask Local AI handler | question and the spoken answer |
| approval | approval decide (app, phone, display) | what was approved or rejected, where |
| release | start-up, when `release.json`'s commit differs from the last one recorded | "Local AI updated to 2.0.N" with the PR titles as body |

PowerShell jobs are recorded as runs **by title only** (no command or output).

### 3. One-time import

On first start with the journal, a background pass (setting `journal-import-v1`, resumable) imports the run ledger,
conversations and their messages (one entry per question/answer pair), Library artifacts, missions, approvals,
shipped changes and the activity log, each with a stable `ref` so a repeat import adds nothing. It yields between
batches of 200 so the server stays responsive.

### 4. Ask history

- `POST /api/journal/ask {question}` starts a run (kind `prompt`, `meta.mode = 'history'`), so it appears in Work and
  opens in the run view like any chat.
- Retrieval: date words → window; search terms → up to 12 entries; if the terms find nothing but there is a date
  window, the newest 30 entries of that window. **If nothing is retrieved, the answer is "I don't have anything about
  that" and no model is called.**
- The default local chat model gets the entries, numbered, with date and source, and is told to answer only from
  them and to cite them as [n]. Citations come back as links to the entries' sources. Uncited claims are not
  stripped (a small model can't be forced), but the entries are always shown under the answer.
- **Home:** a new mode chip, **Ask history**, in the composer's mode sheet.
- **Voice:** a `history` intent in `app/voice.js`, checked before `CURRENT`, for first-person past questions
  ("what did I…", "when did I…", "did my print…", "how long did…", "my last print"). The spoken answer is the first
  two sentences, as for every voice answer.

### 5. Finding things

- **⌘K palette:** after two characters it shows, below the page matches, up to 5 journal hits (debounced, 150 ms)
  and a "Search history for '…'" row that opens the History tab with the query.
- **History tab** under Projects (registry id `history`, parent `projects`): days newest first, each entry with time,
  source icon, title, a line of body, and its link; a search box, source filter chips, and Delete on each entry
  through the shared approval sheet. Empty, loading and error states use the shared state helper.
- API: `GET /api/journal?q=&from=&to=&source=&limit=&before=`, `DELETE /api/journal/:id`.

### 6. Privacy and redaction

- Before storing: long hex strings (`[0-9a-f]{40,}`), bearer tokens, `key=`/`token=`/`password=` values and private
  key blocks are replaced with `[redacted]`. Approval-key and display-key contents never reach a recorder.
- The journal lives in the appliance database, so it is covered by the existing database backups (local, and the
  OneDrive copy that already holds chats). No new place receives it, and no model outside the PC reads it.

### 7. Evening recap and the morning brief

- At 21:00 local (setting, default on), the recap job takes the day's entries and asks the local chat model for 3–5
  plain sentences: what was made, printed, watched, what failed, what still needs the owner. It is saved as a
  journal entry (`source: recap`), shown as a card on Home until the next morning, and sent as one push through the
  notifier (quiet hours respected).
- If `/api/busy` says the PC is busy it retries every 15 minutes until midnight; if the model can't run, the recap is
  built from counts without a model ("3 chats, 1 print (finished), 2 films").
- A day with fewer than 3 entries gets no push, only the Home card.
- `apiMorningBrief` gains `yesterday: {text, link}` from the previous day's recap.

## Error handling

- Recorders never throw into the code that calls them; a failing recorder can't break a run, a print poll or voice.
- The import is resumable and idempotent; a crash mid-import continues next start.
- Search with bad input returns an empty list, never a SQL error; FTS syntax is never exposed.
- Ask: model timeout or failure ends the run as failed with the retrieved entries still shown.

## Testing

- `tests/journal.test.cjs`: record + idempotent `ref`, delete tombstone survives re-import, FTS search and ranking,
  date-word windows (with a fixed clock and time zone), redaction cases, no raw FTS syntax.
- Recorder tests with fakes: print transitions (finished / cancelled / failed / display offline mid-print), Pi hub
  sessions (finish, stop at 40%, two devices), materials diffs, release change.
- `tests/voice.test.cjs`: `history` intent cases, and that "latest news" stays `current`.
- Ask: fake model; citations map to entries; empty retrieval calls no model.
- Recap: fake clock and model; busy retry; no-model fallback; quiet hours; < 3 entries → no push.
- Browser: `history-ui.mjs` (History tab, search, delete, palette hits, Ask history chip), axe on the new tab.

## Delivery (5 PRs, in order)

1. Journal module, FTS, run recorder, one-time import, `GET`/`DELETE /api/journal`.
2. Print, watch, materials, voice, approval and release recorders.
3. Ask history: API, Home mode chip, voice intent.
4. ⌘K journal hits and the History tab.
5. Evening recap, Home card, push, morning brief "Yesterday".

Each PR: `npm test`, browser suites on a fresh server, local CI green, then merge; `/healthz` confirms the deploy.

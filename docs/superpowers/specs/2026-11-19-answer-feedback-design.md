# Answer feedback: design

Date: 2026-11-19 · Status: **proposed** (approved when the owner merges this PR; nothing is built before that)
Governed by: platform amendment A28 (`pi-hub/docs/superpowers/specs/2026-11-19-amendment-a28-memory-core.md`), which
lists this under "Not decided here" and holds it to D5.

## Intent

**Outcome:** the owner can say whether an answer was good, and that verdict is kept with what was asked, which model
answered and how it was routed. Today nothing records whether an answer helped, so nothing can be compared or tuned.

**Success looks like:** after a few weeks, Models shows "On this PC: 41 good, 9 not; Groq: 12 good, 1 not", and each
"not" opens the run it came from.

**Not goals:** changing routing, prompts or models automatically from feedback (this PR only records and shows);
feedback text reaching any model; ratings on images, missions or changes (answers only, first); a new page.

## What exists

- Answers are runs (`chat`, `research`, and the `prompt` run Past work adds). The run view draws the answer and, under
  it, where it came from: "Answered on this PC" or "Answered by … · Groq", with the reason (`RB.routeText`,
  `app/public/run-bodies.js`; `run.meta.privacy`).
- The run ledger keeps the newest 250 runs (pinned or filed ones are kept), so a verdict stored only on the run is
  lost with it.
- The journal (`app/journal.js`) is durable, but an entry is written once per `ref` and never updated, and A28 D1
  scopes it to what the owner asked and what the Assistant did.
- Voice answers are runs too; there is no screen to rate them on.

## Design

### 1. The control

Under an answer, on the same line as where it came from: two buttons, **Good answer** and **Not right** (thumb icons
with those accessible names, `aria-pressed`). One can be on; pressing it again clears it. After **Not right**, an
optional one-line "What was wrong?" field (≤ 300 characters) with Save; skipping it keeps the verdict.

- Shown on completed `chat`, `research` and Past work runs. Not on failed or cancelled runs, images, missions or
  changes.
- Keyboard reachable in reading order after the answer; visible focus; the saved state is announced through the
  shared `announce` helper (`app/public/components.js`); no motion.
- States: saving (button busy), saved, and failed to save ("Couldn't save that. Try again", the button returns to its
  earlier state; a failed save is never shown as saved).

### 2. The store

A table of its own in the appliance database, created `IF NOT EXISTS` with no `SCHEMA_VERSION` bump (the journal's
rule, so Safe Deploy's rollback still opens the database):

```sql
CREATE TABLE IF NOT EXISTS answer_feedback (
  run_id   TEXT PRIMARY KEY,
  verdict  TEXT NOT NULL CHECK(verdict IN ('good','bad')),
  note     TEXT NOT NULL DEFAULT '',     -- ≤ 300 chars, redacted like journal text
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL,                -- chat | research | prompt
  provider TEXT NOT NULL,                -- ollama | groq | cerebras
  model    TEXT NOT NULL,
  class    TEXT NOT NULL,                -- private | shareable
  asked    TEXT NOT NULL                 -- the question, ≤ 200 chars, redacted
) STRICT;
```

It is one row per run, updated in place when the verdict changes and deleted when it is cleared, which the journal
can't do. The row copies the model, provider, class and question at the time of the verdict, so it outlives the run
when the ledger drops it. It is covered by the existing database backups and goes nowhere else.

### 3. API

- `POST /api/runs/feedback {id, verdict: 'good'|'bad'|null, note?}` → `{feedback}`. 404 for an unknown run, 409 for
  a run that isn't a completed answer. In `app/signin.js`'s list of owner-only mutations.
- `GET /api/runs/feedback/summary` → counts by provider and model for the last 30 and 90 days, and the newest 20
  "bad" rows with their run links.
- A run's card carries its verdict, so the run view and Work can show it without another request.

### 4. Where it is shown

Models, under the routing table: "How answers have landed", a small table by model (good, not right, share), then
"Recent answers marked not right" with the question, the note and a link to the run (or "this run is no longer kept"
when the ledger dropped it). Empty state: "No answers rated yet. Use the buttons under an answer." Loading and error
states use the shared state helper; a failed read says so and never shows zeros.

### 5. Privacy (A28 D5)

Feedback is not sent to any model. The summary is counts. If a later design feeds verdicts or notes into a prompt, it
needs its own spec and D5's four rules.

## Decisions for the owner

- **D1 A table, not journal entries.** Your list said "stored in the journal". Recommended: its own table, because a
  verdict changes and the journal is write-once, and A28 D1 keeps the journal to the Assistant's work. The table lives
  in the same database beside it. If you want it findable in ⌘K later, a journal entry can point at the row.
- **D2 Voice.** Recommended: not in this PR. Later, "that was wrong" as a voice follow-up could mark the last answer.
- **D3 Where the summary sits.** Recommended: Models (it is about which model answers well). Alternative: Improve ›
  Signals, where a run of "not right" on one model could raise a signal.

## Testing

- Unit: set, change, clear; the row survives the run leaving the ledger; redaction of note and question; summary
  counts by window; a database error is an error response, not an empty summary.
- API: 404, 409, sign-in gate; verdict on the run card.
- Browser: `answer-feedback-ui.mjs` (press, change, clear, note, failed save, keyboard only), the Models section in
  its empty, loaded and failed states, axe on both.

## Delivery

One PR. Title: "Tell Local AI when an answer was good or not right".

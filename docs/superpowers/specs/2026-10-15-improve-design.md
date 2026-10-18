# Improve: one pipeline for changing Local AI (roadmap sub-project 4)

Date: 2026-10-15 · Status: design approved in conversation, spec for review
Roadmap: `docs/superpowers/specs/2026-10-15-localai-evolution-design.md` ("Improve: one pipeline").
Depends on: sub-project 1 (run card, run view, approval sheet, state helper) and sub-project 2 (five pages; the
Improve domain and its routes).

## Intent

**For:** the owner, mostly on the phone.

**Outcome:** one place to see and steer everything that could change Local AI. Open Improve, see one short ranked
backlog, decide what happens to each item, and see what is in flight and what shipped, without checking four pages
(Change requests, Issues, Quality signals, Claude Code).

**Decided by the owner (2026-10-15):**
- The composer's "Change Local AI" mode offers **Add to backlog** or **Start now** each time.
- Serious Signals reach the Backlog on their own (high severity, or seen 3 or more times); the rest wait in Signals.
- Ranking is today's score plus **Move to top**.
- The Claude board's findings become the Backlog (no new table, no migration of the board).

**Unchanged:** `GET /api/claude/priorities` response shape; how Claude sessions post events and findings; how change
requests are planned, tested, approved and applied; Local AI never starts a Claude session ("Hand to Claude" is
passive).

## Data and stages

A **backlog item** is a Claude board finding (`storage` setting under `CLAUDE_FINDING_PREFIX`), with new optional fields:

| Field | Meaning |
|---|---|
| `source` | `claude` \| `signal` \| `idea`. Missing = `claude`. |
| `signalId` | The Signal (issue) it came from. |
| `changeId` | Its current or last change request. |
| `handedToClaude`, `handedAt` | Set by Hand to Claude. |
| `shipped` | `{ version, commit, at, pending }`, set when its change is applied; `pending` until the next start. |

The **stage** is derived, never stored:

| Stage | Rule (first match wins) |
|---|---|
| Shipped | status `fixed` |
| Set aside (filter, not a tab) | status `deferred` or `rejected` |
| In progress | status `in_progress`, or `handedToClaude` (since 2026-10-18: handed items are Claude's to do), or `changeId` points to a change in `planned`, `patch_failed`, `validation_failed`, `staged`, `awaiting_approval`, `approved`, `apply_requested` |
| Backlog | everything else (`proposed`, `approved`) |

**Signals** are today's Issues store (`ISSUES_STORE`) with its deduplication and auto-resolve kept.
- **Auto-promote:** after each scan saves, every open Signal with `severity === 'high'` or `occurrences >= 3` that has no
  item gets one: id `signal-<issueId>`, `source:'signal'`, `status:'proposed'`, severity copied. Exactly one item per Signal.
- **Promote** (manual) creates the same item for any Signal. **Dismiss** sets the Signal to `ignored` (today's behaviour:
  it does not come back).
- When a Signal auto-resolves and its item is still in Backlog, the item becomes `fixed` with
  `decisionNote: 'Resolved on its own'`.

**Ideas:** **Add to backlog** creates `source:'idea'`, `status:'approved'`, title from the text (first line, 120 chars),
summary the full text. **Start now** creates the item and its change request together (see Flows).

**Ranking:** today's `claudeScore` (severity weight + 6 × net votes + status boost + `priorityBoost`).
- **Move to top:** sets `priorityBoost` so the item's score is 1 above the current highest open score.
- **Hand to Claude:** status `approved`, `handedToClaude:true`, `priorityBoost += 30`,
  `decisionNote: 'Handed to Claude'` (appended if a note exists).
- `/api/claude/priorities` keeps its fields and filter; it now also lists open `signal` and `idea` items, so handed items
  reach sessions first.

## The Improve page

Four registry pages in the `improve` domain, shown as the shell's underline tabs, built only from sub-project 1's
components:

- **Backlog** (`backlog`, the domain default): ranked `list-row` items with source icon, title, severity badge, up/down
  votes, and a "Handed to Claude" badge. Tapping opens an item sheet: summary, fix, file, notes; actions **Start**,
  **Hand to Claude**, **Move to top**, **Defer**, **Reject**. Header action **+ New idea** (text, then Add to backlog /
  Start now).
- **In progress** (`inProgress`): change requests as run cards (tap → run view with plan, tests, diff and the approval
  bar; Approve/Deploy through the approval sheet's typed confirmation), and items a Claude session is working, showing
  that session's live status from board events (tap → the Claude chat panel as its run view).
- **Shipped** (`shipped`): items grouped by release (version, date), each with its PR link or "Resolved on its own".
- **Signals** (`signals`): severity, occurrences, last seen; **Promote** / **Dismiss**. Header action **Run checks now**.
  Full scan details and the browser error log under a collapsed "Details".

**Old addresses:** `ALIASES` map `changes` and `claude` → `inProgress`, `issues` and `quality` → `signals`. Element ids the
deploy validator and tests check keep existing.

**Home "Needs you"** lists, from Improve, only change requests awaiting approval and newly auto-promoted Signals; the
"N change requests are unfinished" row goes (they are visible in In progress).

## Flows

1. **Start:** POST the item's title, summary and fix to `/api/changes/plan` (target `self`); set `changeId`; the item is
   In progress.
2. **Applied:** when a linked change reaches `applied`, the item becomes `fixed` with `shipped.pending:true`. On server
   start, pending items get `shipped.version/commit` from the release record (`readRelease()` / `appVersion()` in `app/release.js`), since every deploy restarts.
3. **Failed:** the item stays In progress with a "Needs a look" badge; **Retry** (re-plan) or **Back to backlog**
   (clears `changeId`, status `approved`). **Discard** on a running change rejects it and asks Back to backlog or Set aside.
4. **Claude:** sessions keep posting `in_progress` and `fixed` (with `pr`) through `/api/claude/findings` or `/decision`;
   the stage follows.
5. **Signals:** promotion and resolve-handling run right after `detectIssues` saves.
6. **Existing change requests:** on first start, each change in an unfinished state with no linked item gets one
   (`source:'idea'`, status `in_progress`, title from the change summary), so the current 11 appear in In progress.

## Errors

- Every list uses `LocalAIUI.loadInto`; a failed load shows Retry, never an empty list.
- Each action reports failure inline and leaves the item where it was.
- Promotion and the first-start linking are idempotent (one item per Signal or change) and run in `storage.transaction`.
- Items without the new fields read as `source:'claude'` with no links; `/api/claude/priorities` output is unchanged for them.

## Code shape

- `app/improve.js` (new, pure): `stageOf(item, changesById)`, `shouldPromote(signal)`, `promoteSignal(signal)`,
  `ideaItem(text)`, `moveToTopBoost(item, openItems)`, `handToClaude(item)`.
- `app/server.js`: Improve routes (`/api/improve/items`, `/api/improve/idea`, `/api/improve/start`,
  `/api/improve/signal`), the call after `detectIssues`, the hook where a change is applied, and the start-up step.
- Client: the four pages in `view-registry.js` / `index.html`, rendered with `components.js`.

## Testing

- **Unit** (`tests/improve.test.cjs`): `stageOf` for every status and link combination; promotion (high, count 3,
  once only); Move to top; Hand to Claude ordering.
- **API:** idea via Add to backlog and Start now; Start links a change; applied → Shipped, and a restart records the
  release; first-start linking of old changes; `/api/claude/priorities` field list snapshot; existing
  `claude-board-api` tests pass.
- **Browser:** the four tabs; item sheet actions; New idea's two buttons; Promote/Dismiss; `#changes`, `#issues`,
  `#quality`, `#claude` land on the right tab; axe `color-contrast` and `target-size` on each tab.

## Out of scope

Splitting `server.js` (`prod-modularize`); Projects and System (sub-projects 3, 5); any way for Local AI to start Claude
sessions; new engines or run kinds.

# LocalAI evolution — roadmap design

Date: 2026-10-15 · Status: approved in conversation, spec for review
Type: roadmap. Each sub-project below gets its own spec → plan → implementation cycle.

## Intent

**Who it is for:** one person — the owner. No other users are planned.

**Outcome:** LocalAI feels like one coherent, polished app the owner reaches for daily, not a collection of tools.
Every existing capability is used, so nothing is removed; the structure is redefined around how the owner works.

**Success looks like:**
- Starting anything (chat, image, mission, automation, change to LocalAI) begins in one place.
- Everything in progress or waiting on the owner is visible in one place, and the phone says when something needs them.
- Finished work can be found again and filed with related work.
- Fewer pages, each built from a small set of shared, polished components.

**Not goals:** multi-user features (accounts, roles, packaging for others), new engines or run kinds, analytics
dashboards.

## Diagnosis

The current shape mirrors how features were built: 5 domains and 26 views in `app/public/view-registry.js`,
with overlaps — Monitors vs Automations (scheduled work), Runs vs Audit log (history), Library vs Projects (kept work),
and four homes for "what should change in LocalAI" (Change requests, Issues, Quality signals, Claude Code).

Nearly every feature has the same shape: **ask → work runs → result to review or keep.** The backend already models
this: `app/run-ledger.js` records every kind of work (prompt, image, agent, automation, engineering, research, action,
quality-check, …) with status (including `awaiting_approval`), progress, events, output, artifacts, cancel and retry.

## Direction: one composer, one timeline

Considered: (A) one composer + one timeline, (B) polish the existing pages in place, (C) everything inside a Project.
**Chosen: A.** It matches how a single user thinks ("I want X"), removes the duplicates, and concentrates polish in a
handful of shared components instead of 26 pages. B keeps 20+ pages to maintain; C forces a project choice on quick asks.

## Page map

| Page | Holds | Absorbs |
|---|---|---|
| **Home** | Composer ("What should we do?") with a mode chip; **Needs you** (approvals, pending changes, failures); **Recent work** | Home, Inbox, Approvals |
| **Work** | One timeline of every run, filterable by kind and status; each run opens into its run view | Runs, Missions list, Automations, Monitors, Browser & computer history |
| **Projects** | Kept work per project: runs, results, sources, memory; plus an "Everything" view | Projects, Library, Sources, Memory |
| **Improve** | One pipeline for changing LocalAI (see below) | Change requests, Issues, Quality signals, Claude Code |
| **System** | Health, Models, Integrations, Audit log, and a **Tools** shelf: Files, Repository, PowerShell, n8n editor, GridCraft | Health, Models, Integrations, Audit log, Files, Repository, PowerShell, n8n workflows |

- **Composer modes:** Chat · Image · Mission · Automate · Change LocalAI. Each mode keeps its existing options (model,
  image engine, specialists, schedule) in a compact options tray.
- **Specialist surfaces keep their richness:** the image editor, Agent World / mission canvas, GridCraft and the Claude
  chat panel mount as the **run view** for their run kind.
- **Phone tab bar:** Home · Work · Projects · Improve · System — the phone-redesign shell, relabeled.

## Runs as the core object

Additions to the run ledger (all additive):

1. **`projectId`** — a run can be filed into a project; unfiled runs appear under "Everything".
2. **`threadId`** — follow-up runs (chat turns, "now make it blue") share a thread; the timeline shows a thread once,
   with its latest state.
3. **Kept runs are never pruned.** Today the ledger keeps the newest 250 runs. Runs that are pinned, filed in a project,
   or have artifacts are exempt; only unfiled, unpinned runs without artifacts age out.
4. **Card contract per run kind:** one-line summary, result preview (text snippet, thumbnail, mission outcome, diff
   stat), approval prompt when `awaiting_approval`, and which run view opens it.

Shared front-end components, built once in the phone-redesign design language:

- **Run card:** kind icon, title, status badge, progress, preview, one primary action (Review / Approve / Open / Retry).
- **Run view:** header (title, status, project, actions); live event log; a kind-specific body slot; an approval bar.
- **Approval sheet:** replaces the ~10 native `confirm()`/`prompt()` calls; names the exact effect; typed confirmation
  for host-level actions. Closes board item `ux-native-confirm`.
- **Load / empty / error helper:** used by every list, so a failed load never looks empty. Closes board item
  `ui-swallowed-errors`.

How each engine executes (Ollama, ComfyUI, n8n, agents, PowerShell bridge) does not change.

## Improve: one pipeline

| Stage | Contents | Fed by |
|---|---|---|
| **Signals** | Raw detections, deduplicated | Quality checks, browser errors, failed runs |
| **Backlog** | One ranked list: issues, Claude findings and the owner's ideas, same card and up/down/rank controls | Promoted signals, `POST /api/claude/findings`, composer "Change LocalAI" |
| **In progress** | Change requests being planned/tested, and Claude sessions working an item (live via the progress hook) | Backlog → "Start" (local engineering agent) or "Hand to Claude" |
| **Shipped** | Approved and deployed, with the release commit from `/healthz` | Safe Deploy |

- The backlog is the single source of truth for ranking; `GET /api/claude/priorities` reads from it with its current
  response shape unchanged.
- The Claude chat panel is the run view for a Claude session.
- Merge and deploy approvals use the shared approval sheet.
- **"Hand to Claude" is passive:** it marks the item and exposes it through the priorities API. No headless Claude
  runner is started from LocalAI (an earlier explicit decision).

## New functionality

1. **Notifications** — phone notification when a run finishes, fails or waits for approval. Web push from the PWA
   (VAPID signing and payload encryption with Node's built-in `crypto`); ntfy over plain HTTP as the fallback if web push
   proves too costly. Covers most of board item `prod-monitoring`'s alerting.
2. **Search across work** — the ⌘K palette also finds content: chat text, image prompts, mission outcomes, change
   titles. SQLite FTS; no new service.
3. **Repeat / schedule any run** — any finished run offers "Repeat…" (daily, weekly, on a trigger). Existing scheduled
   automations and the morning brief are carried over, after which the separate Automations and Monitors pages retire.
4. **Composer auto mode** — the local model picks the mode from free text. Built last, after living with explicit mode
   chips; a wrong guess must be one tap to correct.

## Sub-projects and order

| # | Sub-project | Depends on | Notes |
|---|---|---|---|
| 0 | **Phone redesign: shell only** (its plan's Task 2) | — | Stop the phone-redesign plan after Task 2. Tasks 3–6 restyle pages this roadmap merges; Task 7 happens as new pages land. |
| 1 | **Run model + shared components** | 0 | Ledger additions, card contract, run card, run view shell, approval sheet, state helper. |
| 2 | **Navigation, Home and Work** | 1 | 5-page map, composer with mode chips, Needs you, timeline; Chat, Images, Missions and GridCraft mount as run views. |
| 3 | **Projects** | 1, 2 | Merge Library, Sources, Memory; file runs into projects. |
| 4 | **Improve** | 1, 2 | Merged pipeline; Claude board API contract unchanged. |
| 5 | **System and Tools** | 2 | Mostly relocation. |
| 6 | **Notifications** | 1 | Can run in parallel with 3–5. |
| 7 | **Search across work** | 1, 3 | |
| 8 | **Repeat / schedule any run** | 2 | Carries over existing automations and the morning brief, then retires Automations and Monitors. |
| 9 | **Composer auto mode** | 2 | Last. |

Compatible but outside this roadmap: HTTPS on a local name (shipped in #83) and splitting `app/server.js` into modules
(board `prod-modularize`). Whether to split the server first is decided at the start of sub-project 1, based on how
much of `server.js` it must touch.

## Rules for every sub-project

1. **One design language** — phone-redesign tokens, self-hosted Figtree, the icon sprite and its components.
2. **Old URLs and view ids keep working** through `ALIASES` in `view-registry.js`, indefinitely — bookmarks, the PWA,
   notification deep links and the Claude board depend on them.
3. **Tests move with the pages** — browser tests are updated in the same PR, and axe-core checks (dev dependency) are
   added for each new page, gradually covering board item `prod-a11y`.
4. **No new runtime npm dependencies** — the server stays on Node built-ins.
5. **Main is always fully usable** — no half-migrated state; when a page moves, its old entry point redirects in the
   same PR. Main auto-deploys within about 5 minutes of merge.

Each sub-project ships through PR → CI green → merge → Safe Deploy, confirmed by `/healthz` `releaseCommit`.

## Board items this roadmap closes

`ux-native-confirm` (1), `ui-swallowed-errors` (1), `ux-inbox-noise` (2: Needs you lists real pending work; info notices
don't drive the badge), `a11y-view-change` (2: page changes set the title and move focus; palette and drawer become real
dialogs), most of `prod-monitoring` alerting (6), and `prod-a11y` progressively (rule 3).

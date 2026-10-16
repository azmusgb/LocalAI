# Web Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish what the 16 October critique found: every page a home user can reach reads in plain words, shows
only true and current information, and behaves the same on desktop and phone. Developer pages are clearly marked
or hidden. Old records are repaired where the data allows, and removed where it doesn't (owner's call).

**Architecture:** Small, independent PRs. Each fixes one page or one concern, carries a test that failed first,
passes local CI, and merges on green. No new dependencies, no new pages. Copy changes go through the registry
labels where one exists. Data repairs are one-time, idempotent start-up passes keyed in settings
(`repair:<name>-v1`), following `repairRunTextOnce()`.

**Tech Stack:** Node 22.13+ built-ins, `node:sqlite` via `app/storage.js`, vanilla JS/CSS, `node --test`,
Playwright, vendored axe-core.

**Spec:** `docs/superpowers/specs/2026-10-16-web-critique.md`. Section numbers below (§3.1 …) refer to it.

## Global Constraints

- Element ids, routes and function names checked by `deploy/Test-LocalAI-Candidate.ps1` and the Playwright tests
  stay; a test that pins old copy moves with the copy in the same PR.
- CSS is appended at the end of `app/public/app.css` in a commented block; nothing above is edited (#202 owns the
  cascade clean-up).
- Phone means `@media(max-width:760px)` with `body.ux-v3`, as the existing header rules use.
- Every PR: `npm test`, the affected `tests/*-ui.mjs`, then `npm run ci -- <PR>`; merge only on a green `local-ci`.
  Update a visual baseline only after looking at the new image.
- Copy rules: say what a thing does for the owner; no "capability", "runtime", "orchestration", "durable",
  "index" as a verb, raw ids, raw paths, or JSON on a first screen. Version strings come from `/healthz`, never
  typed.
- Owner decisions D1–D5 gate Tasks 9–11 only; Tasks 1–8 need none.

## Order and sizing

| Task | Scope | Size | Needs |
|---|---|---|---|
| 1 | Phone header pills; Files icons | S | – |
| 2 | Health copy and deploy-check caption | S | – |
| 3 | Projects empty state and grammar | S | – |
| 4 | Claude Code chips and Activity rows | S | – |
| 5 | PowerShell and Monitors wording | S | – |
| 6 | Models: names, labels, dates | M | – |
| 7 | Browser & computer for people | M | – |
| 8 | Data repair: image summaries; Work page size on phone | M | – |
| 9 | Developer pages behind the switch | M | D1 |
| 10 | Delete unrecoverable runs; retire legacy pages | S/M | D2, D4 |
| 11 | Branch protection on `local-ci`; local CI retry report | S | D3 |

Tasks 1–5 are one short session; 6–8 another; 9–11 after the owner answers.

---

### Task 1: Phone header pills and Files icons (§3.2 6, 12)

**Files:** `app/public/app.css` (append), `app/public/app.js` (`renderTree`), `tests/mobile-ui.mjs` (new check),
`tests/workbench-ui.mjs` or the suite that covers Files (new check).

**Steps:**
1. Test first: at 390 px open Inbox, Approvals, Files, Models, PowerShell, Browser & computer; assert no
   `.topbar > .pill` is visible and nothing sits between the app header and the page tabs. Run; it fails.
2. Append `@media(max-width:760px){body.ux-v3 .view>.topbar>.pill{display:none}}` with a comment: the title moved
   into the header, the bell already counts unread, the rest is fine print the page repeats.
3. Test first: a tree with `notes.md`, `photo.png`, `wheel.whl`, `archive.zip`; assert only `notes.md` gets the
   `compose` (pencil) icon, the others `sources`. Run; it fails.
4. In `renderTree`, choose the icon by a `TEXT_FILE` extension list (text, code, data, config); everything else is a
   plain file icon. Placeholder for the workspace field: "Folder to open (projects or repos)".
5. Run mobile, layout, visual, tap-targets, a11y-sweep; `npm test`; local CI; merge on green.

**Acceptance:** phone pages start with their tabs; Files shows a pencil only on files it can edit.

### Task 2: Health copy (§3.2 8)

**Files:** `app/public/index.html` (`#status` topbar, Capabilities card, deploy-check caption), `tests/visual`
baselines `status-*`.

**Steps:**
1. Subtitle: "How Local AI and its helpers are doing right now." Capabilities card subtitle: "The services Local AI
   runs on. The optional ones can be off without stopping it." Deploy-check caption: "Checked on every update; a
   release that fails its checks is rolled back."
2. A `tests/system-lists-ui.mjs` check asserts the three strings and that no "capability" appears in `#status`.
3. Update the two Health baselines after viewing; run layout, notifications, first-run; local CI; merge.

### Task 3: Projects (§3.2 9)

**Files:** `app/public/app.js` (projects render), `tests/projects-ui.mjs` (new or extend).

**Steps:**
1. Tests first: with one project, it is selected and its detail shown; with none, one empty state ("Create your
   first project.") and no "Select a project." pane; counts read "1 source" / "2 sources".
2. Implement: auto-select when `items.length === 1` (keep the last selection otherwise); a `plural(n, word)` helper
   next to `esc`.
3. Local CI; merge.

### Task 4: Claude Code chips and Activity (§3.2 10)

**Files:** `app/public/ui.js` (claude board section), `tests/claude-board-ui.mjs`.

**Steps:**
1. Tests first: a session titled "LocalAI-sp4 · Claude Code · 76278f59" shows as "LocalAI-sp4 · Claude Code" (the
   trailing ` · <6–12 hex>` dropped); four consecutive "New request" events collapse into "New request ×4" with the
   latest time.
2. Implement a `displayTitle()` and an event-folding step in the Activity render (same approach as Audit log's
   restart folding in `app.js`).
3. Local CI; merge.

### Task 5: PowerShell and Monitors wording (§3.2 11)

**Files:** `app/public/app.js` (`loadPowerShellJobs` empty copy), `app/public/index.html` (`#operations` copy),
`tests/system-lists-ui.mjs`.

**Steps:**
1. Tests first: PowerShell with no jobs shows "No scripts yet. Scripts you create for review appear here."; Monitors
   says "morning brief" where it said "operational brief".
2. Implement; local CI; merge.

### Task 6: Models for people (§3.2 7)

**Files:** `app/public/ui.js` (models section ~540–600), `app/public/app.css` (append), `tests/models-ui.mjs`,
`tests/visual` `models-*` baselines.

**Steps:**
1. Tests first: at 390 px the default model's full name is visible (wraps, no ellipsis); the runtime tile reads
   "Loaded now" / "Not loaded" with the model name, not "Runtime detail"; "Unload target" becomes "Unloads at" and
   uses the app's `formatWhen()` (same format as Work's "Today, 5:52 PM").
2. Implement; the `toLocaleString()` at `ui.js:191` goes through the shared formatter. Hide the runtime tile when
   developer tools are off (it is diagnostic).
3. Update models baselines after viewing; local CI; merge.

### Task 7: Browser & computer for people (§3.1 2)

**Files:** `app/public/index.html` (`#actions`), `app/public/app.js` (actions section), `app/public/app.css`
(append), `tests/actions-ui.mjs` (new), `tests/visual` (add `actions-phone`/`actions-desktop`).

**Steps:**
1. Design, in the registry's words ("Fetch pages and run approved local actions."): a first screen with two cards,
   **Fetch a web page** (URL field, "Fetch" button, result as readable text with a link to the source) and **Run an
   approved action** (a list of the allow-listed actions with a one-line description and a "Run" that goes through
   approvals). The JSON batch editor moves under a "Advanced: run a batch" disclosure, with its sample generated at
   render time (version from `/healthz`, never a literal).
2. Tests first: the first screen has no `<textarea>` visible and no "v1." literal; the URL field is empty with
   placeholder "https://"; at 390 px nothing overflows; the advanced disclosure reveals the editor.
3. Subtitle: "Fetch pages and run approved local actions. Every action waits for your OK."
4. Baselines, local CI; merge.

### Task 8: Data repair and Work page size (§3.1 3, §3.2 13)

**Files:** `app/server.js` (new `repairImageSummariesOnce()` beside `repairRunTextOnce()`), `app/run-ledger.js`
(`rewriteText` already covers summary), `app/public/work.js` (`PAGE`), `tests/self-change-ship-api.test.cjs`,
`tests/work-ui.mjs`.

**Steps:**
1. Test first: a seeded image run with summary "1 704 × 1024 image edited with Quality (X)" comes back as
   "704 × 1024 image, edited with Quality (X)"; "3 1024 × 680 images …" as "3 images, 1024 × 680, …"; a modern
   summary is unchanged; the run's dates are unchanged.
2. Implement the one-time repair with a regex on `^(\d+) (\d+ × \d+) image(s?)`; key `repair:image-summaries-v1`.
3. Test first: at 390 px Work loads 20 rows and shows "Show more"; at 1440 px, 60. Implement `PAGE` by width
   (`matchMedia('(max-width:760px)')`).
4. Local CI; merge.

### Task 9: Developer pages behind the switch (§3.1 1; needs D1)

**Files:** `app/public/view-registry.js` (a `dev:true` flag on `workbench`, `repoTools`, `powershell`, `actions`),
`app/public/ui.js` (nav builders skip `dev` views when `body.dev-tools-off`; ⌘K too), `app/public/app.css`,
`tests/navigation-ui.mjs`, `tests/search-ui.mjs`, `docs/USER-GUIDE.md`.

**Steps:**
1. Tests first: with developer tools off, System's side menu and page strip list Health, Models, Integrations,
   Automations, n8n workflows, Monitors, Claude Code, Audit log only; ⌘K doesn't offer Files; a direct `#powershell`
   still opens (deep links keep working, as Improve's do). With the switch on, all appear.
2. Implement via the registry flag, not page-specific CSS, so a future developer page gets it for free.
3. The Health switch's description: "Adds Improve and the developer tools (Files, Repository, PowerShell, Browser &
   computer)."
4. Update the user guide's Developer tools section; local CI; merge.

### Task 10: Remove what can't be repaired; retire legacy pages (needs D2, D4)

**Files:** `app/server.js` (one-time delete of the two run ids, keyed `repair:cut-titles-v1`; or an owner action),
`app/public/view-registry.js` (`ALIASES`: `issues`, `quality` → `signals`; `changes`, `runs` → `inProgress` /
`work`), `app/public/index.html` (remove the four sections), `tests/*` that reference them.

**Steps:**
1. D2 yes: delete runs whose title matches `^[a-z]{1,3} the ` **and** whose `createdAt` is before 2026-10-16 (the
   two found; the pattern is narrow on purpose); log the ids. Test with a seeded run.
2. D4 yes: alias the four ids, delete their sections and scripts, move or delete their tests; a `navigation-ui`
   check asserts `#issues` lands on Signals and `#runs` on Work.
3. Local CI; merge.

### Task 11: Guard the gate (needs D3)

**Files:** repository settings (owner), `scripts/local-ci.mjs`, `CLAUDE.md`, `docs/ADMIN-GUIDE.md`.

**Steps:**
1. Owner: Settings › Branches › `main` › require status checks to pass › `local-ci`. (Or
   `gh api -X PUT repos/azmusgb/LocalAI/branches/main/protection …`; needs admin.)
2. Local CI: when a browser suite fails, rerun that suite once; if it passes, report
   "✅ passed, 1 suite on retry: <name>" and post a PR comment naming it, so flakes are tracked rather than hidden.
   Unit tests are not retried. Test by injecting a failing suite via an env var.
3. Docs: the admin guide's local CI section gains the two rules.

---

## Done when

- Every visible page passes a copy review against the Copy rules above, at both sizes, on the appliance's real
  data, with screenshots attached to the final PR.
- `npm run ci` on `main` is green; the visual baselines match the owner's screens.
- The user guide describes the app as it is after Tasks 1–10.
- The critique's §3 has no open Important items; Moderate items are fixed or explicitly deferred by the owner.

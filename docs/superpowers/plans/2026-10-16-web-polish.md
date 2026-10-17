# Web Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the gap between the shell and the pages behind it, as the critique describes: everything the app
says is true, every action answers back, the phone keyboard and touch reach everything, the owner's menu holds
only owner pages, and one vocabulary and one component kit run through every page.

**Architecture:** Eight sub-projects, each a run of small PRs. Each PR fixes one page or one concern, carries a
test that failed first (unit for pure rules, Playwright for behaviour, visual baselines for looks), passes local
CI (`npm run ci -- <PR>`), and merges on green. No new dependencies, no new pages, no new design language: the kit
in `components.js`/`LocalAIKit` and the `--ds-*` tokens are the target; old pages move onto them rather than the
kit growing variants. Data repairs are one-time, idempotent start-up passes keyed in settings
(`repair:<name>-v1`).

**Tech Stack:** Node 22.13+ built-ins, `node:sqlite` via `app/storage.js`, vanilla JS/CSS, `node --test`,
Playwright, vendored axe-core.

**Spec:** `docs/superpowers/specs/2026-10-16-web-critique.md`. References like §3.2 point into it. Owner decisions
D1–D10 are in its §4.

## Global Constraints

- Element ids, routes and function names checked by `deploy/Test-LocalAI-Candidate.ps1` and the Playwright tests
  stay; a test that pins old copy moves with the copy in the same PR.
- CSS is appended at the end of `app/public/app.css` in commented blocks until Sub-project E consolidates; nothing
  above is edited meanwhile.
- Phone means `@media(max-width:760px)` with `body.ux-v3`; touch means `(pointer:coarse)`; keyboard-aware means
  `visualViewport`.
- Copy rules: say what a thing does for the owner; one word per concept (**run**, **change**, **service**); no
  "capability", "runtime", "orchestration", "inventory", "workspace", "artifact", "patch", raw ids, raw paths or
  JSON on a first screen; sentence case; version strings from `/healthz`. A lint test (A5) enforces the banned list
  on visible strings.
- Feedback rule: every action that changes state ends with (a) focus on something sensible and (b) a sentence
  the owner can read or hear: in the page for errors, a ≥ 5 s pausable toast or a live region for status.
- Every PR: `npm test`, the affected `tests/*-ui.mjs`, then `npm run ci -- <PR>`; merge on green. A visual
  baseline is updated only after looking at the new image, on real data where the test allows.
- Sub-projects D (structure) and the parts of E that remove pages wait for D6–D10. Everything else starts now.

## Order and sizing

| Sub-project | Theme | PRs | Size | Needs |
|---|---|---|---|---|
| **A** | Trust: true statements, honest first run, one conversation | 6 | M | D10 for A3 |
| **B** | Feedback after every action (focus, announcement, confirmation) | 6 | M | – |
| **C** | Phone keyboard and text reachable by touch | 6 | M | – |
| **D** | Owner's menu and the developer boundary | 7 | L | D1, D4 now; D6–D9 |
| **E** | One vocabulary, one kit | 8 | L | – (page removals wait for D) |
| **F** | Phone polish | 7 | M | – |
| **G** | Accessibility semantics | 5 | S | – |
| **H** | Data and process | 4 | S | – |

Run order: A and B first (they are the trust and the feedback the owner meets daily), C alongside (phone), then
G and H (small, independent), then D once decided, then E (it is easiest after D removes pages), F last.
Sub-projects can proceed in parallel sessions as long as they touch different files; E touches everything and
should run alone.

---

## Sub-project A: Trust (§3.1)

### A1: Health tells the truth when the check fails
**Files:** `app/public/app.js` (`refreshStatus`), `tests/system-lists-ui.mjs`.
**Test first:** stub `/api/status` → 500 and → `{}`; assert the Appliance card reads "Couldn't check the services.
Try again", the last known list stays, nothing says "ready".
**Implement:** check `r.ok` and `Array.isArray(j.services)` before rendering; route failures through the existing
unreachable branch; `role=status` on the summary (also closes §3.2 "Check again announces nothing").

### A2: First run is one story
**Files:** `app/public/ui.js` (first-run section ~3334–3430), `app/public/home.js` (`attentionRow`),
`app/server.js:281` (impact copy), `tests/first-run-ui.mjs`.
**Test first:** on an empty server: Needs you shows no service rows while `#firstRun` is mounted; step 3 is done
only after a run view opens; a failed sample send reads "Chat needs Intelligence running. See Health"; Health's
down-card for Intelligence says "Start Ollama on the Windows host" (copy table per service).
**Implement:** suppress service rows under first run; `li.dataset.state='done'` on run open, not on click; a
`SERVICE_ACTION` table beside `SERVICE_PURPOSE` (#213).

### A3: One conversation, one name, one Library item (needs D10)
**Files:** `app/server.js` (thread row title ~1673; library write ~837/966), `app/run-cards.js`,
`tests/run-ledger.test.cjs`, `tests/library-api.test.cjs` (or the existing library test), `tests/chat-run-ui.mjs`.
**Test first:** two turns in one thread → Work/Home show the first message as the title with "2 turns"; the run
header matches; `/api/library` has one Conversation for the thread whose summary is the latest answer.
**Implement:** thread title = first run's title; library upsert keyed by `threadId`. A one-time repair merges
existing per-turn Library duplicates by thread (`repair:library-threads-v1`), keeping the oldest item's id.

### A4: Inbox counts agree
**Files:** `app/public/app.js` (`loadInbox`), `app/public/index.html:178`, `tests/notifications-ui.mjs`.
**Test first:** two pending approvals, no alerts → Alerts tab shows a row "2 approvals waiting → Approvals"; the
Approvals tab label reads "Approvals · 2"; the bell, the pill and the row agree.
**Implement:** compute one `waiting` number in one place (the Inbox button already does) and render from it.

### A5: Copy lint
**Files:** new `tests/copy-lint.test.cjs`.
**Test:** collects visible strings from `index.html` (text nodes, `placeholder`, `title`, `aria-label`) and
string literals rendered by `app/public/*.js` on a short allow-list of files, and fails on the banned words
(Copy rules) outside developer-only pages (`data-dev` sections after D1). Starts with today's count as the
ceiling and only ratchets down. This is the test that keeps §3.5 from regressing.

### A6: Failure copy at anxious moments
**Files:** `app/public/ui.js` (`kindLabel` ~2695; run view failure actions ~2966–2975), `app/public/app.js`
(`changeValidationHtml`, approval toasts ~654–669), `tests/chat-run-ui.mjs`, `tests/components-ui.mjs`.
**Test first:** a failed chat from Home shows subtitle "Chat", a "Try again" button and, for a model error, a
link to Models; the change review reads "Nothing to apply yet" / "Not tested yet" / "Changes appear after
testing"; approving toasts "Approved — Local AI will apply it".

## Sub-project B: Feedback after every action (§3.2)

### B1: Home send keeps focus and announces the answer
**Files:** `app/public/ui.js` (`showView` run path 3134–3138; stream done ~3191–3196), `app/public/home.js`
(send), `tests/a11y-nav-ui.mjs`.
**Test first:** after Enter on Home, `document.activeElement` is inside the run view within 300 ms and stays
there through the pending→run re-render; when the stream ends `#runLiveRegion` reads "Answer ready."

### B2: Acting on an item refocuses and confirms
**Files:** `app/public/improve.js` (sheet actions, `refresh`), `app/public/app.js` (approvals), `tests/improve-ui.mjs`,
`tests/notifications-ui.mjs`.
**Test first:** after "Move to top", focus is on that item's row and a status "Moved to top" is announced; after
Approve, focus is on the next pending Approve (or the "Nothing is waiting" text) and "Approved" is announced.
**Implement:** a `refocus(id)` helper in `components.js` used by both; announcements through the existing
`#toast` `role=status`.

### B3: Start now and Hand to Claude say what happens next
**Files:** `app/public/improve.js:165,184`, `tests/improve-ui.mjs`.
**Test first:** "Start now" from Backlog lands on In progress with the item highlighted; "Hand to Claude" toasts
"Claude will pick this up in its next session" and the badge appears.

### B4: Toasts the owner can read
**Files:** `app/public/app.js:32`, `app/public/improve.js:189`, `app/public/ui.js:1932, 3540-3545`,
`app/public/app.css` (append), `tests/components-ui.mjs`.
**Test first:** error toasts become in-page `role=alert` boxes (Improve run-checks failure shows under the
button); status toasts last ≥ 5 s and pause while hovered or focused; the "Updated to…" toast is dismissible and
leaves no element behind when hidden.

### B5: Approvals are a list with named buttons
**Files:** `app/public/app.js:650`, `tests/notifications-ui.mjs`, `tests/a11y-sweep-ui.mjs`.
**Test first:** accessibility snapshot shows a list of items, each with an `<h3>` title and buttons named
"Approve: <title>" / "Reject: <title>".

### B6: Home doesn't repeat itself
**Files:** `app/public/home.js:140`, `tests/home-ui.mjs`.
**Test first:** a run shown in Needs you is absent from Recent.

## Sub-project C: Phone keyboard and reachable text (§3.3)

### C1: Keyboard-aware composer
**Files:** `app/public/home.js` (`dockToNav` ~222–228), `app/public/app.css` (append), `tests/home-ui.mjs`.
**Test first:** emulate `visualViewport` height 500 at 390×844 (as `chat-run-ui.mjs` does): the composer's
bottom edge sits at the visual viewport's bottom, and `.ux-mobile-nav` is hidden while the textarea is focused;
on blur both return. **Then verify on the owner's iPhone** (a checklist item, not a test).

### C2: Reply bar safe area
**Files:** `app/public/app.css` (append). **Test:** computed `padding-bottom` of the reply bar includes
`env(safe-area-inset-bottom)` (assert the rule exists via `CSS.supports` + stylesheet scan, as the layout suite
does for other rules).

### C3: Inbox alerts open
**Files:** `app/public/app.js` (inbox card), `app/public/app.css:1239`, `tests/notifications-ui.mjs`.
**Test first:** a 600-character alert body shows four lines and a "Show more" that expands (`aria-expanded`),
on phone and desktop alike.

### C4: Nothing is hover-only
**Files:** `app/public/ui.js:2842` (run title), `app/public/app.js` (`renderTree`), `tests/layout-ui.mjs`
(the "path only on hover" check changes to "path on hover, or under the name on touch"), `tests/chat-run-ui.mjs`.
**Test first:** on a touch context, tapping a clamped run title un-clamps it; each Files row shows its parent
folder as a second line; on desktop the hover titles remain.

### C5: Secondary text is readable
**Files:** `app/public/app.css` (append), visual baselines for library/activity.
**Test first:** on ≤ 760 no visible text in `#library` or `#activityList` is under 13 px; `.activity-detail`
wraps to two lines.

### C6: Narrow rows
**Files:** `app/public/app.css` (append), `tests/layout-ui.mjs` at 320.
**Test first:** at 320 px a Work row's text column is ≥ 200 px (badge under the title or icon dropped).

## Sub-project D: The owner's menu and the developer boundary (§3.4; D1, D4 now, D6–D9 when answered)

### D-1: The switch is a registry flag (D1)
**Files:** `app/public/view-registry.js` (`dev:true` on `workbench`, `repoTools`, `powershell`, `actions`),
`app/public/ui.js` (rail, strip, ⌘K skip `dev` views when `body.dev-tools-off`; switch copy at ~3359),
`tests/navigation-ui.mjs`, `tests/search-ui.mjs`, `docs/USER-GUIDE.md`.
**Test first:** switch off → System lists Health, Models, Integrations, Automations, n8n workflows, Monitors,
Claude Code, Audit log; ⌘K doesn't offer Files; `#powershell` by URL still opens. Switch on → all appear. The
switch's description names what it adds today.

### D-2: Retire the legacy ids (D4)
**Files:** `app/public/index.html` (remove `#issues`, `#quality`, `#changes` sections), the scripts that render
them in `app/public/app.js`/`ui.js`, `tests/*` that reference them (8/5/12 files; API tests stay, page tests move
or go), `app/public/sw.js` if any asset goes.
**Test first:** `#issues` → Signals, `#quality` → Signals, `#changes` → In progress, `#runs` → Work (aliases exist;
assert the sections are gone and nothing 404s in the console).

### D-3: ⌘K and hidden pages
**Files:** `app/public/app.js:754`, `app/public/ui.js` (breadcrumb for hidden views), `tests/search-ui.mjs`,
`tests/navigation-ui.mjs`.
**Test first:** ⌘K offers only non-hidden, non-dev (when off) views; opening `#agents` shows breadcrumb "Work /
Missions" with the Work rail item lit.

### D-4: Extend the boundary (D6)
Claude Code and n8n workflows get `dev:true`; Models' runtime tile and Technical status render only with the
switch on. Tests as D-1.

### D-5: Library inside Projects (D7)
**Files:** `app/public/view-registry.js` (`library` → `parent:'projects'`, tab "Everything you kept";
`DOMAINS[2].defaultView:'projects'`), `app/public/app.js` (library render: list rows for text, cards for images),
`tests/navigation-ui.mjs`, `tests/library-ui.mjs`, visual baselines.
**Test first:** the Projects tab lands on Projects; Library is a tab of Projects; text items are list rows.

### D-6: One queue (D8)
**Files:** `app/public/home.js` (Needs you opens an approval sheet with full detail and Approve/Reject),
`app/public/view-registry.js` (`inbox` tab "Inbox"; `approvals` → alias of `inbox`), `app/public/app.js`,
`tests/home-ui.mjs`, `tests/notifications-ui.mjs`.
**Test first:** an approval is actionable from Needs you without leaving Home; the bell shows one number; Inbox
is the history.

### D-7: One Automations page (D9)
**Files:** `app/public/view-registry.js` (`operations` → alias of `automationStudio`), `app/public/index.html`
(`#operations` content folds into Automations as kinds "Health check" and "Morning brief"), `app/public/app.js`,
`tests/system-lists-ui.mjs`, `tests/agent-operations-ui.mjs`.
**Test first:** a health monitor is created from Automations with kind "Health check"; "Generate brief" lives
there; `#operations` lands on Automations.

## Sub-project E: One vocabulary, one kit (§3.5, §3.6)

### E1: Glossary and terms
**Files:** `docs/USER-GUIDE.md` (a Glossary section), `app/public/index.html`, renderers.
Replace mission/job/execution/task/attempt → **run** (keep "mission" only for the run kind); change request /
finding / item → **change** (keep Signal and idea as sources); companion/capability/integration/tool/bridge →
**service**; one verb per action: "Check again", "Run checks", "Refresh". Extend A5's banned list as terms retire.

### E2: Run header and Missions
**Files:** `app/public/ui.js:2880` ("Not filed" → nothing until filed), `ui.js:1224-1249` (Missions view:
workers and current step first, map behind "Watch live map", tabs renamed Summary / Workers / Sources / Steps,
toolbar labels in words), `tests/agent-operations-ui.mjs`, `tests/chat-run-ui.mjs`.

### E3: Empty states
**Files:** `app/public/index.html`, `app/public/app.js:607, 657`, `tests/system-lists-ui.mjs`.
One pattern: "<What appears here>. <How to make it appear.>" for Projects, Monitors/Automations, Files,
Signals (no empty "Latest checks"), Audit log (no "Clear user activity" when there is nothing to clear).

### E4: One button kit
Map `.btn`/`.btn primary`/`.btn danger`/`.iconbtn` onto `.btn-outline`/`.btn-primary`/`.btn-danger`/`.icon-btn`
in `index.html` and the renderers; delete the 22 `.btn` redefinitions; one rule for primary (the action the page
exists for). Visual baselines for every page.

### E5: One segmented control, one empty state, pills for counts only
`.work-chip`, `.filter`, `.agent-result-tabs`, Agent World toggles → `.ux-tab` (with G1's keyboard behaviour);
`.empty`, `.preview-pane` empties → `.empty-state`; topbar pills carry counts only (states move into the page).

### E6: Type scale, spacing, radii
Five sizes on `--ds-*` (11 px gone except badges), a `.stack-8/12/16` utility replacing the 55 inline styles,
three radii. One PR per page group; `tests/budgets.test.cjs` gains "no inline `style=` in index.html".

### E7: Colour and icon semantics
Severity badges neutral with the word; status colours only for status; Quality/Missions/Changes onto the kit;
one icon per meaning (`sparkle` = Claude only; `compose` = chat and new; `alert` = Signals; `check` = done; a
`file` icon for files); the legacy `<aside>` letter glyphs removed.

### E8: `document.title` and sentence case
Per page ("Work · Local AI") and per run (the run's title); sentence case across `#agents` and friends.

## Sub-project F: Phone polish (§3.7)

F1 pull-to-refresh on list pages (or "Updated n min ago" + `overscroll-behavior-y: contain`) · F2 mode sheet as
one bottom-anchored column · F3 Library pages by 24, chips in one row, count in the placeholder · F4 ⌘K as a bottom
sheet with 8 likely pages on ≤ 760 · F5 iPad: reserved page-list column on coarse pointers ≥ 761, kbd hint hidden
under `(hover:none)` · F6 install metadata aligned on `#0a111c`, `black-translucent`, maskable icon · F7 sticky
header hairline on scroll; iOS scroll lock for sheets. Each with a check in `tests/mobile-ui.mjs` or
`tests/layout-ui.mjs`; F6 with a unit test on the manifest and meta tags.

## Sub-project G: Accessibility semantics (§3.8)

G1 roving tabindex and arrow keys for `.ux-tab` and the mode sheet (or `aria-pressed` buttons), `aria-controls` ·
G2 `<nav aria-label>` landmarks and `aria-current` in the rail · G3 labels for the six placeholder-only fields;
`aria-describedby`/`aria-invalid` on errors · G4 conversation turns labelled "You"/"Local AI", run view `<h2>`,
`role=list` on run lists, ⌘K result count · G5 extend `tests/a11y-nav-ui.mjs` with the four journeys the review
ran (ask, act, approve, ⌘K) as permanent checks.

## Sub-project H: Data and process (§3.9)

H1 one-time repair of the three image summaries (`repair:image-summaries-v1`; test with seeded runs) · H2 local
CI: on a red unit test, comment on the PR with the failing test's name; rerun a failed browser suite once and
report "passed on retry: <suite>" distinctly (never for unit tests) · H3 release-note discipline: PR titles ≤ 70
characters, one clause (a check in local CI that warns, never fails) · H4 the user guide and admin guide updated
after A, B, D.

---

## Done when

- Every page passes A5's copy lint; the user guide's glossary matches the UI word for word.
- The four accessibility journeys (G5) and the keyboard-composer check (C1) pass in CI; the owner has confirmed
  the composer on the iPhone.
- The owner menu (after D) has no page whose first screen contains raw ids, paths or JSON.
- Visual baselines exist for every owner page at 390 and 1440 and match the owner's screens.
- `npm run ci` on `main` is green, and the critique's §3 has no open Important rows.

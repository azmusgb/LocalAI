# Navigation, Home and Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap sub-project 2: five pages (Home · Work · Projects · Improve · System), a Home composer whose Send
opens the work where you are, one Work timeline, and a routed full-screen run view whose bodies reuse the existing
Chat, Images, Mission and Change UIs.

**Architecture:** A small hash router (`#<page>`, `#run/<id>`) lives in a new `app/public/router.js` and drives the
existing `showView` and the sub-project 1 run drawer, which becomes the run view. The registry gains the new domains
and aliases. Work and Home are rendered by new modules (`work.js`, `home.js`) from `/api/runs`. Run bodies
(`run-bodies.js`) mount the existing `#ask`, `#create`, `#agents` and `#changes` working subtrees into the run view.
Missions gain a ledger run so they appear in Work and open as run views.

**Tech Stack:** Vanilla JS/CSS (no build step), Node 22 built-ins server, `node --test`, Playwright browser suites,
vendored axe-core 4.10.2.

**Spec:** `docs/superpowers/specs/2026-10-15-navigation-home-work-design.md` (mockups in
`docs/superpowers/mockups/2026-10-15-navigation-home-work/`).

**Deviation from the spec, decided while planning:** the spec has six tasks. Missions create no ledger run today
(they live in the orchestrator's own store, and `POST /api/agents/missions/start` returns only when the mission
ends), so "a mission opens as a run view and appears in Work" needs a server change. That is Task 7, separate from
the image/change bodies (Task 6).

## Global Constraints

- One design language: `--ds-*` tokens, Figtree, the `#i-*` sprite (24 px viewBox, 1.8 stroke, round caps,
  `currentColor`) and the component classes (`.list-row*`, `.badge--*`, `.icon-btn`, `.btn-primary`, `.btn-outline`,
  `.card`).
- Phone breakpoint `@media (max-width:760px)`; 44 px targets; inputs ≥ 16 px on phones.
- Old URLs and view ids keep working through `ALIASES` in `view-registry.js`, indefinitely.
- No new runtime npm dependencies.
- Main stays fully usable after each task; each task is its own PR (CI green → owner merges).
- Contracts that must keep passing: the strings in `tests/run-execution-ui.test.cjs` (`section.id = 'runs'`,
  `button.dataset.view = 'runs'`, `panel.id = 'homeRunCenter'`, `runDrawerBackdrop`, `Cancel run`, `Retry`,
  `/api/runs/cancel`, `/api/runs/retry`, `['Attempt', String(run.attempt || 1)]`, `['Retry of', run.retryOf || '—']`,
  `Timeline`, `Output`, `event.key === 'Escape'`), `window.LocalAIRuns.open(id) → Promise<boolean>` (false for an
  unknown id), the gate code checked by `tests/truth-layer-ui.test.cjs`, and `view-registry.test.cjs` lines 85–92.
- New front-end scripts are classic scripts added to `index.html` before `/app.js` and to `SHELL` in
  `app/public/sw.js` with a `CACHE` bump.
- Every new surface gets an axe `color-contrast` + `target-size` check (helper in `tests/components-ui.mjs`).
- Copy: plain sentences, no internal status names on screen (`LocalAIKit.statusBadge`).

## Review Focus

1. **A deep link to a run that aged out or never existed** (`#run/run-123…`) → "This run is no longer available"
   with a link to Work; no blank screen, no console error. Test in Task 2.
2. **Back after Send** → closes the run view and returns to Home with the composer empty; Back again leaves Home as
   before. Test in Task 4.
3. **A reply while the previous answer is still streaming** → the reply box is disabled (send shows Stop) until the
   stream ends or is stopped; no interleaved answers. Test in Task 5.
4. **Reload in the middle of a run** (`#run/<id>` while running) → the run view reopens on that run and shows live
   progress. Test in Task 2.
5. **Developer tools off** → Improve hidden in the tab bar and rail (four equal tabs), and `#improve`/old Build
   links still open. Test in Task 1.

---

### Task 1: Registry and routing

**Files:**
- Create: `app/public/router.js`
- Modify: `app/public/view-registry.js` (DOMAINS, VIEWS domains, ALIASES), `app/public/index.html` (sprite symbols
  `i-work`, `i-projects`, `i-improve`; script tag), `app/public/ui.js` (`buildMobile`, `buildDesktopNav`, `sync`,
  `applyDevTools`), `app/public/app.css` (`.dev-tools-off [data-domain="improve"]`), `app/public/sw.js`
- Test: `tests/view-registry.test.cjs`, `tests/router-ui.mjs` (new), and selector updates in `navigation-ui.mjs`,
  `agent-operations-ui.mjs`, `first-run-ui.mjs`, `integration-hub-ui.mjs`, `mobile-ui.mjs`

**Interfaces:**
- Produces:
  - `DOMAINS` ids `home, work, projects, improve, system`, each `{id,label,icon,symbol,tagline,defaultView}`;
    default views `home, work, library, changes, status`; icons `home, work, projects, improve, system`.
  - A view `work` (domain `work`, label `Work`) whose section `#work` is created by Task 3; until then `router.js`
    shows `#runs` for `#work`.
  - Domain of each existing view: `home`: home, inbox, approvals · `projects`: library, projects, knowledge, memory ·
    `improve`: changes, issues, quality, claude · `system`: status, models, integrations, activity, workbench,
    repoTools, powershell, automationStudio, automations, actions, operations · `ask`, `create`, `agents`, `runs` have
    `domain:'hidden'` (no nav entry, still routable).
  - `ALIASES` adds: `runs → work`, `agents → work`, `ask → home`, `create → home`, `engineering → changes` (kept).
    Alias targets carry an intent: `window.LocalAIRouter.intentFor(id) → {mode?:'ask'|'create', kind?:'missions'}`
    (`ask → {mode:'ask'}`, `create → {mode:'create'}`, `agents → {kind:'missions'}`).
  - `window.LocalAIRouter = { go(path: string, {replace?: boolean}) → void, current() → {page: string, runId: string|null, query: URLSearchParams}, onRun(fn: (runId: string|null) => void) → void }` in `router.js`.
    `go('#work?kind=images')`, `go('#run/<id>')`. It listens to `hashchange`; a page path calls
    `window.showView(resolvedId)`; a run path calls the run-open handler registered by Task 2 (`onRun`). `showView`
    calls made by other code update the hash with `replace` semantics so Back follows real navigation only.
  - Loading the app with a hash honours it; no hash → `#home`.

- [ ] **Step 1: Failing tests.**
  - `tests/view-registry.test.cjs`: `DOMAINS` ids equal `['home','work','projects','improve','system']`; every view
    has a domain in that list or `'hidden'`; `resolve('runs')==='work'`, `resolve('agents')==='work'`,
    `resolve('ask')==='home'`, `resolve('create')==='home'`; every DOMAINS `icon` has a matching `<symbol id="i-…">` in
    `index.html`.
  - `tests/router-ui.mjs` (390×844 and 1280×860): loading `/#library` shows `#library.active`; clicking each tab-bar
    item sets `location.hash` to that domain's default view; `history.back()` after two navigations returns to the
    first; `/#ask` lands on `#home.active`; `/#agents` lands on Work (`#runs.active` until Task 3) with
    `LocalAIRouter.current().query.get('kind')==='missions'`; Review Focus 5: with `localStorage['localai.devTools']='0'`
    the tab bar shows 4 equal-width items without Improve, and `/#changes` still shows `#changes.active`.
- [ ] **Step 2: Run** `node --test tests/view-registry.test.cjs` and `node tests/run-browser.mjs router` → FAIL.
- [ ] **Step 3: Implement** the registry changes, `router.js`, the three sprite symbols (same style as `i-home`), the
  nav consumers reading the new domains, and the dev-tools rule for `improve`. Update the listed suites' domain
  selectors (`workspace`→`projects`, `automate`→`system`, `build`→`improve`) and the `#ask.active` /
  `#agents.active` waits that came from clicking a domain.
- [ ] **Step 4: Run** `npm test` and `node tests/run-browser.mjs` (own server on port 3094) → PASS.
- [ ] **Step 5: Commit** `Five pages and a hash router: Home, Work, Projects, Improve, System`.

### Task 2: Run view shell

**Files:**
- Modify: `app/public/ui.js` (execution-runtime section: `ensureSurface`, `renderDrawer`, `openDrawer`,
  `closeDrawer`, `openRunBySource`), `app/public/app.css`, `app/server.js` (`apiRuns` `?id=` adds `card`)
- Test: `tests/components-ui.mjs`, `tests/run-api.test.cjs`, `tests/run-execution-ui.test.cjs` (contracts unchanged)

**Interfaces:**
- Consumes: Task 1 `LocalAIRouter.onRun`, `go`.
- Produces:
  - `GET /api/runs?id=<id>` returns `{item}` where `item.card` is present (same `runCard` options as the list).
  - Opening a run is routing: `LocalAIRuns.open(id)` resolves the id as today and then `LocalAIRouter.go('#run/'+id)`;
    `onRun(id)` renders the run view (fetching `?id=` when the run isn't in `state.runs`); `onRun(null)` closes it.
    Close (‹), Escape and the backdrop call `history.back()` when the run view was opened by in-app navigation, else
    `go('#home',{replace:true})`.
  - `window.LocalAIRuns.openPending({kind: string, title: string}) → { resolve(runId: string): void, fail(message: string): void }`:
    shows the run view immediately in a "Starting…" state (title, kind icon, spinner) under the hash `#run/pending`;
    `resolve` replaces the hash with `#run/<runId>` (replace semantics); `fail` shows the message with a Close button.
  - Layout: phones — full screen over the tab bar; desktop — a right-side panel `min(820px, 100vw - 120px)`.
    Header: ‹ (`aria-label="Back"`), title, subtitle `<kind label> · <project name or "Not filed">`, ⓘ
    (`aria-label="Details"`), ⋯ (`aria-label="More"`) holding "Cancel run" and "Retry". The body slot follows; the
    approval bar stays inline above the body. ⓘ opens a bottom sheet (`#runDetailsSheet`, a `<dialog>`) containing
    Pin, File…, the details grid and the Timeline — the same builders sub-project 1 uses, moved, not duplicated.
  - Missing run: body text "This run is no longer available" and a `.btn-outline` "Open Work" → `go('#work')`.

- [ ] **Step 1: Failing tests** (`tests/components-ui.mjs`, `/api/runs` stubbed with one completed chat run and one
  running image run): opening a run sets `location.hash==='#run/<id>'`; at 390×844 the run view's bounding box equals
  the viewport and covers `#uxMobileNav`; at 1280×860 its width is ≤ 820; the details grid and Timeline are not
  visible until ⓘ is pressed, then are inside `#runDetailsSheet`; Pin and File… are in the sheet; Escape closes the
  sheet first, then the run view; `history.back()` closes the run view; Review Focus 1: loading `/#run/run-missing`
  (stub `?id=` → 404) shows "This run is no longer available" and no page error; Review Focus 4: reloading on
  `/#run/<running image id>` reopens it with its progress bar; `openPending` shows "Starting…", and after
  `resolve('run-x')` the hash is `#run/run-x` and `history.length` did not grow; axe clean with the view and the
  sheet open. `tests/run-api.test.cjs`: `GET /api/runs?id=<id>` item has `card.kind`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and all browser suites → PASS (the `run-execution-ui` contract strings unchanged).
- [ ] **Step 5: Commit** `Run view: routed, full screen on phones, details behind ⓘ`.

### Task 3: Work

**Files:**
- Create: `app/public/work.js`
- Modify: `app/public/index.html` (`section#work.view`, script tag), `app/server.js` (`unifiedRunItems`/`apiRuns`:
  `before`), `app/public/app.css`, `app/public/sw.js`, `app/public/view-registry.js` (Work's section exists now)
- Test: `tests/work-ui.mjs` (new), `tests/run-api.test.cjs`

**Interfaces:**
- Consumes: `LocalAIUI.loadInto`, `LocalAIUI.runCard`, `LocalAIRuns.open`, `LocalAIRouter`.
- Produces:
  - `GET /api/runs?threads=1&before=<runId>&limit=60`: items whose `createdAt` is older than that run's, after all
    filters; `before` must pass the run id rule, else 400.
  - `#work` page: filter chips (`[data-work-kind]` = `all, chats, images, missions, changes, other`; chats = chat +
    research; changes = engineering; other = everything else), a search field `#workSearch` (filters loaded rows by
    title + summary, case-insensitive), day groups `Today · Yesterday · Earlier this week · Older` (local time,
    `createdAt` of the thread's latest run), rows by `runCard` with a chat row's subtitle `Chat · N turns`
    (N = runs in the thread among loaded items, shown when > 1), `#workMore` "Show more" (next 60 via `before`),
    empty state "Nothing yet. What should we do?" + button "Start something" → `go('#home')` and focuses the composer.
  - Filter is remembered (`localStorage['localai.work.kind']`) and mirrored in the hash (`#work?kind=images`); the
    hash wins on load.
  - Polling: 5 s while any loaded run is queued/running/streaming, else 60 s; paused while the tab is hidden; a row
    updates in place (by `data-run-id`) and the scroll position is kept.
  - Errors through `loadInto`: "Couldn't load your work." with Retry.

- [ ] **Step 1: Failing tests.** `tests/run-api.test.cjs`: create 70 chat runs in 70 threads, `threads=1&limit=60`
  returns 60, `before=<60th id>` returns the remaining 10 older ones; `before=../x` → 400. `tests/work-ui.mjs`
  (stubbed `/api/runs`: runs created today, yesterday, 3 days ago, 30 days ago across kinds): group headings in that
  order; the Images chip shows only image rows and sets `#work?kind=images`; reload keeps it; `#workSearch` "sqlite"
  filters to the matching title; Show more appends and is hidden when fewer than 60 come back; a stubbed 500 shows
  "Couldn't load your work." and Retry recovers; a running row's progress updates within 6 s without the list
  re-scrolling to top; `/#agents` lands on `#work.active` with the Missions chip active; axe clean at 390×844.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The System → Runs page stays reachable by id (`#runs`) for the
  `run-execution-ui` contracts but leaves the navigation; `runs` resolves to `work`.
- [ ] **Step 4: Run** `npm test` and all browser suites → PASS.
- [ ] **Step 5: Commit** `Work: one timeline of everything you started, by day`.

### Task 4: Home

**Files:**
- Create: `app/public/home.js`
- Modify: `app/public/index.html` (`#home` markup: header slot, `#homeNeedsYou`, `#homeRecent2` list, composer
  `#homeComposer`), `app/public/app.js` (`runCommand` becomes a call into `home.js`; keep `resolveIntentRequest`),
  `app/public/ui.js` (Home's attention surface feeds Needs you; Get started stays), `app/public/app.css`,
  `app/public/sw.js`
- Test: `tests/home-ui.mjs` (new); selector updates in `navigation-ui.mjs`, `first-run-ui.mjs`, `mobile-ui.mjs`

**Interfaces:**
- Consumes: `LocalAIRuns.openPending`, `LocalAIRouter`, `LocalAIUI.runCard`, `loadInto`, `ask`; `attentionItems`
  (service and change items).
- Produces:
  - Home order: brand + greeting header (existing) · `#homeNeedsYou` (hidden when empty; rows = runs with status
    `awaiting_approval`, runs `failed` in the last 24 h, and the `critical` items from `attentionItems`) · Recent
    (`/api/runs?threads=1&limit=6` as `runCard`s, "See all" → `#work`; replaced by `#firstRun` while Get started shows)
    · `#homeComposer` docked above the tab bar on phones (fixed, safe-area aware, content padded so nothing hides
    under it) and at the foot of a centred 720 px column on desktop.
  - Composer: `textarea#commandInput` (keeps its id and placeholder), mode chip `#homeModeChip` (label
    `Auto ▾` / `Chat ▾` …), send `#commandGo` (keeps its id, `aria-label="Send"`). The chip opens
    `LocalAIUI.ask`-style sheet `#homeModeSheet` listing modes `auto, ask, research, create, mission, automate,
    engineering` (labels `Auto, Chat, Research, Image, Mission, Automate, Change Local AI`) and the chosen mode's
    options: ask/research → model `<select>` (from the existing chat model list); create → engine, shape, style (the
    `#create` controls' current values, mirrored); mission → specialists (manual ids). Mode and options persist in
    `localStorage['localai.home.mode']` / `['localai.home.options']`. `.mode[data-mode]` buttons stay in the DOM
    (visually hidden) for the gate and first-run code.
  - `window.LocalAIHome.send(text: string, mode: string) → Promise<void>`:
    `auto` → `resolveIntentRequest`; then show "→ <Mode>" on the chip for 1.5 s and proceed;
    `ask`/`research` → `openPending({kind,title})` then Task 5's `LocalAIChat.start(text,{research, pending})`;
    `create` → `openPending` then Task 6's `LocalAIImages.start(text, {pending})`;
    `mission` → `openPending` then Task 7's `LocalAIMissions.start(text, {pending})`;
    `engineering` → `POST /api/engineering/start` then `LocalAIRuns.open('legacy-engineering:'+run.id)`;
    `automate` → `go('#automationStudio')` with the text in its prompt field.
    Until Tasks 5–7 land, `ask/research/create/mission` fall back to today's behaviour (open the page with the text).
    On a start failure the text stays in `#commandInput` and the reason shows in `#homeComposerError`.
  - Send clears the input only after the run view opened.

- [ ] **Step 1: Failing tests** (`tests/home-ui.mjs`, 390×844 and 1280×860, `/api/runs` stubbed): Needs you lists
  an awaiting-approval run and a failed run from today, not a failed run from 3 days ago, and is hidden when there are
  none; Recent shows 6 thread cards and "See all" goes to `#work`; at 390×844 `#homeComposer`'s bottom equals
  `#uxMobileNav`'s top (± 1) and the last Recent card is fully above the composer when scrolled to the end; the chip
  sheet lists the seven modes and choosing Image persists across reload; Engineering send (stub
  `/api/engineering/start` → `{run:{id:'e1'}}`) opens `#run/legacy-engineering:e1`; Review Focus 2: after a send that
  opened a run, `history.back()` shows `#home.active` with an empty composer; a stubbed 500 from the start endpoint
  keeps the text and shows the error; axe clean.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and all browser suites → PASS.
- [ ] **Step 5: Commit** `Home: needs you, recent, and a composer at your thumb`.

### Task 5: Chat and research body

**Files:**
- Create: `app/public/run-bodies.js` (shared mount/unmount helpers + the chat body)
- Modify: `app/public/app.js` (`sendChat` split: a reusable `streamChat({messages, webSearch, model, threadId, onToken, onMeta}) → Promise<{runId, content}>`; `#ask` remains the host), `app/public/index.html`, `app/public/sw.js`, `app/public/app.css`
- Test: `tests/chat-run-ui.mjs` (new); updates in `navigation-ui.mjs` (Chat via the composer/run view instead of
  `showView('ask')`), `mobile-ui.mjs` (the Send-above-tab-bar check moves to the run view's reply box)

**Interfaces:**
- Consumes: `LocalAIUI.registerRunBody`, `openPending`, `LocalAIRouter`.
- Produces:
  - `window.LocalAIChat.start(text: string, {research: boolean, pending}) → Promise<void>`: new thread
    (`newThreadId()`), streams via `streamChat`; on the `meta` event (`runId`) calls `pending.resolve(runId)`.
  - `registerRunBody('chat'|'research', mount)`: loads `GET /api/runs?threadId=<t>&limit=500`, sorts by `createdAt`
    ascending, renders user turns from `input.prompt` and answers from `output.text`; when `output.truncated` is true
    the answer text comes from the run's first Library artifact (`/api/library` item by id in `artifactIds[0]`,
    `response` field). A reply box (`#runReply` textarea + send `#runReplySend`) is pinned at the bottom; a reply
    calls `streamChat` with the rebuilt messages (last 16, as `/api/chat/stream` accepts) and the thread id, and the
    answer streams into the view. While streaming, send becomes Stop (aborts).
  - The `#ask` page leaves the navigation (`domain:'hidden'`); `ask` resolves to Home with Chat mode.
  - The device's existing `localAiMessages` conversation is the thread `localAiThreadId`; nothing migrates.

- [ ] **Step 1: Failing tests** (`tests/chat-run-ui.mjs`, `/api/chat/stream` stubbed as SSE with `meta`, `token`,
  `done`; `/api/runs?threadId=` stubbed): from Home in Chat mode, Send opens `#run/pending` then `#run/<runId>` from
  `meta`, and tokens appear in the run view; a thread with 3 runs renders 3 user and 3 assistant turns in order; a
  truncated answer shows the Library text; a reply sends `threadId` equal to the thread's and the previous turns as
  messages; Review Focus 3: during a stream `#runReplySend` reads "Stop" and a second Enter sends nothing, Stop aborts
  and re-enables; at 390×844 `#runReply` is fully visible above the viewport bottom with the keyboard viewport reduced
  by 300 px; `/#ask` lands on Home with the chip reading "Chat ▾"; axe clean.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and all browser suites → PASS.
- [ ] **Step 5: Commit** `Chat opens where you are: conversations live in the run view`.

### Task 6: Image and change bodies

**Files:**
- Modify: `app/public/run-bodies.js` (image and engineering bodies), `app/public/app.js` (`generateImage` split:
  reusable `startImage(body) → Promise<response>`; `selectChange(id)` render target parameterised), `app/public/app.css`
- Test: `tests/images-ui.mjs` (moves its flows into the run view), `tests/image-run-ui.mjs` (new),
  `tests/change-run-ui.mjs` (new)

**Interfaces:**
- Consumes: run-bodies helpers from Task 5; `openPending`.
- Produces:
  - `window.LocalAIImages.start(prompt: string, {pending}) → Promise<void>`: builds the body from the current image
    options (`imageRequestBody()`), POSTs `/api/images/generate`, resolves `pending` with `runId`.
  - `registerRunBody('image', mount)`: moves `#imageStage` (result, batch, actions incl. `#imageAgain` and
    `#imageEditThis`) and `#imageEditPanel` into the slot on mount and back into `#create` on unmount; a strip of the
    thread's versions (`GET /api/runs?threadId=<t>`, each run's `output.images`) with the selected one large; Another
    version and Edit keep the thread (`imageUi.threadId` set from the run).
  - `registerRunBody('engineering', mount)`: calls `selectChange(run.meta.changeId, slot)` so the change detail
    (summary, validation, diff, Stage/Approve/Reject/Apply) renders in the slot; with no `changeId` yet, shows the
    engineering run's steps (`renderEngineeringRun`) and refreshes until a change exists.
  - `#create` and `#changes` keep working as hosts; `create` leaves the navigation (`domain:'hidden'`), `changes`
    stays under Improve.

- [ ] **Step 1: Failing tests.** `tests/image-run-ui.mjs` (stub `/api/images/generate` → `{runId:'run-i1',threadId:'t1',images:[{imageUrl:'/x.png'}]}` and `/api/runs`): Image mode Send opens `#run/run-i1` with the image shown; Another version posts `threadId:'t1'`; Edit opens the editor inside the run view and Apply edit posts `threadId:'t1'` with `source`; closing the run view returns `#imageStage` to `#create` (element count 1, parent `#create`). `tests/change-run-ui.mjs`: an engineering run with `meta.changeId:'c1'` (stub `/api/changes`) renders the change detail with Approve in the run view; with no change yet it shows the run's steps. `tests/images-ui.mjs`: its existing assertions run through the run view. axe clean on both.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and all browser suites → PASS.
- [ ] **Step 5: Commit** `Images and changes open where you are`.

### Task 7: Missions as runs

**Files:**
- Modify: `app/server.js` (`apiAgentMissionStart`), `app/run-cards.js` (agent preview from mission), `app/public/run-bodies.js` (mission body), `ui.js` (agent-specialists `startMission` gains a caller-supplied pending handle; Agent World mount target parameterised)
- Test: `tests/run-api.test.cjs`, `tests/mission-run-ui.mjs` (new), `tests/agent-operations-ui.mjs` (updates)

**Interfaces:**
- Produces:
  - `POST /api/agents/missions/start {goal, projectId?, agentIds?, async: true}` → `202 {runId, threadId}`
    immediately: creates a ledger run `{type:'agent', title: titleFromText(goal,'Mission'), input:{goal, projectId,
    agentIds}, projectId (when valid), meta:{}}`, starts the mission without awaiting it, records `meta.missionId` from
    the mission's first event, maps mission progress/state to the run (`running` with progress, `completed` with
    `summary` and `output:{missionId, outcome}`, `failed` with `error`). Without `async`, the endpoint behaves as today
    (existing callers and tests unchanged).
  - `runCard` for `type:'agent'` with `meta.missionId`: preview `{type:'mission', text: summary}` (existing shape).
  - `window.LocalAIMissions.start(goal: string, {pending}) → Promise<void>` posts with `async:true` and resolves
    `pending` with `runId`.
  - `registerRunBody('agent', mount)`: when `run.meta.missionId` exists, mounts `#agentWorldCityMount`, the mission
    headline/progress and `#agentTimeline` into the slot (moved, returned on unmount) and selects that mission;
    otherwise the default Output block.
  - `agents` (Missions page) leaves the navigation; `/#agents` → Work with the Missions chip (Task 1/3).

- [ ] **Step 1: Failing tests.** `tests/run-api.test.cjs` (orchestrator stubbed or a fast mission with mocked
  inference, as the existing agent tests do): `async:true` returns 202 with a `runId` before the mission ends; the
  run gains `meta.missionId` and ends `completed` with `output.missionId`; a failing mission ends the run `failed`
  with an error; without `async` the response is the existing `{mission}`. `tests/mission-run-ui.mjs`: Mission mode
  Send opens `#run/<runId>` and `#agentWorldCityMount` is inside the run view; closing returns it to `#agents`; Work's
  Missions chip lists the mission run. axe clean.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and all browser suites → PASS.
- [ ] **Step 5: Commit** `Missions are runs: start from Home, follow in Work`.

# Run Model and Shared Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roadmap sub-project 1: runs can be filed, threaded and kept, every run describes itself as a card, and the
app gets four shared components (load/empty/error state, approval sheet, run card, run view) that sub-projects 2–5 build on.

**Architecture:** The ledger (`app/run-ledger.js`) gains three fields and keep-aware pruning. A new pure module
(`app/run-cards.js`) turns any run (native or legacy) into a card, attached to every `/api/runs` item. A new classic
script (`app/public/components.js`, loaded before `app.js`) exposes `window.LocalAIUI` with the state helper, the
approval sheet and the run card. The existing run drawer in `ui.js` becomes the run view. No page moves; navigation
is sub-project 2.

**Tech Stack:** Node 22.13+ built-ins, `node:sqlite` via `app/storage.js`, vanilla JS/CSS, `node --test`,
Playwright browser tests, vendored axe-core 4.10.2.

**Spec:** `docs/superpowers/specs/2026-10-15-localai-evolution-design.md` (sections "Runs as the core object",
"Rules for every sub-project", "Board items this roadmap closes").

**Decision: no server split first.** The roadmap leaves this to the start of sub-project 1. It touches `server.js` in
four small places (`apiRuns`, one new route, `threadId` on chat and image requests, the approval lookup for cards), so
the split (`prod-modularize`) stays separate. `run-cards.js` is a new module rather than more `server.js`.

## Global Constraints

- No new runtime npm dependencies; the server uses Node built-ins only.
- One design language: `--ds-*` tokens, Figtree, the `#i-*` icon sprite and the component classes from #81
  (`.card-surface`, `.list-row*`, `.badge--*`, `.banner*`, `.empty-state*`, `.btn-primary`, `.btn-outline`, `.icon-btn`).
- Element ids, routes and the strings asserted in `tests/run-execution-ui.test.cjs` are contracts: keep
  `runDrawerBackdrop`, "Cancel run", "Retry", `['Attempt', String(run.attempt || 1)]`, `['Retry of', run.retryOf || '—']`,
  "Timeline", "Output", `event.key === 'Escape'`, `/api/runs?limit=120`, `window.LocalAIRuns.open`.
- Every new UI surface gets an axe `color-contrast` + `target-size` check (vendor `tests/vendor/axe.min.js` from the
  closed #94's branch `phone-remaining`, with `tests/vendor/axe-LICENSE.txt`).
- Adding `components.js` to the page means adding it to `SHELL` in `app/public/sw.js` and bumping `CACHE`.
- Main stays fully usable after each task (each task is its own PR: CI green → owner merges → Safe Deploy).
- Copy: plain sentences, no internal status names on screen (use `LocalAIKit.statusBadge`).

## Review Focus

1. **More kept runs than the limit** → creating a run still works, the oldest unkept runs are pruned, and no kept run
   (pinned, filed, or with artifacts) is ever deleted. Test in Task 1.
2. **A junk or hostile `threadId`/`projectId`** (spaces, 500 chars, `../`, an object) → ignored or 400, never stored
   raw. Test in Tasks 1–2.
3. **Acting on a legacy run** (`legacy-agent:…`) through the new update route → 409 with a message, not a crash.
   Test in Task 2.
4. **The approval sheet under pressure:** a double tap on Confirm sends once; Escape or a backdrop tap resolves as
   cancelled; focus returns to the button that opened it. Test in Task 5.
5. **A list that loaded before and then fails** → the error state with Retry replaces it (no stale list presented as
   current), and Retry recovers. Test in Task 4.

---

### Task 1: Ledger: projectId, threadId, pinned, keep-aware pruning

**Files:**
- Modify: `app/run-ledger.js`, `app/storage.js` (`pruneSettings`)
- Test: `tests/run-ledger.test.cjs`, `tests/storage.test.cjs`

**Interfaces:**
- Produces: run fields `projectId: string|null`, `threadId: string` (defaults to the run's own id), `pinned: boolean`.
  `ledger.create({..., projectId, threadId})`; `ledger.file(runId, { projectId?, pinned? }) → publicRun|null`;
  `ledger.list({ limit, status, type, projectId, threadId, collapseThreads })`; `isKept(run) → boolean`
  (exported). `storage.pruneSettings(prefix, keep, { exempt })` where `exempt` is
  `{ truthy: string[], nonEmptyArray: string[] }` of JSON paths matching `/^\$\.[A-Za-z_][A-Za-z0-9_]*$/`.
- Id rule (both fields): `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/`; anything else becomes `null` (projectId) or the
  run id (threadId).

- [ ] **Step 1: Failing tests** in `tests/run-ledger.test.cjs` (extend `MemorySettings.pruneSettings` to honour
  `exempt` the same way):
  - `run carries projectId, threadId and pinned`: create with `{projectId:'proj-1', threadId:'t-1'}` → fields set;
    create without → `projectId===null`, `threadId===run.id`, `pinned===false`.
  - `bad ids are not stored`: `projectId:'../x'`, `threadId:'a'.repeat(200)`, `threadId:{}` → `null` / own id.
  - `file() pins and files; null unfiles`: `file(id,{pinned:true})`, then `{projectId:'p'}`, then `{projectId:null}`.
  - `kept runs survive pruning` (Review Focus 1): `maxRuns:20`; create 5 runs, pin 2, file 2, give 1 artifactIds;
    create 30 more → all 5 kept runs still `get()`-able, and unkept count is exactly 20.
  - `list filters and collapses threads`: three runs in thread `t`, one in `u` → `list({threadId:'t'}).length===3`,
    `list({collapseThreads:true})` returns 2 items, the newest of each thread.
- [ ] **Step 2: Failing test** in `tests/storage.test.cjs`: `pruneSettings keeps exempt rows` using real SQLite
  storage: 6 rows under `x/`, two with `{pinned:true}` and one with `{artifactIds:['a']}`, `pruneSettings('x/', 2,
  {exempt:{truthy:['$.pinned','$.projectId'], nonEmptyArray:['$.artifactIds']}})` leaves the 3 exempt rows plus the 2
  newest others; an invalid path throws `TypeError`.
- [ ] **Step 3: Run** `node --test tests/run-ledger.test.cjs tests/storage.test.cjs`: expect FAIL.
- [ ] **Step 4: Implement.** `pruneSettings` adds `AND NOT (<exempt predicates>)` to both the DELETE and its
  ranking subquery, so only non-exempt rows are ranked and pruned (`json_extract(payload,'$.p')` truthy:
  `IS NOT NULL AND != '' AND != 0 AND != 'false'`; array: `json_array_length(...) > 0`). `create` calls it with the
  exempt set above. `list` passes `projectId`/`threadId` through `where`; `collapseThreads` keeps the first item per
  `threadId` from the newest-first list, then applies `limit`.
- [ ] **Step 5: Run** `npm test`: PASS. **Commit:** `Runs: project, thread and pin fields; kept runs are never pruned`.

### Task 2: Runs API: filters, filing, threads from chat and images

**Files:**
- Modify: `app/server.js` (`apiRuns`, new `apiRunUpdate` + route, chat run creation near `runLedger.create({type:body?.webSearch…`, image run creation in the generate handler), `app/public/app.js` (chat request body, image follow-ups)
- Test: `tests/run-api.test.cjs`

**Interfaces:**
- Consumes: Task 1's `ledger.file`, `ledger.list` options.
- Produces: `GET /api/runs?projectId=&threadId=&threads=1` (filters applied after `unifiedRunItems`; `threads=1`
  collapses by `threadId`, legacy items count as their own thread). `POST /api/runs/update {id, pinned?, projectId?}`
  → `{item}`; 400 bad id format, 404 unknown run or unknown project (checked against the projects store), 409 for
  `legacy-*` ids with `{error:'This run is managed by its own page and cannot be filed yet'}`.
  `/api/chat` and `/api/images/generate` accept `threadId` (Task 1 id rule) and pass it to `runLedger.create`.
  Client: `state.threadId` starts as `crypto.randomUUID()` and resets in `newChat()`; chat requests send it.
  "Another version" and edits send the source image run's `threadId`.

- [ ] **Step 1: Failing tests** in `tests/run-api.test.cjs` (reuse its spawned-server harness):
  - `runs can be pinned and filed`: create a project via `/api/projects/create`, run a chat, `POST /api/runs/update`
    `{id, pinned:true, projectId}` → item has both; `GET /api/runs?projectId=…` returns just that run.
  - `update rejects unknown project, bad ids and legacy runs` (Review Focus 2 and 3): unknown projectId → 404;
    `id:'../../x'` → 400; an existing `legacy-agent:` id from the list → 409 with the message above.
  - `chat turns share a thread`: two `/api/chat` calls with `threadId:'th-1'` → `GET /api/runs?threadId=th-1` has 2;
    `?threads=1` lists that thread once; a chat with `threadId:'bad id!'` gets its own run id as threadId.
- [ ] **Step 2: Run** `node --test tests/run-api.test.cjs`: FAIL.
- [ ] **Step 3: Implement** the route, filters and client changes above.
- [ ] **Step 4: Run** `npm test`: PASS. **Commit:** `Runs API: filter by project and thread, pin and file runs`.

### Task 3: Card contract (server)

**Files:**
- Create: `app/run-cards.js`
- Modify: `app/server.js` (`apiRuns` attaches `card`)
- Test: `tests/run-cards.test.cjs` (new), `tests/run-api.test.cjs`

**Interfaces:**
- Produces: `runCard(run, { approvalFor }) → { kind, icon, title, summary, badge:{label,tone}, preview, action, approval, view }`
  - `icon` (sprite name): chat `compose`, research `globe`, image `image`, agent `automate`, automation `refresh`,
    engineering `build`, anything else `system`.
  - `preview`: chat/research `{type:'text', text}` (output.text or summary, ≤240 chars); image
    `{type:'image', src: output.images[0].imageUrl, count}`; agent `{type:'mission', text: summary}`; engineering
    `{type:'diff', changeId, files}` (files from the change when found, else null); else `null`.
  - `action`: `awaiting_approval` → `{label:'Review'}`; failed and `retryable` → `{label:'Retry'}`; otherwise `{label:'Open'}`.
  - `approval`: `approvalFor(run)` → `{id, title, detail, risk}` for a pending approval whose `meta.changeId` equals
    `run.meta.changeId`, else `null`.
  - `view`: chat/research `ask`, image `create`, agent `agents`, automation `automationStudio`, engineering `changes`,
    else `runs`. `badge` uses the same status map as `LocalAIKit.statusBadge`, copied into `run-cards.js` as a frozen object.
  - `/api/runs` items gain `card`; the response shape is otherwise unchanged.

- [ ] **Step 1: Failing tests:** `tests/run-cards.test.cjs`, one test per kind with the exact `icon`, `preview`,
  `action` and `view` above; an engineering run awaiting approval with a matching pending approval →
  `approval.risk==='high'` and `action.label==='Review'`; an unknown type → `icon:'system'`, `view:'runs'`,
  `preview:null`; a run with no `output` → text preview from `summary`. `tests/run-api.test.cjs`: every `/api/runs`
  item has `card.icon` and `card.view`.
- [ ] **Step 2: Run** `node --test tests/run-cards.test.cjs tests/run-api.test.cjs`: FAIL.
- [ ] **Step 3: Implement** `run-cards.js` and the `apiRuns` attach (`approvalFor` reads `approvalStore()` once per request).
- [ ] **Step 4: Run** `npm test`: PASS. **Commit:** `Runs describe themselves as cards`.

### Task 4: One load / empty / error state for every list

**Files:**
- Create: `app/public/components.js`
- Modify: `app/public/index.html` (`<script src="/components.js">` before `app.js`), `app/public/sw.js` (SHELL +
  CACHE), `app/public/app.js` (loaders), `app/public/app.css` (state styles)
- Test: `tests/components-ui.mjs` (new), `tests/static-cache.test.cjs` (add `/components.js`)

**Interfaces:**
- Produces: `window.LocalAIUI.loadInto(container, load, { render, empty, what })`, where `load: () => Promise<T>`,
  `render: (container, T) => boolean`, `empty: string` (copy shown when `render` returns false), and `what: string`
  (for "Couldn't load {what}."). It shows `.state-loading` only after 300 ms, replaces content with `.state-error`
  ("Couldn't load {what}." + the error message + a Retry `.btn-outline`) on rejection, and returns the promise.
  `LocalAIUI.fetchJson(url, opt) → Promise<object>` rejects on non-2xx or non-JSON with the server's `error`.

- [ ] **Step 1: Failing tests** in `tests/components-ui.mjs` (390×844, against a server): on a fixture element,
  `loadInto` with a resolving loader renders; with `render → false` shows the `empty` copy; with a rejecting loader
  shows "Couldn't load runs." and a Retry button; Review Focus 5: success, then failure on Retry → the error state
  replaces the list, then success on a second Retry → the list again; a loader slower than 300 ms shows
  `.state-loading`; axe clean on the error state. With `/api/library` stubbed to 500, `#libraryGrid` shows
  "Couldn't load your library." (not "Nothing saved yet"); the same for `/api/activity` → `#activityList`.
- [ ] **Step 2: Run** `node tests/run-browser.mjs components`: FAIL.
- [ ] **Step 3: Implement** `components.js` and convert every view loader in `app.js` whose `catch{}` hides a failed
  list load (`loadActivity`, `loadLibrary`, `loadWorkspace`, and each `evoApi`/`api` list loader: inbox, approvals,
  memory, monitors, changes, issues, quality, PowerShell jobs, projects, knowledge, automations) to
  `LocalAIUI.loadInto`. `catch{}` blocks that are not list loads (JSON parse fallbacks, best-effort telemetry) stay.
- [ ] **Step 4: Run** `npm test` and `node tests/run-browser.mjs components mobile navigation`: PASS.
  **Commit:** `One load/empty/error state for every list` (closes `ui-swallowed-errors`).

### Task 5: Approval sheet replaces native confirm() and prompt()

**Files:**
- Modify: `app/public/components.js`, `app/public/app.css`, `app/public/app.js` (the 11 call sites)
- Test: `tests/components-ui.mjs`, plus `tests/security-contract.test.cjs` (add: no `confirm(`/`prompt(` in `app/public/*.js`)

**Interfaces:**
- Produces: `LocalAIUI.ask({ title, effect, confirmLabel, tone, typed, input }) → Promise<{ ok: boolean, value?: string }>`.
  `tone`: `'default'|'danger'|'host'`. `typed`: a word the user must type exactly before Confirm enables. `input`:
  `{ label, type:'text'|'password', placeholder }` for sheets that collect a value. A real `<dialog>` with
  `aria-labelledby`/`aria-describedby`, `showModal()`, focus on the first field (or Cancel), Escape and backdrop =
  cancel, focus restored to the opener, Confirm disabled after the first press. On phones it is a bottom sheet.
- Call sites and their exact copy:

| Site (`app.js`) | title | effect | confirmLabel | tone / typed / input |
|---|---|---|---|---|
| `newChat` | Start a new conversation? | Completed turns stay in Library. This draft is cleared. | New conversation | default |
| clear activity | Clear your activity? | System and recovery audit events are kept. | Clear activity | danger |
| delete Library item | Delete "{title}"? | It's removed from Library for good. | Delete | danger |
| `newProject` | New project | — | Create | input `{label:'Project name', type:'text'}` |
| `saveWorkbench` | Save {path}? | A timestamped backup is made first. | Save | default |
| `runComputerBatch` | Run {n} workspace operation(s)? | {first three ops, one per line} | Run | host, typed `RUN` |
| `runWorkbenchCommand` | Run "{cmd} {args}"? | In {cwd}. Allow-listed command. | Run | host, typed `RUN` |
| `applyChange` (self) | Deploy this change to Local AI? | Local AI restarts with the change; Safe Deploy rolls back on failure. | Deploy | host, typed `DEPLOY` |
| `applyChange` (workspace) | Apply this change to {root}? | {n} file(s) are written. | Apply | default |
| PowerShell approval key | Approval key | From C:\LocalAI\powershell-bridge\approval-key.txt on the host. Kept only in this tab. | Use key | input `{type:'password'}` |
| `queuePowerShellJob` | Queue this script on the Windows host? | It runs with the host bridge's permissions. | Queue | host, typed `RUN` |

- [ ] **Step 1: Failing tests** in `tests/components-ui.mjs`: `ask` resolves `{ok:true}` on Confirm and
  `{ok:false}` on Cancel, Escape and a backdrop click; with `typed:'RUN'` Confirm stays disabled until `RUN` is
  typed; `input` returns the typed value; Review Focus 4: a double click on Confirm resolves once and the `onConfirm`
  spy fires once, and after closing `document.activeElement` is the opener; axe clean with the sheet open at 390×844.
  `tests/security-contract.test.cjs`: `app/public/app.js` and `ui.js` contain no `confirm(` or `prompt(` call
  (regex `/(^|[^.\w])(window\.)?(confirm|prompt)\(/m`).
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** `ask` and convert the 11 sites with the copy above (each `if(!confirm(...))return` becomes
  `if(!(await LocalAIUI.ask({...})).ok)return`).
- [ ] **Step 4: Run** `npm test` and the browser suites: PASS. **Commit:** `One approval sheet for risky actions`
  (closes `ux-native-confirm`).

### Task 6: Run card and run view

**Files:**
- Modify: `app/public/components.js` (`runCard`), `app/public/ui.js` (`// ==== execution-runtime.js ====`:
  `makeRunRow`, `renderDrawer`, Home run center), `app/public/app.css`
- Test: `tests/run-execution-ui.test.cjs`, `tests/components-ui.mjs`

**Interfaces:**
- Consumes: Task 3's `item.card`, Task 2's `/api/runs/update`, Task 4's `components.js`, Task 5's `ask`.
- Produces: `LocalAIUI.runCard(item, { onOpen }) → HTMLElement` (`.list-row` with `.list-row__icon` sprite icon,
  title, summary, status badge, a progress bar while active, the preview (thumbnail / two-line text / diff stat), and
  one primary action button labelled `card.action.label`); `LocalAIUI.registerRunBody(kind, mount(run, el) → void)`;
  the run view is the existing drawer (`#runDrawerBackdrop`, `#runDrawer`) with, in order: a header (title, badge,
  project name or "Not filed", Pin and File… actions), the approval bar when `card.approval` is set (Approve /
  Reject through `ask`, `tone:'host'` and typed `APPROVE` when `risk==='high'`, POST `/api/approvals/decide`), the
  kind body slot (`registerRunBody`; default: the existing Output block), then Timeline. File… uses `ask` with
  `input` replaced by a project `<select>` (add `select: {label, options:[{value,label}]}` to `ask`'s options).

- [ ] **Step 1: Failing tests:**
  - `tests/run-execution-ui.test.cjs`: keep every current assertion; add that `ui.js` uses `LocalAIUI.runCard` and
    `registerRunBody`, and the run view mentions `Not filed`, `Pin` and `/api/runs/update`.
  - `tests/components-ui.mjs`, with `/api/runs` stubbed (one image run with a card preview, one engineering run
    awaiting approval with `approval.risk:'high'`): Runs shows two `.list-row` cards with the image thumbnail and
    the Review action; opening the engineering run shows the approval bar; Approve asks for `APPROVE` and then POSTs
    `/api/approvals/decide` with `{id, decision:'approved'}`; Pin POSTs `/api/runs/update {pinned:true}`; a body
    registered for `image` mounts in place of Output; axe clean on the open run view.
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement.** Home run center and Runs both render `runCard`; `window.LocalAIRuns.open` keeps its
  contract (returns `false` for an unknown id).
- [ ] **Step 4: Run** `npm test` and all browser suites: PASS; screenshot Runs and an open run view at 390×844 and
  1280×860. **Commit:** `Run card and run view`.

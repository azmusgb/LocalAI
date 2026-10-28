# Agent World Main Street, PR 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Agent World page (`#agents`) becomes the street. The full street fills the page, and tapping a building opens its close-up and its panel. Today's mission view stays one tap away, as the page's mission mode.

**Architecture:**
- **Engine** (`street.js`): gains a `full` mode (taller, larger zoom, `focus(id)`, snap on phones).
- **Buildings:** each gains a `panel(state, world)` describing what is in it.
- **Page module:** a new on-demand `app/public/street/page.js` owns street mode on `#agents`: the mount, the panel in the rail/sheet, the header, and switching to and from mission mode.
- **`ui.js`:** gets only a tiny hook. The old city renderer stays for mission mode until PR 5.

**Tech Stack:** Plain browser JS (IIFE modules, no build), Canvas 2D, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-agent-world-main-street-design.md`, especially:
- "Where it shows" (`#agents`, the full street: desktop street plus rail; on a phone, one building at a time with swipe and the sheet underneath).
- "The street" table (the "Tap opens" column).
- Delivery item 4.

**Already shipped (don't rebuild):**
- PRs #415, #419 and #421: `/api/world` street and crews, the engine, the ten buildings, `common.js`, `traffic.js`, `night.js`, and the def hooks `item`, `hidden`, `stamp`, `beacon` and `lights`.

## Rulings that shape this plan (owner may revisit)

1. **What "cutaway" means in PR 4.** Tapping a building in the full street gives a close-up: the camera centres on it and a soft spotlight marks it. Its panel then appears in the rail (desktop) or the sheet (phone). The panel shows a status line, up to 6 rows (needs you, unseen failures, running and recent, with no duplicates) and an "Open …" link.
   - Each building's art already shows its work through the windows.
   - Dedicated interior art for every building is out of scope. The Missions cutaway (floors and stair hand-offs) is PR 5.
2. **Two modes on `#agents`.** Street mode is the default. Mission mode is today's page (old city, mission head, crew, story and result) and is entered only by:
   - `#agents?mission=<id|latest>`;
   - tapping Missions HQ, or the "Open the mission" row in its panel;
   - starting a mission;
   - Replay, Demo or Watch mode from the More menu;
   - Work › Missions' "Open Agent World" banner, which now goes to `#agents?mission=latest`.

   In mission mode a "← Street" button (`#awToStreet`) returns to street mode. Watch mode stays on the old city until PR 5.
3. **Home's run links.** A Home chip with no specific run opens `#agents?place=<id>`, which is street mode focused on that building.
4. **Budgets:**
   - The street modules total rises to 72 KB gzipped. They are on-demand, not the shell, and are now 58.8 KB.
   - `street.js`'s own cap rises to 10 KB. It is the engine and is now 7.7 KB.
   - Both get dated notes in `tests/budgets.test.cjs`. Every other `street/*.js` file stays ≤ 8 KB.
   - Shell files (`ui.js`, `index.html`, `app.css`) may grow only by the markup and hook this plan names: under 1 KB gzipped in total, within the existing 294 KB shell budget.

## Global Constraints

- **Code style:** no npm runtime deps and no build step. Front-end files are plain IIFE scripts, and every `app/public/street/*.js` can also be `require()`d by Node tests.
- **Contracts:** don't rename any element id or route. `#agents` keeps its id and the deploy-contract ids: `agentWorldCityMount`, `agentTimeline`, `agentInspector`, `agentResultBody`, `agentMissionHistory`, `agentAdvancedPanel`. New ids are added, never substituted.
- **Text:** never painted into the canvas. Panels and chips are HTML set with `textContent`.
- **The idle rule still holds:** a quiet street draws nothing per frame. Polling stays as it is: one shared poller, 10 s, an 8 s timeout, and only while some street mount is on screen. A Home strip and a page street both mounted means one poll.
- **Reduced motion:** no smooth camera moves; focus snaps.
- **Wheel:** the plain vertical wheel is never captured.
- **Commits:** messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR title is release notes, written for the owner.

## Review Focus

1. **Arriving at `#agents` cold** (deep link, reload, back/forward between street and mission mode): the right mode shows, the URL reflects it, and Back returns to the previous mode or page without loops. Test: Task 4.
2. **A mission running while in street mode:** Missions HQ shows it (busy, a figure on a floor), and its panel offers "Open the mission". The page never switches to mission mode by itself. Test: Task 4.
3. **Phone:** one building fills the width and a swipe moves exactly one building (scroll-snap). The sheet's peek reads the focused building. The plain vertical page scroll is unaffected. Test: Task 1 and Task 5.
4. **Untrusted text** (run titles, model names, crew titles) in the panel rows appears as plain text, cut with "…", and never widens the page. Test: Task 2 and Task 4.
5. **Both mounts** (Home strip and page street): navigating Home → `#agents` → Home keeps one poller, with no duplicate requests and no leaked rAF loop. Test: Task 5.

---

### Task 1: Engine full mode and focus

**Files:**
- Modify: `app/public/street/street.js`, `app/public/app.css` (a few rules at the end), and `tests/budgets.test.cjs` (the `street.js` 10 KB cap and the 72 KB total, both with dated notes).
- Test: `tests/street-engine-ui.mjs`

**Interfaces:**
- **`mount(el, {mode: 'full', onOpen(id, item)})`:**
  - Its height is the container's height (`el.clientHeight`, which the page CSS gives as the stage height). The minimum is 300 CSS px.
  - `zoom = clamp(height/360, 0.8, 2)`.
  - Chips are the same component as the strip's.
  - On `max-width: 760px` the box gets `scroll-snap-type: x mandatory`, and each building slot is a snap point (`scroll-snap-align: center`; an invisible per-slot marker element is fine). The slot width becomes at least the box width, so one building fills it.
- **The mount handle gains `focus(id | null)`:**
  - It centres building `id` (smooth; instant under reduced motion).
  - It marks it focused: the engine draws a soft elliptical spotlight on the ground under the focused building, and the rest of the street gets a 15% dim overlay. Both are drawn per frame only while the focus animates in, then once into a cached layer.
  - `focus(null)` clears it.
  - `handle.focused()` returns the id.
- **`onFocus(id)` option:** called when the user's scroll/swipe settles with a different building centred (phones), so the page can update the panel.
- **The strip's behaviour is unchanged.**

- [ ] **Step 1: Write the failing tests** (own mount, `fresh()` page):
  - **Full mode at 1280×800 with a 480 px container:** the canvas is 480 CSS px tall and zoom ≈ 1.33.
  - **Focus:** `focus('foundry')` centres it (`|centre − box centre| < 4 px`); `focused() === 'foundry'`; `stats().stills` doesn't rise on refocusing the same id.
  - **Phone (390×844):** `scrollSnapType` contains `x`. Scrolling one slot and settling fires `onFocus` with the next building's id.
  - **Reduced motion:** `focus` is instant.
  - **A quiet full street:** frames are flat over 1 s after the focus settles.
  - **The strip is unchanged:** the existing strip checks pass untouched.
- [ ] **Step 2: Run** `node tests/run-browser.mjs street-engine`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `street-engine`, `home`, `npm test` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit:** `"street: a full-page street with focus and phone snapping"`.

### Task 2: Building panels

**Files:**
- Modify: `app/public/street/common.js` (`runsPanel`) and every building file (`panel`).
- Test: `tests/street-panels.test.cjs`

**Interfaces:**
- **`def.panel(state, world) -> {title, status, tone, rows: Row[], open: {label, to} | null, mission?: true}`**, with `Row = {id: string|null, title, note}`.
  - **`note`:**
    - 'Needs you' for a needs-you run;
    - 'Failed' for an unseen failure;
    - 'Running' for a running run;
    - 'Finished · <h:mm>' for a completed recent run (local time of `startedAt`);
    - 'Stopped' for a cancelled one;
    - 'Failed' for a failed recent one.
  - **Rows** come in the order needs you, failed unseen, running, recent. There are at most 6, with no duplicate ids.
  - **`title`** is `cut(title, 80)`.
  - **`status`** is the chip detail. **`tone`** is the chip tone.
- **`common.runsPanel(key, title, open)`** builds rows from `world.street[key]` for the runs buildings.
- **Open targets** (route strings for `LocalAIRouter.go`, or an absolute URL):

| Building | `open` | Rows |
|---|---|---|
| chat | `{label: 'Open Chat', to: '#ask'}` | runs |
| images | `{label: 'Open Images', to: '#create'}` | runs |
| missions | `{label: 'Open the mission', to: '#agents?mission=latest'}`, with `mission: true` | runs (a row tap opens that mission: `#agents?mission=<id>`) |
| garage | `{label: 'Open In progress', to: '#inProgress'}` | runs |
| sheets | `{label: 'Open Spreadsheets', to: '#spreadsheets'}` | runs from `street.sheets` |
| clock | `{label: 'Open Automations', to: '#automationStudio'}` | runs |
| foundry | `{label: 'Open Models', to: '#models'}` | one row per loaded model (`id: null`, title = name, note = '<sizeMb> MB'), then 'Queue: <n> waiting' when waiting > 0 |
| workshop | `{label: 'Open Pi Hub', to: 'http://10.0.0.30/'}` | none; status only |
| kiosk | `{label: 'Open Workshop display', to: '#integrations?card=workshop'}` | none |
| yard | `{label: 'Open Claude Code', to: '#claude'}` | one row per session (`id: null`, title = `cut(title, 80)`, note = 'Working' or 'Waiting') |

- **Pi Hub's address:** `#homeBack`'s `href` in `index.html` is the Pi Hub address. `page.js` reads it from that element, falling back to the literal.

- [ ] **Step 1: Write the failing table tests.** For each building:
  - busy, quiet and down;
  - order and dedup;
  - the cap of 6;
  - a 300-character title cut to 80 with '…';
  - a markup title kept as a plain string (no escaping needed; the page sets `textContent`).
- [ ] **Step 2: Run** `node --test tests/street-panels.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit:** `"street: each building says what's in it"`.

### Task 3: The street page module

**Files:**
- Create: `app/public/street/page.js`.
- Modify:
  - `app/public/home.js` (`STREET_MODS += 'page'`; Home's `onOpen` without an item now goes to `'#agents?place=' + id`; keep `home.js` within its budget);
  - `app/public/sw.js` (`SHELL` and a `CACHE` bump);
  - `app/public/index.html`: inside `.aw-city`, next to `#agentWorldCityMount`, add `<div id="awStreetMount" class="aw-street" hidden></div>`. Inside `#awSheetBody`, first, add `<section id="awPlace" class="aw-place" aria-live="polite" hidden></section>`. In `.aw-head__actions`, first, add `<button type="button" id="awToStreet" class="btn-outline" hidden>← Street</button>`;
  - the `agents` page activation (router or `ui.js`; find where the router applies a page with its query, e.g. `showView('agents')`), so it calls `LocalAIStreetLoad().then(() => LocalAIStreetPage.enter(query))`. This is the only `ui.js`/router change in this task;
  - `app/public/app.css`: `.aw-page[data-aw-mode="street"]` hides mission-only parts (`#agentWorldCityMount`, `.agent-mission-strip`, `.aw-crew`, `.aw-story-box`, `.agent-ops`, `#awEmpty`, `#awPrimary`, `#awRetry`) and shows `#awStreetMount` and `#awPlace`; `data-aw-mode="mission"` is today's look plus `#awToStreet`.
- Test: `tests/street-page-ui.mjs` (new).

**Interfaces:**
- **`window.LocalAIStreetPage = {enter(query: URLSearchParams), mode(): 'street'|'mission', toStreet(), toMission(missionId|'latest')}`.**
- **`enter(query)`:**
  - `query.mission` → mission mode with that mission.
  - Otherwise → street mode, focused on `query.place` if it is a known building id.
  - It sets `#agents[data-aw-mode]`, toggles the hidden attributes, and mounts the full street once into `#awStreetMount` (with `onOpen` and `onFocus`).
- **Street mode:**
  - **Header:** `#awTitle` = 'Agent World'; `#awStatus` = '<n> busy · <k> need you', or 'All quiet', from the current world's chip tones.
  - **`#awPlace`:** renders the focused building's `panel()`, re-rendering on each world for the focused building.
    - An `h2` title, a status line, then rows as buttons. A row with an `id` opens `LocalAIRuns.show(id)`; for Missions HQ it opens `toMission(id)`.
    - Then the open link. An absolute URL opens in the same tab, matching `#homeBack`.
  - **Chip tap in full mode:** focuses that building and shows its panel; `history.replaceState` to `#agents?place=<id>`. Missions HQ's chip goes to mission mode instead (`#agents?mission=latest`, with a push so Back returns to the street).
  - **Peek line on phones** (`#awSheetStatus`): '<Building>: <status>'.
- **Mission mode:**
  - Calls the existing mission code. `page.js` must not reimplement it; it hands over through the existing global that loads a mission by id, which Task 4 adds to `ui.js`.
  - Shows `#awToStreet`, which calls `toStreet()`, pushing `#agents`.
- **Hand-off contract with `ui.js`** (Task 4 implements the `ui.js` side): `page.js` calls `window.LocalAIMissionView?.show(id|'latest')` to enter and `window.LocalAIMissionView?.hide()` to leave. Until Task 4 lands, both are no-ops under `?.`.

- [ ] **Step 1: Write the failing browser tests** (`street-page-ui.mjs`; stub `/api/world` and runs with `page.route`):
  - `#agents` shows street mode: `data-aw-mode="street"`, `#awStreetMount` visible, `#agentWorldCityMount` hidden.
  - Tapping the Foundry chip shows `#awPlace` with 'Model Foundry' and 'Open Models', and the URL becomes `#agents?place=foundry`.
  - `#agents?place=garage` cold: focused on the garage, with its panel shown.
  - A needs-you row click calls `LocalAIRuns.show` with its id (spy).
  - A 300-character markup run title in a row is text, `scrollWidth <= innerWidth` at 390, and no `img` is created.
  - Phone 390×844: swiping one building updates the peek to the next building.
- [ ] **Step 2: Run** `node tests/run-browser.mjs street-page`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `street-page`, `street-engine`, `home`, `npm test` and `npm run lint`. Expected: PASS. Run the deploy validator and confirm the contract ids are intact.
- [ ] **Step 5: Commit:** `"Agent World: the page is the street"`.

### Task 4: Mission mode hand-off in `ui.js`, and routing

**Files:**
- Modify:
  - `app/public/ui.js`: in its `agent-world-city.js` and agents sections, the smallest hook possible;
  - the Work › Missions banner (`#workOpenAgentWorld` handler: find it with `grep -n workOpenAgentWorld app/public/*.js`) → `#agents?mission=latest`;
- Test: `tests/street-page-ui.mjs`, and the existing suites that open `#agents` expecting the mission view.

**Interfaces:**
- **`window.LocalAIMissionView = {show(id|'latest'), hide()}`:**
  - `show` renders that mission with today's code (`renderMission`, or `loadHistory`'s pick for 'latest'), unhides the old city and wakes it.
  - `hide` puts the old city to sleep: no rAF or polling from the old city while in street mode. That is today's visibility logic, triggered by the mount being hidden.
- **Mission-mode triggers (Ruling 2):** starting a mission (after `/api/agents/missions/start` succeeds), Replay, Demo and Watch mode from the More menu, `?mission=`, Missions HQ, and the Work banner. Each sets the URL to `#agents?mission=<id>` with a push.
- **Existing tests:** every existing browser suite that opens `#agents` expecting the mission view now opens `#agents?mission=latest`, or uses the trigger it exercises:
  - `agent-world-ui`, `mission-run-ui`, `agent-world-watch-ui`, `agent-world-landmarks-ui`, `agent-world-layers-ui`, `agent-operations-ui`, `axe-ui`, `perf-ui`, `visual-ui` and any other `grep -l "#agents" tests/*-ui.mjs` hit.
  - Keep each test's intent.
  - The visual baselines for `agents-*` pages stay the mission view (they open `?mission=…`). Add new baselines for the street page: `agents-street-desktop1440` and `agents-street-phone`.

- [ ] **Step 1: Write the failing tests** (`street-page-ui.mjs`):
  - `#agents?mission=latest` cold → mission mode; the city is visible; `#awToStreet` is visible.
  - Clicking `#awToStreet` → street mode; Back → mission mode again; Back → the previous page.
  - In street mode a running mission makes Missions HQ busy, and the page stays in street mode for 15 s (fake clock).
  - Starting a mission from the start dialog lands in mission mode.
  - In street mode the old city draws no frames (its frame or stat counter stays flat).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the hook and the triggers, and update the existing suites' `#agents` entry points.**
- [ ] **Step 4: Run the full browser suite** (`LOCALAI_URL=… npm run test:browser`), `npm test`, `npm run lint` and the deploy validator. Expected: all PASS, with only the street-page baselines new.
- [ ] **Step 5: Commit:** `"Agent World: missions open from the street, and back"`.

### Task 5: Polish, both mounts, phone, and screenshots

**Files:** modify only what the tests below find, plus `tests/home-ui.mjs`, `tests/perf-ui.mjs` and `tests/visual/darwin/` (the new street baselines and Home only).

- [ ] **Step 1: Write the failing tests.**
  - **Home → `#agents` → Home:** over 30 s of fake time on each, `/api/world` is requested at the single-poller rate. At most 1 rAF loop runs (`stats().frames` rises only for the visible mount).
  - **Perf:** the full street at 1440×900 and at 390×844 (DPR 3), with the flood world at night: `avgMs < 8`.
  - **Phone:** a vertical swipe over the street scrolls the page or sheet, not the street. A horizontal swipe moves exactly one building.
- [ ] **Step 2: Run them.** Expected: FAIL where not yet true.
- [ ] **Step 3: Fix what they find.**
- [ ] **Step 4: Run everything.**
  - `npm test`, `npm run lint` and the full browser suite.
  - Visual baselines: update `agents-street-*` and Home only, Read them, and revert other churn.
  - The deploy validator.
  - **Screenshots** to `.superpowers/street/pr4-*.png`: real `#agents` in street mode by day and night at 1440 and 390, with a building focused and its panel shown; mission mode with `#awToStreet` visible.
- [ ] **Step 5: Commit:** `"Agent World street: one poller, phone swipes, screenshots"`.

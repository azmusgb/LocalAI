# Agent World Main Street, PRs 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/world` reports every kind of work per building (PR 1). A live Main Street strip at the top of Home
draws six buildings at the art bar, and tapping it opens Agent World (PR 2).

**Architecture:**
- **Server:** a pure `buildStreet()` in a new `app/world-street.js` turns the run ledger into per-building lists.
  `createWorld` caches it and adds it, plus Claude crews, to the existing `/api/world` answer.
- **Client:** a new on-demand engine in `app/public/street/`. `street.js` handles canvas, camera, polling, chips and
  the loop. `art.js` holds the drawing kit, and there is one file per building. Home's `home.js` loads it and mounts
  it in a strip.

**Tech Stack:** Node 22 (`node:test`), plain browser JS (IIFE modules, no build), Canvas 2D, Playwright browser tests.

**Spec:** `docs/superpowers/specs/2026-10-27-agent-world-main-street-design.md`. The art bar is
`docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html`; open it in a browser before any art task.

**Scope:** PR 1 (Tasks 1–2) and PR 2 (Tasks 3–9). PRs 3–5 get their own plan after the owner reviews the Foundry
(Task 5, step 6), because that review may change the art kit they build on.

## Global Constraints

- **Dependencies and build:** no npm runtime dependencies, no build step. Front-end files are plain scripts, each an
  IIFE.
- **Styling:** use `--ds-*` tokens in CSS. `app/public/app.css` is one file in cascade order: add new rules at the
  end.
- **Contracts:** do not rename any element id or route. `#agents` and its contract ids stay.
- **`/api/world`:**
  - Keeps `schema: 1`, and keeps its existing per-source caching.
  - A read that is already under way is shared.
  - `null` means down or not set up.
  - No secrets or addresses.
  - No timestamps in the body other than item `startedAt`.
  - A poll that changes nothing gets a 304.
- **Street item shape:** `{id, title, status, startedAt}` exactly. Titles come from `readableTitle(run)`.
- **Caps:**
  - `running`: 3 per building.
  - `recent`: 3 per building.
  - `needsYou`: 3 per building.
  - `failedUnseen`: 3 per building.
  - `crews`: 6 sessions.
  - Titles: 80 characters.
- **Art:**
  - Vector art drawn in code at `devicePixelRatio`. Never pixelated (`imageSmoothingEnabled` stays true), and no
    image files.
  - Text is never painted into the canvas. Labels are HTML chips set with `textContent`.
- **Polling and frames:**
  - Poll every 10 s, only while a street mount is on screen and the tab is visible.
  - Frames run only while visible. With reduced motion there is no animation loop: one still frame per state change.
- **Night is off in PR 2.** `env.night` is always `false`. Night art is PR 3.
- **Size budget for `app/public/street/*.js`:** at most 48 KB gzipped in total and 8 KB gzipped per file.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR titles are release notes,
  written for the owner.

## Review Focus

1. **Hostile or odd titles** (`<img src=x onerror=…>`, 300-character prompts, emoji, RTL text) appear as plain text,
   cut with "…", and never break the chip layout. Tests: Task 1 (cap), Task 9 (rendered as text).
2. **A flood of work** (50 chats running, 200 queued images): each building shows at most 3 figures and a "+47"-style
   count, the server answer stays small, and the frame time stays within budget. Tests: Task 1 (caps and `waiting`),
   Task 9 (perf).
3. **A bad `/api/world` answer** (500, network error, invalid JSON, `schema: 2`): the strip keeps the last good
   picture, dims it and shows "Can't reach LocalAI, retrying". It never shows an empty street as if that were true.
   Test: Task 7.
4. **Resize, rotation and zoom** (phone rotates, a window is dragged to another-DPR display): the canvas backing size
   follows `clientWidth × devicePixelRatio` and the stills are redrawn, never stretched or blurred. Test: Task 6.
5. **One broken building** (its `drawLive` throws): every other building and chip keeps drawing, and the error is
   logged once, not every frame. Test: Task 6.

---

## PR 1: `/api/world` street data

### Task 1: `buildStreet()`, a pure run-ledger summary

**Files:**
- Create: `app/world-street.js`
- Test: `tests/world-street.test.cjs`

**Interfaces:**
- **Consumes:**
  - `readableTitle(run)` from `app/run-cards.js`.
  - `pick(runs, {now})` from `app/public/needs-you.js`, via `require('./public/needs-you')` as `server.js` does. Its
    CommonJS tail is the pattern the street building files copy in Task 4.
- **Produces:**
  - `streetKey(run) -> 'chat'|'images'|'missions'|'garage'|'sheets'|'clock'|null`
  - `buildStreet(runs: object[], {now: number}) -> {chat, images, missions, garage, sheets, clock}`, where each value
    is `{running: Item[], waiting: number, needsYou: Item[], failedUnseen: Item[], recent: Item[]}` and
    `Item = {id, title, status, startedAt}`
  - `STREET_KEYS = ['chat','images','missions','garage','sheets','clock']`
  - `crewList(live: object[]) -> {id, title, state: 'working'|'waiting', lastAction}[]`, capped at 6, with title and
    lastAction cut to 80 characters

**Mapping, after legacy types** (`mission` and `specialist` count as `agent`):

| Run type | Building |
|---|---|
| `chat`, `research` | `chat` |
| `image` | `images` |
| `agent` | `missions` |
| `engineering` | `garage` |
| `spreadsheet` | `sheets` |
| `automation` | `clock` |
| anything else | `null` (ignored) |

**Status rules:**

| List | Which runs | Order |
|---|---|---|
| `running` | status `running` or `streaming` | newest `createdAt` first |
| `waiting` | the count of `queued` plus running past the cap of 3 | n/a |
| `needsYou` | `awaiting_approval` among `pick()` | |
| `failedUnseen` | `failed` among `pick()` | |
| `recent` | `completed`/`failed`/`cancelled` | newest `finishedAt` (or `updatedAt`) first |

`startedAt` = `run.createdAt`.

- [ ] **Step 1: Write the failing tests** in `tests/world-street.test.cjs`:
  - `streetKey maps every run type`: a table over the mapping above, plus `{type:'mission'}` → `'missions'`,
    `{type:'nope'}` → `null` and `{}` → `null`.
  - `buildStreet caps running at 3 and counts the rest as waiting`: 5 running chats and 2 queued chats give
    `chat.running.length === 3` and `chat.waiting === 4`, with the newest first.
  - `buildStreet lists approvals and unseen failures per building`:
    - An `awaiting_approval` engineering run is in `garage.needsYou`.
    - A failed image (no `seenAt`, failed 1 h ago) is in `images.failedUnseen`.
    - The same failed image with `seenAt` set is not.
  - `buildStreet recent is the last 3 finished, newest first`.
  - `items carry exactly id, title, status, startedAt`:
    `assert.deepEqual(Object.keys(item).sort(), ['id','startedAt','status','title'])`.
  - `titles are readableTitle cut to 80`: a chat whose `meta.label` is 300 × `'é'` gets a title of length 80.
  - `every key is present when there are no runs`: `buildStreet([], {now})` deep-equals six empty buildings.
  - `crewList caps at 6 and trims`: 9 sessions in give 6 out, each with only the keys `id,lastAction,state,title`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test tests/world-street.test.cjs`. Expected: FAIL,
  `Cannot find module '../app/world-street'`.
- [ ] **Step 3: Implement `app/world-street.js`** with the exports above.
  - `'use strict'`, with a header comment in the style of `app/world.js`: what it is, who calls it, the caps.
  - It reads nothing itself: callers pass the runs.
- [ ] **Step 4: Run them and see them pass.** Run `node --test tests/world-street.test.cjs`. Expected: all PASS.
- [ ] **Step 5: Commit.**
  `git add app/world-street.js tests/world-street.test.cjs && git commit -m "world: buildStreet, every kind of work per Main Street building"`

### Task 2: `/api/world` serves `street` and `crews`

**Files:**
- Modify: `app/world.js`:
  - The header comment: add `street` and `crews`.
  - `createWorld` options.
  - `summary()`.
  - Exports.
- Modify: `app/server/changes.js:739-810`. Add `claudeLiveNow()` to the returned object.
- Modify: `app/server.js:689-693`. Pass `runs` and `crews` into `createWorld`.
- Test: `tests/world.test.cjs`

**Interfaces:**
- **Consumes:** `buildStreet`, `crewList` (Task 1).
- **Produces:**
  - `createWorld({... runs = () => [], crews = () => null})`. `runs()` returns recent public runs with `seenAt`
    merged, and `crews()` returns `claudeLive(...)` output or `null`.
  - `summary()` returns the existing fields plus `street` (the `buildStreet` result, or `null` if `runs()` throws)
    and `crews` (the `crewList` result, or `null`).
  - `LEDGER_MS = 5000`, exported.
- **Server wiring:**
  - `runs: () => runLedger.list({ limit: 200 }).map(withSeen(seenRuns()))`
  - `crews: () => claudeLiveNow()`
  - `claudeLiveNow = () => claudeLive(storage.listSettings(CLAUDE_SESSION_PREFIX), storage.listSettings(CLAUDE_EVENT_PREFIX, { limit: CLAUDE_LIVE_SCAN_EVENTS }), Date.now())`
  - Destructure `claudeLiveNow` from `createChanges(...)` with the others. `world` is created earlier at line 689,
    but the arrow only runs at request time, so that is fine.

- [ ] **Step 1: Write the failing tests** in `tests/world.test.cjs`, using the existing `fakeWorld(over)`:
  - `street comes from the ledger, read at most once per LEDGER_MS`:
    - Count `runs()` calls over two `summary()` calls at the same clock: 1 call.
    - Move the clock by `LEDGER_MS`, call `summary()` again: 2 calls.
    - `street.chat.running[0].id` equals the stub run's id.
  - `street is null when the ledger throws, and the rest still answers`: `runs: () => { throw new Error('x') }`
    gives `street === null` and `models.loaded.length === 2`.
  - `crews come from the board`: two stub sessions give `crews.length === 2`, and `crews: () => null` gives
    `crews === null`.
  - `an idle poll is still a 304`: through `api()` with the same stub runs, a second request with the first `ETag`
    gets a 304. Extend the existing 304 test's world with `runs`.
  - `the answer has no address or secret`: extend the existing secrets assertion to the new fields. A stub run whose
    `meta` holds `{token:'wsl_…', url:'http://10.0.0.5'}` must not leak.
- [ ] **Step 2: Run them and see them fail.** Run `node --test tests/world.test.cjs`. Expected: the new tests FAIL
  (`street` is undefined).
- [ ] **Step 3: Implement.**
  - **`app/world.js`:**
    - `const street = cached(() => buildStreet(runs(), { now: now() }), LEDGER_MS, now);` (`cached` already turns a
      throw into `null`).
    - `crewPart()` runs `crewList` on `crews()`, catching a throw as `null`.
    - Add both to `summary()`.
  - **`changes.js`:** add and export `claudeLiveNow`.
  - **`server.js`:** add the two options to the `createWorld` call.
- [ ] **Step 4: Run them and see them pass.** Run `node --test tests/world.test.cjs tests/world-street.test.cjs`,
  then `npm test`. Expected: all PASS.
- [ ] **Step 5: Smoke-test against a throwaway server.**
  - Start it as `CLAUDE.md` › Test describes, on port 3180.
  - Run `curl -s http://127.0.0.1:3180/api/world | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(Object.keys(j.street),j.crews)"`.
  - Expected: `[ 'chat', 'images', 'missions', 'garage', 'sheets', 'clock' ] []` (or `null`).
  - Stop the server.
- [ ] **Step 6: Commit, and open PR 1.**
  - `git add app/world.js app/server/changes.js app/server.js tests/world.test.cjs && git commit -m "world: /api/world reports every kind of work per building, and live Claude sessions"`
  - Push the branch `feat/street-data` and open the PR, titled
    "Agent World now knows about chats, images, changes, automations and Claude sessions (no visible change yet)".
  - Ship with `npm run ship -- <PR>`.

---

## PR 2: the engine and the Home strip

All PR 2 tasks are on branch `feat/street-home`, based on `main` after PR 1 merges.

### Task 3: Loader, shell, budget and the art kit

**Files:**
- Create: `app/public/street/art.js`
- Create: `app/public/street/street.js`. Only its skeleton here: `register`, `ORDER`, `defs()`. The engine itself
  comes in Task 6.
- Modify: `app/public/home.js`. Add `STREET_MODS` and `loadStreet()`, and expose `window.LocalAIStreetLoad`.
- Modify: `app/public/sw.js`. Add the `SHELL` entries for every `/street/*.js`, and bump `CACHE` by appending
  `-street1`.
- Modify: `tests/frontend-scripts.test.cjs` and `tests/budgets.test.cjs`
- Test: `tests/street-art.test.cjs`

**Interfaces:**
- **Produces, as globals:**
  - `window.LocalAIStreet.register(def)`, `.ORDER`, `.defs()`.
  - `window.LocalAIStreetArt` (below).
  - `window.LocalAIStreetLoad() -> Promise<void>`. It resolves once every module in `STREET_MODS` has loaded and
    rejects if any fails. It is idempotent.
- **`ORDER`** = `['chat','images','missions','garage','sheets','clock','foundry','workshop','kiosk','yard']`. A key
  with no registered def is skipped.
- **`STREET_MODS`** (in `home.js`) = `['art','street','chat','images','sheets','foundry','workshop','kiosk']`. They
  are loaded in order with `async=false` from `/street/<m>.js`.
- **`def` shape:**
  `{id, width, state(world) -> object, stillKey?(state) -> string, drawStill(ctx, state, env), drawLive(ctx, state, t, env), chip(state) -> {title, detail, tone: 'busy'|'quiet'|'down'|'attention'}, open?(item)}`
  - `width` is in scene units. The scene is 360 units tall, and the ground line (top of the sidewalk) is at
    `y = 300`.
  - A building draws in its own box, `x ∈ [0, width]`, `y ∈ [0, 360]`.
  - `env = {night: false, reduced: boolean, zoom: number, dpr: number}`.
- **`LocalAIStreetArt`**, each `(ctx, …)` and each drawing only, with no state:
  - Textures: `brick(ctx, x, y, w, h, {tone})`, `brickSide(…)`, `corrugated(ctx, x, y, w, h)`, `steel(ctx, x, y, w, h)`.
  - Light and glass: `glass(ctx, x, y, w, h)`, `glow(ctx, cx, cy, rx, ry, color, alpha)`, `rays(ctx, poly[], color, alpha)`.
  - Shadows: `softShadow(ctx, cx, cy, rx, ry)`.
  - People: `person(ctx, x, y, {vest, hat, prop: 'clipboard'|'wrench'|'tablet'|'hammer'|null, skin, pose: 0..1})`.
  - Objects: `crate(ctx, x, y, s)`, `smoke(ctx, x, y, t)`, `fire(ctx, x, y, w, h, t)`.
  - Scenery: `sidewalk(ctx, x, w)`, `road(ctx, x, w)`, `skyline(ctx, x, w, layer: 0|1)`.
  - `palette`, a frozen object of named colours taken from the art-bar file.
  - All of them match the art bar: gradients, rounded bricks with highlights, soft shadows via `ctx.filter = 'blur(…)'`
    or shadowBlur, and `ctx.imageSmoothingEnabled` never set false.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/frontend-scripts.test.cjs`:** add `every Main Street module is in the loader and precached, and none is in index.html`.
    It has the same three assertions as the `aw` test, against `app/public/street/*.js`, `STREET_MODS=[…]` in
    `home.js` and `'/street/<m>.js'` in `SHELL`.
  - **`tests/budgets.test.cjs`:** add `Main Street modules stay within their own budget (gzipped)`.
    - Total at most 48 KB, each file at most 8 KB.
    - Not loaded by the shell.
    - Its comment explains the art-bar reason for the size.
  - **`tests/street-art.test.cjs`:**
    - Load `art.js` into a `vm` context with a recording fake 2D context (a `Proxy` that logs method names and
      property sets).
    - `every helper draws without throwing`: call each helper.
    - `art never turns off smoothing`: no set of `imageSmoothingEnabled` to `false`.
    - `person draws every prop`: call it once per prop.
- [ ] **Step 2: Run them and see them fail.** Run
  `node --test tests/frontend-scripts.test.cjs tests/budgets.test.cjs tests/street-art.test.cjs`. Expected: FAIL (no
  `street/` directory).
- [ ] **Step 3: Implement** `art.js`, the `street.js` skeleton, `loadStreet` in `home.js` and the `SHELL` entries.
  - Write `art.js` with the art-bar file open next to it. The palette and shapes are lifted from its SVG
    (`brick`/`brickSide` patterns, `steel`/`glass`/`furnace`/`spill`/`crate` gradients, the worker figure).
- [ ] **Step 4: Run them and see them pass.** Run the same command. Expected: all PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "street: art kit, module loader, precache and budget"`

### Task 4: Building logic for all six (pure `state` and `chip`)

**Files:**
- Create: `app/public/street/chat.js`, `images.js`, `sheets.js`, `foundry.js`, `workshop.js` and `kiosk.js`. This
  task adds `id`, `width`, `state`, `stillKey` and `chip`, with `drawStill`/`drawLive` as no-op stubs. Each file ends
  with:
  ```js
  if (typeof module === 'object' && module.exports) module.exports = def; else root.LocalAIStreet?.register(def);
  ```
- Test: `tests/street-buildings.test.cjs`

**Interfaces:**
- **Consumes:**
  - The `/api/world` shape: Task 2, plus the existing `models`, `printer`, `sheets` and `kiosk` parts. Their fields
    are listed in `app/world.js` `summary()`.
  - The `def` shape (Task 3).
- **Produces** `state(world)` per building, with these fields. A source of `null` gives `{down: true}` plus the
  defaults.

| Building | `width` | `state(world)` fields |
|---|---|---|
| `chat` | 240 | `{running: n ≤ 3, more: n, needsYou: n, failed: n, down}`. `down` when `world.street === null`. |
| `images` | 240 | the same, from `street.images` |
| `sheets` | 220 | `{working: inFlight > 0 \|\| running > 0, bridge: true\|false\|null, excel: true\|false\|null, down: bridge === null}` |
| `foundry` | 320 | `{model: loaded[0]?.name \|\| null, loaded: n, queued: queue?.waiting \|\| 0, down: loaded === null}` |
| `workshop` | 260 | `{setUp, state, progress, minutesLeft, error: state === 'error', down: setUp && access !== 'ok'}` |
| `kiosk` | 140 | `{setUp, online, firmware, down: setUp && online !== true}` |

- **`chip(state)`** copy, exact:

| Situation | Chip |
|---|---|
| Down | `{title: <Name>, detail: 'Not answering', tone: 'down'}` |
| Not set up (workshop, kiosk) | `{title, detail: 'Not set up', tone: 'quiet'}` |
| Foundry busy | `detail: '<model> loaded · <n> waiting'`, or `'<model> loaded'` when 0 waiting; `tone: 'busy'` |
| Foundry quiet | `'No model loaded'` |
| Chat / Images busy | `'<n> running'`, plus `' · <k> need you'` when needsYou > 0, in which case `tone: 'attention'` |
| Chat / Images quiet | `'Quiet'` |
| Workshop | `'Printing · <p>% · <m> min left'`, `'Error'` (`attention`), or `'Idle'` |
| Sheets | `'Working'`, `'Ready'`, or `'Excel not open'` when `bridge` is true and `excel` is false |
| Kiosk | `'Online · <firmware>'` or `'Online'` |

- **Names:** Chat Café, Image Studio, Spreadsheets Office, Model Foundry, Workshop Garage, Kiosk Billboard.
- **`stillKey(state)`** covers only what the still art shows: lit or unlit, down, and for the Workshop the door being
  up. It does **not** include `progress`, so a moving percentage never rebuilds the still.

- [ ] **Step 1: Write the failing table tests**, one `test()` per building. For each building, cover:
  - the busy world
  - the quiet world
  - the down world (the source is `null`)
  - not set up, where it applies
  - a 300-character model name or title. The chip `detail` must stay ≤ 60 characters and end with `'…'`.

  Also assert `stillKey(busy) !== stillKey(quiet)`, and for the Workshop
  `stillKey({…progress: 10}) === stillKey({…progress: 90})`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test tests/street-buildings.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the six defs' logic, with stub draws.
- [ ] **Step 4: Run them and see them pass.** Run `node --test tests/street-buildings.test.cjs && npm test`.
  Expected: all PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "street: what each of the first six buildings shows"`

### Task 5: The Model Foundry at the art bar, then the owner's review

**Files:**
- Modify: `app/public/street/foundry.js`. Write its `drawStill` and `drawLive`.
- Modify: `app/public/street/art.js`, only if the Foundry needs a helper that's missing.
- Create: `tests/street-gallery.html`. A dev-only page that is not served from `public/`. It loads `art.js` and the
  building files with `file://` script tags, and draws each building in busy, quiet and down states side by side at
  zoom 1, using a stub world.

**What it must show**, matching the art bar (`assets/2026-10-27-agent-world-art-bar.html`):
- **Structure:** a hazy skyline layer behind; a brick front with a side wall in perspective; a corrugated roof with a
  steel trim; a chimney with smoke; a big glass window, with a frame, mullions and a reflection, that you see the hall
  through.
- **Inside the hall, when busy:** a furnace glowing with flicker; the crucible swaying and pouring a molten stream; a
  conveyor with a crate per queued job (up to 4, then nothing more); light rays.
- **The doorway:** a lit door with a worker holding a clipboard. There's a soft shadow under everything.
- **Quiet:** the furnace is dark, there's no smoke, the crucible is still and the conveyor is empty.
- **Down:** windows boarded with planks, no light.

- [ ] **Step 1:** Implement `drawStill` (everything static for the state) and `drawLive` (fire, smoke, pour,
  conveyor, rays, and the worker's small idle motion, all driven by `t` in ms).
- [ ] **Step 2: Render the gallery.**
  - Open `tests/street-gallery.html` in Playwright at 1440×900, DPR 2, and screenshot to
    `.superpowers/street/foundry.png`.
  - Compare it side by side with the art-bar file screenshotted at the same size.
  - Expected: the same composition and materials, at equal or better detail.
- [ ] **Step 3: Check the frame cost.**
  - In the gallery, time 120 `drawLive` calls for the busy state at zoom 1, DPR 2.
  - Expected: a mean under 2 ms per call.
- [ ] **Step 4: Run `npm test`.** Expected: PASS, including the budget, with `foundry.js` at most 8 KB gzipped.
- [ ] **Step 5: Commit.**
  `git commit -m "street: the Model Foundry, drawn at the art bar"`
- [ ] **Step 6: STOP for the owner's review.**
  - Show the owner the Foundry gallery screenshot, busy, quiet and down, next to the art bar.
  - Do not start Task 6 until they approve.
  - Fold any change they ask for into `art.js`/`foundry.js` and repeat steps 2–5.

### Task 6: The engine: mount, camera, stills cache, loop, chips

**Files:**
- Modify: `app/public/street/street.js`
- Modify: `app/public/app.css`, appending a `/* Main Street */` section with `.street`, `.street__canvas`,
  `.street-chip` (and its `--busy`, `--quiet`, `--down` and `--attention` variants) and `.street.is-stale`.
- Test: `tests/street-engine-ui.mjs`

**Interfaces:**
- **Consumes:** `register`/`defs` (Task 3), and the building defs (Tasks 4–5).
- **Produces:**
  - **`LocalAIStreet.mount(el, {mode: 'strip', onOpen(id)}) -> {destroy()}`:**
    - Creates `<div class="street"><canvas class="street__canvas"></canvas><div class="street__chips"></div></div>`
      in `el`.
    - The strip is 160 CSS px tall, or 132 at `max-width: 760px`. Zoom = `canvasCssHeight / 360`.
    - Buildings are laid out left to right in `ORDER`, with a 24-unit gap.
    - On desktop, the camera fits the whole street if it fits, and otherwise scrolls horizontally with drag, wheel
      and shift-wheel. On a phone it scrolls with native horizontal swipe.
    - When the street doesn't fit, a `setWorld` that changes a building's `stillKey` scrolls that building into view
      (smoothly; instantly with reduced motion), unless the person scrolled in the last 10 s.
  - **`LocalAIStreet.setWorld(world)`:** the poller and tests call it. It recomputes each `state`, rebuilds a still
    only when its `stillKey` changes, and updates the chips.
  - **`LocalAIStreet.stats() -> {frames, avgMs, stills}`:** a test and perf hook. `stills` counts still rebuilds.
- **Chips:**
  - One per building, absolutely placed over its roof line.
  - Text is set with `textContent` only.
  - Each chip is a `<button type="button">` whose `aria-label` is `"<title>: <detail>"`. Clicking it calls
    `onOpen(id)`.
- **Stills:** one offscreen canvas per building, keyed `id|zoom|dpr|night|stillKey`. Rebuilt on that key's change and
  on resize.
- **Loop:**
  - `requestAnimationFrame`, capped at 30 fps.
  - Runs only while `el` intersects the viewport (IntersectionObserver), the document is visible and reduced motion is
    off. With reduced motion, one frame is drawn per `setWorld` or resize, with `t = 0`.
- **Errors:** wrap each building's `drawLive` in `try/catch`. On a throw, skip that building for the frame and
  `console.warn` once per building id.

- [ ] **Step 1: Write the failing browser tests** in `tests/street-engine-ui.mjs`. Use the `check()` style of
  `tests/agent-world-landmarks-ui.mjs`. Each test mounts on a blank test page via
  `page.goto(base + '/#home')`, then `LocalAIStreetLoad()`, then `mount(document.body.appendChild(div), {mode: 'strip'})`,
  then `setWorld(BUSY)`.
  - `six chips in street order with the right words`: the chip texts in DOM order start with Chat Café, Image Studio,
    Spreadsheets Office, Model Foundry, Workshop Garage and Kiosk Billboard. The Foundry chip includes
    `'qwen3:4b-instruct-32k loaded · 2 waiting'`.
  - `a title with HTML is text`: a world whose model name is `'<img src=x onerror=window.__x=1>'` shows that literal
    text in the chip, and `window.__x` is undefined.
  - `stills rebuild only when the picture changes`:
    - `setWorld(BUSY)` twice: `stats().stills` is unchanged.
    - Change only `printer.progress`: still unchanged.
    - Set `models.loaded = []`: it goes up by 1.
  - `canvas follows size and DPR`:
    - At 1280×800, DPR 1: `canvas.width === clientWidth`.
    - `page.setViewportSize` to 390×844, with a new context at DPR 3: `canvas.width === clientWidth * 3`.
  - `one broken building doesn't stop the street`:
    - Register `{id: 'yard', width: 100, state: () => ({}), chip: () => ({title: 'Y', detail: 'y', tone: 'quiet'}), drawStill() {}, drawLive() { throw new Error('boom') }}`.
    - Run 30 frames. The other chips are still there, `stats().frames` keeps rising, and `console.warn` was called
      exactly once with `'yard'`.
  - `reduced motion draws once, then stops`: with `emulateMedia({reducedMotion: 'reduce'})`, `stats().frames` is the
    same 1 s apart.
  - `off screen, no frames`: after `el.style.marginTop = '5000px'`, frames stop rising.
- [ ] **Step 2: Run them and see them fail.**
  - Start a throwaway server (CLAUDE.md › Test) on port 3180.
  - Run `LOCALAI_URL=http://127.0.0.1:3180 node tests/run-browser.mjs street-engine`.
  - Expected: FAIL (`mount` is not a function).
- [ ] **Step 3: Implement the engine and CSS.**
- [ ] **Step 4: Run them and see them pass.** Run the same command. Expected: all PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "street: engine (camera, cached stills, 30 fps loop only on screen, chips)"`

### Task 7: The shared poller and the stale state

**Files:**
- Modify: `app/public/street/street.js`
- Test: `tests/street-engine-ui.mjs` (add to it)

**Interfaces:**
- **Produces:**
  - **The poller:** started by the first mount and stopped by the last `destroy()`.
    - Every 10 s it runs `fetch('/api/world', {cache: 'no-cache', credentials: 'same-origin'})`, one request at a time.
    - It pauses while no mount is on screen or `document.hidden`. On becoming visible again, it polls at once.
    - An answer that is `ok`, valid JSON with `schema === 1` goes to `setWorld`. Anything else counts as a failure.
  - **Stale:** after a failure, every mount gets the class `is-stale` (the canvas at `opacity: .55`) and one extra
    chip `.street-chip--stale`, reading `"Can't reach LocalAI, retrying"`. The next good answer clears both. The last
    good world stays drawn.
  - **Before the first good answer:** nothing is drawn and the mount stays `hidden`, so Home shows no empty street.
- [ ] **Step 1: Write the failing tests** (the server's `/api/world` stubbed with `page.route`):
  - `polls every 10 s only while visible`: with a fake clock (`page.clock.install()`), advance 30 s and count 4
    requests (the first plus 3). Set `document.hidden` via `visibilitychange` emulation, advance 30 s: no new
    requests.
  - `bad answers keep the last picture and say so`. After one good answer, each of these in turn: a 500, an
    `abort()`, the body `'{'`, and `{schema: 2}`. Each time `.street.is-stale` is present, the stale chip text matches
    exactly and the six building chips keep their last text. Then a good answer clears it.
  - `nothing shows before the first answer`: route `/api/world` to hang. The mount stays `hidden`.
- [ ] **Step 2: Run them and see them fail.** Run `node tests/run-browser.mjs street-engine`. Expected: the new
  tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.** Expected: all PASS.
- [ ] **Step 5: Commit.**
  `git commit -m "street: one shared /api/world poller; a failed poll dims the street and says so"`

### Task 8: The other five buildings at the art bar

**Files:**
- Modify: `app/public/street/chat.js`, `images.js`, `sheets.js`, `workshop.js` and `kiosk.js`, writing each one's
  `drawStill`/`drawLive`.
- Modify: `tests/street-gallery.html`, so it shows all six.

**Each building is drawn with the `art.js` kit, at the Foundry's level of detail.** Busy, quiet and down follow the
Foundry's pattern: quiet means no light or motion, and down means boarded with no light.

| Building | Busy |
|---|---|
| Chat Café | A café front with an awning and a big window. A figure per running chat, up to 3, at the counter, each with a speech bubble whose dots animate. A "+n" badge drawn as a shape (the number goes on the chip, not the canvas). |
| Image Studio | A tall studio with a skylight and an easel in the window. The canvas fills in with colour bands over a 6 s cycle, and a painter's arm moves. |
| Spreadsheets Office | A two-storey office with a grid of windows. Lit windows tick on and off in a pattern, and a figure sits at a desk with a monitor. When `bridge` is true and `excel` is false: lit, with a dim screen. |
| Workshop Garage | A roll-up door, open while printing, with the printer inside. The door's progress bar is drawn from `state.progress` in `drawLive` (not the still). A red beacon on error. Closed and dark when idle. |
| Kiosk Billboard | A billboard on legs with a screen that glows softly when online, and dark when offline or not set up. |

- [ ] **Step 1:** Implement the five, one commit each:
  `git commit -m "street: <Building>, drawn at the art bar"`.
- [ ] **Step 2: Gallery screenshot and frame cost.**
  - Screenshot to `.superpowers/street/all.png`.
  - Time `drawLive` for each building in its busy state. Expected: a mean under 2 ms each.
- [ ] **Step 3: Run `npm test`** (the budget especially). Expected: PASS.

### Task 9: The Home strip, end to end

**Files:**
- Modify: `app/public/index.html:31`. After `</header>`, add
  `<section id="homeStreet" class="home-street" aria-label="Agent World" hidden><div id="homeStreetMount"></div></section>`.
- Modify: `app/public/home.js`.
  - On `activate()`, call `LocalAIStreetLoad()` and then `mount(#homeStreetMount, {mode: 'strip', onOpen: id => LocalAIRouter.go('#agents')})`.
    `#agents` is still the old city in PR 2. Opening it focused on building `id` comes with the full street in PR 4.
  - Unhide `#homeStreet` on the first good world. The engine already keeps it hidden until then: Task 7.
  - If loading fails, leave it hidden and log once.
  - Don't remount on repeat activations.
- Modify: `app/public/app.css`. Add `.home-street`: margin, radius `var(--ds-radius-lg)` and border
  `var(--ds-border)`.
- Modify: `tests/home-ui.mjs`, `tests/perf-ui.mjs` and the `tests/visual/darwin/` Home baselines.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/home-ui.mjs`:**
    - `Home shows Main Street once the world answers`: `#homeStreet` is visible, with 6 chips.
    - `tapping a building opens Agent World`: clicking the Model Foundry chip gives `location.hash === '#agents'`.
    - `a long title doesn't widen Home`: with a stubbed world whose model name is 300 characters,
      `document.documentElement.scrollWidth <= innerWidth` at 390 px.
  - **`tests/perf-ui.mjs`:** add `Main Street strip stays within its frame budget`.
    - At 390×844, DPR 3, with the BUSY world, wait 3 s.
    - `stats().avgMs < 8`.
    - The phone CPU is throttled the way the file's existing checks do it. Follow their setup.
- [ ] **Step 2: Run them and see them fail.** Run
  `LOCALAI_URL=http://127.0.0.1:3180 node tests/run-browser.mjs home perf`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement** the index.html, home.js and app.css changes.
- [ ] **Step 4: Run them and see them pass.** Run the same command, then the whole browser suite with
  `LOCALAI_URL=http://127.0.0.1:3180 npm run test:browser`. Expected: all PASS, apart from the visual Home pages,
  which have changed.
- [ ] **Step 5: Update the visual baselines.**
  - Run `LOCALAI_VISUAL_UPDATE=1 node tests/visual-ui.mjs`.
  - Open the new Home PNGs (phone and desktop) and check them. The quiet street should show "Not answering" for the
    Foundry, since the visual server has no Ollama, plus "Not set up" for the workshop and kiosk.
  - Commit them.
- [ ] **Step 6: Run the deploy validator.** Run
  `pwsh -NoProfile -File deploy/Test-LocalAI-Candidate.ps1 -CandidateRoot . -LocalNode`. Expected: it passes, and
  the contract ids are unchanged.
- [ ] **Step 7: Commit and open PR 2.**
  - Commit: `git commit -m "Home: a live Main Street strip that opens Agent World"`.
  - PR title: "Home now shows Main Street: a live street of your chats, images, models, printer, Spreadsheets and the
    kiosk".
  - The PR body has the gallery screenshots.
  - Run `npm run ci -- <PR>`, then ship with `npm run ship -- <PR>`.
  - Confirm with `/healthz` that `releaseCommit` equals the merge commit.

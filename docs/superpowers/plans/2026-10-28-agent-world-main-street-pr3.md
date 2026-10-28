# Agent World Main Street, PR 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the street on Home. This means:
- **Four new buildings:** Missions HQ, Repair Garage, Clock Tower and Claude Yard.
- **Needs-you beacons.**
- **Cars:** stalled cars for unseen failures, and cars driving off when runs finish.
- **Night lighting.**
- **Run links:** tapping a building that has something specific goes to that run.

**Architecture:** This extends the shipped engine (`app/public/street/street.js`, #419) and its building contract. Shared building helpers move into a new `common.js`, and the four buildings follow `foundry.js`'s pattern. Cars, beacons and night lighting are engine layers that work from what each building declares (`roof`, `lights(state)`), so buildings stay focused on their own art.

**Tech Stack:** Plain browser JS (IIFE modules, no build), Canvas 2D, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-agent-world-main-street-design.md` ("The street", "Look", Delivery item 3). Art bar: `docs/superpowers/specs/assets/2026-10-27-agent-world-art-bar.html`. Reference buildings: `app/public/street/foundry.js` (most detailed) and `chat.js`.

**Already shipped, don't rebuild:**
- `/api/world` `street` and `crews` (#415).
- The engine, poller, stale state, the idle loop stop, parallax (skyline layers at 0.5× and 0.25×) and the six buildings (#419).

## Global Constraints

- **Code style:** no npm runtime deps and no build step. Front-end files are plain IIFE scripts, and every `app/public/street/*.js` is also `require()`-able from Node tests (the CommonJS tail pattern in `chat.js`).
- **Art:** drawn in code at `devicePixelRatio`, never pixelated, no image files. Text is never painted into the canvas. Labels are HTML chips set with `textContent`.
- **Building contract:** `drawStill` draws everything static for the state (cached per `stillKey`). `drawLive` draws only what moves. Every building declares `animates(state)`. A quiet street draws nothing per frame.
- **Down or not set up:** boarded windows and no light; never a fake state.
- **Polling:** the poller is unchanged: 10 s, 8 s timeout, 2 s minimum gap, only while on screen.
- **Wheel:** the plain vertical wheel is never captured.
- **Contracts:** don't rename element ids or routes. `#homeStreet` is never `hidden`.
- **Budgets:**
  - `app/public/street/*.js`: each file ≤ 8 KB gzipped; the total ≤ 60 KB gzipped. The 48 → 60 KB raise lands in Task 1 with a dated note.
  - App shell total ≤ 294 KB.
  - `home.js` ≤ 12 KB, and is not touched in this PR.
- **Motion and battery:**
  - **Beacons and hazard lights:** pulse for 60 s after they first appear (per item id), then stay steadily lit, so a long-unseen failure doesn't keep the strip animating.
  - **Reduced motion:** no pulses, no driving cars, and every state shown statically.
- **Night:** on from 19:00 to 07:00 local time, re-checked once a minute while a strip is mounted. `env.night` reaches every building, and night is part of the stills key.
- **Commits:** messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR title is release notes, written for the owner.

## Review Focus

1. **A flood of asks** (10 approvals and 10 failures across buildings): at most one beacon and one stalled car per building, the strip stays readable, and the frame time stays within the perf budget. Tests: Task 6 and Task 8.
2. **Night at the boundary** (18:59 → 19:00, page left open overnight): the street switches within a minute, stills rebuild once, nothing flickers, and the idle stop still works at night. Test: Task 7.
3. **Developer tools turned off while the strip is open:** the Claude Yard disappears at the next world, and the layout re-flows without a gap. Test: Task 5.
4. **A run finishing while the strip is off screen or the tab is hidden:** no queued burst of cars when it comes back; only finishes seen while visible drive off. Test: Task 6.
5. **Odd crew titles** (300 characters, markup, RTL): appear only in the chip, as text. Test: Task 5.

---

### Task 1: Shared building helpers, budget, and the `animates` contract

**Files:**
- Create: `app/public/street/common.js`
- Modify:
  - `app/public/street/chat.js`, `images.js`, `sheets.js`, `foundry.js`, `workshop.js` and `kiosk.js`: use `common.js`.
  - `app/public/home.js`: `STREET_MODS` gains `'common'` after `'street'`. This is the only `home.js` change.
  - `app/public/sw.js`: `SHELL` gets `/street/common.js` and a `CACHE` suffix bump.
  - `tests/budgets.test.cjs`: the street total goes 48 → 60 KB, with a dated note on why (ten buildings, cars and night at the art bar; on-demand, not shell).
- Test: `tests/street-common.test.cjs`, and extend `tests/street-buildings.test.cjs`.

**Interfaces:**
- **Produces** `window.LocalAIStreetCommon`, also `module.exports` under Node. A building file gets it with
  `const C = typeof module === 'object' && module.exports ? require('./common.js') : root.LocalAIStreetCommon`.
  - `cut(s: string, n = 60) -> string`: if longer than n, return the first n-1 characters plus '…'.
  - `count(v) -> int`: a finite positive number floored, else 0.
  - `asks(src) -> {needsYou: int, failed: int, first: Item|null}`: from a `street[key]` entry. `first` is `needsYou[0] || failedUnseen[0] || null`.
  - `runsBuilding({id, key, title, width, roof}) -> {id, width, roof, state, stillKey, chip, animates, item}`: the logic half of a work building.
    - `state(world)` → `{running ≤3, more, needsYou, failed, first, down}`. `down` when `world.street` is null.
    - `stillKey` → `'down' | 'lit' | 'unlit'`.
    - `chip` → title; detail is 'Not answering', 'Quiet', or `'<running+more> running'` with `' · <k> need you'` and/or `' · <f> failed'` appended. Tone is `'attention'` when k or f > 0, else `'busy'`/`'quiet'`/`'down'`. The detail goes through `cut()`.
    - `item(state) -> Item|null`: returns `state.first`, or `running[0]` when there's no ask.
    - `animates(state)`: `running + more > 0`.
    - Each building file then adds its own art: `Object.assign(C.runsBuilding({...}), {drawStill, drawLive, lights})`.
- **Every def must expose `animates`.** A unit test loads every `street/*.js` building file and asserts `typeof def.animates === 'function'`.

- [ ] **Step 1: Write the failing tests.**
  - `cut`, `count` and `asks` tables.
  - `runsBuilding` chip copy: 'Quiet'; '3 running'; '50 running' for 3 running + 47 waiting; '2 running · 1 need you' (attention); '1 failed' with tone attention when nothing is running; 'Not answering' when street is null.
  - `item()` picks needsYou, then failed, then running.
  - Every building def has `animates`.
  - **Update the chat and images chip tables:** a failed run now adds `' · <f> failed'` with tone attention. That's a deliberate copy change: the spec says failures must be visible.
- [ ] **Step 2: Run** `node --test tests/street-common.test.cjs tests/street-buildings.test.cjs`. Expected: FAIL (no common.js).
- [ ] **Step 3: Implement** `common.js`, and refactor the six buildings.
  - `chat` and `images` use `runsBuilding` for logic, keeping their own `drawStill`/`drawLive`.
  - Every file uses `C.cut`. No behaviour change except the failed suffix.
  - The `sheets` chip appends the same `' · <k> need you'` / `' · <f> failed'` suffix from `C.asks(street.sheets)`, with tone attention when either is above 0.
- [ ] **Step 4: Run** `npm test` (budgets included) and `node tests/run-browser.mjs street-engine home`. Expected: PASS. Note the street total in gzipped KB in the commit message body.
- [ ] **Step 5: Commit:** `"street: shared building helpers; failures show on the chips"`.

### Task 2: Engine: per-building run links and hidden buildings

**Files:**
- Modify: `app/public/street/street.js`
- Test: `tests/street-engine-ui.mjs`

**Interfaces:**
- **Consumes:** `def.item?(state) -> Item|null` (Task 1).
- **Produces:**
  - `mount(el, {mode, onOpen(id, item)})`: a chip click calls `onOpen(def.id, def.item?.(state) ?? null)`.
  - `mountHome()`'s `onOpen` becomes `(id, item) => item && root.LocalAIRuns?.show ? root.LocalAIRuns.show(item.id) : root.LocalAIRouter.go('#agents')`.
  - Chip hint text: 'Opens this run' when `item` is non-null, else 'Opens Agent World'. This replaces the fixed `HINT`.
  - A state with `hidden: true` removes that building from layout, drawing and chips until a world makes it visible again. The layout re-flows.

- [ ] **Step 1: Write the failing tests** (own mount; stub `window.LocalAIRuns = {show: id => window.__shown = id}`):
  - Clicking a chat chip whose state has needsYou `[{id: 'r1', …}]` calls `show('r1')`.
  - Clicking a quiet chip goes to `#agents`.
  - The hint text follows `item`.
  - A test def whose state returns `{hidden: true}` has no chip, and the next building moves left. Setting it visible again restores the chip.
- [ ] **Step 2: Run** `node tests/run-browser.mjs street-engine`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it again. Expected: PASS.
- [ ] **Step 5: Commit:** `"street: a building with something specific opens that run"`.

### Tasks 3–5: The four new buildings

Each building file uses `common.js` for logic where it's a work building, and is drawn at the Foundry's level of detail in the art bar's language. Every building needs:
- Distinct silhouettes at strip zoom (≈0.44), with static parts in the still.
- `animates` declared, and a `tests/street-<id>-draw.test.cjs` that pins "busy frames don't repaint the still", and that quiet and down frames are empty.
- A `lights(state)` (see Task 7; until then, return `[]`).
- A `roof`: the y of its roof line in building coordinates (0 = top of the scene, ground at 300). The engine already places the chip from it, and it anchors the beacon.

Append each to `STREET_MODS` (`home.js`) and `SHELL` (`sw.js`) when its file is created, and extend `tests/street-gallery.html` to include it.

#### Task 3: Missions HQ and Repair Garage

**Files:** create `app/public/street/missions.js` and `garage.js`, and `tests/street-missions-draw.test.cjs` and `street-garage-draw.test.cjs`. Modify `home.js` (STREET_MODS), `sw.js` and the gallery.

| Def | Setup | Busy | Quiet | Down |
|---|---|---|---|---|
| `missions` | `runsBuilding({id: 'missions', key: 'missions', title: 'Missions HQ', width: 260, roof: 90})` | A three-storey office with a blue command-centre band. Lit floors; up to 3 figures moving between windows on different floors, one per running mission; a roof antenna with a blinking light. Storefront only, no cutaway (that's PR 5). | Dark floors, antenna light off. | Boarded. |
| `garage` | `runsBuilding({id: 'garage', key: 'garage', title: 'Repair Garage', width: 240, roof: 160})` | A brick garage with two bays. A car on a raised lift in the open bay and a mechanic underneath with a wrench (`person({prop: 'wrench'})`); sparks now and then. | Bays shut, dark. | Boarded. |

- [ ] **Step 1: Failing tests.**
  - Each building's draw test, following the Foundry's pattern.
  - Chips: 'Missions HQ' / 'Repair Garage' through the Task 1 tables.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement both,** iterating on gallery screenshots against the art bar and the existing six (save `.superpowers/street/pr3-missions-garage.png`).
- [ ] **Step 4: Verify.** `npm test`. Each busy `drawLive` mean < 2 ms at zoom 1, DPR 2 (the gallery timing hook).
- [ ] **Step 5: Commit,** one commit per building.

#### Task 4: Clock Tower

**Files:** create `app/public/street/clock.js` and `tests/street-clock-draw.test.cjs`. Modify `home.js`, `sw.js` and the gallery.

`runsBuilding({id: 'clock', key: 'clock', title: 'Clock Tower', width: 140, roof: 60})`:
- **Shape:** a narrow stone tower with a clock face and a bell in an open belfry.
- **Clock hands:** always show the real local time (hour and minute), drawn in `drawLive` only when busy. When quiet, the still shows the time at its last rebuild. **Ruling:** a quiet clock may be up to an hour stale; it doesn't wake the loop.
- **Busy (an automation is running):** the minute hand sweeps fast and the bell swings.
- **Quiet:** still hands, no swing.
- **Down:** boarded belfry, a dark face.

- [ ] **Steps 1–5:** as in Task 3. The draw test asserts that a quiet frame is empty and that busy hands move with `t`.

#### Task 5: Claude Yard

**Files:** create `app/public/street/yard.js`, `tests/street-yard-draw.test.cjs` and the yard rows in `tests/street-buildings.test.cjs`. Modify `home.js`, `sw.js` and the gallery.

**Logic (not a runs building):**
- `state(world)` → `{hidden, working: int, waiting: int, sessions: [{id, title, state}] ≤ 3, more: int, down}`.
  - `hidden` when `root.document?.body?.classList.contains('dev-tools-off')`. Under Node there's no document, so `hidden` is false.
  - `world.crews === null` gives `down: false` with zero sessions. **Ruling:** the board being unreadable reads as "No sessions", never boarded, because the board isn't a service the owner runs.
- `chip`: title 'Claude Yard'. Detail is `'<w> working'` and/or `' · <q> waiting'`, or 'No sessions'. Tone is busy when w > 0, else quiet. The detail goes through `cut()`.
- `item(state)`: always null, because a tap opens Agent World. **Ruling:** the Claude Code page has no per-session deep link today.
- `animates`: working > 0. `width`: 260. `roof`: 180. `stillKey`: `'hidden' | 'busy' | 'idle'`.

**Art:**
- **Busy:** a fenced yard with a striped canopy. Up to 3 workers in Claude-orange (`#d97757`) at laptops on trestle tables, typing (forearm motion) when their session is working and still when waiting. A '+' badge shape when there are more.
- **Idle:** an empty yard, laptops closed.

- [ ] **Step 1: Failing tests.**
  - Chip table: 2 working + 1 waiting gives '2 working · 1 waiting'; empty gives 'No sessions'.
  - A 300-character title doesn't appear in the chip (sessions aren't listed in it).
  - Draw tests.
  - **Browser** (`street-engine-ui.mjs`): with `dev-tools-off` on body and a world with crews, there is no Claude Yard chip. Removing the class and calling `setWorld` makes it appear.
  - A markup or RTL session title never reaches the DOM: assert that the yard chip's `textContent` excludes it.
- [ ] **Steps 2–5:** as in Task 3.

### Task 6: Beacons, stalled cars and cars driving off

**Files:**
- Modify: `app/public/street/street.js` (an engine layer); `app/public/street/art.js` (`car(ctx, x, y, {color, hazard: 0..1, wheel: rad})` and `beacon(ctx, x, y, {glow: 0..1, color})`, both in the art bar's language).
- Test: `tests/street-engine-ui.mjs`, `tests/street-art.test.cjs`.

**Interfaces:**
- **Consumes:** `state.needsYou`, `state.failed`, `state.first` and `def.roof`, from Task 1 and the buildings.
- **Engine behaviour:**
  - **Beacon:** when a building's `state.needsYou > 0`, a beacon stands on its roof centre (`x = width/2`, `y = roof`, building coordinates), amber `#ffb02e`.
  - **Stalled car:** when `state.failed > 0`, one car is parked at the kerb in front of that building (y ≈ 318) with its hazard lights on.
  - **At most one of each per building.**
  - **Pulse rule:** the beacon and hazard lights pulse for 60 s from the first time the engine sees that ask's item id (`state.first.id`), then stay steady. A map of id → first-seen time is kept per mount, so ids that leave are forgotten.
  - **Departing cars:** between two worlds, any id that was in `street[key].running` and is now in `street[key].recent` with status `completed` spawns a car at that building. It pulls out and drives right off the end of the street over 4 s, with at most 3 cars at once.
    - Only diffs where the strip was visible for both worlds spawn cars. A world that arrives after the strip was hidden or off screen resets the baseline with no cars.
    - Reduced motion spawns no cars.
  - **Animation:** a pulsing beacon, a pulsing hazard or a moving car counts as animating for the idle rule; steady ones don't.
- **`stats()`** gains `cars` (cars currently driving) and `beacons` (beacons drawn last frame), for tests.

- [ ] **Step 1: Failing tests** (fake clock, own mount):
  - A needsYou world shows `stats().beacons === 1` and frames rise. After 61 s, frames are flat (steady).
  - A flood world with 10 needsYou and 10 failed in each street key shows exactly one beacon per building with asks, and one stalled car per building with failures.
  - running → completed shows `stats().cars === 1` within one frame, and 0 after 4.5 s.
  - running → completed while the parent is display:none, then shown: `cars === 0`.
  - Reduced motion: no cars, and the beacon is still drawn steady.
  - Art tests: `car` and `beacon` draw without throwing, with smoothing on.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node tests/run-browser.mjs street-engine`, `npm test` and `node tests/run-browser.mjs perf`. Expected: PASS.
- [ ] **Step 5: Commit:** `"street: beacons for what needs you, stalled cars for failures, cars that drive off when work finishes"`.

### Task 7: Night lighting

**Files:**
- Modify: `street.js` (night clock and lighting pass); `art.js` (`sky(ctx, w, {night})` with stars at night); every building's `lights(state)` and night-aware `drawStill` (darker materials at night).
- Test: `tests/street-engine-ui.mjs`, `tests/street-night.test.cjs`.

**Interfaces:**
- **`env.night`:** `hour >= 19 || hour < 7` (local `Date`). Recomputed on mount and once a minute while any strip is mounted, through one shared timer. A change re-keys every still and redraws once.
- **`def.lights(state) -> Array<{x, y, w, h, color, kind: 'window'|'lamp'|'glow'}>`:** building coordinates. Return `[]` when down. Lamps are on at night even when quiet; windows only when busy.
- **The lighting pass, at night only, after buildings and cars:**
  1. Fill a `rgba(6, 10, 24, 0.5)` overlay over the whole canvas.
  2. With `globalCompositeOperation = 'lighter'`, draw each building's lights as soft glows.
  3. Draw each light's reflection mirrored below the ground line onto the road at 0.35 alpha, faded downward.
  4. Beacons and car lights also glow.
  - The pass belongs to the still for static lights (cached per stillKey with night) and to the live frame only for animated ones, so a quiet night street still draws nothing per frame.

- [ ] **Step 1: Failing tests.**
  - **`street-night.test.cjs`:** each building's `lights()` returns `[]` when down, at least one lamp when quiet, and more items when busy. All rects lie inside the building box.
  - **Browser:**
    - With `page.clock.setFixedTime` at 18:59:30 local, advance 60 s: the stills counter rises once, and a pixel sampled at the sky is darker after.
    - A quiet night street has flat frames over 1 s.
    - A busy window's glow raises the road pixel under it compared with day.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** iterating on a night gallery screenshot against the art bar's night look (the art bar file's night panel, and the C style the owner picked: glow, neon, wet-street reflections). Save `.superpowers/street/pr3-night.png`.
- [ ] **Step 4: Verify.** `npm test`; `node tests/run-browser.mjs street-engine home perf`.
- [ ] **Step 5: Commit:** `"street: night — busy buildings glow after dark"`.

### Task 8: The whole street on Home

**Files:**
- Modify: `tests/home-ui.mjs`, `tests/perf-ui.mjs` and the visual baselines in `tests/visual/darwin/` (Home only).
- Modify app files only to fix what these find.

- [ ] **Step 1: Failing tests.**
  - **`home-ui`:** with a stubbed world where every street key is busy plus crews, Home's strip has 10 chips in ORDER (9 with `dev-tools-off`).
  - **`home-ui`:** a needsYou chip click on real Home opens the run view. Assert `window.LocalAIRuns.show` was called with that id, using a spy.
  - **`perf`:** at 390×844, DPR 3, with the flood world (Review Focus 1) at night, `stats().avgMs < 8`.
- [ ] **Step 2: Run them.** Expected: FAIL where not yet true.
- [ ] **Step 3: Fix what they find.**
- [ ] **Step 4: Run everything.**
  - `npm test` and `npm run lint`.
  - The full browser suite: `LOCALAI_URL=… npm run test:browser`.
  - Update the visual baselines with `LOCALAI_VISUAL_UPDATE=1 node tests/visual-ui.mjs`, revert unrelated ones, and Read the Home PNGs.
  - The deploy validator: `pwsh -NoProfile -File deploy/Test-LocalAI-Candidate.ps1 -CandidateRoot . -LocalNode`.
  - Take screenshots of real Home with the busy world by day and by night at 1280 and 390 (`.superpowers/street/pr3-home-*.png`).
- [ ] **Step 5: Commit:** `"Home: the whole street — Missions HQ, Repair Garage, Clock Tower, Claude Yard, beacons, cars and night"`.

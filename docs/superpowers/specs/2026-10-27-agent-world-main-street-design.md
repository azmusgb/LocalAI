# Agent World, Main Street (27 October 2026)

**Owner's ask:** rethink Agent World. "I really like the idea, not sure if it's in the right place, hooked up to the
best things, using the right logic", and later "I need ideas on the look".
**Replaces:** the layout and renderer of `2026-10-17-agent-world-design.md` (the top-down city) and most of
`2026-10-24-agent-world-round-2-design.md` (see "What happens to round 2" below). The story words of the 17 Oct spec
(`agent-world-words.js`) stay.
**Mockups:** brainstorm screens in `.superpowers/brainstorm/` (git-ignored): `home-strip-look.html`,
`full-street-cutaway.html`, `art-wow.html` (the art bar).

## Where it stands (`main` c708173)

- Agent World is the hidden page `agents` (registry label "Missions"). Its only way in is the "Open Agent World"
  banner in Work › Missions.
- It draws **one mission at a time**: workers walk between districts of a top-down city. `/api/world` landmarks
  (models, printer, Spreadsheets, kiosk) add a few lit buildings. Chats, images, changes, automations, approvals and
  Claude Code sessions are not in it. With no mission running it is nearly a still picture.
- The renderer is the `agent-world-city.js` section of `app/public/ui.js` (about 1,000 lines in the hand-edited
  bundle). Watch mode, the story rail and six browser suites use `window.LocalAIAgentWorld`.

## What the owner checks, in order

1. What their AI work is doing (chats, images, missions, changes: running and finished).
2. The state of the house (models, printer, kiosk, services).
3. Their Claude Code sessions.
4. What needs them (approvals, questions, failures).

## The idea

**Agent World is Main Street: a side-view street with one building per kind of work and per house thing, on Home.**
A short live strip at the top of Home shows the street. Tap it and the full Agent World opens on the same street,
taller, with buildings that open into cutaways so you can see the work inside. A mission plays out inside the Missions
building, one floor per step of its plan.

## Look

- **The art is detailed vector art drawn in code, at full screen resolution, never pixelated.** The bar is
  `art-wow.html`:
  - **Depth:** a hazy far city, buildings with a side wall and a roof, then the sidewalk, curb and road, then
    foreground plants. The layers move at different speeds (parallax).
  - **Materials:** brick, corrugated metal, steel and glass, each looking different, with reflections.
  - **Light:** soft shadows, glow spilling out, light rays.
  - **The work is visible inside each building:** the Foundry's crucible pours, its queue is crates on a conveyor,
    and people have real proportions, hats and props.
- **Day is bright and readable. Night uses the lighting pass:** the scene darkens, and glow, neon, rays and wet-street
  reflections appear only around busy buildings, so busy buildings stand out after dark. Night turns on by the local
  clock (19:00–07:00); the existing Night control overrides it for the session.
- **Labels are HTML chips** over the canvas (name, state, count) styled with `--ds-*` tokens. Text is never painted
  into the art, so it stays crisp and screen readers can read it.
- **Reduced motion:** no walking or driving, still fire and smoke, state changes snap.

## The street

Fixed order, always present. A building with nothing going on goes quiet but never disappears.

| Building | Fed by | Busy looks like | Tap opens |
|---|---|---|---|
| Chat Café | runs of type `chat`, `research` | a figure per running run (up to 3) with a speech bubble | cutaway; rows → run view; "Open Chat" |
| Image Studio | `image` | the canvas in the window paints in | cutaway; rows → run view; "Open Images" |
| Missions HQ | `agent` (missions) | cutaway floors = plan steps; workers take the stairs to hand off | the mission story (rail/sheet) |
| Repair Garage | `engineering` (changes) | a car on the lift, a mechanic under it | cutaway; rows → run view; "Open In progress" (Improve) |
| Spreadsheets Office | `spreadsheet` + GridCraft `/health` | lit windows, someone at a desk | cutaway; "Open Spreadsheets" |
| Clock Tower | `automation` | hands spin; the bell swings when an automation runs | cutaway; "Open Automations" |
| Model Foundry | Ollama `/api/ps` + mission model queue | furnace lit, model name on the chip, a crate per queued turn | cutaway; "Open Models" |
| Workshop Garage | the Workshop printer poller | door up, print bed visible, progress on the door | cutaway; "Open Pi Hub" (where Home's printer line goes) |
| Kiosk Billboard | the Workshop display's health | screen on, firmware on the chip | System › Services › Workshop display (`#integrations?card=workshop`) |
| Claude Yard | Claude board sessions (developer tools on only) | a worker at a laptop per session, title on the chip, last action as a bubble | "Open Claude Code" |

Rules:
- **Down or not set up:** boarded windows and a "Not answering" chip, never a fake state.
- **A run finishes:** a car pulls out of its building and drives off the end of the street.
- **A run fails:** its car stalls in front of the building with a hazard light until the run is seen (the existing
  `/api/runs/seen`).
- **Needs you:** a beacon on the roof of the building that owns the run. Tapping it opens the approval or question
  (the same actions as Work).
- **A cutaway** lists up to 3 running and the last 3 finished runs. Each row opens the existing run view.
- **Watch mode** stays read-only: taps show the chip, not actions.
- **There are no per-project buildings.** Round 2's Projects Quarter is dropped.

## Where it shows

- **Home strip:** a short, wide view of the street at a lower zoom (storefronts only, no cutaways), above Recent. The
  camera keeps the most recently changed building in view. Tapping it opens `#agents` focused on that building. On a
  phone it scrolls sideways.
- **`#agents`, the full street:**
  - **Desktop:** the street fills the main area, with the story rail on the right.
  - **Phone:** one building fills the screen; swipe to walk the street; the story sheet sits underneath (peek, half,
    full) as today.
  - The page keeps its id and the deploy-contract element ids (`agentWorldCityMount`, `agentTimeline`,
    `agentInspector`, `agentResultBody`, `agentMissionHistory`, `agentAdvancedPanel`).
- **Watch mode** (`agent-world-watch.js`): the full street, following whatever changed. With every kind of work on
  the street, it becomes the TV/ambient display.
- **The Work › Missions banner** stays as a second way in.

## Architecture

### Rendering
- **Canvas 2D at `devicePixelRatio`.** Vector paths, gradients, patterns and blur, as in the art bar.
- **Each building's still parts are drawn once** to an offscreen canvas, keyed by zoom, day/night and the building's
  `state` signature. Each frame draws only the moving parts: fire, smoke, pour, conveyor, people, cars, light.
- **Four parallax layers:** sky, far city, street, foreground.
- **Night lighting pass:** a dark overlay, then additive glow, rays and reflections around buildings whose state is
  busy.
- **Frames run only while the street is visible.** A hidden tab or an off-screen strip draws nothing.

### Files (`app/public/street/`, loaded on demand like today's `aw/` modules)
- **`street.js`, the engine:**
  - Owns the canvas, camera, layers, the animation loop, hit-testing and chip positioning, and the shared poller.
  - Exposes `window.LocalAIAgentWorld` with the methods watch mode, the rail and the tests use today: `follow`,
    `following`, `demo`, `demoing`, `demoStory`, `busy`, `avatar`, `view`, focus via `localai:agentworld-focus`, and
    replay via `localai:agentworld-replay-mission`.
  - `addLayer` is retired once `aw/landmarks.js` is absorbed into buildings.
- **`art.js`:** shared drawing helpers: palette, brick, corrugated metal, steel, glass, shadows, glow, people (body,
  hat, prop, walk) and cars. Buildings compose these; they don't each reinvent bricks.
- **One file per building** (`chat.js`, `images.js`, `missions.js`, `garage.js`, `sheets.js`, `clock.js`,
  `foundry.js`, `workshop.js`, `kiosk.js`, `yard.js`), each exporting:
  `{id, width, state(world), drawStill(ctx, state, env), drawLive(ctx, state, t, env), cutaway(ctx, state, t, env), chip(state), rows(state), open(item)}`
  - `state()` and `chip()` are pure.
  - A building never fetches. It is handed its slice of `/api/world`, and `missions.js` also gets the mission detail.
  - `env` is `{night, reduced, zoom}`.
- **`missions.js`:** the cutaway floors (Plan, Specialists, Wrap-up, from the mission's workers and their states) and
  the stair hand-offs. Worker looks keep today's `lookFor` and role props, redrawn in the new style.
- **Retired:**
  - The `agent-world-city.js` section of `ui.js`, deleted in PR 5.
  - `aw/landmarks.js` and `aw/kit.js`, absorbed into buildings in PRs 2–3.

### Data (`app/world.js`, `GET /api/world`)
- **New `street` object:**
  - One key per building: `{running:[…≤3], waiting:n, needsYou:[…], failedUnseen:[…], recent:[…≤3]}`.
  - Items are `{id, title, status, startedAt}`. Titles come from `readableTitle`.
  - Built from the run ledger with the same `workKind` mapping as Work, plus approvals for `needsYou` and
    `/api/runs/seen` state for `failedUnseen`.
- **`crews`** is filled from the Claude board's live sessions, and only when developer tools are on.
  - Each crew item is `{id, title, lastAction}`, already cleaned by `clean()`.
- **Existing rules kept:**
  - Each source is cached (the ledger read at most once every 5 s).
  - A read under way is shared.
  - `null` means down or not set up.
  - No secrets, no addresses.
  - No timestamps in the body except item `startedAt` (which only changes when the items do), so the ETag is stable
    and an idle poll is a 304.
- **One shared client poller** every 10 s, only while the strip, the page or watch mode is visible.
- **Mission detail** comes from the existing `/api/agents/mission?id=`, fetched only while a mission is running or
  its cutaway is open.

### Errors
- **`/api/world` fails or times out:** keep the last picture, dimmed, with a "Can't reach LocalAI, retrying" chip.
- **A source is `null`:** that building is boarded with "Not answering". The others are unaffected.
- **A building's draw throws:** that building is skipped for the frame and logged once. The street keeps drawing.

## Testing

- **Unit (`tests/*.test.cjs`):**
  - The `street` builder: the kind mapping, the caps, needs-you, failed-unseen, null sources, the developer-tools gate
    on `crews`, ETag stability.
  - Each building's `state()` and `chip()` as table tests.
- **Browser (`tests/*-ui.mjs`):**
  - The Home strip renders, and a tap opens `#agents` on the right building.
  - A building tap opens its cutaway; a row opens the run view.
  - Beacon → approval.
  - Phone swipe.
  - Night mode.
  - Reduced motion.
  - The existing `agent-world`, `agent-world-landmarks`, `agent-world-layers`, `agent-world-watch`, `mission-run` and
    `axe` suites, updated where they assumed the top-down city.
- **Visual:** screenshot baselines per building, day and night (`visual-ui.mjs`).
- **Performance:** a frame-time budget for a phone-sized viewport (`perf-ui.mjs`).

## Delivery (PR-sized, each based on `main`, each through `npm run ship`)

1. **`/api/world` street data.** `street` and `crews`, with unit tests. No visible change.
2. **Engine and Home strip.**
   - `street.js`, `art.js` and the storefronts for Foundry, Workshop, Kiosk, Spreadsheets, Chat Café and Image Studio.
   - The strip on Home; a tap opens today's `#agents`.
   - Day art.
   - **The Foundry is built first and its screenshot reviewed with the owner** before the other buildings follow its
     kit.
3. **The rest of the street.**
   - Missions HQ, Repair Garage, Clock Tower and Claude Yard storefronts.
   - Beacons, stalled cars and cars driving off.
   - Night lighting and parallax.
4. **The full page.**
   - `#agents` becomes the street, with cutaways for every building except Missions, the story rail and swipe on
     phones.
   - The Missions HQ tap still opens today's mission view.
5. **Missions cutaway and retirement.**
   - Floors and stair hand-offs; demo, replay, follow and watch mode on the street.
   - Delete `agent-world-city.js` from `ui.js` and `aw/`.
   - Update the suites.

## What happens to round 2 (24 Oct)

- **Landmarks:** absorbed as the Foundry, Workshop, Spreadsheets and Kiosk buildings.
- **Claude Yard:** kept, as a building.
- **Projects and runs:**
  - Runs are kept, as figures and cars per building.
  - Per-project buildings are dropped.
- **Polish (five items):**
  - Demo chip over toasts, two progress numbers, zoom controls over signs: these go with the top-down city.
  - The phone peek and "idle is dead" are answered by this design.
- **"Cooler":** answered by the art bar here.

## Out of scope

- New server state or storage: everything comes from sources LocalAI already has.
- Sound beyond watch mode's existing chimes.
- Art from image files or sprite sheets: everything is drawn in code.
- A main-nav entry for Agent World (revisit if the Home strip isn't enough).

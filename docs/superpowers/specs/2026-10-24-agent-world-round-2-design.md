# Agent World, round 2: the city is the house (24 October 2026)

**Owner's asks:** "make agent world look cooler even" (Home, twice), and roadmap project **E — Agent World as
navigation** (`2026-10-23-localai-next-roadmap-design.md`).
**Builds on:** `2026-10-17-agent-world-design.md` (layout, story, words), `2026-10-18-agent-world-visuals.md`
(workers, buildings, ground; shipped), and round 1 "mission control" (approved 19 Oct; its plan was never committed).

## Where it stands (review of `main` 595bf41, demo mission, desktop 1440 and iPhone 14)

Shipped: the visuals pass (role props, walk cycles, district silhouettes, sidewalks, lamps, flows along roads), the
layer hook (`LocalAIAgentWorld.addLayer`, #354), `GET /api/world` (#357), watch mode (#351), replay, demo.

**Round 1 stopped after its plumbing.** `/api/world` reports the models, the printer, Spreadsheets and the display,
but nothing draws it: `AW_MODS` is only `kit`, and `crews` is still `null`. So the city still shows one mission
and nothing else about the house, and when no mission runs it is an empty box.

**What reads as unfinished** (seen in the review):
1. The **Demo · Stop** chip sits on top of the event toasts (desktop: over the end of the first toast; phone: over
   its text).
2. **Two progress numbers on one building**: Command Center's roof pill says 99% while its screen says 100% and
   "MISSION COMPLETE" is up.
3. The **zoom controls cover a district sign** (Validation Lab) and the follow camera crops signs at the top edge
   (Documentation Studio).
4. On a phone the sheet's peek is one line ("Done · 4 workers") over 100 px of empty space.
5. **Idle is dead**: with no mission running there is nothing to watch, so the city is a demo-only toy.

## The idea

**The city is the house.** Every district stands for something real that LocalAI already knows about, it is lit
when that thing is busy, and tapping it opens the page that deals with it. A mission is still the big event
(workers walk, buildings rise), but the city is worth opening on an ordinary evening: the printer garage glows
while a print runs, the foundry's chimney smokes while a model is loaded, a car drives out for every run.

## Design

### Landmarks (round 1's PR 3, from `/api/world`; one `aw/landmarks.js` module, ground + draw + hit + rows)
- **Model Foundry:** furnace glow and chimney smoke while a model is loaded; a sign with the loaded model's short
  name; a queue of crates for queued mission turns. Tap → System › Models.
- **Workshop garage:** roll-up door open with the printer inside while printing, a progress bar on the door
  (`printer.percent`), a red beacon on error, dark when the printer is off. Tap → Workshop / the printer card.
- **Spreadsheets office:** windows lit while GridCraft works; a dim "bridge down" sign when it is down. Tap →
  Projects › Spreadsheets.
- **Kiosk billboard:** the Workshop display's state (online, firmware). Tap → Services › Workshop display.
- Down or not set up = the building is dark with a plain sign ("Not answering"), never a fake state.

### Projects and runs (project E's first slice; `aw/projects.js`)
- **A building per pinned project** (up to 6, on the reserved Projects Quarter blocks), named on its roof; more
  projects collapse into one "Other projects" tower.
- **A car per active run** from the run ledger (`/api/runs?status=running`), leaving the building of its project
  (or the depot) and parking at the district of its kind (chat → Command Center, image → a studio, change →
  Repair Bay). A run that needs the owner parks with a **beacon** over the car.
- **Tap a car** → the existing run view; **tap a beacon** → the approval sheet. Same actions as Work, nothing new
  on the server.
- Watch mode on the TV stays read-only (taps show the card, no actions).

### Claude Yard (round 1's PR 4; fills `crews` in `/api/world`)
- One small yard where each live Claude Code session from the board is a worker with a laptop, its title on a
  name tag, its last action as a bubble (from the board's events; already sanitised by `clean()`). Tap → Claude
  Code page. Shown only with developer tools on.

### Polish (the five items above)
- Chip and toasts share one top-left stack; the demo chip goes first, toasts below it.
- One progress number per building: the roof pill is hidden once the screen shows the mission's own percentage,
  and both read the same value.
- Signs avoid the control box the same way bubbles avoid signs; the follow camera keeps a 24 px margin for signs.
- Phone peek shows the crew avatars and the status sentence on one row, and the sheet's peek height fits it
  (no empty band).
- **Idle city:** with no mission, the camera slowly pans between lit landmarks (not in reduced motion), and the
  empty state says "Nothing running · Start a mission" over the city, not instead of it.

### "Cooler" (visual moments, all reduced-motion aware, all in the cached ground or the sprite sheet)
- **Weather from the house:** rain/snow/clear from the Home weather (already fetched for the display feed).
- **Time of day from the clock** (exists) plus a sunset palette band between day and night.
- **Print finished:** the garage door rolls up and a little drone flies the part to Command Center.
- **Mission done:** fireworks stay; add a crowd of the crew waving on the Command Center roof.

## Decisions (recommendation first; I'll proceed on these unless you say otherwise)
- **D1 Order:** polish → landmarks → projects and runs → Claude Yard → "cooler" moments. *Rec: this order*; polish
  is small and fixes what looks broken today, landmarks make the idle city worth opening.
- **D2 Projects shown:** pinned projects only (max 6) vs the six most recently active. *Rec: most recently active*,
  so it works without pinning anything.
- **D3 Claude Yard visibility:** developer tools only vs always. *Rec: developer tools only* (session titles are
  developer words).
- **D4 Weather:** real weather vs none. *Rec: real*, it costs nothing (cached) and makes the TV watch mode alive.

## Quality bar
- 60 fps on desktop and iPhone 14 (frame-time test), no per-frame growth: new art in the cached ground layer,
  per-frame overlays a few fills.
- Modules stay within the on-demand budget (4 KB each, 12 KB in all, gzipped); raise it with a dated note only if a
  module needs it. Shell budget unchanged.
- Every tap target has a City services row (the canvas's accessible equivalent); axe clean.
- Tests per PR: the layer draws from a stubbed `/api/world` and `/api/runs` (busy, idle, down), taps open the right
  page, reduced motion shows state without movement, and visual baselines for an idle city and a busy one.

## Delivery (PR-sized, each based on `main`, each through `npm run ship`)
1. Polish (chip/toast stack, one progress number, sign vs controls, phone peek, idle state).
2. Landmarks module.
3. Projects and runs module.
4. Claude Yard (server `crews` + module).
5. Moments: weather, sunset band, print-finished drone, roof crowd.

# Agent World, redesigned (17 October 2026)

**Owner's ask:** "make the agent world amazing ui / ux".

## What it is today

Missions (`#agents`, a hidden page opened from Work › Missions › "Open Agent World") stacks, top to bottom: a
mission form ("Mission objective", "Mission Router", "Preview plan", "Advanced routing"), a progress strip, the
**Agent World** pixel city with two toolbars (Fit · Active · Follow · − 100% + · Labels · Flows · Night · Crew ·
Theater) and four counters, an objective/status block, the city, an event ticker, Crew, Districts, Replay,
Simulation, a keyboard-shortcut line, then beside or below: Mission timeline, Inspector ("Capability fit 100%",
"Grounding Not required", "Assignment rationale"), result tabs (Synthesis · Worker outputs · Evidence · Routing)
and a Mission history of every mission ever run.

**What's wonderful:** the city. Districts that match the work (UX Lab, Documentation Studio, Command Center,
Model Foundry, Validation Lab, Repair Bay), workers walking between them, buildings under construction with
cranes as work progresses, a minimap, day/night, dependency flows. It is the most delightful thing in the app.

**What's wrong:**
1. **On a phone the city is blank**: an empty dark box under "Select a worker or building". The phone page is
   11,600 px of stacked panels; Crew scrolls sideways and is cut off; a "Keys: 0 fit · A active…" line is shown on
   a touch screen.
2. **The city is buried** under a form and a strip, and framed by controls and counters. On desktop it's half the
   width; the rest is a timeline and an inspector that repeat the crew list in developer terms.
3. **It doesn't tell the story.** "Needs attention · UX Analyst requires intervention" and a red striped bar, but
   not *what* went wrong or what to do; the page-level "Retry mission" sits in the form, far from the city.
4. **Four ways to see one mission's progress** (counters, strip, timeline, crew) and **two replays** (Replay and
   Simulation) with identical-looking controls.
5. **Developer words everywhere:** Mission Router, routing override, capability fit, grounding, fallback,
   assignment rationale, Synthesis, Evidence, Routing, "Mission-first · Local models".
6. **History lives in two places** (here and Work › Missions), here as a 15-row wall.

## The design

**One idea:** Agent World is a *place you watch your team work*. The city is the page; everything else is a
caption, a cast list, or a sheet you pull up.

### Layout

- **Desktop (≥ 1024 px):** the city fills the main area edge to edge (min 520 px tall, 16:10). A right **Story
  rail** (360 px) holds, in order: the mission card, the crew, the story feed. The page header is one line:
  mission title, a status sentence, and one primary action.
- **Tablet (761–1023 px):** city full width, Story rail below it as two columns (crew | story).
- **Phone (≤ 760 px):** the city fills the screen under the header (`100dvh` minus header and tab bar). A **bottom
  sheet** with three snap points (peek 112 px: status sentence + crew avatars; half: crew + story; full: results)
  holds everything else. Drag, tap the handle or Back to change snap; the city stays interactive above it. No
  page scroll on this view.

### The header: one sentence and one action

- Title: the mission's goal in the owner's words ("Improve the look and polish of Agent World").
- Status sentence, plain and specific: "Working · 1 of 3 done · UX Analyst is drafting the plan" / "Needs you ·
  UX Analyst stopped: the model didn't answer" / "Done in 4 min · 3 workers".
- One primary action by state: **Watch live** (running, when the camera isn't following) · **Try again** (failed;
  retries the failed worker, not the whole mission, when the server supports it, else the mission) · **See the
  result** (done) · **Start a mission** (no mission).
- Overflow menu (⋯): Start a new mission · Watch the replay · Open in Work · Copy result.

### Start a mission

A sheet ("What should the team do?"), opened from the header or the empty state:
- one large text box; **Who's on the team** preview (avatars and one-line roles) appears as you type (the existing
  plan preview, in words: "A UX Analyst will review the screens; a Coordinator will write the plan");
- "Let the team search the web (searches leave this computer)" and "Keep it in a project" as plain options;
- **Advanced** (developer tools only): choose specialists, routing override, model.
- **Start**; the sheet closes, the camera flies to Command Center and the city wakes up.

### The city

- **Camera follows the action by default**: it eases to whoever just changed state; any pan/zoom by the owner
  pauses following, and a small "Follow" chip appears to resume.
- **Controls, three only, over the city's bottom-right corner:** zoom −/+ and Follow. Everything else (labels,
  flows, night, theater) moves to a "View" item in the ⋯ menu. Fit is a double-tap/double-click.
- **Tap a worker or building** → the camera centres on it and a **worker card** opens (desktop: in the rail;
  phone: the sheet goes to half): avatar, role in words ("Reviews screens for usability"), what they're doing now,
  their output so far, and, if stuck, *why* and **Try again**. Model and scores show only with developer tools.
- **Events float over the city** as short toasts at the top-left for 4 s (max 3), and are kept in the story feed.
- **Moments:** a worker finishing raises a small flag over their building; a failure shows a red warning sign
  and the worker sits on the kerb; mission done → fireworks over Command Center (skipped with reduced motion).
- **Reduced motion:** no camera easing, no walking, no fireworks; positions jump.

### The crew and the story

- **Crew:** one row per worker: pixel avatar, name, role in words, state badge (Working / Done / Waiting / Needs
  you), current step on a second line. Tap = focus in the city + worker card. This list is the accessible
  equivalent of the city.
- **Story:** the event feed in sentences, newest first, grouped by worker when a run of events is from one:
  "UX Analyst started reviewing the Home screen", "Coordinator is waiting for UX Analyst". Replaces the Mission
  timeline.

### Results

When there's output: **Summary** first (the synthesis; if none, say why: "No summary yet — the Coordinator didn't
finish"), then **What each worker found** (collapsible per worker), then **Sources** (the evidence, as links). On
phone this is the sheet's full snap. "Routing" moves behind developer tools.

### Replay and demo

- A finished mission shows a slim **timeline scrubber** under the city (desktop) / in the sheet (phone) with event
  markers coloured by state and one Play/Pause button; speed is in ⋯ › View. The camera replays with it.
- "Simulation" becomes **Try a demo mission** in the empty state only (and in ⋯ when developer tools are on).

### Empty state (no mission yet)

The city at golden hour, idle workers in their districts, and centred on it: "Give your team a goal" with the
composer's text box and Start. Below (phone: in the sheet) "Try a demo mission".

### History

Removed from this page: Work › Missions is the history. The ⋯ menu has "All missions" → Work › Missions. Opening a
mission from Work opens it here (existing route).

### Words

Mission Router → **Team lead** (it picks the team); specialists → **workers**; Synthesis → **Summary**; Evidence →
**Sources**; Worker outputs → **What each worker found**; "Mission-first · Local models" pill → gone; Inspector →
the worker card; "Capability fit", "Grounding", "Fallback", "Assignment rationale" → developer tools only.

### Quality bar

- Phone: city renders on iPhone 14 and SE; pinch-zoom and drag-pan work; the sheet snaps; Back closes the sheet
  first; the tab bar is not covered; nothing scrolls sideways; page height = one screen.
- 60 fps target on desktop and iPhone 14 for a 3-worker mission (existing frame-time budget test extended to the
  phone viewport).
- Keyboard: crew rows, header action, ⋯ menu, zoom and Follow are reachable; the city canvas has a text label
  and the crew list is the screen-reader path. Axe clean.
- Visual baselines for the empty, running, needs-you and done states at 390 and 1440.

## Delivery (PR-sized)

1. **Phone city renders**, and the page stops stacking: canvas sizing fix; phone layout with the bottom sheet;
   keyboard-hint line hidden on touch; Crew as rows. (Fixes the worst problem first.)
2. **Story-first layout** on desktop/tablet: full-bleed city + Story rail; header sentence + one action; timeline
   and inspector replaced by crew rows + worker card + story feed; History removed (link to Work).
3. **Start a mission sheet** with team preview in words; Advanced behind developer tools; empty state with the
   golden-hour city and "Try a demo mission".
4. **The city's behaviour:** follow-by-default camera, three controls + ⋯ › View, floating event toasts, moments
   (flags, warning sign, fireworks), reduced-motion paths.
5. **Results and replay:** Summary / What each worker found / Sources; one replay scrubber; words pass and
   developer-only fields; visual baselines; frame-time budget on phone.

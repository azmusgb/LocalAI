# Agent World visuals, second pass (18 October 2026)

**Owner's ask:** "Improve animation, workers, graphics of agent world".
**Builds on:** `2026-10-17-agent-world-design.md` (layout, story, words). This pass is only the city itself: how it
looks and moves. The renderer is `// ==== agent-world-city.js ====` in `app/public/ui.js` (canvas, ~70 KB).

## What's there (live review, 17 Oct, desktop 1440 @2x and iPhone 14; 61 fps on both)

Good: pathfinding along roads, construction stages with scaffolding and a crane, traffic, flags, warning signs,
fireworks, follow camera, minimap, day/night. Weak:

1. **Workers are one sprite.** Same hard hat, vest and pose; a tiny letter badge is the only difference. They glide
   between points with no walk cycle and face nowhere. At rest they don't do anything that reads as their job.
2. **Labels collide.** Speech bubbles ("MERGE") sit on district signs; a sign's percentage overprints its name
   ("Cente4%"); workers stand on signs.
3. **Buildings are one block.** Same box and window grid for every district, only the roof stripe colour differs.
   No shadows, so the city reads flat.
4. **Ground is noisy.** A checkerboard of greens with random dots; no sidewalks, crossings, lamps or benches; few trees,
   all alike.
5. **Flows ignore streets.** Dependency lines are straight dashed diagonals across blocks and buildings.

## The design

**Style stays pixel art** (it's the charm), drawn cleaner: a fixed 2 px pixel grid at 100%, a limited palette per
district, soft drop shadows, one light direction (top-left), night lighting from windows and lamps.

### Workers
- **A look per role**, readable at 100% without the badge: vest colour = the role's district colour; one prop each
  (UX Analyst: tablet; Code Analyst: laptop; Documentation: clipboard; Validator: magnifier; Coordinator: radio;
  Team lead: blueprint roll; Repair: wrench; Model work: hard drive). Skin tones and hair vary by worker id
  (deterministic), so a crew of three never looks like clones.
- **Walk cycle**: 4 frames (legs and arms swing, 1 px body bob), facing left/right by direction of travel; 6 fps.
- **Idle and work loops** by state: working = their prop's action (typing, writing, scanning) with small sparks or
  paper; waiting = look around / check watch; done = thumbs-up then relax; stopped = sit on the kerb with a warning
  sign (exists; keep); needs-you = wave toward the camera.
- **Selection**: a soft ring under the worker and a name tag ("Code Analyst") above; hover on desktop shows the tag.

### Labels and bubbles
- District signs sit **on the roof edge**, name and progress as two separate pieces (name; a small progress pill).
- Speech bubbles are **one short word or icon** (✓, …, !, the current step's verb), never over a sign: they stack
  above the worker and nudge sideways when they would overlap a sign or another bubble (simple rectangle avoidance).
- Text uses a pixel font size that stays crisp at 100% and 200% (render text at integer scale).

### Buildings and districts
- **One silhouette per district** with a prop that says what it does: UX Lab (glass front with screens showing
  wireframes), Documentation Studio (book stacks in windows, a printer), Command Center (antenna and a big status
  screen showing the mission %), Model Foundry (chimney with a warm furnace glow), Validation Lab (checkmark beacon
  that blinks green on pass), Repair Bay (roller door that opens when a worker is fixing), Projects Quarter (filing
  towers).
- **Shadows** (one direction), roof edges, a lit-window pattern that changes slowly (not a uniform grid); at night
  windows glow and spill light on the pavement.
- Construction stays as is (scaffold, crane, materials) but uses the same shadow and palette.

### Ground
- **Sidewalks** along every road, **crosswalks** at junctions, **lamp posts** (lit at night), **benches** and
  **planters** near buildings, **trees** in three shapes and two sizes with a gentle sway; grass as smooth tiles with
  sparse tufts instead of random dots.
- All static scenery stays in the cached ground layer (`drawGroundStatic`), so it costs nothing per frame.

### Motion
- Camera moves ease (existing) and never jitter at rest (snap to the pixel grid when idle).
- **Flows follow roads**: a dependency is drawn as a moving packet along the road path between the two districts
  (reuse `astar`), with the line itself faint; finished hand-offs pulse once at the receiving door.
- Cars stay in lanes, stop at crossings when a worker crosses, and fade out when the city is idle at night.
- Reduced motion: no walk cycles (workers jump), no sway, no particles; positions and states unchanged.

## Quality bar
- 60 fps on desktop and iPhone 14 for a 3-worker mission (the frame-time test, desktop and phone); no growth of the
  per-frame budget: new static art goes into the cached ground layer, per-worker sprites into an offscreen sprite
  sheet built once per role/tone.
- Shell download budget: aim for ≤ +6 KB gzipped for this pass (sprites are drawn in code, no image files).
- Visual baselines for Agent World updated and reviewed by eye; a new test that two workers with different roles
  render with different pixels, and that no bubble's box intersects a district sign's box in a seeded mission.

## Delivery (PR-sized)
1. **Workers**: per-role look and prop, deterministic variety, walk cycle with facing, idle/work loops, selection tag.
2. **Signs, bubbles and flows**: sign layout, bubble placement with overlap avoidance, flows along roads.
3. **Buildings and ground**: district silhouettes and props, shadows, lit windows, sidewalks, crossings, lamps,
   benches, trees, smoother grass.

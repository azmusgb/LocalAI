# Plan: navigation depth

Spec: `docs/superpowers/specs/2026-11-09-navigation-depth-design.md` (approved 9 Nov, D1-D5 as recommended). Four code
PRs, each based on `main`. They touch different pages, so they can be reviewed in any order. When one lands, merge
`main` into the others and keep both sides of `index.html`'s script line and `sw.js`'s SHELL
(`tests/frontend-scripts.test.cjs` guards the script list).

1. **One Changes page; Atlas only in Improve** (D4, D3).
   - `view-registry.js`: a view may name the strip item it lights with `lights` (System tools already did this through
     `underTools`; that becomes `lights:'tools'`).
   - `backlog` gets the label "Changes" (tab and short "Changes"; page heading "Changes"). `inProgress` and `shipped`
     keep their addresses and sections, with `lights:'backlog'` and no strip button.
   - Each of the three sections shows the same stage chips, Backlog · Doing · Shipped, under the heading. They are
     links to `#backlog`, `#inProgress` and `#shipped`, with `aria-current` on the open one.
   - `architecture` loses `tool:true`, so it is no longer a card on Tools.
   - Tests: navigation (Improve strip = Changes · Signals · Claude · Atlas; the stage chips; Tools without
     Architecture), router, improve-ui, the visual baselines that change.
2. **Status and Connections are one page** (D1).
   - Connections' cards ("What each one does", Outside websites) mount inside Status under its Services list.
     Connections' own summary plate goes, because Status's plate already says how many core services are up.
   - `integrations` leaves the registry's views and joins `ALIASES` → `status`. `#integrations?card=workshop` still
     brings the Workshop card into view, now on Status.
   - Tests: navigation (System strip = Status · Models · Tools · Settings · Audit log), integrations and status
     suites, the alias, visual.
3. **Pins** (D2).
   - Server: `GET`/`PUT /api/nav/pins` in the settings table (`nav-pins`), up to four known view ids, in order.
     Unknown ids are dropped and a fifth is refused with a plain error.
   - Home: a "Pinned" row under the composer (hidden when empty).
   - ⌘K: pinned pages first, under "Pinned".
   - Every page heading: a Pin / Unpin button (`aria-pressed`) in the head's tool slot, beside any existing tool.
     When four pages are already pinned, the button says so instead of failing silently.
   - Tests: contract (endpoint validation), a pins browser suite (pin, Home row, palette order, unpin, the limit, the
     error state when the save fails).
4. **Page-open counter** (D5).
   - Server: `POST /api/nav/open {view}` adds 1 to `nav-opens:<day>` (view id → count) for known view ids only, and
     keeps 90 days. `GET /api/nav/opens?days=30` returns totals. `DELETE /api/nav/opens` resets them. Nothing leaves
     the appliance.
   - Client: one call per page change from the shell's `sync`, debounced, never for the same view twice in a row.
   - Settings: a "Pages you open" card that shows the top ten for the last 30 days, with a Reset button behind a
     confirmation.
   - Tests: contract (counting, unknown ids, pruning, reset), and a settings browser check.

Each PR:
- `npm test`, lint, and every browser suite on a fresh server;
- the width sweep and axe;
- screenshots at 390, 768 and 1440 px in light and dark for the pages it changes;
- `npm run ci -- <PR>`, and progress posted to the Claude board.

The owner merges with `npm run ship -- <PR>`.

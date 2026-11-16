# Atlas platform capture: all four systems, checked contracts, honest freshness

Date: 2026-11-15. Status: **proposed**, for the owner's review. Builds on the Atlas redesign
(`2026-11-04-atlas-redesign-design.md`, approved 4 Nov) and Atlas across repositories
(`2026-11-07-atlas-across-repos-design.md`, proposed 7 Nov; its declared-edge scope is kept here, nothing is re-opened).

## Why

The owner asked for Atlas to be "way better" and to "capture the full Pi Hub, Print Lab, LocalAI, smart display".
Today Atlas maps three repositories (`ATLAS` in pi-hub `hub/systems.py` lists pi-hub, localai, mac-watch→localai,
print-lab). The smart display (`bambuhelper-smart-display`, deploy target `firmware`) has no entry. The links between
systems are a hand-written file (`atlas/contracts.json`). The owner has not yet said which question Atlas should answer
best; this design assumes "what breaks if I change X, across all four systems" and says so, so it can be corrected.

## Goals

1. Atlas has a snapshot and a map for all four systems.
2. The cross-system contract edges are checked against code at the live commits, including server-to-server calls.
3. Every system shows live commit, scanned commit and the gap, so a stale map is obvious.
4. One platform view above the per-repo maps: systems as nodes, contract edges between them.

## Non-goals

- Inferring undeclared edges from arbitrary code (7 Nov out-of-scope list stands).
- A new page or a restyle. The page stays Improve → Atlas, `/assistant/atlas`, in appliance-ui's kit.
- Parsing firmware C/C++ call graphs.
- Change-impact across repos and a generated platform summary for agents (follow-ups once 1 to 4 land).

## Anti-goals

- A map that looks complete while a system is missing or stale.
- A second list of systems. Hosts and repos keep coming from Pi Hub's `/api/systems`.

## Constraints

- Snapshots come from read-only bare mirrors through per-repo deploy keys (`atlas_snapshot_runner.py`); the smart
  display needs its own allowed repository, mirror and key alias on the PC.
- LocalAI ships only through `release` (`npm run ship -- <PR>`); Pi Hub through its own release path. Deploy
  preflight and confirmation rules apply to anything that restarts services.
- Scanner is `quick_arch.py`; changes keep existing schema-2 `graph.json` readers working.
- `bambuhelper-smart-display` is a large mixed repo: many `apply_workshop_os12_*.py` patch scripts, a root `app.js`,
  firmware sources and device schemas. The first snapshot must say what it parsed and what it skipped.

## Approaches

A. **Coverage first, then contracts, then freshness** (recommended). Smallest end-to-end step first: the smart display
   appears in Systems and gets a snapshot, even if its map is thin. Then server-to-server edge scanning, then the
   freshness figures. Each step ships alone and shows something the owner can look at.
B. **Platform view first.** Build the top-level graph on today's three repos plus hand-written contracts. Looks good
   sooner, but it draws the gaps (missing system, unchecked edges) as if they were facts.
C. **New scanner for all repos.** Replace `quick_arch.py` with a per-language scanner. Largest cost, and the
   existing scanner already holds routes, imports and snapshots for three repos.

Recommended: A. The owner replied "Yes" to the ranked list, whose order is A.

## Design (approach A)

1. **Smart display coverage.**
   - pi-hub `hub/systems.py`: add `"firmware": "bambuhelper-smart-display"` to `ATLAS`; `tests/test_systems.py` keeps
     the host/target invariants.
   - Runner: add the repository to the allowed list and to `ATLAS_REPO_REMOTES` defaults; document the PC key alias.
   - Scanner: for this repo, scan Python and JS imports and HTTP routes with the existing parsers, treat firmware
     sources as opaque modules grouped by folder, and record `skipped: [{path, reason}]` in the snapshot so the
     page can say "firmware sources listed, not parsed".
2. **Checked server-to-server edges.** Scanner records outgoing `/api/` calls from server modules (pattern
   `new URL('/api/…', hubUrl)`, `requests`/`httpx` calls against the hub base URL), not only browser scripts. The
   contracts endpoint (`GET /api/atlas/contracts`) marks each declared edge `confirmed`, `provider missing` or
   `consumer missing` at the live commits, and lists calls found in code with no declared edge as "undeclared (not
   an error)". Declared edges for netmon, home-mcp and the smart display are added to `atlas/contracts.json`.
3. **Freshness.** Systems cards show: live commit (from `release:<target>` records), scanned commit, commits behind,
   scan age. Behind or older than the release reads "map is behind the running release" in words, not colour alone.
4. **Platform view.** A compact graph above the Systems strip: nodes are the four systems plus home-mcp and netmon
   as declared consumers; edges are contract edges coloured by check result (confirmed, missing, undeclared);
   keyboard reachable, table fallback below, reduced motion respected. Selecting an edge shows provider, consumers and
   the tests that reference the route.

States designed: no snapshot, scan running, scan failed, mirror unreachable (PC asleep), skipped paths, long names.

## Sizing and order

A project: four PRs across two repos, in this order: (1) pi-hub `ATLAS` entry plus LocalAI runner and scanner support
for the smart display; (2) server-to-server scanning and edge checks; (3) freshness figures; (4) platform view.
Each is shippable alone. Verification per PR: the repo's unit tests, `tests/atlas-*.test.cjs`, `tests/atlas-map-ui.mjs`,
the width sweep and axe, screenshots at phone, tablet and desktop in light and dark, plus one real snapshot of the
smart display on the PC.

## Left to the builder

- Exact parse rules for the smart display's mixed sources (settle on the first real snapshot; keep `skipped` honest).
- Edge-check wording and graph layout inside the kit's tokens.
- Whether the platform view needs a visual mockup first (owner's call; offer one before PR 4).

## Open questions for the owner

1. Is "what breaks if I change X, across systems" the question that matters most? If not, the order may change.
2. Should home-mcp and netmon appear as nodes (assumed yes, as declared consumers only)?

# Atlas platform capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atlas maps all four systems (Pi Hub, Print Lab, LocalAI, smart display), checks cross-system contract edges against code, shows how stale each map is, and draws one platform graph.

**Architecture:** Pi Hub's `ATLAS` table and the runner's `DEFAULT_REMOTES` decide which repositories get snapshots. `quick_arch.py` scans them. `app/server/atlas-contracts.js` evaluates `atlas/contracts.json` against the snapshots at the live commits. The page (`app/public/architecture.js`, `app/public/atlas-systems.js`) renders the results in the appliance-ui kit.

**Tech Stack:** Python 3.12 (scanner, runner, Pi Hub FastAPI), Node 22 (`node --test`, no runtime npm deps), Playwright browser tests (`tests/*-ui.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-15-atlas-platform-capture-design.md`

## Global Constraints

- Snapshots only from read-only bare mirrors through per-repo deploy keys; no write access to any repo from Atlas.
- Hosts and repos come from Pi Hub `GET /api/systems`; no second list in the page.
- Page stays Improve → Atlas, `/assistant/atlas`; use `--ui-*` kit tokens only (`node app/public/ui/literals.mjs app/public` must not grow).
- Existing schema-2 `graph.json` readers keep working; new fields are additive.
- Element ids, routes and function names are contracts checked by tests; rename none without updating the test in the same PR.
- LocalAI ships only via `npm run ci -- <PR>` then `npm run ship -- <PR>`; Pi Hub via its own release path. Deploy preflight and confirmation rules apply; restarts and firewall changes need owner confirmation.
- Smart display first snapshot records `skipped: [{path, reason}]` and the page shows it; firmware C/C++ is not parsed.
- Undeclared edges are listed as "undeclared", never as errors.

## Review Focus

- Smart display mirror unreachable (PC asleep): Systems card says "mirror unreachable", the other three repos still render.
- Scanned commit newer than the live release record, or no release record: freshness says so in words, never a negative "behind" count.
- A declared edge whose provider repo has no snapshot: result is `no snapshot`, not `provider missing`.
- Repo with zero parsed modules (smart display firmware only): map shows the skipped list, not an empty map without explanation.
- Long repo and module names and 100+ edges in the platform graph: truncate with title text, table fallback stays complete.

---

### Task 1: Smart display in Pi Hub's system list (pi-hub repo)

**Files:**
- Modify: `/Users/billrahe/dev/pi-hub/hub/systems.py` (`ATLAS` dict)
- Test: `/Users/billrahe/dev/pi-hub/tests/test_systems.py`

**Interfaces:**
- Produces: `GET /api/systems` target `firmware` has `atlas: "bambuhelper-smart-display"`.

- [ ] **Step 1: Write the failing test** `test_firmware_target_has_atlas_name`: `systems.body()` hosts → the `devices` host's target with `id == "firmware"` has `atlas == "bambuhelper-smart-display"`.
- [ ] **Step 2: Run** `cd /Users/billrahe/dev/pi-hub && python -m pytest tests/test_systems.py -k firmware -v`. Expected: FAIL (`atlas` is `None`).
- [ ] **Step 3: Add** `"firmware": "bambuhelper-smart-display"` to `ATLAS` in `hub/systems.py`.
- [ ] **Step 4: Run** `python -m pytest tests/test_systems.py -v`. Expected: all PASS.
- [ ] **Step 5: Commit** on a branch from main in a `wt new pi-hub feat/atlas-firmware` worktree; open the PR; do not merge until the owner says "merge".

### Task 2: Runner and scanner accept the smart display (LocalAI repo)

**Files:**
- Modify: `atlas_snapshot_runner.py` (`DEFAULT_REMOTES`: add `"bambuhelper-smart-display": "git@github-atlas-smartdisplay:azmusgb/bambuhelper-smart-display.git"`)
- Modify: `quick_arch.py` (repo profile for `bambuhelper-smart-display`; write `skipped` into `graph.json`)
- Modify: `app/server/atlas.js` / `app/server/atlas-systems.js` only where repo names are validated (`clean(body, repos)`); keep the allow-list driven by the runner's remotes.
- Modify: `docs/` Atlas section listing the PC key alias `github-atlas-smartdisplay`.
- Test: `tests/atlas-scanner-v3.test.cjs` (scanner), `tests/atlas-snapshots-server.test.cjs` (server accepts the repo)

**Interfaces:**
- Consumes: Task 1's `atlas` name `bambuhelper-smart-display`.
- Produces: `graph.json` field `skipped: Array<{path: string, reason: string}>` (empty array for existing repos); snapshots for repo `bambuhelper-smart-display` are served by the existing snapshot endpoints.

- [ ] **Step 1: Write failing tests.** Scanner: a fixture tree with `app.js`, `apply_x.py`, `src/main.cpp`, `include/a.h` scanned with `--repo bambuhelper-smart-display` yields modules for `app.js` and `apply_x.py`, and `skipped` containing `src/main.cpp` and `include/a.h` with reason `"firmware source, not parsed"`. Server: requesting a snapshot for `bambuhelper-smart-display` is accepted (not `unknown_repo`).
- [ ] **Step 2: Run** `node --test tests/atlas-scanner-v3.test.cjs tests/atlas-snapshots-server.test.cjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the repo profile: parse `.py` and `.js` with the existing parsers, group `.c/.cc/.cpp/.h/.ino` files into `skipped`; add the remote.
- [ ] **Step 4: Run** the same command plus `npm test`. Expected: PASS.
- [ ] **Step 5: Add the `github-atlas-smartdisplay` host alias and key on the PC** (owner action; ask first, it touches the PC's SSH config and a deploy key), then take one real snapshot with Snapshot now and record the module and skipped counts in the PR.
- [ ] **Step 6: Commit and open the PR** (`npm run ci -- <PR>` is the gate).

### Task 3: Server-to-server edge scanning and edge checks (LocalAI repo)

**Files:**
- Modify: `quick_arch.py` (find where `extract_module_api_calls` is called; today only `app/public/**` browser scripts feed `outbound` calls. Include server modules, and Python callers using `requests`/`httpx`/`urllib` against a hub base URL)
- Modify: `app/server/atlas-contracts.js` (`check()` result per edge)
- Modify: `atlas/contracts.json` (declared edges for netmon, home-mcp and the smart display as consumers; `allowedConsumerRepos` in `tests/atlas-contracts.test.cjs` already lists home-mcp and netmon, add `bambuhelper-smart-display`)
- Test: `tests/atlas-scanner-v2.test.cjs`, `tests/atlas-contracts.test.cjs`, `tests/atlas-contracts-api.test.cjs`

**Interfaces:**
- Produces: each edge in `GET /api/atlas/contracts` has `check: "confirmed" | "provider missing" | "consumer missing" | "no snapshot"`; response also has `undeclared: Array<{repo, module, method, path, line}>`.
- Produces: `graph.json` module field `apiCalls` includes server modules.

- [ ] **Step 1: Write failing tests.** Scanner: a server module containing `new URL('/api/records', hubUrl)` records an outgoing call `/api/records` with its line. Contracts: an edge whose provider route exists and whose consumer module has the call is `confirmed`; provider route removed is `provider missing`; consumer call removed is `consumer missing`; provider repo with no snapshot is `no snapshot`; a call in a snapshot matching no declared edge appears in `undeclared` and does not change any edge's check.
- [ ] **Step 2: Run** `node --test tests/atlas-scanner-v2.test.cjs tests/atlas-contracts.test.cjs tests/atlas-contracts-api.test.cjs`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** scanner widening and `check()` result values; reuse `matchRoute`/`matchCallPath`, no new matcher.
- [ ] **Step 4: Add the declared edges** (netmon and home-mcp calls to Pi Hub, smart display to Pi Hub notify/records as found in those repos) with `source` text naming the file and line read.
- [ ] **Step 5: Run** `npm test`. Expected: PASS. Commit; PR; `npm run ci -- <PR>`.

### Task 4: Freshness on each system (LocalAI repo)

**Files:**
- Modify: `app/server/atlas-systems.js` (`withSnapshots`)
- Modify: `app/public/atlas-systems.js` (`repoLine`)
- Test: `tests/atlas-systems.test.cjs`, `tests/atlas-systems-strip.test.cjs`

**Interfaces:**
- Produces: each repo in `GET /api/atlas/systems` has `freshness: {live: string|null, scanned: string|null, behind: number|null, scanAgeSeconds: number|null, state: "current"|"behind"|"ahead"|"no release"|"no snapshot"}`; `repoLine(repo, now)` renders it in words ("Map is behind the running release").

- [ ] **Step 1: Write failing tests** for each `state`, including `behind` null when the scanned commit is not an ancestor of live (state `ahead`, text never shows a negative number).
- [ ] **Step 2: Run** `node --test tests/atlas-systems.test.cjs tests/atlas-systems-strip.test.cjs`. Expected: FAIL.
- [ ] **Step 3: Implement** using `release:<target>` record commit as live and the snapshot's commit as scanned; commit distance from the mirror via the runner, `null` when unavailable.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Commit; PR; `npm run ci -- <PR>`.

### Task 5: Platform graph above the Systems strip (LocalAI repo)

**Files:**
- Create: `app/public/atlas-platform.js` (render function `renderPlatformGraph(el, systems, contracts)`)
- Modify: `app/public/index.html` (one `<section id="atlas-platform">` inside the Atlas page), `app/public/architecture.js` (call it after systems and contracts load), `app/public/app.css` (kit tokens only)
- Test: `tests/atlas-platform-ui.mjs` (Playwright), `tests/atlas-platform.test.cjs` (pure layout function)

**Interfaces:**
- Consumes: Task 3 `check`/`undeclared`, Task 4 `freshness`.
- Produces: nodes = the four systems plus home-mcp and netmon; edges coloured by `check` with a text label, not colour alone; each edge selectable by keyboard, showing provider, consumers and the tests that reference the route; a table fallback listing every edge.

- [ ] **Step 1: Write failing tests.** Unit: layout of six nodes and a fixture edge list returns one position per node and one path per edge; 120 edges still produces a complete table. UI: tab to an edge, press Enter, the detail shows provider and consumers; with `prefers-reduced-motion` no animation; states render for no snapshot, scan failed, mirror unreachable.
- [ ] **Step 2: Run** `node --test tests/atlas-platform.test.cjs` and the throwaway-server browser run for `atlas-platform`. Expected: FAIL.
- [ ] **Step 3: Implement** the section; offer the owner a mockup before building the visual layout.
- [ ] **Step 4: Run** `node app/public/ui/literals.mjs app/public`, `npm test`, the browser suite, the width sweep and axe; screenshots at phone, tablet, desktop in light and dark.
- [ ] **Step 5: Commit; PR; `npm run ci -- <PR>`.**

---

## Self-review

- **Spec coverage:** goal 1 → Tasks 1–2; goal 2 → Task 3; goal 3 → Task 4; goal 4 → Task 5; states and non-goals covered in Global Constraints and Review Focus.
- **Open point:** Task 3's scanner change location is confirmed only after reading where `extract_module_api_calls` is called; the first step of that task is to locate it.
- **Types:** `check` values, `freshness.state` values and `skipped` shape are used identically in Tasks 2–5.

# Atlas across repositories: implementation plan

Date: 2026-11-08 · Status: **proposed** · Implements: spec `docs/superpowers/specs/2026-11-07-atlas-across-repos-design.md` (#508), platform baseline §6.4 and §13.

**Goal:** Atlas checks declared contract edges between repositories against live release commits. The owner opens Assistant › System › Advanced › Architecture and sees:
1. Which contracts exist between systems, naming provider and consumer modules.
2. Whether both sides match at the live release commits.
3. The cross-repo blast radius in each module's inspector ("Other systems that call this", "Calls to other systems").
4. Broken edges surfaced directly as high-priority findings.

---

## Prerequisites & Sequencing

As directed by the owner, implementation proceeds in strict sequence:

1. **Gate 0: Record Step 10 Acceptance.** Pi Hub plan `2026-11-07-step-10-finish-and-accept.md` acceptance criteria must be visually verified on the live page and logged in `docs/operations.md` (all 3 repos at live commits, serialized "Snapshot now", unprompted release trigger).
2. **Phase 1: Diff Lens.** Implemented under step 10 P3 ("what changed in this release" vs previous/any kept snapshot) before contract work begins.
3. **Phase 2: Declared Cross-Repository Contracts.** The 4 PRs outlined in this plan.

---

## Architecture & Data Flow

```
+----------------------------------------------------------------------------------+
| atlas/contracts.json (Declared contracts truth: id, route, provider, consumers)  |
+----------------------------------------------------------------------------------+
                                        |
                                        v
+-----------------------+      +---------------------------+      +----------------------+
| LocalAI Snapshot      |      | Pi Hub Snapshot           |      | Print-Lab Snapshot   |
| (calls, httpRoutes)   |      | (calls, httpRoutes)       |      | (calls, httpRoutes)  |
+-----------------------+      +---------------------------+      +----------------------+
         \                               |                               /
          \                              v                              /
           +-----------------------------------------------------------+
           | GET /api/atlas/contracts                                  |
           | - Reads live release commits from GET /api/systems        |
           | - Resolves state per contract:                            |
           |   * Checked (provider serves route, consumer has call)    |
           |   * Provider missing (route missing/moved -> Finding)     |
           |   * Consumer missing (call not in consumer module)        |
           |   * Not checked (unmapped repo e.g. home-mcp)             |
           +-----------------------------------------------------------+
                                         |
                                         v
           +-----------------------------------------------------------+
           | Architecture Page UI:                                     |
           | - "Between systems" collapsible drawer under System strip |
           | - Inspector cross-repo caller & callee sections           |
           | - Findings integration (broken edges ranked #1)           |
           +-----------------------------------------------------------+
```

---

## PR Breakdown

Each PR is small, self-contained, tested, and shipped via `npm run ship`.

### PR 1: Declarations and Validation Test
- **Files:** `atlas/contracts.json`, `tests/atlas-contracts.test.cjs`.
- **Scope:**
  - Create `atlas/contracts.json` declaring the 10 known cross-system edges from the spec:
    - `record.v1` (`GET /api/records` -> LocalAI, home-mcp)
    - Now summary (`GET /api/now`, `GET /api/now/poster/{n}.jpg` -> LocalAI, home-mcp)
    - `needs-item.v1` (`GET /api/needs` -> LocalAI, home-mcp)
    - `record.v1` release ingest (`POST /api/releases/{target}` -> LocalAI, mac-watch)
    - Systems list (`GET /api/systems` -> LocalAI)
    - `print-lab-index.v1` (`POST /api/lab/{project}/sync`, photos -> print-lab)
    - `lab-request.v1` (`GET/POST /api/lab/{project}/requests` -> print-lab)
    - LocalAI notify (`POST /api/notify/localai` -> LocalAI)
    - Camera (`GET /api/camera` -> LocalAI)
    - System health/alerts/backups (`app.py` routes -> home-mcp)
  - Validation test: unique contract IDs, valid methods (GET, POST, PUT, DELETE), absolute `/api/` paths, provider repo in allowed set (`pi-hub`, `localai`, `print-lab`), consumers syntax and known repo targets.
- **Verification:** Unit test green; zero runtime behavior change.

### PR 2: Scanner Schema 3 — Outgoing `/api/` Calls
- **Files:** `quick_arch.py`, `tests/atlas-scanner-v3.test.cjs`, `tests/fixtures/scanner-calls/`.
- **Scope:**
  - Bump `graph.json` version to schema 3.
  - In `quick_arch.py`, extend call extraction beyond browser scripts to **all** modules:
    - JavaScript: string literals matching `/(?:api|releases|lab)\/[a-zA-Z0-9_\-/{}]+/` in fetch/URL calls.
    - Python: path string literals in `urllib.request`, `httpx`, `requests`, and f-strings.
    - Preserve comment stripping and AST filtering so comments and docstrings are ignored.
    - Backward compatibility: schema 1 and 2 snapshots load without errors; consumer sides are marked "Not checked".
- **Verification:** Python unit tests covering JS server calls, Python f-strings, ignored comments, and schema 2 loading.

### PR 3: Server Endpoint `GET /api/atlas/contracts`
- **Files:** `app/server/atlas-contracts.js`, `app/server.js`, `tests/atlas-contracts-api.test.cjs`.
- **Scope:**
  - Implement `GET /api/atlas/contracts`:
    1. Read `atlas/contracts.json`.
    2. Query live release commits via `GET /api/systems` (cached by `atlas-systems.js`).
    3. Load provider and consumer module nodes from snapshot `graph.json` at live commits (fallback to newest snapshot if live is not yet snapshotted).
    4. Compute status for each edge: `checked`, `provider_missing`, `consumer_missing`, `not_checked`.
    5. Return JSON payload: `{ commits: { ... }, contracts: [ ... ], broken_count: N }`.
- **Verification:** Server API tests testing every table state with synthetic graph fixtures (route moved, missing provider, unmapped repo, Pi Hub offline).

### PR 4: Architecture UI — Between Systems & Cross-Repo Blast Radius
- **Files:** `app/public/architecture.js`, `app/public/index.html`, `app/public/app.css`, `tests/architecture-contracts-ui.mjs`.
- **Scope:**
  - UI Drawer: "Between systems" collapsible section under the Systems strip.
    - Header line: "All 10 contracts checked at the live commits" or broken count warning badge.
    - Rows: Contract name, provider chip (clickable to jump to repo/module), consumers chips, and status badge.
  - Inspector:
    - "Other systems that call this" when a provider module is selected.
    - "Calls to other systems" when a consumer module is selected.
  - Findings Integration:
    - Broken contract edges surfaced at the top of "Look here first" findings.
  - Changed Lens:
    - Highlight contracts where provider or consumer module changed since previous release.
  - Visual & Accessibility:
    - Fully accessible buttons, keyboard navigability, 390px and 1440px layouts in light/dark themes, axe clean.
- **Verification:** Playwright UI tests, visual regression baselines, axe accessibility suite.

---

## Acceptance Criteria

1. On live Assistant › System › Advanced › Architecture:
   - "Between systems" section lists all declared contracts.
   - Core provider/consumer edges between `pi-hub`, `localai`, and `print-lab` read "Checked at the live commits".
   - `home-mcp` edges read "Not checked (home-mcp isn't mapped)".
2. Selecting `hub/app.py` in Pi Hub's map shows outgoing consumers in LocalAI and home-mcp.
3. Intentionally misconfiguring a path in a temporary local test of `atlas/contracts.json` raises a high-priority finding ("Broken contract edge").
4. Layout clean at 390px and 1440px with zero accessibility violations.
5. Record completion in `docs/operations.md`.

# Atlas across repositories: the contracts between systems

Date: 2026-11-07. Status: **proposed**, for the owner's review. Builds on the Atlas redesign spec
(`2026-11-04-atlas-redesign-design.md`, approved 4 Nov) and on pi-hub plan
`docs/superpowers/plans/2026-11-07-step-10-finish-and-accept.md` (#171, merged), which names this spec as the next
step. Platform baseline: pi-hub `2026-11-01-platform-product-architecture-design.md`, §4 (object model), §6.4 and §13.

## Why

Atlas maps one repository at a time. The questions that cost the most are between repositories. For example: "if I
change what Pi Hub's `/api/records` returns, what breaks?" Today the answer is a grep across four checkouts, done by hand.
Baseline §6.4 says the cross-repo picture "is in specs like this one", written by hand. This spec makes that picture
something Atlas checks against the code at the commits that are live.

The order the owner approved: **declared** contract edges first, from contracts we already know. Inferring links from
code that nobody declared comes later, if at all (see "Out of scope").

## What exists today (read on 7 Nov 2026; LocalAI `origin/main` ae4b2fb, pi-hub `origin/main` d3edf3f)

- **The contracts have names but no files.** Baseline §4 and §13 name `record.v1` (including kind `release:<target>`),
  `needs-item.v1`, `print-lab-index.v1`, `lab-request.v1`, `healthz.v1` and `error.v1`. No repository has a schema file
  for any of them. appliance-ui ships `tokens.json`, `src/words.json` and `tools.json`. bambuhelper has three device
  schemas of its own. §13 leaves "contract and registry technical design" to a later design.
- **Atlas already knows one side of each edge.** Schema 2 `graph.json` stores `httpRoutes` (`quick_arch.py:1400`):
  - LocalAI's routes come from `app/server.js` and `app/server/*.js`.
  - Pi Hub's come from FastAPI decorators under `hub/`, prefixes included (`fastapi_routes`, `quick_arch.py:748`).
  - The scanner records outgoing `/api/` calls only for browser scripts (`app/public/**`). A server module calling
    another repository, such as `new URL('/api/records', hubUrl)`, isn't recorded.
- **Pi Hub already holds the list of systems.** `hub/systems.py` maps each deploy target to its host, its GitHub
  repository (`REPOS`) and its Atlas repository name (`ATLAS`). It serves this at `GET /api/systems` (`hub/app.py:153`).
  LocalAI's `app/server/atlas-systems.js` reads that list and caches it for the Systems strip.
- **The edges, as the code has them on `origin/main`:**

| Contract | Provider (Pi Hub, `hub/`) | Consumers |
|---|---|---|
| `record.v1` | `GET /api/records`, `app.py:158` | LocalAI `app/pi-hub.js:130`, `app/atlas-releases.js:40`; home-mcp `src/home_mcp/server.py:91,207,226` |
| Now summary (no contract name yet) | `GET /api/now`, `app.py:123`; `GET /api/now/poster/{n}.jpg`, `app.py:310` | LocalAI `app/pi-hub.js:96,144`; home-mcp `server.py:91` |
| `needs-item.v1` | `GET /api/needs`, `app.py:217` | LocalAI `app/pi-hub.js` (needs); home-mcp `server.py:91` |
| `record.v1` kind `release:<target>`, write path | `POST /api/releases/{target}`, `app.py:196` | LocalAI `deploy/Send-LocalAI-ReleaseReport.ps1:62`, `host/mac-watch/watch.py:144` |
| Systems list (no contract name yet) | `GET /api/systems`, `app.py:153` | LocalAI `app/server/atlas-systems.js` |
| `print-lab-index.v1` | `POST /api/lab/{project}/sync`, `GET`/`PUT /api/lab/{project}/photos…` (`lab.py:325,415,428`, prefix `/api/lab`) | print-lab `lab/sync.py:170,181,187` |
| `lab-request.v1` | `GET`/`POST /api/lab/{project}/requests…` (`lab.py:600,700,750`) | print-lab `lab/pull.py:155,238` |
| Notify (no contract name yet) | `POST /api/notify/localai` (`notify_routes.py:19`) | LocalAI `app/hub-notify.js:26` |
| Camera (no contract name yet) | `GET /api/camera`, `app.py:628` | LocalAI `app/print-lab.js:340` |
| Workshop, Pi, freshness, alerts, backups | `app.py:392,724,114,742,222` | home-mcp `server.py:117,139,163,188` |

Pi Hub provides every edge in the table. print-lab also sends telemetry to LocalAI (`lab/sync.py` `localai_base`), and
LocalAI reads Bambuddy (a third party). These have no Pi Hub side; decision 5 says how they're treated.

## What the page does

It is the same Architecture page. The Systems strip at the top already lists what runs where. This adds one section
under the strip and two lists in the inspector.

1. **Between systems** (a section below the Systems strip, collapsed to one line until opened):
   - One row per contract: its name, the provider (repository, module and route), each consumer (repository and
     module), and a state. For example: "`record.v1` · Pi Hub `hub/app.py` `GET /api/records` · used by Local AI
     `app/pi-hub.js`, `app/atlas-releases.js`, home-mcp `server.py` · Checked at the live commits".
   - The header line names the commits it was checked against: "Pi Hub 47c47ca · Local AI ae4b2fb · Print lab 90b6a33,
     the live releases".
   - Selecting a provider or consumer opens that repository's map with that module selected.
2. **The inspector** of a selected module gains two lists, shown only when they aren't empty:
   - "Other systems that call this": the consumers in other repositories, each with its contract.
   - "Calls to other systems": the contracts this module uses, each naming its provider.

   This is the blast radius across repositories. Selecting `hub/app.py` shows that changing it reaches three Local AI
   modules and home-mcp.
3. **Findings** (the existing "Look here first", still at most six) can name a broken edge. Example: "`app/pi-hub.js`
   calls `GET /api/now`, which Pi Hub doesn't serve at 47c47ca." A broken edge ranks above every finding within a
   single repository, because it is a live break between systems.
4. **The Changed lens** marks an edge when the module on either side changed since the snapshot being compared with
   (step 10 plan, P3). The row says "provider changed in this release" or "consumer changed in this release". That is
   the release review question: which contracts this release touched.

There is no cross-repository node graph. The redesign removed the unreadable plate, and four repositories' modules on
one canvas would bring it back. Contracts are a list. Each map stays one repository.

## Each edge's state

The state is worked out for each edge, from the declaration and the two repositories' snapshots:

| State | When | What the row says |
|---|---|---|
| Checked | The provider's snapshot has the route in `httpRoutes`, owned by the declared module, and the consumer's snapshot has a call to that path in the declared module | "Checked at the live commits" or "Checked at <commits>, not the live ones" |
| Provider missing | The route isn't in the provider's `httpRoutes`, or another module owns it | A finding: "… which Pi Hub doesn't serve at <commit>" |
| Consumer missing | The declared module has no call to that path | "Declared but not found in <module> at <commit>": the declaration is out of date |
| Not checked | A side has no snapshot, or it is a schema 2 snapshot without outgoing calls, or its repository isn't mapped (home-mcp, the PC's PowerShell report) | Says which, for example "home-mcp isn't mapped", never "OK" |

"Not checked" is never shown as "Checked". A route that moved to another module counts as missing, not as checked,
because the declaration names the module that owns it.

## Data

1. **Declarations** (decision 1): `atlas/contracts.json` in LocalAI. It is a list. Each entry has:
   - `id` (unique);
   - `contract` (a baseline §13 name, or `null` with a `label`);
   - `provider`: `{repo, module, method, path}`;
   - `consumers`: `[{repo, module}]`;
   - `source`: the spec or plan that defines the contract.

   `repo` is an Atlas repository name (`localai`, `pi-hub`, `print-lab`) or a named unmapped one (`home-mcp`).
   A test checks the file: unique ids, known repositories, paths starting with `/`, methods from a fixed set, no
   duplicate provider route.
2. **Outgoing calls in the scanner** (decision 3): `graph.json` schema 3 adds `calls` to each module. These are the
   `/api/…` string literals the module uses to build a request, with the line number, from every module, not only
   browser scripts. It covers JavaScript, which the browser rule already extracts this way, and Python
   (`urllib.request.Request`, `httpx`, f-strings with a path literal). The existing comment-line filter applies.
   Snapshots at schema 1 and 2 still load; their consumer side is "Not checked".
3. **`GET /api/atlas/contracts`** joins the declarations with each repository's snapshot at its live commit:
   - The live commit comes from `GET /api/systems`, through `atlas-systems.js`'s cache (decision 2).
   - With no snapshot at the live commit, it uses the newest snapshot and says so.
   - It returns each edge's state and the commits used. It only reads: no scan starts from this route.

## States of the section

- **Loading:** the section's line says "Checking contracts" while the rest of the page draws.
- **The Pi can't be reached:** it uses the cached systems list, with "live commits as of <age>".
- **The PC is asleep:** nothing changes, because this page is LocalAI's, on the PC.
- **No declarations file, or it fails its check:** "Contract list can't be read: <reason>". No edge is shown as checked.
- **Every edge is checked:** the collapsed line says "All 10 contracts checked at the live commits". The rows stay
  available.
- **Long content:** module paths end in an ellipsis, with the full path in a tooltip and in the inspector. At 390 px each
  row stacks: contract, provider, consumers, state.

## Accessibility and fit

- The section's toggle is a `<button>` with `aria-expanded`. Each provider and consumer is a link-styled button that
  says where it goes ("Open Pi Hub map at hub/app.py").
- A state is shown as words and a chip, never colour alone. A broken edge uses the kit's bad tone.
- It uses the LocalAI kit's tokens. It adds no new colour.
- `prefers-reduced-motion` turns off the expand animation.

## PRs

Each is small and tested first, shipped with `npm run ship`.

1. **Declarations and their check.** `atlas/contracts.json` with the edges from the table above, plus its test. No
   behaviour changes. The owner reviews the list itself in this PR: it is the declared truth.
2. **Scanner schema 3: outgoing calls** (`quick_arch.py`). Python tests come first:
   - a fixture JavaScript server module calling `new URL('/api/records', hub)`;
   - a Python module with an f-string path;
   - a commented-out call that is ignored;
   - a schema 2 graph still loading.
3. **`GET /api/atlas/contracts`.** Unit tests over fixture graphs come first, one for each state in the table:
   checked, provider missing, route moved to another module, consumer missing, an unmapped repository, a schema 2
   side, no snapshot at the live commit, and the Pi unreachable with a cached list.
4. **The page:** the Between systems section, the two inspector lists, broken-edge findings and the Changed lens mark.
   Includes browser checks for the toggle, keyboard use and 390 px, plus the axe suite and visual baselines at 390 and
   1440 px in both themes.

PR 1 can merge on its own. PR 3 needs PRs 1 and 2. PR 4 needs PR 3, and its Changed lens mark needs the step 10
plan's P3.

## Acceptance

The owner looks at the live page and sees:

- All the table's edges listed. Each edge between the three mapped repositories reads "Checked at the live commits"
  once the live commits are snapshotted at schema 3.
- home-mcp's and the PowerShell report's edges read "Not checked", naming why.
- Selecting Pi Hub `hub/app.py` lists its consumers in other repositories. Selecting LocalAI `app/pi-hub.js` lists the
  contracts it uses.
- A broken edge raises a finding. It's shown with a test fixture, and once on the live page by editing a local copy
  of the declarations file to name a path Pi Hub doesn't serve, then restoring it.
- At 390 px and 1440 px, in both themes, it reads correctly, and the browser suite and axe are clean.

The record goes in LocalAI `docs/operations.md` as "Atlas across repositories accepted <date>". A matching commit on
the PC is a deploy, not acceptance.

## Decisions (recommendations first)

1. **The declarations live in LocalAI, in `atlas/contracts.json`, until contract files exist.**
   - The baseline names the contracts but leaves their technical design open (§13). No schema files exist.
   - Recommend a small list owned by Atlas. It records where each contract crosses between repositories, which is a
     fact about code, and that is Atlas's subject. When contract files exist (in `home-platform` or appliance-ui),
     this list is generated from them and the hand-written one is removed in the same PR. Its `source` field says
     where each contract is defined until then.
   - Rejected: putting it in Pi Hub's registry (`hub/systems.py`). That holds runtime names and states, not code
     locations, and every contract change would then need a Pi Hub release.
   - Rejected: waiting for the contract design. That would block a useful check on work nobody has scheduled.
2. **Compare at the live commits, from the release records.** "What breaks between systems" is a question about what
   runs. The release records are the deployment truth (baseline D1, D7), and the Systems strip already reads them.
   With no snapshot at a live commit, the newest one is used, and the row says it isn't the live one.
   Rejected: each repository's newest snapshot by default. That checks code that may not be running.
3. **The scanner records outgoing calls in every module, as schema 3.** The declaration names the consumer module.
   Without the module's calls in `graph.json`, the consumer side can only be trusted, not checked.
   - Trade-off: a schema bump, and older snapshots show the consumer side as "Not checked" until they are
     rescanned. A release rescans each repository within minutes, so the live commits have it after their next
     release, or after "Snapshot now".
   - Rejected: searching the clean copies on each page load. That's slow, depends on copies that are pruned, and
     isn't how Atlas works (it reads snapshots).
4. **Unmapped repositories are named consumers, not maps.** home-mcp and the PowerShell release report call Pi Hub.
   Leaving them out would understate the blast radius. Mapping home-mcp is satellite onboarding, which was decided on
   1 Nov as "added later, config plus deploy key". So they appear by name and file, with "Not checked".
5. **Pi Hub is the only provider in the first list.** The edges the owner named (records, `/api/now`, release records,
   the print-lab mirror, home-mcp) all point at Pi Hub. print-lab's telemetry to LocalAI and LocalAI's Bambuddy calls
   fit the same format and can be added in PR 1 if the owner wants them. Bambuddy is a third party with no map, so
   its side would always be "Not checked".

## Out of scope (noted, not gated)

- **Inferred edges.** Matching every outgoing call to any repository's routes, declared or not, would find what
  nobody declared. Once schema 3 exists it's cheap: a "Calls not in the contract list" list. It's a separate spec
  after this one is accepted, as the owner ordered.
- **Payload checks.** This checks that each route and caller exist, not that the shape each side reads matches. That
  needs the contract files from baseline §13.
- **Satellites as maps** (home-mcp, netmon, appliance-ui, the display firmware). These follow the 1 Nov decision.
- **The display's links** (the display feed v2, the message channel). The baseline gives them to `display-on-hub`.
  They can join the list once the firmware is mapped.

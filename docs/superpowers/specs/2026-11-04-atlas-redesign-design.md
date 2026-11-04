# Atlas redesign: a map you can read

Date: 2026-11-04. Status: approved by the owner ("approve", 4 Nov 2026), decisions 1-4 as recommended. Direction from the prototype ("love it"); the
decisions are below. Builds on `docs/superpowers/plans/2026-11-01-atlas-every-repo.md` (snapshots per
repository and commit, PRs 1-6) and replaces the page's "plate" layout (#471). Platform baseline: section 6.4 and
step 10 (pi-hub `2026-11-01-platform-product-architecture-design.md`).

Prototype, built from the live Local AI snapshot of 31 Oct: https://claude.ai/artifact/CQRUJ5wUh48nR9ChSLBY54

## What is wrong today (live 2.0.1248, `ff9081c`)

1. **The map says almost nothing.** Every module is an unlabeled grey square in a domain box. You learn a domain's
   size and nothing else until you click. No lines show what depends on what, though that is the one thing an
   architecture map is for.
2. **The data is thin.** The scanner records code imports only: 108 links between 142 production modules. The 52
   browser scripts reach the server over HTTP, so they show almost no links, and the UI looks disconnected from the
   API it calls. Services, ports and the other repositories are missing.
3. **The risk score points the wrong way.** `risk_score()` counts every importer, tests included, so a module gets
   riskier as tests are added. `app/storage.js` scores 63 ("high") mainly because 24 test files import it.
4. **The findings don't say why.** A numbered circle on a square, with the reason one click away in the inspector.
5. **It is often stale without saying so clearly.** The newest scan is 4 days older than the running release.

## What the page does

One page, three layers, read top to bottom. The prototype is the reference for layout and copy.

1. **Systems: what runs where.** One card per host: Pi (always on), PC (may sleep), Mac, Devices, Off-site. Each
   lists its services and repositories. A repository shows "mapped · <commit> · <age>" or "no snapshot yet".
   Selecting a repository loads its map below. Hosts and services come from Pi Hub's registry and the
   `release:<target>` records (decision 2), never from a list typed into the page.
2. **The map: how one repository depends on itself.** Columns run from callers to what they use:
   Browser → Entry → Server → Capabilities → Shared → Data. The column rules are per repository. LocalAI's come from
   its domains; other repositories use the per-repository map from plan PR 1. Each module is a named row with a bar
   sized by its connections and coloured by the current lens. Links are curves. Selecting a module colours what it
   uses (blue) and what uses it (orange) and dims the rest. HTTP links (browser to route) are dashed, so they read
   apart from imports.
3. **Look here first.** At most six findings, each a sentence with its reason in plain words. For example:
   "server.js wires up 63 modules and no test imports it. Every route starts here. A smoke test that boots it would
   catch a broken import before deploy." Selecting a finding selects its module and scrolls the map to it.

**Inspector** (right column; a sheet below the map on phones):
- Name, path and domain.
- Risk out of 100, with a chip.
- Four figures: uses, used by, affected (everything that depends on it, directly or not), and test references.
- "Why it ranks here".
- The lists of what it uses, what uses it, and the tests that import it. Each entry selects that module.
- Ask and Goose (unchanged from today) move to the bottom of the inspector, scoped to the selected module.

**Lenses:** Risk, Tests, Blast radius, Changed since the previous snapshot.

**Search:** `/` focuses it. Enter selects the first match. Escape clears the search, then the selection.

**Freshness:** one line in the header, for example "Snapshot 31 Oct · 4 days old · older than the running release
ff9081c". It turns amber when the snapshot's commit is not the live one, and gives the "Snapshot now" button.

## Data the scanner adds (`quick_arch.py`, `graph.json` schema version 2)

1. **HTTP links.**
   - Browser side: string literals that start `/api/` in `app/public/**` (`fetch`, `api()`, `EventSource`).
   - Server side: route literals in `app/server.js` and `app/server/*.js` (`p === '/api/…'`, `startsWith('/api/…')`).
   - Each browser module links to the server module that owns the longest matching route. Today that is 128 distinct
     browser paths and 190 server paths. Links are typed `http`. A path with no owner becomes a finding ("calls
     /api/x, which nothing serves").
   - The same idea covers pi-hub (`@app.get(...)` in FastAPI) through the per-repository rules.
2. **Typed links.** Each link records `kind`: `import`, `http` or `test`. Test links are kept apart, so the page counts
   tests per module without drawing them.
3. **Risk, rebuilt and explained.** Risk is made of reach (how many modules depend on it, directly or not), fan-out,
   and fan-in, with each test that imports the module reducing it. The score ships with its parts
   (`riskParts: {reach, out, in, tested}`), so the page can say why. Tests can only lower risk.
4. **Systems manifest.** Not scanned. LocalAI reads hosts, services, ports and repository-to-target names from Pi
   Hub's registry and release records (decision 2) and serves them as `GET /api/atlas/systems`. It is cached, so the
   strip still draws when the Pi is unreachable, marked with the age of that copy.

Schema version 1 snapshots still load. The page shows them without HTTP links or risk parts, and says
"Older snapshot: rescan for HTTP links".

## States

- **Loading:** the systems strip and map frame draw at once, and the map fills in.
- **No snapshot for this repository:** say why and offer "Snapshot now". The reasons are no deploy key, no mirror,
  or never run.
- **Stale:** the amber freshness line, as above.
- **Snapshot running or queued:** a progress line on the map. The previous snapshot stays readable underneath.
- **Error:** what failed (scanner, intelligence service, PC asleep) and what to do.
- **Large repositories:** past 400 modules, domains collapse to one row each with a count, and open on selection.
  Labels never clip silently; long names end in an ellipsis with the full path in the inspector.

## Accessibility and fit

- Every module row is a button with a label that reads its risk, dependents and tests.
- Focus is visible. Lens buttons use `aria-pressed`.
- Colour is never the only signal: lenses have a legend, and changed modules carry a dot.
- `prefers-reduced-motion` turns off the scroll animation and transitions.
- At 390 px, the map scrolls inside its own frame and the inspector stacks below it. The page itself never scrolls
  sideways.
- It uses the LocalAI kit's tokens. The prototype's survey-sheet palette is a direction, not new tokens: risk colours
  map to the kit's semantic colours.

## PRs

Each PR is small and tested first, shipped with `npm run ship`. The page keeps working between them.

1. **Scanner v2: typed links and HTTP links** (`quick_arch.py`). This adds schema version 2, `kind` on links,
   browser-to-route matching for LocalAI, and the "nothing serves this path" finding. Python tests come first:
   a fixture repository with two browser scripts, two routes and one dangling call.
2. **Risk rebuilt with its parts.** Tests come first: adding a test import never raises a score; `server.js` stays
   critical; `storage.js` drops below high.
3. **The page: map, inspector and findings** (`app/public/architecture.js`, `app/public/app.css`). It replaces the
   plate. It covers the lenses, search, states and the version 1 fallback, with the browser suite updated and new
   visual baselines at 390 and 1440 px.
4. **Systems strip and `GET /api/atlas/systems`.** It reads Pi Hub's registry and records, with the cached fallback.
5. **pi-hub and print-lab rules.** These add FastAPI route extraction and the column rules for each. They depend on the
   deploy keys of plan decision 1.
6. **Ask: a small packet about the selected module** (`atlas_intelligence.py`). See "What Ask sends the model" below.
   Tests come first: the packet's size limit, the selected module coming first, the refusal of a model whose context
   is too small, and compact JSON.

## What Ask sends the model

Measured 4 Nov 2026 against the live graph (31 Oct snapshot, `atlas_intelligence.py` on `5f26d31`):

- Every question sends about 5,400 tokens of evidence. With a module selected it is about 8,600.
- About 60% of that is the same repo-wide material whatever the question: 16 top findings and 12 finding groups.
- The selected module comes last, after everything else. That is where a small model is least likely to use it.
- The request sets no `num_ctx`. The default model, `qwen3:4b-instruct-32k`, has 32,768 tokens, so it fits. The picker
  also offers `qwen3:4b-instruct-8k` and `qwen3:4b-instruct` (no context set). On those, Ollama silently cuts the
  prompt, and the system prompt and rules can be the part that is lost.

Target:

1. **Order.** The question comes first, then the selected module with what it uses, what uses it, its tests and its
   risk parts. After that come only the findings that name that module or its neighbours. Repo-wide findings go in only
   when no module is selected.
2. **Size.** Send compact JSON, not indented. Cap the packet at 3,000 tokens for a selected module and 4,000 without
   one, and drop the lowest-ranked items first. Each answer says what was left out.
3. **Context.** Send `num_ctx` explicitly. Refuse a model whose context can't hold the system prompt, the packet and a
   1,000-token answer, and say which model to pick instead.
4. **Files on demand.** Ask never inlines file contents. Goose opens files when it needs them, read-only, from the
   snapshot's clean copy (unchanged from plan PR 5).

## Acceptance

- On the live page, LocalAI's map shows named modules with links, including an HTTP link from every browser module
  that calls the API. PR 1 found 16 such modules (18 links, all 134 paths served) on 4 Nov; the earlier "at least 40"
  overcounted, because most browser scripts never call the API.
- Selecting `app/server.js` highlights its 63 imports. Its inspector shows risk, reach and "no tests".
- The findings name at least one real dangling or untested route, or say there are none.
- No module's risk rises when a test that imports it is added (a unit test proves this).
- The page reads correctly at 390 px and 1440 px in both themes, with the browser suite and axe clean.
- A version 1 snapshot still opens.
- Asking about `app/storage.js` sends at most 3,000 tokens of evidence, with that module first. Choosing an 8k model
  either fits or gets a clear refusal, never a silently cut prompt.

## Decisions (recommendations first)

1. **Replace the plate rather than offer both.** Recommend replace: two maps of the same data split attention, and
   the plate shows nothing the new map lacks.
2. **Systems data comes from Pi Hub's registry and release records.** Recommend this rather than a list in LocalAI,
   because the baseline makes the registry the one source of names (Shared foundations) and the records the
   deployment truth (D1, D7).
3. **Close draft #482** (the unreviewed `atlas_intelligence.py` edit found on the PC). Recommend closing. Its two real
   improvements, `_as_int` for numeric strings and checking the question before loading the snapshot, become part of
   PR 2 with tests.
4. **Keep Ask and Goose.** Recommend keeping them, in the inspector, scoped to the selected module.

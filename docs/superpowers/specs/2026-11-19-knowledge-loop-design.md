# Knowledge loop: research, evidence and controlled improvement

**Status:** proposed, design only. Nothing here is approved or built.
**Date:** 2026-11-19
**Answers:** the owner's "Master Engineering Brief" (autonomous knowledge, research and evolution platform, working name "Knowledge Command"), first assignment: inspect and design.
**Read at:** LocalAI `b01e8b68`, pi-hub `c7ec699` (plus open PR #288), print-lab `39ec96e`, appliance-ui `3575e8f` (2.23.2), each at `origin/main` after a fetch.
**Governed by:** the platform baseline (`pi-hub/docs/superpowers/specs/2026-11-01-platform-product-architecture-design.md`). Section 3.9 lists what this design would change in it; those are a proposed amendment, not decisions.

Labels used throughout: **Observed** (read in code or a spec at the commits above), **Inferred** (follows from what was observed, not checked directly), **Unverified** (not inspected), **Recommendation** (this document's proposal).

---

## 1. Executive assessment

**Feasibility.** The closed loop in the brief is feasible on the stack that already exists, without a new service, database or framework. The full vision (adaptive research trees, earned autonomy, model optimisation) is not one project; it is five or six, and the later ones only make sense once the earlier ones have produced data.

About half of the loop is already built in LocalAI under other names:

| Brief concept | Already exists (Observed) | Missing |
|---|---|---|
| Engineering Improvement Queue | Improve backlog and Claude board: findings, severity, votes, decisions, ranked by `claudeScore` (`app/server/changes.js:604`) | Evidence links, value/readiness, contracts |
| Discovery Inbox | Signals, promoted at high severity or 3 occurrences (`app/improve.js:50-52`) | External sources; only internal signals feed it |
| Controlled implementation | Change pipeline plan → stage → validate → approve → request-apply (`/api/changes/*`), engineering runs, Hand to Claude (`app/improve.js:96-126`) | A contract the implementer cannot edit; baseline measurements |
| Release gate | Local CI, `npm run ship`, `release` branch, Safe Deploy rollback (`scripts/local-ci.mjs:2-28`) | Post-release outcome check |
| Episodic memory | Journal (FTS5, `ref` idempotency, redaction, tombstones; `app/journal.js:9-22`), run ledger | Nothing for this design |
| Preference memory | Owner facts and fact suggestions with owner Save (`app/owner-facts.js`, `app/fact-suggestions.js`) | Nothing for this design |
| Scheduler | 30 s automation tick with non-overlap and claim-before-run (`app/server/automations.js:20-23`, `app/server.js:322`) | Durable per-job retry, backoff, budgets |
| Bounded agent loop | `runAgentLoop`: 8 turns, 12 tool calls, 10 min, per-tool 15 s, context cap, abort signal (`app/agent-runtime.js:92-94`) | Nothing for this design |
| Model routing with privacy | Coordinator: local by default, cloud only for non-private kinds with the switch on, redaction before send (`app/model-router.js:9-16`, `app/model-coordinator.js`) | Nothing for this design |
| Experiment structure | print-lab's question/experiment/verdict records and guards (`lab/records/schema.py`, `lab/loop/guards.py`) | A software equivalent |
| Evaluation signal | Answer feedback table (`app/answer-feedback.js:15-26`); roadmap project B "model leaderboard" (not built) | A benchmark harness |

What does not exist anywhere: a source registry, ingestion from external sources, knowledge records with provenance and a lifecycle, research branches, a software experiment lab, benchmarks, and server-side authority gates.

**Highest-value opportunity.** Measurement, not discovery. Reading the web is cheap and already half-present (SearXNG). What the platform lacks is any way to say "this change made X better by Y": there is no benchmark for anything. The single most valuable thing this project can produce is an Improve item that carries its sources and a measured before/after, with the outcome written back as knowledge. Everything else in the brief is in service of that sentence.

**Major risks, ranked.**

1. **The hand-off is a privilege escalation path.** Text from the web becomes a finding, a finding becomes a backlog item, and a Claude session with repository write access works that backlog. Without a hard boundary, a poisoned page can steer code changes. Today web search results already reach chat prompts unmarked (`app/server/chat.js:83-91`, Observed), so the boundary has to be built before any ingestion, not after.
2. **Activity mistaken for progress.** A system that ingests 200 items a day and produces 30 "opportunities" will be ignored within two weeks. The scarce resource is the owner's attention, and the design must budget it explicitly.
3. **Self-grading.** A model that proposes a change and also judges it will approve it. Until deterministic benchmarks exist, the honest authority level is L1 (recommend), not the brief's default of L2.
4. **Resource contention on one PC.** One GPU serves interactive chat, voice, images and missions through a concurrency-1 model queue (`app/agent-runtime.js:37`). Background research must yield to all of them, and the PC is not always on.
5. **Scope.** The brief names ten GUI sections and twenty-four entities. Built literally it is a second product beside the Assistant, against a baseline that caps the Assistant at four sections and two levels (A27) and is tightening, not widening.
6. **Shell size.** The shell is at its budget: `ui.js` measures 119,797 B gzipped against a 119,808 B limit, `index.html` 17,406 against 17,408, `app.js` 40,782 against 40,960 (measured with `gzip -9` at `b01e8b68`; `tests/budgets.test.cjs:223`). Any new UI must be an on-demand module.

---

## 2. Verified repository inventory

### 2.1 What was inspected

| Repo (actual name) | Purpose (Observed) | Stack (Observed) |
|---|---|---|
| `azmusgb/LocalAI` (`~/dev/ai-harness/LocalAI`) | The AI service: the Assistant, run ledger, Improve, Atlas | Node ≥ 22.13, built-in `node:sqlite`, vanilla-JS PWA, **no runtime npm dependencies**, no build step; Docker on a Windows PC (32 GB) |
| `azmusgb/pi-hub` | Runtime front door: shell, gate, records, Needs you, push, device actions | FastAPI, plain ES modules, Caddy, systemd; Pi 4, 4 GB, service capped at `MemoryMax=200M`, SD-card root with 9.9 GB free |
| `azmusgb/print-lab` | Mac-side experiment engine for the X2D and H2S | Python 3.12 + uv, JSON records with file locks, CLI authoring |
| `azmusgb/appliance-ui` | Shared UI kit and design contract | CSS tokens and components, small JS helpers, vendored into each app |

**Not inspected (Unverified):** `home-mcp`, `netmon`, `bambuhelper-smart-display` and the firmware repos; the live state of the Windows host (container egress rules, sleep schedule, installed models); whether LocalAI's live release matches `b01e8b68`.

### 2.2 LocalAI: observed facts

**Persistence.** One SQLite database. Twenty-one JSON-payload collections (`app/storage.js:12-34`: projects, conversations, knowledge sources and chunks, missions, agent runs, automations and their runs, approvals, changes, project memory, monitors, quality events, issues, engineering runs, deployments, and others), a `settings` key/value table that also holds the run ledger (one row per run, newest 250 kept unless pinned or filed; `app/run-ledger.js:6,24`) and the Claude board. Three purpose-built tables added since: `journal` with `journal_fts`, `journal_deleted`, `answer_feedback`. New tables are created `IF NOT EXISTS` with no schema-version bump so a rollback still opens the database (`app/journal.js:3-5`). Nightly backup: `VACUUM INTO` snapshot with an off-site copy to OneDrive (`deploy/Backup-LocalAI-Data.ps1`).

**AI and tools.** Ollama locally; Groq then Cerebras for non-private kinds when the owner's cloud switch is on, with this PC's model always last. Chat is a single model call with no tools. Missions use `runAgentLoop` with read-only tools: `search_project_knowledge`, `read_project_file`, `find_in_project`, and `search_web` only when `allowWeb` is set (`app/agent-tools.js:120-205`). Tool results are declared untrusted in the system prompt (`app/agent-runtime.js:101`).

**Research today.** `webSearch: true` on a chat turn runs one SearXNG query and pastes title, snippet and URL of each result into the prompt (`app/server/chat.js:83-91`). An automation of kind `research` runs a SearXNG query on an hourly or daily schedule and stores the raw output (`app/server/automations.js:14`). No source registry, no documents, no claims, no deduplication, no provenance.

**Knowledge today.** Project "knowledge sources" are owner-imported documents cut into 1,800-character chunks and scored by keyword (`app/server/projects.js:79-100`). Project memory notes and owner facts are short owner-approved notes. None has confidence, verification status, validity dates or contradiction handling.

**Untrusted text.** One helper, `app/untrusted.js`, defuses `<<<`/`>>>` so quoted text cannot close its block; used for board requests, journal entries and project notes. Web search snippets do not go through it.

**Outbound fetch.** `/api/browser/fetch` and `/api/actions/http-check` accept any http or https URL; `validateExternalUrl` checks only the scheme (`app/server/workbench.js:19`). Both are sign-in guarded, but neither blocks private, loopback or tailnet addresses. This is a standing SSRF weakness independent of this project (follow-up F1).

**Authentication.** Device-cookie sign-in in report-only mode by default; a GUARDED list is refused without a device even in report mode, covering the routes that run code, write files, approve changes, read the journal or touch the Claude board (`app/signin.js:11-32`). The Mac key signs in the Mac and Claude sessions.

**Approvals.** `b.approved === true` in the request body is the whole check on workbench write, computer batch and one more route (`app/server/workbench.js:17,23,44`). Approvals are records the caller asserts, not gates the server enforces.

**Observability.** Run ledger (status, bounded events, output), Activity, journal, sign-in report, health and watchdog ticks, quality events and issues scanned on a timer. No trace id that spans a mission, its tool calls and a resulting change.

**Testing.** 288 files under `tests/`, 68 of them browser suites; local CI is the only CI (no GitHub Actions) and posts a commit status; `ship` merges only the tested commit and moves `release`. Size budgets, lint and a kit-literals check run in the unit suite.

**UI.** 28 view ids in `app/public/view-registry.js`; page names come from `pages.json`. A27 (merged, not built) cuts the Assistant to Ask, Work, Projects, Improve, with Setup moved to System › Assistant.

### 2.3 pi-hub: observed facts

- **§6.2:** one server path for device actions, `POST /api/printer/{action}`; the surfaces that can act are Pi Hub and the display. LocalAI is deliberately not one.
- **§3:** "Knowledge and workspace: Projects, sources, memory, library… LocalAI-only." Research is listed under the AI domain.
- **`AGENTS.md:8-11`:** a new page, navigation model, Caddy route or store is a proposed amendment and is not implemented before its PR merges.
- **A28 D5:** stored text reaching a model is data in a marked block, in a run with no tools, on this PC only; no journal text in any run that has tools.
- **A30 (PR #288, open):** the Assistant proposes and Pi Hub executes; four fixed read-only tools in chat; all outside text marked untrusted including web results; chat as the front door.
- **Actions:** `/api/actions/{name}` requires only the `household` role although the baseline says owner-only; confirmation is client-side only (recorded in A30 as a gap).
- **Hardware:** Pi 4, 4 GB; `/tmp` is a small RAM disk; the USB drive may be absent. The Pi is not a place for a research workload or a growing store.

### 2.4 print-lab: observed facts

The experiment model is the most rigorous structure in any of the four repos and transfers almost unchanged in shape: a **question** with budget, stops and an autonomy level 0–4; an **experiment** with hypothesis, a machine-checkable `expect`, exactly one factor with declared dependent adjustments, variants with control and anchor roles, builds fingerprinted by input hash, an approval bound to the artifact hash, an owner verdict that keeps superseded verdicts, and an outcome derived purely from records (`lab/loop/outcome.py:104-133`). Guards list every failure rather than stopping at the first; a `refuted_dependency` guard blocks work that relies on a refuted conclusion; two uninformative outcomes in a row stop a question automatically. The code is coupled to printing (factors, geometry, grams, plates) and is Python; the shape is reusable, the code is not.

### 2.5 appliance-ui: observed facts

`DESIGN.md` requires one dominant purpose and one primary action per screen, summary then exceptions then detail, technical detail behind a "Details" disclosure, and forbids KPI tiles, charts or feeds unless they support a decision. States live, stale, unavailable, unknown and demonstration are distinct. Components that exist: rows, table (with stacking), chips, filter chips, tabs, faceplate with aside, sections, notice, empty, skeleton, meter, the Needs-you list, inline confirm, the ⌘K palette. Components that do **not** exist: timeline, diff view, split or detail pane, tree. New components go into the kit, never into one app.

### 2.6 Work in flight that this design must not collide with

Observed worktrees under `~/dev/.worktrees/LocalAI/`: `feat-signin-banner`, `fix-past-work-titles`, `fix-home-silent-reads`, `fix-route-fallback-telemetry`, `fix-chat-cancel-timeouts`, and others. pi-hub PR #288 (A30) is open. No other open PRs in the four repos. This design touches none of those files; step 1 adds new files and three small wiring edits in `app/server.js` and `app/signin.js`, which the sign-in banner branch may also touch (rebase risk, low).

---

## 3. Proposed architecture

### 3.1 Position

**Recommendation.** Do not build "Knowledge Command" as a product. Grow Improve. The Assistant already has a pipeline named Signals → Backlog → In progress → Shipped; this design adds what comes before Signals (sources, documents, findings) and what the pipeline lacks in the middle (evidence, experiments, contracts) and at the end (outcomes). One pipeline, one queue, one memory.

LocalAI owns all of it. Pi Hub changes nothing in the first three phases. print-lab keeps its own experiments and is a model, not a dependency.

### 3.2 Boundaries and components

All in the LocalAI Node process, as modules under `app/research/` with routes in `app/server/research.js`. No new service.

| Brief responsibility | Component | New or reused |
|---|---|---|
| A. Orchestrator | `jobs` table (lease, attempts, idempotency key, budget) driven by the existing 30 s tick | New table, reused tick |
| B. Discovery | `net-guard`, `fetcher`, `feed` parser, `intake` | New |
| C. Knowledge and memory | `research_documents`, `research_findings`; journal (episodic); owner facts (preference); repo files such as `AGENTS.md` and skills (procedural) | Mostly reused |
| D. Research planner | `topics` with depth, breadth and budget; decisions written as events with reasons | New, phase 4 |
| E. Actor | `runAgentLoop` for reading; Claude sessions through the existing board for code | Reused |
| F. Evaluation | Benchmark suites as files under `evals/`, deterministic scorers, `experiments` table shaped like print-lab's | New, phase 3 |
| G. Priority | Value score plus a readiness checklist on Improve items | Extends `claudeScore` |
| H. Evolution | Contracts attached to Improve items; existing change pipeline and Hand to Claude | Extends |
| I. Policy and release gate | One server function `allowed(operation, context)`; local CI and ship | New function, reused gate |
| J. Control plane | Pages inside the Assistant's Improve section | Extends |

**Memory mapping (Recommendation).** The brief's four memory types do not need four stores:

- *Episodic* is the journal and run ledger. Already built.
- *Preference* is owner facts. Already built, owner-approved by design.
- *Procedural* is what the repos already version in git: `AGENTS.md`, `CLAUDE.md`, skills, plans. A lesson that should change how agents work is a PR to one of those files, reviewed like code. Do not build a database of instructions that models read back; that is the memory-poisoning surface with no reviewer.
- *Semantic* is the only new store: findings with provenance and a lifecycle.

### 3.3 Data flow

```
 registered source ──fetch──▶ document ──read (no tools, local)──▶ finding
   (owner-approved)   │        (provenance,                        (claim + quoted
                      │         hash, revision)                     evidence + status)
              net-guard                                                  │
                                                          owner: keep / dismiss / promote
                                                                         ▼
 outcome ◀── shipped ◀── PR + local CI ◀── Claude session ◀── Improve item
 (measured,   (existing    (existing)       (existing           (evidence, value,
  written      reconcile)                    hand-off)           readiness, contract)
  back to                                                             │
  the finding)                                             experiment (phase 3):
                                                           baseline vs candidate on a
                                                           pinned benchmark, scored
                                                           by code, not by a model
```

### 3.4 Trust boundaries

Three zones, with one rule each.

1. **Outside text** (anything fetched). It is evidence. It is stored verbatim, bounded, and only ever enters a prompt inside an `UNTRUSTED` block through `app/untrusted.js`. The run that reads it has **no tools** and, by default, runs on this PC. Its only output is JSON checked against a fixed shape (claim ≤ 300 characters, a quote that must appear verbatim in the document, a relevance label from a closed list). Anything that fails the shape is discarded and counted.
2. **Derived records** (findings, topics, scores). They are the model's reading of evidence, never instructions. A finding moves past `extracted` only by an owner action or by corroboration from a second, independently registered source. A finding never enters a run that has tools; this extends A28 D5.4 to a new class of stored text.
3. **Authority** (anything that changes a repo, a setting or a device). Reached only through the owner: promotion to the backlog is an owner action, and the text handed to a Claude session is quoted between the existing `UNTRUSTED_REQUEST` markers (`app/improve.js:112`) with the sources listed as links, not pasted.

The reader, the proposer and the judge are different things: a no-tools reader extracts, the owner promotes, a scorer written in code judges. No model output is ever the approval for another model's output.

### 3.5 Persistence

**Recommendation: SQLite, the same database, new tables created `IF NOT EXISTS`.** Reason in section 7.

Step 1 tables: `research_sources`, `research_fetches`, `research_documents` (+ FTS5). Later: `research_findings`, `research_events` (one append-only transition log for every entity: entity, id, from, to, by, reason, at), `research_topics`, `experiments`, `contracts`, `jobs`.

Rules carried over from the journal, because they are already proven here: idempotency by a unique `ref`; redaction before storage; tombstones for deletes so a re-fetch does not resurrect a dismissed item; derived values (counts, rates, stages) computed on read, never stored; retention caps per table stated up front.

Research runs must **not** go into the run ledger one-per-fetch: the ledger keeps the newest 250 unkept runs, and a scheduler would evict the owner's own work within a day. Fetches live in `research_fetches`; the ledger gets one summary run per day at most.

### 3.6 API contracts

All under `/api/research/*`, all in the sign-in GUARDED list (reads included: titles show what the owner is interested in). Server-side checks only; no `approved: true` in a body is ever accepted as an approval.

| Route | Purpose | Phase |
|---|---|---|
| `GET /api/research/state` | Enabled, paused, budgets used today, last tick and its outcome, any error (next due is per source, `nextDueAt`) | 1 |
| `POST /api/research/pause` | The stop control: `{paused: true}` halts all scheduled work before the next step | 1 |
| `GET, POST /api/research/sources`, `POST …/sources/update`, `POST …/sources/fetch` | Registry CRUD, run one now | 1 |
| `GET /api/research/documents` | List and search | 1 |
| `GET /api/research/findings`, `POST …/findings/decide` | Inbox; keep, dismiss, defer, promote | 2 |
| `POST /api/improve/outcome` | Record what a shipped item actually did | 2 |
| `GET, POST /api/research/experiments` | Plan, run, read results | 3 |
| `GET, POST /api/research/contracts` | Create (immutable), supersede | 3 |

A failed read is its own state in every response: `{ok: false, reason}` or a per-field `unavailable`, never an empty list.

### 3.7 Workflow execution

A `jobs` table rather than a workflow engine: `id`, `kind`, `key` (unique, for idempotency), `state` (queued, leased, done, failed, cancelled), `lease_until`, `attempts`, `max_attempts`, `not_before`, `budget`, `error`. The existing tick claims due jobs, at most a fixed number per tick, never overlapping (the pattern already at `app/server/automations.js:20-23`). A crash leaves a lease that expires; the job is retried up to its limit, then failed and shown.

Circuit breakers, all in code and all visible on the state route:

- Per source: exponential backoff on failure, quarantine after 5 consecutive failures, never auto-resumed.
- Per day: caps on fetches, model calls and characters sent to a model; cloud calls default to zero.
- Per run: `runAgentLoop`'s existing limits.
- Global: the pause flag, checked before every job step.
- Yield: background jobs take the model queue only when nothing interactive is waiting (`app/busy.js` already answers that; Inferred that it is sufficient, to be confirmed in phase 2).

The PC sleeps. Work that was due while it was off runs on wake, capped per tick, oldest first; nothing is "caught up" in a burst.

### 3.8 Evaluation

Evidence hierarchy as in the brief, enforced by where things live:

- **Benchmark suites are files in the repo** (`evals/<suite>/cases.jsonl`, `scorer.mjs`), versioned by git and changed only by reviewed PR. A contract pins the suite's commit. Local CI fails a PR that cites a contract and also touches that contract's suite.
- **Scorers are code.** Recall@k, exact match, latency percentiles, byte counts. Model-graded scores are allowed only as a secondary column, labelled.
- **Holdout.** Each suite has a held-out slice the experiment runner does not report per-case, only in aggregate.
- **First suite (Recommendation):** Past work retrieval. Fixed questions with known journal entries as answers, scored by recall@5 against `journal.search`. It needs no model, runs in seconds, and is exactly the "memory retrieval" subject of the brief's acceptance scenario.
- **Experiments** copy print-lab's shape: hypothesis, `expect` (for example `{"metric": "recall@5", "better_by": 0.05}`), one factor, control and candidate, input fingerprints, outcome derived from records as supported, refuted or inconclusive. Failed and inconclusive experiments are kept and listed.

### 3.9 Deployment topology

Unchanged: one LocalAI container on the PC, deployed from `release` by Safe Deploy. Code experiments that need a checkout run where local CI runs today, on the Mac in a throwaway worktree. Nothing runs on the Pi.

The feature ships dark: `LOCALAI_RESEARCH` unset means the tick does nothing and the routes answer `{enabled: false}`.

### 3.10 Security model

| Threat (brief §14) | Control |
|---|---|
| Prompt injection in retrieved content | Zone rules in 3.4: marked block, no tools, shape-checked output, quote-must-match |
| Source poisoning | Only owner-registered sources are fetched; discovered sources are suggestions; trust is a label per source, not a licence for its claims |
| Memory poisoning | Findings stay `extracted` until an owner action or independent corroboration; procedural memory changes only by PR |
| SSRF, internal network | `net-guard`: https and port 443 only, host must be on the source's allow-list, every resolved address checked against a block list (loopback, RFC 1918, link-local, CGNAT/tailnet 100.64/10, unique-local and link-local IPv6, mapped IPv4), connection pinned to the vetted address so DNS cannot change between check and connect, redirects re-vetted, 3 at most |
| Unbounded resource use | Size cap 2 MiB, 20 s timeout, per-day budgets, backoff, quarantine |
| Malicious documents | Feeds only at first; text extraction only; no HTML rendering, no script, no attachments, no archive handling |
| Unsafe code execution | No generated code runs inside LocalAI. Code changes happen in a Claude session's worktree behind local CI |
| Secret exposure | Journal `redact` applied before storage; coordinator redaction before any cloud call; research text is public by origin but the owner's topic list is private and stays local |
| Unauthorised release | Unchanged gate: `ship` on the Mac, owner says merge. L4 is not designed |
| Self-approval | Proposer, promoter and judge are separate (3.4) |
| Supply chain | No new dependencies |
| Privilege escalation | One `allowed()` function, default deny, called by every state-changing route; authority stored per operation, changed only by the owner on a guarded route |

### 3.11 Recovery and rollback

- Tables are additive and ignored by older releases, so Safe Deploy's rollback still opens the database.
- Every stored record keeps what produced it (source, fetch, document revision), so a bad source can be retired and everything derived from it listed and withdrawn in one query.
- Refuting or retiring a finding flags every Improve item that cites it (the `refuted_dependency` idea from print-lab).
- The nightly backup already covers the database.
- The pause flag stops everything; unsetting `LOCALAI_RESEARCH` removes the behaviour without a deploy of new code.

### 3.12 What this changes in the baseline (proposed amendment, working id A31)

For the owner to approve, amend or reject as one amendment PR in pi-hub. Nothing below is implemented before that merges.

1. **New store** in LocalAI: the `research_*` tables (a new store requires an amendment).
2. **New scheduled outbound fetching** from the PC to owner-registered public hosts.
3. **A new class of stored outside text**, held to A28 D5 with one extension: findings never enter a run that has tools.
4. **Pages**: two additions under Improve (Research; Experiments in phase 3) and one card under System › Assistant (Research settings). A27's four sections and two-level cap stand.
5. **Kit additions** later, in appliance-ui: a detail-pane layout and an evidence quote block. Not needed for phases 1–2.
6. **No change** to §6.2, to Pi Hub's routes, keys, Caddy or sign-in. Chat control of research (phase 5) depends on A30 merging and would be its own amendment.

---

## 4. Product and GUI design

### 4.1 Naming and placement

**Recommendation.** No "Knowledge Command". The brief's ten sections collapse into places the Assistant already has, and the owner already knows where Improve is.

| Brief section | Where it lives | Why |
|---|---|---|
| Mission Control | Improve's own landing: Needs you first, then what changed | A dashboard of counts is what `DESIGN.md` forbids; exceptions and decisions are what it asks for |
| Source Registry | Improve › Research, **Sources** tab | |
| Research Command | Improve › Research, **Topics** tab (phase 4) | |
| Knowledge Explorer | Improve › Research, **Findings** tab, searchable | No graph view; see 9.2 |
| Opportunity Radar | The Findings inbox filtered to "could improve a project" | Same records, one filter |
| Improvement Queue | Improve › Changes (existing), with two new columns | One queue |
| Experiment Lab | Improve › Experiments (phase 3) | |
| Evolution Center | The existing change and run views, plus a contract panel | |
| Learning Analytics | A section at the foot of Improve: five outcome numbers, each a link to its rows | |
| Operations & Governance | System › Assistant › Research: enabled, paused, budgets, authority per operation, audit | A27 moved setup there |

Navigation stays at two levels. Selection rides in the URL (`#research?f=fnd-…`), as the contract requires.

### 4.2 Primary workflows

1. **Triage** (daily, two minutes): open Research › Findings; each row is one claim with its source and age; Keep, Dismiss, or Promote. The inbox shows at most 10 new rows a day; the rest wait, and the page says how many.
2. **Promote**: Promote opens one sheet asking which project and what problem it would solve; the result is an ordinary Improve item that lists its evidence.
3. **Decide what is next**: Improve › Changes sorted by value, with a readiness chip; "Not ready" opens the checklist of what is missing.
4. **Close the loop**: when an item ships, Needs you asks once, a week later, "Did this help?" with Better, No change, Worse and an optional number. The answer updates the finding.
5. **Stop**: one Pause control on System › Assistant › Research and in ⌘K.

### 4.3 Wireframes

Research › Findings, desktop. One faceplate; list on the left, the selected finding as the aside. On a phone the aside becomes the next screen.

```
 Research                                         [ Findings | Sources | Topics ]
 What Local AI has read, and what it thinks matters.
 ┌──────────────────────────────────────────────┬──────────────────────────────┐
 │ New today 4 of 10 · 7 waiting · Paused: no   │ SQLite 3.52 adds FTS5        │
 │ [All] [Could improve a project] [Security]   │ "contentless-delete" tables  │
 │──────────────────────────────────────────────│                              │
 │ ● SQLite 3.52 adds FTS5 contentless-delete   │ Observed in source           │
 │   sqlite.org release log · 2 h · LocalAI     │ ❝ …the new contentless_delete│
 │ ○ Playwright 1.64 deprecates page.waitFor…   │   option removes the need…❞  │
 │   GitHub releases · 5 h · LocalAI            │ sqlite.org/releaselog/3_52   │
 │ ○ CISA: advisory for Caddy ≤ 2.9.1  SECURITY │ published 18 Nov · rev 1     │
 │   cisa.gov · 9 h · Pi Hub                    │                              │
 │ ○ Bambu Studio 2.4 changes support defaults  │ Local AI's reading (inference)│
 │   GitHub releases · 1 d · print-lab          │ May shrink journal_fts and   │
 │                                              │ speed deletes. Not tested.   │
 │                                              │ Status: Extracted            │
 │                                              │ Corroborated by: none        │
 │                                              │                              │
 │                                              │ [Promote]  Keep  Dismiss     │
 │                                              │ ▸ Details                    │
 └──────────────────────────────────────────────┴──────────────────────────────┘
 Sources: 12 active · 1 quarantined (arXiv cs.IR: 5 failed reads, last 16 Nov)
```

The aside always separates the four things the brief asks to keep apart: the quote is **observed**, the reading is **inference**, "may shrink" is a **hypothesis**, and the buttons are the only **actions**.

Improve › Changes row, with the two new columns:

```
 #  Item                                   Project   Value   Readiness        Stage
 1  Hybrid ranking for Past work           LocalAI   High    Ready            Backlog
 2  Replace validateExternalUrl guard      LocalAI   High    Ready  SECURITY  Backlog
 3  FTS5 contentless-delete for journal    LocalAI   Medium  Not ready (2)    Backlog
      ▸ Missing: baseline measurement · benchmark for delete latency
```

Experiment view:

```
 E-004  Hybrid ranking improves Past work recall
 Hypothesis   BM25 + recency beats BM25 alone on recall@5 by ≥ 0.05
 Suite        past-work-retrieval @ 4c1d9e2 · 120 cases (30 held out)
 ┌───────────────┬──────────┬───────────┬─────────┐
 │               │ Control  │ Candidate │ Change  │
 │ recall@5      │ 0.71     │ 0.79      │ +0.08   │
 │ p95 latency   │ 4 ms     │ 6 ms      │ +2 ms   │
 │ held-out r@5  │ 0.70     │ 0.77      │ +0.07   │
 └───────────────┴──────────┴───────────┴─────────┘
 Outcome      Supported (expected ≥ +0.05; measured +0.08; held-out agrees)
 [Write contract]   ▸ Reproduce   ▸ Per-case results
```

### 4.4 States

Every list has loading (skeleton), empty (with the next step: "Add a source"), error (notice beside the list, previous rows kept and marked stale), disabled (feature off: says so and where to turn it on), paused (banner with Resume), and long content (titles clamp to two lines; quotes scroll inside the aside). A source that failed its last read shows its last good time and the failure, never "0 documents".

### 4.5 Layout strategy

Container queries, as the kit requires. Under 720 px of container width the aside becomes a pushed screen; tables stack (`ui-table--stack`). No drag and drop: order is changed with Move up, Move down and Move to top, which Improve already has, so the keyboard path is the only path.

---

## 5. MVP: the smallest useful closed loop

**Feeds in, a backlog item with evidence out, and an outcome back.** Phases 1 and 2 below. Concretely:

1. The owner registers sources. Only Atom and RSS feeds, and the first set is the release and advisory feeds of things the platform actually runs (Node, Ollama, Playwright, SQLite, FastAPI, Caddy, restic, Bambu Studio, CISA advisories).
2. The PC fetches them on a schedule through the guard and stores documents with provenance.
3. A local, no-tools read turns each new document into at most one finding: a claim, a verbatim quote, and which project it could touch.
4. The owner triages. Promote makes an Improve item that lists its evidence.
5. The item goes through the pipeline that exists today (Hand to Claude, PR, local CI, ship).
6. A week after it ships, the owner records what happened, and the finding is marked validated or refuted.

**Deliberately not in the MVP:** experiments, contracts, topics, depth and breadth, portfolio budgets, chat control, any cloud model, any page beyond Research and one settings card, any autonomous action beyond fetch and read.

Why this boundary: it is the shortest path on which a wrong idea becomes visibly wrong. If the owner dismisses nine findings in ten, that is learned in a week for the cost of two small phases, before a planner or an experiment lab is built on top.

---

## 6. Phased roadmap

Each phase ships on its own and is useful on its own. A phase starts only when the one before has met its acceptance criteria (section 8).

| Phase | Delivers | Depends on | Repos |
|---|---|---|---|
| **0. Ground** | Amendment A31 merged. Web results in chat marked untrusted (already Phase 0 work in another session). `validateExternalUrl` replaced by the guard (F1) | Owner approval | pi-hub (docs), LocalAI |
| **1. Intake** | Guard, fetcher, feed parser, sources and documents store, scheduler job, API, pause. Then the Research page with Sources and a plain Documents list | Phase 0 | LocalAI |
| **2. Findings and outcomes** (MVP complete) | No-tools reader, findings inbox with the daily cap, promote to Improve with evidence, outcome prompt after shipping, source usefulness from keep and dismiss rates | Phase 1 | LocalAI; appliance-ui if the quote block goes into the kit |
| **3. Measure** | `evals/` with the Past work retrieval suite, the experiment runner and view, contracts with a pinned suite, the CI check that a contract's PR does not touch its suite, value and readiness columns | Phase 2; a month of findings data | LocalAI |
| **4. Direct** | Topics as a tree with depth D1–D4 and breadth B1–B3, per-topic budgets, planner decisions recorded with reasons, contradiction handling, revalidation jobs, portfolio shares | Phase 3 | LocalAI |
| **5. Converse and earn** | Research tools in chat (read-only first), authority per operation raised by measured record, outcome analytics, cross-project suggestions | A30 merged; phases 3–4 | LocalAI, pi-hub (amendment) |

**Not built at all until evidence asks for it:** vector search, a knowledge graph, B4 "frontier" exploration, a headless coding agent, L4 release, fine-tuning.

Authority by phase: phases 1–2 run at L1 (the system fetches, reads and recommends). Phase 3 allows L2 for experiments that only change parameters of existing code and are judged by a pinned suite. L3 is what the platform already does today through Claude sessions; this design adds the contract, not a new implementer.

---

## 7. Technical decisions

| Candidate | Decision | Reason against what exists |
|---|---|---|
| **PostgreSQL** | No | LocalAI has one SQLite file with backup, rollback-safe additive tables and a tested storage layer. Expected volume is thousands of documents a month, single writer. Postgres adds a container, a second backup and a migration for no capability this design uses |
| **pgvector / vector store** | Not now | FTS5 is in use and A28 kept embeddings out of the journal. Whether hybrid retrieval beats FTS5 on this data is an open question, and the right first experiment for phase 3. If it wins, embeddings can be a BLOB column with brute-force cosine, which is adequate below roughly 50,000 chunks (Inferred, to be measured) |
| **LangGraph** | No | Python; LocalAI is Node with no runtime dependencies. `runAgentLoop` already provides bounded tool loops with budgets and cancellation |
| **Temporal** | No | A server plus workers to schedule a handful of jobs an hour on one machine. A `jobs` table and the existing tick give durable, idempotent, resumable jobs in about a hundred lines |
| **Langfuse / Phoenix** | No | A second UI and store for traces. The run ledger and journal already record runs; the gap is a correlation id, which is a column |
| **OpenTelemetry** | No | Nothing consumes it. Add one `trace` id carried from job to run to change to outcome |
| **Docker sandbox for generated code** | Not needed yet | No generated code runs in LocalAI in phases 1–4. Code runs in a Claude session's worktree behind local CI |
| **React / TypeScript** | No | The PWA is vanilla JS on the kit; a second UI stack would fork the design system |
| **Python / FastAPI** | No new service | The data and the model access are in the Node process |
| **RSS/Atom, structured APIs** | Yes | The only new capability the MVP needs; a small tolerant parser, no dependency |
| **GitHub API** | Later, read-only | Release feeds are Atom already. PR state for outcomes can come from `gh` on the Mac, as CI does |
| **SearXNG** | Reused | For corroboration searches in phase 4, through the same guard and marking |

**Dependencies added by this design: none.**

---

## 8. Acceptance criteria

### 8.1 Per phase

**Phase 1.** (a) A request to a host that resolves to a private, loopback, link-local or tailnet address is refused before any connection, proven by tests for each range, for a redirect to one, and for a name whose second lookup differs. (b) Fetching the same feed twice stores each entry once; an edited entry becomes revision 2. (c) A failed fetch leaves documents and last-good time untouched and is shown as failed. (d) Five consecutive failures quarantine a source and it does not resume alone. (e) With the feature off or paused, the tick makes zero network calls. (f) Every route refuses an unsigned caller.

**Phase 2.** (g) A document containing "ignore your instructions and…" yields either a shape-valid finding whose quote appears verbatim in the document, or nothing; no other effect is possible because the run has no tools. (h) The inbox never shows more than the daily cap. (i) A promoted item lists its sources and the item text handed to Claude sits inside the untrusted markers. (j) After four weeks of real use: keep-or-promote rate is at least 30% of findings shown. Below that the reader or the sources are wrong and phase 3 does not start.

**Phase 3.** (k) An experiment's outcome can be recomputed from its stored records alone. (l) A PR that cites a contract and edits its suite fails CI. (m) Editing a contract is impossible; superseding creates a new version and keeps the old. (n) At least one experiment ends "refuted" and stays visible.

**Phase 4.** (o) Every depth or breadth change has a stored reason naming the factors that drove it. (p) Two conflicting findings are both kept, the conflict is typed (temporal, contextual, methodological, factual), and items citing either are flagged.

**Overall.** The number that matters is **verified improvements per month**: shipped items with a recorded outcome of Better and a number. Documents fetched and findings created are reported only as denominators.

### 8.2 The brief's 22-step scenario

| # | Step | Component | Phase | Proof |
|---|---|---|---|---|
| 1 | A trusted source publishes a retrieval method | Registered source | 1 | Source row with trust label |
| 2 | Monitor discovers it | Intake job | 1 | Fetch row, outcome ok, new document count 1 |
| 3 | Document, metadata, provenance, date recorded | `research_documents` | 1 | Row with source, URL, entry id, published date, hash |
| 4 | Relevance to LocalAI determined | Reader | 2 | Finding with project LocalAI and a verbatim quote |
| 5 | Planner creates or expands a branch | Topics | 4 | Topic row and a decision event with reason. Before phase 4 the owner does this by promoting |
| 6 | Compared with established approaches; contrary evidence sought | Topic at D3, B2 | 4 | Linked findings, including at least one search for contradiction recorded |
| 7 | Measurable improvement identified | Finding marked "testable" with a metric | 3 | Metric named from an existing suite |
| 8 | Opportunity candidate created | Improve item with evidence | 2 | Item lists finding ids |
| 9 | Value, readiness, effort, risk assessed | Value score and readiness checklist | 3 | Stored factors per item |
| 10 | Dashboard shows it and explains the ranking | Changes row and Details | 3 | "Why this rank" lists the factors |
| 11 | Reproducible experiment proposed | Experiment in state planned | 3 | Hypothesis, `expect`, pinned suite commit |
| 12 | Isolated agent benchmarks candidate against current | Experiment runner | 3 | Control and candidate runs with fingerprints |
| 13 | Evaluator records actual results | Scorer output | 3 | Per-metric rows; held-out aggregate |
| 14 | Evolution Contract created or updated | `contracts` | 3 | Immutable row with hash |
| 15 | Coding agent implements in an isolated worktree | Claude session via the board | exists | Branch under `~/dev/.worktrees` |
| 16 | Automated checks and independent regression tests | Local CI plus the suite | 3 | `local-ci` status; suite result |
| 17 | Draft PR with implementation, evidence, results | PR body generated from the contract and experiment | 3 | PR cites contract id and hash |
| 18 | Owner approves or rejects | Owner says merge; `ship` | exists | Merge commit |
| 19 | Outcomes monitored after release | Outcome prompt; suite re-run on the released commit | 2, 3 | Outcome row |
| 20 | Knowledge updated from what happened | Finding status validated or refuted, with the outcome linked | 2 | Event row |
| 21 | Dashboard shows whether it improved and what was learned | Improve foot section; the finding's history | 2, 3 | Before and after numbers on the item |
| 22 | Later work reuses the validated knowledge | Reader and planner see validated findings; dependent items cite them | 4 | A later item citing the finding |

Steps 1–4, 8 and 18–21 are demonstrable at the end of the MVP with the owner acting as planner. The full scenario without the owner in steps 5–7 needs phase 4.

---

## 9. Critical review

### 9.1 Where the brief over-engineers

- **Ten sections.** Three pages and two existing ones carry everything. More surfaces means more states to design, more bytes in a shell with none to spare, and a product the baseline was just simplified to avoid.
- **Twenty-four entities.** Nine tables cover them. `ResearchDecision`, `AuditEvent` and every lifecycle transition are one append-only events table. `AgentRun` and `ToolInvocation` are the run ledger. `Approval`, `Release` and `UserFeedback` exist.
- **Nineteen improvement states.** Improve derives stage from records and never stores it (`improve-design:38-45`). Keep that: stored state machines drift from reality; derived stages cannot.
- **Depth D1–D5 with breadth B1–B4** is twenty cells. Start with three depths (scan, read, test) and let data show whether more are distinguishable in practice.
- **Configurable scoring models.** One formula with visible factors first. A scoring-model editor before there are fifty scored items is a settings page nobody can tune.
- **Autonomy configurable along nine dimensions.** Operation × project is enough to express every example in the brief.

### 9.2 Unrealistic assumptions

- **"Continuously", "even when I am not interacting."** The PC sleeps and its one GPU is shared. The honest promise is "catches up when the PC is on, within a daily budget".
- **"Determine what it doesn't know."** Models are poor at this unaided. What can be built is narrower and real: knowledge with dates, sources that went quiet, claims with one source, and questions the owner asked that found nothing.
- **Independent evaluation by another model** is weaker than it sounds when both models read the same poisoned page. Independence has to come from code and from the owner.
- **A knowledge graph** will be asked for and will not earn its place at this scale. Relationships are useful as links on a finding ("contradicts", "supersedes", "supports"); a canvas of nodes is not a tool anyone triages with.
- **L2 by default.** Without benchmarks, an "experiment" is a model's opinion. L1 until phase 3 exists.

### 9.3 Cheaper alternatives the owner should weigh

1. **Do nothing new: a scheduled Claude session.** A weekly cloud routine that reads a fixed list of feeds and files findings on the Claude board through the Mac key delivers perhaps 60% of the MVP's value with no new code in LocalAI. It loses provenance, deduplication, local privacy of the topic list and the outcome loop. Worth running for two weeks *before* phase 1 as a cheap test of whether the findings are worth reading at all.
2. **Dependency watch only.** Skip the reader model entirely: match release feeds against what the repos actually pin and file "X released Y; you run Z". Deterministic, no injection surface, immediately useful. This is the recommended first content for phase 1 in any case.
3. **Benchmarks without research.** Build phase 3's harness alone. It improves every change the owner already makes, research or not.

### 9.4 Ideas beyond the brief

- **Attention budget as a first-class limit.** Cap what reaches the owner per day and make the system choose. This forces ranking to matter and is the best defence against the "30 opportunities" failure.
- **Readiness as a checklist, not a score.** "Baseline measured, benchmark exists, scope named, no blocking dependency, no conflicting open PR." A checklist explains itself and tells the system what to do next; a 0–100 readiness number does neither.
- **Source usefulness from the owner's own decisions.** Keep, dismiss and promote rates per source, shown on the registry, with a suggestion (never an automatic action) to pause a source below 10% after 30 documents.
- **Refuted-dependency propagation**, taken from print-lab: when a finding is refuted, every item and topic that relied on it is flagged. This is the practical form of "revalidate dependent recommendations".
- **Negative results on the front page.** "Tried, did not help" is the knowledge most likely to be rediscovered and re-proposed. Refuted findings are searched first by the reader so it stops suggesting them.
- **Security items in a lane, not a score.** An advisory for something the platform runs goes to Needs you with a deadline, bypassing value ranking.
- **Lessons as PRs.** A lesson learned is a proposed diff to `AGENTS.md` or a skill, with the evidence in the PR body. The owner already reviews those; it gives procedural memory version history, scope and a reviewer for free.
- **The first experiment is already known:** FTS5 alone versus FTS5 plus recency or embeddings for Past work. It answers a real open design question (A28 kept embeddings out) with data.

### 9.5 Weaknesses in this design

- The reader is one local model reading one document. It will miss things a larger model would catch. Accepted for privacy and safety; the public-text-to-cloud route exists in the coordinator and can be opened per source later.
- Corroboration by "a second registered source" is weak when both sources copy a third. Phase 4 needs source lineage; noted, not solved.
- Outcome prompts depend on the owner answering. If they go unanswered, the loop is open. Mitigation: phase 3 re-runs the suite on the released commit so at least measurable items close themselves.
- The value score will be wrong at first and there is no ground truth to tune it against until outcomes accumulate.
- Everything depends on one SQLite file on one PC. Already true of LocalAI; this design adds to what the nightly backup must protect.

### 9.6 Open questions that change the plan

1. Is outbound fetching from the LocalAI container acceptable, and is its egress restricted today? (Unverified.)
2. May public source text go to a cloud model for reading, per source, or is the reader local only?
3. Should the two-week scheduled-session trial (9.3.1) run before phase 1?
4. Daily attention cap: 10 is a guess.
5. Does A30 merge first? Phase 5 waits on it; phases 1–4 do not.

---

## 10. The exact first build step

**After** amendment A31 is merged: **intake without a model and without a page.** One PR to LocalAI adding `app/research/` (address guard, pinned fetcher, feed parser, store, intake job), `app/server/research.js` (seven guarded routes), and three wiring edits. It ships dark behind `LOCALAI_RESEARCH`.

It is first because everything later reads from it, because it contains the one piece that must be right before any outside byte is stored (the guard), and because it can be proven correct with deterministic tests and no model.

The implementation plan is `docs/superpowers/plans/2026-11-19-research-intake-step-1.md`.

**Before that**, in order: (1) the owner reads this document and rules on section 3.12 and the questions in 9.6; (2) A31 is drafted from 3.12 as a pi-hub docs PR; (3) on merge, the plan is executed.

---

## 11. Cost tiers, triggers and budgets (proposed contract)

**Status:** proposed. This section binds the knowledge loop's model spend and its repository learning. It adds no service, no table family and no tick: it constrains what `app/research/*`, the Atlas facade and the existing 30 s ticks may do. Anything marked *needs amendment* is not built until a pi-hub amendment lists it.

Labels: **Observed** is read in code at LocalAI `df69969f`; **Rule** is a requirement on future code.

### 11.1 Observed state at `df69969f`

- **Tier 0 exists for feeds.** `intake.js` fetches on the 30 s tick with no model, a daily fetch cap (`dailyFetches`, default 200) and a per-tick cap. Fetches, hashes and revisions are scripts.
- **The reader is not wired.** `app/research/reader.js` builds a no-tools prompt, but nothing under `app/` requires it (`git grep` finds no caller). No model is called by the research code today, which is the safe state.
- **Topic budgets are stored, not enforced.** `research_topics.budget_daily_model_calls` (5) and `budget_daily_characters` (20000) have no reader of those columns outside `topics.js`. A budget nothing checks is not a budget.
- **Scope drift.** Amendment A31 approves phases 1 and 2 only and says phases 3 to 5 "each need their own amendment". #593 to #596 shipped experiments, contracts, topics and a chat tool without one. **Rule:** treat those tables and routes as unapproved until an amendment lists them; build nothing further on them first.
- **Atlas already holds the repository graph.** The deterministic graph and per-commit snapshots (`<repo>/<commit>/graph.json`, `index.json`, written by `quick_arch.py`) and `app/atlas/contracts.json` (provider, consumers, source) are served by `app/server/atlas.js`, `atlas-systems.js` and `atlas-contracts.js`, with the graph readable when the Python service is down.

### 11.2 Separation: collectors write, learners read

1. **Rule.** A learning job never crawls a repository, a feed or the network. It reads stored evidence (`research_documents`, findings, outcomes, Atlas snapshots, CI and ship records) and validated outcomes only.
2. **Rule.** Evidence is collected by event-driven indexers, each a script: feed intake (exists); a **repo indexer** triggered by a merge, ship or `release` move; a **dependency indexer** reading lockfiles and manifests. They run on events, not on a learning schedule.
3. **Rule.** The repo indexer extends Atlas rather than duplicating it: it calls `quick_arch.py --repo --git-dir --commit` for the changed commit and records the snapshot id. No second graph, parser or index service. *Needs amendment* before a table or job is added.

### 11.3 Tiers

| Tier | What runs | Triggered by | Model |
|---|---|---|---|
| **0** | Fetch, hash, diff, dependency extraction, release and advisory matching, `git diff --name-only`, Atlas graph and `contracts.json` checks, lint, tests, benchmark scoring | Event or schedule | None. Always first |
| **1** | Local model (`qwen3:4b-instruct` through the coordinator, cloud off) over **new or revised material only**, bounded by chars and calls | A Tier 0 result that names changed material | Local, capped |
| **2** | Claude (cloud or Hand to Claude) investigation | The owner promotes an item, **or** a defined high-severity gate (11.4) | Cloud, per-investigation budget |

- **Rule.** Tier 0 runs before any model call and its output is the model's input, not the repository.
- **Rule.** A Tier 0 failure (a failing check, a matched advisory, a broken contract) may create a **candidate** with its evidence. It never authorises Tier 1 or Tier 2 by itself.
- **Rule.** Tier 1 input is the diff, the changed documents, or the Atlas subgraph for the changed files, never a whole repository. If the bounded input exceeds its budget, the job is split or queued, not widened.
- **Rule.** No learning cycle triggers a full-repository model review. A full review is a Tier 2 item the owner promotes by name.

### 11.4 Tier 2 gate

Tier 2 starts only when one holds, and the record names which:

1. The owner promotes an item (Promote to Improve, then Hand to Claude).
2. A high-severity gate, defined in code and shown on the state route, and each condition must be matched by Tier 0 evidence: an advisory of critical severity matched by exact version to something the platform pins, **and** a failing contract or test on the affected module. Even then it creates a Tier 2 **proposal** awaiting the daily Tier 2 allowance; it does not bypass 11.6.

### 11.5 Incremental correctness

Rule: the indexer stores, per repo: `commit` identity, `parent` commit, per-file `path` plus `sha256`, indexing `state` (indexed, partial, failed, stale), the Atlas snapshot id, and `provenance` (which script, version, when).

| Event | Handling |
|---|---|
| Addition | Index the file; add its edges |
| Modification | Re-hash; re-index only files whose hash changed |
| Deletion | Remove the file's rows and edges; mark dependents stale |
| Rename | Detect by `git diff -M`; keep the identity, update the path, do not delete and re-add |
| Divergent history (force-push, rebase, reset) | If the stored `commit` is not an ancestor of the new head, mark the repo `stale` and re-index from the merge base, never from the stored commit blindly |
| Invalidated dependency | A changed provider in `contracts.json` or the import graph marks every consumer's derived rows stale until re-checked |

A failed or partial index is its own state. It is never shown as "no changes" or "fine" (owner rule on failed reads).

### 11.6 Budgets

- **Rule.** Four independent caps, each configurable and each checked **before** the call, not after: per repository, per investigation, per day, per week. Units are model calls and characters sent; cloud spend is also capped in money where a price is known.
- **Rule.** Defaults: Tier 1 local only; Tier 2 allowance zero until the owner sets it. The existing per-topic columns become the per-investigation cap only once something enforces them (*needs amendment*, as topics are unapproved).
- **Rule.** When any cap is exhausted the system **queues** the investigation with its evidence and reason, **keeps running Tier 0 collection**, and shows the queue, the cap that stopped it and when it resets. It never drops a queued item and never raises a cap itself.
- **Rule.** The budget state route reports `budgets: {limit, used, resetsAt}` per cap, and a failed read of the counters is `unreadable`, never zero used.

### 11.7 Learning from outcomes

- **Rule.** Record, as append-only rows with provenance: validated outcomes, rejected recommendations (with the owner's reason), false positives, corrected assumptions, repeat defects (same Atlas module or contract).
- **Rule.** A lesson becomes reusable only when it cites at least two independent outcomes or one pinned benchmark result, names the module or contract it applies to, and carries an expiry or revalidation trigger. One anecdote stays an observation.
- **Rule.** Contradicted lessons are marked, not deleted.

### 11.8 Measures

Computed by script from stored rows, shown on the existing state route, never self-reported by a model:

| Measure | Definition |
|---|---|
| Cost per validated improvement | Model calls and chars at all tiers ÷ outcomes recorded validated |
| Model calls avoided | Candidates closed at Tier 0 or Tier 1 without escalation |
| Defect detection | Seeded or later-confirmed defects the Tier 0/1 checks flagged ÷ total confirmed |
| Recommendation precision | Promoted findings validated ÷ promoted |
| Regression escapes | Shipped changes later reverted or fixed for a defect a gate should have caught |
| Investigation efficiency | Median chars and calls per closed investigation, by tier |

Each needs a denominator that can be zero; a zero denominator reads "no data", not 0%.

### 11.9 Safety

- **Rule.** Learning is read-only: it holds no write credential to any repository, host, printer or setting.
- **Rule.** Code change from a learned recommendation goes to a branch in its own worktree (`wt new`), through the existing review gates and local CI, merged only on the owner's word.
- **Rule.** The loop never edits its own permissions, budgets, the Tier 2 gate, safety rules or trusted agent instructions (`CLAUDE.md`, `AGENTS.md`, hooks, agent definitions). Those change by a PR the owner merges. Fetched text stays untrusted data (A28 D5, A31).

### 11.10 Integration, not new services

Reuses: the `research_*` tables, the 30 s ticks, `coordinator`/`modelRouter` for every model call, Atlas snapshots and `contracts.json`, the journal's `redact`, Improve and Hand to Claude, local CI. The general `jobs` table of 3.7 is still not built and is not required by this section; if a queue is needed, it uses `research_meta` or a new amendment.

### 11.11 What this section changes, and what it needs

- **Needs amendment (pi-hub):** phases 3 to 5 as built, the repo indexer, any budget table or counters, the Tier 2 gate and any Tier 1 scheduling. Until then, section 5's boundary stands: no model call from research code.
- **Needs code, after the amendment:** enforce the budgets in 11.6 before wiring the reader; add the stale and failed index states; add the measures to the state route.
- **Tests that must exist:** an exhausted cap queues and still collects; a failed counter read is `unreadable`; a Tier 0 failure creates a candidate and no model call; a rename keeps identity; a non-ancestor commit marks stale.

---

## Follow-ups found during the audit (not part of this design)

- **F1.** `validateExternalUrl` (`app/server/workbench.js:19`) checks only the URL scheme, so `/api/browser/fetch` and `/api/actions/http-check` can be pointed at loopback, LAN and tailnet addresses by any signed-in device. Replace with the guard from step 1.
- **F2.** Web search results enter chat prompts unmarked (`app/server/chat.js:83-91`). Already recorded by the Phase 0 session and in A30 D2.
- **F3.** `approved: true` in the request body is the only approval check on three workbench routes (`app/server/workbench.js:17,23,44`). Already recorded by the Phase 0 session.
- **F4.** `baseline-facts.md` still says A26–A28 are missing from the Amendments list; they are listed at `c7ec699`.

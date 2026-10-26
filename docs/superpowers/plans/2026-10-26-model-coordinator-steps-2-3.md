# Model coordinator, delivery steps 2 and 3

Spec: `docs/superpowers/specs/2026-10-26-model-coordinator-design.md` (approved 26 Oct: rule change yes; plain chat stays
local unless "Use a bigger model"; Groq + Cerebras). Step 1 (router, cloud client, chat and research) is PR #398; this
branch (`feat/coordinator-ui`) builds on it.

## Task 1: one place that runs work through the coordinator

- New `app/model-coordinator.js` (pure-ish, injected `cloudModels`, `routingSetting`, `recordActivity`):
  `route(req)` (adds the switch, keys and parked providers to `modelRouter.route`), `run(route, messages, {kind})` (the
  cloud candidates in order; `null` when none answered or none were allowed: the caller goes on to this PC),
  `local(route, model)`, `redact(text)` (keys and secret env values, `Bearer …`, absolute paths, private and tailnet
  addresses, email addresses) and `secretish(text)` (asks about Local AI's own keys, tokens, passwords, config).
  One Activity line per cloud call: provider, model, kind, size in characters, never the text.
- `app/model-router.js`: `route()` takes `stay` (a reason that keeps the work here, e.g. "Your workspace files stay on
  this PC"); `table()` rows gain `where` (plain words for the Models page); `label(route)` gives "Answered by Llama 3.3
  70B · Groq" or "Answered on this PC".
- Chat's `cloudAnswer` uses `run()` (adds the Activity line and redaction; behaviour otherwise unchanged).
- Tests: `tests/model-coordinator.test.cjs` (spy cloud: switch off = no call; redaction; secretish; fallback; activity
  line has no text), `tests/model-router.test.cjs` (`stay`, `label`, `where`).

## Task 2: the change planner routes (step 2)

- `app/server/changes.js` `generatePatchPlan(request, targetRoot, {kind})`: Change requests plan as kind `plan`;
  engineering runs (the existing self-change call site that writes code) as kind `code`. Only Local AI's own code may go
  out: a workspace target stays here ("Your workspace files stay on this PC"); a request about Local AI's keys, tokens,
  passwords or config stays here. The cloud gets the request and the source excerpts minus secret-looking files
  (`.env`, keys, certificates, names with secret/token/password/credential), redacted; the PERSONAL guard reads all of
  it. Cloud failure or cloud off: the local planner exactly as before. The change records `route`.
- Tests: `tests/model-coordinator-api.test.cjs` gains planner cases through the real server (fake Ollama, fake Groq):
  off = Groq never called; on = Groq answers and the change says so; workspace target stays local; a secrets request
  stays local; a Groq 503 falls back to this PC; nothing secret-shaped in what Groq received.

## Task 3: mission synthesis routes (step 2)

- `app/agent-orchestrator.js`: with `deps.coordinator`, the Coordinator's synthesis first tries the cloud as kind `plan`
  with the one-prompt synthesis (no tools, no evidence index), from the goal and the specialist outputs, redacted. Stays
  here when the mission reads a project's documents (`projectId`), when the goal is about Local AI's secrets or config,
  or when the guard finds anything personal. Otherwise, and whenever the cloud fails, the local path runs unchanged
  (tool-mode Coordinator, then the one-prompt fallback). Workers are unchanged. The mission stores `route`; the mission
  run's `meta.route` carries it (`app/server/agents.js`).
- Tests: `tests/mission-cloud-synthesis.test.cjs` with a spy coordinator: off = no cloud call; on = cloud answers and
  `mission.route.provider` is `groq`; project missions and personal specialist output stay local; cloud failure falls
  back to the local Coordinator.

## Task 4: "Answered by" on every run (step 3)

- `app/run-cards.js` `runCard()` adds `route: {text, why}` from `meta.route` (or, for an engineering run, its change's
  `route`). `components.js` run cards show the text as a sub line; the run view (ui.js `renderDrawer`) shows it beside
  the status badge with the reason.
- Tests: `tests/run-cards.test.cjs` cases; browser: `tests/model-routing-ui.mjs` checks a seeded run's card and view.

## Task 5: Models page controls and composer toggles (step 3)

- `app/public/model-routing.js` (loaded on demand when Models opens, like `print-lab.js`): the switch "Use cloud models
  for work that isn't private" (PUT `/api/models/routing`), a row per provider (key set or missing, used today, last
  problem, resting until) and the read-only routing table. Never shows a key; the API never sends one.
- Home's composer (`home.js`): when cloud is on, two toggles under the box, "Use a bigger model" and "Keep on this PC";
  they go with the next Chat or Research (`bigger`, `keepLocal`) and reset after it is sent. Hidden while cloud is off
  (they would change nothing). `app.js` `streamChat` passes them through (a comment shortened to stay in budget).
- Tests: `tests/model-routing-ui.mjs` (phone and desktop, axe): the switch turns cloud on and off, provider rows, the
  table, the toggles appear only with cloud on and send `bigger`/`keepLocal` once. `tests/model-coordinator-api.test.cjs`:
  an unsigned PUT from another device is refused.

## Task 6: docs

- `docs/USER-GUIDE.md`: the Models section's switch, provider rows and table; the composer toggles; "Answered by".

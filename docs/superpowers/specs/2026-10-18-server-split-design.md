# Splitting app/server.js into modules

Date: 2026-10-18. Status: approved by the owner ("apply") after the design in chat. Claude board item `prod-modularize`.

## Why

`app/server.js` is 3,996 lines / 286 KB: about 20 feature areas, ~137 routes in one `if` chain, and helpers every area
uses. Most of it is dense one-line functions, so a change anywhere means reading a lot of it, and cycles between areas
are hidden by function hoisting. The goal is the same behaviour in files of 2–30 KB, each one area.

## What the code looks like today (map of origin/main 98cff8b)

- 1–157: requires, env constants, singletons (`storage`, `notifier`, `inFlight`, `runLedger`, `activeRunControllers`,
  `claudeChat`), core helpers (`json`, `text`, `storageError`, `readState`/`writeState`, `prependRecord`, `readBody`,
  `recordActivity`).
- 158–3652: feature areas (status/capabilities, models, glance/voice, chat, library, images, GridCraft/ArtCraft/
  Workshop, static/config, runs, projects/knowledge/memory, agents/missions, automations/monitors, workbench, trash,
  notifications/approvals, changes, quality/issues, engineering, PowerShell, Claude board/Improve).
- 3653–3818: the router; 3819–3996: one-time repairs, push, releases, start-up and `listen`.
- One tight cycle: changes ↔ Improve/Claude ↔ engineering ↔ issues ↔ approvals. Everything else is a near-leaf.
- Mutable module state, each owned by one area except `capabilityCache` (reassigned from models) and
  `activeRunControllers` (chat, runs, missions).

## Decisions

- **S1 Layout.** `app/server/<area>.js`, plus `app/server/context.js` for shared helpers and singletons. `server.js`
  stays the entry point (router, cross-site guard, start-up repairs, `listen`); compose, tests and deploy keep
  running `node app/server.js`. Deploy copies the whole `app/` folder and nothing `require`s server.js, so new files
  are safe at runtime.
- **S2 Wiring.** `createX(ctx)` factories, as `claude-chat.js`, `model-pulls.js` and `notify.js` already do. An area
  calls another through `ctx` at call time (`ctx.changes.changeStore()`), never at load time, so load order can't
  create a cycle. State owned by one area moves with it; `capabilityCache` becomes an object with `reset()`.
- **S3 Router.** The `if` chain stays in server.js, calling `ctx.<area>.apiX(...)`. Only handler bodies move. A route
  table is a later, separate step.
- **S4 Source tests.** One helper (`tests/server-source.cjs`) returns server.js plus `app/server/*.js` as one text;
  the source-string checks in `run-execution-server-contract`, `model-runtime-server-contract`,
  `security-contract`, `workshop-status` and `deploy/Test-LocalAI-Candidate.ps1` read through it. The
  `SECRET_ENV`…`allowedCommand` block stays contiguous in one file (the security test evaluates that slice). An
  ordering check that only held because everything was one file (`apiChatStream` before `apiGenerateImage`) becomes
  "each exists".
- **S5 Done means unchanged.** Each PR only moves code: no renames, fixes or reformatting mixed in. Each passes
  `npm test`, every browser suite and local CI, and gets a live smoke check (healthz, a chat, an image page, Work,
  Improve) after it deploys.
- **S6 Self-checks.** The quality scan and staged-change validation `node --check` every app `.js` file, not just
  server.js; `mission-evidence` points at the new files.

## Order

1. `context.js` (pure helpers and stores) and S4, S6.
2. Leaves: push/releases/access, PowerShell, GridCraft/ArtCraft/Workshop, static/config, models.
3. Projects/conversations/knowledge/memory, then notifications/approvals.
4. Images; quality/issues.
5. Runs; agents/missions; automations/monitors; workbench (with the `SECRET_ENV` block).
6. The changes + engineering + Improve/Claude board cluster, together.
7. Status/capabilities.
8. Chat and glance/voice last (streaming hot path).

End state: server.js about 20 KB.

## Not in this work

Behaviour changes, the route table, Prettier (after the splits, per the cleanup roadmap).

## Risks and how each is handled

- A function used across areas forgotten in `ctx` → `ReferenceError` at call time, not load time. Mitigation: every
  PR runs all 45+ browser suites (they exercise every area), and a unit test loads each module and checks its
  factory returns every name the router calls.
- `this`-free module copies of `let` state → owned state moves whole; shared state is an object.
- Start-up order (claudeChat, trash and repairs need helpers before `listen`) → context is built first, areas next,
  repairs after, as today.
- The "listening on 0.0.0.0:<port>" log line tests parse stays unchanged.

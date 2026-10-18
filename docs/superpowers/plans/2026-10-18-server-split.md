# Plan: split app/server.js

Spec: `docs/superpowers/specs/2026-10-18-server-split-design.md`. One PR per step, each based on `main`, each a pure
move (no behaviour change). Every PR: `npm test`, deploy contracts, every browser suite on a fresh server,
`npm run ci -- <PR>`, and after it deploys a smoke check (healthz, a chat reply, Images page, Work, Improve).

1. **Context and checks.** `app/server/context.js`: `json`, `text`, `storageError`, `readBody`, `fetchWithTimeout`,
   `sameOriginJson` and the store helpers (`readState`, `writeState`, `prependRecord`, `RETENTION`). server.js
   destructures them, so every call site stays as it is. `tests/server-source.cjs` (S4) and the tests that read
   server.js switch to it. The quality scan and staged validation check every app `.js` (S6). This PR also carries
   the spec and this plan.
2. **Leaves.** push/releases/access, PowerShell, GridCraft/ArtCraft/Workshop, static/config/redirects. Models moved
   to step 7: its handlers read `capabilityCache`, which server.js reassigns, so they go with it.
3. **Platform stores.** Projects, conversations, knowledge, memory; then notifications and approvals
   (`addNotification` joins `ctx`).
4. **Images; quality and issues.**
5. **Runs; agents and missions; automations and monitors; workbench** (with the contiguous `SECRET_ENV` block).
6. **Changes, engineering, Improve and the Claude board** in one PR.
7. **Status, capabilities and models** (`capabilityCache` becomes an object with `reset()`).
8. **Chat; glance and voice.**

After step 8: server.js is the router, guard, repairs and start-up; Prettier can follow.

# LocalAI: notes for Claude Code

Home AI appliance: `app/server.js` (Node 22.13+, `node:sqlite`, no npm runtime deps, no build step) in Docker
container `local-ai-appliance` on a Windows host, UI on port 3080. Docs index: `docs/README.md`.

## Test

- `npm test`: all `tests/*.test.cjs` (`node --test`). Needs nothing running. Run it before every PR.
- Browser tests need a server. Use a throwaway one on a spare port, wait for it, test, stop it:
  `d=$(mktemp -d); DATA_DIR=$d WORKSPACE_ROOT=$d PORT=3180 node app/server.js > "$d/log" 2>&1 & pid=$!`,
  `until curl -fs http://127.0.0.1:3180/healthz >/dev/null; do sleep 1; done`,
  `LOCALAI_URL=http://127.0.0.1:3180 npm run test:browser` (all `tests/*-ui.mjs`; `node tests/run-browser.mjs <name>`
  for some), then `kill $pid`.
  More in `docs/DEVELOPMENT.md`.
- Deploy validator off the host: `pwsh -NoProfile -File deploy/Test-LocalAI-Candidate.ps1 -CandidateRoot . -LocalNode`.
  `npm run validate` needs the appliance's Docker image and only works on the host.

## Ship

1. Branch, commit, open a PR. CI runs on PRs only, path-filtered (`.github/workflows/`); what runs must be green.
   Docs-only PRs run no CI.
2. Merge. The host's `LocalAI Safe Deploy` task deploys `main` within about 5 minutes and rolls back by itself.
3. Confirm: `curl -s http://10.0.0.21:3080/healthz` (10.0.0.21 is the owner's appliance on their LAN) → `releaseCommit` equals the merge SHA. Deploy output
   contains fake `DEPLOYED: aaaa…` lines from contract tests; trust only `/healthz`.

Host access, when needed: `ssh windows-ai` (the owner's ssh alias for the Windows host; PowerShell 5.1). Run deploy scripts as a child process
(`powershell -NoProfile -File ...`), not inline. Details: `docs/DEPLOY.md`.

## Report to the Claude board

Base `http://10.0.0.21:3080` (the owner's appliance). JSON bodies, no auth. Mutating requests that carry a foreign `Origin` or
`Sec-Fetch-Site: cross-site` get 403; curl and scripts send neither, so they are unaffected.

- Before choosing work: `GET /api/claude/priorities?limit=20` (open findings in the owner's rank order, with decisions).
- Progress: `POST /api/claude/events` `{sessionId, sessionTitle, cwd, sessionStatus:"active"|"idle"|"done"|"failed", events:[{kind:"phase"|"action"|"note"|"decision", title, detail, status:"started"|"running"|"done"|"failed"|"info", phase, tool}]}`.
- Findings: `POST /api/claude/findings` `{sessionId, findings:[{id, title, category, severity:"high"|"medium"|"low", area, file, summary, scenario, fix, pr, status}]}`.
  Re-posting the same `id` updates it and keeps the owner's votes and notes. A `status` you send replaces the
  owner's decision, so omit it unless you are marking your own work (`in_progress`, `fixed`). Values:
  `proposed`, `approved`, `in_progress`, `deferred`, `rejected`, `fixed`.

## Conventions and pitfalls

- **Element ids, routes and some function names are contracts** checked by `deploy/Test-LocalAI-Candidate.ps1`
  and the Playwright tests. Renaming one breaks CI and the deploy; update the test in the same PR.
- **`app/public/ui.js` is a hand-edited bundle**: sections start `// ==== name.js ====`, each its own scope.
  Edit in place; there is no source to rebuild from. `app/public/app.css` is one file in cascade order; the
  design-system section maps old tokens onto `--ds-*`. Use `--ds-*` tokens.
- **Navigation lives in `app/public/view-registry.js`.** New page = registry entry + `<section id>` in
  `index.html`; retired ids go in `ALIASES`. Use the registry's labels in docs and UI text.
- New `tests/*.test.cjs` and `tests/*-ui.mjs` files are picked up automatically; no lists to update.
- **Never put secrets in the container, repo or logs.** The PowerShell `approval-key.txt` must never reach the
  container. Spawned processes get a filtered environment; see `docs/SECURITY.md` (Other controls, `childEnv`).
- **Host scripts run under Windows PowerShell 5.1**: send UTF-8 bytes in `Invoke-RestMethod` bodies, set
  `[Console]::OutputEncoding` to UTF-8 before reading git output, and do not run `git` under
  `$ErrorActionPreference = 'Stop'` (stderr becomes a terminating error).
- `storage.transaction()` is synchronous; never await model or network calls inside it.
- Versions: `package.json` holds major.minor (bump by hand for a notable change); the deploy appends the commit
  count on `main` (`2.0.431`) and records the merged PR titles as release notes. PR titles are the release notes,
  so write them for the owner. See `docs/DEPLOY.md` (Versions and release notes).

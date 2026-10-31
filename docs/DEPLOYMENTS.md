# Deployment evidence view

Open **Improve → Deployments** or `/#deployments`. The page adapts the Engineering Command Center Deployments concept to the existing LocalAI navigation and design tokens. It does not replace the application's shell.

## Evidence boundaries

- Only the current appliance's `/healthz` response is connected. `releaseCommit` must be a full 40-character hexadecimal commit SHA.
- A successful health response reports a deployed revision. It does not prove CI success, merge status, artifact identity, runtime verification, rollback readiness or physical acceptance.
- Reports expire after 60 seconds. Failed refreshes retain the previous revision as explicitly stale. Leaving the view aborts its read and stops the freshness timer.
- Workshop OS, Filament Inventory, Print Lab / Pi Hub, FormWorks Utilities and Mermaid / Workflow Tools remain visibly unconnected. No illustrative PRs, SHAs, environments, green counts or historical chat states are presented as current evidence.
- Source SHA, merged SHA, artifact digest, rollback evidence and exact workflow/PR/checklist links require future authoritative feed integration. Missing evidence is unknown, not a failed check and not a successful gate.
- Physical acceptance is a separate Workshop OS gate. This page cannot flash, promote, roll back or control hardware.

## UI

The environment matrix supports search, evidence filters and keyboard-selectable workstreams. Selection drives revision details, promotion evidence, next action and contextual links. An empty filter hides selection details. Pending gates use hollow circles, never completion ticks. Tables have their own overflow boundary; details and the action rail stack at narrow widths. Existing shell labels and navigation are preserved.

## Validation

`node --test tests/deployments.test.cjs tests/view-registry.test.cjs`

These tests cover exact SHA validation, workstream isolation, stale/future evidence, independent release stages, filtering and navigation contracts. Before merge, run the full `npm test`, lint, browser tests and repository-required `npm run ci -- <PR number>` on a complete checkout. Browser checks should include 480px/desktop layouts, keyboard selection, no-result filters, unavailable/denied health responses, refresh timeout and rapid navigation during a pending request.

No backend deployment feed or production runtime verification is claimed by this change.

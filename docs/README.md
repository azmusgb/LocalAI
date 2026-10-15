# LocalAI documentation

Start with the [project README](../README.md) for what LocalAI is.

## Operate

- [Operations](OPERATIONS.md): health checks, scheduled tasks, backups and restore, logs, troubleshooting index.
- [Deploy](DEPLOY.md): how merges reach the appliance, the auto-deploy task, manual deploys, rollback, HTTPS, the host-only port.
- [Storage](STORAGE.md): the SQLite database, migration, inspection, backups, JSON rollback, storage troubleshooting.
- [Security](SECURITY.md): threat model, controls as implemented, known gaps.

## Develop

- [Development](DEVELOPMENT.md): local setup, environment variables, tests, CI, front-end structure, conventions.
- [Architecture](ARCHITECTURE.md): components, ports, data flow, container layout.
- [CLAUDE.md](../CLAUDE.md): short guidance loaded into every Claude Code session in this repo.

## Components

- [Claude chat](CLAUDE-CHAT.md): chat with a running Claude Code session on the Mac from the Claude Code page.
- [Apple Watch and Siri](APPLE-WATCH.md): Siri Shortcuts for "What needs me", "Is Local AI OK" and "Ask Local AI" on an iPhone or watch.
- [GridCraft](GRIDCRAFT.md): the GridCraft page, its Windows bridge and agent.
- [GridCraft agent](../host/gridcraft-agent/README.md): running the agent by hand, desktop launcher, long-context switch.
- [ComfyUI](../host/comfyui/README.md): image generation service and engines.
- [PowerShell bridge](../host/powershell-bridge/README.md): the host runner behind the PowerShell Workbench.
- [Integrations](INTEGRATIONS.md): which tool owns which capability, and the integration roadmap.

## Design records

Specs and implementation plans written before a change was built. They record intent at the time and are not
kept up to date; the guides above describe what exists now.

- [LocalAI evolution roadmap](superpowers/specs/2026-10-15-localai-evolution-design.md): one composer, one timeline; the page map will change
- [Claude chat design](superpowers/specs/2026-10-15-claude-chat-design.md) and [plan](superpowers/plans/2026-10-15-claude-chat.md)
- [Phone redesign design](superpowers/specs/2026-10-15-phone-redesign-design.md) and [plan](superpowers/plans/2026-10-15-phone-redesign.md)
- [Improve design](superpowers/specs/2026-10-15-improve-design.md) and [plan](superpowers/plans/2026-10-15-improve.md): roadmap sub-project 4, one pipeline for changing Local AI

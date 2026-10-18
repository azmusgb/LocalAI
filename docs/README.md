# LocalAI documentation

Start with the [project README](../README.md) for what LocalAI is.

## Guides

- [User guide](USER-GUIDE.md): everyday use on a phone or computer: Home, Work, Projects, Improve, approvals,
  notifications, voice.
- [Admin guide](ADMIN-GUIDE.md): how do I… check health, update, run local CI, back up, set up a phone, reach it
  from away, pair a device. Each answer links to the detailed guide below.

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
- [Apple Watch and Siri](APPLE-WATCH.md): the "Ask Local AI" Siri Shortcut for an iPhone or watch: what needs you, health, time, weather, news, and starting work by voice.
- [GridCraft](GRIDCRAFT.md): the GridCraft page, its Windows bridge and agent.
- [GridCraft agent](../host/gridcraft-agent/README.md): running the agent by hand, desktop launcher, long-context switch.
- [ArtCraft](ARTCRAFT.md): the ArtCraft card on Services: installed/open status and opening it on the Windows computer.
- [Workshop display](WORKSHOP-DISPLAY.md): the Services card for the touchscreen beside the printer: its status, opening its own portal, its address and Tailscale route.
- [ComfyUI](../host/comfyui/README.md): image generation service and engines.
- [PowerShell bridge](../host/powershell-bridge/README.md): the host runner behind the PowerShell Workbench.
- [Integrations](INTEGRATIONS.md): which tool owns which capability, and the integration roadmap.

## Design records

Specs and implementation plans written before a change was built. They record intent at the time and are not
kept up to date; the guides above describe what exists now.

- [LocalAI evolution roadmap](superpowers/specs/2026-10-15-localai-evolution-design.md): one composer, one timeline; the page map will change
- [Claude chat design](superpowers/specs/2026-10-15-claude-chat-design.md) and [plan](superpowers/plans/2026-10-15-claude-chat.md)
- [Phone redesign design](superpowers/specs/2026-10-15-phone-redesign-design.md) and [plan](superpowers/plans/2026-10-15-phone-redesign.md)
- [Agent World design](superpowers/specs/2026-10-17-agent-world-design.md): the Missions page redesigned around the city; phone sheet, story rail, plain words
- [Web critique](superpowers/specs/2026-10-16-web-critique.md) and [web polish plan](superpowers/plans/2026-10-16-web-polish.md): what the 16 October review of every page found, what was fixed, and the owner's decisions
- [Improve design](superpowers/specs/2026-10-15-improve-design.md) and [plan](superpowers/plans/2026-10-15-improve.md): roadmap sub-project 4, one pipeline for changing Local AI

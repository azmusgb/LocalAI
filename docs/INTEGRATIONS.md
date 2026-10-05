# Local AI integration policy

Local AI is intentionally **local-first and capability-owned**. Integrations should extend an existing capability owner instead of adding parallel chat, automation, or media stacks.

## Capability owners

| Capability | Owner | Policy |
| --- | --- | --- |
| Local reasoning/chat | Ollama + Local AI | Local AI remains the user-facing chat/orchestration layer. |
| Automation | n8n | Keep n8n as the workflow engine; do not add a second automation runtime without a measured gap. |
| Image/video/avatar generation | ComfyUI | Add media models and workflows through ComfyUI; do not present optional models/nodes as installed until runtime discovery verifies them. |
| UI/UX design bridge | Penpot | Prefer self-hosting and an opt-in MCP bridge. MCP credentials must never be exposed in browser code, source, logs, or screenshots. |
| Local notes/knowledge | Obsidian vaults | Treat vaults as local source folders for Projects/Knowledge. Ingestion should preserve source provenance and default to read-only access. |
| Model discovery | Hugging Face | Registry/source only; compatibility, license, model size, and local resource fit are explicit gates before installation. |

## Security and automation guardrails

### n8n

Use n8n's official security audit after adding credentials, community/custom nodes, filesystem access, or public webhooks. The audit covers credential, database, filesystem, node, and instance risks.

Official guidance: <https://docs.n8n.io/hosting/securing/security-audit/>

### ComfyUI

ComfyUI supports API-mode workflows, but custom nodes are not automatically safe for headless/API automation. Nodes that require direct client/server communication may not be usable through the API path Local AI relies on.

Official custom-node model: <https://docs.comfy.org/custom-nodes/overview>

Stable Video Diffusion and SadTalker therefore remain **unverified capability targets** until Local AI can discover the required models/nodes from the running ComfyUI instance.

### Penpot

Penpot supports self-hosting and an MCP server for design-to-code and design-to-design workflows. Prefer a self-hosted instance for Local AI. Treat the MCP URL/key as a secret and keep it server-side.

Self-hosting guide: <https://help.penpot.app/technical-guide/getting-started/>

MCP guide: <https://help.penpot.app/mcp/>

## Implementation order

1. **Shipped:** Live n8n and ComfyUI health on System → Integrations.
2. **Next:** ComfyUI runtime capability discovery for video/avatar nodes and models.
3. **Next:** Read-only Obsidian vault mounting/ingestion into Project Knowledge with source provenance.
4. **Opt-in:** Server-side Penpot MCP connector for self-hosted design workspaces.
5. **Optional:** Local LanguageTool service for deterministic grammar/style QA.

Cloud providers remain explicit fallbacks only after a concrete local capability or quality gap is documented. Local AI must never silently upload local artifacts or enroll cloud credentials.

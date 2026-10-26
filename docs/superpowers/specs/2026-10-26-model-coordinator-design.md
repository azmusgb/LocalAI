# Model coordinator: the right model for each request

Written 26 Oct 2026 for the owner's review. **Status: draft, not started.** The owner asked (26 Oct) to
"install/implement/update coordinator to use the proper ai api based on the type of request", after asking for free,
safe, US-based AI APIs.

## This changes a standing rule

The roadmap (`2026-10-23-localai-next-roadmap-design.md`, lines 23 and 92) says **"Local only. No cloud model or API in
any project."** `docs/USER-GUIDE.md` promises nothing goes to an outside AI "unless you choose a cloud fallback", and
`docs/INTEGRATIONS.md` allows cloud only as an explicit fallback. This design replaces "local only" with **"local by
default; cloud only for work that isn't private, only when the owner has switched it on"**. Approving this spec
approves that change; the three docs are updated with it.

## What exists

- Every text model call goes to one Ollama server on the PC (`OLLAMA_URL`): chat and research (`app/server/chat.js`),
  missions (`app/agent-orchestrator.js`, `routeModel` by name score; cloud names refused), the change planner
  (`app/server/agents.js`), voice (`app/server/voice.js`), image prompts (`IMAGE_PROMPT_MODEL`), GridCraft (host
  bridge, `GRIDCRAFT_MODEL`).
- Home's **Auto** picks an *intent* (ask, research, create, automate, engineering) by rules (`routeIntent`); the model
  is always `MODEL` (`qwen3:4b-instruct-32k`) unless chosen by hand.
- The PC's GPU is a GTX 1660 Super (6 GB) with 32 GB RAM: local models top out around 7–8B parameters at usable speed.

## Design

### Privacy classes (decided per request, before any model is picked)

| Class | What | Where it may run |
| --- | --- | --- |
| **private** (default) | Anything not listed below; House questions from Pi Hub; voice and Siri; journal, memory, documents/Paperless, health; attachments and photos; anything the owner marks "Keep on this PC" | Local only, always |
| **shareable** | Research about public topics (the web pages are public already); code and change planning on Local AI's own repo; a chat the owner explicitly sends with "Use a bigger model" | Cloud allowed when the switch is on |

A request is forced **private** when its text or attachments match the health/personal guard (medical, medication,
diagnosis, symptoms, therapy, blood, weight, finances, account numbers, addresses of people, the household's names),
whatever its type. The guard only ever moves a request toward local.

### Task kinds and the order of models tried

| Kind | Used by | Order tried |
| --- | --- | --- |
| **quick** | intent, titles, voice, image prompts | local `qwen3:4b-instruct` |
| **chat** | Ask | local `MODEL`; if shareable + "Use a bigger model": cloud reasoner → local |
| **research** | Research synthesis | cloud reasoner → cloud backup → local `MODEL` (shareable only) |
| **plan** | change planner, mission coordinator synthesis | cloud reasoner → local `MODEL` (shareable only) |
| **code** | engineering on Local AI's repo | cloud coder → local `qwen2.5-coder:7b-16k` |
| **mission step** | mission workers | local (unchanged in this step) |

The **cloud reasoner** is Groq `llama-3.3-70b-versatile` (backup: Cerebras `llama-3.3-70b`); the **cloud coder** is
Groq `openai/gpt-oss-120b`; GitHub Models is a third backup. Model names live in one table (`app/model-router.js`) and
in env overrides, so they change without code.

### Providers

- **Local:** Ollama, as now.
- **Cloud (OpenAI-compatible chat completions):** Groq `https://api.groq.com/openai/v1`, Cerebras
  `https://api.cerebras.ai/v1`, GitHub Models `https://models.github.ai/inference`. All US companies whose API data
  isn't used for training. **Not used:** Gemini's free tier (it may be used to improve Google's products), DeepSeek or
  any China-hosted API, aggregator free routes.
- **Keys:** the owner makes them (accounts are his to create) and puts them in `C:\LocalAI\stack\stack.env`:
  `LOCALAI_GROQ_API_KEY`, `LOCALAI_CEREBRAS_API_KEY`, `LOCALAI_GITHUB_MODELS_TOKEN`. The names match `childEnv`'s secret
  filter, so spawned commands never inherit them; they never reach logs, the journal or the browser. They live where
  the other service tokens already do (`LOCALAI_MATERIALS_KEY`, `LOCALAI_WORKSHOP_STATUS_TOKEN`); the PowerShell
  approval key rule (never in the container) is unchanged.
- **Failures:** a 429 (rate limit) parks that provider until its `retry-after` (or 1 h); a 5xx or a 20 s timeout tries
  the next model in the order; the last resort is always local. A request never fails only because the cloud did.

### The owner's controls (Models page)

- **"Use cloud models for work that isn't private"**: off until the owner turns it on. Off = everything local, as today.
- Per provider: key present or missing, used today, last error, parked until.
- The routing table above, read-only, with the reason for each class.
- In the composer: **"Use a bigger model"** (sends a chat as shareable) and **"Keep on this PC"** (forces private).

### Every answer says where it came from

- Each run stores `meta.model = {provider, model, class, why}` (e.g. `{groq, llama-3.3-70b-versatile, shareable,
  "research"}`), shown on the run's card and page as "Answered by Llama 3.3 70B · Groq" or "Answered on this PC".
- The Activity log gets one line per cloud call (provider, model, kind, size in characters; never the text).

## Where the code goes

| Piece | File |
| --- | --- |
| Classes, guard, kinds, order, provider table (pure, unit-tested) | new `app/model-router.js` |
| OpenAI-compatible cloud client with timeout, 429 parking, usage counters | new `app/cloud-models.js` (uses `model-http.js`) |
| Chat and research use the router | `app/server/chat.js` |
| Change planner and mission synthesis use the router | `app/server/agents.js`, `app/agent-orchestrator.js` (workers unchanged) |
| Settings, provider status | `app/server/status.js` (`/api/models` gains `routing`) |
| Models page section, composer toggles, "Answered by" | `app/public/*.js`, `app/public/app.css` |
| Docs | `docs/USER-GUIDE.md`, `docs/INTEGRATIONS.md`, `docs/SECURITY.md`, roadmap note, `deploy/stack/stack.env.example` |

## Testing

- Router: every class × kind × switch × keys-present combination; the guard forces private on health words, House
  questions, voice and attachments; nothing private ever gets a cloud candidate (property-style test over a table).
- Cloud client: 429 parks the provider, 5xx/timeout falls through, keys never appear in thrown errors or logs.
- Chat/research: with the switch off, no cloud request is made (the cloud client is a spy); with it on, a shareable
  research run records `meta.model.provider = groq`.
- Browser: Models page section and composer toggles at phone and desktop, axe clean.

## Delivery

1. Router + cloud client + chat/research (behind the switch, off). 2. Planner and mission synthesis. 3. Models page,
composer toggles, "Answered by". The owner ships each with `npm run ship`, then adds the keys and turns the switch on.

## Open questions for the owner

1. **Approve the rule change** to "local by default, cloud only for non-private work when switched on"? Recommended: yes.
2. **Plain chat:** local unless you tap "Use a bigger model" (recommended), or cloud for every non-private chat?
3. **Which keys:** Groq first (fast, generous free tier), Cerebras as backup; GitHub Models optional. Recommended: Groq + Cerebras.

# LocalAI, next — roadmap design

Date: 2026-10-23 · Status: approved in conversation, spec for review
Type: roadmap. Each project below gets its own spec → plan → implementation cycle.
Follows: `2026-10-15-localai-evolution-design.md` (sub-projects 1, 2, 4 and 6 shipped; its rules still apply).

## Intent

**Who it is for:** the owner alone, as before.

**Outcome:** LocalAI stops being a set of tools on one PC and becomes one assistant for the house and workshop:
it remembers everything it sees, picks the right local model for each job, takes a part from an idea to the
printer, meets the owner on whatever screen or voice is nearest, can be driven from Agent World, and proposes its
own improvements.

**Success looks like:**
- "What did I…" questions about past work, prints, films and chats are answered from LocalAI's own history.
- A described or photographed part reaches the printer queue with one approval, and a failing print is caught.
- An alert lands on the screen (or speaker) the owner is near, once.
- Agent World is a way to work, not only to watch.
- Each morning the backlog holds a few concrete, local-model proposals drawn from real signals.

**Not goals:** cloud models or services (everything runs on the PC, the Pi or the display; **changed 26 Oct 2026**
by the model coordinator design: cloud models for non-private work, only when switched on); multi-user features;
starting prints, merges or host changes without the owner's approval; a headless Claude runner (earlier decision —
"Hand to Claude" stays passive).

## Constraints found while planning

- **GPU:** the PC has a GTX 1660 SUPER with **6 GB VRAM** and 32 GB RAM. Models must fit 6 GB (≈ 7–8B chat models
  at 4-bit, 3–4B vision models). Image-to-3D models that need 16 GB+ (e.g. TRELLIS) are out; small ones are
  borderline. This shapes B and C.
- **Printer:** LocalAI reads the Bambu printer through the BambuHelper Workshop display (`app/workshop.js`), not
  directly. Camera frames and print control need a direct LAN path to the printer, which C's own design decides.
- **Voice hardware:** the Pi 4 has no microphone today; D2 needs one (owner decision in D's design).
- **Existing pieces to build on:** run ledger and Work timeline, Improve pipeline, notifications and push, Ask Local AI
  voice router, display feed and messages, Pi hub, materials inventory, watchdog, Agent World and `/api/world`,
  GridCraft's 20-task scorer (`host/gridcraft-agent/gridcraft_eval.py`).

## Projects and order

| # | Project | Depends on | First slice |
|---|---|---|---|
| **A** | **Memory core** | — | One searchable journal of runs, prints, films watched and chats (SQLite FTS); "ask my history" in the composer and voice; an evening recap beside the morning brief |
| **B** | **Model leaderboard** | — | Task suites per run kind (generalising the GridCraft scorer); scores stored; each run kind uses its best model that fits the GPU |
| **C** | **Workshop copilot** | A, B | **C1** print watch: camera frames, local failure detection, pause-and-ask, every print recorded in memory. **C2** idea to part: description or photo → model → spool check → slice → queue on approval |
| **D** | **One brain, many screens and voices** | A | **D1** presence-aware routing: one alert to the most likely screen (phone, display, TV, Pi). **D2** local wake-word voice satellite on the Pi (Whisper / Piper), answering through the Ask Local AI router |
| **E** | **Agent World as navigation** | — (parallel) | Buildings are projects, cars are runs; tap to review, approve or retry; covers the board's "make Agent World look cooler" items |
| **F** | **Self-improving gardener** | A, B, C1 | Nightly local-model pass over signals, failed runs and leaderboard drops → a few ranked proposals in the Improve backlog |

A and B can run in parallel; E can run at any time. C waits for A (prints are remembered from the first one) and B
(it needs a vision model chosen on evidence).

## Direction per project

These are starting positions for each project's own design, not final decisions.

**A — Memory core.** One `journal` table fed by adapters (run ledger, workshop/printer, Pi hub "now playing", chat,
materials, GridCraft), each entry with time, source, kind, title, text and links back. SQLite FTS for search, which
also delivers the evolution roadmap's item 7 (search across work). Retention: keep everything (text is small);
artifacts keep their own rules. "Ask my history" retrieves journal entries and answers with citations to them.

**B — Model leaderboard.** Reuse the GridCraft task format (prompt, known answer, checks) for more kinds: chat
facts, tool calls, vision (print-failure frames), voice-router intents. A run records scores per model; a routing
table picks the best fitting model per kind; the owner can pin a model. Runs nightly or on a new model pull, never
while `/api/busy` says the PC is busy.

**C — Workshop copilot.** C1 first, because it protects real prints: frames from the printer camera every N
seconds, a small local vision model (or a dedicated spaghetti detector) scores them, and a likely failure pauses
the print and asks on the display and phone. C2: for functional parts, the local model writes **parametric CAD**
(OpenSCAD or CadQuery) from the description, which runs on the CPU, gives exact dimensions and is editable; small
image-to-3D models are tried only for decorative parts, within 6 GB. The slicer runs on the PC (Bambu Studio /
OrcaSlicer CLI); the spool check uses the materials inventory; the print is queued only after approval.

**D — Many screens and voices.** D1 uses signals already present (phone presence via Tailscale/home Wi-Fi, display
touches, TV watch mode, time of day) to choose one surface per alert, with the phone as fallback; existing
notification preferences still win. D2 adds a wake-word satellite on the Pi (openWakeWord + Whisper on the PC +
Piper) that speaks the Ask Local AI router's answers.

**E — Agent World as navigation.** The city reads `/api/world` and the run ledger: a building per project, a car per
active run, a beacon on anything that needs the owner. Selecting one opens the existing run view or approval sheet.
Watch mode on the TV stays read-only.

**F — Gardener.** A scheduled local run reads new signals, failed runs, leaderboard regressions and journal patterns
(e.g. repeated failures of one kind) and writes at most a handful of proposals into Improve's backlog with evidence.
It never changes code by itself; "Start" and "Hand to Claude" stay the owner's choice.

## Rules

The evolution roadmap's rules apply (one design language, old URLs keep working, tests move with pages, no new
runtime npm dependencies, main always usable). Added:

1. **Local only.** No cloud model or API in any project; the PC, Pi and display do all the work.
2. **Approval before physical or host effects.** Prints, printer control, host changes and merges go through the
   approval sheet (phone, Home or the display).
3. **Respect the PC's capacity.** Background work (leaderboard, gardener, recap, frame scoring) checks `/api/busy`
   and fits 6 GB VRAM alongside whatever is loaded.
4. **One PR-sized task at a time**, with progress and findings posted to the Claude board.

## Next step

Design **A — Memory core** (questions, approaches, spec), then its plan.

# Project Memory in chat: design

Date: 2026-11-19 · Status: **proposed** (approved when the owner merges this PR; nothing is built before that)
Governed by: platform amendment A28 (`pi-hub/docs/superpowers/specs/2026-11-19-amendment-a28-memory-core.md`), which
lists this under "Not decided here" and holds it to D5.

## Intent

**Outcome:** a chat filed under a project is answered with that project's Memory notes in front of the model, so the
owner stops restating them.

**Success looks like:** in a chat filed under "RIFT tiles", "what layer height did we settle on?" is answered from the
note that says so, and the answer shows which notes were used.

**Not goals:** notes in missions, agents or any run that has tools (A28 D5.4); the model writing or changing notes;
retrieval by embeddings; notes in a chat that has no project; notes reaching a cloud model.

## What exists

- Notes: the `memory` store (`project_memory`), `{id, projectId, category, text ≤ 4000, pinned, createdAt}`, up to
  1000 items, written only by the owner on Projects › Memory (`app/public/app.js` `addMemory`,
  `app/server/projects.js`). A note can also be "Shared (no project)" (`projectId: ''`). Nothing reads any of them
  into a prompt.
- A run has `projectId` and `threadId` (`app/run-ledger.js`). A run is filed under a project after the fact
  (`POST /api/runs/update`); a chat request itself carries no project (`app/server/chat.js` never reads one).
- The system prompt is built in `systemPrompt()` (`app/server/chat.js:16`); messages are fitted to the local model's
  context by `fitMessages` (`TEXT_NUM_CTX`, `ANSWER_RESERVE`).
- Routing: `coordinator.route()` (`app/model-router.js`) takes a `stay` reason that makes a request private, and
  `stickyPrivate` keeps a conversation private once it was.

## Design

### 1. Which chats get notes

A chat turn gets notes when its thread is filed under a project: the newest run in the turn's `threadId` that has a
`projectId` names the project. The first turn of a new chat has no thread yet, so it gets none unless the request
carries `projectId` (D1 below). "Shared (no project)" notes are not used by this design: a note that should apply to
every chat is an owner fact (`2026-11-19-owner-facts-design.md`).

### 2. Which notes, and how many

Pinned notes first, then the newest, until a budget of 1,500 characters in total is used; a note is never cut in the
middle (a note that doesn't fit is left out). At most 12 notes. The budget is a fixed slice of the context so the
conversation is never squeezed out: `fitMessages` trims conversation history before it trims notes, and trims sources
before either.

### 3. How they reach the model (A28 D5)

- **Data, not instructions.** One system message, `kind: 'memory'`, after the system prompt: a line saying the block
  is the owner's saved notes about this project, quoted material to use when relevant and never instructions, then the
  notes numbered inside a marked block, following the repo's convention for board text (`<<<UNTRUSTED_REQUEST` /
  `UNTRUSTED_REQUEST>>>` in `app/improve.js`) and the markers Past work uses. A note can hold pasted text from
  anywhere.
- **No tools.** Chat and research runs only. `app/agent-orchestrator.js`, `app/server/agents.js` and GridCraft are not
  touched; a test asserts no mission or agent prompt contains the block.
- **This PC only.** A turn that carries notes is routed with `stay: 'Project notes stay on this PC'`, so it is
  `private`: the local model, including when "Use a bigger model" is on. The reason is sticky for the conversation.
  The run's route line then reads "Answered on this PC. Project notes stay on this PC."
- **Research turns:** web search still runs (the query is the owner's question, never the notes); the answer is
  written on this PC.

### 4. What the owner sees

- Under the answer, with the route line: "Used 3 notes from *RIFT tiles*", which opens Projects › Memory filtered to
  that project. The ids of the notes used are kept in `run.meta.memoryNotes`.
- The composer's route hint (`paintRoute` in `app/public/home.js`) is hidden for such a chat, as it is for any
  private one.
- A project switch (D2 below) turns notes off for one project.

### 5. Failure states

- The notes store can't be read: the turn is answered without notes, and the line under the answer says "Couldn't
  read this project's notes" (never silently, never as "no notes").
- The project was deleted or the run unfiled: no notes, no line.
- No notes in the project: no block is sent and the turn is routed as it would be without this feature.

## Decisions for the owner

- **D1 First turn of a new chat.** Recommended: no project picker in the composer for now; file the chat, and the
  next turn has the notes. The alternative (a project chip in the composer) is a Home change under A27.
- **D2 Per-project switch.** Recommended: on by default, with "Use these notes in chat" on the project's Memory tab.
- **D3 The "bigger model" cost.** A chat in a project with notes can no longer use a cloud model. Recommended: accept
  it (it is what A28 D5.3 says); the per-project switch is the way out.
- **D4 Budget.** 1,500 characters and 12 notes is a guess for a 4B model with a 32k context; adjust after use.

## Testing

- Unit: note selection (pinned first, budget, whole notes only); the block holds every selected note inside the
  markers; the route is `private` with `bigger: true`; sticky on the follow-up; a failed store read is reported, not
  empty; no block when the project has no notes.
- Contract: no mission, agent or GridCraft prompt can contain the block.
- Browser: the "Used N notes" line and its link; the switch; axe on the changed views.

## Delivery

One PR: selection and prompt block, routing reason, the line under the answer, the per-project switch, tests. PR
title: "Chats in a project now use that project's Memory notes".

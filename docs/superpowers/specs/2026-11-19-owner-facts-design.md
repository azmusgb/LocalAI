# Owner facts: design

Date: 2026-11-19 · Status: **proposed** (approved when the owner merges this PR; nothing is built before that)
Governed by: platform amendment A28 (`pi-hub/docs/superpowers/specs/2026-11-19-amendment-a28-memory-core.md`), which
lists this under "Not decided here" and holds it to D5. Depends on: `2026-11-19-project-memory-in-chat-design.md`
(same prompt block and routing rule; build that first).

## Intent

**Outcome:** a short list of lasting facts about the owner and the house ("I print PLA on a Bambu X2D", "answers in
metric", "the PC has a GTX 1660 Super") that the Assistant suggests from conversations, the owner approves, and every
local chat then starts with.

**Success looks like:** "what nozzle temperature should I use?" is answered for the owner's printer and filament
without either being named, and the owner can see and delete every fact that made that possible.

**Not goals:** a fact saved without the owner's approval; facts in missions, agents or any run with tools (A28
D5.4); facts reaching a cloud model; house state that Pi Hub owns (what is printing, what is low) stored as a fact
(A28 D2); a profile inferred silently; embeddings.

## What exists

- Projects › Memory holds notes per project (`memory` store), and its project picker has "Shared (no project)"
  (`projectId: ''`). Shared notes are free text of any length and nothing reads them; there is no short, capped list
  meant for every chat.
- `systemPrompt()` (`app/server/chat.js:16`) is fixed text plus capability and voice blocks.
- The shared approval sheet (`LocalAIUI.approvalSheet`, `app/public/components.js`) is how the owner approves things.
- Past work (A28) gives the journal a way to answer "what did I say about X", which covers recall of one-off details;
  facts are for what is true every time.

## Design

### 1. The list

Facts are notes in the existing `memory` store with `projectId: ''` and `category: 'owner'`, so there is no new
store, and the existing add, update and delete routes and backups apply. Each is one sentence, ≤ 200 characters. The
list is capped at 30; the page says so when it is full, and nothing is dropped automatically.

Shown on Projects › Memory as its first group, **About you and the house**, above the per-project notes: each fact
with Edit and Delete, and Add for one typed by hand. No new page or registry entry (A27). Existing "Shared (no
project)" notes stay as they are and are not injected; each gets "Make this a fact" when it fits in 200 characters.

### 2. Suggestions

After a chat run completes on this PC, a `quick` job (always local, `app/model-router.js`) reads that turn's question
and answer and returns at most one candidate fact, or nothing. It is told to propose only something lasting that the
owner stated about themselves, their equipment or their preferences, never something from a web page or a guess.

- A candidate is dropped by rule, before the owner sees it, when it: repeats an existing fact (normalised text
  match); contains anything `redact()` (`app/journal.js`) would hide; matches the router's `PERSONAL` words (health,
  money, identity); or describes current state ("is printing", "is low", a date).
- At most 3 suggestions a day, and none while `/api/busy` says the PC is busy. Turns that were private for the
  owner's own reason ("Keep on this PC", files, personal words) produce no suggestion.
- What survives becomes a pending suggestion: "Remember this? *You print mostly PLA on a Bambu X2D.*" with **Save**,
  **Edit**, **No**, on the Memory page and as one quiet line under the answer it came from. Nothing is injected until
  Save. **No** is remembered (a hash of the text), so the same fact isn't proposed again.
- The model's proposal is untrusted text: it is shown escaped, saved only through the owner's tap, and never run.

### 3. How facts reach the model (A28 D5)

- The block from the project-memory spec, with a second heading: saved facts about the owner, quoted material, never
  instructions, inside the marked block. Facts come before project notes and share the context budget (facts: 800
  characters; a fact that doesn't fit is left out, newest first to go).
- **Only when the turn is already staying on this PC.** Facts are added after routing: if the turn is `private`, the
  local model gets them; if it is going to a cloud model ("Use a bigger model", public research), the facts are left
  out and the route line says "Your saved facts weren't used: this answer came from a cloud model." Facts do not make
  a turn private (D1 below). Voice and house questions are always local, so they always get them.
- Chat, research, voice and Past work only. Never missions, agents, GridCraft or change planning; a test asserts it.

### 4. Failure states

- The store can't be read: answer without facts and say "Couldn't read your saved facts" under the answer.
- The suggestion job fails or times out: no suggestion; nothing is shown; logged once.
- A fact is edited or deleted: the next turn uses the new list; nothing is cached across turns.

## Decisions for the owner

- **D1 Facts don't force a chat to stay local.** A28 D5.3 says a prompt carrying stored text is private. Read
  strictly with an always-on list, that would end "Use a bigger model" for good. Recommended: facts go only to turns
  that are local anyway and are left out of cloud turns, so no fact ever leaves the PC and the bigger model still
  works. This is the one place this spec reads D5.3 narrowly; if you want the strict reading, the list needs an
  off switch per chat instead.
- **D2 Model-suggested or hand-written only.** Recommended: build the list and the injection first (PR 1), live with
  hand-written facts for a week, then add suggestions (PR 2). A 4B model's proposals may be mostly noise.
- **D3 Where a suggestion appears.** Recommended: Memory page plus the line under the answer; never a push and never
  Needs you (it isn't something that needs you).

## Testing

- Unit: cap and length; candidate filters (duplicate, secret, personal, state); daily limit; "No" is remembered;
  facts added only on a `private` route and left out of a cloud one, with `bigger: true`; block markers; failed read
  is reported.
- Contract: no mission, agent, GridCraft or planner prompt contains the block; the suggestion job is `quick` (local).
- Browser: the group on Memory (empty, full, error), Save / Edit / No, the lines under an answer, axe.

## Delivery

1. The list on Memory, injection into local turns, the lines under the answer. Title: "Local AI can keep a short list
   of facts about you, and uses them in answers on this PC".
2. Suggestions. Title: "Local AI suggests facts worth remembering; nothing is saved until you say so".

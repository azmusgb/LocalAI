# Navigation, Home and Work — design (roadmap sub-project 2)

Date: 2026-10-15 · Status: approved in conversation, spec for review
Roadmap: `docs/superpowers/specs/2026-10-15-localai-evolution-design.md` (sub-project 2). Builds on sub-project 1
(run fields, runs API, run cards, `LocalAIUI.loadInto`/`ask`/`runCard`/`registerRunBody`).
Mockups (chosen options): `docs/superpowers/mockups/2026-10-15-navigation-home-work/` — `home-layout.html` (B),
`work-layout.html` (A), `run-view.html` (B).

## Intent

LocalAI is for its owner alone. This sub-project makes the app feel like one place: start anything from Home, follow
it in Work, and never wonder which page something went to. Chat, Images and Missions stop being destinations; what
you start opens where you are, as a full run view.

**Success:** from Home you can chat, research, make an image, run a mission or request a change without changing
page; everything you started is in Work, newest first; any run opens full screen, and Back returns you to where you
were; every old link and bookmark still lands somewhere sensible.

## Decisions

- After Send, the work happens in place: the run opens as a full run view (full screen on phones, a wide panel on
  desktop). Chosen over keeping per-kind pages and over a quick/long hybrid.
- The run view is a route (`#run/<id>`) whose body slot mounts the existing Chat, Images and Mission UIs (moved, not
  rebuilt). Chosen over a non-routed overlay (no Back/links) and over rebuilding those UIs.
- Home: composer docked at the bottom above the tab bar (mockup B).
- Work: grouped by time (mockup A); status is a badge per row.
- Run view: content only; Pin, File…, details and timeline in a sheet behind ⓘ (mockup B).

## 1. Navigation and routing

Five pages in `app/public/view-registry.js` (`DOMAINS`, each with `icon`); the phone tab bar and desktop rail read
from it.

| Page (domain id) | In this sub-project | Later |
|---|---|---|
| Home (`home`) | New Home (section 2) | — |
| Work (`work`) | New timeline (section 3) | — |
| Projects (`projects`) | Library, Projects, Sources, Memory as its pages/tabs | merged in sub-project 3 |
| Improve (`improve`) | Change requests, Issues, Quality signals, Claude Code | merged in sub-project 4 |
| System (`system`) | Health, Models, Integrations, Audit log; Tools: Files, Repository, PowerShell, n8n workflows, Automations, Monitors, Browser & computer, GridCraft | tidied in sub-project 5 |

- Sprite icons: `home`, `work` (new symbol: stacked rows), `projects` (new: folder), `improve` (reuse `build`
  glyph under the new id), `system`. New symbols are added to the `index.html` sprite in the same style (24 px
  viewBox, 1.8 stroke, round caps, `currentColor`).
- Chat (`ask`), Images (`create`) and Missions (`agents`) leave the navigation.
- **Routes:** each page has a hash (`#home`, `#work`, `#projects`, `#improve`, `#system`, and existing page ids such
  as `#models`); an open run is `#run/<id>`. Back/Forward move between them; Back closes a run view. Loading
  `#run/<id>` directly fetches `GET /api/runs?id=<id>`; if it doesn't exist: "This run is no longer available" and a
  link to Work.
- **Aliases** (`ALIASES` in the registry): `ask` → Home with Chat mode selected; `create` → Home with Image mode;
  `agents` → Work filtered to Missions; `runs` → Work (Work replaces the Runs list); `library`, `projects`, `knowledge`, `memory` →
  Projects; `changes`, `issues`, `quality`, `claude` → Improve; everything else keeps its id under its new domain.
  The ⌘K palette's `aka` names keep working.
- Developer tools off hides Improve (as it hid Build); the tab bar shows four equal items.

## 2. Home

Order: brand + greeting header · **Needs you** · **Recent** · composer docked above the tab bar. On desktop the same
column, centred, composer at its foot.

- **Needs you** (hidden when empty): runs `awaiting_approval`; runs failed in the last 24 h; pending approvals; a
  core service down (from the status Home already loads). Each row is a `runCard`; a service row opens Health.
- **Recent:** the latest 6 threads (`GET /api/runs?threads=1&limit=6`) as `runCard`s, and "See all" → Work. On a new
  install the existing Get started card replaces Recent until something has been made.
- **Composer:** a growing text field, a mode chip on the left (`Auto ▾`), a send button. The chip opens a sheet with
  the modes — Auto · Chat · Research · Image · Mission · Automate · Change Local AI — and the chosen mode's options
  (Chat/Research: model; Image: engine, shape, style preset; Mission: specialists). The last mode and options are
  remembered in `localStorage` (per-viewer convenience).
- **Send:**

| Mode | Result |
|---|---|
| Auto | The existing intent router (`resolveIntentRequest`) picks a mode; the chip shows the choice ("→ Chat") and a tap changes it before the run starts. |
| Chat / Research | Starts a **new** thread (`newThreadId()`), then opens `#run/<id>` with the answer streaming. |
| Image | Starts generation, opens the run view (progress → result). |
| Mission | Starts the mission, opens the run view (live Agent World). |
| Change Local AI | Creates the change request, opens its run view. |
| Automate | Opens System → Tools → Automations with the text prefilled (until sub-project 8's "Repeat any run"). |

- If a start fails, the composer keeps the text and shows the reason inline.

## 3. Work

- Data: `GET /api/runs?threads=1`, rendered with `LocalAIUI.loadInto` (error: "Couldn't load your work." + Retry).
- Day groups: Today · Yesterday · Earlier this week · Older (local time). Rows are `runCard`s; a chat row shows the
  latest turn and "Chat · N turns".
- Filter chips: All · Chats (chat + research) · Images · Missions · Changes · Other. A search field filters loaded
  rows by title and summary (full-text search is sub-project 7). The filter is remembered and reflected in the URL
  (`#work?kind=images`).
- Paging: first 60 threads, then **Show more** fetches 60 more. Server addition: `GET /api/runs?before=<run id>`
  returns items older than that run (ids sort by creation), applied together with the existing filters.
- Live: poll every 5 s while any run is running, else every 60 s; rows update in place without moving the scroll
  position.
- Tap → `#run/<id>` of the thread's latest run. Empty state: "Nothing yet. What should we do?" with a button to the
  Home composer.

## 4. Run view

Upgrades sub-project 1's run drawer in place (`#runDrawerBackdrop`, `#runDrawer`, `window.LocalAIRuns.open` keep their
contracts).

- Full screen on phones (covers the tab bar); a ~820 px panel on desktop.
- Header: ‹ back, title, subtitle (kind · project or "Not filed"), **ⓘ**, **⋯** (Cancel while running, Retry when
  failed and retryable).
- **ⓘ sheet:** Pin, File…, the details grid and the timeline (from sub-project 1).
- The approval bar shows inline at the top when `card.approval` is set.
- **Bodies** (`LocalAIUI.registerRunBody(kind, mount)`):

| Kind | Body |
|---|---|
| chat, research | The thread's conversation, rebuilt from its runs (`GET /api/runs?threadId=<t>`, oldest first: `input.prompt` → user turn, `output.text` → answer). When an answer is truncated in the ledger, the full text comes from its Library artifact. A reply box is pinned at the bottom; a reply calls `/api/chat` with the thread's `threadId` and the rebuilt messages as context, and the answer streams in. |
| image | The thread's versions as a strip with the selected image large; Another version and Edit use the existing image editor; progress while generating. |
| agent (mission) | The existing live Agent World and mission timeline. |
| engineering (change) | The existing change detail: plan, files with diff stats, tests, Apply / Deploy (with its typed word). |
| anything else | The Output block. |

- **Reuse:** the existing `#ask`, `#create` and `#agents` sections stay in the page, hidden, as hosts; a body moves
  their working subtree into the run view on open and back on close. Their scripts keep their element ids.
- The current on-device chat history belongs to the saved `localAiThreadId`, so it appears in Work like any chat.
- Errors: a run that fails while open updates live (Retry in ⋯); a failed reply keeps its text and shows the reason;
  a missing run shows "This run is no longer available".

## 5. Delivery

One PR per task; main stays fully usable after each.

1. Registry and routing — five domains with icons, hash routes including `#run/<id>`, aliases, relabelled tab bar
   and rail.
2. Run view shell — full screen/panel, ⓘ sheet, ⋯ actions, Back closes, deep links.
3. Work — timeline, filters, search, Show more (+ `before=` cursor), live polling.
4. Home — header, Needs you, Recent, docked composer with mode sheet; Send opens the run view.
5. Chat/research body — conversation from runs, reply, streaming; Chat leaves the navigation.
6. Image, mission and change bodies — existing editors and views move in; Images and Missions leave the navigation.

**Tests (each task):** browser checks at 390×844 and 1280×860, axe (`color-contrast`, `target-size`) on each new
surface, old URLs landing correctly, existing suites green (selectors change only where pages moved). Cases: Back and
Forward through runs; opening a deleted or aged-out run; replying while an answer still streams; the composer
keeping its text when a start fails; Developer tools off → four tabs; reloading mid-run.

**Out of scope:** merging Projects, Improve and System (sub-projects 3–5); notifications (6); full-text search (7);
Repeat (8); auto-mode changes (9); GridCraft as a run view (it does not create runs yet).

**Risk:** moving the existing Chat, Images and Missions UIs into the run view (tasks 5–6). Each task's browser tests
exercise them inside the run view before their old page leaves the navigation.

**Rules** (roadmap): one design language; old URLs keep working; tests move with pages; no new runtime npm
dependencies; main always usable.

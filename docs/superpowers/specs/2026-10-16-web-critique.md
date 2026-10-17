# Local AI on the web: the full critique (16 October 2026)

**Scope.** The whole web app as the owner meets it: every page, every main flow, every state (empty, loading,
error, long), on desktop (1440/1280/1024), iPhone (390/320) and iPad (768/834/1024), with keyboard and screen
reader. Four independent reviews fed this: flows and states, structure and consistency, accessibility and
keyboard, phone and tablet. Each ran the app on its own seeded server and against the live appliance (2.0.403),
and anchored every finding to a file and line. Evidence (about 300 screenshots and logs) is under
`scratchpad/critique/`. The plan that follows is `docs/superpowers/plans/2026-10-16-web-polish.md`.

**Verdict.** A 2026 shell around a 2024 internal tool. The shell (Home, Work, the run view, the status kit, the
phone tab bar, Back that behaves) is at consumer quality, and the core loop (ask, watch it stream, reply, find it
again) is solid. Roughly 60% of the pages behind it are the previous app untouched, and those are where the owner
meets "capability", "runtime", raw ids and JSON. The product fails at the **seams**: the first ten minutes
contradict themselves, Health can say "Everything is ready" on a dead server, a conversation gets renamed and
duplicated by the owner's own replies, and after most actions nothing says what happened. On the phone it is
closer to a native app than a shrunken site, let down by the one interaction the owner performs most: typing into
a composer that doesn't know the keyboard is open.

## 1. What is good (keep it)

- **The core loop.** Send opens the run instantly with the question, tokens stream, Stop works, Reply is in place,
  Back returns to where you were, failed sends keep the text.
- **Honest failure plumbing.** `loadInto` makes a failed load look different from an empty list and offers Retry;
  0-byte and unreadable replies say so; loading appears only after 300 ms.
- **The shell.** Rail, breadcrumb, ⌘K (a textbook combobox), the page strip with edge fades, five equal phone tabs
  that drop to four when developer tools are off; header, strip and tab bar stay put over a 5,400 px list.
- **Sheets and Back.** Every sheet closes on Back via `sheetHistory`; the Work scroll position survives a run-view
  round trip; true bottom sheets with 48 px actions and safe-area padding.
- **Keyboard and motion.** Every journey completes without a mouse; focus ring ≥ 8:1 everywhere; nothing animates
  continuously; 200% zoom and 320 px both work; every icon button has a name; contrast passes AA on every sample.
- **Specific pages.** Home, Work and Images are the model: one list grammar, owner words, honest status badges.
  Get started is the right concept; Search's "no pages match → search your work" path is right; the saved-copy
  banner is honest.
- **The registry** as the single source for rail, breadcrumb, ⌘K and old-name routing.

## 2. Fixed today, so the baseline is clear

#195 browser suites run locally again · #196/#204 local CI with a queue · #197/#203 44 px targets · #199/#214
flaky tests (one was a real pairing bug) · #201 saved-copy banner · #205 Back closes Improve sheets · #207 Health
deploy check · #208 Inbox failed-update alert · #209 focus box, Claude Code width, Library cards, Health spacing,
Signals disclosure · #210 Shipped by release · #211 Integrations/Sources/Memory words, Audit log restarts · #212
Work failed cards and garbled titles · #213 Health rows say what each service does, PowerShell locked state · #206
user and admin guides.

## 3. Findings, by theme and severity

Tiers: **I** the owner is misled, blocked or loses work · **M** rough edge a home user notices · **m** polish.

### 3.1 Trust: what the app says must be true

| | Finding | Evidence | Fix |
|---|---|---|---|
| I | **Health says "Everything is ready" when `/api/status` fails.** `r.json()` is read without checking `r.ok`; an empty services list reads as healthy. | `app.js:565-572`; flow 8 | On `!r.ok` or no `services`: "Couldn't check the services. Try again", keep the last known list. |
| I | **First run contradicts itself.** Five red "Fix" rows sit above "Get started", whose step 1 says the same thing; "Fix" lands on Health cards that offer no action; tapping a sample task marks step 3 done with a green check while the send fails with "local intelligence service is not healthy". | `ui.js:3414` (unconditional done), `:341-349`, `home.js:102`, `server.js:281` | While Get started is mounted, suppress the service rows; step 3 done only when a run opens; message "Chat needs Intelligence running. See Health"; Health down-cards say the action ("Start Ollama on the Windows host"). |
| I | **A conversation is renamed by each reply and saved to the Library once per turn.** After one follow-up, Work/Home show the thread under the follow-up's text while the run header keeps the first; Library has two "Conversation" items. | `server.js:1673` (thread row = latest run), `:837/:966` (library item per stream), `run-cards.js:46` | Thread title = first turn (or generated once); one Library item per thread, updated in place. |
| M | **Inbox says "Nothing needs you right now" with a "0 unread" pill while two approvals wait one tab over** and the bell says 2. | `app.js:641-644`; `index.html:178` | Alerts shows "2 approvals waiting → Approvals"; tab reads "Approvals · 2"; one count everywhere. |
| M | **Home lists the same approval twice** (Needs you and Recent). | `home.js:140` | Recent excludes rows already in Needs you. |
| M | **Models page when Ollama is unreachable:** "Model inventory unavailable / fetch failed / The application will not infer installed model state…". | `ui.js:552-553` | "Can't reach Intelligence (Ollama). Installed models show once it's running. See Health." |
| M | **Chat failure from Home** shows subtitle "Run" (kind label falls through) and only Close, no Try again. | `ui.js:2695, 2966-2975` | Label "Chat"; add Try again; link to Models for model errors. |

### 3.2 Feedback: after every action, say what happened and keep focus

| | Finding | Evidence | Fix |
|---|---|---|---|
| I | **Sending from Home drops focus to `<body>` and the first answer is never announced.** `#runLiveRegion` is empty when the stream ends; assistant turns are plain divs. A screen-reader owner hears nothing after Enter. | `ui.js:3134-3138, 3191-3196`, `run-bodies.js:47, 103-118` (WCAG 2.4.3, 4.1.3) | Focus the first control after the pending→run re-render; set the live region to "Answer ready." on done (failures already do). |
| I | **Acting on an item loses focus and leaves no trace.** Backlog "Move to top": sheet closes, list re-renders, focus on `<body>`, no toast. Approve: same, with a 2.2 s toast. | `improve.js:163-166, 40-43`; `app.js:650-654` | Refocus the same row (by id) or the next; announce "Moved to top" / "Approved". |
| I | **A ghost button after the "Updated to x.y.z" toast.** The toast fades after 10 s but its button stays in the DOM: an invisible Tab stop that navigates to Health. | `ui.js:3540-3545` (2.4.7, 2.2.1) | Clear the toast's content when hiding; make the notice dismissible, not timed. |
| M | **"Start now" from Backlog ends nowhere**: sheet closes, you stay on Backlog, the item has gone to In progress. "Hand to Claude" only adds a small badge. From Home the same action navigates. | `improve.js:184, 165`; `home.js:154` | Go to In progress (or toast with a link); "Claude will pick this up in its next session". |
| M | **Toasts are too brief and can't be re-read**: 2.2 s (approvals), 3 s (Improve errors), `pointer-events:none`. Errors vanish before they can be read. | `app.js:32`, `improve.js:189`, `ui.js:1932` (2.2.1) | Errors into the page (`role=alert` box); status toasts ≥ 5 s, pause on hover/focus. |
| M | **Approve/Reject buttons are indistinguishable** to a screen reader (four buttons named "Approve", "Reject"); cards are divs with no heading or list. | `app.js:650` (2.4.6, 1.3.1) | `aria-label="Approve: <title>"` as votes already do; `<ul>/<li>`, `<h3>`. |
| M | **Health "Check again" announces nothing.** | `app.js:572, 582` | `role=status` on `#statusSummary`. |
| M | **Reviewing a change from Home is developer prose**: "No patch operations were produced. Refine the request or workspace context.", "Not validated yet.", toast "Approval approved". | `app.js:666-669, 654` | "Nothing to apply yet", "Not tested yet", "Approved — Local AI will apply it". |

### 3.3 The phone keyboard and text you can't reach by touch

| | Finding | Evidence | Fix |
|---|---|---|---|
| I | **The Home composer ignores the iOS keyboard.** It is positioned from `innerHeight` and the tab bar; iOS changes only `visualViewport`, which nothing on Home listens to (the run view's reply box does). On a real phone the composer can sit under the keyboard with the tab bar still showing. | `home.js:~222-228`, `app.css:1698`; cf. `run-bodies.js:30` | Bind `visualViewport` resize/scroll as the run view does; hide the tab bar while the textarea is focused. Verify on the device. |
| I | **Inbox alert bodies are cut at four lines with no way to read the rest** on a phone; actions are only Mark read / Resolve. | `app.css:1239` | Tap to expand (`aria-expanded`) or open in a sheet. |
| I | **Hover-only text.** The run-view title's full text and every file's folder path exist only as `title=` tooltips. No hover on a phone. | `ui.js:2842`; Files tree; `layout-ui.mjs` pins it | Tap the title to un-clamp; show the parent path as a line under the name on `(pointer:coarse)`. |
| M | **Run view's reply bar has no safe-area padding**: on a notched iPhone, Reply and Send sit on the home indicator. | `app.css:909`; no `env(safe-area-inset-bottom)` on the reply bar | Add it. |
| M | **11 px secondary text** on Library cards and the Audit log, and audit detail is `nowrap` + ellipsis with no expansion. | `app.css:5, 1079-1083` | 13 px minimum on ≤ 760; let detail wrap to two lines. |
| M | **Work rows at 320 px leave 145 px for text** (icon + padding + badge). | `app.css:1157, 1570` | At ≤ 370, drop the leading icon or move the badge under the title. |

### 3.4 Structure: the owner's menu and the developer boundary

| | Finding | Evidence | Fix |
|---|---|---|---|
| I | **The developer boundary is too far right.** System has 13 pages. Files, Repository, PowerShell, Browser & computer and Claude Code are developer tools by content; Integrations ("Keep orchestration here instead of adding Bardeen…"; now rewritten in #211), Models ("VRAM resident", "Q4_K_M", "Runtime detail") and Audit log (12 × "Appliance started") were by copy. The switch's own description still names retired pages ("change requests, issues, quality signals and the Claude board"). | `view-registry.js:31-34`, `ui.js:3359` | Make the switch the IA boundary: owner menu ≈ Home · Work · Projects · System (Health, Models-lite, Automations, Audit log); Improve, Claude Code, n8n, Files, Repository, PowerShell, Browser & computer behind it. See D6. |
| I | **The same chat appears in four places; Library is a second Work.** Home › Recent, Work, Library (every text chat as a 16:9 card) and Audit log all list the same runs. The roadmap said Projects absorbs Library as an "Everything" view. | `view-registry.js:21`, `#library` | Library = kept and pinned work (Projects › Everything), list rows for text. See D7. |
| M | **Three queues for "deal with this"**: Home › Needs you, Inbox › Alerts, Inbox › Approvals; the page is "Inbox" in nav and breadcrumb but its own tab says "Alerts"; three different counts. | `view-registry.js:17` | Needs you is the queue; Inbox is the history; one number. See D8. |
| M | **Automations is four pages for one idea**: Automations (its type select already has "System health"), Monitors, n8n workflows (two cards, 85% empty), Browser & computer. | `view-registry.js:31-34` | One Automations page with kinds Prompt / Research / Health check / Morning brief; "Open n8n" stays a button. See D9. |
| M | **⌘K offers 30 of 31 views**, including the hidden and retired ones (Chat, Images, Missions, Change requests, Issues, Quality signals); landing on them shows a breadcrumb with no leaf and no rail item lit. | `app.js:754` | Offer `domain!=='hidden'` only; give hidden pages a breadcrumb leaf and a lit parent. |
| M | **"Projects" tab lands on Library**; the label and the landing page disagree. | `view-registry.js:12` `defaultView` | Land on Projects, or name the tab Library. See D7. |
| M | **Layout shifts between pages**: Work and Missions drop the secondary rail so content moves 298 → 110 px; Home is capped ~720 px while Work rows stretch 1,300 px with the badge 1,100 px from the title. iPad gets the desktop shell with the same jump. | `app.css:453`, `ui.js renderSecondary` | Reserve the page-list column (or collapse it consistently); cap list width on wide screens. |
| m | Section labels repeat the page ("Work › Work", "Health › Health › Health", "Automations › Automations"); Projects' h1 is "Projects" on all three tabs. | registry sections | No section header when a domain has one section; tagline Projects "What you keep". |

### 3.5 One vocabulary

| | Finding | Evidence | Fix |
|---|---|---|---|
| M | **Drift for one thing.** Work item: run / mission / job / execution / task / attempt. Change: change request / change / Changes / idea / finding / Signal / issue / item. Service: companion / capability / service / integration / tool / bridge / extension. Re-check verbs: Check again / Generate brief / Run checks now / Scan now / Run quality scan / Refresh ×4. | index.html, improve.js:8, Health | Pick **run**, **change**, **service**; one verb per action ("Check again"). A glossary in the user guide; a lint test that greps visible strings for the banned words. |
| M | **Developer-speak at anxious moments.** Run header "Chat · Not filed" on every run; Missions "Mission Router", "Routing override", "Direct execution", tabs Synthesis / Worker outputs / Evidence / Routing, toolbar Theater / Crew / Flows / Night; Projects metrics "Knowledge sources", "Artifacts". Counts in visible strings: "runtime" 64× in ui.js, "JSON" 70×/41×, "capabilit" 32×. | `ui.js:2880, 1224-1249`, `#projects` | Show nothing until filed; Missions leads with workers and the current step, the map behind "Watch live map". |
| m | **Empty states that don't say what will appear or how**: Projects "Choose a workspace.", Monitors "No monitors configured." / "Generate a current operational brief.", Files sub "Inspect, search, diff, and safely edit explicitly mounted local workspaces.", Signals' empty "Latest checks", Audit log's "Clear user activity" on a one-line log. 48 distinct empty strings; 23 start "No …". | index.html:84, 90, 171, 182; app.js:607, 657 | One pattern (as Library, Sources, Memory, Backlog already do): what appears here + how to make it appear. |
| m | Title Case leaks ("Start Mission", "Open Agent World"); "+ New idea" is the only glyph-prefixed button; `document.title` never changes, so browser history is unreadable. | `#agents`; flow 10 | Sentence case; set `document.title` per page and run. |

### 3.6 One component kit

| | Finding | Evidence | Fix |
|---|---|---|---|
| M | **Two button systems**: `.btn`/`.btn primary` (index.html 24/18; `.btn` redefined in 22 CSS blocks) vs `.btn-primary`/`.btn-outline` (components.js, the new pages); icon buttons `.iconbtn` vs `.icon-btn`. Primary emphasis is arbitrary (Signals' "Run checks now" grey, Issues' "Scan now" blue). | app.css | One button kit; one rule for which action is primary. |
| M | **Five pick-one controls**: `.ux-tab`, `.work-chip`, `.filter`, `.agent-result-tabs`, Agent World toggles. **Three empty-state looks**: `.empty`, `.empty-state`, bordered `.preview-pane`. The topbar pill carries a count, a state, a security notice and a tagline in the same style. | class counts above | One segmented control; one empty state; pills only for counts. |
| M | **Spacing and type are ad hoc**: 55 inline `style=` in index.html (31× `margin-top:10px`), about 20 font sizes (11–29 px), one type token, 8 radii. | index.html, app.css | A `.stack` gap utility and a 5-step type scale on `--ds-*`; 13 px minimum for secondary text. |
| M | **Colour semantics break on old pages**: Backlog severity "Medium" is amber (= "Needs a look"); "Claude" source badge is accent blue (= "Running"); Changes "Rejected"/"Error" grey; Quality "PASS"/"WARN" uppercase; Missions "Complete" in a cyan/orange palette used nowhere else. | `improve.js:20`, `app.css:1166` | Severity gets its own neutral treatment; status colours only for status; Missions on the kit. |
| M | **Icons carry several meanings**: sparkle = Claude Code nav + Claude items + text-chat placeholder; pencil = chat runs + change requests + a .zip; alert = Signals nav + Issues rows + a Shipped row. The legacy `<aside>` still uses letters/emoji (W, R, PS, Δ, ✳). | `#i-sparkle`, `#i-compose`, `.navicon` | One icon per meaning; a file icon for non-text files; remove the letter glyphs. |
| M | **Missions run view leads with a game console** ("Agent World · IDLE · 0 Working 0 Done · Fit Active Follow − 100% + Labels Flows Night Crew Theater · Keys: 0 fit · A active…"); the worker list is below the fold. | `ui.js:1224-1249`; flow 4 | Workers and current step first; map behind a button. |
| m | 16:9 placeholder cards for text in Library (#209 removed the box; the grid itself remains); Monitors shows two cards with ~40 px of content each; Signals' empty box is 1,100 px wide. | | List rows for text; cards only for images. |

### 3.7 Phone polish

| | Finding | Evidence | Fix |
|---|---|---|---|
| M | **Pull-to-refresh does nothing**, and only Health has a refresh. Lists refresh on a timer or visibility change. | `app.css:1195` (only `-x`), `work.js:112,133` | Pull-to-refresh on `main` for list pages, or "Updated 2 min ago" + `overscroll-behavior-y: contain`. |
| M | **Mode sheet puts Auto and Chat furthest from the thumb**; 7 cards in two columns leave an orphan. | `home.js MODES`, `.home-sheet` | One column of 56 px rows, bottom-anchored, current mode nearest the thumb. |
| M | **Library "Show 107 more" dumps 107 cards**; the controls above the list take 250 px. | `ui.js LIMITS.libraryGrid` | Page by 24; chips in one scrolling row; count inside the search placeholder. |
| M | **⌘K is a 1,545 px desktop palette on a phone**, opening under where the keyboard will be. | `app.css:15 .cmdk` | On ≤ 760: bottom sheet, 8 most likely pages, grouped by section. |
| M | **iPad gets the desktop shell with the content column jumping 188 px between tabs**, and a "⌘K" hint on a touch device. | `app.css:453`, `ui.js renderSecondary` | Reserve or consistently collapse the page list on `(pointer:coarse) and (min-width:761px)`; hide the kbd hint under `(hover:none)`. |
| m | Install metadata disagree: `theme-color #0b0d11` ≠ page `#0a111c` ≠ manifest `#090b0f`; no `apple-mobile-web-app-status-bar-style`, no maskable icon. Sticky header has no hairline once scrolled. `body.ux-sheet-open{overflow:hidden}` doesn't lock iOS scroll. | `index.html:5`, manifest, `app.css:1458, 463` | Align on `#0a111c`; `black-translucent`; maskable 512; 1 px line when `scrollY>0`; `touch-action`/position lock for sheets. |

### 3.8 Accessibility semantics (beyond §3.2)

| | Finding | Evidence | Fix |
|---|---|---|---|
| M | Mode sheet radios are in the Tab order with no arrow keys; page tabs (`.ux-tab`) promise arrows and have none, no `aria-controls`. | `home.js:66,80`; `ui.js:892-893, 962` (4.1.2) | Roving tabindex + arrows (the mission result tabs already do it), or plain buttons with `aria-pressed`. |
| M | Desktop sidebar is an `<aside>` with no `nav` role or `aria-current`. | `ui.js:958` (1.3.1, 2.4.1) | `<nav aria-label>` ×2; `aria-current="page"`. |
| M | Fields labelled only by placeholder: `#knowledgeQuery`, `#browserUrl`, `#monitorName`, `#workbenchPath`, `#workbenchSearch`, `#repoPath`. Errors not tied to fields (`aria-describedby`, `aria-invalid`). | sweep F (3.3.2, 3.3.1) | `aria-label` or visible labels; associate errors. |
| m | Conversation turns don't say who spoke; the run view has no heading; lists are plain divs; ⌘K announces no result count. | `run-bodies.js:103-118`, `#runDrawerTitle` | "You"/"Local AI" labels; `<h2>`; `role=list`; hidden `role=status` "1 page". |

### 3.9 Data and process

- Two Work runs have titles with lost first letters (unrecoverable; owner chose to keep them). Three image runs
  carry the old count-first summary ("1 704 × 1024 image…"), repairable from the run's output.
- Three PRs today merged before `local-ci` was green; one red was a real bug elsewhere (#214). The owner chose no
  blocking gate: local CI should therefore make a red impossible to miss (PR comment with the failing test's
  name) and rerun a failed browser suite once, reporting "passed on retry" distinctly.
- The Mac's own browser doesn't trust the appliance's current certificate (needs the owner's password).
- Keep both sides when merging `main` into a branch (#174/#175 lost work that way).

## 4. Decisions for the owner

Answered: **D1** hide Files, Repository, PowerShell and Browser & computer behind the developer switch · **D2** keep
the two odd-titled runs · **D3** no blocking merge gate · **D4** retire `issues`, `quality`, `changes`, `runs`
(their ids already alias to Signals, In progress and Work) and keep `ask`, `create`, `agents`.

| # | Question | Recommendation |
|---|---|---|
| D5 | Trust the appliance's current certificate on this Mac (needs your password; commands given earlier). | Yes. |
| D6 | Extend the developer boundary: also put **Claude Code** and **n8n workflows** behind the switch, and hide Models' runtime details and Technical status unless it is on? Improve is already behind it. | Yes. The owner menu becomes Home · Work · Projects · System (Health, Models, Automations, Audit log) plus Improve when on. |
| D7 | **Library inside Projects**: Library becomes Projects › "Everything you kept" (list rows for text, cards for images); the Projects tab lands on Projects. | Yes. Work remains the place for "everything I did"; Library for "what I kept". |
| D8 | **One queue**: Approvals folds into Home › Needs you (full detail in a sheet); Inbox becomes the history with its tab named "Inbox"; one count on the bell. | Yes. |
| D9 | **One Automations page** with kinds Prompt / Research / Health check / Morning brief; Monitors retires; "Open n8n" stays a button on it. | Yes. |
| D10 | Thread naming: a conversation keeps its **first** message as its title (or a short generated one), and the Library holds one item per thread. | First message, generated title later if wanted. |

D6–D10 change structure the owner sees every day, so they wait for a yes. Everything else in the plan proceeds.

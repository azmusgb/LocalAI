# Navigation depth: fewer places, one way to move between them

Date: 2026-11-09. Status: proposed, waiting for the owner's decisions D1-D5. Amends
`2026-11-02-navigation-tools-settings-design.md` and `2026-10-17-navigation-structure-design.md`. The five areas,
the phone bar, Home's composer, ⌘K and the `ALIASES` for old addresses all stay.

## Why

The owner's words (9 Nov): "feel like localai has things buried deep - so many tabs/tab groups". The 2 Nov update
removed the developer-tools switch and the second strip, and it shipped. What remains is breadth and mixed
mechanisms, not one buried switch.

## What the walk-through found (main `90d11ba`, a fresh server with an empty data folder; 1440 px and 390 px)

Every view in `app/public/view-registry.js` was opened by address, and its page strip, tabs, filter chips and headings
were recorded. Claude Code was skipped, because opening it creates a pairing code.

**33 views, 27 a person can reach from a menu, and four ways to move between them:**

| Area | Level 2 | Level 3 | Mechanism |
|---|---|---|---|
| Home | Home, Inbox (bell) | Chat and Images are composer modes (`Auto ▾`) | composer menu |
| Work | Work · Agent World · Assistant automations | Work's 8 filters: All, Needs you, Chats, Images, Missions, Spreadsheets, Changes, Other | tab strip of one page, then filter chips |
| Projects | Projects · Sources · Memory · Library | Library's 5 filters | tab strip of one page, then filter chips |
| Improve | Backlog · In progress · Shipped · Signals · Claude · Atlas | Atlas: systems, lenses, findings | page strip of separate pages |
| System | Status · Models · Connections · Tools · Settings · Audit log | Tools: 6 cards (Files, Repository, PowerShell, Browser & computer, n8n, Architecture) | page strip, then cards |

The strips look the same but behave differently: in Work and Projects they are tabs of one page, while in Improve and
System they are separate pages. A row of filter chips under a row of tabs reads as a third level.

**Clicks from Home** (rail or bar counted as one):

| Destination | Clicks |
|---|---|
| Work, Projects, Backlog, Assistant status | 1 |
| Agent World, Library, Shipped, Models, Settings | 2 |
| Files, Repository, PowerShell, Browser & computer, n8n | 3 (System › Tools › card) |
| Spreadsheets | 2 (Home › `Auto ▾` › Spreadsheet) or 3 (Work › chip › a run) |

Ranked by how much each costs the owner:

1. **The tools the owner works with daily are the deepest.** The five System tools take three clicks, or ⌘K. Nothing
   remembers which ones the owner uses.
2. **Two strips overflow the phone again.** At 390 px, System's six tabs clip "Audit log" and Improve's six clip
   "Atlas", even with the short labels from 2 Nov. Work (3) and Projects (4) fit.
3. **System says the same thing three times.** Status shows "0 of 5 core services up" and a Services list. Connections
   opens with "0/2 core services healthy" and lists the same services with what each does. Models has a "What runs
   where" section, and so does Atlas. To learn whether something is up, the owner has to pick between two tabs.
4. **Improve splits one list into three pages.** Backlog, In progress and Shipped are stages of the same item, and each
   page on a quiet day is a heading and an empty state.
5. **Two kinds of strip.** See the table above. A person can't predict whether a strip item changes the page or only
   its contents, or whether "← Home" or the rail is the way back. The top bar shows "← Home" on desktop beside the rail,
   which already has Home.

There is no record of which pages the owner opens. The audit log records actions, not page views, so this design does
not claim frequencies. D5 proposes counting them.

## Rules this design keeps to

- **Two levels at most:** an area, then a page. Anything below that is a filter on the page you are already on, never
  another place to go.
- **One strip style:** each strip item is a page, with its own address and heading. A page with filters shows them as
  chips inside its own content, never as a second strip.
- **Five strip items at most**, so that every strip fits 390 px with full labels. The check is a test, not a promise
  (Verification below).
- **Your own shortcuts beat our hierarchy:** pinned pages (D2) reach anything in one click.

## Proposal

| | Today | Proposed |
|---|---|---|
| Improve strip | Backlog · In progress · Shipped · Signals · Claude · Atlas (6) | **Changes** · Signals · Claude · Atlas (4). Changes is one ranked list with stage chips Backlog · Doing · Shipped; it opens on Backlog. `#backlog`, `#inProgress` and `#shipped` resolve to Changes with that chip selected |
| System strip | Status · Models · Connections · Tools · Settings · Audit log (6) | **Status** · Models · Tools · Settings · Audit log (5). Connections merges into Status: one health headline, then one list of every service and connection with its state and what it is for. `#integrations` resolves to Status |
| "What runs where" | On Models and on Atlas | Only on Atlas, which draws it from Pi Hub's registry. Models keeps installed and loaded models and cloud models |
| Tools | System › Tools › card (3 clicks) | Unchanged, plus pins (D2). Cards show "last used" so the page leads with what the owner uses |
| Architecture card on Tools | A second way into Atlas | Removed; Atlas is Improve's tab (D3) |
| Pins | None | Up to four pages pinned by the owner, shown as a row on Home under the composer and in the ⌘K palette's first group. Pin or unpin from a page's heading menu |
| "← Home" in the top bar | Every page, desktop and phone | Phone only, where there is no rail |
| Work filters | 8 chips | Unchanged in this design; listed under Open questions |

After this, every page is at most two clicks from Home, and any pinned page is one.

## Decisions for the owner

- **D1. Merge Connections into Status** (recommended). Alternative: keep both, and drop Audit log from the strip into
  Status as a "History" link. Either way System fits five.
- **D2. Pins on Home, up to four** (recommended). Alternative: a sixth rail item, "Tools", which reaches the five tools
  in two clicks but crowds the phone bar to six.
- **D3. Atlas only in Improve** (recommended). Alternative: keep the Tools card as a shortcut.
- **D4. One Changes page with stage chips** (recommended). Alternative: keep the three pages and accept that Improve's
  strip scrolls on the phone.
- **D5. Count page opens locally** (recommended): a per-view counter in the appliance's own database (view id and
  count by day, nothing else, never sent anywhere), shown on Settings with a reset button. It informs which pages to
  pin by default and which to retire next. Alternative: no counting; decide by asking the owner.

## Open questions

- Work's eight filters include **Needs you**, which repeats Home, and **Missions**, which repeats Agent World. Remove
  them, or keep them because a filter is cheap? Not decided here.
- Library is "what you kept", and Work's filters cover the same chats and images. A later design could make Library a
  "Kept" filter on Work. Not proposed now.

## Implementation, in PRs once approved

1. `view-registry.js`: Changes, the merged Status, aliases, the removed Architecture card; registry and navigation
   tests updated.
2. Changes page (stage chips over the existing Improve data) and Status page (merged services list).
3. Pins: storage, Home row, palette group and heading menu.
4. Top bar "← Home" on phone only.
5. If D5: the page-open counter and its Settings card.

## Verification

- `tests/navigation-ui.mjs` asserts every strip has at most five items and no strip overflows at 390 px.
- Every retired address resolves (an `ALIASES` test), and ⌘K still finds each page by its old names (`aka`).
- The width sweep, axe and visual baselines, with screenshots at phone, tablet and desktop widths in light and dark,
  before each UI PR is called done.

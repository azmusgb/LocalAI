# Phone redesign — design

Date: 2026-10-15 · Status: approved mockups, spec for review
Mockups (approved): https://claude.ai/artifact/2uczmEkCU2pB5sWVknT7zp — Home, Chat, Change requests, Missions, Health at 390×844.

## Goal

Make Local AI feel like a first-class phone app. Today a phone screen spends about half its height on chrome
(top bar, pill row, page title, description, a button) before any content, the tab bar uses placeholder glyphs and
floats above Safari's own bar, and forms are raw. The redesign gives every page one compact header, underline page
tabs, a flush tab bar with real icons, content-first layouts and one consistent visual language — and carries the
same language (type, colors, icons, badges, lists) to desktop without changing the desktop layout.

## Scope

- **In:** the phone shell (≤ 760 px) for every page; page-level phone layouts for all 26 pages using shared patterns;
  the five mocked pages built as mocked; the same visual tokens, type, icons and components on desktop.
- **Out:** a desktop layout overhaul (the rail + section list stay); redesigning the Agent World canvas itself;
  new features. Copy changes only where the mockups change them.

## Design language

| Token | Value | Use |
|---|---|---|
| `--ds-bg` | `#0A111C` | page ground |
| `--ds-surface` | `#121B2B` | cards, lists, composer |
| `--ds-surface-2` | `#172238` | chips, pressed rows |
| `--ds-line` | `#1B2740` (dividers) / `#1F2C42` (card edges) / `#263552` (inputs, outline buttons) | hairlines |
| `--ds-text` | `#EAF0F8` | primary text |
| `--ds-muted` | `#93A4BC` | secondary text (≥ 7:1 on bg) |
| `--ds-faint` | `#8698B1` | inactive tabs/labels (≥ 4.5:1 at 11 px+) |
| `--ds-accent` | `#6CB6FF` (fill) / `#7CC0FF` (text, links, active tab) / ink `#04111F` | the one action color |
| `--ds-attention` | `#FFB224` (fill), `#FFC352` (text) | "needs you" |
| `--ds-good` | `#3ED598` / text `#5BE0A8` | healthy, done |
| `--ds-bad` | `#FF6B6B` / text `#FF8A8A` | broken, failed |

- **Type:** Figtree 400/500/600/700, **self-hosted** (`app/public/fonts/`, OFL; the appliance must render offline),
  fallback `system-ui`. Scale: 11 (tab labels, badges) · 13 (secondary) · 15 (body, tabs) · 16–17 (inputs, row titles)
  · 20 (header) · 22 (empty-state/hero titles). Inputs ≥ 16 px on phones.
- **Shape:** radius 12 (inputs, small buttons), 14–16 (buttons, list groups), 18–20 (cards, composer), 999 (badges, chips).
  Spacing on a 4 px grid; page gutter 16 px.
- **Icons:** one inline SVG sprite (`<symbol>`s in `index.html`, used with `<use href="#i-…">`), 24 px viewBox,
  1.8 stroke, round caps, `currentColor`. Set: home, workspace (sparkles), automate (bolt), build (code), system (pulse),
  search, bell, chevron-down/right, send (arrow-up), globe, compose (pencil), refresh, image, plus, check, x.
- **Status badges:** 24 px tall, 12 px semibold text, tinted background, never interactive-looking (no border, no
  hover). Plain-language labels ("Ready to review", "Needs a look", "Done", "Down") mapped from internal statuses.

## Shell (phone, ≤ 760 px)

1. **Header** (52 px, sticky, safe-area aware): left — the domain name as a button (`Build ▾`, 20 px/650) that opens
   the existing page sheet; Home shows the brand mark + "Good morning/afternoon/evening" + "Local AI" instead. Right —
   up to two 44 px icon buttons: Search (opens ⌘K palette) and Inbox bell with count badge; a page may replace Search
   with its own action (Health: refresh). Replaces the context bar's title, Menu and Inbox text buttons.
2. **Page tabs** (44 px, sticky under the header): underline tabs for the domain's pages and the current page's tab
   group, 15 px, active = text color + 2 px accent underline, scrollable with the active tab scrolled into view; no pills.
   Replaces the `.ux-page-strip`/chip row.
3. **No page title block on phones:** `.topbar` h1 and description are visually hidden (kept for screen readers);
   page actions that lived in the topbar move into the header action slot or the page's first card.
4. **Tab bar:** flush to the bottom (no floating card), translucent `--ds-bg` with a top hairline, 5 items with sprite
   icons + 11 px labels, active item = accent color + 52×30 tinted pill behind the icon; bottom padding
   `env(safe-area-inset-bottom)`. Hidden Build when Developer tools is off (existing behavior).
5. Content gutter 16 px; first content 14 px under the tabs; the content never sits under the header, tabs or tab bar.

## Shared page patterns

- **Card**: surface, 18 px radius, 1 px card edge, 14–16 px padding.
- **List group**: surface, 16 px radius, rows ≥ 52 px with 1 px dividers; row = optional 32 px icon tile + title/subtitle
  + trailing value/badge + chevron when it navigates.
- **Settings row**: label left, value right in muted, chevron; implemented as a real `<select>` (or button opening one)
  styled as the row, so it stays accessible and native on iOS. Replaces label-above-select form fields on phones.
- **Banner**: attention-tinted card with a count, one line of explanation and one action.
- **Empty state**: 52 px icon tile, 22 px title, one sentence, then 2–3 starter actions.
- **Composer**: rounded 24 px field, leading toggle icon (optional), growing textarea, trailing 40 px circular send
  (disabled = muted fill).
- **Primary button**: accent fill, 48 px, 14 px radius; secondary: outline `#263552`. One primary per screen region.

## The five mocked pages

- **Home:** brand header; "What should we do?" composer card (mode picker chip + send); one row of suggestion chips;
  **Needs you** list (pending changes, broken core service, pending approvals — from data already on Home) with
  "See all"; **Recent** 3-up grid (images as thumbnails, chats as text tiles) with "Library". The capability tiles,
  execution map and duplicate cards are removed from phones (they remain on desktop).
- **Chat:** model chip (current model + "on this network") and a compose icon for New conversation; empty state
  "Private chat" + three starters; messages as before; composer pinned above the tab bar with the web-research globe
  toggle (replaces the checkbox) — fixes the overlapping empty-state bug. The "Idle" phase text is shown only while
  something is happening.
- **Change requests:** "N changes waiting for you → Review" banner when pending > 0 (scrolls to/filters the ledger);
  "New change" card = textarea + settings rows *Applies to* (target) and *How* (attempts) + "Plan and test" + "Nothing
  is applied until you approve it."; Recent = list group with plain-language badges. Fixes the blank Target select.
- **Missions:** "Give the team a goal" card (normal-weight placeholder — fixes the bold placeholder), *Project* settings
  row, Preview plan / Start mission; **Last mission** card (static mini-map preview, crew avatars, Done badge, Read
  result / Watch replay); Agent World and the full timeline stay below.
- **Health:** refresh in the header; summary card with a ring (healthy/total) and a one-line verdict; **Core services**
  and **Optional companions** list groups with status dots and latency; **Settings** group with Developer tools as a
  `role="switch"` toggle (replaces the checkbox card).

## Other pages (patterns, not bespoke layouts)

Every other page gets the shell plus the patterns above: forms become cards with settings rows; lists become list
groups with plain-language badges; page-level buttons ("Refresh", "Check again", "Scan now") move into the header
action slot as icons where there is one obvious action, otherwise into the first card; descriptions move into empty
states. Images, Library, Inbox, Issues, Runs and Audit log get list/grid treatments; Files, Repository, PowerShell keep
their tools inside cards.

## Desktop

Adopt tokens, Figtree, the icon sprite (rail and section list icons), status badges, list groups and settings rows
where they replace the same component; keep the rail/section layout and page titles. No layout changes beyond
component swaps.

## Accessibility and quality bars

- 44 px targets, inputs ≥ 16 px, contrast ≥ 4.5:1 (axe clean for color-contrast and target-size on phones).
- Real buttons/links/selects; icon buttons have `aria-label`; tabs are `role="tablist"` with `aria-selected`, or links
  with `aria-current="page"`; the switch is `role="switch"` + `aria-checked`.
- `prefers-reduced-motion` respected; no layout shift when the header/tabs become sticky.
- Existing behavior and element ids stay (tests and app.js depend on them); new elements are additive.

## Testing

- `tests/mobile-ui.mjs` updated for the new shell: header height ≤ 56 px, tabs ≤ 44 px, first content within 120 px of
  the top on every page, tab bar flush (bottom = viewport bottom), no pill row, no visible h1 on phones, the three bugs
  fixed (chat empty state not overlapping the composer, Target select shows a value, mission placeholder weight 400).
- `tests/design-system-ui.mjs`: Figtree loaded from `/fonts/`, no Google Fonts request, sprite present.
- axe on phone for every page: no `color-contrast` or `target-size` violations.
- Screenshot pass of all 26 pages at 390×844 reviewed against the mockups.
- All existing suites keep passing.

## Rollout (one PR each, in order)

1. Foundation: tokens, self-hosted Figtree, icon sprite, header, page tabs, flush tab bar, hide phone page titles.
2. Home and Chat.
3. Change requests and Missions.
4. Health and the rest of System (Models, Integrations, Runs, Audit log).
5. Remaining pages (Workspace: Images, Library, Projects/Sources/Memory; Home: Inbox/Approvals; Automate: Automations,
   n8n, Browser & computer, Monitors; Build: Issues/Quality, Claude Code, Files, Repository, PowerShell).
6. Desktop adoption of the components and icons.

# Navigation structure: five areas, one second-level pattern

Date: 2026-10-17. Status: approved by the owner ("Yes") after the critique in chat. Builds on
`2026-10-15-navigation-home-work-design.md`, which this partly reverses (Improve hidden with Developer tools off).

## Problems (critique of `main` at b307721, phone = iPhone 14, desktop = 1440 px)

1. **Improve is invisible by default.** Developer tools off hides the whole area, yet the owner uses its Backlog,
   In progress and Claude board daily. Opened from a link, no tab is highlighted, so there is no "you are here".
   Claude Code is a `dev` page in System, hidden the same way. Local AI has one user; hiding his own pipeline from
   him protects no one.
2. **System is a junk drawer.** Tagline "Health and history", but it holds Automations (scheduled work) and
   Spreadsheets (a tool you make things with) next to Health, Models, Services and Audit log.
3. **Three overlapping second-level navigators on the phone**: the title's "⌄" sheet, the underlined page strip
   (which overflows: "Spreadsheets" cut off, "Audit log" off-screen) and in-page tabs in two other styles (Projects'
   2×2 segmented box, Work's segmented row of *filters* that look exactly like page tabs).
4. **The header's top-right slot changes meaning**: Search (Home, Work, Projects), Refresh (Health, duplicating
   "Check again"), "+" (Improve).
5. **Four doors to "what needs me"**: Home › Needs you, the Inbox page, the bell, and the desktop rail's
   "Attention" footer, although D8 chose one queue.
6. **Heavy desktop chrome that repeats itself**: 264 px of rail plus a section column (Home's has two links), and
   the page name in the breadcrumb, the highlighted item and the H1. Desktop and phone teach different models.
7. **Names drift**: Home says results go "to your Library"; the tab is "Everything you kept" (long enough to wrap
   Projects' tabs to two rows). Missions has no entry of its own.

## Target

| Area (bar / rail) | Pages, in one strip | Change |
|---|---|---|
| Home | Home | Inbox only behind the bell |
| Work | Work · Automations | Automations moves here under its own name; Work's kinds are chips, not tabs; Missions stays reachable from Work's Missions filter (Agent World is a separate project) |
| Projects | Projects · Sources · Memory · Library · Spreadsheets | "Library" everywhere; Spreadsheets moves here |
| Improve | Backlog · In progress · Shipped · Signals · Claude Code | always shown; Claude Code is an ordinary page |
| System | Health · Models · Services · Audit log | + developer pages while Developer tools is on |

- **One second-level pattern**: the underlined page strip, on the phone and the desktop. The "⌄" sheet goes; the
  desktop drops the section column and the breadcrumb (⌘K search stays in the top bar).
- **Fixed header**: Search and the bell always in the same place on every page. Page actions live in the page
  (one primary per page, as the button kit already requires).
- **One "what needs me"**: the bell (with its count) opens the Inbox; Home › Needs you stays as Home's content; the
  desktop "Attention" footer goes.
- Old ids keep working through `ALIASES`; element ids do not change.

## Decisions

- N1. Improve is always one of the five areas. Developer tools only adds the developer pages (Files, Repository,
  PowerShell, Browser & computer, n8n workflows) and the diagnostic tiles marked `data-dev-only`.
- N2. Claude Code moves from System (dev) to Improve, not dev.
- N3. Five items in the phone bar (the iOS maximum, and the evolution spec's five areas).
- N4. Pages move between areas by registry edits (`domain`, `section`, `parent`); no element id changes.
- N5. The underlined strip is the only page-level navigation below the bar/rail; filters inside a page are chips.

## Not in this work

Renaming areas, Home's composer layout, new pages.

## Testing

Each PR updates the navigation, router, mobile, first-run and visual suites it touches, and runs every browser
suite on a fresh server before the PR. Visual baselines are regenerated only for the pages whose navigation changed.

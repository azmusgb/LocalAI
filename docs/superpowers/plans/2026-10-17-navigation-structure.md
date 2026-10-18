# Plan: navigation structure

Spec: `docs/superpowers/specs/2026-10-17-navigation-structure-design.md`. One PR per step, each based on `main`
(merge `main` into the next branch after the previous one lands; keep both sides of conflicts).

1. **Improve always shown; Claude Code moves into it** (N1, N2, N3). Remove Improve from the
   `.dev-tools-off` rule in `app.css`; `claude` → `domain:'improve'`, not `dev`; `applyDevTools` stops sending you
   Home from Improve; Health's toggle copy. Tests: first-run, router, mobile (five items), navigation (developer
   pages list), claude-board, layout. This PR also carries the spec and this plan.
2. **Fixed header slots** (spec: Fixed header). Search and bell on every page; Refresh and "+" move into their
   pages. Tests: mobile, layout, tap-targets, visual.
3. **Pages to their areas** (spec table). Automations → a tab of Work (keeps its name); Spreadsheets → Projects; "Everything you
   kept" → "Library" in the registry and copy. Tests: navigation, router, search (⌘K labels), visual.
   Done with part of step 4, because moving pages without it stacked two identical tab rows: the phone strip lists a
   page's tabs (Projects › Library, Work › Automations) and the page's own tab row hides there; page tabs are
   underlined everywhere (`.ux-page-tabs`), so they never look like the boxed filters under them.
4. **One strip everywhere** (N5), the rest. Phone: drop the "⌄" sheet. Desktop: drop the section column and the
   breadcrumb, use the strip under the H1. Tests: a11y-nav,
   navigation, layout, mobile, visual (largest PR; may split phone / desktop).
5. **One "what needs me"**. Bell count opens the Inbox; drop the desktop "Attention" footer; Inbox leaves Home's
   strip. Tests: notifications, home, navigation.

Each PR: `npm test`, lint, all browser suites on a fresh server, `npm run ci -- <PR>`; post progress to the Claude
board.

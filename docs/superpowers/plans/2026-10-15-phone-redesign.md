# Phone Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved phone redesign — one compact header, underline page tabs, a flush icon tab bar, content-first pages and one visual language — across all 26 pages, then carry the components to desktop.

**Architecture:** Tokens, the self-hosted font and an inline SVG icon sprite land first; the shell (header, page tabs, tab bar) is rebuilt inside the existing navigation section of `app/public/ui.js` (`buildContext` / `buildPageStrip` / `buildMobile`) and styled in a new "Phone shell" block of `app/public/app.css`; pages are then restyled with shared component classes. Each task is its own PR merged to main before the next starts (other sessions also edit these files).

**Tech Stack:** Vanilla HTML/CSS/JS (no build step), Playwright browser tests, axe-core 4.10.2 for accessibility checks in tests.

> **Scope change (2026-10-15):** this plan now ends after **Task 2**. The LocalAI evolution roadmap
> (`docs/superpowers/specs/2026-10-15-localai-evolution-design.md`) merges or replaces the pages Tasks 3–6 would restyle,
> and its sub-projects adopt the components on desktop as each new page lands (Task 7). Tasks 3–7 are kept below for
> reference only — do not execute them.

**Spec:** `docs/superpowers/specs/2026-10-15-phone-redesign-design.md` · Mockups: https://claude.ai/artifact/2uczmEkCU2pB5sWVknT7zp (the Design canvas; each screen is a `.dc.html` file — readable with the Artifact `read` action, `path: "project/<Name>.dc.html"`, names Main/Chat/Changes/Missions/Health).

## Global Constraints

- Phone breakpoint: `@media (max-width:760px)`; desktop layout (rail + section list) unchanged.
- Tokens exactly as the spec's Design language table; new/changed values go on the existing `--ds-*` names in the design-system `:root` (add `--ds-attention`, `--ds-attention-text`, `--ds-good-text`, `--ds-bad-text`, `--ds-accent-text`, `--ds-line-card`, `--ds-line-input`).
- Font: Figtree variable, self-hosted at `app/public/fonts/figtree-latin-wght-normal.woff2` (from `@fontsource-variable/figtree@5.1.1`, file `files/figtree-latin-wght-normal.woff2`, OFL — add `app/public/fonts/OFL.txt`), `@font-face` weight range 400 700, `font-display: swap`; no request to Google Fonts or any other origin at runtime.
- Icons: one `<svg hidden>` sprite at the top of `<body>` in `index.html`, `<symbol id="i-<name>" viewBox="0 0 24 24">`, stroke `currentColor`, width 1.8, round caps/joins; names: `home workspace automate build system search bell chevron-down chevron-right send globe compose refresh image plus check x`. Use: `<svg class="icon" aria-hidden="true"><use href="#i-home"/></svg>`.
- Every existing element id stays; app.js/ui.js behavior stays; new markup is additive or replaces only presentational wrappers.
- Phone quality bars: targets ≥ 44 px, inputs ≥ 16 px, axe `color-contrast` and `target-size` clean on every page at 390×844.
- Header 52 px, page tabs 44 px, tab bar flush to the viewport bottom with `padding-bottom: env(safe-area-inset-bottom)`; content never hidden under any of them.
- Copy: plain-language status badges map internal statuses — `awaiting_approval`/`ready`→"Ready to review", `needs_attention`→"Needs a look", `applied`/`completed`/`answered`→"Done", `running`→"Running", `failed`→"Failed", `queued`→"Queued", `DOWN`→"Down", `HEALTHY`→"Healthy", `OPTIONAL_OFFLINE`→"Offline". One helper `statusBadge(status) → {label, tone}` with tone `accent|attention|good|bad|neutral`.
- Each task: branch from latest `origin/main`, PR, CI green, merge (auto-deploys); update `tests/` in the same PR; all existing suites keep passing.

## Review Focus

1. **Domains with many pages (Build: 8, System: 5) on a 320 px phone** → page tabs scroll horizontally, the active tab is scrolled into view, nothing wraps or overflows the page. Test in Task 2.
2. **Developer tools off** → Build disappears from the tab bar and the remaining 4 items fill it evenly; turning it on restores 5. Test in Task 2.
3. **No internet** → the app renders in Figtree from `/fonts/` and makes no cross-origin requests. Test in Task 1.
4. **Phone keyboard open on Chat** → the composer stays visible above the keyboard (uses `100dvh`/`visualViewport`, not fixed `100vh`). Test in Task 3 (emulate a reduced visual viewport).
5. **A page with no data yet (fresh install)** → empty states render inside the new cards with no stray headings or zero-height boxes. Test in Tasks 3–6 (run the phone suite against a fresh DATA_DIR).

---

### Task 1: Foundation — tokens, font, icon sprite, components CSS

**Files:**
- Create: `app/public/fonts/figtree-latin-wght-normal.woff2`, `app/public/fonts/OFL.txt`
- Modify: `app/public/index.html` (sprite after `<body>`), `app/public/app.css` (design-system `:root` tokens; new "Components" block before the phone layer), `app/public/sw.js` (cache the font), `app/server.js` only if `.woff2` needs a MIME type
- Test: `tests/design-system-ui.mjs`

**Interfaces:**
- Produces CSS classes (all sizes): `.icon` (24 px, `currentColor`), `.card`, `.list-group` + `.list-row` (+ `.list-row__icon`, `.list-row__main`, `.list-row__title`, `.list-row__sub`, `.list-row__trail`), `.settings-row` (label/value/chevron; wraps a real `<select>`), `.badge` + `.badge--accent|attention|good|bad|neutral`, `.banner` (`--attention`), `.empty-state`, `.btn-primary`, `.btn-outline`, `.icon-btn` (44×44), `.chip`.
- Produces JS (in ui.js, a small `// ==== ui-kit.js ====` section exposing `window.LocalAIKit`): `icon(name) → string` (sprite `<svg>` markup), `statusBadge(status) → {label, tone}`, `badgeHtml(status) → string`.

- [ ] **Step 1: Failing tests** in `tests/design-system-ui.mjs`: `font is Figtree from /fonts and no cross-origin requests` (record all requests during load; assert none leave the page origin; `document.fonts.check('16px Figtree')` true; computed body font-family starts with `Figtree`); `icon sprite has every named symbol` (the 17 ids); `statusBadge maps statuses` (the Global Constraints table, via `window.LocalAIKit.statusBadge`).
- [ ] **Step 2: Run** `LOCALAI_URL=http://127.0.0.1:3099 node tests/design-system-ui.mjs` against a local server — expected FAIL.
- [ ] **Step 3: Implement** (font file downloaded once from `https://cdn.jsdelivr.net/npm/@fontsource-variable/figtree@5.1.1/files/figtree-latin-wght-normal.woff2` and committed; OFL text from the same package's `LICENSE`).
- [ ] **Step 4: Run** the suite and `npm test` — PASS; all other browser suites still pass.
- [ ] **Step 5: Commit + PR** "Design foundation: Figtree, icon sprite, component classes".

### Task 2: Phone shell — header, page tabs, flush tab bar

**Files:**
- Modify: `app/public/ui.js` (`buildContext`, `buildPageStrip`/`renderPageStrip`, `buildMobile`, `sync`, the first-run Developer-tools hook), `app/public/app.css` (replace the phone rules for `.ux-context-bar`, `.ux-page-strip`, `.ux-mobile-nav` with a "Phone shell" block; hide `.topbar h1`/`.sub` visually on phones)
- Test: `tests/mobile-ui.mjs`, `tests/navigation-ui.mjs` (adjust selectors only where the old pills/Menu text are asserted)

**Interfaces:**
- Consumes: Task 1 sprite + `.icon-btn`.
- Produces: `#uxHeader` (phone header; on desktop the existing context bar stays), `#uxHeaderDomain` (button: domain name + chevron, opens the existing sheet via `toggleSheet()`), `#uxHeaderAction` (page action slot; pages call `window.LocalAIShell.setAction({icon, label, onClick})` / `clearAction()`), `#uxSearchBtn`, existing `#uxInboxBtn` (now icon + count), `#uxPageStrip` (underline tabs; links with `aria-current="page"`), `#uxMobileNav` (flush tab bar, sprite icons). Home shows the brand mark + greeting instead of the domain button.
- Produces in `app/public/view-registry.js`: an `icon` field on each `DOMAINS` entry naming its sprite symbol (`home`, `workspace`, `automate`, `build`, `system`). The tab bar and header read the label and icon only from `DOMAINS` (no hard-coded names), so the roadmap's sub-project 2 relabels the tab bar by editing the registry.

- [ ] **Step 1: Failing tests** in `tests/mobile-ui.mjs` at 390×844 for every view: header height ≤ 56; `#uxPageStrip` height ≤ 44 and its links have no pill background; first visible content element of the active view starts ≤ 120 px from the top; `#uxMobileNav` bottom == viewport height (± 1) and it has 5 items with `svg use` icons; no visible `.view.active .topbar h1`; each tab-bar item's `use` href equals `#i-` + its domain's `icon` from `LocalAIViews.DOMAINS`; Inbox bell has `aria-label` containing the count. Review Focus 1: at 320×640 on Build the strip scrolls, the active tab is fully visible, no page overflow. Review Focus 2: toggling Developer tools off leaves 4 tab-bar items of equal width.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; Health registers its refresh via `LocalAIShell.setAction` (the old "Check again" stays in DOM for desktop).
- [ ] **Step 4: Run** all browser suites + `npm test` — PASS; phone screenshots of 5 pages compared against the mockups' header/tabs/tab bar.
- [ ] **Step 5: Commit + PR** "Phone shell: one header, underline tabs, flush tab bar".

### Task 3: Home and Chat — superseded (see scope change)

**Files:** `app/public/index.html` (`#home`, `#ask` markup additions), `app/public/app.js` (only where the chat empty state / phase text / web toggle are rendered), `app/public/ui.js` (Home "Needs you" + "Recent" phone sections), `app/public/app.css`; Test: `tests/mobile-ui.mjs`, `tests/navigation-ui.mjs`.

**Interfaces:** Consumes Tasks 1–2. Produces: `#homeNeedsYou` (list-group of pending changes / broken core service / pending approvals from data Home already loads), `#homeRecentGrid`, `#chatModelChip`, `#chatWebToggle` (button `aria-pressed`, mirrors and drives the existing `#webSearch` checkbox, which becomes visually hidden), chat empty state `#chatEmpty` with three starter buttons that fill `#chatInput`.

- [ ] **Step 1: Failing tests** (390×844): Home shows `What should we do?` composer, ≤ 1 row of suggestion chips, `#homeNeedsYou` lists pending changes when `/api/changes` has pending > 0 (stub the API), no capability tiles/execution map visible on phones; Chat empty state does not overlap `#chatInput`'s composer (bounding boxes), `#chatWebToggle` toggles `#webSearch.checked`, phase text hidden when idle; Review Focus 4: with the visual viewport reduced to 844−300, `#chatInput` stays within it; Review Focus 5: fresh DATA_DIR renders Home/Chat empty states cleanly.
- [ ] **Step 2–4:** fail → implement to the mockups (Main, Chat) → pass all suites.
- [ ] **Step 5: Commit + PR** "Home and Chat: phone redesign".

### Task 4: Change requests and Missions — superseded (see scope change)

**Files:** `app/public/index.html` (`#changes`, `#agents` form markup), `app/public/app.js` (ledger/runs rendering → list rows + `badgeHtml`), `app/public/ui.js` (mission "Last mission" card in the agent-specialists/agent-world sections), `app/public/app.css`; Test: `tests/mobile-ui.mjs`, `tests/agent-operations-ui.mjs`.

**Interfaces:** Consumes `badgeHtml`. Produces `#changesBanner` (shown when pending > 0; action filters `#changeList` to reviewable items), settings rows wrapping `#engineeringTarget` and `#engineeringAttempts`, `#missionLastCard`.

- [ ] **Step 1: Failing tests:** `#engineeringTarget` shows a non-empty selected label on iOS-like rendering (its value text visible — the blank-select bug); banner visible with the pending count when stubbed pending = 11; ledger rows show plain-language badges (no `needs_attention` text anywhere visible); mission placeholder `font-weight` = 400 and smaller than the old bold; `#missionLastCard` renders the latest mission from `/api/agents/missions` stub; Review Focus 5 empty states.
- [ ] **Step 2–4:** fail → implement to the mockups (Changes, Missions) → pass all suites.
- [ ] **Step 5: Commit + PR** "Change requests and Missions: phone redesign".

### Task 5: Health and the System pages — superseded (see scope change)

**Files:** `app/public/index.html` (`#status`), `app/public/app.js` (`serviceList` rendering), `app/public/ui.js` (Developer tools switch in first-run section; Models, Integrations, Runs list rows; Audit log rows), `app/public/app.css`; Test: `tests/mobile-ui.mjs`, `tests/first-run-ui.mjs`, `tests/models-ui.mjs`, `tests/integration-hub-ui.mjs`.

**Interfaces:** Produces `#healthSummary` (ring + verdict), core/optional list groups, `#devToolsSwitch` (`role="switch"`, `aria-checked`, drives the existing preference; the old checkbox id keeps working for first-run tests or the tests are updated).

- [ ] **Step 1: Failing tests:** summary verdict names the broken core service when one is DOWN (stub `/api/status`); core and optional groups separate; switch toggles Build in the tab bar; Runs rows show `Failed` badges for failed runs and a filter for Failed; Review Focus 5.
- [ ] **Step 2–4:** fail → implement (Health mockup; patterns for Models/Integrations/Runs/Audit log) → pass.
- [ ] **Step 5: Commit + PR** "Health and System pages: phone redesign".

### Task 6: Remaining pages — superseded (see scope change)

**Files:** `app/public/index.html`, `app/public/app.js`, `app/public/ui.js`, `app/public/app.css` for Images, Library, Projects/Sources/Memory, Inbox/Approvals, Automations, n8n, Browser & computer, Monitors, Issues/Quality, Claude Code, Files, Repository, PowerShell; Test: `tests/mobile-ui.mjs` + the page suites.

- [ ] **Step 1: Failing tests:** for each of these pages at 390×844 — no visible label-above-select fields (selects sit in `.settings-row`), lists use `.list-row`, page-level single actions are in `#uxHeaderAction`, axe `color-contrast`/`target-size` clean (axe-core 4.10.2 loaded from `node_modules` if added as devDependency, else from the vendored file in `tests/vendor/axe.min.js`).
- [ ] **Step 2–4:** fail → implement with the shared components → pass all suites; screenshot pass of all 26 pages.
- [ ] **Step 5: Commit + PR** "Remaining pages: phone redesign".

### Task 7: Desktop adoption — superseded (see scope change)

**Files:** `app/public/app.css`, `app/public/ui.js` (rail + section list icons from the sprite); Test: `tests/navigation-ui.mjs`, `tests/design-system-ui.mjs`.

- [ ] **Step 1: Failing tests** at 1440×900: rail items use sprite icons; status badges and list rows render with the component classes on Change requests, Runs, Health; page titles still visible; no layout change (rail width and section list width unchanged).
- [ ] **Step 2–4:** fail → implement → pass all suites (+ desktop screenshots of 6 key pages).
- [ ] **Step 5: Commit + PR** "Desktop: adopt the redesigned components and icons".

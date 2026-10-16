# Local AI on the web: a full critique (16 October 2026)

**What this is.** A product and quality review of the web app as it runs on the appliance (2.0.401), on desktop
(1440, 1280, 1024 px) and phone (390 px). Evidence: screenshots of all 31 pages at both sizes, scripted clicks
through the main flows, the live API, and the code. It records what was fixed today, what is still wrong, why it
matters to the owner, and the decisions only the owner can make. The plan that follows from it is
`docs/superpowers/plans/2026-10-16-web-polish.md`.

**Verdict.** The app is sound: no script errors, no failed requests, no sideways scrolling on any page, navigation
and Back behave, every control is tappable, the test suites (447 unit, 41 browser) pass on a fresh server. What
lets it down is **trust in what it shows**: stale or wrong data presented as current, developer notes shown as user
copy, and old records that newer code no longer creates but still displays. Most of the serious cases were fixed
today; what remains is listed by severity below.

## 1. What is good

- **One design language.** Pages share tokens, components, icons and spacing; dark theme is consistent.
- **Navigation works everywhere.** Rail, side menu, phone tabs, ⌘K search, Back (including closing sheets), deep
  links to runs.
- **Honest offline behaviour (new today).** A phone that can't reach Local AI shows "You're looking at a saved copy
  from…" and reloads by itself when it can.
- **Accessibility baseline.** Axe passes on every page at both sizes; 44 px targets everywhere; headings get focus
  after navigation (now without a visible box).
- **Testing culture.** 41 browser suites and 447 unit tests, run locally before every merge now that GitHub Actions
  is off; visual baselines for key pages; a queue so runs don't fight for the machine.

## 2. Fixed today (so the baseline is clear)

| PR | Problem the owner saw | Fix |
|---|---|---|
| #195 | 13 browser suites never passed locally | Mission stream opens only on Missions; three tests could see their requests again |
| #196, #204 | No PR checks since Actions stopped | `npm run ci -- <PR>` posts a `local-ci` status; runs queue one at a time; clean stop |
| #197, #203 | Small tap targets | Every control ≥ 44 px, test keeps it so |
| #199, #214 | Random test failures | Timing-tolerant tests; pairing tie-break bug (a real bug) fixed |
| #201 | Phone showed a day-old app as current | Saved-copy banner, build check, honest Health |
| #205 | Back left Improve instead of closing a sheet | `sheetHistory` on both Improve sheets |
| #207 | Health "Last deployment check: Sep 28" | Shows the running release's passed checks |
| #208 | Inbox: "Automatic update … failed … RemoteException ×2" for 21 h | Real cause shown; resolved once a later update ships |
| #209 | Focus box on titles; Claude Code half-width; empty Library boxes; Health card touching; "Details" | All polished |
| #210 | Shipped: 100+ items under "Earlier" | Grouped by release, older ones folded, ✓ icons |
| #211 | Integrations/Sources/Memory read like design notes; Audit log wall of restarts | Plain words; restarts folded |
| #212 | Failed changes said "Changes are being prepared"; garbled titles | Preview only in flight; one-time text repair |
| #206 | No user or admin guide | `docs/USER-GUIDE.md`, `docs/ADMIN-GUIDE.md` |
| #213 (queued) | Health rows all "Core capability is ready. 3038 ms"; PowerShell looked usable while locked | Each row says what the service does; locked means disabled |

## 3. What is still wrong, by severity

### 3.1 Important: the owner is misled or blocked

1. **Developer pages sit in the main menu for everyone.** System › Tools lists Files, Repository, PowerShell and
   Browser & computer regardless of the developer-tools switch; the switch hides only Improve and "Change Local AI"
   (`app.css:1257`). A home user meets a PowerShell console, a repo inspector and a raw JSON batch editor.
   *Decision needed (§5).*
2. **Browser & computer is a developer screen.** Default content is a raw JSON batch stamped "Created by Local AI
   v1.6" (stale); subtitle "Permissioned local actions. No unrestricted shell and no Docker socket exposure"; on a
   phone the JSON is clipped and the URL field shows "https://example.co". (`index.html` `#actions`.)
3. **Old records with wrong text remain in Work.** 2 of the last 65 runs have titles missing their first letters
   ("om the supplied source…"); the lost text is not stored anywhere, so no repair is possible. 3 of 15 image runs
   carry the old "1 704 × 1024 image…" summary where the count reads as a width; those are repairable from the run's
   output. *Decision needed on the two cut-off titles (§5).*
4. **Merges happen before the check is green.** Three PRs today (#205, #210, #211) were merged while `local-ci`
   was pending or red. #211's red was a real bug elsewhere (#214), so nothing broke, but the process relies on
   luck. GitHub can require the `local-ci` status before merging. *Decision needed (§5).*
5. **The Mac's own browser doesn't trust the appliance.** `https://10.0.0.21` warns on this Mac because the current
   Caddy root (fingerprint `20EB…ABE7`) isn't in the keychain; an older Caddy root is. Notifications and the
   Home-Screen app depend on it. Needs the owner's password; commands were given.

### 3.2 Moderate: rough edges a home user notices

6. **Phone headers leave a pill stranded.** On Inbox ("1 unread"), Approvals ("0 pending"), Files ("Backs up before
   saving"), Browser, PowerShell and Models the page title moves into the app header and the pill beside it is left
   on a line of its own above the tabs. Seven pages use a `.topbar > .pill`.
7. **Models.** Model names truncate ("qwen3:4b-ins…") so the 32k/16k/8k variants look identical; "Live / Runtime
   detail" means nothing to a user (`ui.js:549`); "Unload target" uses `toLocaleString()` (`ui.js:191`), a different
   date format from the rest of the app.
8. **Health copy.** Subtitle "Core appliance health and optional companion availability are reported separately";
   the Capabilities card repeats it; "Last deployment check" still says "Run on the host before each release"
   although since #207 it reflects every update.
9. **Projects.** With one project the page still says "Select a project." and "1 sources".
10. **Claude Code chips show raw ids** ("LocalAI-sp4 · Claude Code · 76278f59"); Activity shows four identical
    "New request" rows. The titles come from sessions; the board should present them, not echo them.
11. **PowerShell** "Execution history" card has no empty-state text on phone. **Monitors** says "operational brief"
    where the button says "Generate brief" and the feature is the morning brief.
12. **Files** gives `.zip`, `.whl` and images the pencil (edit) icon; the workspace field placeholder is "projects
    or repos".
13. **Work on a phone loads 60 rows** (`work.js` `PAGE=60`) before "Show more": a 9,000 px page. 20 would do on a
    phone.

### 3.3 Minor and structural

14. **Hidden legacy pages** (`ask`, `create`, `agents`, `runs`, `issues`, `quality`, `changes`) are still served and
    reachable by link or old bookmark. Nothing in `app/public/*.js` calls `showView()` on them any more. They carry
    older styling and copy and are not in any sweep. Either retire them (registry `ALIASES`) or keep testing them.
15. **Release notes = PR titles.** Good rule, but today's titles are long sentences; What's new reads better with
    one short clause each (see #202's title for a good example, #213's for a long one).
16. **Visual baselines are macOS-only.** On Linux CI they'd be created fresh and pass with a note; fine while CI is
    local, worth knowing when Actions returns.
17. **Two copies of the mission stream** live in `ui.js` (specialists panel and Agent World). Both were patched
    identically today; one shared instance would be safer.

## 4. Process notes

- **Keep both sides when merging `main` into a branch.** Two of this week's merges resolved conflicts by taking
  `main`'s side and silently dropped Tasks 2–3 of Ask Local AI (#174, #175). Recovered in #176.
- **Test what the owner sees, not just an empty server.** The empty test server never renders Library pin/delete
  buttons, Work's long titles, Shipped's 100 items or the Inbox's stale alert. The tap-target test now says to run
  it against the appliance too; the same applies to visual and copy reviews.
- **Flakes were real bugs twice today** (#214 pairing tie, #199's stuck-answer race). Treat a red check as
  information, not noise.

## 5. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Should Files, Repository, PowerShell and Browser & computer be hidden unless developer tools are on? | Yes: same switch, same CSS rule. Health, Models, Integrations, Automations, Monitors, Claude Code and Audit log stay. |
| D2 | The two Work runs with cut-off titles ("om the supplied source…", "…"): delete, or leave? | Delete them; the text can't be recovered. |
| D3 | Require a green `local-ci` before merging (GitHub branch protection on `main`)? | Yes. It applies to Claude sessions too. |
| D4 | Retire the hidden legacy pages now, or keep them until the next redesign pass? | Retire `issues`, `quality`, `changes`, `runs` now (their data has new homes); keep `ask`, `create`, `agents` until their replacements are complete. |
| D5 | Trust the new certificate on this Mac (needs your password). | Run the three commands from the earlier message. |

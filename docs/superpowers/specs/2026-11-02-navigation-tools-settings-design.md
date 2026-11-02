# Navigation: tools, settings and two overflowing strips

Date: 2026-11-02. Status: approved by the owner ("approve", 2 Nov 2026), D1-D4 as recommended. Amends `2026-10-17-navigation-structure-design.md`
(five areas, one page strip).

## What the walk-through found (live 2.0.1187, `9054281`; desktop 1440 px, phone 390 px)

The site has 33 views (`app/public/view-registry.js`): 5 areas, 17 visible pages or tabs, 6 developer tools and
5 views with no menu entry of their own. Ranked by how often the owner trips over them:

1. **Tools are three levels down and behind a switch.** Architecture, Files, Repository, PowerShell, Browser &
   computer and n8n appear only when "Show developer tools" is on. That switch sits at the bottom of Health. Then
   they appear under System › Advanced, as a second strip below the first. Opening the System Atlas takes a switch,
   then System, then Advanced, then Architecture. On the phone, that second strip pushes PowerShell off-screen. The
   17 Oct design rejected exactly this for Improve (N1): Local AI has one user, so hiding the owner's own tools
   from them protects no one.
2. **Health is also the settings page.** Of its nine cards, only three are about health: Appliance, Last
   deployment check and Services. The rest are settings or history: Notifications (allow), Sign-in (report only),
   Show developer tools, Home location, and What's new. What's new lists releases, which Improve › Shipped also
   does ("What changed, release by release"). To change a setting you have to know it lives under Health.
3. **Two strips overflow on the phone again.** The 17 Oct design fixed this, and it came back as pages were added.
   Projects has 6 tabs (Spreadsheets and Print lab are off-screen). Improve has 6 (Signals and Claude Code are
   off-screen), since Deployments was added after 17 Oct.
4. **Projects mixes your work with other machines.** Projects, Sources, Memory and Library are what you keep.
   Spreadsheets sends a request to GridCraft on the Windows computer. Print lab shows Pi Hub's print lab, whose
   items already reach Home › Needs you (for example "E-025: Judge the print"), and Pi Hub has its own lab page.
5. **"What needs me" disagrees with itself.** Home says "Needs you · 2". The header says "Inbox 24". On desktop,
   Home's header has no Inbox button at all, while every other page shows one. The 17 Oct design asked for one
   fixed header with the bell in the same place on every page.

What already works and stays: the five areas and the phone bar, Home's composer (with its Image mode), ⌘K, Work's
chips for Missions and Runs, and old addresses resolving through `ALIASES`.

## Proposal

| | Today | Proposed |
|---|---|---|
| System strip | Health · Models · Services · Audit log · Advanced (+ 6-tab second strip) | Health · Models · Services · **Tools** · **Settings** · Audit log |
| Tools | 6 pages behind a switch and a second strip | One **Tools** page, always shown, with one card per tool. Each card opens the tool at its existing address. No second strip and no switch |
| Architecture | System › Advanced › Architecture | **Improve › Architecture**: understanding the code sits beside changing it. Also a card on Tools |
| Settings | Spread across Health | **System › Settings**: Notifications, Sign-in, Home location. "Show developer tools" is removed |
| What's new | A Health card | Moves into **Improve › Shipped**, which already lists releases. The "Updated to …" toast links there |
| Improve strip | Backlog · In progress · Deployments · Shipped · Signals · Claude Code (6) | Backlog · In progress · Shipped · Signals · Claude Code · Architecture (6). Deployments merges into Shipped, so each release shows its evidence |
| Projects strip | Projects · Sources · Memory · Library · Spreadsheets · Print lab (6) | Projects · Sources · Memory · Library (4) |
| Spreadsheets | A Projects tab | A Work kind: a chip in Work, plus a composer mode beside Image ("Spreadsheet ▾"). Its page keeps its address |
| Print lab | A Projects tab | A card on Home's Pi Hub row that opens Pi Hub's lab page. Its items keep arriving in Needs you. `#printLab` resolves to Home |
| Inbox | Missing from Home's header on desktop; its count differs from Needs you | The bell sits in the same place on every page. Its badge counts what needs you; the Inbox lists history, with no badge of its own |

The Improve strip still has six tabs. To keep it from overflowing the phone, the strip uses the labels Backlog,
Doing, Shipped, Signals, Claude, Atlas (`tab` labels only; page names unchanged). Without that, Architecture
stays on Tools only. The owner chooses (decision D3).

## Decisions for the owner

- **D1. Tools always shown, switch removed** (recommended). Alternative: keep the switch but move it to Settings.
- **D2. Settings becomes a System tab** (recommended). Alternative: a Settings sheet from the avatar/header.
- **D3. Architecture in Improve with short tab labels** (recommended). Alternative: Architecture only on Tools.
- **D4. Spreadsheets becomes a Work kind and Print lab moves out to Pi Hub** (recommended). Alternative: keep both
  tabs and let the Projects strip scroll.

## Delivery (after approval)

Registry edits first (N4: no element ids change; old ids stay as aliases), each its own PR shipped with
`npm run ship`:

1. Settings page and Health trimmed back to health; What's new into Shipped.
2. Tools page and the developer-tools switch removed; Architecture added to Improve.
3. Projects strip down to four: Spreadsheets as a Work kind and composer mode; Print lab to Home's Pi Hub row.
4. Deployments merged into Shipped; the bell fixed on every page with one count.

Each PR updates the navigation, router, mobile, first-run and visual suites it touches, and regenerates visual
baselines only for pages whose navigation changed.

## Acceptance

- On a 390 px phone, no page strip has a tab off-screen.
- Every tool and setting is reachable in at most two taps from the bar, with no switch to find first.
- Health shows only health. The bell and its count are the same on every page and match Needs you.
- Every old address (`#architecture`, `#printLab`, `#spreadsheets`, `#deployments`, …) still opens what replaced it.

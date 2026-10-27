# Using Local AI

Local AI is your own AI assistant, running on your computer at home. Everything runs on that computer unless
you switch on cloud models (Models page): then only work that isn't private (research on public topics, code
changes to Local AI, a chat you send with "Use a bigger model") may go to Groq or Cerebras, and every answer says
which model gave it. House questions, voice, files, photos and anything about health, money or identity always stay
on the computer. This guide covers everyday use on a phone or a computer. Setting it up
and looking after it is in the [admin guide](ADMIN-GUIDE.md).

## Open it

- **On a computer at home:** `https://10.0.0.21`.
- **On an iPhone:** open `https://10.0.0.21` in Safari, then Share › **Add to Home Screen**. Open Local AI from the
  Home Screen icon from then on: notifications only work there. The first time, the phone has to trust Local AI's
  certificate; **Health › Secure connection** walks you through it.
- **Away from home:** only if Tailscale is set up (see the admin guide). Otherwise Local AI is reachable on your home
  network only.

If the phone can't reach Local AI, a banner at the top says **"Can't reach Local AI. You're looking at a saved copy
from …"**. What you see is the last copy the phone kept; nothing on it is current. Local AI reloads by itself once it
can be reached again, or tap **Try again**.

## Find your way around

There are five sections. On a phone they are the tabs at the bottom; on a computer they are on the left.

| Section | What it's for |
|---|---|
| **Home** | Start something, see what needs you, pick up where you left off |
| **Work** | Everything that is running or done (chats, images, missions, changes), and **Automations**, what runs on a schedule |
| **Projects** | What you make and keep: your projects with their Sources and Memory, your **Library**, **Spreadsheets** and the **Print lab** |
| **Improve** | Changing Local AI itself: ideas, problems it noticed, changes in progress, what shipped |
| **System** | Health, models, services and the audit log (and the developer tools, when they are on) |

To jump anywhere, press **⌘K** on a computer or tap the **magnifier** on a phone, then type a page name. If no page
matches, **Search your work for …** looks through your chats, images and runs.

The **Back** button behaves as you'd expect: it closes an open sheet first, then goes to the previous page.

## Home: ask for something

Type in the box at the bottom of Home and send. The chip next to it picks what kind of request it is:

| Choice | What happens |
|---|---|
| **Auto** | Local AI picks the best fit for you |
| **Chat** | A conversation with your local models |
| **Research** | Searches the web first, then answers with its sources |
| **Image** | Makes a picture |
| **Mission** | Gives a goal to a team of specialist agents that work on it together |
| **Automate** | Sets up a task that runs on a schedule |
| **Change Local AI** | Asks for a change to Local AI itself (shown only with developer tools on; see Improve) |

What you send opens where you are and keeps running if you leave; it is always in **Work**.

### Cloud models: where an answer comes from

Everything runs on this computer until you switch on **Use cloud models for work that isn't private** under
**System › Models › Cloud models**. That card also lists each cloud service (Groq, Cerebras): whether its key is set,
how many times it was used today, its last problem, and "Resting until …" when it reached its free limit. Below them,
**What runs where** shows each kind of work and where it may run. Keys live in `stack.env` on the PC; the page only
says whether one is set. Changing the switch needs a signed-in device.

With cloud models on, two toggles appear under the box on Home (for Chat, Research and Auto):

- **Use a bigger model**: send this chat to a cloud model if it isn't private. A plain chat stays on this computer
  without it.
- **Keep on this PC**: this request stays on this computer, whatever it is.

They apply to the next thing you send, then switch off again. Anything about health, money or identity, House
questions, voice, files and photos, your workspace and documents, and questions about Local AI's own keys or setup
always stay on this computer. Research, change plans for Local AI's own code and mission summaries may use a cloud
model when nothing in them is private. If a cloud model is busy or fails, this computer answers instead.

Every answer says where it came from: **Answered by GPT-OSS 120B · Groq** or **Answered on this PC**, with the
reason, under the answer and on its card in Work. Each cloud call is listed in the Audit log (which service, which
model, how much text; never the text itself).

Ask the chat about Local AI itself (where image models go, how to reach it away from home, how updates work, where a
page is) and it answers from this appliance's own setup: its addresses, its folders and its page names.

**Needs you**, near the top of Home, lists what is waiting for you: approvals, runs that failed in the last day,
services that are down, and new Signals. Tap one to deal with it. An approval opens in a sheet over Home with
everything it will do, and **Approve** or **Reject** right there; you stay on Home. While the 3D printer is printing,
paused or stopped with an error, one line about it sits just above.

Approvals, fixes and setup steps always show. Failed runs fill Needs you up to three rows, newest first, and the rest
wait behind **See all**, which opens Work's **Needs you** filter. Repeated failures of the same goal are one row
("Failed ×5"). A failure leaves Needs you once you open it (on any device), a
day after it failed, or when you retry it or run the same goal again (if that fails too, the new failure shows
instead); it always stays in Work. Approvals stay until you decide them.

Needs you also lists the rest of the house's one list, the same items in the same words as Pi Hub, the wall and the
Workshop display: the printer ("Clear the plate"), the Pi, the print lab ("Judge E-022") and Local AI's own warnings
("Worth a look"). They are in the same order, problems first, then what is waiting on you, then things worth a look.
A printer or Pi item opens on Pi Hub; a lab item opens Projects › Print lab; a warning opens Health. When Pi Hub isn't
answering, Needs you shows only Local AI's own rows.

## Images

Pick **Image** on Home (or open **Images** with ⌘K) and describe the picture. Three engines run on the computer's own
GPU: **Fast** (about 15 seconds), **Quality** (about a minute) and **Best** (Z-Image Turbo, the most detailed, about
4 minutes for a full 1024 px picture on a 6 GB graphics card). Each engine shows the time it last took on this
computer.

**Best starts with a quick preview.** A Best image is first drawn small (512 × 512, or the chosen shape scaled to fit
576 px) in fewer steps, in about a minute, and shows with a **Preview** tag. If you like it, tap **Make the full
picture** under it; it says how long that takes here (about 4 minutes until it has been measured). The full picture
uses the same seed and prompt, so it is the preview's picture, larger and with finer detail. If you don't like the
preview, change the prompt or tap **Another version** instead, and you have saved the 4 minutes. To skip the preview
and always go straight to the full picture, turn off **Best: show a quick preview first** on the Images page (it is
on by default and remembered on each device). Fast and Quality never preview; they are quick already. Neither do
several images at once, edits, or a model picked under **Advanced**.

Previews and full pictures are both in **Work** (as versions of one image), but only full pictures arrive in
**Library**. To keep a preview there too, tap **Keep preview** under it; tap it again to take it out.

## Work: everything running and done

Work lists every run, newest first, grouped by day. Filter it with **All**, **Chats**, **Images**, **Missions**,
**Changes** and **Other**, or search it.

Tap a row to open it. A chat opens as the conversation, with a reply box at the bottom. While something runs you can
watch it live and cancel it; a failed run offers **Retry**. A run's header names its kind, and the project once you
file it there (**Details › File…**).

Chats and research stay here, in Work, and nowhere else unless you keep them. To keep one in your **Library**, tap
**☆ Keep** in the open chat, or the ☆ on its row in Work; it turns to ★ **Kept**, and the whole conversation is one
Library item that later replies update. Tap it again to take it out of Library; it stays in Work.

**Missions** is the history of every mission, however you started it, each listed once; tap one to open it in Agent
World.

A mission goal that asks to change Local AI itself (in Agent World or Home) offers **Hand to Claude** first, since
Claude Code reviews the code and opens a tested pull request; **Start a mission anyway** still starts it.

### Watch mode

Agent World can be a screen you leave on, such as a TV or a spare tablet. In Agent World, open **⋯ › Watch mode**.

- The city fills the screen and follows whoever is working.
- A caption at the bottom says what the team is doing.
- When nothing is running, the last mission replays every 2 minutes.
- A soft chime marks a mission starting, finishing or needing you. **Sound on** turns it off.
- The screen stays awake.
- The pointer hides when you don't move it.

**Exit watch mode** or Esc goes back. For a screen that should start in watch mode, open
`https://10.0.0.21/?open=agents&watch=1`. It starts without full screen, because a browser only allows full screen
after a tap, but the city still fills the window.

## Projects: what you keep

The Projects tab opens on your projects. Its tabs:

- **Projects:** group related work, each with its own sources and memory.
- **Sources:** files and notes the assistant can search when it answers.
- **Memory:** facts the assistant keeps about each project.
- **Library**: what you kept. Chats and research arrive only when you tap **☆ Keep** on them (in the open chat or
  on their row in Work); images you make arrive by themselves (a Best quick preview only when you keep it). Conversations and research are a list, newest first,
  and images are pictures after them. Filter by kind, or show only what you **pinned**. ☆ pins an item. × takes a
  chat out of Library (it stays in Work) and deletes an image. Work is everything you did; this is what you kept.
  Old Library links open this tab.

  Before 18 October every chat landed in Library by itself. The chats you had not pinned or filed in a project were
  moved out once, on the first start after the update (the Audit log says how many); they are all still in Work,
  and you can keep any of them again.

## Deleting things

- **In Work:** choose **Select**, tick the rows, then **Delete (n)**. Or open a run, choose **Details**, then **Delete**.
  Deleting a chat removes the whole conversation (every turn) and its Library copy.
- **In Library:** × deletes a picture or a note. For a kept chat, × only takes it out of Library; it stays in Work.
- **In Projects:** **Delete project** on the project's page. Its chats, sources and memories stay, under no project.

Each delete shows **Undo** for 10 seconds. After a day, deleted things are gone for good. Something that is still
running can't be deleted: stop it first. Pictures are removed from Local AI, but the image files stay in ComfyUI's
output folder on the Windows computer.

## Improve: change Local AI itself

Improve is one list of everything that could change in Local AI, from your ideas, problems Local AI noticed, and
findings from Claude Code sessions.

- **Backlog:** the ranked list. Vote items up or down, or open one to **Start** it, **Hand to Claude**,
  **Move to top**, **Defer** or **Reject**. **New idea** adds your own; choose **Add to backlog**, **Hand to Claude**
  or **Start now**. Anything handed to Claude waits in **In progress** for the next Claude Code session.
- **Signals:** problems Local AI noticed on its own. Serious ones (high severity, or seen three or more times) join
  the Backlog by themselves; **Promote** adds any other, **Dismiss** drops it.
- **In progress:** changes being planned, tested or waiting for your OK. Open one for its next step:
  **Test the change**, **Approve** (after a confirmation), or **Retry** if it failed. **See the changes** shows the
  difference. **Back to backlog** or **Discard** stops it.
- **Shipped:** what changed, release by release, with a link to each change.

## Approvals and alerts

Some actions wait for your OK before they change anything: scripts on the Windows computer, file edits, applying a
change. You decide them in **Needs you** on Home: tap one, read what it will do, then **Approve** or **Reject**.

The **Inbox** (the bell at the top) is the history. Approvals still waiting are listed first, and **Review** opens the same
sheet. After them come open alerts, then **History**: resolved alerts and what you approved or rejected, newest first.
It keeps alerts you missed while notifications were quiet. The bell shows one number: unread alerts plus approvals
waiting. Old Approvals links open the Inbox.

## Print lab
**Projects › Print lab** shows the 3D-print lab that runs on the Mac (the print-lab repo): what needs you (a print to
judge, a test to approve) with the command to run on the Mac and a Copy button, the open question's time and material
budget, and every experiment with what was asked and what actually printed, the outcome, and the photos. It is
read-only: the Mac sends it (`lab sync`, after every `lab` command) and stays the record; verdicts and approvals are
made on the Mac.

## Spreadsheets
**Projects › Spreadsheets** shows the workbook open in GridCraft on the Windows computer and asks GridCraft to check or
change it. Pick a sheet tab to see its cells; tap a cell for its value and formula, and **Ask about this cell** to put its
address in your request. **Show formulas** shows formula text in the grid. Long sheets page by 100 rows.

To work on another workbook, choose it in the menu next to the workbook's name. It lists the spreadsheet files in the
GridCraft folder on the Windows computer (`Documents\GridCraft`). If the open workbook has unsaved changes, the page asks
first. While a Review request is waiting, keep or discard it before opening another workbook.

Type what you want or tap an example, choose what the request may do, then **Run**:

- **Read only**: it looks and answers, and cannot change anything.
- **Review** (the default): it makes the changes in GridCraft without saving. The answer lists every changed cell,
  before and after, and the grid marks them in amber. **Keep changes** saves the workbook; **Discard** undoes them.
  Only the latest request can be undone, and Discard refuses if someone changed the workbook in GridCraft since.
- **Apply**: it makes the changes and saves the workbook.

To change a cell yourself, select it, then tap or click it again (or double-click it, or press Enter or F2, or just
start typing). Type a value or a formula starting with `=`; **Enter** puts it in, **Esc** cancels. On a phone, **Change
this cell** opens a small sheet with the cell's value and formula; **Save** puts it in. Your changes go through Review,
whatever mode is chosen: they show in amber, are listed under **Direct edit** in the requests, and nothing is saved
until you choose **Keep changes**; **Discard** undoes them. Changes made one after another are kept or discarded
together. **Read only** turns changing cells off, and while a request is running a change waits until it finishes.

A request takes from a few seconds to a few minutes, one at a time, and works from a phone too. **Earlier requests**
lists past ones with what each changed. The badge says whether GridCraft is ready; if a request fails, the answer says
why and **Try again** sends it once more.

## ArtCraft
**System › Services** has a card for ArtCraft, the image and video studio on the Windows computer. It says whether
ArtCraft is installed and open there; **Open on the Windows computer** starts it. ArtCraft makes pictures and video
through cloud services with your ArtCraft account, so what you type and the pictures you use leave your network and
what it makes stays in that account. For anything private, use **Images**, which stays on this computer.

**System › Services** also has a card for the Workshop display, the touchscreen beside the printer: it says whether
the display is answering and whether its page has its own sign-in, and **Open Workshop portal** opens the display's own
page. (Today's firmware has no sign-in; once the update is installed the card says "its own sign-in", and the portal
asks for the code shown on the display, System → Local Portal.) Away from home, Tailscale must be on
([Workshop display](WORKSHOP-DISPLAY.md)).

With the display's read-only status token set up ([Workshop display › Printer status](WORKSHOP-DISPLAY.md#printer-status-read-only-token)),
**Home** shows one line while a print runs or has stopped with an error, such as "Printer · 42% · 1 h 10 min left".
Tap it to open the Workshop display card. Nothing shows while the printer is idle or after you stopped a print
yourself (the card says "Printer · Print stopped"). When a print failed without saying why, the card says "Printer ·
Print ended — check the display". If the display hasn't given a fresh answer for about 2 minutes, Home's line goes
away rather than show old progress.

To sign in to the display's portal without walking to the touchscreen, set up its code key once
([Workshop display › Sign-in code](WORKSHOP-DISPLAY.md#sign-in-code-on-the-services-card)). The card then has **Show
sign-in code**: tap it to see the code in two groups of five, with **Copy** and **Open portal ↗**. It hides itself after
a minute or when you switch away. Anyone who can open Local AI can do the same, so only set it up while you are the one
using it.

## Automations

**Work › Automations** is one page for everything that runs by itself. Pick a **Kind**, then create it:

| Kind | What it does |
|---|---|
| **Prompt** | Asks your local model something, by hand or every hour or day |
| **Research** | Searches the web and summarises it with sources, on the same schedule |
| **Health check** | Checks every service every 15 minutes and tells you in the Inbox when one needs attention |
| **Morning brief** | **Generate brief** sums up health, open alerts and recent activity, right now |

Your automations and health checks are listed together; **Run now** runs one at once. **Open n8n ↗** opens n8n for
advanced workflows. Old Monitors links open this page.

## Notifications

On an iPhone, open Local AI from the Home Screen, then **System › Health › Notifications › Allow notifications**, and
**Send a test**. Choose which kinds you want (Needs you, Failed, Down and recovered, Finished) and your quiet hours.
During quiet hours (10 PM to 7 AM by default) only failures and outages get through.

## Ask by voice (Siri and Apple Watch)

"Ask Local AI" is a Siri Shortcut. Ask it the time, what needs you, whether Local AI is OK, the weather, today's news,
or have it start an image, research or a mission. Follow-ups such as "and tomorrow?" continue the conversation.
Approvals are never given by voice; they stay on the phone. Setup and everything you can say: [Apple Watch and
Siri](APPLE-WATCH.md).

For weather, set your home location in **System › Health › Home location**.

## Chat with Claude Code

**Improve › Claude Code** lets you message a Claude Code session running on the Mac, and watch it work. A phone has to
be paired first, once. See [Claude chat](CLAUDE-CHAT.md).

## Developer tools

**System › Health › Show developer tools** adds **Change Local AI** to Home's choices, and the developer pages
under System: **Files**, **Repository**, **PowerShell**, **Browser & computer** and **n8n workflows**. It also shows Models' runtime tile and Health's **Advanced service
details**. Off, all of these are hidden from the menu, the page strip and search; a page's address still opens it.
Everything else works the same. The setting is kept per device.

In a mission's start sheet, **Advanced › Workers' model** runs every worker on one installed model instead of **Automatic**; the team lead still picks its own.

## Glossary

Local AI uses one word for each thing, everywhere. If you meet one of the words in the last column, it is an old name
for the word in the first.

| Word | What it means | Instead of |
|---|---|---|
| **Run** | One thing Local AI does for you: a chat, research, an image, a mission, an automation or a change. Every run is in **Work**. | job, task, execution, attempt |
| **Mission** | A run where a team of specialist agents works on one goal. | agent operation |
| **Change** | A change to Local AI itself. It starts as an idea or a Signal and goes through **Improve**. | change request, finding, item, patch |
| **Service** | Something Local AI runs on or connects to, such as Ollama, ComfyUI, n8n or GridCraft. **System › Services** lists them. | companion, capability, integration, tool, bridge, extension |
| **Project** | A group of related work, with its own Sources and Memory. | workspace |
| **Source** | A file or note a project's assistant can look things up in. | knowledge source |
| **Kept** | What you kept from your work: **Projects › Library**. | artifact, library item |
| **Check again** | Asks every service how it is doing, now (Health, Services). | Refresh status, Recheck |
| **Run checks** | Looks for problems in Local AI now (Signals). | Run checks now, Scan now, Run quality scan |
| **Refresh** | Reloads a list. | Reload |

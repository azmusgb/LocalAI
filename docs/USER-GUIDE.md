# Using Local AI

Local AI is your own AI assistant, running on your computer at home. Nothing you type goes to an outside AI
service unless you choose a cloud fallback. This guide covers everyday use on a phone or a computer. Setting it up
and looking after it is in the [admin guide](ADMIN-GUIDE.md).

## Open it

- **On a computer at home:** `https://10.0.0.21`, or `http://10.0.0.21:3080`.
- **On an iPhone:** open `https://10.0.0.21` in Safari, then Share › **Add to Home Screen**. Open Local AI from the
  Home Screen icon from then on: notifications only work there. The first time, the phone has to trust Local AI's
  certificate; **Health › Secure connection** walks you through it.
- **Away from home:** only if Tailscale is set up (see the admin guide). Otherwise Local AI is reachable on your home
  network only.

If the phone can't reach Local AI, a banner at the top says **"Can't reach Local AI. You're looking at a saved copy
from …"**. What you see is the last copy the phone kept; nothing on it is current. Local AI reloads by itself once it
can be reached again, or tap **Try again**.

## Find your way around

There are up to five sections. On a phone they are the tabs at the bottom; on a computer they are on the left.
Improve appears only with developer tools on (see the end of this guide).

| Section | What it's for |
|---|---|
| **Home** | Start something, see what needs you, pick up where you left off |
| **Work** | Everything that is running or done: chats, images, missions, changes |
| **Projects** | What you keep: the Library, Projects, Sources and Memory |
| **Improve** | Changing Local AI itself: ideas, problems it noticed, changes in progress, what shipped |
| **System** | Health, models, integrations, automations, the audit log and tools |

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

**Needs you**, near the top of Home, lists what is waiting for you: approvals, runs that failed in the last day,
services that are down, and new Signals. Tap one to deal with it.

## Work: everything running and done

Work lists every run, newest first, grouped by day. Filter it with **All**, **Chats**, **Images**, **Missions**,
**Changes** and **Other**, or search it.

Tap a row to open it. A chat opens as the conversation, with a reply box at the bottom. While something runs you can
watch it live and cancel it; a failed run offers **Retry**.

## Projects: what you keep

- **Library:** everything you've made: conversations, research and images. Filter by kind, or show only what you
  **pinned**. ☆ pins an item; × deletes it.
- **Projects:** group related work, each with its own sources and memory.
- **Sources:** files and notes the assistant can search when it answers.
- **Memory:** facts the assistant keeps about each project.

## Improve: change Local AI itself

Improve is one list of everything that could change in Local AI, from your ideas, problems Local AI noticed, and
findings from Claude Code sessions. It is shown when **Show developer tools** is on.

- **Backlog:** the ranked list. Vote items up or down, or open one to **Start** it, **Hand to Claude**,
  **Move to top**, **Defer** or **Reject**. **+ New idea** adds your own; choose **Add to backlog** or **Start now**.
- **Signals:** problems Local AI noticed on its own. Serious ones (high severity, or seen three or more times) join
  the Backlog by themselves; **Promote** adds any other, **Dismiss** drops it.
- **In progress:** changes being planned, tested or waiting for your OK. Open one for its next step:
  **Test the change**, **Approve** (after a confirmation), or **Retry** if it failed. **See the changes** shows the
  difference. **Back to backlog** or **Discard** stops it.
- **Shipped:** what changed, release by release, with a link to each change.

## Approvals and alerts

Some actions wait for your OK before they change anything: scripts on the Windows computer, file edits, applying a
change. They appear in **Needs you** on Home and under **Inbox › Approvals**. **Inbox › Alerts** keeps every alert,
including ones you missed while notifications were quiet.

## Automations

**System › Automations** is one page for everything that runs by itself. Pick a **Kind**, then create it:

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

**System › Claude Code** lets you message a Claude Code session running on the Mac, and watch it work. A phone has to
be paired first, once. See [Claude chat](CLAUDE-CHAT.md).

## Developer tools

**System › Health › Show developer tools** adds the Improve section to the menu, **Change Local AI** to Home's
choices, and the developer pages under System: **Claude Code**, **Files**, **Repository**, **PowerShell**,
**Browser & computer** and **n8n workflows**. It also shows Models' runtime tile and Health's **Advanced service
details**. Off, all of these are hidden from the menu, the page strip and search; a page's address still opens it.
Everything else works the same. The setting is kept per device.

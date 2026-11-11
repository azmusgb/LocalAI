# Looking after Local AI

Short answers to "how do I…", for whoever runs the appliance. Each one points to the guide with the details. For
everyday use, see the [user guide](USER-GUIDE.md).

Local AI runs in Docker on the Windows computer at `10.0.0.81`. The app is on port 3080; HTTPS (`https://10.0.0.81`)
goes through Caddy on port 443.

## Is it healthy?

- **In the app:** System › Health shows each core service and the optional companions.
- **From any computer:** `curl -s https://10.0.0.81/healthz` (a computer that trusts the LocalAI certificate) returns the running `version` and `releaseCommit`.
- When core health changes and stays changed for 2 minutes, phones with notifications get **Down** / **Recovered**.
- **After a Windows restart** some services (n8n, search, HTTPS) can stay stopped. The next update check, within
  5 minutes, starts any stopped services again and the Inbox says "Restarted N Local AI services that were stopped".
  Details: [Deploy](DEPLOY.md#after-a-windows-restart).

Details and the troubleshooting index: [Operations](OPERATIONS.md).

## Update it

Merge a pull request into `main`. The host's **LocalAI Safe Deploy** task deploys it within about 5 minutes, checks
it, and rolls back by itself if the new build is unhealthy. Updates wait for running work: while a mission, an image,
a chat, a GridCraft request or an automation is running, the update waits for it, up to 45 minutes. After that it
updates anyway and the Inbox says what it stopped. It's live when `/healthz` reports the merge's commit as
`releaseCommit`. Each release's notes are the merged PR titles: **What's new** lists them, the first load after an
update says "Updated to …", and Improve › Shipped groups changes by release.

Manual deploys and rollback: [Deploy](DEPLOY.md).

## Check a change before merging (local CI)

There are no GitHub Actions workflows. Checks run on the Mac instead:

```sh
npm run ci -- <PR number>
```

It tests the PR merged with the latest `main` in a temporary checkout (syntax, unit tests, PowerShell and
deploy-candidate checks, and every browser suite against a fresh server, about 15 minutes), then posts a ✅ or ❌
**local-ci** check on the PR. Merge only on a green local-ci.

To test and merge in one step, use `npm run ship -- <PR number>` instead: it runs the same checks and merges the PR
only if they're green, and only the exact commit that was tested (if anything is pushed to the PR meanwhile, GitHub
refuses the merge). If another PR was merged into `main` while the checks ran, ship first re-runs the quick checks
(unit tests, size budgets, deploy contracts; a minute or two) on the PR combined with the newer `main`, and merges only
if those pass too. If they fail, it doesn't merge: the PR gets a ❌ "main moved; re-check failed" naming the failing
tests, and a comment. That is how two PRs that each passed on their own are kept from breaking `main` together.
GitHub can't *require* a green check on this account (that needs a paid plan for a private repository), so this is
the safe way to merge.

- A red is hard to miss: the ❌ status names the failed steps, and a comment on the PR names the failing unit
  tests (first ten) so you need not open the log. A red has been a real bug before; fix or explain it before merging.
- A browser suite that fails is run once more on its own. If it passes, the check is green but reads
  "All passed, 1 suite on retry: <suite>" and a comment names the suite, so a flake is on record rather than hidden.
  Unit tests are never retried. A title over 70 characters or with more than one clause gets a "Release note" comment
  (titles become release notes); it never turns the check red.
- One run at a time per machine. A second run waits, and its PR shows "Queued behind PR #N".
- Ctrl-C stops a run cleanly: the PR is marked "Stopped before it finished" and nothing is left running.

More: [Development › CI](DEVELOPMENT.md#ci).

## Old containers in Docker Desktop

Stopped containers named `local-ai-…-pre-compose`, `-pre-hostport` or `-pre-lockdown` are copies kept from earlier
migrations, for rollback. They never start on their own, and they are kept for 7 days and then removed automatically
once the live stack is healthy (volumes and data kept); the Inbox says "Removed 5 old backup containers (stopped
copies from earlier migrations)". `festive_turing` (Docker's tutorial) and `localai-agent-design-candidate` aren't
Local AI's; remove them by hand if you like: `docker rm festive_turing` and `docker rm localai-agent-design-candidate`.

**Never run `docker system prune --volumes` here.** It deletes volumes, and Caddy's certificate authority
(`localai-caddy-data`) and n8n's data live in volumes. Details: [Deploy › Old backup containers](DEPLOY.md#old-backup-containers).

## Back up and restore

The database is backed up nightly at 02:30, to the host and to OneDrive, and each copy is restore-tested; a failed
backup sends a **Failed** notification. How to take one by hand and how
to restore: [Operations › Backups](OPERATIONS.md#backups) and [Restore](OPERATIONS.md#restore). Database details:
[Storage](STORAGE.md).

## Set up a phone

1. Trust Local AI's certificate once: on the phone open `http://10.0.0.81/localai-ca.crt`, install it, then turn on
   full trust for it (iPhone: Settings › General › About › Certificate Trust Settings). **Health › Secure connection**
   shows whether it worked.
2. **One icon that works everywhere:** with Tailscale set up (see [Reach it away from home](#reach-it-away-from-home))
   and turned on on the phone, open the Tailscale address (`https://<computer>.<tailnet>.ts.net`; Health › Secure
   connection shows it) in Safari, Share › **Add to Home
   Screen**, and use that icon from then on. It works at home and away. An icon added from `https://10.0.0.81` works
   on the home Wi-Fi only; away from home its saved copy checks the Tailscale address and, if it answers, switches
   there after 2 s (**Cancel** stays put, then it offers **Open over Tailscale**). **Health › Secure connection** lists
   both addresses.
3. Notifications: from the Home Screen app, **System › Settings › Notifications › Allow notifications**. Notifications
   belong to the icon they were allowed from, so allow them again after switching icons.

HTTPS and the certificate: [Deploy › HTTPS with Caddy](DEPLOY.md#https-with-caddy).

## Reach it away from home

Install Tailscale on the Windows computer and the phone, sign both in to the same account, then re-run
`deploy\Install-LocalAI-HTTPS.ps1` (elevated). Nothing is opened to the internet; only devices on your Tailscale
network get in. The phone already trusts the Tailscale address's certificate (same Local AI certificate authority).

For one icon that works everywhere, add Local AI to the Home Screen from the Tailscale address (Health › Secure
connection shows it) and keep Tailscale on. If a phone opens the home address while away, Local AI can't be reached,
and the saved copy's banner offers **Open over Tailscale** ("Turn on Tailscale on this phone first"), from what the
phone saved on its last visit, with no network needed. Details: [Deploy › HTTPS with Caddy](DEPLOY.md#https-with-caddy).

## Pair a device for Claude Code chat

On the Mac that runs the Claude Code session:

| Command | Does |
|---|---|
| `localai-chat pair <code> [name]` | Pairs the device showing that code on Improve › Claude Code |
| `localai-chat devices` | Lists paired devices |
| `localai-chat revoke <id>` | Removes one |
| `localai-chat status` | Shows whether the bridge is running |

Details and troubleshooting: [Claude chat](CLAUDE-CHAT.md).

## Set up Siri and the Apple Watch

Build the "Ask Local AI" shortcut on the iPhone and set a home location for weather (System › Health › Home
location): [Apple Watch and Siri](APPLE-WATCH.md).

## A phone shows an old version

If Local AI can't be reached, the phone shows its saved copy with a banner saying so, and reloads by itself when
Local AI answers again. If there's no banner and the page is clearly old, the phone is on a copy from before the
banner existed: open it once while it can reach Local AI and it catches up. Check the certificate first if it can
never reach it (Health › Secure connection).

## Who can do what

Anything that changes the Windows computer, files or Local AI's own code waits for an approval in the app. Secrets
never go into the container, the repo or logs. The threat model and every control: [Security](SECURITY.md).

# Looking after Local AI

Short answers to "how do I…", for whoever runs the appliance. Each one points to the guide with the details. For
everyday use, see the [user guide](USER-GUIDE.md).

Local AI runs in Docker on the Windows computer at `10.0.0.21`. The app is on port 3080; HTTPS (`https://10.0.0.21`)
goes through Caddy on port 443.

## Is it healthy?

- **In the app:** System › Health shows each core service and the optional companions.
- **From any computer:** `curl -s http://10.0.0.21:3080/healthz` returns the running `version` and `releaseCommit`.
- When core health changes and stays changed for 2 minutes, phones with notifications get **Down** / **Recovered**.

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

GitHub Actions can't start jobs on this account (billing), so the `validate`, `storage` and `windows-contracts`
workflows are disabled. Checks run on the Mac instead:

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
- When GitHub billing works again: `gh workflow enable validate -R azmusgb/LocalAI` (and `storage`,
  `windows-contracts`).

More: [Development › CI](DEVELOPMENT.md#ci).

## Back up and restore

The database is backed up nightly at 02:30, to the host and to OneDrive, and each copy is restore-tested; a failed
backup sends a **Failed** notification. How to take one by hand and how
to restore: [Operations › Backups](OPERATIONS.md#backups) and [Restore](OPERATIONS.md#restore). Database details:
[Storage](STORAGE.md).

## Set up a phone

1. Trust Local AI's certificate once: on the phone open `http://10.0.0.21/localai-ca.crt`, install it, then turn on
   full trust for it (iPhone: Settings › General › About › Certificate Trust Settings). **Health › Secure connection**
   shows whether it worked.
2. Open `https://10.0.0.21` in Safari, Share › **Add to Home Screen**, and use that icon from then on.
3. Notifications: from the Home Screen app, **System › Health › Notifications › Allow notifications**.

HTTPS and the certificate: [Deploy › HTTPS with Caddy](DEPLOY.md#https-with-caddy).

## Reach it away from home

Install Tailscale on the Windows computer and the phone, sign both in to the same account, then re-run
`deploy\Install-LocalAI-HTTPS.ps1` (elevated). Nothing is opened to the internet; only devices on your Tailscale
network get in. Details: [Deploy › HTTPS with Caddy](DEPLOY.md#https-with-caddy).

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

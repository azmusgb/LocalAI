# Atlas for every repository: plan

Date: 2026-11-01 · Status: decisions made by the owner on 1 Nov 2026 (below) · Implements: platform baseline (pi-hub `2355701`)
section 6.4 and migration step 10. Documentation only.

## What the baseline asks for (6.4)

| | Today | Target |
|---|---|---|
| Trigger | Manual `quick_arch.py` | When awake, LocalAI reads Pi Hub's release records and snapshots any new commit. A PC that slept catches up on waking. Anything else uses a manual button |
| Coverage | LocalAI's repo only | Every home-platform repository and satellite, as snapshots keyed by repository and commit |
| Where it runs | The deploy checkout (`C:\LocalAI\repo`), which the deploy task requires to be clean | A clean copy at the snapshot's commit |
| Where it is read | Assistant › System › Advanced › Architecture | The same page. Versions rows link to "Architecture at this commit" |

Step 10 depends on step 3, the `release:<target>` records, for its trigger only. This plan does everything else
first. The trigger is the last PR, and it waits for step 3.

## How it works today (origin/main `791ff0b`)

- `quick_arch.py` (5,111 lines) scans the folder it sits in. `ROOT` is `Path(__file__).parent`. It writes one
  file, `.atlas/graph/system-atlas.html`, with the graph embedded as `const DATA = {…}`.
- `changed_files()` runs `git status` in that folder. "Changed" means uncommitted edits in the deploy checkout.
- `classify()` assigns domains from LocalAI's own paths (`app/public/` → UI, `host/gridcraft` → GridCraft, …). Any
  other repository would land almost entirely in a fallback domain.
- The container mounts `C:\LocalAI\repo\.atlas\graph` read-only at `/atlas-graph`. `app/server/atlas.js` serves
  `GET /api/atlas/graph` from that one file.
- `atlas_intelligence.py` (host, port 8765, Ollama and Goose) reads the same single graph for summary, findings,
  node, ask and goose.
- Nothing runs it on a schedule. It runs only when someone runs it.

## What the PC can reach

The PC reads GitHub through per-repository deploy keys: `C:\LocalAI\repo` uses the host alias `github-localai`. A
test on 1 Nov (`git ls-remote`) confirmed it cannot read pi-hub or the other platform repositories. Snapshotting
them needs read access from the PC. That is a credential decision for the owner (decision 1 below).

## PRs

Each PR is small, reviewed on its own, and shipped with `npm run ship`. Earlier PRs keep today's page working
unchanged.

1. **Generator: any repository, any commit, clean copy.**
   - New command form: `quick_arch.py --repo <name> --git-dir <path> --commit <sha>`. It exports the commit with
     `git archive` into a temporary folder and scans that folder, never a working tree.
   - It writes `.atlas/snapshots/<repo>/<sha>/graph.json` and appends to `.atlas/snapshots/index.json` with the
     repository, commit, commit time, generation time and stats. Writes are atomic.
   - "Changed" becomes "changed since the previous snapshot of this repository" (`git diff --name-only <prev>..<sha>`),
     because a clean copy has no uncommitted edits.
   - `classify()` keeps LocalAI's rules for LocalAI. For other repositories it uses the top-level folder, with a
     small per-repository map where the layout is known (pi-hub `hub/` and `deploy/`; print-lab `lab/`; firmware
     `src/`).
   - Running it with no arguments behaves exactly as today. Python tests run with the existing harness
     (`tests/atlas-hardening.test.cjs` style).
2. **Server: read snapshots.**
   - `GET /api/atlas/snapshots` returns the index.
   - `GET /api/atlas/graph?repo=&commit=` reads one snapshot. The repository must be on the allow-list and the commit
     must be 7-40 hex characters; nothing else reaches the file system.
   - With no parameters, it serves today's graph.
   - Compose mounts `.atlas/snapshots` read-only, beside `/atlas-graph`.
3. **Page: pick a repository and commit.**
   - A repository and commit picker on the Architecture page, defaulting to LocalAI's newest.
   - States for loading, no snapshots yet, stale (with the commit's time), error and long lists.
   - The domain map and file view are unchanged.
   - Findings, Ask and Goose follow the chosen snapshot once PR 5 lands. Until then they show "Graph only for this
     repository" for other repositories.
4. **Manual button: "Snapshot now".**
   - `POST /api/atlas/snapshot {repo, ref}` goes through the existing token-protected proxy to `atlas_intelligence.py`
     on the host. The host fetches the repository's mirror (`C:\LocalAI\atlas-repos\<repo>.git`, bare, fetch-only),
     resolves the ref and runs step 1.
   - One run at a time. A queued or running state shows on the page.
   - Retention: the newest 5 snapshots per repository (decision 2).
5. **Intelligence on the chosen snapshot.** `atlas_intelligence.py` takes an optional `repo` and `commit` on
   summary, findings, node, ask and goose. It loads that snapshot's `graph.json` instead of the single graph, and it
   answers questions from the snapshot's clean copy (re-exported with `git archive`, read-only), never from a working
   tree. The server passes both values through the proxy after the same allow-list check as PR 2. Without them, it
   behaves as today.
6. **Release trigger (after baseline step 3).** When the PC is awake, LocalAI reads Pi Hub's `release:<target>`
   records every few minutes and snapshots any live commit it has not seen. On waking, the first read catches up.
   Pi Hub's System › Versions links each row to `#architecture?repo=<r>&commit=<sha>`. That link is a pi-hub PR.

## Decisions (owner, 1 Nov 2026)

1. **Access: read-only deploy keys**, one per repository. Each is added on GitHub as read-only and kept in the
   PC's SSH config under its own host alias (like `github-localai`). Nothing on the PC can push. The keys are created
   and added before PR 4. That is a trust change, so the owner confirms it when it happens.
2. **Repositories: the core three first:** pi-hub, LocalAI and print-lab, with the newest 5 snapshots each. The
   others (bambuhelper-smart-display, home-mcp, netmon, appliance-ui) are added later. Adding one is a config change
   plus one deploy key.
3. **Intelligence: included in this plan** as PR 5.

## Acceptance (whole plan)

- The Architecture page offers pi-hub, LocalAI and print-lab. Each shows a graph at a named commit, generated from a clean
  copy. The PC's deploy checkout stays clean throughout.
- "Snapshot now" on any repository produces a new snapshot within a few minutes. Findings and Ask then answer about that snapshot. Running it twice queues the second
  run rather than running both at once.
- After step 3: a release to any target appears as a snapshot without anyone pressing a button, including after the
  PC wakes from sleep.

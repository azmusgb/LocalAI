# Agent World Mission Control reference implementation

Date: 23 November 2026  
Status: functional reference implementation on `feat/agent-world-mission-control`; no deployment or merge

## Outcome and boundary

Mission Control is an additional Agent World section. It projects the canonical LocalAI mission record into an
initiative overview, stage, progress, roadmap, workstreams, dependencies, blockers, evidence, revisions and event
history. Selecting a workstream opens the existing worker inspector. The existing Needs-you surface remains the owner
of real decisions.

The feature does not add a production datastore, a new route, a new page, a Pi Hub proxy or a second mission state
machine. Real mission state still comes from the persisted `missions` collection and `/api/agents/missions` SSE.
The structured decision exercise is deliberately demo-only, labelled as sample data, and stored under
`localai.agentWorld.missionControlDemo.v1` in that browser. It demonstrates single choice, multiple choice,
recommendation, rationale, custom direction and durable demo plan revisions without claiming live Claude telemetry.

## Pinned evidence

| Repository | Local revision inspected | GitHub `main` inspected | Working state |
|---|---|---|---|
| `azmusgb/pi-hub` | `fcab56c8da356f328a1e653d7a0db2bcfd52a58c` | `4c3f457531a390b730b2e16f49f9afd8d5ad5e77` | clean; not edited |
| `azmusgb/LocalAI` | isolated worktree based on `72f84dcbdf0683a9945232133c4e52a2b9636b87` | `72f84dcbdf0683a9945232133c4e52a2b9636b87` | only this branch edited |
| `azmusgb/appliance-ui` | `06cdf6c6f246abf57d28c5a1b6524fcf8dade87d` | same | clean; not edited |
| `azmusgb/print-lab` | `e6284767c2e1f95e9ab1f2f990508e14f791dd3f` | same | clean; not edited |
| `azmusgb/bambuhelper-smart-display` | `3941a1e9dc9c5291fcb73ec94c23518b4110497b` | same | clean; not edited |

The shared LocalAI checkout at `~/dev/ai-harness/LocalAI` was inspected read-only and left untouched. The implementation
uses `~/dev/.worktrees/LocalAI/feat-agent-world-mission-control`.

Claude's concurrent A34 work is Pi Hub PR [#309](https://github.com/azmusgb/pi-hub/pull/309), branch
`docs/a34-assistant-to-pi-hub`, head `2e0cc3a14c1b78733baf229c3df1ff7fb3477981`. It was inspected through GitHub
and not checked out or modified.

## Decisions reconciled

- **A22:** Pi Hub provides the shared site and kit while LocalAI content remains on its own origin. This implementation
  uses the existing LocalAI kit tokens and components.
- **A27:** the flatter two-level Assistant navigation is approved; Agent World is already a Work tab. No page or
  navigation entry was added.
- **A30:** Pi Hub executes consequential household actions and read-only Assistant tools are allow-listed. Mission
  Control adds no action authority.
- **A34 (proposed, not approved):** D4 explicitly keeps Agent World/Main Street tier 3, framed from LocalAI. This work
  therefore stays in LocalAI and does not overlap A34's Pi Hub adapter or tier-1 page work.

## Existing contracts used

`app/agent-orchestrator.js` is the source of truth:

- `workers[].dependsOn`, state, reason and routing metadata define the plan and workstreams;
- `timeline[]` is the durable mission event history; `followup` and `fallback` events are plan revisions;
- mission-level and result-level `evidenceRecords[]` are the evidence ledger;
- records persist in the existing `missions` storage collection and stream through the existing mission event emitter;
- worker details use the existing Agent World words and inspector, including the actual model and recorded routing
  metadata where available.

Main Street is already implemented in `app/world-street.js` and `app/public/street/*`. `/api/world` remains a
read-only summary. The print-lab dependency remains the Mac-owned `print-lab-index/1` projection in
`app/print-lab.js`; Agent World reads the designated Bambuddy-backed Pi Hub printer record and never substitutes the
Workshop display's differing reading when Pi Hub is unavailable. No print-lab ownership or route changed here.

## Provisional provider adapter contract

This is a future seam, not a new service or store. An adapter must return the existing mission shape unchanged and add
provenance beside it:

```ts
type MissionProvenance = {
  source: "stored-mission-record" | "live-mission-feed" | "demo";
  observedAt: string;
  live: boolean;
  label: string;
};

type MissionSnapshot = {
  mission: ExistingLocalAIMissionRecord;
  provenance: MissionProvenance;
};

interface MissionProviderAdapter {
  getMission(id: string): Promise<MissionSnapshot | null>;
  listMissions(limit?: number): Promise<MissionSnapshot[]>;
  subscribe(id: string, onSnapshot: (value: MissionSnapshot) => void): () => void;
}
```

Rules:

1. The adapter may normalize transport and provenance, but must not invent worker, event, evidence or decision state.
2. LocalAI's `missions` collection remains authoritative. Adapter caches, if ever added, are labelled mirrors.
3. Demo state is never returned as live and never enters the mission collection.
4. A future A34/Pi Hub adapter must follow A34's allow-list, owner-only and `key: never` rules; Agent World remains
   tier 3 unless a later approved amendment changes D4.

## Files and behavior

- `app/public/index.html`: Mission Control section inside the existing Agent World sheet.
- `app/public/ui.js`: lifecycle wiring into the existing mission feed and worker inspector.
- `app/public/aw/mission-control.js`: on-demand projection, honest provenance, demo decisions and local demo revisions;
  kept out of the app-shell download budget with the other Agent World modules.
- `app/public/app.css`: responsive kit-token styling, including reduced-motion-safe behavior.
- `tests/agent-world-plate.test.cjs`: page anatomy contract.
- `tests/agent-world-ui.mjs`: desktop, phone, evidence, revision, inspector and persistence coverage.

## Run and verify

```sh
npm ci
PORT=3187 DATA_DIR=/tmp/localai-mc-data WORKSPACE_ROOT=/tmp/localai-mc-work npm start
LOCALAI_URL=http://127.0.0.1:3187 node tests/agent-world-ui.mjs
node --test tests/agent-world-plate.test.cjs
node app/public/ui/literals.mjs app/public
npm test
```

Open Agent World, start or select a mission, then open **Mission control**. With no mission, use **Try a demo
mission** to exercise the labelled sample decisions. Demo choices and custom direction survive a browser reload; real
mission records are unchanged.

## Limitations and handoff

- Real missions do not yet contain a structured decision schema, so this reference does not pretend demo choices are
  production approvals. A production version should extend the canonical mission/approval contract only after its
  lifecycle and authority are specified.
- “Plan revisions” currently mean the initial route plus recorded `followup` and `fallback` events. Other event types
  remain in Story rather than being relabelled as revisions.
- Provenance distinguishes stored record, live feed and demo; it does not claim per-token or per-tool live Claude
  telemetry.
- No production deployment, merge, credential, Pi Hub, appliance-ui, print-lab, display or Claude-owned file change is
  part of this branch.

Claude can continue A34 independently. If A34 is approved and later changes Agent World's tier, reconcile by adapting
the provider seam above to the approved contract; do not copy the demo store into Pi Hub and do not create a second
mission database.

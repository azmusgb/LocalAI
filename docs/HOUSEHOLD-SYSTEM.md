# One household, several surfaces

LocalAI, Agent World, Pi Hub, Bambuddy and Workshop OS form one system. Each keeps a specific responsibility.
This guide distinguishes the integration implemented in source from the remaining work. Local checks do not prove
that a release is installed or that a physical action succeeded.

## Responsibilities

| Component | Owns | Reads from the others |
|---|---|---|
| Bambuddy on the Pi | Printer management, spool quantities and assignments, print history | Printer telemetry |
| Pi Hub | Shared household records, household attention, routine household commands | Bambuddy, direct service checks, LocalAI's own attention |
| LocalAI | AI work, runs, reasoning, generation, approval policy and agent execution | Pi Hub's household records; specialist service results |
| Agent World in LocalAI | A visible account of work, workers, decisions and outcomes | LocalAI runs and Claude sessions; Pi Hub's designated printer record |
| Workshop OS on the WS350 | Physical interaction, immediate printer controls, device health and recovery | LocalAI's display feed and messages; direct printer telemetry |
| Print Lab on the Mac | Experiment records, generated artifacts, applied verdicts | Human judgments and the existing request queues |

A command's HTTP success means the receiving service accepted it. Subsequent telemetry verifies the resulting state;
a person verifies physical conditions such as an empty plate or print quality. A model's explanation never replaces
those observations.

## Implemented integration

### Household facts

Pi Hub's `/api/records` is the shared household snapshot. Each record includes its designated `source`, `as_of`,
`stale`, state, headline and limited detail. The Assistant reads this same snapshot. Missing readings stay unknown;
old readings are explicitly historical. It does not fill in movie counts, disk space, drive connectivity, backups or
service state from remembered defaults. Recent print history is labelled historical, separate from current telemetry.

Agent World's printer adapter reads the Bambuddy-backed `printer` record at most once per 15 seconds, sharing
concurrent requests. It independently checks the original confirmation time on every use, including cache hits.
After 90 seconds, an explicit stale flag, or a confirmation more than 5 seconds in the future, progress and time left
become unknown. An unavailable Pi never causes an automatic switch to the display's differing printer reading.
Expired readings say **Reading expired** in the city and Main Street. A finished print still asks to clear its plate
instead of claiming readiness for the next print. The summary includes `source: "bambuddy"`, `via: "pi-hub"` and `seenAt`; addresses, credentials and raw source payloads
are excluded. The display poller still supplies display firmware and token/access health.

### Attention flows in one direction

1. LocalAI publishes `/api/attention`: its own approval/failure summary and watchdog cards. Building this response
   does not fetch Pi Hub, inventory, weather or a model, and does not probe capabilities.
2. Pi Hub combines those cards with its own records and Print Lab needs at `/api/needs`.
3. LocalAI forwards that aggregate to the paired display. Home and the display consume the same household list.

Pi Hub no longer reads `/api/display/feed` as an input to the aggregate. That endpoint is a presentation feed for
the display, not an upstream source of household facts. Publish LocalAI's new endpoint before installing the Pi Hub
consumer; an older LocalAI returns no attention reading, which Pi Hub marks as unread rather than all clear.

### Agent World watch mode

Watch mode reads both missions and `/api/world`. Work in Chat, Images, Changes, Spreadsheets and Automations, waiting
approvals, unseen failures and live Claude sessions all prevent idle replay. Their captions identify the work or the
decision. An unavailable source is labelled unavailable. Only a confirmed quiet street and mission source permit
replaying the previous mission, and replay remains labelled. Leaving watch mode invalidates pending polls so an old
request cannot restart it or overwrite a later watch session.

### Plate confirmation

Pi Hub and LocalAI use the same step order and outcome meaning: ask Bambuddy to confirm the plate, then clear the
error list only if the first step succeeded. If only error clearing fails, the plate confirmation remains accepted
and the error list needs checking. A timeout never triggers an automatic repeat of the physical command.

LocalAI also posts a quiet result banner through the existing display message channel: **Plate confirmed**,
**Check printer errors**, or **Plate not confirmed**. This requires no firmware protocol change. The banner is best
effort and must not change the command's outcome. The existing route still requires the display key or a signed-in
caller in every sign-in mode.

## Next complete workflow: an experiment from request to evidence

This is the next implementation contract, not a claim of a new cross-system task engine. Preserve the existing
experiment and request stores; do not create another inventory or print-history database.

- A task is `lab:<project>:<experiment>`, for example `lab:hex-tile:E-021`. Experiment IDs alone are not globally unique.
- A build, print attempt and verdict request keep their existing distinct IDs. A retry creates a new attempt under
  the same task. A repeated request ID returns its stored outcome instead of repeating the action.
- Each task reference carries the project, experiment, originating run/session, attempt when known, source and
  original observation time. Links open the exact experiment, attempt or approval on the surface that owns it.
- Operational states distinguish queued, working, waiting for approval, waiting for a machine, waiting for physical
  judgment, blocked, completed with evidence, failed and cancelled. An offline worker is not a completed task.
- Digital results link their artifacts and checks. A print completion links Bambuddy's attempt. A physical verdict
  names the human observation and photos. A generated opinion never stands in for that verdict.

The acceptance example is one panel experiment: request → proposed revision → approval → artifact → actual print →
WS350 judgment → Mac-applied verdict → evidence and next step visible in Agent World. Check it with the Windows PC
asleep, the Mac asleep, the Pi restarting, a stale source, duplicate events and a repeated verdict submission.

## Remaining boundaries

Routine display plate confirmation still passes through Windows LocalAI. Moving it to a narrowly authenticated
Pi-side gateway, and pairing the display directly to that gateway, requires a separate firmware candidate and
physical acceptance. Pi Hub's LocalAI HTTP clients still disable certificate verification; provision its CA and
service credentials before changing that deployment contract. Neither issue is solved by the work summary API.

Firmware promotion remains governed by Workshop OS's exact-image and physical acceptance process. Keep installed,
source, candidate, accepted and published channel identities distinct; no server change promotes firmware.

## Local verification, 28 October 2026

The complete LocalAI Node suite passed 1,126 tests, followed by affected printer/street checks after the final
expired-reading and plate-confirmation wording changes. Pi Hub passed 654 Python tests (8 skipped) and 164
JavaScript tests. Seventeen browser checks cover watch mode and Agent World landmarks, including work without a
mission, unavailable work, expired printer readings and plate confirmation. Desktop and 390-pixel phone watch-mode
captures were visually inspected. Changed JavaScript passed ESLint; all three repositories passed whitespace checks.
No release was deployed and no firmware was flashed or promoted by this work.

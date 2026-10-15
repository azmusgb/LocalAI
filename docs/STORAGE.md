# SQLite state and migration

LocalAI keeps its state in one SQLite database, `DATA_DIR/localai.db`, through Node's built-in `node:sqlite`.
Node.js 22.13.0 or newer is required on the development machine and in the appliance image; there are no npm
runtime dependencies or native modules. Keep `DATA_DIR` on a local disk or a local Docker volume, and reach
the data through the HTTP API rather than sharing the database file over SMB or NFS.

## Ownership and schema

`app/storage.js` owns schema migrations, transactions, repositories, legacy import, backup and export. The
server and the specialist orchestrator share one connection; a standalone orchestrator owns its own and
exposes `close()`.

| State | SQLite tables |
| --- | --- |
| Projects | `projects` |
| Conversations | `conversations`, `messages` |
| Knowledge | `knowledge_sources`, `knowledge_chunks` |
| Library (artifacts) | `artifacts` |
| Specialist missions | `missions`, `mission_steps`, `mission_events` |
| General and specialist agent runs | `agent_runs`, `specialist_agent_runs` |
| Automations and their runs | `automations`, `automation_runs` |
| Audit log, Inbox, approvals, changes | `activities`, `notifications`, `approvals`, `changes` |
| Project memory, monitors | `project_memory`, `monitors` |
| Quality events and scans, issues | `quality_events`, `quality_scans`, `issues` |
| Engineering and PowerShell runs | `engineering_runs`, `powershell_jobs` |
| Deployment records (provisioned, unused) | `deployments` |
| Key-value rows (see below) | `settings` |
| Schema and legacy import audit | `schema_migrations`, `legacy_imports` |

`settings` holds keyed JSON rows that need no table of their own:

| Key prefix | Contents | Written by |
|---|---|---|
| `status` | Last health state and pending transitions | `app/server.js` |
| `unified-run/` | The run ledger behind **System › Runs** | `app/run-ledger.js` |
| `claude-session/`, `claude-event/`, `claude-finding/` | Claude board sessions, progress events (newest 3,000), findings (1,000) | `app/server.js` |
| `claudeChat:` | Chat relay sessions, messages, paired devices, pairing requests | `app/claude-chat.js` |
| `repair:garbled-text-v1`, `legacy-json-import-v1` | One-time migration markers | `app/server.js`, `app/storage.js` |

Records keep indexed project references, status and stable ordering, plus JSON metadata that preserves the
existing API fields. Messages, chunks, mission workers and mission timeline entries live only in their child
tables and are deleted with their parent. Known project references have foreign keys; a reference to a
project that does not exist yet stays in the payload and the indexed `project_ref`, and attaches when the
project is created. Generated files and media stay with the service that made them; SQLite holds their
metadata. Windows deploy state (`C:\LocalAI\.deploy\state.json`) belongs to the host scripts, not to SQLite.

## First start

1. Create schema version 1 in a transaction.
2. Parse and validate every recognized legacy JSON file. Malformed JSON, invalid records or duplicate IDs stop
   startup and name the file; nothing is partially imported.
3. Copy the original bytes to `DATA_DIR/backups/json-before-sqlite-<uuid>/`.
4. Import every collection in one transaction, recording SHA-256 hashes, counts and backup paths.
5. Commit an import marker and check SQLite integrity and foreign keys before the HTTP server starts.

After a successful import SQLite is authoritative. The original JSON files are kept but never read again:
editing them changes nothing, and leaving them in place cannot bring deleted records back. An empty
installation also gets an import marker. To retry an import that failed, fix the input and restart.

The database runs in WAL mode with `synchronous=FULL`, a five-second busy timeout and foreign keys on. If
SQLite fails the server does not fall back to JSON, and a database with a newer schema version is refused
rather than downgraded.

## Writes and history

`storage.upsert(collection, record)` writes one record in a transaction. `storage.list(collection)` returns a
snapshot that can be passed back to `storage.save(collection, items, originalSnapshot)`. Save compares only
the records that changed or were deleted against their original values, keeps records other requests added
or changed in the meantime, and rejects a conflicting change with `STORAGE_CONFLICT` (HTTP 409). Callers
reload and retry; nothing is overwritten automatically.

Filtered or paginated lists cannot be saved as whole collections; use the record API. `storage.transaction()`
is synchronous and rejects async callbacks: do model or network calls before opening a transaction, never
inside one.

Conversations, messages and mission timelines are kept in full. Log-like collections are pruned to their
newest records on write (`RETENTION` in `app/server.js`):

| Collection | Kept |
|---|---|
| `activity` (Audit log) | 2,000 |
| `notifications`, `automationRuns`, `qualityEvents` | 500 each |
| `agentRuns`, `engineeringRuns` | 300 each |
| `powerShellJobs` | 250 |
| `qualityScans` | 100 |

Runs (`unified-run/` settings rows): a run that is pinned or filed under a project is kept and never pruned, so
kept runs grow without a ceiling. Every other run, including successful chats and images, ages out after the
newest 250. Library items are not deleted when their run ages out. Unpin or unfile a run to let it age out.

`GET /api/projects`, `/api/conversations` and `/api/knowledge` accept optional `limit` (1–1000), `offset`
(0 or more) and `projectId`. Responses keep `items` and add `total`, `limit` and `offset`. Default page
sizes are 250, 300 and 500.

## Inspect, back up and export

`app/storage-cli.js` takes a command and `--data-dir` (default: `DATA_DIR`, else `/data`); `backup`,
`export-json` and `downgrade-json` also need `--output`. On the host, run it inside the container:

```powershell
docker exec local-ai-appliance node /app/storage-cli.js status --data-dir /data
docker exec local-ai-appliance node /app/storage-cli.js check --data-dir /data
docker exec local-ai-appliance node /app/storage-cli.js preflight --data-dir /data
docker exec local-ai-appliance node /app/storage-cli.js backup --data-dir /data --output /data/backups/manual-snapshot.db
docker exec local-ai-appliance node /app/storage-cli.js export-json --data-dir /data --output /data/backups/json-export
```

On a development machine: `node app/storage-cli.js status --data-dir ./data`.

| Command | What it does |
|---|---|
| `status`, `check` | Read-only inspection; never creates schema, imports or backs up. Before the first migration they validate the JSON and report `migrationPending: true`. A missing data directory is an error |
| `preflight` | Copies committed state (or legacy JSON) to a temporary directory, runs the migration and integrity checks there, and removes the copy |
| `migrate` | Opens the database (running any pending migration) and reports status |
| `backup` | `VACUUM INTO` a new file, which includes committed WAL data |
| `export-json` | Writes compatible JSON files from one transaction |
| `downgrade-json` | See [Code rollback across the JSON boundary](#code-rollback-across-the-json-boundary) |

Output paths must be new; existing backups are never overwritten. Copying `localai.db` while the app is
running is not a coherent backup. Nightly backups use `backup`; see [Operations › Backups](OPERATIONS.md#backups).

`GET /api/storage/status` reports the engine, schema, journal mode, import audit and collection counts.
`/healthz` reports `storage` and `releaseCommit` and is served only after storage initialized. Deploys write
`app/release.json` with the exact SHA; without that file (development) `releaseCommit` is `null`, and a
malformed file stops startup.

### Recovering the database by hand

Prefer `deploy\Restore-LocalAI-Data.ps1` ([Operations › Restore](OPERATIONS.md#restore)). By hand: stop the
application, keep a copy of the whole data directory, put a verified backup at `DATA_DIR/localai.db` with no
stale `localai.db-wal`/`localai.db-shm` beside it, start, and check `/api/storage/status`. Restoring a backup
reverts data to that point; a code rollback keeps current data.

## Code rollback across the JSON boundary

Deploys check the image's Node runtime before promotion, even when the container is stopped, and run the
disposable preflight with the data and candidate code mounted read-only, before stopping the app and again
after. Each SQLite deploy backs up the database to `DATA_DIR/backups` through a throwaway worker that uses the
existing image and mounts with `--network none`. `DATA_DIR` must be a container mount outside `/app`
(`Get-LocalAI-DataDirectory` in `deploy/Storage-LocalAI.ps1` refuses anything else).

Rolling back to code that predates SQLite runs `downgrade-json` while the application is stopped. It exports
the current state, writes a SQLite backup, replaces the legacy JSON with the export, and archives the active
database and its import marker, so the older application sees current data and a later upgrade re-imports
JSON edits made in between. If the export fails the rollback stops before the older code starts.

Manual equivalent, with every process using the database stopped:

```powershell
node .\app\storage-cli.js downgrade-json --data-dir C:\LocalAI\data --output C:\LocalAI\backups\before-json-rollback
```

## Troubleshooting

### Preflight fails only when the container is stopped

Symptom, on Docker Desktop for Windows: storage preflight works while `local-ai-appliance` runs, but with it
stopped fails with `LocalAI storage: unable to open database file`. The cause was `--volumes-from` against a
stopped container.

`deploy/Storage-LocalAI.ps1` now resolves the Docker mount behind `DATA_DIR` (a named volume,
`local-ai-appliance-data` on the current host) and the `/app` bind, and mounts them explicitly into storage
workers (`Get-LocalAI-ExplicitMountArgument`). Candidate preflight mounts `/data` read-only and copies
`localai.db` with its `-wal`/`-shm` files to a writable `/tmp` before opening it, because SQLite cannot open a
WAL database from a read-only mount there; maintenance
mounts `/data` read-write and the deployed `/app` read-only so the deployed `storage-cli.js` is used.
`--volumes-from` remains only as a fallback when the mount metadata is incomplete (simulated fixtures).

The deploy contract tests mock Docker, so check this case by hand on the host after changing
`Storage-LocalAI.ps1`:

```powershell
docker inspect local-ai-appliance --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}'
docker stop --timeout 15 local-ai-appliance
. .\deploy\Storage-LocalAI.ps1
Test-LocalAI-StorageCandidate -Container 'local-ai-appliance' -CandidateApp '.\app'   # expect success
docker start local-ai-appliance
Invoke-RestMethod http://127.0.0.1:3080/healthz
.\deploy\Deploy-LocalAI.ps1 -CheckOnly
```

The first line should show `/data` as a `volume`.

### Other storage errors

| Error | Meaning |
|---|---|
| `STORAGE_CONFLICT` (HTTP 409) | Another request changed the same record; reload and retry |
| `DATA_DIR does not exist or is not a directory` | `storage-cli.js` was pointed at the wrong path |
| `Storage maintenance requires the application container to be stopped.` | `Invoke-LocalAI-StorageMaintenance` was run against a running container |
| `DATA_DIR ... is not backed by a container mount` | The container's `/data` is not a volume or bind; workers refuse to guess |

## Tests

`npm test` covers legacy round trips, malformed imports, schema rejection, conflicts, rollback, child cascades,
full history, pagination, backups, JSON downgrade and re-upgrade, separate writer processes, concurrent
agent and automation HTTP execution, restart durability, read-only inspection, disposable preflight and
release identity. CI runs the whole suite on Linux with Node 22 for every code PR. PRs that touch storage,
release, run ledger or orchestrator code also run those suites on Node 22.13.0; a weekly run adds Windows and
Node 24 (`.github/workflows/storage.yml`). The deploy contract tests run the real promotion and rollback scripts
against simulated Docker on PowerShell 7 and Windows PowerShell 5.1, for PRs touching `deploy/` or host
PowerShell and weekly; they do not certify a real rollout on the host. See [Development › CI](DEVELOPMENT.md#ci).

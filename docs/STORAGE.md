# SQLite state and migration

LocalAI now stores application state in `DATA_DIR/localai.db`. Node.js **22.13.0 or newer** is required on both the development host and the appliance container. Storage uses `node:sqlite`; there are no npm runtime dependencies or native modules to compile. Keep `DATA_DIR` on a local disk or local Docker volume. Access the appliance through HTTP rather than sharing the database file over SMB/NFS.

## Ownership and schema

`app/storage.js` owns versioned schema migrations, transactions, state repositories, legacy import, backup and export. The server and specialist orchestrator share one connection. Standalone orchestrators own their connection and expose `close()`.

| Existing state | SQLite tables |
| --- | --- |
| Projects | `projects` |
| Conversations | `conversations`, `messages` |
| Knowledge | `knowledge_sources`, `knowledge_chunks` |
| Artifact library | `artifacts` |
| Specialist missions | `missions`, `mission_steps`, `mission_events` |
| General and specialist agents | `agent_runs`, `specialist_agent_runs` |
| Automation definitions and executions | `automations`, `automation_runs` |
| Activity, notifications, approvals, changes | `activities`, `notifications`, `approvals`, `changes` |
| Project memory, monitors | `project_memory`, `monitors` |
| Quality events/scans and issues | `quality_events`, `quality_scans`, `issues` |
| Engineering and PowerShell executions | `engineering_runs`, `powershell_jobs` |
| Service transition state | `settings` |
| Schema and legacy import audit | `schema_migrations`, `legacy_imports` |

`deployments` is provisioned for application deployment records. Windows deployment control state in `C:\LocalAI\.deploy\state.json` remains owned by the host deployment scripts; this phase does not invent a second host deployment controller.

Records have indexed project references, status and stable ordering, plus JSON metadata that preserves existing fields and API responses. Messages, chunks, mission workers and mission timeline entries have one authoritative child-table representation with cascading deletion. Known project references have foreign keys. Historical references to missing projects remain in the payload and indexed `project_ref`; they are queryable and attach to the foreign key when the project is created later. Generated files/media remain with their existing disk/service owner; artifact metadata and references live in SQLite. Upload, hashing and file ingestion remain the separate Files + Knowledge phase.

## First start

1. Create schema version 1 in a transaction.
2. Parse and validate every recognized legacy JSON file. Malformed JSON, invalid records or duplicate IDs stop startup with the source filename; no partial data import is committed.
3. Copy the exact original bytes to `DATA_DIR/backups/json-before-sqlite-<unique-id>/`.
4. Import all collections and status in one transaction, recording SHA-256 hashes, counts and backup paths.
5. Commit a durable import marker and verify SQLite integrity and foreign keys before the HTTP server starts.

Original JSON files are preserved and never rewritten during normal operation. Once import succeeds, SQLite is authoritative. Editing old JSON files does not change live data, and leaving those files in place cannot resurrect deleted records. Empty installations also receive an import marker. Correct malformed input and restart to retry an uncommitted import.

WAL mode, a five-second busy timeout and `synchronous=FULL` protect committed state. The application does not silently fall back to JSON when SQLite fails. A database with a newer schema version is rejected rather than downgraded.

## Writes and history

`storage.upsert(collection, record)` writes a single runtime-owned record in a transaction. `storage.list(collection)` returns a full snapshot that can be passed to `storage.save(collection, items, originalSnapshot)`. Save compares only changed/deleted records to their original values, preserves records inserted or updated by other requests, and rejects conflicting changes with `STORAGE_CONFLICT`. HTTP handlers return 409 for these conflicts. Callers must reload and retry; there is no automatic overwrite.

Filtered or paginated lists cannot be saved as whole collections. Use the record API for those operations. `storage.transaction()` supports synchronous, multi-collection work; no model/network await belongs inside a database transaction. Approval/change transitions use this boundary so their records commit together.

Persistence no longer truncates collections at the old 150/250/500 record limits. Conversation saves retain all valid user/assistant messages within the existing request-size limit; inference still uses bounded context. Mission timelines are retained in full. UI display limits remain independent of persisted history.

`GET /api/projects`, `/api/conversations` and `/api/knowledge` accept optional `limit` (1–1000), `offset` (nonnegative) and `projectId`. Responses retain `items` and add `total`, `limit` and `offset`. Default page sizes are 250, 300 and 500 respectively. Storage repositories also support indexed status filtering and literal title search. Knowledge search retains its existing scoring and response contract.

## Inspect, back up and export

From the repository root, with the application data directory specified:

```powershell
node .\app\storage-cli.js status --data-dir C:\LocalAI\data
node .\app\storage-cli.js check --data-dir C:\LocalAI\data
node .\app\storage-cli.js preflight --data-dir C:\LocalAI\data
node .\app\storage-cli.js backup --data-dir C:\LocalAI\data --output C:\LocalAI\backups\localai-snapshot.db
node .\app\storage-cli.js export-json --data-dir C:\LocalAI\data --output C:\LocalAI\backups\json-export
```

Use the actual mounted `DATA_DIR` for your installation. Output files/directories must be new; existing backups are never overwritten. `backup` uses SQLite `VACUUM INTO`, which includes committed WAL data, followed by a file flush. Copying only `localai.db` while the application is running is not a coherent backup. `export-json` produces compatible JSON files from a single database transaction.

`status` and `check` inspect an existing database read-only and never initialize schema, import JSON or create backups. Before the first migration they validate recognized JSON files and report `migrationPending: true`. A nonexistent data directory fails rather than creating an empty installation. `preflight` copies committed SQLite state (including WAL commits), or legacy JSON, into disposable temporary storage and runs the candidate migration and integrity checks there. It removes the temporary copy on success or failure.

`GET /api/storage/status` reports engine, schema, journal mode, import audit and collection counts. `/healthz` adds storage engine/schema information and `releaseCommit`; it is served only after initialization succeeds. Managed deployments generate `app/release.json` with the exact deployed SHA. Development without that file reports a null release identity; malformed identities fail startup.

For database recovery, stop the application, preserve the entire current data directory, then place a verified SQLite backup at `DATA_DIR/localai.db` in a data directory without stale `localai.db-wal`/`localai.db-shm` files. Restart and inspect `/api/storage/status`. Restoring a backup deliberately reverts data to that snapshot; routine code rollback preserves current state.

## Code rollback across the JSON boundary

Deployment certifies storage behavior and checks the actual container image's Node runtime before promotion, including when the container is stopped. Before stopping the application it runs disposable data preflight with source volumes and candidate code mounted read-only. It repeats preflight after stopping writes and before application replacement. Subsequent SQLite deployments create a coherent pre-deploy data backup in `DATA_DIR/backups` through an isolated worker using the existing immutable container image and mounts. `DATA_DIR` must be backed by a container mount outside `/app`.

When rolling back to a snapshot that predates SQLite, deployment/rollback scripts run `downgrade-json` through the isolated worker **while the application is stopped**. It exports current database state, creates a SQLite backup, replaces legacy JSON with the current export, and archives the active database and its import marker. This lets the older application see current data and lets a subsequent upgrade import JSON edits made during the downgrade. A failed export stops rollback before older code starts. Keep all recovery output.

For a manual equivalent after stopping every application process using the database:

```powershell
node .\app\storage-cli.js downgrade-json --data-dir C:\LocalAI\data --output C:\LocalAI\backups\before-json-rollback
```

Deploy/rollback data workers require the existing appliance `/app` and data mounts; they use `--network none` and do not launch model services. Actual Windows/Docker promotion, storage mounts and recovery must still be verified on the appliance host.

## Validation

`npm test` covers exact legacy round trips, malformed imports, schema rejection, conflicts, rollback, child cascades, full history, pagination, coherent backups, JSON downgrade/re-upgrade, separate writer processes, concurrent agent/automation HTTP execution, restart durability, read-only inspection, disposable migration preflight and release identity validation. Existing specialist orchestration tests run against SQLite. CI runs these on Windows and Linux with Node 22.13 and Node 24, plus the deployment validator and existing desktop/mobile browser acceptance. Deployment contract tests run actual promotion/rollback scripts with simulated native command boundaries on PowerShell 7 and Windows PowerShell 5.1; they do not certify a real appliance rollout.

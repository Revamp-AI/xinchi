# Postgres / Neon cutover

Focus uses PostgreSQL 16 or later. The app remains a single-owner process on `127.0.0.1:3210`; using Neon does not deploy the app or its workers.

## Connection setup

For Neon, create a dedicated project in a region near the app. Choose a small compute allocation and autosuspend appropriate to your usage. Project creation, spending limits, history retention, and restore policies are account decisions. The application does not provision or change them.

Put the pooled connection string in `DATABASE_URL` in the ignored `.env.local`. Put the direct connection string in `DATABASE_URL_UNPOOLED` for migrations. Keep TLS enabled as prescribed by the connection string. Use a dedicated database and database owner for Focus; do not share it with untrusted applications. `focus_auth` is revoked from `PUBLIC`, but the configured Focus role can access it for authentication.

```sh
npm ci
npm run db:migrate
npm run build
npm start
```

Migrations are explicit and checksum-verified. App imports and builds never alter schemas. Each migration batch holds a transaction advisory lock, so concurrent deploys serialize. Never edit a migration after applying it; add a new numbered SQL file.

## Moving an existing SQLite archive

1. Inventory the existing private data directory. Find `xin.sqlite3`, optional `auth.secret.sqlite3`, and `connections.secret.json`. Check that the new database is empty. Keep `.env.local` and provider credentials outside public commits.
2. Finish or cancel reviews and imports. Stop the old Next server and its detached workers. Do not run old SQLite writers and new Postgres writers together. Inspect process command lines locally rather than killing arbitrary PIDs from database rows.
3. Run a dry run. Choose a new private backup directory each time:

```sh
npm run db:import-sqlite -- --source-dir /private/path/to/data --backup-dir /private/path/to/dry-run-backup
```

4. With all writers stopped, take the actual cutover snapshots and import atomically:

```sh
npm run db:import-sqlite -- --source-dir /private/path/to/data --backup-dir /private/path/to/cutover-backup --apply --writers-stopped
```

The command uses SQLite's online backup API with read-only source connections. Snapshot files become read-only. It preserves text IDs, exact source bodies, raw JSON strings, hashes, item history, job output, proposals and sync checkpoints. It copies the pinned owner and sanitized auth events, excludes old sessions and OAuth attempts, and deliberately marks queued/running legacy work interrupted. Every copied row and table count is checked before commit; foreign keys verify references. Unsupported legacy columns or any nonempty destination stop the import. The report includes counts and source/version digests without printing private source content.

5. Keep using the same private `XIN_DATA_DIR` for `connections.secret.json` and local agent output. Add the Postgres URLs to the app's `.env.local`. Start the new app and sign in again.
6. Check source search, a saved citation, accepted commitments, history and provider coverage. Refresh providers deliberately; then use Contacts → Bring in contacts → Extract last 90 days. Uncertain identities and duplicate meetings require review. Full stored-history extraction is optional.
7. Keep the original database and snapshots. They are no longer the active archive.

## Backup and restore

Use `pg_dump` with a private PostgreSQL service/credential file to make a custom-format database backup; keep provider secrets in a separate private backup. Do not paste connection URLs into shell history or public logs. The in-app JSON export is useful for inspection and portability, but is not a full disaster-recovery backup and intentionally omits authentication.

Restore a database backup into a **new empty database or isolated Neon branch** with `pg_restore`. Point a separate local verification process at that restored database and compare table counts, source hashes, source-version bodies, item/event references and representative searches. Verify the pinned owner; revoke restored sessions and OAuth attempts before a live recovery. The automated migration tests exercise a local dump/restore round trip; live Neon backup retention and restore behavior still need verification against the chosen project.

Before the first Postgres writes, rollback can use the read-only SQLite snapshots with the old app. **After new Postgres writes, switching to old SQLite would lose data.** Export/reconcile those writes or recover from a current Postgres backup before switching.

## Workers

Agent reviews, provider imports and contact extraction use separate durable queues with 45-second leases and 10-second heartbeats. Claims are atomic; cancelled or expired workers cannot publish results. Provider checkpoints and imported records are guarded by the current lease. A process ID is diagnostic only and is never used to kill a process on another host. Expired runs are marked interrupted and may be retried. Contact extraction resumes from its per-source queue and does not roll back successfully imported provider sources.

Active-outcome acceptance and contact merges lock a workspace row so simultaneous requests cannot bypass capacity or identity checks. Source imports retain independent per-source locks and unique source/version keys. Runtime pools are bounded at five connections per process; account for the Next server, workers and the agent context process when selecting a database connection budget.

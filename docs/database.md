# Database access and schema changes

Focus is moving from raw SQL strings to Drizzle ORM one module at a time. New code uses Drizzle; raw `all`, `one` and `run` calls remain only in modules that have not been converted yet and in test assertions.

## Schema

`lib/schema/` defines every table, split by domain (`core`, `reviews`, `ingestion`, `contacts`, `priorities`, and `auth` for the `focus_auth` schema). It is the source of truth for the database. Keys match column names (snake_case), so rows keep the shape the API, UI, MCP tools and exports already use. Name foreign keys `<table>_<column>_fkey`, the name Postgres gave the existing ones.

To change the schema:

1. Edit `lib/schema/`.
2. Run `npm run db:generate`. drizzle-kit writes `drizzle/<timestamp>_<name>/migration.sql` and a snapshot.
3. Read the generated SQL. Add data backfills to it when needed.
4. Apply it with `npm run db:migrate`.

Never edit a migration after it has been applied; `db:migrate` rejects a changed file. Do not run `drizzle-kit migrate` or `drizzle-kit push` against a real database: they bypass the schema lock and the legacy adoption step below. `tests/migrations.test.mjs` fails if `lib/schema/` and the generated migrations disagree.

## Queries

Import `db` from `lib/postgres.ts`.

- Outside `transaction()`, `db` uses the connection pool. Inside it, `db` uses that transaction's connection, so Drizzle queries and remaining raw helpers see the same uncommitted writes and roll back together.
- `db.transaction(fn)` runs `fn` inside `transaction()`. A nested call joins the enclosing transaction rather than opening a savepoint. To roll back, throw.
- Use `sql` fragments for Postgres-specific expressions (jsonb operators, full-text search, `now() + interval`). Lock rows with `.for('update')`.
- Selected columns come back as the app expects: `timestamptz` as ISO strings, `int8` as numbers (an unsafe integer throws), `date` as `YYYY-MM-DD` strings. `db.execute(sql\`...\`)` returns raw driver values instead; select through table columns when you need mapped values.

## Errors

Drizzle wraps driver errors in `DrizzleQueryError`, whose message contains the SQL and its parameters. Before choosing a message for a failure, call `databaseErrorCode(e)` from `lib/postgres.ts`: when it returns a code, show a fixed message, never `e.message`.

## Converting a module

Each module moves in two commits:

1. **Convert to TypeScript.** `git mv` the `.mjs` file to `.ts`, format it with Prettier, add types that pass `strict`, and update import paths. No behavior change.
2. **Move queries to Drizzle.** Replace raw SQL with `db` queries that keep the same semantics, and check any code that inspects query errors. Tests keep their raw SQL assertions, which check results independently of Drizzle.

## Legacy migrations

`migrations/001`–`016` built the schema before Drizzle. They are frozen. A new database is built from `drizzle/` alone. A database that still has `focus_schema_migrations` finishes any missing legacy files and then records the Drizzle baseline as applied without running it; see the [cutover runbook](postgres-cutover.md). Once every existing database has been migrated this way, `migrations/` and the adoption step will be removed.

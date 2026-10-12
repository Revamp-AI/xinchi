# AGENTS.md

Repository guidance for coding agents lives in [CLAUDE.md](CLAUDE.md); follow it.

Database work follows [docs/database.md](docs/database.md):

- Write new queries with the Drizzle `db` from `lib/postgres.ts`. Do not add raw `all`, `one` or `run` calls.
- Change the schema in `lib/schema/`, then run `npm run db:generate` and review the generated SQL in `drizzle/`. Do not add files to `migrations/`; those are frozen.
- Apply migrations only with `npm run db:migrate`, never `drizzle-kit migrate` or `drizzle-kit push`.
- When showing a database failure to a user, check `databaseErrorCode(e)` and use a fixed message; never show the error's message.

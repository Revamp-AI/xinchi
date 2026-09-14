# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Focus is a single-owner, local-only Next.js 16 app. It ingests meeting and email context (Fireflies, Granola, Gmail, manual files) into SQLite, runs agent reviews through the signed-in Codex CLI, and keeps a commitment board capped at three active outcomes. Everything binds to `http://127.0.0.1:3210`. The repo is public; runtime data, credentials, and the owner's private context never go in it.

## Commands

Node 24+ is required (`node:sqlite`). No linter or formatter is configured. Type checking runs inside `next build` (`tsconfig.json` has `strict: false` and `allowJs`).

| Task | Command |
|---|---|
| Install | `npm ci` |
| Dev server | `npm run dev` (port 3210; run only one instance) |
| Production | `npm run build && npm start` |
| All tests | `npm test` |
| One test file | `node --test tests/system.test.mjs` |
| One test by name | `node --test --test-name-pattern="displacement" tests/system.test.mjs` |
| Import JSON sources | `npm run import -- /path/to/sources.json` |
| Replace Google client | `node --env-file-if-exists=.env.local scripts/configure-google.mjs client.json` |
| Add a Coss UI component | `npx shadcn@latest add @coss/<name>` (registry alias in `components.json`) |

`.env.local` must set `XIN_ALLOWED_EMAIL` (see `.env.example`). `dev` and `build` pass `--webpack`; keep that unless you have verified Turbopack with `node:sqlite` (listed in `serverExternalPackages`) and the Tailwind v4 PostCSS setup. Running the build or the tests creates `data/` as a side effect; it is gitignored.

## Architecture

### Three processes, one database

- **Next server.** One catch-all route, `app/api/[...path]/route.js`, dispatches on the path string. Pages are `app/page.jsx` (session-gated workspace) and `app/login/page.jsx`.
- **Sync worker.** `startSync()` in `lib/connectors.mjs` inserts a `sync_runs` row and spawns a detached `scripts/sync-worker.mjs`, which runs `syncProvider()` and writes progress back to that row. Any running run older than 15 minutes is marked failed and replaced.
- **Agent worker.** `createJob()` / `launchJob()` in `lib/agent.mjs` insert a `jobs` row and spawn a detached `scripts/worker.mjs`. That process runs `codex exec` (read-only sandbox, most features disabled, `--output-schema`) with `scripts/context-mcp.mjs` attached as a stdio MCP server exposing exactly three read-only tools: `search_context`, `read_source`, `read_commitments`. Every tool call appends a `job_events` row, which is both the job heartbeat and the "activity" log shown in the UI.

Children receive `XIN_APP_ROOT` and `XIN_DATA_DIR` so they resolve `scripts/` and `data/` the same way the server does. There is no websocket and no scheduler: the workspace polls `GET /api/state` every 2.5 s, and `dashboard()` in `lib/db.mjs` is the single payload every view reads.

### Storage (`data/`, override with `XIN_DATA_DIR`)

- `xin.sqlite3` via `lib/db.mjs`: `sources`, `source_versions` (raw snapshots), FTS5 `source_search`, `items`, `events`, `proposals`, `jobs`, `job_events`, `sync_runs`, `settings`.
- `auth.secret.sqlite3` via `lib/auth.mjs`: owner, hashed sessions, OAuth attempts, sanitized `auth_events`.
- `connections.secret.json` via `lib/connectors.mjs`: provider keys, Google client, Gmail tokens, last Gmail issue.

Importing `lib/db.mjs` or `lib/auth.mjs` opens the database and creates the schema as a module side effect. Tests set `process.env.XIN_DATA_DIR` to a temp dir *before* `await import(...)`. `lib/*.mjs` are plain ESM shared by the Next server and the standalone scripts; keep them free of Next and React imports.

### Source records

`upsertSource()` is the only write path. The id is `provider:external_id`. An unchanged content hash is a no-op; a new hash updates the row, appends a `source_versions` snapshot, and rebuilds the FTS row. Coverage is ranked (`metadata`/`empty` < `summary` < `document`/`email body` < `transcript` < `deleted upstream`) and a lower-ranked import cannot overwrite a higher-ranked body. Prompts typed into the agent composer are stored as `manual` sources so later reviews can find them.

### Commitment rules live in `saveItem()` (`lib/db.mjs`)

This function is the business-rule center; the UI only mirrors it.

- Statuses: `candidate` (UI label "To decide"), `now`, `waiting`, `later`, `done`, `dropped` (UI label "Closed"). Kinds: `action`, `decision`.
- `now` requires `done_when`, `next_action`, `owner`, `checkpoint`. A fourth `now` item must pass `replace_id`, `tradeoff_reason`, `replace_checkpoint`; the displaced item moves to `later` with a `displaced` event, in the same transaction.
- `waiting` requires `dependency` + `checkpoint`; `later` requires `reason` + `checkpoint`; `dropped` requires `reason`; `done` requires `evidence`. Moving a checkpoint after one was set requires a `reason`.
- `source_quote` must be a verbatim substring of the linked source body. `version` gives optimistic concurrency. Every save writes an `events` row with before/after JSON.
- Accepting a proposal is just `saveItem({...payload, proposal_id})`. Nothing becomes an item without the user.

### Agent contract (`lib/agent.mjs`, `scripts/worker.mjs`)

`AgentResult` (zod) becomes the JSON Schema handed to Codex. `validateResult()` rejects the whole result if any citation quote is not a substring of the cited source body or if `existing_item_id` is unknown; a rejected result fails the job and saves nothing. Proposals dedupe by fingerprint (title + first source + existing item). One job runs at a time; imports finishing during a job queue a single `pending_import_review` that the worker drains on exit. `recoverJobs()` fails jobs with no heartbeat for 10 minutes; the worker times out at 8 minutes and fails any run that never called a context tool. The agent policy is the inline prompt string in `scripts/worker.mjs`.

### Auth and request protection (`lib/auth.mjs`)

Google OIDC with PKCE, one owner (`XIN_ALLOWED_EMAIL`; the Google `sub` is pinned on first login). `checkLocalRequest()` requires `Host: 127.0.0.1:3210` exactly (`localhost` is rejected), and every POST needs `Origin: http://127.0.0.1:3210` plus the `X-Xin-Request: 1` header. The `api()` / `post()` helpers in `app/workspace.jsx` and `app/login/screen.jsx` add it; any new fetch must too. Only `auth/setup` and `auth/google/start` are unauthenticated POSTs. Text shown to the browser comes exclusively from the fixed strings in `lib/auth-messages.mjs`; never surface raw provider responses. `tests/auth.test.mjs` enumerates protected paths, so add new API paths to those lists.

### UI

- `app/workspace.jsx` owns all client state and the `api()` helper. `components/focus/*.jsx` are presentational views and dialogs that receive callbacks. Which dialog is open is decided by which state object is non-null (`editing`, `source`, `trace`, `events`, `setup`).
- `components/ui/*.tsx` are vendored Coss UI registry files (MIT; see `components/ui/README.md`). Only import aliases were changed. Re-add from the `@coss` registry rather than restyling them by hand.
- Styling: `app/coss.css` holds the Tailwind v4 `@theme` tokens (light and `.dark` sets). `app/focus-theme.css` defines the Focus accent variables (`--focus-*`) with light and dark values, and `app/globals.css` imports both and holds the product-specific classes and breakpoints written against those variables. `components/focus/theme.jsx` wraps the app in next-themes (class attribute, storage key `focus-theme`) and provides the appearance toggle. The `--focus-*` variables are not registered in `@theme`, so they are not available as Tailwind utilities. For new UI prefer Coss token utilities (`bg-muted`, `text-muted-foreground`, `border-border`) or existing product classes, and never hard-code hex colors.
- Two code styles coexist. `lib/`, `scripts/`, `tests/`, and `route.js` are dense one-statement-per-line files; `components/` and `app/*.jsx` are Prettier-formatted. Match the file you are in.

## Repo-specific rules

- Never commit anything under `data/`, `.env*`, or a Google client JSON. Meeting and email content, agent outputs, and the owner's product notes are private.
- Tests use fictional fixtures and mock `global.fetch` (or `t.mock.method`) for providers. Never point a test at a real data dir or account. Manual UI checks against a live archive must not create demo decisions.
- Add a regression test for any observed failure before fixing it.
- Other tools may commit to this checkout while you work. Run `git status` and `git log -3` before editing and again before committing; re-read files that changed.

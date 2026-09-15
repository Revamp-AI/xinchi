# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Focus is a single-owner Next.js 16 app with local and Vercel production modes. It ingests meeting and email context (Fireflies, Granola, Gmail, manual files) into PostgreSQL, runs agent reviews through the signed-in Codex CLI, and keeps a commitment board capped at three active outcomes. Local mode binds to `http://127.0.0.1:3210`. Hosted mode uses the exact HTTPS `XIN_APP_ORIGIN`, Secure host-only cookies, encrypted Postgres provider credentials, and AI Gateway reviews. See `docs/vercel.md`. The repo is public; runtime data, credentials, and the owner's private context never go in it.

## Commands

Node 24+ and PostgreSQL 16+ are required. SQLite is used only by the offline legacy importer. ESLint (`eslint.config.mjs`, a JavaScript-only flat config built from the `@next/eslint-plugin-next` core-web-vitals rules plus the React, React Hooks, and jsx-a11y plugins) and Prettier (`.prettierrc`) are configured; Prettier skips the dense `lib/*.mjs`, `scripts/`, `tests/*.test.mjs`, `app/api/`, and vendored `components/ui/` files (`.prettierignore`). Type checking runs inside `next build` (`tsconfig.json` has `strict: false` and `allowJs`) using the native TypeScript 7 compiler. TypeScript files are not linted because typescript-eslint does not support TypeScript 7 yet; `next build` is what catches type errors in them.

| Task | Command |
|---|---|
| Install | `npm ci` |
| Dev server | `npm run dev` (port 3210; run only one instance) |
| Production | `npm run build && npm start` |
| All tests | `npm test` |
| One test file | `npm test -- tests/system.test.mjs` |
| One test by name | `npm test -- --test-name-pattern="displacement" tests/system.test.mjs` |
| Lint | `npm run lint` |
| Format | `npm run format` (check only: `npm run format:check`) |
| Browser smoke test | `npm run test:e2e` (Playwright; builds and starts the app on port 3210 with a temporary `XIN_DATA_DIR`, so the port must be free; run `npx playwright install chromium` once) |
| Import JSON sources | `npm run import -- /path/to/sources.json` |
| Replace Google client | `node --env-file-if-exists=.env.local scripts/configure-google.mjs client.json` |
| Add a Coss UI component | `npx shadcn@latest add @coss/<name>` (registry alias in `components.json`) |

`.env.local` must set `XIN_ALLOWED_EMAIL` (see `.env.example`). `dev` and `build` pass `--webpack`; keep that unless you have verified Turbopack with `pg` (listed in `serverExternalPackages`) and the Tailwind v4 PostCSS setup. Running the build or the tests creates `data/` as a side effect; it is gitignored.

## Architecture

### Processes and persistence

The Next server, provider sync worker, contact extraction worker and agent worker share asynchronous PostgreSQL helpers in `lib/postgres.mjs`. Every `all`, `one`, `run`, `getSetting`, source write, item write and auth database operation must be awaited. Transactions use AsyncLocalStorage and one checked-out connection. Runtime imports do not run migrations. Run `npm run db:migrate` explicitly; migration tooling lives in `lib/migrations.mjs` and must not be imported by the web app.

`lib/leases.mjs` claims 45-second durable leases and workers heartbeat every 10 seconds. PID fields are diagnostic only. Expired/cancelled workers must not write sources, checkpoints or results; guard writes in a transaction with the current lease. Capacity and contact merges lock `workspace_lock`.

`DATABASE_URL` selects runtime storage; optional `DATABASE_URL_UNPOOLED` selects the migration connection. `focus_auth` holds the pinned owner, hashed sessions, OAuth attempts and sanitized audit, and is excluded from exports. Local `connections.secret.json` and `data/runs/` remain private. Hosted provider credentials use `focus_auth.provider_secrets` and `XIN_SECRETS_KEY`; Google client credentials are environment-only. `secrets()`, `saveSecrets()`, and credential mutations are asynchronous. Do not read or migrate a live personal archive during tests.

`npm test` creates an isolated local Postgres cluster and each test file creates a unique database. `FOCUS_TEST_DATABASE_URL` may point at a dedicated loopback test server. Browser tests also use a temporary Postgres database and fictional fixtures.

Contacts modules separate manual CRUD/policy (`contacts.mjs`), parsing/projection (`contact-extraction.mjs`), audited merge/undo (`contact-identity.mjs`), workers and pure versioned cadence rules (`relationship-rules.mjs`). Cross-provider identity equality suggests review; it does not silently merge. Source versions and contact queues are durable; state is rebuildable. [Contacts behavior](docs/contacts.md) and the [cutover runbook](docs/postgres-cutover.md) describe invariants and limits.

### Source records

`upsertSource()` is the only write path. The id is `provider:external_id`. An unchanged content hash is a no-op; a new hash updates the row, appends a `source_versions` snapshot, and enqueues contact extraction where applicable. PostgreSQL maintains the full-text index. Coverage is ranked (`metadata`/`empty` < `summary` < `document`/`email body` < `transcript` < `deleted upstream`) and a lower-ranked import cannot overwrite a higher-ranked body. Prompts typed into the agent composer are stored as `manual` sources so later reviews can find them.

### Commitment rules live in `saveItem()` (`lib/db.mjs`)

This function is the business-rule center; the UI only mirrors it.

- Statuses: `candidate` (UI label "To decide"), `now`, `waiting`, `later`, `done`, `dropped` (UI label "Closed"). Kinds: `action`, `decision`.
- `now` requires `done_when`, `next_action`, `owner`, `checkpoint`. A fourth `now` item must pass `replace_id`, `tradeoff_reason`, `replace_checkpoint`; the displaced item moves to `later` with a `displaced` event, in the same transaction.
- `waiting` requires `dependency` + `checkpoint`; `later` requires `reason` + `checkpoint`; `dropped` requires `reason`; `done` requires `evidence`. Moving a checkpoint after one was set requires a `reason`.
- `source_quote` must be a verbatim substring of the linked source body. `version` gives optimistic concurrency. Every save writes an `events` row with before/after JSON. `item_contacts` links follow-ups to people without creating a second task ledger.
- Accepting a proposal is just `saveItem({...payload, proposal_id})`. Nothing becomes an item without the user.

### Agent contract (`lib/agent.mjs`, `scripts/worker.mjs`)

`AgentResult` (zod) becomes the JSON Schema used by both the local Codex runner and cloud AI Gateway runner. `validateResult()` rejects the whole result if any citation quote is not a substring of the cited source body or if `existing_item_id` is unknown; a rejected result fails the job and saves nothing. Proposals dedupe by fingerprint (title + first source + existing item). One job runs at a time; imports finishing during a job queue a single `pending_import_review` that the worker drains on exit. `recoverJobs()` fails expired durable leases; the worker times out at 8 minutes and fails any run that never called a context tool. Both runners share the policy in `lib/agent-policy.mjs` and read-only tools in `lib/context-tools.mjs`.

### Auth and request protection (`lib/auth.mjs`)

Google OIDC with PKCE, one owner (`XIN_ALLOWED_EMAIL`; the Google `sub` is pinned on first login). `checkLocalRequest()` requires the exact configured origin host (`127.0.0.1:3210` in local mode; `localhost` is rejected), and every POST needs `Origin: http://127.0.0.1:3210` plus the `X-Xin-Request: 1` header (hosted writes use the configured HTTPS origin). The `api()` / `post()` helpers in `app/workspace.jsx` and `app/login/screen.jsx` add it; any new fetch must too. Only `auth/setup` and `auth/google/start` are unauthenticated POSTs; hosted `auth/setup` is always forbidden. `/api/internal/jobs` requires the cron bearer secret. Text shown to the browser comes exclusively from the fixed strings in `lib/auth-messages.mjs`; never surface raw provider responses. `tests/auth.test.mjs` enumerates protected paths, so add new API paths to those lists.

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

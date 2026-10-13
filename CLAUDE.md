# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Focus is a single-owner Next.js 16 app with local and Vercel production modes. It ingests meeting, email, calendar and chat context (Fireflies, Granola, Gmail, Google Calendar, Beeper, manual files) and contacts (LinkedIn, Apple Contacts, CSV) into PostgreSQL, runs agent reviews that propose evidence-backed commitments and priority changes, keeps a commitment board capped at three active outcomes, and exposes the workspace to Codex through an authenticated remote MCP server. Local mode binds to `http://127.0.0.1:3210` and reviews through the signed-in Codex CLI. Hosted mode uses the exact HTTPS `XIN_APP_ORIGIN`, Secure host-only cookies, encrypted Postgres provider credentials, and AI Gateway or ChatGPT-subscription reviews. See `docs/vercel.md`. The repo is public; runtime data, credentials, and the owner's private context never go in it.

## Commands

Node 24+ and PostgreSQL 16+ are required. SQLite is used only by the offline legacy importer. ESLint (`eslint.config.mjs`, a JavaScript-only flat config built from the `@next/eslint-plugin-next` core-web-vitals rules plus the React, React Hooks, and jsx-a11y plugins) and Prettier (`.prettierrc`) are configured; Prettier skips the dense `lib/*.mjs`, `scripts/`, `tests/*.test.mjs`, `app/api/`, and vendored `components/ui/` files (`.prettierignore`). Type checking runs inside `next build` (`tsconfig.json` sets `strict`, `noUncheckedIndexedAccess` and `allowJs`) using the native TypeScript 7 compiler. Node runs `lib/*.ts` directly by stripping types, so relative imports name the `.ts` file and type-only imports use `import type`. TypeScript files are not linted because typescript-eslint does not support TypeScript 7 yet; `next build` is what catches type errors in them.

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
| One browser spec | `npm run test:e2e -- mcp.spec.ts` (add `--project=desktop-chromium` to skip the phone-width run) |
| Generate a migration | `npm run db:generate` after editing `lib/schema/`; review the SQL it writes to `drizzle/` |
| Apply migrations | `npm run db:migrate` (never runs implicitly; never `drizzle-kit migrate` or `push`) |
| Import JSON sources | `npm run import -- /path/to/sources.json` |
| Import contacts | `node --env-file-if-exists=.env.local scripts/import-linkedin.mjs Connections.csv` (or `import-apple-contacts.mjs Contacts.abbu`); prints a preview and writes only with `--apply` |
| Replace Google client | `node --env-file-if-exists=.env.local scripts/configure-google.mjs client.json` |
| Add a Coss UI component | `npx shadcn@latest add @coss/<name>` (registry alias in `components.json`) |

`.env.local` must set `XIN_ALLOWED_EMAIL` (see `.env.example`). `dev` and `build` pass `--webpack`; keep that unless you have verified Turbopack with `pg` (listed in `serverExternalPackages`) and the Tailwind v4 PostCSS setup. Running the build or the tests creates `data/` as a side effect; it is gitignored.

## Architecture

### Runtime modes and routing

`lib/runtime.mjs` derives the mode flags; branch on them rather than raw env. `HOSTED` means an HTTPS `APP_ORIGIN`. `CLOUD_JOBS` (Vercel, or `XIN_AGENT_MODE=cloud`) replaces the detached local workers with Workflows and in-process cloud reviews. `POSTGRES_SECRETS` keeps encrypted credentials in Postgres instead of `data/connections.secret.json`.

Nearly every `/api/*` endpoint is a path-string branch inside the catch-all `app/api/[...path]/route.js` (one `GET`, one `POST`). The routes outside it carry their own auth: `app/api/internal/jobs` (cron bearer), `app/api/beeper/device/[action]` (paired-companion credential), `app/api/mcp/[action]` (OAuth register/token/authorize/revoke) and `app/mcp/route.js` (the MCP Streamable HTTP endpoint). In cloud mode, writes call `after()` → `drainCloudWork()` (`lib/cloud-jobs.mjs`), which reconciles Workflow runs, expires leases, dispatches ingestion and runs at most one queued review. The per-minute Vercel cron does the same and also runs `scheduleProviderSyncs()` (`lib/scheduled-sync.ts`: Granola, Fireflies, Gmail and Calendar after five idle minutes; failed runs retry hourly, permanent failures daily) plus contact matching and intelligence.

### Processes and persistence

The Next server, provider sync worker, contact extraction worker and agent worker share `lib/postgres.ts`. All queries use its transaction-aware Drizzle `db` against the schema in `lib/schema/`; the raw `all`, `one` and `run` helpers remain only for the exceptions listed in the [database guide](docs/database.md). Every query, `getSetting`, source write, item write and auth database operation must be awaited. Show database failures through `databaseErrorCode()` and a fixed message, never the error text. Transactions use AsyncLocalStorage and one checked-out connection. Runtime imports do not run migrations. Run `npm run db:migrate` explicitly; migration tooling lives in `lib/migrations.ts` and must not be imported by the web app. Change the schema in `lib/schema/` and generate a migration into `drizzle/` with `npm run db:generate`; the numbered files in `migrations/` are frozen.

Local workers and cloud reviews use `lib/leases.ts` with 45-second leases and 10-second heartbeats. Hosted ingestion and contact extraction use `workflows/ingestion.js`: each bounded step commits source writes and its cursor atomically in Neon. `lib/durable-ingestion.ts` fences dispatch ownership, step revisions and 120-second unit leases so replay and late workers cannot repeat a commit. Durable waits are exempt from legacy lease expiration; cron reconciles confirmed terminal Workflow runs and offers resumable failures. PID fields are diagnostic only. Capacity, ingestion commits and contact merges lock `workspace_lock`.

`DATABASE_URL` selects runtime storage; optional `DATABASE_URL_UNPOOLED` selects the migration connection. `focus_auth` holds the pinned owner, hashed sessions, OAuth attempts and sanitized audit, and is excluded from exports. Local `connections.secret.json` and `data/runs/` remain private. Hosted provider credentials use `focus_auth.provider_secrets` and `XIN_SECRETS_KEY`; Google client credentials are environment-only. `secrets()`, `saveSecrets()`, and credential mutations are asynchronous. Do not read or migrate a live personal archive during tests.

`npm test` creates an isolated local Postgres cluster and each test file creates a unique database. `FOCUS_TEST_DATABASE_URL` may point at a dedicated loopback test server. Browser tests also use a temporary Postgres database and fictional fixtures.

`FOCUS_E2E_DURABLE=1 npm run test:e2e -- workflow.spec.ts --project=desktop-chromium` verifies the compiled Workflow runtime with fictional uploads and contact extraction. Its temporary local Workflow world and review blocker prevent production queue access or model invocation. Manual hosted uploads use authenticated chunks and private staging tables; Workflow inputs and outputs contain opaque IDs, revisions and completion/retry metadata, never source content or credentials.

Contacts modules separate manual CRUD/policy (`contacts.ts`), parsing/projection (`contact-extraction.ts`), audited merge/undo (`contact-identity.ts`), workers and pure versioned cadence rules (`relationship-rules.mjs`). LinkedIn and Apple imports create contact-profile sources that automatic reviews skip. Cross-provider identity equality suggests review; it does not silently merge. Source versions and contact queues are durable; state is rebuildable. [Contacts behavior](docs/contacts.md) and the [cutover runbook](docs/postgres-cutover.md) describe invariants and limits.

### Providers

- Beeper: `public/beeper-companion.mjs` is a standalone script the owner downloads and runs on their Mac as a LaunchAgent. It imports only Node built-ins and must stay self-contained. It uploads pages of at most 25 messages through the device routes into Postgres staging; the durable ingestion workflow then imports them. See `docs/beeper-setup.md`.
- Granola keys are workspace-scoped, so one sync enumerates several named keys (`lib/granola-connections.mjs`). Keys are resolved from encrypted storage on each step and never enter Workflow checkpoints or public connection state.
- Fireflies imports only meetings with the owner as participant (`XIN_FIREFLIES_PARTICIPANT_EMAIL`, else `XIN_ALLOWED_EMAIL`), never an unfiltered account, using windows that overlap the previous snapshot by seven days. See `docs/meeting-sync.md` and `docs/fireflies-sync.md`.
- Google Calendar shares the Google sign-in (`calendar.events.readonly`, consented independently of Gmail; `lib/calendar.ts`). Calendar sources skip contact extraction, and attendance alone never creates a hard deadline.

### Source records

`upsertSource()` is the only write path. The id is `provider:external_id`. An unchanged content hash is a no-op; a new hash updates the row, appends a `source_versions` snapshot, and enqueues contact extraction where applicable. PostgreSQL maintains the full-text index. Coverage is ranked (`metadata`/`empty` < `summary` < `document`/`email body` < `transcript` < `deleted upstream`) and a lower-ranked import cannot overwrite a higher-ranked body. Prompts typed into the agent composer are stored as `manual` sources so later reviews can find them.

### Commitment rules live in `saveItem()` (`lib/db.ts`)

This function is the business-rule center; the UI only mirrors it.

- Statuses: `candidate` (UI label "To decide"), `now`, `waiting`, `later`, `done`, `dropped` (UI label "Closed"). Kinds: `action`, `decision`.
- `now` requires `done_when`, `next_action`, `owner`, `checkpoint`. A fourth `now` item must pass `replace_id`, `tradeoff_reason`, `replace_checkpoint`; the displaced item moves to `later` with a `displaced` event, in the same transaction.
- `waiting` requires `dependency` + `checkpoint`; `later` requires `reason` + `checkpoint`; `dropped` requires `reason`; `done` requires `evidence`. Moving a checkpoint after one was set requires a `reason`.
- `source_quote` must be a verbatim substring of the linked source body. `version` gives optimistic concurrency. Every save writes an `events` row with before/after JSON. `item_contacts` links follow-ups to people without creating a second task ledger.
- Accepting a proposal is just `saveItem({...payload, proposal_id, proposal_version})`; the version rejects a stale suggestion. Nothing becomes an item without the user.

### Agent contract (`lib/agent.ts`, `scripts/worker.ts`)

`AgentResult` (zod) becomes the JSON Schema used by every review runner. Locally, `scripts/worker.ts` spawns `codex exec` in a read-only sandbox with `scripts/context-mcp.mjs` as its stdio tool server. In cloud mode, `lib/cloud-agent.ts` runs an AI SDK tool loop on the model chosen in `lib/review-settings.mjs`: AI Gateway (`XIN_AGENT_MODEL`), or a ChatGPT subscription through Codex device OAuth (`lib/codex-http.mjs`, `lib/codex-model.mjs`, `docs/chatgpt-reviews.md`). `validateResult()` rejects the whole result if any citation quote is not a substring of the cited source body or if `existing_item_id` is unknown; a rejected result fails the job and saves nothing. `lib/proposals.ts` owns proposal triage. Automatic proposals need a structured qualification (`validateQualification()`); verbal promises must cite a meeting transcript. Proposals dedupe by fingerprint (title + first source + existing item), stable `deliverable_key`, or the same cited promise, including dismissed ones. At most ten stay pending and the rest are `deferred`. Reviews may dismiss an open suggestion only with cited evidence, recorded in `proposal_events`. See `docs/commitment-triage.md`. One job runs at a time; imports finishing during a job queue a single `pending_import_review` that the worker drains on exit, and `takePendingImportReview()` also starts daily `backlog_review` jobs that recheck at most three open suggestions each. `recoverJobs()` fails expired durable leases; the worker times out at 8 minutes and fails any run that never called a context tool. All runners share the policy in `lib/agent-policy.mjs` and read-only tools in `lib/context-tools.ts`.

`queueSourceReview()` (`lib/review-batches.ts`) adds a changed source to `review_queue` only if it is from the last 30 days, already linked to an item, or cited by a pending or deferred proposal. Each review reads a bounded batch (at most 6 sources and 60,000 characters, paged by offset) plus the priority inventory.

### Priorities (`lib/priorities.ts`)

Three fixed stacks (`deal-flow`, `product`, `go-to-market`). Manual order is authoritative and version-checked. Reviews may attach cited updates, checked against immutable source snapshots, but cannot change owner, financials, notes or order. Next-decision changes, rank changes and new priorities become pending `priority_suggestions` that the user applies or dismisses, with at most six new-priority suggestions pending. Applying one checks the priority's version so a stale suggestion cannot overwrite a manual edit.

### Remote MCP server (`lib/mcp-server.mjs`, `lib/mcp-tools.ts`, `lib/mcp-auth.ts`)

`mcp-tools.ts` holds the tool catalog with zod input schemas and calls the same `lib/` functions as the HTTP routes, so `saveItem()`, priority and contact rules still apply. Every write tool requires an `idempotency_key`, and its cached result commits with the change. Updates need the record's current `version`, and merges need a preview token. `mcp-auth.ts` implements OAuth with dynamic client registration, PKCE S256, `focus:read`/`focus:write` scopes, and hashed tokens in `focus_auth`. Tool results never include provider credentials or OAuth tokens. See `docs/mcp-setup.md`.

### Auth and request protection (`lib/auth.ts`)

Google OIDC with PKCE, one owner (`XIN_ALLOWED_EMAIL`; the Google `sub` is pinned on first login). `checkLocalRequest()` requires the exact configured origin host (`127.0.0.1:3210` in local mode; `localhost` is rejected), and every POST needs `Origin: http://127.0.0.1:3210` plus the `X-Xin-Request: 1` header (hosted writes use the configured HTTPS origin). The `api()` / `post()` helpers in `app/workspace.jsx` and `app/login/screen.jsx` add it; any new fetch must too. In the catch-all router, only `auth/setup` and `auth/google/start` are unauthenticated POSTs; hosted `auth/setup` is always forbidden. `/api/internal/jobs` requires the cron bearer secret. Text shown to the browser comes exclusively from the fixed strings in `lib/auth-messages.mjs`; never surface raw provider responses. `tests/auth.test.mjs` enumerates protected catch-all paths, so add new API paths to those lists; MCP and Beeper device auth are covered in `tests/mcp.test.mjs` and `tests/beeper.test.mjs`.

### UI

- `app/workspace.jsx` owns all client state and the `api()` helper. The seven views (`agent` = Overview, `priorities`, `board` = Commitments, `contacts`, `library`, `connections`, `settings`) are selected by URL hash. `components/focus/*.jsx` are presentational views and dialogs that receive callbacks. Which dialog is open is decided by which state object is non-null (`editing`, `source`, `trace`, `events`, `setup`).
- `components/ui/*.tsx` are vendored Coss UI registry files (MIT; see `components/ui/README.md`). Only import aliases were changed. Re-add from the `@coss` registry rather than restyling them by hand.
- Styling: `app/coss.css` holds the Tailwind v4 `@theme` tokens (light and `.dark` sets). `app/focus-theme.css` defines the Focus accent variables (`--focus-*`) with light and dark values, and `app/globals.css` imports both and holds the product-specific classes and breakpoints written against those variables. `components/focus/theme.jsx` wraps the app in next-themes (class attribute, storage key `focus-theme`) and provides the appearance toggle. The `--focus-*` variables are not registered in `@theme`, so they are not available as Tailwind utilities. For new UI prefer Coss token utilities (`bg-muted`, `text-muted-foreground`, `border-border`) or existing product classes, and never hard-code hex colors. The one exception is the Priorities view (`priorities-view.jsx`, `priorities.css`), which uses Radix Themes (`@radix-ui/themes`, stylesheet loaded in `app/layout.jsx`) scoped to match the workspace appearance.
- Two code styles coexist. `lib/*.mjs`, `scripts/`, `tests/`, and `route.js` are dense one-statement-per-line files; `components/`, `app/*.jsx` and `lib/**/*.ts` are Prettier-formatted. Match the file you are in.

## Repo-specific rules

- Never commit anything under `data/`, `.env*`, or a Google client JSON. Meeting and email content, agent outputs, and the owner's product notes are private.
- Tests use fictional fixtures and mock `global.fetch` (or `t.mock.method`) for providers. Never point a test at a real data dir or account. Manual UI checks against a live archive must not create demo decisions.
- Add a regression test for any observed failure before fixing it.
- Other tools may commit to this checkout while you work. Run `git status` and `git log -3` before editing and again before committing; re-read files that changed.

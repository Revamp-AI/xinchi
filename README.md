# Focus

A single-owner Next.js app backed by PostgreSQL for turning meeting and email context into evidence-backed priorities and explicit commitments.

The public repository contains application code, fictional test fixtures, and setup documentation. It starts with an empty workspace. Personal recordings, transcripts, analysis, databases, agent outputs, screenshots, credentials, and session archives are not included.

## Interface

The existing workspace shell and Google sign-in use [Coss UI](https://coss.com/ui), built on Base UI and Tailwind CSS. Official registry components live in `components/ui/`; Focus views compose them in `components/focus/`. The registry alias is configured in `components.json`. Coss's neutral design tokens and locally bundled Inter font are in `app/coss.css`, with responsive product layouts in `app/globals.css`. The upstream MIT notice is retained alongside the components.

Overview puts the agent prompt and reviewable proposals first. Commitments keeps the three-outcome limit and decision history. Contacts adds a personal CRM, relationship heat map, source-backed timelines, identity review, and private message drafts. Context library provides source search, provider filters, pagination, and original-text previews. Connections shows stored counts, coverage, import progress, retry messages, and storage details. Mobile navigation uses the Coss sidebar sheet. The Priorities screen and its Overview summary use WorkOS Radix Themes, scoped to match the workspace appearance.

For a quick interface check, navigate all seven views, switch commitment tabs, open and cancel an editor, filter/search the library including an empty result, open a source, and open/cancel Gmail settings. Check the same flows at a narrow phone width. Use an isolated test workspace for any test writes; do not create demo decisions in a live personal archive.

The appearance button in the top-right corner of the workspace and sign-in screen offers **Light**, **Dark**, and **System**. System follows the device preference by default. An explicit choice is remembered per browser in local storage (`focus-theme`) and applied before the page paints. Theme handling uses [next-themes](https://github.com/pacocoursey/next-themes); Coss tokens style shared controls, and `app/focus-theme.css` supplies matching product colors. This preference does not change workspace data or authentication.

To verify appearance changes, choose Dark, reload, and confirm Dark remains selected. Check Light and System, a source preview, a commitment dialog, and mobile navigation. Theme validation does not require creating or saving any commitments.

## Priorities

`#priorities` contains Deal flow, Product, and Go-to-market stacks. Drag handles or move controls change the order of priorities and stacks; that manual order is authoritative. The Overview shows the first active priority in each stack. The detail panel holds owner, financials, next decision, a linked commitment, notes, dated updates and exact source citations. Complete and restore priorities without deleting their history.

New or changed sources already enter the bounded review queue. Each review now reads the priority inventory and can attach relevant cited context automatically. The configured review provider/model stays unchanged. Citations are checked against immutable source snapshots before anything is saved. Older evidence cannot replace a newer latest update. The AI cannot silently change owner, financials, notes, next decision or order; next-decision/rank changes and new priorities remain apply/dismiss suggestions. At most six new-priority suggestions can be pending. Applying a change checks the priority's version so a stale suggestion cannot overwrite a manual edit.

Creating a priority, changing its title/keywords/linked commitment, restoring it, or choosing **Review context** queues up to twelve matching sources from the last 30 days, plus the linked commitment's source if it is among the returned records. Context review resumes in bounded pages with retries. If a matching page is already running, it is revisited after that review completes. **Suggest from meetings** starts a review of recent archive material to propose initial priorities. This feature depends on successful provider imports and a working configured AI review connection; the screen reports active or interrupted reviews.

Priority CRUD, manual ordering, updates, archive review, and suggestion decisions are also available through the authenticated Focus MCP server with the same version checks, write permissions and idempotency guarantees as commitments. Priority tables are included in the workspace export. Migration `014_priorities.sql` is additive and creates empty stacks, never example company data.

## Requirements

- Node.js 24 or later.
- PostgreSQL 16+ or a Neon database. Local PostgreSQL tools are also used for isolated tests.
- Local mode: Codex CLI installed and signed in on the same Mac for agent reviews. Hosted mode: Vercel AI Gateway model access.
- A Google Cloud project for Google login and read-only Gmail access.
- Optional Fireflies and Granola API keys for live meeting imports.

## Deploy to Vercel

Follow the [production deployment guide](docs/vercel.md) for HTTPS authentication, encrypted credential storage, AI Gateway reviews, and durable ingestion through Vercel Workflows.

## Run locally

```sh
npm ci
cp .env.example .env.local
```

Edit `.env.local` and replace `owner@example.com` in `XIN_ALLOWED_EMAIL` with the Google account that should own this workspace. This is required: the app refuses sign-in when no owner is configured. It never grants ownership to an arbitrary first visitor.

Set `DATABASE_URL` to your private Postgres/Neon connection string (and `DATABASE_URL_UNPOOLED` for a direct migration connection if needed). Existing SQLite workspaces must follow the [cutover guide](docs/postgres-cutover.md) before starting the new app.

```sh
npm run db:migrate
npm run build
npm start
```

Open http://127.0.0.1:3210. The **Open Focus.command** launcher can also start the app on macOS. Use `npm run dev` for development; only run one instance on this port.

## Google login and Gmail

1. Enable the Gmail API in your Google Cloud project.
2. Configure the consent screen for your internal Workspace organization, or add the owner account as a test user for an external testing app.
3. Create an OAuth client of type **Web application**.
4. Add this exact authorized redirect URI: `http://127.0.0.1:3210/api/auth/google/callback`.
5. Download the client JSON, upload it on the Focus login screen, and choose **Continue with Google**.

The requested scopes are `openid email profile https://www.googleapis.com/auth/gmail.readonly`. Google login is restricted to `XIN_ALLOWED_EMAIL`; the first successful login also pins the stable Google account ID. All workspace APIs, exports, and agent actions require an authenticated session. Sessions expire after 12 hours; sign-out revokes browser access.

Gmail consent is requested in the same flow. Successful authorization saves background access and attempts to start an import. If another import is running, use Connections → Refresh later. You can decline Gmail access and still sign in. Sign-out does not revoke the Gmail grant or interrupt a running import.

Gmail setup errors no longer block a verified Google login. Connections shows **Needs attention** and an actionable explanation. If the Gmail API is disabled, enable it in the same Google Cloud project, then choose **Refresh**; the approved grant is retained in private credential storage. A successful reconnect or import clears the warning. Account mismatches still block sign-in.

Login failures distinguish expired browser flows, rejected clients or codes, identity verification, and network failures. The private `auth_events` table records stage, outcome, safe error category, HTTP status, and recognized provider/JWT reason codes. It never records tokens, authorization codes, OAuth URLs, or raw provider responses, and it is excluded from workspace exports.

The first client upload is accepted only from this local app's origin and only before a client is configured. To replace it later, run:

```sh
node --env-file-if-exists=.env.local scripts/configure-google.mjs /path/to/google-client.json
```

Replacing the client revokes existing browser sessions and pending login attempts. Keep the downloaded JSON outside the repository.

## Import context

In **Connections**, configure Fireflies or Granola and choose Refresh. Fireflies filters meetings by `XIN_FIREFLIES_PARTICIPANT_EMAIL`, falling back to `XIN_ALLOWED_EMAIL`; it never silently imports an unfiltered account. Granola uses a Personal API key, subject to the provider's plan and workspace policy.

The context library accepts `.txt`, `.md`, and normalized JSON documents. Hosted uploads send small text chunks, then queue the import so the browser can close once the upload finishes. Connections shows upload and import progress. Hosted limits are 64 MiB of UTF-8 input, 5,000 source records, and 20 MiB per normalized record including its retained raw evidence. The whole file is validated before any source is written; successful imports remove temporary staging. Interrupted uploads must be selected again.

JSON can also be imported locally:

```sh
npm run import -- /path/to/sources.json
```

A fictional normalized record looks like this:

```json
[
  {
    "provider": "manual",
    "external_id": "example-note-1",
    "title": "Release planning",
    "occurred_at": "2026-01-15",
    "body": "The next release needs a checklist and a review date.",
    "coverage": "document"
  }
]
```

Stable provider IDs make repeated imports idempotent; changed source snapshots are retained. The CLI also accepts a workspace export's `sources` array or a supported research-archive JSON structure. It restores source records, not commitment/session state. CLI imports do not launch an agent; ask for a review in the app afterward.

## Agent and commitments

The agent searches source text, reads full source pages, reviews previous requests and decisions, and proposes work with exact source excerpts. It has a narrow read-only context tool interface. It cannot accept commitments, send messages, mutate provider data, or execute arbitrary shell commands through its tools.

Proposals require your review. The board allows up to three active outcomes; a fourth requires explicit displacement. Accepted outcomes need a defined finish, next action, owner, and checkpoint. Deferrals, waiting dependencies, and completion evidence are recorded with decision history.

UI/provider imports trigger an agent review or queue a follow-up behind the current review. Hosted imports finish contact extraction before requesting that review. Local reviews use the Codex CLI's existing account sign-in and usage allowance; hosted reviews use billable AI Gateway model calls.

## Storage and sync status

The app runs locally or on Vercel. Hosted imports and contact extraction use Vercel Workflows; reviews use AI Gateway in a separate worker. Each ingestion step makes at most one provider request and saves at most one complete source, with its progress checkpoint committed atomically in PostgreSQL. Workflow retries can resume across function invocations without restarting a full backfill. Local mode retains its detached import, extraction, and Codex workers.

Sources, source snapshots, commitments, relationship records, state history, drafts and worker coordination live in your configured PostgreSQL database. Neon can host that database remotely. Authentication uses the restricted `focus_auth` schema, excluded from workspace exports.

In local mode, the ignored private `data/` directory holds `connections.secret.json` (provider credentials and Google tokens) and `runs/` (agent output). `XIN_DATA_DIR` selects another private directory. Hosted credentials are encrypted in PostgreSQL. Temporary file chunks, staged records, and ingestion cursors also stay in the private database and are excluded from workspace exports. **Do not commit runtime data or connection strings.** Exports omit credentials and authentication but include private source and relationship material.

See [Postgres setup, migration, backup and recovery](docs/postgres-cutover.md) and [Contacts behavior and limits](docs/contacts.md). Existing SQLite archives are retained read-only after cutover. Use PostgreSQL backups and verified restore procedures for the active database.

Connections shows stored coverage and upload, queued, running, complete, partial, or failed states. Progress counts processed records, including unchanged records. Hosted Gmail backfills advance through message pages automatically, then use incremental history for the default scope; custom queries rescan. Granola checkpoints individual notes and transcript pages. Fireflies checkpoints one transcript at a time within its participant scope and fixed scan boundary. Local Gmail backfills retain their existing limit of up to 1,000 messages per refresh.

Hosted transient provider failures retry with durable waits; provider retry delays are honored up to 24 hours per wait. Permanent validation/authentication failures or 12 consecutive failures at the same position require attention. **Retry import** resumes a failed hosted run from its saved position after the underlying problem is fixed. A cron checks for Workflow runs that ended without updating Focus and makes them available for retry. It also dispatches queued work every minute; it does not start new periodic provider scans.

## Current limits

- Single owner only; no multi-user data isolation. Local mode binds to `127.0.0.1:3210`; hosted mode accepts only its configured HTTPS origin.
- HttpOnly, SameSite=Lax session cookies on loopback HTTP; hosted sessions additionally use Secure, host-only cookies and an exact HTTPS origin.
- Local files are not separately encrypted by the app; OS account and disk protections still matter.
- Text ingestion only: recording media and email attachment contents are not downloaded. Attachment names are retained.
- Hosted provider responses, checkpoints, and normalized records are limited to 8 MiB each. Very large records need a smaller export; durable execution does not remove per-record limits.
- Exact excerpts establish provenance, not the truth of statements or the correctness of model interpretation.
- No scheduled provider polling, proactive failure alerts, full ingestion-history UI, or automatic backup service.
- Live Google/provider setup requires your own credentials. Tests use fictional fixtures and simulated provider responses; they do not verify a particular live account.

## Validation

```sh
npm test
npm run lint
npm run format:check
npm run build
npm run test:e2e
```

`npm test` starts a disposable local Postgres cluster, creates one database per test file, and removes it afterward. Install local PostgreSQL 16+ tools (`initdb`, `pg_ctl`, `pg_dump`, `pg_restore`) or set `FOCUS_TEST_DATABASE_URL` to a dedicated loopback test server. Tests refuse remote database targets.

Tests use isolated temporary databases and cover Google token verification, owner restrictions, session/callback security, protected endpoints, imports, source history, quote validation, commitment rules, and sync recovery, migration fidelity, snapshot citations, contact identity/merge undo, cadence classification, and concurrent capacity.

`npm run lint` runs ESLint with the Next.js core-web-vitals rules. `npm run format:check` verifies Prettier formatting for `app/`, `components/focus/`, `hooks/`, and the TypeScript helpers in `lib/`; `npm run format` rewrites them. `npm run test:e2e` builds the app, starts it on `127.0.0.1:3210` with a temporary data directory seeded with fictional sources and a signed-in owner session, and drives all seven views in desktop and phone-width Chromium. It refuses to run while anything else listens on port 3210, so stop a running Focus first. Run `npx playwright install chromium` once before the first run.

To exercise real compiled Workflow steps locally, including file upload, source persistence, contact extraction, and staging cleanup:

```sh
FOCUS_E2E_DURABLE=1 npm run test:e2e -- workflow.spec.ts --project=desktop-chromium
```

This check uses a disposable loopback database and fictional records. It verifies that a review is queued without making a model call or contacting live providers.

Technical references: [Next.js](https://nextjs.org/docs/app/getting-started/installation), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Fireflies transcript queries](https://docs.fireflies.ai/graphql-api/query/transcripts), [Granola API](https://docs.granola.ai/introduction), and [jose verification](https://github.com/panva/jose).

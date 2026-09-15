# Vercel production

Focus supports a single-owner HTTPS deployment on Vercel with Neon persistence. The hosted app uses Vercel Workflows for ingestion and contact extraction, plus separate cloud AI reviews. It does not require a Mac or Codex CLI to stay running. Local mode retains its original detached workers and Codex runner.

## Configuration

Link the intended Vercel team/project, then configure these **production-only** variables:

- `DATABASE_URL`: the pooled Neon connection with verified TLS.
- `XIN_APP_ORIGIN`: the exact production HTTPS origin, without a path.
- `XIN_ALLOWED_EMAIL`: the sole Google account allowed to sign in.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: a Google OAuth **Web application** client. Authorize `${XIN_APP_ORIGIN}/api/auth/google/callback` in Google Cloud and enable the Gmail API. Gmail consent is optional for workspace sign-in.
- `XIN_SECRET_STORAGE=postgres` and `XIN_SECRETS_KEY`: a random 32-byte base64url key. Back it up separately from the database; losing this key makes stored provider credentials unrecoverable.
- `CRON_SECRET`: a random secret for Vercel's scheduled dispatch, recovery, and review worker.
- `XIN_AGENT_MODE=cloud`, optional `XIN_AGENT_MODEL` (defaults to `openai/gpt-6-astra`), and optional `XIN_TIME_ZONE` for server calendar dates.

AI Gateway uses Vercel OIDC automatically in production. Ensure the team has model access and sufficient credits. `AI_GATEWAY_API_KEY` is an optional alternative for a non-Vercel cloud runner. Model calls are billable and token usage is recorded per review in `jobs.usage_json`.

The app fails closed while Google credentials are missing. Public visitors cannot upload or replace the hosted OAuth client. Sessions use Secure, HttpOnly, host-only cookies, and writes require the configured origin plus the application request header.

## Deploy

Apply migrations through the direct Neon connection with `npm run db:migrate`, including migration 006 for Workflow coordination and temporary upload staging and 007 for one active import per provider. Then run `npm test`, `npm run test:e2e`, and `npm run build`. Browser tests create fictional records in disposable loopback PostgreSQL databases. They never target production.

Run the dedicated compiled-Workflow browser check before deploying ingestion changes:

```sh
FOCUS_E2E_DURABLE=1 npm run test:e2e -- workflow.spec.ts --project=desktop-chromium
```

It exercises upload → Workflow steps → sources → contact extraction → queued review and verifies staging cleanup, without calling a model or live provider.

Deploy source with `vercel deploy --prod` from the linked checkout. `.vercelignore` excludes local credentials, archives, backups, and fixtures. Do not copy production credentials into preview environments. A preview needs its own database and exact HTTPS origin before it can be used.

## Background work

User requests enqueue work in PostgreSQL and start a Vercel Workflow after the response. The authenticated cron dispatches queued work every minute as a fallback. A Workflow advances through small steps: at most one provider API call and one complete source per step, or one source for contact extraction. File validation is a separate staging step. Source writes and progress changes commit together in Neon; revision and ownership checks prevent duplicate deliveries or an old worker from applying a step twice. Workflow arguments and outputs contain coordination identifiers and status, while source text and cursors stay in PostgreSQL.

Gmail, Fireflies, Granola, and manual files have independent import slots. A running or retrying provider does not block another provider. Duplicate runs for the same provider remain blocked by both admission checks and a database constraint; contact extraction and AI review each retain their own single shared worker.

Gmail saves pending message IDs and history/page positions, Granola saves note and transcript-page progress, and Fireflies saves its participant scope, fixed scan boundary, and transcript offset. A hosted backfill continues across function invocations until its pages are exhausted. Imports with changed sources queue contact extraction; extraction then requests a separate AI review. Cron continues requested jobs rather than initiating new scheduled provider scans.

Transient provider failures use durable exponential waits, honoring provider retry delays up to 24 hours per wait. A successful step resets the failure count. Permanent errors or 12 consecutive failures at one position mark the import failed with a safe message in Connections. After correcting the connection or input, **Retry import** resumes its saved position. Workflow step execution also has bounded infrastructure retries. Cron reconciles Workflow runs that terminated without updating Focus so they do not remain shown as running indefinitely; these runs are available for manual retry.

Individual steps still have limits: provider requests time out after 45 seconds, provider responses/checkpoints/records are capped at 8 MiB, and durable database transactions have bounded statement and lock waits. A single oversized record needs a smaller export. Reviews remain separate Node.js functions with the configured 800-second maximum; they stop after eight minutes or twelve model steps, with bounded tool output and read-only tools. Every result is citation-validated before saving; proposals remain unaccepted and message drafts remain unsent.

## Manual uploads

The hosted library uploads UTF-8 text or JSON in small chunks, then returns once ingestion is queued. Keep the browser open during upload; afterward the Workflow can finish without it. Limits are 64 MiB of input, 5,000 source records, and 20 MiB per normalized `{doc, raw}` record. The retained raw evidence counts toward that record limit. The entire archive is validated before source ingestion starts, and each following step imports one staged record.

Chunks, records, and cursors live in private PostgreSQL tables excluded from workspace exports. Successful imports remove upload staging. The client cancels incomplete uploads on errors when possible; abandoned uploads expire after 24 hours and must be selected again. Failed imports retain their saved source position for retry. Validation failures require a corrected file rather than repeating the same invalid input.

## Credentials and recovery

Provider keys and Gmail refresh/access tokens use AES-256-GCM encryption in `focus_auth.provider_secrets`. Updates serialize to preserve concurrent credential changes. The encryption key lives in server environment secrets. Google client credentials stay in server environment variables. None of these appear in workspace exports or model tools.

Keep PostgreSQL backups and the encryption key in separate private storage. A restored database needs the same encryption key, Google client configuration, owner allowlist, and production callback origin. Invalidate restored sessions and OAuth attempts before opening a recovered workspace. See [the Postgres runbook](postgres-cutover.md).

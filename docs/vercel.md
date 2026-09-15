# Vercel production

Focus supports a single-owner HTTPS deployment on Vercel with Neon persistence. The hosted app uses cloud AI reviews and serverless import/extraction workers. It does not require a Mac or Codex CLI to stay running. Local development can still use the original Codex runner.

## Configuration

Link the intended Vercel team/project, then configure these **production-only** variables:

- `DATABASE_URL`: the pooled Neon connection with verified TLS.
- `XIN_APP_ORIGIN`: the exact production HTTPS origin, without a path.
- `XIN_ALLOWED_EMAIL`: the sole Google account allowed to sign in.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: a Google OAuth **Web application** client. Authorize `${XIN_APP_ORIGIN}/api/auth/google/callback` in Google Cloud and enable the Gmail API. Gmail consent is optional for workspace sign-in.
- `XIN_SECRET_STORAGE=postgres` and `XIN_SECRETS_KEY`: a random 32-byte base64url key. Back it up separately from the database; losing this key makes stored provider credentials unrecoverable.
- `CRON_SECRET`: a random secret for Vercel's scheduled worker.
- `XIN_AGENT_MODE=cloud`, optional `XIN_AGENT_MODEL` (defaults to `openai/gpt-6-astra`), and optional `XIN_TIME_ZONE` for server calendar dates.

AI Gateway uses Vercel OIDC automatically in production. Ensure the team has model access and sufficient credits. `AI_GATEWAY_API_KEY` is an optional alternative for a non-Vercel cloud runner. Model calls are billable and token usage is recorded per review in `jobs.usage_json`.

The app fails closed while Google credentials are missing. Public visitors cannot upload or replace the hosted OAuth client. Sessions use Secure, HttpOnly, host-only cookies, and writes require the configured origin plus the application request header.

## Deploy

Apply migrations through the direct Neon connection with `npm run db:migrate`, then run `npm test`, `npm run test:e2e`, and `npm run build`. Browser tests create fictional records in disposable loopback PostgreSQL databases. They never target production.

Deploy source with `vercel deploy --prod` from the linked checkout. `.vercelignore` excludes local credentials, archives, backups, and fixtures. Do not copy production credentials into preview environments. A preview needs its own database and exact HTTPS origin before it can be used.

## Background work

User requests enqueue durable PostgreSQL jobs and schedule work after the response. An authenticated Vercel cron invocation drains pending queues every minute as a fallback. Leases prevent concurrent invocations from claiming the same run. The three queues process reviews, provider imports, and contact extraction independently.

Functions allow up to 800 seconds on the configured Pro team. Reviews stop after eight minutes or twelve model steps, with bounded tool output and read-only tools. Every result is citation-validated before it is saved; proposals remain unaccepted and message drafts remain unsent.

Imports and extraction yield before their seven-minute execution budget, release their lease, and continue from durable checkpoints in a later invocation. Fireflies retains its pagination boundary and record offset, Granola retains its note-page cursor, and Gmail retains its backfill cursor. A process crash expires the lease and marks the run interrupted; retry it from the UI. Very large single-provider records can still exceed one invocation and require a narrower import.

## Credentials and recovery

Provider keys and Gmail refresh/access tokens use AES-256-GCM encryption in `focus_auth.provider_secrets`. Updates serialize to preserve concurrent credential changes. The encryption key lives in server environment secrets. Google client credentials stay in server environment variables. None of these appear in workspace exports or model tools.

Keep PostgreSQL backups and the encryption key in separate private storage. A restored database needs the same encryption key, Google client configuration, owner allowlist, and production callback origin. Invalidate restored sessions and OAuth attempts before opening a recovered workspace. See [the Postgres runbook](postgres-cutover.md).

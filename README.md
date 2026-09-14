# Focus

A local, full-stack Next.js app for turning meeting and email context into evidence-backed priorities and explicit commitments.

The public repository contains application code, fictional test fixtures, and setup documentation. It starts with an empty workspace. Personal recordings, transcripts, analysis, databases, agent outputs, screenshots, credentials, and session archives are not included.

## Requirements

- Node.js 24 or later.
- Codex CLI installed and signed in on the same Mac for agent reviews.
- A Google Cloud project for Google login and read-only Gmail access.
- Optional Fireflies and Granola API keys for live meeting imports.

## Run locally

```sh
npm ci
cp .env.example .env.local
```

Edit `.env.local` and replace `owner@example.com` in `XIN_ALLOWED_EMAIL` with the Google account that should own this workspace. This is required: the app refuses sign-in when no owner is configured. It never grants ownership to an arbitrary first visitor.

```sh
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

Gmail setup errors no longer block a verified Google login. Connections shows **Needs attention** and an actionable explanation. If the Gmail API is disabled, enable it in the same Google Cloud project, then choose **Refresh**; the approved grant is retained locally. A successful reconnect or import clears the warning. Account mismatches still block sign-in.

Login failures distinguish expired browser flows, rejected clients or codes, identity verification, and network failures. The private `auth_events` table records stage, outcome, safe error category, HTTP status, and recognized provider/JWT reason codes. It never records tokens, authorization codes, OAuth URLs, or raw provider responses, and it is excluded from workspace exports.

The first client upload is accepted only from this local app's origin and only before a client is configured. To replace it later, run:

```sh
node --env-file-if-exists=.env.local scripts/configure-google.mjs /path/to/google-client.json
```

Replacing the client revokes existing browser sessions and pending login attempts. Keep the downloaded JSON outside the repository.

## Import context

In **Connections**, configure Fireflies or Granola and choose Refresh. Fireflies filters meetings by `XIN_FIREFLIES_PARTICIPANT_EMAIL`, falling back to `XIN_ALLOWED_EMAIL`; it never silently imports an unfiltered account. Granola uses a Personal API key, subject to the provider's plan and workspace policy.

The context library accepts `.txt`, `.md`, and normalized JSON documents. JSON can also be imported locally:

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

UI/provider imports trigger an agent review or queue a follow-up behind the current review. The Codex CLI uses its existing account sign-in and usage allowance.

## Storage and sync status

Everything runs locally. By default, the ignored `data/` directory contains:

- `xin.sqlite3`: source text, raw snapshots, full-text search, commitments, history, agent runs, proposals, and sync records.
- `connections.secret.json`: API credentials and Google tokens, created during setup.
- `auth.secret.sqlite3`: the pinned identity, hashed sessions, temporary OAuth attempts, and the latest 200 sanitized authentication events.
- `runs/`: structured outputs from agent reviews.

The optional `XIN_DATA_DIR` override selects another private directory. **Do not commit any runtime data.** Workspace exports omit credentials and auth sessions but contain private source material and decisions. Use the in-app JSON export or SQLite's backup API for backups; copying a live database without its journal can miss writes.

Connections shows stored coverage and the latest available run state: running, complete, partial, or failed. Progress counts processed records, including unchanged records. Gmail backfill is resumable in batches of up to 1,000 messages per refresh, followed by incremental history sync for the default scope. Custom Gmail query scopes rescan. Granola stores an update boundary; Fireflies rescans its participant scope with stable IDs.

## Current limits

- Single-owner local app, bound to `127.0.0.1:3210`; no shared hosted service or multi-user data isolation.
- HttpOnly, SameSite=Lax session cookies on loopback HTTP. Hosting would require HTTPS/Secure cookies, trusted origins, hosted credentials, and workers.
- Local files are not separately encrypted by the app; OS account and disk protections still matter.
- Text ingestion only: recording media and email attachment contents are not downloaded. Attachment names are retained.
- Exact excerpts establish provenance, not the truth of statements or the correctness of model interpretation.
- No scheduled provider polling, proactive failure alerts, full ingestion-history UI, or automatic backup service.
- Live Google/provider setup requires your own credentials. Tests use fictional fixtures and simulated provider responses; they do not verify a particular live account.

## Validation

```sh
npm test
npm run build
```

Tests use isolated temporary databases and cover Google token verification, owner restrictions, session/callback security, protected endpoints, imports, source history, quote validation, commitment rules, and sync recovery.

Technical references: [Next.js](https://nextjs.org/docs/app/getting-started/installation), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Fireflies transcript queries](https://docs.fireflies.ai/graphql-api/query/transcripts), [Granola API](https://docs.granola.ai/introduction), and [jose verification](https://github.com/panva/jose).

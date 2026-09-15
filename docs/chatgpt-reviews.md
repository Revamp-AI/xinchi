# ChatGPT subscription reviews

Open `/#settings` in the signed-in workspace. Choose **Connect ChatGPT**, open
the OpenAI device sign-in link, and enter the displayed code. Return to Settings,
test a model available to the account, then select **Use ChatGPT for reviews**.
This changes new cloud reviews; existing reviews keep their selected provider.

The server uses Codex device OAuth and the Codex Responses endpoint directly.
It does not run the Codex CLI, require a Mac worker, or pass OAuth tokens through
AI Gateway. Subscription eligibility, available models, and limits are governed
by OpenAI. This is a Hermes-style Codex adapter, not a general OpenAI API key.
The upstream Codex protocol may change independently of the public API.

On Vercel, connection credentials and pending login state use the existing
encrypted `focus_auth.provider_secrets` row and `XIN_SECRETS_KEY`. No new
environment variables or database migration are required. PostgreSQL advisory
locking serializes refresh-token rotation across function instances. Local
development uses the existing private credential file and an in-process lock;
use PostgreSQL secret storage for multiple processes.

Settings returns only account display information, pending device codes, and
connection-test results. Tokens are excluded from client responses, logs and
workspace exports. Every Settings endpoint requires the workspace session, and
writes require the existing same-origin request protection. Each login lasts
at most 15 minutes; polling is server-rate-limited and can resume after reload.

The adapter consumes bounded SSE responses and requires a terminal completion.
It maps read-only context tools and records token usage. Review output still
passes schema validation, exact citation verification and job lease checks.
Individual requests have a two-minute deadline within the existing eight-minute
review deadline. A 401 refreshes once; revoked refresh credentials prompt sign-in;
rate limits remain distinct from authentication errors.

Disconnect removes Focus's stored credentials and pending login. It does not
revoke other Codex sessions or automatically switch to billed API usage. Select
AI Gateway explicitly to resume reviews through the deployment's configured
`XIN_AGENT_MODEL` and Vercel credits. A provider switch does not replay old failed
reviews automatically; retry the desired review from Overview.

Validation: `npm test`; `node scripts/test-postgres.mjs --e2e review-settings.spec.ts smoke.spec.ts`.
OAuth tests use fictional credentials; a live connection test in production is
required after the account owner completes sign-in.

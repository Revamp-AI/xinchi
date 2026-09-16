# Connect Focus to Codex

Focus exposes an authenticated remote MCP server at:

```text
https://focus-revamp.vercel.app/mcp
```

In Codex **Settings → MCP servers**, add a server named `focus`, select **Streamable HTTP**, enter the URL, save, and authenticate. Sign in to Focus as the workspace owner and allow access. If Focus opens a sign-in tab, complete sign-in there, return to the approval tab, and continue. Start a new Codex task after connecting so its tools are loaded.

The CLI uses the same configuration:

```sh
codex mcp add focus --url https://focus-revamp.vercel.app/mcp
codex mcp login focus
```

For read-only access, authenticate with `codex mcp login focus --scopes focus:read`. To change access later, revoke the connection in Focus Settings and authenticate again with the desired scopes. See the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## What Codex can do

The server publishes 50 tools, two resources, and a review prompt. The tool catalog is the authoritative schema and includes parameter descriptions and constraints.

| Area | Capabilities |
| --- | --- |
| Workspace | Read priorities, capacity, coverage and counts; set weekly focus; prepare a private business update |
| Commitments | Search, read history, create, update owner and fields, change status under the existing decision rules |
| Proposals | Read evidence, accept or dismiss pending proposals |
| Contacts | Search all heat-map segments, update profiles and preferences, import CSV batches, manage affiliations and commitment links |
| Relationships | Read timelines, log real past interactions, review duplicates, confirm coverage, preview/perform/undo identity merges |
| Drafts | Create and revise private drafts with current versions; no outbound messaging |
| Context | Search the archive, page through full source text, retrieve preserved versions |
| Reviews | Read findings and questions, start/cancel a cloud review, answer questions, submit a review prepared by Codex with verified citations |
| Connections | Read status, save supplied provider credentials, change Gmail query, request provider/companion syncs |
| Imports | Inspect progress, retry durable imports, upload text/JSON in resumable chunks, queue extraction |
| Review settings | Select a configured provider/model and test its connection |

Google sign-in, ChatGPT sign-in, and Beeper device pairing are completed through the existing Focus interface. Tools return the relevant setup links. Provider credentials and OAuth tokens are never returned by workspace tools.

Try: “Review my Focus commitments and source context. Save evidence-backed proposals for my decision.” Or: “Find Avery in Focus, show the relationship history, then draft a follow-up for me to review.”

## Actions and background work

Every write tool requires an `idempotency_key`. Use a fresh UUID for each intended change; reuse the same key and arguments only when retrying it. Focus commits the change and cached result together. Updates to commitments, contacts, drafts, and reviewed interactions require the current record version. Merges require a preview token. The existing capacity, citation, and contact-preference rules still apply.

Imports, extraction, and cloud reviews return job IDs immediately. Poll the matching read tools for progress. Source ingestion uses the existing durable workflows and checkpoints; MCP does not keep a request open for an entire import. Beeper still requires its paired local companion. `focus_submit_review` saves Codex's structured review without calling a cloud model and leaves suggestions pending.

Granola and Fireflies sync automatically in production. `refresh_connection` starts an immediate check; pass `rescan: true` to force either provider to recheck full history. Active imports must finish first.

## Access and deployment

Focus **Settings → Connect Codex** lists clients, scopes, last use, and successful MCP actions. Revoking access disables the grant and all of its tokens immediately. Signing out of the website does not revoke an existing MCP connection.

The server supports Streamable HTTP, including legacy stateless negotiation, with OAuth discovery, dynamic public-client registration, PKCE S256, and resource-bound opaque tokens. `focus:read` is required; `focus:write` permits actions. Access tokens last one hour; refresh tokens rotate and grants last at most 90 days. Reusing a consumed refresh token revokes that grant. Tokens and authorization codes are stored only as hashes in the private `focus_auth` schema, outside workspace exports.

Apply migration `009_mcp_access.sql` before deploying. The server uses the existing Postgres database, `XIN_APP_ORIGIN`, owner sign-in, and cloud-worker configuration; it needs no additional service credentials. The canonical origin must match the MCP URL. Preview deployment URLs are not alternate MCP resources.

Run `node scripts/test-postgres.mjs tests/mcp.test.mjs` and `node scripts/test-postgres.mjs --e2e mcp.spec.ts` for isolated protocol, authorization, mutation, and browser verification. These use fictional data in disposable local databases.

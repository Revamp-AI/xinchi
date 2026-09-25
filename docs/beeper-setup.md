# Beeper companion

Focus ingests direct conversations through a companion on the same Mac as Beeper
Desktop. Setup selects all currently available direct conversations by default.
The companion requests the `read` OAuth scope using PKCE.
It only calls local chat/message GET endpoints. No remote access, tunnel, or
inbound connection from Vercel is needed.

## Setup

1. Open Beeper Desktop and enable its Desktop API under Settings → Integrations.
   Leave Remote Access disabled.
2. Open Focus → Connections → Connect Beeper and download the companion.
3. With Node.js 24+ installed, run:

   ```sh
   node ~/Downloads/beeper-companion.mjs setup
   ```

4. In Beeper's authorization window, turn **off “Allow sensitive actions”** before
   clicking **Approve**. This keeps the credential read-only. Setup automatically
   selects all direct conversations and shows their count. Confirm the selection
   in Terminal to continue.
5. Generate a one-time pairing code in Focus and enter it in Terminal when asked.
   It expires after ten minutes; completing a new pairing revokes the previous
   companion's Focus credential.
6. Setup installs the companion as a per-user macOS LaunchAgent. It runs at login.
   Both the Mac and Beeper Desktop need to be available to fetch new messages.

The cloud connection may be deployed before a Mac is paired. No real conversation
is uploaded until the user confirms the conversation selection and completes pairing.

To select only some conversations, run `node ~/Downloads/beeper-companion.mjs setup
--choose`. This optional mode shows a numbered list; enter comma-separated numbers,
or press Enter to keep all conversations selected. The saved selection includes
the conversations available during setup; rerun setup to include new conversations.

## Import behavior

- The initial import covers up to 90 days of locally available message text.
  Beeper may have incomplete history. Groups and attachment files are excluded.
- Incremental scans run approximately every 15 minutes and reread a 48-hour
  overlap. A daily scan revisits the 90-day window to detect older edits and any
  deletion markers Beeper exposes. Disappearing records without deletion markers
  cannot be reliably detected; imported snapshots remain in the archive.
- Pairing supports the full conversation list, subject to a 4 MiB limit on its
  metadata. Each import supports at most 100,000 messages. Use `setup --choose`
  to select fewer conversations if either limit is reached.
- Each upload contains at most 25 messages and is saved in Postgres before it is
  acknowledged. The private local outbox survives process restarts. Staging is
  retained while the Mac is asleep. Once all pages arrive, a Vercel Workflow
  imports one source per step, then queues contact extraction and cloud review.
- Credentials are hashed in the restricted `focus_auth` schema and excluded from
  exports. The Beeper OAuth token is stored only on the Mac, never sent to Focus.
- Network/account/chat/message IDs determine source identities. Contacts use
  account and sender IDs; display names never trigger automatic merges. Only
  verified direct exchanges qualify as relationship evidence. Because history is
  filtered and may be incomplete, inferred silence requires coverage confirmation.

## Files and controls

The companion, credentials, checkpoint/outbox, and log live in
`~/Library/Application Support/Focus Beeper/`. The directory and private files use
owner-only permissions. The startup entry is
`~/Library/LaunchAgents/ai.getrevamp.focus-beeper.plist`.

```sh
node ~/Downloads/beeper-companion.mjs status
node ~/Downloads/beeper-companion.mjs uninstall
```

Uninstall stops automatic syncing. Disconnect in Focus → Connections → Beeper to
revoke cloud upload access. Revoke “Focus Beeper (read only)” in Beeper's approved
connections to revoke local API access. Imported archive snapshots remain.

If Beeper authorization expires, run setup again. If cloud processing fails, use
Retry import in Focus. Refresh requests wait for the Mac and are fetched by its
outbound polling connection.

### Sync stops after restarting the Mac

Older companions used a saved process ID as a lock. After a restart, macOS could
assign that ID to an unrelated process, leaving the companion stuck on “The
companion is already running.” The current companion uses an exclusive loopback
listener that the operating system releases automatically when the process exits.
It accepts no commands or data and is never exposed to the network.

Download the current companion from Focus → Connections → Beeper, then run:

```sh
node ~/Downloads/beeper-companion.mjs install
```

This updates and restarts the login service while preserving the existing pairing,
conversation selection, and pending upload. Setup and a new pairing code are not
needed. The companion resumes from its saved checkpoint.

### Setup stops before asking for a pairing code

Beeper authorization and confirmation of the selection happen before the Focus pairing
code prompt. If setup reports that Beeper granted write access, turn **off
“Allow sensitive actions”** in Beeper's authorization window before approving.
Requesting the `read` scope does not prevent that toggle from granting write access.

The companion rejects the credential, attempts to revoke it, and offers to retry
authorization in the same setup. If automatic revocation fails, it tells you to
remove the rejected “Focus Beeper (read only)” entry under Beeper → Settings →
Integrations → Approved connections. If an older companion exits immediately,
run setup again with the toggle off, or download the updated companion.

After authorization succeeds, all direct conversations are selected automatically.
Confirm the selection, then generate the Focus pairing code when Terminal asks for it.

## Implementation

- `public/beeper-companion.mjs`: standalone downloadable Mac companion.
- `lib/beeper.mjs`: restricted device pairing, ordered staging, source normalization.
- `app/api/beeper/device/[action]/route.js`: scoped device upload routes.
- `lib/durable-ingestion.mjs`: reuse of the existing durable ingestion loop.
- `migrations/008_beeper_companion.sql`: device records, staging metadata, message interactions.
- `tests/beeper.test.mjs`: authorization, scope, replay, restart, extraction, revocation.
- `tests/beeper-companion.test.mjs`: read-only OAuth, write-grant revocation and retry, cancellation, exclusive locking and restart recovery.

Reference: [Beeper API](https://developers.beeper.com/desktop-api/),
[authentication](https://developers.beeper.com/desktop-api/auth/),
[messages](https://developers.beeper.com/desktop-api-reference/resources/messages/methods/list/).

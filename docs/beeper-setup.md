# Beeper companion

Focus ingests selected direct conversations through a companion on the same Mac
as Beeper Desktop. The companion requests the `read` OAuth scope using PKCE.
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

4. Approve Beeper's read-only authorization. In Terminal, choose the numbered
   direct conversations to import. Only these conversations are sent to Focus.
5. Generate a one-time pairing code in Focus and enter it in Terminal when asked.
   It expires after ten minutes; completing a new pairing revokes the previous
   companion's Focus credential.
6. Setup installs the companion as a per-user macOS LaunchAgent. It runs at login.
   Both the Mac and Beeper Desktop need to be available to fetch new messages.

The cloud connection may be deployed before a Mac is paired. No real conversation
is uploaded until the user selects conversations and completes pairing.

## Import behavior

- The initial import covers up to 90 days of locally available message text.
  Beeper may have incomplete history. Groups and attachment files are excluded.
- Incremental scans run approximately every 15 minutes and reread a 48-hour
  overlap. A daily scan revisits the 90-day window to detect older edits and any
  deletion markers Beeper exposes. Disappearing records without deletion markers
  cannot be reliably detected; imported snapshots remain in the archive.
- The initial version supports 1–250 selected conversations and at most 100,000
  messages per import. Choose fewer conversations if the limit is reached.
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

## Implementation

- `public/beeper-companion.mjs`: standalone downloadable Mac companion.
- `lib/beeper.mjs`: restricted device pairing, ordered staging, source normalization.
- `app/api/beeper/device/[action]/route.js`: scoped device upload routes.
- `lib/durable-ingestion.mjs`: reuse of the existing durable ingestion loop.
- `migrations/008_beeper_companion.sql`: device records, staging metadata, message interactions.
- `tests/beeper.test.mjs`: authorization, scope, replay, restart, extraction, revocation.

Reference: [Beeper API](https://developers.beeper.com/desktop-api/),
[authentication](https://developers.beeper.com/desktop-api/auth/),
[messages](https://developers.beeper.com/desktop-api-reference/resources/messages/methods/list/).

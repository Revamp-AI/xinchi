# Automatic commitment review

Focus reviews new source pages and rechecks open suggestions daily. Hosted reviews run through the existing authenticated minute cron without an open browser. Each maintenance job receives at most three versioned suggestions; subsequent jobs continue the remaining due backlog. A failed or incomplete check backs off for an hour. Only cited updates, reconciliations or explicit evidence-backed retained checks mark a suggestion reviewed. Targeted source windows reach promises late in long transcripts without exhausting the reading budget. Local mode drains reviews when a worker runs; it does not install an operating-system scheduler.

## What reaches the shortlist

Automatic proposals must include an exact ownership excerpt and a structured qualification: the owner's verbal promise, written promise, or a direct request for a concrete deliverable. Verbal promises must cite a Granola or Fireflies transcript excerpt; summary-only attribution cannot qualify. Reviews distinguish the owner using the verified workspace identity and source context, without requiring manual contact identity confirmation.

The deterministic ordering favors verbal customer promises, then verbal internal promises, other business promises/requests, and personal work. Supported dates increase urgency within those groups. At most ten suggestions are pending; remaining valid suggestions are deferred and accessible under **For later**. None is automatically accepted as a commitment.

Stable deliverable keys and source/promise matching suppress reworded repeats, including dismissed suggestions. Reviews search accepted and dismissed history and reuse keys. Refreshing a suggestion requires its current version. Exact citation validation verifies the excerpt exists; semantic attribution, matching and completion assessment still depend on the reviewer and available source coverage.

## Pruning and recovery

Reviews can dismiss open suggestions when cited evidence shows delivery, replacement, duplication, an expired event opportunity, someone else's obligation, or a routine notification. Age alone is insufficient. Accepted commitments remain user-controlled.

Every dismissal records its explanation, exact source snapshots and review ID in `proposal_events`. **Recently removed** shows the latest thirty removals with a **Restore suggestion** action. Versions prevent a stale background result from overriding a user's acceptance, dismissal or restoration. Restored suggestions are rechecked the next day. Full history is available in workspace exports and the proposal MCP read tool.

## Google Calendar

Connect **Google Calendar** once in Connections. Google sign-in requests `calendar.events.readonly`; Gmail and Calendar consent are independent. Existing Gmail-only grants do not count as Calendar access. Enable the Google Calendar API for the OAuth project's client. Credentials remain encrypted with other hosted provider grants and never enter review tools or Workflow arguments.

Hosted Calendar sync checks the primary calendar after five idle minutes, covering the past thirty and next ninety days. It expands recurring instances, follows pagination, and preserves original instance IDs, all-day dates, time zones, RSVP, descriptions and cancellations in immutable source snapshots. Previously known events missing from a completed list are fetched individually to distinguish a reschedule from deletion. Partial failures never infer cancellation or advance the successful-sync watermark. Calendar invitations do not count as relationship exchanges.

Review tools report connection state and freshness. An event can support a suggested preparation checkpoint only when tied to a promised output. Calendar attendance alone never creates a hard deadline. The server rejects calendar dates from obsolete snapshots, canceled/tentative/declined events or stale/disconnected coverage. Explicit dates from messages and transcripts remain separately citable.

## Deployment and verification

Apply migrations `015_commitment_triage.sql` and `016_proposal_review_coverage.sql` before deploying the code. It adds versions, priority scores, stable keys, the deferred state, review batches and event history. Existing accepted/dismissed records are preserved; overflow pending suggestions move to deferred until reviewed.

Regression coverage: `commitment-triage.test.mjs`, `calendar-sync.test.mjs`, `scheduled-sync.test.mjs`, Google partial-consent/auth tests, and `commitment-proposals.spec.ts`. Use only the disposable test databases and fictional credentials. Ingestion changes also require the compiled Workflow smoke test documented in [Vercel deployment](vercel.md).

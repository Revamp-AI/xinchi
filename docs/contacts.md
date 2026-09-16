# Contacts and relationship map

Contacts is the fifth Focus destination. It combines a searchable people list, a six-region relationship map, profile and evidence timelines, a review queue, and links to existing commitments.

## Daily use

- Add a contact manually or import a CSV with `name,email,company,role,notes,tags`. Quoted commas and multiline fields work; separate tags with semicolons. Reimporting an identical row is idempotent. Exact personal-email matches reuse the existing profile and preserve its chosen name and preferences. CSV notes and tags are combined; imported names remain searchable identity aliases.
- Bring in contacts from the most recent 90 days of stored Gmail, Beeper, Fireflies and Granola material, or explicitly choose all stored history. Newly imported recent sources enter the extraction queue automatically. CLI imports can be extracted from the Contacts screen.
- Relationship classification happens automatically from verified activity. Identity confirmation and follow-up tracking do not block classification. Set a cadence and add purpose tags independently.
- Exact normalized personal emails resolve to one contact across providers and accounts. Provider identities, source names and evidence remain attached to that contact. Email normalization trims whitespace and ignores letter case; it does not remove dots or plus tags. Name-only matches, shared mailboxes, conflicting maintained profiles, and explicit keep-separate decisions still require review. Names without stable identifiers remain scoped to their recording. Identity matching does not enable follow-up tracking.
- Beeper names come from the other participant or the verified direct conversation's title. Your outgoing sender name never labels the other person. Conversations with unresolved participant ownership remain in source evidence until a verified participant list is available.
- Record organizations as dated affiliations. Ending an old affiliation keeps its history; add the new organization separately.
- Log a meaningful conversation using its actual date. Read the source and immutable snapshot behind timeline entries. You can confirm uncertain attendance or exclude an event. Automated/shared mailboxes and copied recipients do not warm the map automatically.
- Ambiguous merges have a review preview. Exact-email reconciliation prefers a maintained profile, then a descriptive name, then the oldest profile. Notes and tags are combined; evidence, identity bindings, affiliations, drafts and commitment links move to it. Do-not-contact, pause and snooze preferences are preserved. Automatic reconciliation also preserves archive status and explicit cadence. Every merge records a reversible snapshot; later edits block undo rather than being discarded. Undoing an automatic match records a keep-separate decision so imports cannot immediately repeat it.
- Contacts → Review supports selecting individual matches or all 30 visible matches. Bulk actions mark people as different, preview and merge selected profiles, or mark recordings as the same/separate meetings. Counts show the full pending queue, and the next batch appears after decisions. Newly loaded rows are never selected automatically. Selections are separate for people and recordings.
- Bulk merge previews group overlapping selected pairs into one connected set and let you choose which profile to keep. The kept profile supplies the name and cadence; contact restrictions and evidence are preserved. A group containing a prior keep-separate decision or more than 10 profiles needs individual review. Each group commits atomically in its own request, rejects changes since preview, and records one undoable decision for the whole group. Retrying the same request does not merge twice. Partial failures are reported while successful groups remain saved. Recording actions also retain per-record version checks and audit history.
- Link follow-ups to existing commitments or create a new outcome. The same three-active-outcome rule applies. A checkpoint overlay reflects recorded commitments, not an inferred promise from an email.
- Ask Focus for a cited review or an internal message draft. Draft text can be edited, saved and copied. No send operation or additional Gmail scope is implemented.

## Classification

Purpose tags, relationship state and commitment attention are separate.

| State | Basis |
| --- | --- |
| New | A first verified interaction within 14 days, without a reciprocal exchange. |
| Active | Last meaningful reply or attended conversation is within the chosen cadence. |
| Cooling | Beyond one cadence, through three cadences, with complete recent coverage. |
| Dormant | Beyond three cadences, with complete recent coverage. |
| Paused | Paused, snoozed, or marked do-not-contact. |
| Unclassified | Insufficient verified interaction evidence, outbound-only history, or incomplete/stale coverage that prevents a cooling conclusion. |

Cadence defaults to 30 days and applies whether or not follow-up tracking is enabled. It can be changed per person. Unconfirmed identities can have an activity classification while their merge suggestions remain pending. Outbound outreach alone cannot renew warmth. An imported event uses its occurrence time, never its import time. A recent real exchange after a Cooling/Dormant state can display a Reconnected badge; changing cadence alone cannot create it. The map contains actual contact records; it has no fabricated activity or ambient traffic animation.

Coverage requires complete recent provider imports and no outstanding extraction for those providers. A filtered Gmail query is partial coverage. Beeper's locally available history also needs a coverage check before inferring silence. For a manually maintained timeline, the owner can explicitly confirm that it is complete through today; that confirmation remains fresh for 48 hours. This checks completeness of history, independently of identity confirmation. State evaluation is versioned, recorded in history, and refreshed when contacts/events change, the rules change, or the view's evaluation becomes stale.

## LinkedIn connection exports

Run `node --env-file=.env.local scripts/import-linkedin.mjs /path/to/Connections.csv` to preview a native LinkedIn export, then append `--apply` to import. Use the intended database environment. Only Connections.csv is read; messages, advertising data, account history and other archive files are not imported. The native export's Notes preamble, quoted fields and missing emails are supported. Rows without a name and stable profile URL or personal email are skipped and counted.

The importer commits 100 connections at a time and can safely resume by rerunning the same file. LinkedIn profile URLs are stable identity bindings; exact personal emails reuse existing profiles. Names (including reversed two-part names) only suggest a merge in Review. Conflicting identifiers are counted and left for review. Existing names, notes, contact restrictions, archive status and follow-up preferences stay unchanged. Imported company and position become affiliations without inferred start/end dates. Changed exports preserve previous source snapshots and affiliations. Names, roles, companies and aliases are searchable.

Profile identity details link to LinkedIn and the imported source, including the connection date. Connections never create interactions or warm the relationship map. New profiles remain unconfirmed and untracked until you choose otherwise. LinkedIn uploads currently use this resumable CLI; the in-app CSV picker accepts the generic contact format described above.

## Boundaries

For profiles created by the old Beeper outgoing-sender fallback, run `node scripts/repair-beeper-contacts.mjs` with the intended database environment to preview the repair, then add `--apply` to save it. The repair corrects untouched imported labels, archives proven owner-only profiles, and retires obsolete name-match suggestions. It preserves source evidence, contact identities, and user-edited profiles, and never merges people.

Run `node scripts/reconcile-contact-emails.mjs` with the intended database environment to preview existing exact-email duplicates, then add `--apply` to reconcile them. Each email group commits atomically under the same workspace lock as ingestion. Repeated runs are idempotent. No source text or snapshot is deleted. Provider extraction also reconciles eligible legacy duplicates when it encounters them. Aliases are available in profile identity details and contact search.

The map/list page holds 500 contacts at a time; segment counts cover the full filtered result. Map regions show up to 15 people and link to the full segment list. Profile timelines show the most recent 300 interactions; classification evaluates the full stored timeline. Identity/duplicate review panels show the next 30 pending records and refill after decisions.

Cross-provider meeting matching uses normalized titles and nearby timestamps to suggest duplicates. Suggestions are excluded from warmth until reviewed; they are not independent corroboration. Participant schemas vary across source archives. Missing owner attendance or email identity is shown as uncertain, and speaker names never silently identify a person across recordings.

Provider import, contact extraction, and agent review status are separate. Hosted Granola and Fireflies connections [sync automatically](meeting-sync.md); changed imports flow through contact extraction and cloud review. There is no automatic mail sending, calendar connector, sales pipeline, or shared CRM.

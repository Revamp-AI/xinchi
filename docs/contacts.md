# Contacts and relationship map

Contacts is the fifth Focus destination. It combines a searchable people list, a six-region relationship map, profile and evidence timelines, a review queue, and links to existing commitments.

## Daily use

- Add a contact manually or import a CSV with `name,email,company,role,notes,tags`. Quoted commas and multiline fields work; separate tags with semicolons. Reimporting an identical row is idempotent. Changed rows become separate candidates rather than silently replacing a person's manual choices.
- Bring in contacts from the most recent 90 days of stored Gmail, Fireflies and Granola material, or explicitly choose all stored history. Newly imported recent sources enter the extraction queue automatically. CLI imports can be extracted from the Contacts screen.
- Confirm extracted identities, set a cadence, and add purpose tags. A source binding identifies a person within its provider/account. Equal names or addresses across independent bindings create a merge suggestion, not an automatic match. Names without stable identifiers remain scoped to their recording.
- Record organizations as dated affiliations. Ending an old affiliation keeps its history; add the new organization separately.
- Log a meaningful conversation using its actual date. Read the source and immutable snapshot behind timeline entries. You can confirm uncertain attendance or exclude an event. Automated/shared mailboxes and copied recipients do not warm the map automatically.
- Review a merge preview before applying it. The kept profile retains its manual fields; evidence, identity bindings, affiliations, drafts and commitment links move to it. Do-not-contact and pause preferences are preserved. Undo is offered while those records remain unchanged; later edits block undo rather than being discarded.
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
| Unclassified | Unconfirmed/untracked identity, insufficient interaction evidence, outbound-only history, or stale coverage that prevents a cooling conclusion. |

Cadence defaults to 30 days and can be changed per person. Outbound outreach alone cannot renew warmth. An imported event uses its occurrence time, never its import time. A recent real exchange after a Cooling/Dormant state can display a Reconnected badge; changing cadence alone cannot create it. The map contains actual contact records; it has no fabricated activity or ambient traffic animation.

Coverage requires complete recent provider imports and no outstanding extraction for those providers. A filtered Gmail query is partial coverage. For a manually maintained timeline, the owner can explicitly confirm that it is complete through today; that confirmation remains fresh for 48 hours. State evaluation is versioned, recorded in history, and refreshed when contacts/events change or when the view's evaluation becomes stale.

## Boundaries

The map/list page holds 500 contacts at a time; segment counts cover the full filtered result. Map regions show up to 15 people and link to the full segment list. Profile timelines show the most recent 300 interactions; classification evaluates the full stored timeline. Identity/duplicate review panels show the next 30 pending records and refill after decisions.

Cross-provider meeting matching uses normalized titles and nearby timestamps to suggest duplicates. Suggestions are excluded from warmth until reviewed; they are not independent corroboration. Participant schemas vary across source archives. Missing owner attendance or email identity is shown as uncertain, and speaker names never silently identify a person across recordings.

Provider import, contact extraction, and agent review status are separate. There is no automatic mail sending, calendar connector, sales pipeline, shared CRM, hosted worker service, or periodic provider scheduler. Those are outside this release.

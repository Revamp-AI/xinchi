# Contacts and relationship map

Contacts is the fifth Focus destination. It combines a searchable people list, a six-region relationship map, profile and evidence timelines, a review queue, and links to existing commitments.

## Daily use

- Add a contact manually or import a CSV with `name,email,company,role,notes,tags`. Quoted commas and multiline fields work; separate tags with semicolons. Reimporting an identical row is idempotent. Exact personal-email matches reuse the existing profile and preserve its chosen name and preferences. CSV notes and tags are combined; imported names remain searchable identity aliases.
- Stored Gmail, Beeper, Fireflies and Granola history is queued for contact extraction automatically, including sources older than ninety days. New and changed sources enter the queue automatically. The manual import controls can also request recent or all history.
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
| Cooling | Last recorded meaningful exchange is beyond one cadence, through three cadences. Marked estimated when coverage is partial. |
| Dormant | Last recorded meaningful exchange is beyond three cadences. Marked estimated when coverage is partial. |
| Paused | Paused, snoozed, or marked do-not-contact. |
| Unclassified | No verified meaningful interaction evidence, or outbound-only history. An address book connection alone is insufficient. |

Cadence defaults to 30 days and applies whether or not follow-up tracking is enabled. It can be changed per person. Unconfirmed identities can have an activity classification while their merge suggestions remain pending. Outbound outreach alone cannot renew warmth. An imported event uses its occurrence time, never its import time. A recent real exchange after a Cooling/Dormant state can display a Reconnected badge; changing cadence alone cannot create it. The map contains actual contact records; it has no fabricated activity or ambient traffic animation.

Complete coverage requires complete recent provider imports and no outstanding extraction for those providers. A filtered Gmail query is partial coverage. Beeper's locally available history is partial. Incomplete coverage no longer hides older relationships in Unclassified: Cooling and Dormant describe the recorded timeline, with an explicit estimate and coverage explanation. Paused is never inferred from silence; it follows pause, snooze or do-not-contact preferences, with pause/resume available on the profile. For a manually maintained timeline, the owner can explicitly confirm that it is complete through today; that confirmation remains fresh for 48 hours. This checks completeness of history, independently of identity confirmation. State evaluation is versioned, recorded in history, and refreshed when contacts/events change, the rules change, or the view's evaluation becomes stale.

## Automatic relationship agent

The Contacts page shows a Relationship agent panel, enabled by default, with progress, errors, pause and Analyze now controls. Production cron runs bounded analysis passes using the provider/model already selected in Settings → Reviews (including the connected ChatGPT subscription). No separate credentials are required. The panel refreshes while analysis continues; closing the page does not stop the cron.

Each pass assesses up to eight profiles with conversation or user-note evidence and marks up to five hundred address-book-only profiles as lacking relationship context without calling a model. The agent can read longer pages of linked sources using a read-only tool, with a four-step limit, reading budget and two-minute model timeout. Input fingerprints include contact edits, source revisions, participant corrections and affiliations; unchanged profiles do not spend another model call. Leases prevent overlapping writes, stale results are discarded, and failures back off and defer the affected batch so other people can still be analyzed.

The output includes up to three purpose tags, a relationship summary and one optional next step. Every nonempty inference requires an exact quote from an immutable source version linked to that specific person. Source contents are treated as untrusted data. Employers and job titles alone do not establish Customer, Investor or other relationships to the owner. Purpose is shown as inferred; unknown purpose is shown as Not enough context. Manual tags take precedence and are never overwritten. Profiles expose evidence, confidence, assessment date and a persistent dismissal. Merge/undo invalidates derived results for reassessment. The agent cannot send messages, create commitments, merge identities or change contact preferences; restricted contacts get no suggested outreach.

Historical extraction fills missing queue entries once and preserves completed work. All future revisions, including older records, enter extraction. Ingestion workflows yield after five hundred steps, keeping their database cursor, and the next cron dispatch resumes in a fresh workflow to avoid unbounded event histories.

## LinkedIn connection exports

Run `node --env-file=.env.local scripts/import-linkedin.mjs /path/to/Connections.csv` to preview a native LinkedIn export, then append `--apply` to import. Use the intended database environment. Only Connections.csv is read; messages, advertising data, account history and other archive files are not imported. The native export's Notes preamble, quoted fields and missing emails are supported. Rows without a name and stable profile URL or personal email are skipped and counted.

The importer commits 100 connections at a time and can safely resume by rerunning the same file. LinkedIn profile URLs are stable identity bindings; exact personal emails reuse existing profiles. Names (including reversed two-part names) only suggest a merge in Review. Conflicting identifiers are counted and left for review. Existing names, notes, contact restrictions, archive status and follow-up preferences stay unchanged. Imported company and position become affiliations without inferred start/end dates. Changed exports preserve previous source snapshots and affiliations. Names, roles, companies and aliases are searchable.

Profile identity details link to LinkedIn and the imported source, including the connection date. Connections never create interactions or warm the relationship map. New profiles remain unconfirmed and untracked until you choose otherwise. LinkedIn uploads currently use this resumable CLI; the in-app CSV picker accepts the generic contact format described above.

## Automatic employer matching

Contacts → Review includes **Match automatically** and **Match now**. On Vercel, a bounded pass runs through the existing cron every ten minutes; each pass checks at most five new company websites and merges at most thirty pairs. Website failures are cached for a day, successful evidence for thirty days, and deferred checks resume in later passes. Pausing takes effect before the next merge, including during an in-flight website check.

Eligibility requires exactly two active profiles with the same normalized full name, exactly one LinkedIn profile URL, a matching latest LinkedIn export name and employer imported within ninety days, an active matching affiliation, and one non-shared corporate email domain. The domain's brand must exactly match the employer after basic punctuation/legal-suffix normalization, and its HTTPS website must identify that employer in site metadata, structured organization data, or a full branded title segment. Public mail providers, lookalike domains, conflicting affiliations, distinct LinkedIn profiles, ambiguous names, archived contacts, conflicting maintained fields and explicit separations remain for manual review. This uses the imported LinkedIn snapshot; it does not scrape private LinkedIn pages or claim live employment verification.

Website reads are limited to public IPv4 addresses pinned to the TLS request, same-domain HTTPS redirects, one MiB, and eight seconds total. No contact names, email addresses or private profile content are sent to the website. Every automatic decision records the profile URL, source version and company website evidence. Undo restores both profiles and records a separation so the matching pass cannot immediately repeat it. Matching preserves notes, restrictions, chosen cadence and evidence, and does not enable follow-up tracking.

## Apple Contacts archives

Run `node --env-file=.env.local scripts/import-apple-contacts.mjs '/path/to/Contacts.abbu'` to preview an Apple Contacts archive, then append `--apply` to import. The CLI reads a temporary copy of the archive's databases and write-ahead logs; it never restores or modifies the Mac address book. It extracts names, all emails and phone numbers, organizations, roles and website/social URLs. Photos, postal addresses, birthdays and private address-book notes are excluded. The hosted CSV picker still accepts CSV; `.abbu` is handled locally by this CLI.

Imports use fifty-card transactions and stable Apple card identifiers. Identical reimports are unchanged; updated cards preserve previous source versions. Exact personal emails and known LinkedIn URLs reuse existing profiles. An unambiguous international phone number can enrich the same recorded name or an unconfirmed phone-number placeholder; local numbers are retained without guessing a country. Conflicting identifiers are skipped, existing preferences and notes survive, and new cards do not create conversations or warm the relationship map. Phone numbers appear in profile details and contact search.

## Boundaries

For profiles created by the old Beeper outgoing-sender fallback, run `node scripts/repair-beeper-contacts.mjs` with the intended database environment to preview the repair, then add `--apply` to save it. The repair corrects untouched imported labels, archives proven owner-only profiles, and retires obsolete name-match suggestions. It preserves source evidence, contact identities, and user-edited profiles, and never merges people.

Run `node scripts/reconcile-contact-emails.mjs` with the intended database environment to preview existing exact-email duplicates, then add `--apply` to reconcile them. Each email group commits atomically under the same workspace lock as ingestion. Repeated runs are idempotent. No source text or snapshot is deleted. Provider extraction also reconciles eligible legacy duplicates when it encounters them. Aliases are available in profile identity details and contact search.

The list holds 500 contacts at a time; segment counts and purpose filter choices cover the full result. Map regions independently sample up to fifteen contacts per segment from the full filtered set, including people outside the first alphabetical page, and link to the full segment list. Profile timelines show the most recent 300 interactions; classification evaluates the full stored timeline. Identity/duplicate review panels show the next 30 pending records and refill after decisions.

Cross-provider meeting matching uses normalized titles and nearby timestamps to suggest duplicates. Suggestions are excluded from warmth until reviewed; they are not independent corroboration. Participant schemas vary across source archives. Missing owner attendance or email identity is shown as uncertain, and speaker names never silently identify a person across recordings.

Provider import, contact extraction, and agent review status are separate. Hosted Granola and Fireflies connections [sync automatically](meeting-sync.md); changed imports flow through contact extraction and cloud review. There is no automatic mail sending, calendar connector, sales pipeline, or shared CRM.

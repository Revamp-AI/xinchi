# Fireflies incremental sync

After a successful import, **Refresh** requests transcripts from seven days before
the previous successful snapshot through the new run's start time. This overlap
catches recent late arrivals and revisions. **Rescan history** removes the lower
date boundary for an explicit historical check; it does not delete stored sources.

Both the local worker and durable Vercel importer use the same window selection.
The participant, lower and upper bounds, and record offset are preserved when a
run pauses or fails. The completed position advances only after all records in
the window have been saved. An older resumed run cannot rewind a newer position.
No migration or additional environment configuration is required.

For existing installations, a completed durable import with the same participant
provides the first successful position. An unfinished import, a different account,
or the newest stored transcript is not sufficient proof of historical coverage.
Existing in-flight full imports finish their original window and seed the next
incremental sync. Active imports cannot be replaced by a history rescan.

Fireflies date filters operate on transcript creation dates, not a complete feed
of every later edit. Older edits, delayed historical uploads, and newly shared
historical transcripts are also checked by the hosted scheduler's daily history
rescan. Recent checks run after five idle minutes. **Rescan history** starts an
immediate full check. See [automatic meeting imports](meeting-sync.md).
Stored source IDs and content
hashes continue to prevent identical duplicate records and repeated extraction.

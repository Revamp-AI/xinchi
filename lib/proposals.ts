import type { z } from 'zod';
import { and, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { calendarGranted } from './calendar.ts';
import { secrets } from './secret-store.ts';
import {
  all,
  one,
  run,
  uid,
  hash,
  stamp,
  dateOK,
  getSetting,
  transaction,
  lockWorkspace,
} from './db.mjs';
import { db } from './postgres.ts';
import {
  jobs,
  proposal_review_batches,
  proposals,
  source_versions,
  sources,
} from './schema/index.ts';
import type { AgentResult } from './agent.mjs';

type AgentOutput = z.output<typeof AgentResult>;
type Proposal = AgentOutput['proposals'][number];
type Qualification = NonNullable<Proposal['qualification']>;
type Reconciliation = AgentOutput['proposal_reconciliations'][number];
type ProposalCheck = AgentOutput['proposal_checks'][number];

export const SHORTLIST_LIMIT = 10;
const open = "('pending','deferred')";
const due =
  "(reviewed_at IS NULL OR reviewed_at<now()-interval '1 day') AND (review_attempted_at IS NULL OR review_attempted_at<now()-interval '1 hour')";
const isOpen = () => inArray(proposals.status, ['pending', 'deferred']);
const reviewDue = () =>
  sql`(${proposals.reviewed_at} IS NULL OR ${proposals.reviewed_at} < now() - interval '1 day') AND (${proposals.review_attempted_at} IS NULL OR ${proposals.review_attempted_at} < now() - interval '1 hour')`;
export function proposalScore(
  p: { qualification?: Qualification | null },
  now = Date.now(),
) {
  const q = p.qualification;
  if (!q) return 0;
  const base = {
    verbal_promise: { customer: 700, internal: 650, personal: 300 },
    written_promise: { customer: 600, internal: 550, personal: 250 },
    direct_request: { customer: 500, internal: 450, personal: 200 },
  };
  const days = q.due_date
    ? (Date.parse(q.due_date) - now) / 86400000
    : Infinity;
  return (
    (base[q.basis]?.[q.area] || 0) +
    (days <= 7 ? 40 : days <= 14 ? 20 : 0) +
    (q.deadline_kind === 'hard' ? 10 : 0)
  );
}
export async function validateQualification(p: Proposal) {
  const q = p.qualification;
  if (!q) return;
  const c = p.citations.find((c) => c.quote.includes(q.commitment_quote));
  if (!c)
    throw Error(
      'A commitment needs an exact ownership excerpt in its citations.',
    );
  const [source] = await db
    .select({
      provider: sources.provider,
      coverage: sources.coverage,
      body: source_versions.normalized_body,
    })
    .from(source_versions)
    .innerJoin(sources, eq(sources.id, source_versions.source_id))
    .where(
      and(
        eq(source_versions.id, c.source_version_id),
        eq(sources.id, c.source_id),
      ),
    );
  if (q.basis === 'verbal_promise') {
    const transcript = source?.body
      ?.split(/\n?Transcript\n/)
      .slice(1)
      .join('\nTranscript\n');
    if (
      !source ||
      !['granola', 'fireflies'].includes(source.provider) ||
      !transcript?.includes(q.commitment_quote)
    )
      throw Error(
        'A verbal promise requires an exact transcript excerpt, not a summary attribution.',
      );
  }
  if (
    q.basis === 'written_promise' &&
    (!source || !['gmail', 'beeper', 'manual'].includes(source.provider))
  )
    throw Error('A written promise needs a message or owner note.');
  if (q.due_date) {
    if (!dateOK(q.due_date) || q.deadline_kind === 'none')
      throw Error('A suggested date needs a valid date and deadline basis.');
    const deadline = p.citations.find(
      (c) =>
        c.source_id === q.deadline_source_id &&
        c.quote.includes(q.deadline_quote),
    );
    if (q.deadline_quote.length < 8 || !deadline)
      throw Error('A suggested deadline needs an exact cited date basis.');
    if (q.deadline_source_id.startsWith('calendar:')) {
      const [event] = await db
        .select({
          content_hash: sources.content_hash,
          cited_hash: source_versions.content_hash,
          raw_json: source_versions.raw_json,
        })
        .from(sources)
        .innerJoin(source_versions, eq(source_versions.source_id, sources.id))
        .where(
          and(
            eq(sources.id, q.deadline_source_id),
            eq(source_versions.id, deadline.source_version_id),
          ),
        );
      const raw = event ? JSON.parse(event.raw_json) : null;
      const sync = await getSetting('calendar_last_sync');
      if (
        !calendarGranted((await secrets()).calendar_tokens) ||
        !sync?.at ||
        Date.now() - Date.parse(sync.at) > 30 * 60000
      )
        throw Error('Calendar checkpoints require a fresh calendar sync.');
      if (
        !raw ||
        event!.content_hash !== event!.cited_hash ||
        ['cancelled', 'tentative'].includes(raw.status) ||
        raw.attendees?.some(
          (a: { self?: boolean; responseStatus: string }) =>
            a.self &&
            ['declined', 'tentative', 'needsAction'].includes(a.responseStatus),
        )
      )
        throw Error(
          'A calendar checkpoint needs the current, non-cancelled event.',
        );
      const start = raw.start?.dateTime || raw.start?.date;
      if (!start || q.due_date > start.slice(0, 10))
        throw Error(
          'A preparation checkpoint must precede or match its event date.',
        );
      if (q.deadline_kind !== 'checkpoint')
        throw Error(
          'Calendar attendance alone establishes a preparation checkpoint, not a hard deadline.',
        );
    }
  } else if (
    q.deadline_kind !== 'none' ||
    q.deadline_source_id ||
    q.deadline_quote
  )
    throw Error('Deadline evidence requires a date.');
}
export async function proposalEvent(
  id: string,
  action: string,
  reason: string,
  detail: object = {},
  jobId: string | null = null,
) {
  await run(
    'INSERT INTO proposal_events(id,proposal_id,job_id,action,reason,detail) VALUES(?,?,?,?,?,?::jsonb)',
    uid(),
    id,
    jobId,
    action,
    reason,
    JSON.stringify(detail),
  );
}
export async function rebalanceProposals() {
  const rows = await all(`SELECT * FROM proposals WHERE status IN ${open}`);
  for (const row of rows) row.score = proposalScore(JSON.parse(row.payload));
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.created_at.localeCompare(a.created_at) ||
      a.id.localeCompare(b.id),
  );
  for (const [i, row] of rows.entries()) {
    const status = i < SHORTLIST_LIMIT ? 'pending' : 'deferred';
    await run(
      'UPDATE proposals SET priority_score=? WHERE id=?',
      row.score,
      row.id,
    );
    if (status !== row.status) {
      await run(
        'UPDATE proposals SET status=?,version=version+1 WHERE id=?',
        status,
        row.id,
      );
      await proposalEvent(row.id, status, 'shortlist', {
        from: row.status,
        to: status,
      });
    }
  }
}
export async function saveProposals(
  jobId: string,
  proposals: Proposal[],
  { automatic = false }: { automatic?: boolean } = {},
) {
  const saved: Proposal[] = [];
  for (const p of proposals) {
    // Old/manual clients remain compatible; automatic discovery must qualify ownership.
    if (automatic && !p.qualification) continue;
    const key = p.qualification?.deliverable_key.trim().toLowerCase() || '';
    const fingerprint = hash({
      title: p.title.trim().toLowerCase(),
      source: p.citations[0]!.source_id,
      item: p.existing_item_id,
    });
    const old = p.existing_proposal_id
      ? await one('SELECT * FROM proposals WHERE id=?', p.existing_proposal_id)
      : await one(
          "SELECT * FROM proposals WHERE fingerprint=? OR (deliverable_key<>? AND deliverable_key=?) OR (?<>'' AND payload::jsonb->'qualification'->>'commitment_quote'=? AND payload::jsonb->'citations' @> jsonb_build_array(jsonb_build_object('source_id',?::text))) ORDER BY created_at LIMIT 1",
          fingerprint,
          '',
          key,
          p.qualification?.commitment_quote || '',
          p.qualification?.commitment_quote || '',
          p.citations[0]!.source_id,
        );
    if (old) {
      if (!['pending', 'deferred'].includes(old.status)) continue;
      // Updating an existing suggestion requires the version the reviewer actually read.
      if (
        p.existing_proposal_id !== old.id ||
        p.proposal_version !== old.version
      )
        continue;
      if (
        key &&
        (await one(
          'SELECT id FROM proposals WHERE deliverable_key=? AND id<>?',
          key,
          old.id,
        ))
      )
        continue;
      await run(
        'UPDATE proposals SET payload=?,deliverable_key=?,version=version+1,reviewed_at=now() WHERE id=?',
        JSON.stringify(p),
        key || old.deliverable_key,
        old.id,
      );
      await proposalEvent(
        old.id,
        'updated',
        'new_evidence',
        { before: JSON.parse(old.payload), after: p },
        jobId,
      );
      saved.push(p);
      continue;
    }
    if (p.existing_proposal_id) continue;
    const id = uid();
    await run(
      'INSERT INTO proposals(id,job_id,fingerprint,status,payload,created_at,deliverable_key,priority_score) VALUES(?,?,?,?,?,?,?,?)',
      id,
      jobId,
      fingerprint,
      'pending',
      JSON.stringify(p),
      stamp(),
      key,
      proposalScore(p),
    );
    await proposalEvent(
      id,
      'created',
      'source_backed',
      { qualification: p.qualification },
      jobId,
    );
    saved.push(p);
  }
  return saved;
}
export async function reconcileProposals(
  jobId: string,
  reconciliations: Reconciliation[],
) {
  const applied: Reconciliation[] = [];
  for (const r of reconciliations) {
    const before = await one(
      `SELECT * FROM proposals WHERE id=? AND version=? AND status IN ${open}`,
      r.proposal_id,
      r.version,
    );
    if (!before) continue;
    if (
      r.reason === 'duplicate' &&
      (!r.related_proposal_id ||
        r.related_proposal_id === r.proposal_id ||
        !(await one(
          'SELECT id FROM proposals WHERE id=?',
          r.related_proposal_id,
        )))
    )
      throw Error('Duplicate cleanup needs the retained proposal.');
    await run(
      "UPDATE proposals SET status='dismissed',version=version+1,reviewed_at=now() WHERE id=?",
      r.proposal_id,
    );
    await proposalEvent(
      r.proposal_id,
      'dismissed',
      r.reason,
      { ...r, before: JSON.parse(before.payload) },
      jobId,
    );
    applied.push(r);
  }
  return applied;
}
export async function dismissProposal(id: string) {
  return transaction(async () => {
    await lockWorkspace();
    const changed = await run(
      `UPDATE proposals SET status='dismissed',version=version+1 WHERE id=? AND status IN ${open}`,
      id,
    );
    if (!changed.changes)
      throw Error('Proposal not found or already resolved.');
    await proposalEvent(id, 'dismissed', 'user_decision');
    await rebalanceProposals();
    return { dismissed: true, id };
  });
}
export async function restoreProposal(id: string, version: number) {
  return transaction(async () => {
    await lockWorkspace();
    const changed = await run(
      "UPDATE proposals SET status='pending',version=version+1,reviewed_at=now() WHERE id=? AND version=? AND status='dismissed'",
      id,
      version,
    );
    if (!changed.changes)
      throw Error('This suggestion changed. Reopen it before restoring.');
    await proposalEvent(id, 'restored', 'user_decision');
    await rebalanceProposals();
    return { restored: true, id };
  });
}
export async function readProposals(
  {
    offset = 0,
    status = 'open',
    query = '',
  }: { offset?: unknown; status?: string; query?: string } = {},
  jobId?: string,
) {
  const start = Math.max(0, Number(offset) || 0);
  const rows = await db
    .select()
    .from(proposals)
    .where(
      and(
        status === 'assigned'
          ? exists(
              db
                .select({ one: sql`1` })
                .from(proposal_review_batches)
                .where(
                  and(
                    eq(proposal_review_batches.proposal_id, proposals.id),
                    eq(proposal_review_batches.job_id, jobId || ''),
                  ),
                ),
            )
          : status === 'open'
            ? isOpen()
            : eq(proposals.status, status),
        query
          ? sql`to_tsvector('simple', ${proposals.payload}::jsonb->>'title') @@ plainto_tsquery('simple', ${query})`
          : undefined,
      ),
    )
    .orderBy(
      desc(proposals.priority_score),
      desc(proposals.created_at),
      proposals.id,
    )
    .limit(11)
    .offset(start);
  return {
    records: rows
      .slice(0, 10)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
    next_offset: rows.length > 10 ? start + 10 : null,
    shortlist_limit: SHORTLIST_LIMIT,
  };
}
export async function assignProposalReview(jobId: string) {
  const rows = await all(
    `SELECT id,version FROM proposals WHERE status IN ${open} AND ${due} ORDER BY reviewed_at NULLS FIRST,review_attempted_at NULLS FIRST,created_at,id LIMIT 3`,
  );
  for (const row of rows) {
    await run(
      'INSERT INTO proposal_review_batches VALUES(?,?,?)',
      jobId,
      row.id,
      row.version,
    );
    await run(
      'UPDATE proposals SET review_attempted_at=now() WHERE id=?',
      row.id,
    );
  }
  return rows.length;
}
export async function completeProposalReview(
  jobId: string,
  checks: ProposalCheck[] = [],
) {
  for (const check of checks) {
    const updated = await run(
      `UPDATE proposals p SET reviewed_at=now() FROM proposal_review_batches b WHERE b.job_id=? AND b.proposal_id=p.id AND b.version=p.version AND p.id=? AND p.version=? AND p.status IN ${open}`,
      jobId,
      check.proposal_id,
      check.version,
    );
    if (updated.changes)
      await proposalEvent(
        check.proposal_id,
        'reviewed',
        'retained_with_evidence',
        check,
        jobId,
      );
  }
}
export async function maintenanceDue() {
  const [last] = await db
    .select({ status: jobs.status, updated_at: jobs.updated_at })
    .from(jobs)
    .where(eq(jobs.kind, 'backlog_review'))
    .orderBy(desc(jobs.created_at))
    .limit(1);
  if (
    last?.status === 'failed' &&
    Date.now() - Date.parse(last.updated_at) < 3600000
  )
    return false;
  const [stale] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(isOpen(), reviewDue()))
    .limit(1);
  return Boolean(stale);
}
export async function readProposalEvidence(id: string) {
  const [row] = await db
    .select({ payload: proposals.payload })
    .from(proposals)
    .where(eq(proposals.id, id));
  if (!row) throw Error('Proposal not found.');
  const windows = [];
  let remaining = 18000;
  for (const c of JSON.parse(row.payload).citations.slice(0, 6)) {
    const [s] = await db
      .select({
        title: sources.title,
        provider: sources.provider,
        current_hash: sources.content_hash,
        source_version_id: source_versions.id,
        content_hash: source_versions.content_hash,
        body: source_versions.normalized_body,
      })
      .from(source_versions)
      .innerJoin(sources, eq(sources.id, source_versions.source_id))
      .where(
        and(
          eq(source_versions.source_id, c.source_id),
          eq(source_versions.id, c.source_version_id),
        ),
      );
    if (!s?.body) continue;
    const index = s.body.indexOf(c.quote);
    if (index < 0) continue;
    const offset = Math.max(0, index - 1000),
      end = Math.min(s.body.length, offset + Math.min(remaining, 5000));
    if (end <= index) break;
    windows.push({
      source_id: c.source_id,
      source_version_id: s.source_version_id,
      title: s.title,
      provider: s.provider,
      is_current: s.current_hash === s.content_hash,
      body: s.body.slice(offset, end),
      offset,
      end,
      total_characters: s.body.length,
      next_offset: end < s.body.length ? end : null,
    });
    remaining -= end - offset;
    if (remaining <= 0) break;
  }
  return {
    proposal_id: id,
    sources: windows,
    note: 'Scoped windows around the cited promise, not the full sources. Search newer evidence and read current snapshots before deciding whether it remains open.',
  };
}

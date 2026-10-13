import {
  validateQualification,
  saveProposals,
  reconcileProposals,
  rebalanceProposals,
  assignProposalReview,
  completeProposalReview,
  maintenanceDue,
} from './proposals.ts';
import { savePriorityEnrichment, stackId } from './priorities.ts';
import { expireLeases, requireLease, cancelLease } from './leases.ts';
import { REMOTE_WORKERS } from './runtime.mjs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  assignReviewBatch,
  completeReviewBatch,
  releaseFailedReviewBatches,
} from './review-batches.ts';
import {
  uid,
  stamp,
  hash,
  root,
  upsertSource,
  getSetting,
  setSetting,
} from './db.ts';
import { db, transaction, lockWorkspace } from './postgres.ts';
import {
  contacts,
  items,
  job_events,
  jobs,
  message_drafts,
  priorities,
  review_queue,
  source_versions,
  sources,
} from './schema/index.ts';
const ContactDraft = z
  .object({
    contact_id: z.string(),
    subject: z.string().max(300),
    body: z.string().min(1).max(12000),
    citations: z
      .array(
        z
          .object({
            source_id: z.string(),
            source_version_id: z.string().default(''),
            quote: z.string().min(8).max(1500),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const Citation = z
  .object({
    source_id: z.string(),
    source_version_id: z.string().default(''),
    quote: z.string().min(8).max(1500),
  })
  .strict();
const PriorityUpdate = z
  .object({
    priority_id: z.string().min(1),
    summary: z.string().min(1).max(1200),
    next_decision: z.string().max(1000),
    suggested_rank: z.number().int().min(1).max(1000).nullable(),
    reason: z.string().max(1000),
    citations: z.array(Citation).min(1).max(6),
  })
  .strict();
const PrioritySuggestion = z
  .object({
    stack_id: stackId,
    title: z.string().trim().min(1).max(200),
    summary: z.string().min(1).max(1200),
    next_decision: z.string().max(1000),
    citations: z.array(Citation).min(1).max(6),
  })
  .strict();
const Qualification = z
  .object({
    basis: z.enum(['verbal_promise', 'written_promise', 'direct_request']),
    area: z.enum(['customer', 'internal', 'personal']),
    deliverable_key: z.string().trim().min(3).max(180),
    owner_basis: z.string().min(12).max(1000),
    commitment_quote: z.string().min(8).max(1500),
    due_date: z.string().max(10),
    deadline_kind: z.enum(['none', 'hard', 'checkpoint']),
    deadline_source_id: z.string(),
    deadline_quote: z.string().max(1500),
  })
  .strict();
const Reconciliation = z
  .object({
    proposal_id: z.string(),
    version: z.number().int().positive(),
    reason: z.enum([
      'completed',
      'superseded',
      'duplicate',
      'expired_event',
      'not_own_commitment',
      'routine_notice',
    ]),
    explanation: z.string().min(12).max(1200),
    related_proposal_id: z.string().default(''),
    citations: z.array(Citation).min(1).max(6),
  })
  .strict();
const ProposalCheck = z
  .object({
    proposal_id: z.string(),
    version: z.number().int().positive(),
    explanation: z.string().min(12).max(1000),
    citations: z.array(Citation).min(1).max(4),
  })
  .strict();
export const AgentResult = z
  .object({
    brief: z.string().min(1),
    findings: z
      .array(
        z
          .object({ text: z.string(), citations: z.array(Citation).min(1) })
          .strict(),
      )
      .max(8),
    proposals: z
      .array(
        z
          .object({
            title: z.string(),
            kind: z.enum(['action', 'decision']),
            rationale: z.string(),
            done_when: z.string(),
            next_action: z.string(),
            existing_item_id: z.string(),
            uncertainty: z.string(),
            confidence: z.enum(['high', 'medium', 'low']),
            qualification: Qualification.nullable().default(null),
            existing_proposal_id: z.string().default(''),
            proposal_version: z.number().int().nonnegative().default(0),
            contact_ids: z.array(z.string()).max(20).default([]),
            citations: z.array(Citation).min(1),
          })
          .strict(),
      )
      .max(5),
    proposal_checks: z.array(ProposalCheck).max(3).default([]),
    proposal_reconciliations: z.array(Reconciliation).max(10).default([]),
    priority_updates: z.array(PriorityUpdate).max(6).default([]),
    priority_suggestions: z.array(PrioritySuggestion).max(3).default([]),
    drafts: z.array(ContactDraft).max(3).default([]),
    questions: z.array(z.string()).max(5),
    coverage_note: z.string(),
  })
  .strict();
export const schema = z.toJSONSchema(AgentResult);
type AgentOutput = z.output<typeof AgentResult>;
export async function validateResult(value: unknown) {
  const result = AgentResult.parse(value);
  for (const item of [
    ...result.findings,
    ...result.proposals,
    ...result.proposal_checks,
    ...result.proposal_reconciliations,
    ...result.drafts,
    ...result.priority_updates,
    ...result.priority_suggestions,
  ])
    for (const c of item.citations) {
      const [s] = await db
        .select({ body: sources.body, content_hash: sources.content_hash })
        .from(sources)
        .where(eq(sources.id, c.source_id));
      const version = c.source_version_id
        ? (
            await db
              .select()
              .from(source_versions)
              .where(
                and(
                  eq(source_versions.id, c.source_version_id),
                  eq(source_versions.source_id, c.source_id),
                ),
              )
          )[0]
        : s
          ? (
              await db
                .select()
                .from(source_versions)
                .where(
                  and(
                    eq(source_versions.source_id, c.source_id),
                    eq(source_versions.content_hash, s.content_hash),
                  ),
                )
            )[0]
          : null;
      const body =
        version?.normalized_body ??
        (version?.content_hash === s?.content_hash ? s?.body : null);
      if (!body || !body.includes(c.quote))
        throw Error(
          'The agent returned an unverified source excerpt. Nothing was accepted. Run it again.',
        );
      c.source_version_id = version!.id;
    }
  for (const p of result.proposals) await validateQualification(p);
  for (const p of result.proposals)
    if (
      p.existing_item_id &&
      !(
        await db
          .select({ id: items.id })
          .from(items)
          .where(eq(items.id, p.existing_item_id))
      ).length
    )
      throw Error('The agent referred to an unknown commitment.');
  for (const p of result.proposals)
    for (const id of p.contact_ids)
      if (
        !(
          await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(
              and(
                eq(contacts.id, id),
                isNull(contacts.merged_into),
                eq(contacts.archived, false),
              ),
            )
        ).length
      )
        throw Error('The agent referred to an unknown contact.');
  for (const d of result.drafts)
    if (
      !(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, d.contact_id),
              isNull(contacts.merged_into),
              eq(contacts.archived, false),
              eq(contacts.do_not_contact, false),
            ),
          )
      ).length
    )
      throw Error('This contact is unavailable for drafting.');
  for (const p of result.priority_updates)
    if (
      !(
        await db
          .select({ id: priorities.id })
          .from(priorities)
          .where(eq(priorities.id, p.priority_id))
      ).length
    )
      throw Error('The agent referred to an unknown priority.');
  const meta = new Map<
    string,
    { title: string; provider: string; occurred_at: string } | undefined
  >();
  for (const item of [
    ...result.findings,
    ...result.proposals,
    ...result.proposal_checks,
    ...result.proposal_reconciliations,
    ...result.drafts,
    ...result.priority_updates,
    ...result.priority_suggestions,
  ])
    item.citations = await Promise.all(
      item.citations.map(async (c) => {
        if (!meta.has(c.source_id))
          meta.set(
            c.source_id,
            (
              await db
                .select({
                  title: sources.title,
                  provider: sources.provider,
                  occurred_at: sources.occurred_at,
                })
                .from(sources)
                .where(eq(sources.id, c.source_id))
            )[0],
          );
        return { ...c, ...meta.get(c.source_id) };
      }),
    );
  return result;
}
export async function saveResult(
  id: string,
  value: unknown,
  leaseToken?: string,
) {
  let result: AgentOutput | undefined;
  await transaction(async () => {
    await lockWorkspace();
    result = await validateResult(value);
    if (leaseToken) await requireLease('jobs', id, leaseToken);
    else if (
      !(
        await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])),
          )
          .for('update')
      ).length
    )
      throw Error('This review is no longer running.');
    const [job] = await db
      .select({ kind: jobs.kind })
      .from(jobs)
      .where(eq(jobs.id, id));
    result.proposal_reconciliations = await reconcileProposals(
      id,
      result.proposal_reconciliations,
    );
    result.proposals = await saveProposals(id, result.proposals, {
      automatic:
        job!.kind === 'import_review' || job!.kind === 'backlog_review',
    });
    await completeProposalReview(id, result.proposal_checks);
    await rebalanceProposals();
    for (const d of result.drafts)
      await db.insert(message_drafts).values({
        id: uid(),
        contact_id: d.contact_id,
        job_id: id,
        subject: d.subject,
        body: d.body,
        citations: d.citations,
      });
    await db
      .update(jobs)
      .set({
        status: 'complete',
        result_json: JSON.stringify(result),
        progress: 'Review ready',
        updated_at: stamp(),
      })
      .where(eq(jobs.id, id));
    await savePriorityEnrichment(
      id,
      result.priority_updates,
      result.priority_suggestions,
    );
    await completeReviewBatch(id);
  });
  return result;
}
export async function createJob(
  prompt: unknown,
  kind = 'review',
  options: { answers?: unknown; parent_id?: unknown } = {},
) {
  const answers = (Array.isArray(options.answers) ? options.answers : [])
    .map((a) => ({
      question: String(a?.question || '').trim(),
      answer: String(a?.answer || '').trim(),
    }))
    .filter((a) => a.answer);
  if (
    Array.isArray(options.answers) &&
    options.answers.length &&
    !answers.length
  )
    throw Error('Answer at least one question.');
  let text = String(prompt || '');
  if (answers.length) {
    const [parent] = await db
      .select({ prompt: jobs.prompt })
      .from(jobs)
      .where(eq(jobs.id, String(options.parent_id || '')));
    if (!parent)
      throw Error('The review you are answering is no longer available.');
    text = [
      'Follow-up to review ' + options.parent_id + '.',
      '',
      'My answers to your questions:',
      ...answers.map((a) => '- Q: ' + a.question + '\n  A: ' + a.answer),
      '',
      'Original request: ' + parent.prompt,
      '',
      'Continue that review using these answers as verified facts from me. Re-check the sources, update the findings and proposals, and ask only new questions.',
    ].join('\n');
  }
  if (!text.trim()) throw Error('Tell the agent what to look into.');
  const id = await transaction(async () => {
    await lockWorkspace();
    const [active] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']));
    if (active)
      throw Error(
        'An agent is already working. Let it finish before starting another review.',
      );
    const id = uid();
    await db.insert(jobs).values({
      id,
      kind,
      status: 'queued',
      prompt: text.slice(0, 6000),
      created_at: stamp(),
      updated_at: stamp(),
      progress: 'Starting the context review',
    });
    return id;
  });
  if (kind === 'review')
    await upsertSource(
      {
        provider: 'manual',
        external_id: 'agent-request-' + id,
        title: 'Request to Focus · ' + new Date().toISOString().slice(0, 10),
        occurred_at: stamp(),
        body: text,
        coverage: 'note',
      },
      { origin: 'Request entered through the local app', text },
    );
  return id;
}
export async function cancelJob(id: string) {
  await cancelLease('jobs', String(id || ''), 'Review cancelled.');
  await db.update(jobs).set({ progress: 'Cancelled' }).where(eq(jobs.id, id));
  const next = await takePendingImportReview();
  if (next) launchJob(next);
  return { cancelled: true };
}
export function launchJob(id: string) {
  if (REMOTE_WORKERS) return id;
  const child = spawn(
    process.execPath,
    [resolve(root, 'scripts/worker.mjs'), id],
    {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, XIN_APP_ROOT: root },
    },
  );
  child.unref();
  child.on('error', async () => {
    try {
      await db
        .update(jobs)
        .set({
          status: 'failed',
          error: 'Could not start the agent process.',
          updated_at: stamp(),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')));
    } catch {}
  });
  return id;
}
export async function addProgress(id: string, label: string) {
  await db
    .insert(job_events)
    .values({ job_id: id, label, created_at: stamp() });
  await db
    .update(jobs)
    .set({ progress: label, updated_at: stamp() })
    .where(
      and(
        eq(jobs.id, id),
        inArray(jobs.status, ['queued', 'running', 'complete']),
      ),
    );
}
export async function recoverJobs() {
  return expireLeases('jobs');
}

export async function takePendingImportReview() {
  return await transaction(async () => {
    await lockWorkspace();
    if (
      (
        await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(inArray(jobs.status, ['queued', 'running']))
      ).length
    )
      return null;
    await releaseFailedReviewBatches();
    const [pending] = await db
      .select({ source_id: review_queue.source_id })
      .from(review_queue)
      .where(
        and(
          eq(review_queue.completed, false),
          isNull(review_queue.job_id),
          lt(review_queue.attempts, 3),
          or(
            isNull(review_queue.retry_after),
            sql`${review_queue.retry_after} <= now()`,
          ),
        ),
      )
      .limit(1);
    const legacy = await getSetting('pending_import_review'),
      maintenance = await maintenanceDue();
    if (!pending && !legacy && !maintenance) return null;
    const prompt = maintenance
      ? 'Review the assigned pending and deferred suggestions using read_proposals with status assigned. Use read_proposal_evidence for the passages around each promise, then read further if needed. Search for newer delivery, cancellation, replacement and calendar evidence, and reconcile resolved or non-obligations. Qualify and update genuine promises with their current proposal version. Do not dismiss a real promise solely because it is old. Keep accepted commitments unchanged. Read read_calendar for current deadlines and freshness.'
      : pending
        ? 'Review the source pages assigned by read_import_batch, reconcile them against read_commitments, read_priorities and pending proposals; enrich matching priorities with dated, cited context, and suggest new priorities only for substantive ongoing initiatives, and propose only useful, source-backed decisions. Every assigned page is provided in the cloud prompt or available through read_import_batch. Be explicit about partial transcripts and remaining coverage; do not claim to have reviewed the whole archive. Older obligations require current evidence. Do not ask the user to retrieve IDs or records available through your tools.'
        : legacy;
    const id = uid();
    await db.insert(jobs).values({
      id,
      kind: maintenance ? 'backlog_review' : 'import_review',
      status: 'queued',
      prompt,
      created_at: stamp(),
      updated_at: stamp(),
      progress: 'Reviewing imported context',
    });
    if (maintenance) await assignProposalReview(id);
    else {
      await assignReviewBatch(id);
      await setSetting('pending_import_review', null);
    }
    return id;
  });
}
export async function queueImportReview() {
  const id = await takePendingImportReview();
  if (id) await launchJob(id);
  return id;
}

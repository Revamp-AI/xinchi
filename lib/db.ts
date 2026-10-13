import {
  and,
  count,
  desc,
  eq,
  getColumns,
  getTableName,
  inArray,
  is,
  isNull,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
  gte,
} from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { CONTACT_TABLES } from './contact-tables.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MARK_START, MARK_END } from './marks.mjs';
import { transaction, lockWorkspace, db } from './postgres.ts';
import { SERVERLESS } from './runtime.mjs';
import { queueSourceReview } from './review-batches.ts';
import {
  contact_queue,
  contacts,
  events,
  item_contacts,
  items,
  jobs,
  proposal_events,
  proposals,
  settings,
  source_versions,
  sources,
  sync_runs,
} from './schema/index.ts';
import * as schema from './schema/index.ts';
export {
  all,
  one,
  run,
  transaction,
  lockWorkspace,
  db,
  closeDatabase,
} from './postgres.ts';
export const root = resolve(
  /* turbopackIgnore: true */ process.env.XIN_APP_ROOT || process.cwd(),
);
export const dataDir = resolve(
  /* turbopackIgnore: true */ process.env.XIN_DATA_DIR ||
    (SERVERLESS ? '/tmp/focus' : resolve(root, 'data')),
);
if (!SERVERLESS) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export type SourceInput = {
  provider?: string;
  external_id?: string | number;
  title?: string;
  occurred_at?: string;
  body?: string;
  url?: string;
  coverage?: string;
};
type Item = typeof items.$inferSelect;
export const stamp = () => new Date().toISOString();
export const uid = () => randomUUID();
export const hash = (x: unknown) =>
  createHash('sha256')
    .update(typeof x === 'string' ? x : JSON.stringify(x))
    .digest('hex');
export async function getSetting(k: string, d: unknown = null) {
  const [r] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, k));
  return r ? JSON.parse(r.value) : d;
}
export async function setSetting(k: string, v: unknown) {
  const r = await db
    .insert(settings)
    .values({ key: k, value: JSON.stringify(v) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`excluded.value` },
    });
  return { changes: r.rowCount, rows: r.rows };
}
export async function upsertSource(doc: SourceInput, raw: unknown = doc) {
  return await transaction(async () => {
    const provider = String(doc.provider || 'manual'),
      external_id = String(doc.external_id || '').trim();
    if (
      ![
        'fireflies',
        'granola',
        'gmail',
        'manual',
        'beeper',
        'calendar',
      ].includes(provider) ||
      !external_id ||
      !doc.title
    )
      throw Error('A source needs a provider, ID, and title.');
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'source:' + provider + ':' + external_id}))`,
    );
    const [byUrl] =
      provider === 'granola' && doc.url
        ? await db
            .select()
            .from(sources)
            .where(
              and(
                eq(sources.provider, provider),
                or(
                  eq(sources.url, doc.url),
                  eq(sources.external_id, doc.url.split('/').pop()!),
                ),
              ),
            )
        : [];
    const id = byUrl?.id || provider + ':' + external_id,
      [old] = await db.select().from(sources).where(eq(sources.id, id));
    const values = {
      title: String(doc.title),
      occurred_at: String(doc.occurred_at || ''),
      body: String(doc.body || ''),
      url: /^https?:\/\//.test(doc.url || '') ? doc.url! : '',
      coverage: doc.coverage || 'metadata',
    };
    if (values.occurred_at && !isNaN(Date.parse(values.occurred_at)))
      values.occurred_at = new Date(values.occurred_at).toISOString();
    const rank: Record<string, number> = {
      metadata: 0,
      empty: 0,
      summary: 1,
      document: 2,
      'email body': 2,
      'message body': 2,
      transcript: 3,
      'deleted upstream': 4,
    };
    if (
      old &&
      values.coverage !== 'empty' &&
      (rank[values.coverage] ?? 1) < (rank[old.coverage] ?? 1)
    ) {
      values.body = old.body;
      values.coverage = old.coverage;
    }
    const content_hash = hash({ values, raw }),
      date = stamp();
    if (old?.content_hash === content_hash) return { id, changed: false };
    await transaction(async () => {
      await db
        .insert(sources)
        .values({
          id,
          provider,
          external_id,
          ...values,
          content_hash,
          imported_at: date,
          updated_at: date,
        })
        .onConflictDoUpdate({
          target: sources.id,
          set: {
            title: sql`excluded.title`,
            occurred_at: sql`excluded.occurred_at`,
            body: sql`excluded.body`,
            url: sql`excluded.url`,
            coverage: sql`excluded.coverage`,
            content_hash: sql`excluded.content_hash`,
            updated_at: sql`excluded.updated_at`,
          },
        });
      await db
        .insert(source_versions)
        .values({
          id: uid(),
          source_id: id,
          content_hash,
          raw_json: JSON.stringify(raw),
          fetched_at: date,
          normalized_body: values.body,
        })
        .onConflictDoNothing();
      if (
        !old ||
        old.body !== values.body ||
        old.title !== values.title ||
        old.occurred_at !== values.occurred_at
      )
        await queueSourceReview(id);

      if (provider !== 'calendar')
        await db
          .insert(contact_queue)
          .values({ source_id: id, content_hash })
          .onConflictDoUpdate({
            target: contact_queue.source_id,
            set: {
              content_hash: sql`excluded.content_hash`,
              state: 'pending',
              attempts: 0,
              error: '',
              updated_at: sql`now()`,
            },
          });
    });
    return { id, changed: true };
  });
}
export async function searchSources(
  q: unknown = '',
  provider = '',
  offset: unknown = 0,
) {
  const tokens: string[] = String(q).match(/[\p{L}\p{N}_]+/gu) || [],
    where: SQL[] = [];
  if (provider) where.push(eq(sources.provider, provider));
  const query = tokens.join(' ');
  // The same expression as the source_search index.
  const document = sql`to_tsvector('simple', ${sources.title} || ' ' || ${sources.body})`,
    terms = sql`plainto_tsquery('simple', ${query})`;
  if (tokens.length) where.push(sql`${document} @@ ${terms}`);
  const total = await db.$count(sources, and(...where));
  const rows = await db
    .select({
      id: sources.id,
      provider: sources.provider,
      title: sources.title,
      occurred_at: sources.occurred_at,
      coverage: sources.coverage,
      body: sources.body,
    })
    .from(sources)
    .where(and(...where))
    .orderBy(
      ...(tokens.length ? [sql`ts_rank(${document}, ${terms}) DESC`] : []),
      desc(sources.occurred_at),
      sources.id,
    )
    .limit(40)
    .offset(Math.max(0, Number(offset) || 0));
  return {
    total,
    records: rows.map(({ body, ...row }) => ({
      ...row,
      excerpt: sourceExcerpt(body, tokens),
    })),
  };
}
// Contiguous excerpts retain source characters exactly; only explicit display markers are added.
export function sourceExcerpt(body: string, tokens: string[]) {
  if (!tokens.length) return body.slice(0, 250);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const expression = new RegExp(
    '(?<![\\p{L}\\p{N}_])(' + escaped.join('|') + ')(?![\\p{L}\\p{N}_])',
    'giu',
  );
  const matches = [...body.matchAll(expression)];
  if (!matches.length) return body.slice(0, 250);
  const start =
    body.length <= 180
      ? 0
      : Math.max(
          0,
          body.lastIndexOf(' ', Math.max(0, matches[0]!.index - 45)) + 1,
        );
  const end =
    body.length <= 180 ? body.length : Math.min(body.length, start + 180);
  return (
    (start ? '…' : '') +
    body.slice(start, end).replace(expression, MARK_START + '$1' + MARK_END) +
    (end < body.length ? '…' : '')
  );
}
export async function readSource(id: string, offset = 0, limit = 14000) {
  const [s] = await db
    .select({ ...getColumns(sources), source_version_id: source_versions.id })
    .from(sources)
    .leftJoin(
      source_versions,
      and(
        eq(source_versions.source_id, sources.id),
        eq(source_versions.content_hash, sources.content_hash),
      ),
    )
    .where(eq(sources.id, id));
  if (!s) throw Error('Source not found.');
  return {
    ...s,
    body: s.body.slice(offset, offset + limit),
    total_characters: s.body.length,
    offset,
    next_offset: offset + limit < s.body.length ? offset + limit : null,
  };
}
export async function readSourceVersion(id: string) {
  const [v] = await db
    .select({
      ...getColumns(source_versions),
      provider: sources.provider,
      title: sources.title,
      occurred_at: sources.occurred_at,
      coverage: sources.coverage,
      url: sources.url,
    })
    .from(source_versions)
    .innerJoin(sources, eq(sources.id, source_versions.source_id))
    .where(eq(source_versions.id, id));
  if (!v) throw Error('Source snapshot not found.');
  return {
    id: v.source_id,
    source_version_id: v.id,
    provider: v.provider,
    title: v.title + ' · archived snapshot',
    occurred_at: v.occurred_at,
    coverage: v.coverage,
    url: v.url,
    body: v.normalized_body ?? v.raw_json,
    total_characters: (v.normalized_body ?? v.raw_json).length,
    offset: 0,
    next_offset: null,
  };
}
const fields = [
  'title',
  'kind',
  'status',
  'done_when',
  'next_action',
  'owner',
  'checkpoint',
  'hard_deadline',
  'dependency',
  'last_action',
  'fallback',
  'evidence',
  'reason',
  'source_id',
  'source_version_id',
  'source_quote',
  'shared',
] as const;
// What saveItem accepts: item fields plus the context of the save.
export type ItemInput = { [K in (typeof fields)[number]]?: unknown } & {
  id?: string;
  version?: number;
  proposal_id?: string;
  proposal_version?: number;
  replace_id?: string;
  tradeoff_reason?: string;
  replace_checkpoint?: string;
  contact_ids?: unknown;
};
// Validates untrusted input; only a real YYYY-MM-DD string passes.
export function dateOK(v: unknown): v is string {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(v as string) &&
    !isNaN(Date.parse(v as string)) &&
    new Date(v as string).toISOString().slice(0, 10) === v
  );
}
async function event(
  id: string,
  action: string,
  before: unknown,
  after: unknown,
  reason = '',
) {
  await db.insert(events).values({
    id: uid(),
    item_id: id,
    action,
    before_json: before ? JSON.stringify(before) : null,
    after_json: JSON.stringify(after),
    reason,
    created_at: stamp(),
  });
}
export async function saveItem(input: ItemInput) {
  return await transaction(async () => {
    await lockWorkspace();
    if (
      input.proposal_id &&
      !(
        await db
          .select({ id: proposals.id })
          .from(proposals)
          .where(
            and(
              eq(proposals.id, input.proposal_id),
              inArray(proposals.status, ['pending', 'deferred']),
            ),
          )
      ).length
    )
      throw Error('This proposal was already resolved.');
    if (
      input.proposal_id &&
      input.proposal_version! > 0 &&
      !(
        await db
          .select({ id: proposals.id })
          .from(proposals)
          .where(
            and(
              eq(proposals.id, input.proposal_id),
              eq(proposals.version, input.proposal_version!),
            ),
          )
      ).length
    )
      throw Error('This suggestion changed. Reopen it before deciding.');
    const before = input.id
      ? (await db.select().from(items).where(eq(items.id, input.id)))[0]
      : null;
    if (input.id && !before) throw Error('Item not found.');
    if (before && before.version !== input.version)
      throw Error('This item changed. Reopen it before saving.');
    const row: Item = before
      ? { ...before }
      : {
          id: uid(),
          title: '',
          kind: 'action',
          status: 'candidate',
          done_when: '',
          next_action: '',
          owner: 'You',
          checkpoint: '',
          hard_deadline: '',
          original_checkpoint: '',
          dependency: '',
          last_action: '',
          fallback: '',
          evidence: '',
          reason: '',
          source_id: null,
          source_version_id: null,
          source_quote: '',
          shared: 0,
          created_at: stamp(),
          updated_at: stamp(),
          version: 0,
        };
    for (const k of fields)
      if (k in input)
        (row as Record<string, unknown>)[k] =
          k === 'shared'
            ? Number(Boolean(input[k]))
            : ['source_id', 'source_version_id'].includes(k)
              ? input[k] || null
              : String(input[k] || '').trim();
    if (!row.title) throw Error('Name the output or decision.');
    if (
      !['action', 'decision'].includes(row.kind) ||
      !['candidate', 'now', 'waiting', 'later', 'done', 'dropped'].includes(
        row.status,
      )
    )
      throw Error('Choose a valid kind and status.');
    for (const k of ['checkpoint', 'hard_deadline'] as const)
      if (row[k] && !dateOK(row[k])) throw Error('Choose a valid date.');
    if (row.source_id) {
      const [s] = await db
        .select({ body: sources.body, content_hash: sources.content_hash })
        .from(sources)
        .where(eq(sources.id, row.source_id));
      if (!s) throw Error('Source not found.');
      const [v] = await db
        .select()
        .from(source_versions)
        .where(
          row.source_version_id
            ? and(
                eq(source_versions.id, row.source_version_id),
                eq(source_versions.source_id, row.source_id),
              )
            : and(
                eq(source_versions.source_id, row.source_id),
                eq(source_versions.content_hash, s.content_hash),
              ),
        );
      const body =
        v?.normalized_body ??
        (v?.content_hash === s.content_hash ? s.body : null);
      if (row.source_quote && (!body || !body.includes(row.source_quote)))
        throw Error('The excerpt must match the source text.');
      if (row.source_quote) row.source_version_id = v!.id;
    } else row.source_version_id = null;
    if (row.status === 'now') {
      for (const k of [
        'done_when',
        'next_action',
        'owner',
        'checkpoint',
      ] as const)
        if (!row[k])
          throw Error(
            'Accepting needs a defined output, next action, owner, and checkpoint.',
          );
      if (
        (await db.$count(
          items,
          and(eq(items.status, 'now'), ne(items.id, row.id)),
        )) >= 3
      ) {
        const [r] = await db
          .select()
          .from(items)
          .where(
            and(
              eq(items.id, input.replace_id || ''),
              eq(items.status, 'now'),
              ne(items.id, row.id),
            ),
          );
        if (
          !r ||
          !input.tradeoff_reason ||
          !dateOK(input.replace_checkpoint || '')
        )
          throw Error(
            'Three outcomes are active. Choose what this replaces, why, and when to reconsider it.',
          );
        const a = {
          ...r,
          status: 'later',
          reason: input.tradeoff_reason,
          checkpoint: input.replace_checkpoint,
          updated_at: stamp(),
          version: r.version + 1,
        };
        await db
          .update(items)
          .set({
            status: a.status,
            reason: a.reason,
            checkpoint: a.checkpoint,
            updated_at: a.updated_at,
            version: a.version,
          })
          .where(eq(items.id, r.id));
        await event(r.id, 'displaced', r, a, a.reason);
      }
      if (!row.original_checkpoint) row.original_checkpoint = row.checkpoint;
    }
    if (row.status === 'waiting' && (!row.dependency || !row.checkpoint))
      throw Error(
        'Waiting needs a person or dependency and a check-back date.',
      );
    if (row.status === 'later' && (!row.reason || !row.checkpoint))
      throw Error('Later needs a reason and a review date.');
    if (row.status === 'dropped' && !row.reason)
      throw Error('Record why you are closing this.');
    if (row.status === 'done' && !row.evidence)
      throw Error('Add the finished output or decision as evidence.');
    if (
      before?.original_checkpoint &&
      (row.checkpoint !== before.checkpoint ||
        (row.status !== before.status &&
          !['now', 'done'].includes(row.status))) &&
      !row.reason
    )
      throw Error('Record why this commitment changed.');
    row.updated_at = stamp();
    row.version++;
    await db
      .insert(items)
      .values(row)
      .onConflictDoUpdate({
        target: items.id,
        set: Object.fromEntries(
          Object.keys(row)
            .filter((k) => k !== 'id')
            .map((k) => [k, sql`excluded.${sql.identifier(k)}`]),
        ),
      });
    if (input.contact_ids !== undefined) {
      if (!Array.isArray(input.contact_ids) || input.contact_ids.length > 20)
        throw Error('Choose up to 20 related contacts.');
      const ids = [...new Set(input.contact_ids)];
      for (const id of ids)
        if (
          !(
            await db
              .select({ id: contacts.id })
              .from(contacts)
              .where(and(eq(contacts.id, id), isNull(contacts.merged_into)))
          ).length
        )
          throw Error('Related contact not found.');
      await db.delete(item_contacts).where(eq(item_contacts.item_id, row.id));
      for (const id of ids)
        await db
          .insert(item_contacts)
          .values({ item_id: row.id, contact_id: id });
    }
    await event(
      row.id,
      before ? 'updated' : 'created',
      before,
      row,
      row.reason,
    );
    if (input.proposal_id) {
      const { proposalEvent, rebalanceProposals } =
        await import('./proposals.ts');
      await db
        .update(proposals)
        .set({
          status: 'accepted',
          item_id: row.id,
          version: sql`${proposals.version} + 1`,
        })
        .where(eq(proposals.id, input.proposal_id));
      await proposalEvent(input.proposal_id, 'accepted', 'user_decision', {
        item_id: row.id,
      });
      await rebalanceProposals();
    }
    return row;
  });
}
export async function dashboard() {
  const latest = db
    .selectDistinctOn([sync_runs.provider])
    .from(sync_runs)
    .orderBy(sync_runs.provider, desc(sync_runs.started_at), desc(sync_runs.id))
    .as('latest');
  const checkpoint = (json: AnyColumn) => sql`(${json}::jsonb->>'checkpoint')`;
  const [
    itemRows,
    coverage,
    jobRows,
    pending,
    sync,
    sync_history,
    carryovers,
    focus,
    available_hours,
  ] = await Promise.all([
    await db.select().from(items).orderBy(items.created_at, items.id),
    await db
      .select({
        provider: sources.provider,
        coverage: sources.coverage,
        count: count(),
      })
      .from(sources)
      .groupBy(sources.provider, sources.coverage),
    await db.select().from(jobs).orderBy(desc(jobs.created_at)).limit(15),
    await db
      .select()
      .from(proposals)
      .where(eq(proposals.status, 'pending'))
      .orderBy(desc(proposals.priority_score), desc(proposals.created_at))
      .limit(10),
    await db
      .select()
      .from(latest)
      .orderBy(desc(latest.started_at), desc(latest.id)),
    await db
      .select()
      .from(sync_runs)
      .orderBy(desc(sync_runs.started_at), desc(sync_runs.id))
      .limit(30),
    await db
      .select({ item_id: events.item_id, n: count() })
      .from(events)
      .where(
        and(
          eq(events.action, 'updated'),
          sql`${checkpoint(events.before_json)} <> ''`,
          sql`${checkpoint(events.before_json)} <> ${checkpoint(events.after_json)}`,
          sql`(${events.after_json}::jsonb->>'status') = 'now'`,
        ),
      )
      .groupBy(events.item_id),
    await getSetting('focus', ''),
    await getSetting('available_hours', 0),
  ]);
  const deferred_proposals = (
    await db
      .select()
      .from(proposals)
      .where(eq(proposals.status, 'deferred'))
      .orderBy(desc(proposals.priority_score), desc(proposals.created_at))
  ).map((x) => ({ ...x, payload: JSON.parse(x.payload) }));
  const proposal_history = await db
    .select({
      ...getColumns(proposal_events),
      status: proposals.status,
      version: proposals.version,
      title: sql<string | null>`${proposals.payload}::jsonb->>'title'`,
    })
    .from(proposal_events)
    .innerJoin(proposals, eq(proposals.id, proposal_events.proposal_id))
    .where(eq(proposal_events.action, 'dismissed'))
    .orderBy(desc(proposal_events.created_at))
    .limit(30);
  return {
    items: itemRows,
    coverage,
    deferred_proposals,
    proposal_history,
    jobs: jobRows.map((x) => ({
      ...x,
      result: x.result_json ? JSON.parse(x.result_json) : null,
    })),
    proposals: pending.map((x) => ({ ...x, payload: JSON.parse(x.payload) })),
    sync,
    sync_history,
    carryovers,
    focus,
    available_hours,
    storage: 'postgres',
  };
}
export const exportTables = [
  'sources',
  'source_versions',
  'items',
  'events',
  'settings',
  'jobs',
  'proposals',
  'job_events',
  'sync_runs',
  'review_queue',
  'review_batches',
  'proposal_events',
  'proposal_review_batches',
  ...CONTACT_TABLES,
  'priority_stacks',
  'priority_order',
  'priorities',
  'priority_updates',
  'priority_suggestions',
];
// Public tables by name for the export list; focus_auth is never exported.
const publicTables = new Map(
  Object.values(schema as Record<string, unknown>)
    .filter((t): t is PgTable => is(t, PgTable) && !getTableConfig(t).schema)
    .map((t) => [getTableName(t), t]),
);
export async function exportData() {
  return transaction(async () => {
    await db.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
    );
    const data: Record<string, unknown> = {
      schema_version: 3,
      exported_at: stamp(),
    };
    for (const t of exportTables)
      data[t] = await db.select().from(publicTables.get(t)!);
    return data;
  });
}

export async function itemEvents(itemId: string) {
  return db
    .select()
    .from(events)
    .where(eq(events.item_id, itemId))
    .orderBy(desc(events.created_at));
}
// Commitments and their history since a date, for the update draft.
export async function updateDraftActivity(since: string) {
  return {
    items: await db.select().from(items),
    events: await db
      .select({ ...getColumns(events), shared: items.shared })
      .from(events)
      .innerJoin(items, eq(items.id, events.item_id))
      .where(gte(events.created_at, since))
      .orderBy(events.created_at),
  };
}

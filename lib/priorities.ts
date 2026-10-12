import { z } from 'zod';
import {
  and,
  desc,
  eq,
  getColumns,
  gte,
  inArray,
  ne,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import { db, transaction, lockWorkspace } from './postgres.ts';
import { all, one, run, uid, hash, stamp, upsertSource } from './db.mjs';
import {
  items,
  priorities,
  priority_order,
  priority_stacks,
  priority_suggestions,
  priority_updates,
  review_queue,
  source_versions,
  sources,
} from './schema/index.ts';
import type { AgentResult } from './agent.mjs';

type AgentOutput = z.output<typeof AgentResult>;
type PriorityUpdate = Pick<
  AgentOutput['priority_updates'][number],
  'priority_id' | 'summary' | 'next_decision' | 'suggested_rank' | 'citations'
>;
type PrioritySuggestion = AgentOutput['priority_suggestions'][number];
type Priority = typeof priorities.$inferSelect;

export const stackId = z.enum(['deal-flow', 'product', 'go-to-market']);
export const priorityFields = {
  stack_id: stackId,
  title: z.string().trim().min(1).max(200),
  owner: z.string().trim().min(1).max(200),
  financials: z.string().max(500),
  notes: z.string().max(4000),
  keywords: z.string().max(500),
  next_decision: z.string().max(1000),
  commitment_id: z.string().min(1).nullable(),
  status: z.enum(['active', 'done']),
};
export const priorityInput = z
  .object({
    id: z.string().min(1).optional(),
    version: z.number().int().positive().optional(),
  })
  .extend(z.object(priorityFields).partial().shape)
  .strict();

const stacksInOrder = () =>
  db
    .select()
    .from(priority_stacks)
    .orderBy(priority_stacks.position, priority_stacks.id);
async function orderVersion({ lock = false } = {}) {
  const query = db
    .select({ version: priority_order.version })
    .from(priority_order)
    .where(eq(priority_order.id, 1));
  const [order] = await (lock ? query.for('update') : query);
  return order!.version;
}
const bumpOrderVersion = () =>
  db
    .update(priority_order)
    .set({ version: sql`${priority_order.version} + 1` })
    .where(eq(priority_order.id, 1));
export async function prioritiesState() {
  const [stacks, items, suggestions, order_version] = await Promise.all([
    stacksInOrder(),
    db
      .select({
        ...getColumns(priorities),
        suggestion_count: db.$count(
          priority_suggestions,
          and(
            eq(priority_suggestions.priority_id, priorities.id),
            eq(priority_suggestions.status, 'pending'),
          ),
        ),
      })
      .from(priorities)
      .orderBy(priorities.position, priorities.id),
    db
      .select()
      .from(priority_suggestions)
      .where(eq(priority_suggestions.status, 'pending'))
      .orderBy(desc(priority_suggestions.created_at))
      .limit(100),
    orderVersion(),
  ]);
  return { stacks, items, suggestions, order_version };
}
export async function readPriorities({
  offset = 0,
}: { offset?: unknown } = {}) {
  const stacks = await stacksInOrder();
  const start = Math.max(0, Number(offset) || 0);
  const rows = await db
    .select(getColumns(priorities))
    .from(priorities)
    .innerJoin(priority_stacks, eq(priority_stacks.id, priorities.stack_id))
    .where(eq(priorities.status, 'active'))
    .orderBy(priority_stacks.position, priorities.position, priorities.id)
    .limit(21)
    .offset(start);
  const items = [];
  let size = 0;
  for (const row of rows.slice(0, 20)) {
    const p = {
      ...row,
      notes: row.notes.slice(0, 800),
      latest_summary: row.latest_summary.slice(0, 800),
    };
    const n = JSON.stringify(p).length;
    if (items.length && size + n > 30000) break;
    items.push(p);
    size += n;
  }
  const payload = priority_suggestions.payload;
  const pending_suggestions = await db
    .select({
      priority_id: priority_suggestions.priority_id,
      title: sql<string | null>`left(${payload}->>'title', 200)`,
      next_decision: sql<
        string | null
      >`left(${payload}->>'next_decision', 500)`,
      suggested_rank: sql<string | null>`${payload}->>'suggested_rank'`,
    })
    .from(priority_suggestions)
    .where(eq(priority_suggestions.status, 'pending'))
    .orderBy(desc(priority_suggestions.created_at))
    .limit(20);
  return {
    stacks,
    items,
    pending_suggestions,
    offset: start,
    next_offset: rows.length > items.length ? start + items.length : null,
    rules:
      'Manual order, owner, financials and next_decision belong to the user. Match real subjects, not generic vocabulary. Enrich relevant priorities with exact source citations. Propose changes separately; do not invent priorities from routine mail.',
  };
}
export async function priorityDetail(id: string) {
  const [item] = await db
    .select()
    .from(priorities)
    .where(eq(priorities.id, id));
  if (!item) throw Error('Priority not found.');
  return {
    ...item,
    updates: await db
      .select()
      .from(priority_updates)
      .where(eq(priority_updates.priority_id, id))
      .orderBy(
        desc(priority_updates.occurred_at),
        desc(priority_updates.created_at),
      )
      .limit(40),
    suggestions: await db
      .select()
      .from(priority_suggestions)
      .where(
        and(
          eq(priority_suggestions.priority_id, id),
          eq(priority_suggestions.status, 'pending'),
        ),
      )
      .orderBy(desc(priority_suggestions.created_at)),
    commitment: item.commitment_id
      ? (
          await db.select().from(items).where(eq(items.id, item.commitment_id))
        )[0]
      : null,
  };
}
export async function queuePriorityContext(id: string) {
  const [p] = await db.select().from(priorities).where(eq(priorities.id, id));
  if (!p) throw Error('Priority not found.');
  if (p.status !== 'active') return { queued: 0 };
  const words = [
    ...new Set(
      (p.title + ' ' + p.keywords).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ||
        [],
    ),
  ]
    .filter(
      (w) =>
        ![
          'the',
          'and',
          'for',
          'with',
          'priority',
          'update',
          'meeting',
          'review',
        ].includes(w),
    )
    .slice(0, 16);
  const query = words.length ? words.join(' | ') : 'focusunlikelyemptyquery';
  const rows = await db
    .select({ id: sources.id, version_id: source_versions.id })
    .from(sources)
    .innerJoin(
      source_versions,
      and(
        eq(source_versions.source_id, sources.id),
        eq(source_versions.content_hash, sources.content_hash),
      ),
    )
    .where(
      and(
        ne(sources.body, ''),
        notLike(sources.external_id, 'agent-request-%'),
        notLike(sources.external_id, 'contact-profile-%'),
        notLike(sources.external_id, 'linkedin-connection-%'),
        notLike(sources.external_id, 'apple-contact-%'),
        or(
          p.commitment_id
            ? eq(
                sources.id,
                db
                  .select({ source_id: items.source_id })
                  .from(items)
                  .where(eq(items.id, p.commitment_id)),
              )
            : undefined,
          and(
            gte(
              sources.occurred_at,
              new Date(Date.now() - 30 * 86400000).toISOString(),
            ),
            inArray(sources.provider, [
              'granola',
              'fireflies',
              'gmail',
              'beeper',
              'manual',
            ]),
            sql`to_tsvector('simple', ${sources.title} || ' ' || ${sources.body}) @@ to_tsquery('simple', ${query})`,
          ),
        ),
      ),
    )
    .orderBy(desc(sources.occurred_at))
    .limit(12);
  // A source already under review keeps its version and is revisited after
  // that review finishes; otherwise it restarts from the first page.
  const idle = sql`${review_queue.job_id} IS NULL`;
  for (const s of rows)
    await db
      .insert(review_queue)
      .values({ source_id: s.id, source_version_id: s.version_id })
      .onConflictDoUpdate({
        target: review_queue.source_id,
        set: {
          source_version_id: sql`CASE WHEN ${idle} THEN excluded.source_version_id ELSE ${review_queue.source_version_id} END`,
          revisit: sql`${review_queue.job_id} IS NOT NULL`,
          updated_at: sql`now()`,
          completed: false,
          next_offset: sql`CASE WHEN ${idle} THEN 0 ELSE ${review_queue.next_offset} END`,
          attempts: sql`CASE WHEN ${idle} THEN 0 ELSE ${review_queue.attempts} END`,
          retry_after: null,
        },
      });
  return { queued: rows.length };
}
export async function savePriority(value: unknown) {
  const input = priorityInput.parse(value);
  return transaction(async () => {
    await lockWorkspace();
    const old: Priority | undefined = input.id
      ? (
          await db
            .select()
            .from(priorities)
            .where(eq(priorities.id, input.id))
            .for('update')
        )[0]
      : undefined;
    if (input.id && !old) throw Error('Priority not found.');
    if (old && old.version !== input.version)
      throw Error('This priority changed. Reopen it before saving.');
    const p = {
      id: uid(),
      stack_id: 'deal-flow',
      title: '',
      owner: 'You',
      financials: '',
      notes: '',
      keywords: '',
      next_decision: '',
      commitment_id: null,
      status: 'active',
      ...old,
      ...input,
    };
    if (!p.title) throw Error('Give this priority a title.');
    if (
      p.commitment_id &&
      !(
        await db
          .select({ id: items.id })
          .from(items)
          .where(eq(items.id, p.commitment_id))
      ).length
    )
      throw Error('Commitment not found.');
    const position =
      old &&
      old.stack_id === p.stack_id &&
      !(old.status === 'done' && p.status === 'active')
        ? old.position
        : (
            await db
              .select({
                n: sql<number>`COALESCE(max(${priorities.position}), -1) + 1`,
              })
              .from(priorities)
              .where(eq(priorities.stack_id, p.stack_id))
          )[0]!.n;
    const fields = {
      stack_id: p.stack_id,
      title: p.title,
      owner: p.owner,
      financials: p.financials,
      notes: p.notes,
      keywords: p.keywords,
      next_decision: p.next_decision,
      commitment_id: p.commitment_id,
      status: p.status,
      position,
    };
    if (old)
      await db
        .update(priorities)
        .set({
          ...fields,
          version: sql`${priorities.version} + 1`,
          updated_at: sql`now()`,
        })
        .where(eq(priorities.id, p.id));
    else await db.insert(priorities).values({ id: p.id, ...fields });
    if (!old || old.stack_id !== p.stack_id || old.status !== p.status)
      await bumpOrderVersion();
    if (
      !old ||
      old.title !== p.title ||
      old.keywords !== p.keywords ||
      old.commitment_id !== p.commitment_id ||
      old.status !== p.status
    )
      await queuePriorityContext(p.id);
    return priorityDetail(p.id);
  });
}
export async function reorderPriorities(value: unknown) {
  const input = z
    .object({
      version: z.number().int().positive(),
      stack_id: stackId.optional(),
      ids: z.array(z.string()).max(1000),
    })
    .parse(value);
  return transaction(async () => {
    await lockWorkspace();
    if ((await orderVersion({ lock: true })) !== input.version)
      throw Error('The order changed. Refresh and try again.');
    const current = input.stack_id
      ? await db
          .select({ id: priorities.id })
          .from(priorities)
          .where(
            and(
              eq(priorities.stack_id, input.stack_id),
              eq(priorities.status, 'active'),
            ),
          )
      : await db.select({ id: priority_stacks.id }).from(priority_stacks);
    if (
      new Set(input.ids).size !== current.length ||
      input.ids.length !== current.length ||
      current.some((p) => !input.ids.includes(p.id))
    )
      throw Error('Include every current item exactly once.');
    for (const [position, id] of input.ids.entries())
      if (input.stack_id)
        await db
          .update(priorities)
          .set({
            position,
            version: sql`${priorities.version} + 1`,
            updated_at: sql`now()`,
          })
          .where(eq(priorities.id, id));
      else
        await db
          .update(priority_stacks)
          .set({ position })
          .where(eq(priority_stacks.id, id));
    await bumpOrderVersion();
    return prioritiesState();
  });
}
export async function addPriorityUpdate({
  id,
  body,
}: {
  id: string;
  body: unknown;
}) {
  const text = z.string().trim().min(1).max(4000).parse(body);
  return transaction(async () => {
    await lockWorkspace();
    await priorityDetail(id);
    const updateId = uid(),
      time = stamp();
    const source = await upsertSource(
      {
        provider: 'manual',
        external_id: 'priority-update-' + updateId,
        title:
          'Priority update: ' +
          (await one('SELECT title FROM priorities WHERE id=?', id)).title,
        body: text,
        occurred_at: time,
        coverage: 'note',
      },
      { priority_id: id, origin: 'User update', body: text },
    );
    const version = await one(
      'SELECT id FROM source_versions WHERE source_id=? ORDER BY fetched_at DESC LIMIT 1',
      source.id,
    );
    const citations = [
      {
        source_id: source.id,
        source_version_id: version.id,
        quote: text.slice(0, 1000),
      },
    ];
    await run(
      "INSERT INTO priority_updates(id,priority_id,body,origin,citations,fingerprint,occurred_at) VALUES(?,?,?,'user',?::jsonb,?,?)",
      updateId,
      id,
      text,
      JSON.stringify(citations),
      updateId,
      time,
    );
    await run(
      'UPDATE priorities SET latest_summary=?,last_context_at=?,updated_at=now() WHERE id=?',
      text,
      time,
      id,
    );
    return priorityDetail(id);
  });
}
export async function savePriorityEnrichment(
  jobId: string | null,
  updates: PriorityUpdate[] = [],
  suggestions: PrioritySuggestion[] = [],
) {
  for (const update of updates) {
    const p = await one(
      "SELECT * FROM priorities WHERE id=? AND status='active'",
      update.priority_id,
    );
    if (!p) continue;
    const dated = await all(
      'SELECT occurred_at FROM sources WHERE id=ANY(?::text[])',
      update.citations.map((c) => c.source_id),
    );
    const time =
      dated
        .map((d) => d.occurred_at)
        .filter((d) => Number.isFinite(Date.parse(d)))
        .map((d) => new Date(d).toISOString())
        .sort()
        .at(-1) || '';
    const fingerprint = hash({
      priority: p.id,
      versions: [
        ...new Set(update.citations.map((c) => c.source_version_id)),
      ].sort(),
      quotes: update.citations.map((c) => c.quote).sort(),
    });
    const inserted = await run(
      "INSERT INTO priority_updates(id,priority_id,body,origin,citations,fingerprint,job_id,occurred_at) VALUES(?,?,?,'context',?::jsonb,?,?,?) ON CONFLICT(fingerprint) DO NOTHING",
      uid(),
      p.id,
      update.summary,
      JSON.stringify(update.citations),
      fingerprint,
      jobId,
      time,
    );
    if (inserted.changes)
      await run('UPDATE priorities SET updated_at=now() WHERE id=?', p.id);
    if (
      inserted.changes &&
      (!p.latest_summary ||
        (time &&
          (!p.last_context_at ||
            Date.parse(time) >= Date.parse(p.last_context_at))))
    )
      await run(
        'UPDATE priorities SET latest_summary=?,last_context_at=?,updated_at=now() WHERE id=?',
        update.summary,
        time,
        p.id,
      );
    if (
      (update.next_decision && update.next_decision !== p.next_decision) ||
      update.suggested_rank !== null
    ) {
      const payload = { ...update, base_version: p.version };
      await run(
        'INSERT INTO priority_suggestions(id,priority_id,job_id,payload,fingerprint) VALUES(?,?,?,?::jsonb,?) ON CONFLICT(fingerprint) DO NOTHING',
        uid(),
        p.id,
        jobId,
        JSON.stringify(payload),
        hash({
          priority: p.id,
          decision: update.next_decision,
          rank: update.suggested_rank,
          version: p.version,
        }),
      );
      await run('UPDATE priorities SET updated_at=now() WHERE id=?', p.id);
    }
  }
  for (const suggestion of suggestions) {
    if (
      (
        await one(
          "SELECT count(*) n FROM priority_suggestions WHERE priority_id IS NULL AND status='pending'",
        )
      ).n >= 6
    )
      break;
    if (
      await one(
        "SELECT id FROM priorities WHERE lower(title)=lower(?) AND status='active'",
        suggestion.title,
      )
    )
      continue;
    await run(
      'INSERT INTO priority_suggestions(id,job_id,payload,fingerprint) VALUES(?,?,?::jsonb,?) ON CONFLICT(fingerprint) DO NOTHING',
      uid(),
      jobId,
      JSON.stringify(suggestion),
      hash({
        stack: suggestion.stack_id,
        title: suggestion.title.toLowerCase(),
      }),
    );
  }
}
export async function decidePrioritySuggestion({
  id,
  action,
  version,
}: {
  id: string;
  action: string;
  version?: number;
}) {
  return transaction(async () => {
    await lockWorkspace();
    const s = await one(
      "SELECT * FROM priority_suggestions WHERE id=? AND status='pending' FOR UPDATE",
      id,
    );
    if (!s) throw Error('This suggestion was already resolved.');
    if (action === 'dismiss') {
      await run(
        "UPDATE priority_suggestions SET status='dismissed' WHERE id=?",
        id,
      );
      if (s.priority_id)
        await run(
          'UPDATE priorities SET updated_at=now() WHERE id=?',
          s.priority_id,
        );
      return { saved: true };
    }
    if (action !== 'apply') throw Error('Choose apply or dismiss.');
    let p: any;
    if (s.priority_id) {
      p = await one('SELECT * FROM priorities WHERE id=?', s.priority_id);
      if (
        p.status !== 'active' ||
        p.version !== version ||
        p.version !== s.payload.base_version
      )
        throw Error(
          'This priority changed since the suggestion. Dismiss it or review its context again.',
        );
      if (s.payload.next_decision)
        p = await savePriority({
          id: p.id,
          version: p.version,
          next_decision: s.payload.next_decision,
        });
      if (s.payload.suggested_rank !== null) {
        const rows = await all(
          "SELECT id FROM priorities WHERE stack_id=? AND status='active' ORDER BY position,id",
          p.stack_id,
        );
        const ids = rows.map((r) => r.id).filter((id) => id !== p.id);
        ids.splice(
          Math.min(ids.length, Math.max(0, s.payload.suggested_rank - 1)),
          0,
          p.id,
        );
        await reorderPriorities({
          version: (await one('SELECT version FROM priority_order WHERE id=1'))
            .version,
          stack_id: p.stack_id,
          ids,
        });
      }
    } else {
      if (
        await one(
          "SELECT id FROM priorities WHERE lower(title)=lower(?) AND status='active'",
          s.payload.title,
        )
      )
        throw Error('This priority already exists. Dismiss the suggestion.');
      p = await savePriority({
        stack_id: s.payload.stack_id,
        title: s.payload.title,
        next_decision: s.payload.next_decision,
        notes: s.payload.summary,
      });
      await savePriorityEnrichment(s.job_id, [
        {
          priority_id: p.id,
          summary: s.payload.summary,
          next_decision: '',
          suggested_rank: null,
          citations: s.payload.citations,
        },
      ]);
    }
    await run(
      "UPDATE priority_suggestions SET status='applied' WHERE id=?",
      id,
    );
    return priorityDetail(p.id);
  });
}

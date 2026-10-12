import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  databaseErrorCode,
  db,
  lockWorkspace,
  transaction as dbTransaction,
} from './postgres.ts';
import { one, run, stamp, uid, setSetting, upsertSource } from './db.mjs';
import {
  contact_queue,
  contact_runs,
  durable_runs,
  import_records,
  import_uploads,
  sync_runs,
} from './schema/index.ts';
import { projectSource } from './contact-extraction.mjs';
import { startContactProjection } from './contact-jobs.mjs';
import { queueImportReview } from './agent.mjs';

// What durable_runs.outcome stores: the result of the latest step.
type Outcome = {
  revision?: number;
  done?: boolean;
  waitMs?: number;
  failed?: boolean;
  permanent?: boolean;
};
// One bounded unit of work from a provider, a staged upload or the contact queue.
type Step = {
  cursor?: unknown;
  records?: { doc: object; raw?: unknown }[];
  settings?: Record<string, unknown>;
  contact?: { source_id: string; content_hash: string };
  processed?: number;
  message?: string;
  complete?: boolean;
};
type Adapters = {
  contacts?: (cursor: unknown) => Promise<Step>;
  manual?: (id: string, cursor: unknown) => Promise<Step>;
  initial?: (provider: string) => Promise<unknown>;
  advance?: (provider: string, cursor: unknown) => Promise<Step>;
  project?: (sourceId: string, guard: () => Promise<void>) => Promise<unknown>;
};
type DurableRun = typeof durable_runs.$inferSelect;
// A durable run's parent row. Only sync runs have a provider and a changed
// count, and only contact runs a review request.
type Parent =
  | (typeof sync_runs.$inferSelect & { review_requested?: undefined })
  | (typeof contact_runs.$inferSelect & {
      provider?: undefined;
      changed?: undefined;
    });
// Properties a failed step or projection may carry.
type StepError = Error & {
  lostUnit?: boolean;
  permanent?: boolean;
  retryAfterMs?: unknown;
  ingestionProviderError?: boolean;
  manualImport?: boolean;
};

const tables: Record<string, string> = {
  sync: 'sync_runs',
  contacts: 'contact_runs',
};
// The run table each durable kind tracks, in dispatch order.
const parents = { sync: sync_runs, contacts: contact_runs };
const transaction = <T>(fn: () => Promise<T>) =>
  dbTransaction(async () => {
    await db.execute(sql`SET LOCAL statement_timeout='75s'`);
    await db.execute(sql`SET LOCAL lock_timeout='10s'`);
    return fn();
  });
// The durable_runs row for one run.
const durableRun = (kind: string, id: string) =>
  and(eq(durable_runs.kind, kind), eq(durable_runs.run_id, id));
// Rows are read FOR UPDATE; callers hold the workspace lock.
const lockDurableRun = async (
  kind: string,
  id: string,
): Promise<DurableRun | undefined> =>
  (
    await db
      .select()
      .from(durable_runs)
      .where(durableRun(kind, id))
      .for('update')
  )[0];
function parentTable(kind: string) {
  const table = (
    parents as Record<
      string,
      (typeof parents)[keyof typeof parents] | undefined
    >
  )[kind];
  if (!table) throw Error('Unknown ingestion queue.');
  return table;
}
const lockParent = async (
  table: ReturnType<typeof parentTable>,
  id: string,
): Promise<Parent | undefined> =>
  (await db.select().from(table).where(eq(table.id, id)).for('update'))[0];
function tableFor(kind: string) {
  if (!tables[kind]) throw Error('Unknown ingestion queue.');
  return tables[kind];
}
const summary = (row: {
  revision: number;
  completed: boolean;
  outcome: unknown;
}) => ({
  revision: row.revision,
  done: row.completed,
  ...(row.outcome as Outcome),
});
export async function prepareDispatches() {
  return transaction(async () => {
    await lockWorkspace();
    await db
      .update(sync_runs)
      .set({
        state: 'failed',
        message: 'Upload expired; choose the file again',
        finished_at: stamp(),
        updated_at: stamp(),
      })
      .where(
        and(
          eq(sync_runs.provider, 'manual'),
          eq(sync_runs.state, 'uploading'),
          sql`${sync_runs.updated_at}::timestamptz < now() - interval '24 hours'`,
        ),
      );
    await db
      .delete(import_uploads)
      .where(
        and(
          inArray(
            import_uploads.run_id,
            db
              .select({ id: sync_runs.id })
              .from(sync_runs)
              .where(eq(sync_runs.state, 'failed')),
          ),
          lt(import_uploads.created_at, sql`now() - interval '24 hours'`),
        ),
      );
    for (const [kind, table] of Object.entries(parents))
      await db
        .insert(durable_runs)
        .select((qb) =>
          qb
            .select({ kind: sql<string>`${kind}`.as('kind'), run_id: table.id })
            .from(table)
            .where(and(eq(table.state, 'queued'), eq(table.lease_owner, ''))),
        )
        .onConflictDoNothing();
    const pending = await db
      .select()
      .from(durable_runs)
      .where(
        and(
          eq(durable_runs.completed, false),
          eq(durable_runs.workflow_id, ''),
          or(
            isNull(durable_runs.dispatch_until),
            lt(durable_runs.dispatch_until, sql`now()`),
          ),
        ),
      )
      .orderBy(durable_runs.updated_at)
      .limit(4)
      .for('update');
    for (const row of pending) {
      row.dispatch_token ||= uid();
      await db
        .update(durable_runs)
        .set({
          dispatch_token: row.dispatch_token,
          dispatch_until: sql`now() + interval '2 minutes'`,
        })
        .where(durableRun(row.kind, row.run_id));
    }
    return pending.map((r) => ({
      kind: r.kind,
      id: r.run_id,
      token: r.dispatch_token,
    }));
  });
}
export async function acknowledgeDispatch(
  kind: string,
  id: string,
  token: string,
  workflowId: string,
) {
  await db
    .update(durable_runs)
    .set({ workflow_id: workflowId, updated_at: sql`now()` })
    .where(
      and(
        durableRun(kind, id),
        eq(durable_runs.dispatch_token, token),
        eq(durable_runs.workflow_id, ''),
      ),
    );
}
export async function releaseDispatch(kind: string, id: string, token: string) {
  await db
    .update(durable_runs)
    .set({ dispatch_until: sql`now()` })
    .where(
      and(
        durableRun(kind, id),
        eq(durable_runs.dispatch_token, token),
        eq(durable_runs.workflow_id, ''),
      ),
    );
}
export async function resumeDurable(
  kind: string,
  id: string,
  provider?: string,
) {
  return transaction(async () => {
    await lockWorkspace();
    const table = parentTable(kind),
      parent = await lockParent(table, id),
      row = await lockDurableRun(kind, id);
    if (!row) return null;
    if (
      !parent ||
      parent.state !== 'failed' ||
      (provider && parent.provider !== provider)
    )
      throw Error('Only a failed import can be resumed.');
    const active = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          inArray(table.state, ['queued', 'running', 'uploading']),
          kind === 'sync'
            ? eq(sync_runs.provider, parent.provider!)
            : undefined,
        ),
      );
    if (active.length)
      throw Error('An import for this connection is already running.');
    if (kind === 'contacts')
      await db
        .update(contact_queue)
        .set({ state: 'pending', attempts: 0, error: '' })
        .where(eq(contact_queue.state, 'failed'));
    await db
      .update(durable_runs)
      .set({
        workflow_id: '',
        dispatch_token: '',
        dispatch_until: null,
        unit_token: '',
        unit_until: null,
        attempts: 0,
        completed: false,
        outcome: { done: false, revision: row.revision },
        updated_at: sql`now()`,
      })
      .where(durableRun(kind, id));
    await db
      .update(table)
      .set({
        state: 'queued',
        finished_at: null,
        lease_owner: '',
        lease_until: null,
        updated_at: stamp(),
        message: 'Resuming from saved progress',
      })
      .where(eq(table.id, id));
    return { id };
  });
}
async function claimUnit(
  kind: string,
  id: string,
  token: string,
  workflowId: string,
  revision: number,
): Promise<
  | { result: Outcome }
  | { result?: undefined; row: DurableRun; parent: Parent; unit: string }
> {
  const table = parentTable(kind);
  return transaction(async () => {
    await lockWorkspace();
    const row = await lockDurableRun(kind, id);
    if (
      !row ||
      row.dispatch_token !== token ||
      (row.workflow_id && row.workflow_id !== workflowId)
    )
      return { result: { done: true, revision } };
    const parent = await lockParent(table, id);
    if (row.completed) return { result: summary(row) };
    if (!parent || !['queued', 'running'].includes(parent.state)) {
      const outcome = {
        revision: row.revision,
        done: true,
        ...(!parent || parent.state === 'failed' ? { failed: true } : {}),
      };
      // A legacy invocation may finish after dispatch but before our first step.
      // Close only its durable companion; preserve the legacy result and counters.
      await db
        .update(durable_runs)
        .set({
          workflow_id: workflowId,
          completed: true,
          outcome,
          unit_token: '',
          unit_until: null,
          updated_at: sql`now()`,
        })
        .where(durableRun(kind, id));
      return { result: outcome };
    }
    if (row.revision !== revision) return { result: summary(row) };
    const reservedOwner = 'workflow:' + workflowId;
    if (
      parent.lease_owner &&
      parent.lease_owner !== reservedOwner &&
      parent.lease_until &&
      Date.parse(parent.lease_until) > Date.now()
    )
      return {
        result: {
          done: false,
          revision,
          waitMs: Math.max(
            1000,
            Date.parse(parent.lease_until) - Date.now() + 1000,
          ),
        },
      };
    if (row.unit_until && Date.parse(row.unit_until) > Date.now())
      return {
        result: {
          done: false,
          revision,
          waitMs: Math.max(
            1000,
            Date.parse(row.unit_until) - Date.now() + 1000,
          ),
        },
      };
    const unit = uid();
    await db
      .update(durable_runs)
      .set({
        workflow_id: workflowId,
        unit_token: unit,
        unit_until: sql`now() + interval '120 seconds'`,
        updated_at: sql`now()`,
      })
      .where(durableRun(kind, id));
    // Old deployed claimLease code requires an empty owner. Keep this reservation
    // between steps and sleeps; the independent unit token fences durable writes.
    await db
      .update(table)
      .set({
        state: 'running',
        lease_owner: reservedOwner,
        lease_until: null,
        pid: null,
        updated_at: stamp(),
        message: 'Import continues automatically in the background',
      })
      .where(eq(table.id, id));
    return { row, parent, unit };
  });
}
async function requireUnit(kind: string, id: string, unit: string) {
  const owned = await db
    .select({ run_id: durable_runs.run_id })
    .from(durable_runs)
    .where(
      and(
        durableRun(kind, id),
        eq(durable_runs.unit_token, unit),
        gt(durable_runs.unit_until, sql`now()`),
        eq(durable_runs.completed, false),
      ),
    )
    .for('update');
  if (!owned.length)
    throw Object.assign(Error('Ingestion ownership changed.'), {
      lostUnit: true,
    });
}
async function advanceContacts(cursor: unknown): Promise<Step> {
  const [q] = await db
    .select()
    .from(contact_queue)
    .where(eq(contact_queue.state, 'pending'))
    .orderBy(contact_queue.updated_at, contact_queue.source_id)
    .limit(1);
  if (!q) return { cursor: cursor || {}, records: [], complete: true };
  return {
    cursor: {
      processed: ((cursor as { processed?: number })?.processed || 0) + 1,
    },
    contact: q,
    records: [],
    processed: 1,
    complete: false,
  };
}
export async function advanceDurableUnit(
  kind: string,
  id: string,
  token: string,
  workflowId: string,
  revision: number,
  adapters: Adapters = {},
): Promise<Outcome> {
  const claimed = await claimUnit(kind, id, token, workflowId, revision);
  if (claimed.result) return claimed.result;
  const { row, parent, unit } = claimed;
  try {
    let result: Step;
    if (kind === 'contacts')
      result = await (adapters.contacts || advanceContacts)(row.cursor);
    else if (parent.provider === 'manual') {
      const { advanceManual } = await import('./manual-ingestion.ts');
      // Staged records come back from jsonb untyped; they hold { doc, raw }.
      result = (await (adapters.manual || advanceManual)(
        id,
        row.cursor as Parameters<typeof advanceManual>[1],
      )) as Step;
    } else if (parent.provider === 'beeper') {
      const { advanceBeeper } = await import('./beeper.ts');
      result = (await advanceBeeper(
        id,
        row.cursor as Parameters<typeof advanceBeeper>[1],
      )) as Step;
    } else {
      const providers = await import('./ingestion-providers.ts');
      const cursor =
        (row.cursor as Parameters<typeof providers.advanceProvider>[1]) ??
        (await (adapters.initial || providers.initialProviderCursor)(
          parent.provider!,
        ));
      result = (await (adapters.advance || providers.advanceProvider)(
        parent.provider!,
        cursor,
      )) as Step;
    }
    return await transaction(async () => {
      await lockWorkspace();
      await requireUnit(kind, id, unit);
      const table = parentTable(kind),
        latest = await lockParent(table, id);
      if (
        kind === 'contacts' &&
        result.complete &&
        (
          await db
            .select({ source_id: contact_queue.source_id })
            .from(contact_queue)
            .where(eq(contact_queue.state, 'pending'))
            .limit(1)
        ).length
      )
        result.complete = false;
      if (result.contact) {
        const q = result.contact;
        await db.execute(sql`SAVEPOINT contact_projection`);
        try {
          await (adapters.project || projectSource)(q.source_id, () =>
            requireUnit(kind, id, unit),
          );
          await db.execute(sql`RELEASE SAVEPOINT contact_projection`);
        } catch (e) {
          await db.execute(sql`ROLLBACK TO SAVEPOINT contact_projection`);
          if ((e as StepError).lostUnit || databaseErrorCode(e)) throw e;
          await db
            .update(contact_queue)
            .set({
              state: 'failed',
              attempts: sql`${contact_queue.attempts} + 1`,
              error: 'Extraction failed; inspect the source and retry',
              updated_at: sql`now()`,
            })
            .where(
              and(
                eq(contact_queue.source_id, q.source_id),
                eq(contact_queue.content_hash, q.content_hash),
              ),
            );
          await db.execute(sql`RELEASE SAVEPOINT contact_projection`);
        }
      }
      let changed = 0;
      for (const { doc, raw } of result.records || [])
        if ((await upsertSource(doc, raw)).changed) changed++;
      for (const [key, value] of Object.entries(result.settings || {}))
        await setSetting(key, value);
      await requireUnit(kind, id, unit);
      const next = revision + 1,
        outcome = { revision: next, done: Boolean(result.complete) };
      await db
        .update(durable_runs)
        .set({
          // A step without a cursor saves JSON null, not SQL NULL.
          cursor: sql`${JSON.stringify(result.cursor ?? null)}::jsonb`,
          revision: next,
          attempts: 0,
          completed: outcome.done,
          outcome,
          unit_token: '',
          unit_until: null,
          updated_at: sql`now()`,
        })
        .where(durableRun(kind, id));
      const state = outcome.done ? 'complete' : 'running',
        processed = result.processed ?? result.records?.length ?? 0;
      await db
        .update(table)
        .set({
          state,
          imported: sql`${table.imported} + ${processed}`,
          updated_at: stamp(),
          message: outcome.done
            ? 'Import finished'
            : result.message || 'Saved progress; continuing automatically',
          finished_at: outcome.done ? stamp() : null,
          ...(kind === 'sync'
            ? { changed: sql`${sync_runs.changed} + ${changed}` }
            : {}),
        })
        .where(eq(table.id, id));
      if (outcome.done) {
        if (kind === 'sync') {
          if ((parent.changed || 0) + changed) {
            const contact = await startContactProjection({ drain: true });
            await db
              .update(contact_runs)
              .set({ review_requested: true })
              .where(eq(contact_runs.id, contact.id));
          }
          if (parent.provider === 'gmail') {
            const { clearGmailIssue } = await import('./connectors.ts');
            await clearGmailIssue();
          }
          await db.delete(import_records).where(eq(import_records.run_id, id));
          await db.delete(import_uploads).where(eq(import_uploads.run_id, id));
        } else {
          const failures = await db.$count(
            contact_queue,
            eq(contact_queue.state, 'failed'),
          );
          if (failures)
            await db
              .update(contact_runs)
              .set({
                state: 'partial',
                message: failures + ' sources need a retry',
              })
              .where(eq(contact_runs.id, id));
          if (latest!.review_requested) await queueImportReview();
        }
      }
      return outcome;
    });
  } catch (e) {
    const error = e as StepError;
    if (error.lostUnit) return { revision, done: false, waitMs: 2000 };
    return transaction(async () => {
      await lockWorkspace();
      const current = await lockDurableRun(kind, id);
      if (!current || current.unit_token !== unit || current.completed)
        return current ? summary(current) : { done: true, revision };
      const attempts = current.attempts + 1,
        failed = Boolean(error.permanent) || attempts >= 12,
        next = current.revision + 1;
      const waitMs = Math.max(
        1000,
        Math.min(
          86400000,
          Number(error.retryAfterMs) ||
            Math.min(900000, 2000 * 2 ** Math.min(attempts, 9)),
        ),
      );
      const message = failed
        ? error.permanent &&
          (error.ingestionProviderError || error.manualImport)
          ? error.message
          : 'Import paused after repeated failures. Retry to resume saved progress.'
        : 'Provider temporarily unavailable; retrying automatically';
      const outcome = {
        revision: next,
        done: failed,
        ...(!failed
          ? { waitMs }
          : { failed: true, permanent: Boolean(error.permanent) }),
      };
      await db
        .update(durable_runs)
        .set({
          attempts,
          revision: next,
          completed: failed,
          outcome,
          unit_token: '',
          unit_until: null,
          updated_at: sql`now()`,
        })
        .where(durableRun(kind, id));
      const table = parentTable(kind);
      await db
        .update(table)
        .set({
          state: failed ? 'failed' : 'running',
          message,
          updated_at: stamp(),
          finished_at: failed ? stamp() : null,
        })
        .where(eq(table.id, id));
      return outcome;
    });
  }
}
export async function failDurableRun(
  kind: string,
  id: string,
  workflowId: string,
) {
  return transaction(async () => {
    await lockWorkspace();
    const row = await one(
      'SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',
      kind,
      id,
    );
    if (!row || row.completed || row.workflow_id !== workflowId) return;
    await run(
      'UPDATE durable_runs SET completed=true,outcome=?::jsonb,updated_at=now() WHERE kind=? AND run_id=?',
      JSON.stringify({ done: true, failed: true }),
      kind,
      id,
    );
    await run(
      'UPDATE ' +
        tableFor(kind) +
        " SET state='failed',message='Workflow interrupted after retries; refresh to resume saved progress',updated_at=?,finished_at=? WHERE id=?",
      stamp(),
      stamp(),
      id,
    );
  });
}

// Replace an abandoned owner, never its saved cursor. Late callbacks from the
// previous workflow cannot claim or commit a unit after its tokens are cleared.
export async function recoverStalledRun(
  kind: string,
  id: string,
  workflowId: string,
  revision: number,
  { terminal = false }: { terminal?: boolean } = {},
) {
  return transaction(async () => {
    await lockWorkspace();
    const row = await one(
      'SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',
      kind,
      id,
    );
    if (
      !row ||
      row.completed ||
      row.workflow_id !== workflowId ||
      row.revision !== revision
    )
      return false;
    const now = Date.now(),
      wait = Math.max(15 * 60000, Number(row.outcome?.waitMs || 0) + 5 * 60000);
    if (
      (row.unit_until && Date.parse(row.unit_until) > now) ||
      (!terminal && now - Date.parse(row.updated_at) < wait)
    )
      return false;
    const table = tableFor(kind),
      parent = await one(
        'SELECT state FROM ' + table + ' WHERE id=? FOR UPDATE',
        id,
      );
    if (!parent || !['queued', 'running'].includes(parent.state)) return false;
    await run(
      "UPDATE durable_runs SET workflow_id='',dispatch_token='',dispatch_until=NULL,unit_token='',unit_until=NULL,outcome=?::jsonb,updated_at=now() WHERE kind=? AND run_id=?",
      JSON.stringify({ done: false, revision: row.revision }),
      kind,
      id,
    );
    await run(
      'UPDATE ' +
        table +
        " SET state='queued',lease_owner='',lease_until=NULL,updated_at=?,message='Recovering interrupted import from saved progress' WHERE id=?",
      stamp(),
      id,
    );
    return true;
  });
}

// A large archive spans multiple workflow runs while retaining the same cursor.
export async function yieldDurableRun(
  kind: string,
  id: string,
  token: string,
  workflowId: string,
) {
  return transaction(async () => {
    await lockWorkspace();
    const row = await one(
      'SELECT * FROM durable_runs WHERE kind=? AND run_id=? FOR UPDATE',
      kind,
      id,
    );
    if (
      !row ||
      row.completed ||
      row.dispatch_token !== token ||
      row.workflow_id !== workflowId ||
      (row.unit_until && Date.parse(row.unit_until) > Date.now())
    )
      return false;
    await run(
      "UPDATE durable_runs SET workflow_id='',dispatch_token='',dispatch_until=NULL,updated_at=now() WHERE kind=? AND run_id=?",
      kind,
      id,
    );
    await run(
      'UPDATE ' +
        tableFor(kind) +
        " SET state='queued',lease_owner='',lease_until=NULL,updated_at=?,message='Saved progress; continuing in the next background run' WHERE id=?",
      stamp(),
      id,
    );
    return true;
  });
}

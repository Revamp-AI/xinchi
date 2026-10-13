import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { db, transaction } from './postgres.ts';
import { stamp, uid } from './db.mjs';
import { REMOTE_WORKERS } from './runtime.mjs';
import { contact_runs, durable_runs, jobs, sync_runs } from './schema/index.ts';

// Each worker queue: its table, its state column and that column's key in
// updates, and the durable_runs kind whose Workflow owns a run instead of a
// lease. Jobs have no durable kind and record failures in error, not message.
const queues = {
  jobs: { table: jobs, state: jobs.status, key: 'status', kind: null },
  sync_runs: {
    table: sync_runs,
    state: sync_runs.state,
    key: 'state',
    kind: 'sync',
  },
  contact_runs: {
    table: contact_runs,
    state: contact_runs.state,
    key: 'state',
    kind: 'contacts',
  },
} as const;
type QueueName = keyof typeof queues;
type Queue = (typeof queues)[QueueName];
type QueueRow<Q extends QueueName> =
  (typeof queues)[Q]['table']['$inferSelect'];
function queueFor(table: string) {
  const queue = (queues as Record<string, Queue | undefined>)[table];
  if (!queue) throw Error('Unknown worker queue.');
  return queue;
}
const leaseUntil = sql`now() + interval '45 seconds'`;

// Typed by queue so callers get that table's row; JavaScript callers may
// still pass any name, which queueFor rejects at run time.
export async function claimLease<Q extends QueueName>(
  table: Q,
  id: string,
): Promise<{ row: QueueRow<Q>; token: string } | null> {
  const { table: t, state, key } = queueFor(table),
    token = uid();
  const [row] = await db
    .update(t)
    .set({
      [key]: 'running',
      lease_owner: token,
      lease_until: leaseUntil,
      pid: process.pid,
      updated_at: stamp(),
    })
    .where(
      and(
        eq(t.id, id),
        inArray(state, ['queued', 'running']),
        eq(t.lease_owner, ''),
      ),
    )
    .returning();
  return row ? { row: row as QueueRow<Q>, token } : null;
}
export async function heartbeatLease(table: string, id: string, token: string) {
  const { table: t, state } = queueFor(table);
  const rows = await db
    .update(t)
    .set({ lease_until: leaseUntil, updated_at: stamp() })
    .where(
      and(
        eq(t.id, id),
        eq(t.lease_owner, token),
        eq(state, 'running'),
        gt(t.lease_until, sql`now()`),
      ),
    )
    .returning({ id: t.id });
  return !!rows.length;
}
export async function requireLease(table: string, id: string, token: string) {
  const { table: t, state } = queueFor(table);
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.id, id),
        eq(t.lease_owner, token),
        eq(state, 'running'),
        gt(t.lease_until, sql`now()`),
      ),
    )
    .for('share');
  if (!rows.length) throw Error('This worker no longer owns the run.');
}
export async function expireLeases(table: string) {
  const { table: t, state, key, kind } = queueFor(table);
  const result = await db
    .update(t)
    .set({
      [key]: 'failed',
      ...(kind
        ? {
            finished_at: sql`to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
            message: 'Interrupted; retry the import',
          }
        : { error: 'The previous run was interrupted. Start a new review.' }),
      updated_at: stamp(),
    })
    .where(
      and(
        inArray(state, ['queued', 'running']),
        kind
          ? notExists(
              db
                .select({ one: sql`1` })
                .from(durable_runs)
                .where(
                  and(
                    eq(durable_runs.kind, kind),
                    eq(durable_runs.run_id, t.id),
                  ),
                ),
            )
          : undefined,
        or(
          and(isNotNull(t.lease_until), lt(t.lease_until, sql`now()`)),
          and(
            isNull(t.lease_until),
            REMOTE_WORKERS ? eq(state, 'running') : undefined,
            sql`${t.updated_at}::timestamptz < now() - interval '2 minutes'`,
          ),
        ),
      ),
    );
  return { changes: result.rowCount, rows: result.rows };
}
export async function cancelLease(
  table: string,
  id: string,
  message = 'Cancelled',
) {
  const { table: t, state, key, kind } = queueFor(table);
  return transaction(async () => {
    const [row] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), inArray(state, ['queued', 'running'])))
      .for('update');
    if (!row) throw Error('This run is not running.');
    await db
      .update(t)
      .set({
        [key]: 'failed',
        [kind ? 'message' : 'error']: message,
        updated_at: stamp(),
      })
      .where(eq(t.id, id));
    return { cancelled: true };
  });
}

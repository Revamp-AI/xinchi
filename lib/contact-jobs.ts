import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import {
  transaction,
  lockWorkspace,
  uid,
  stamp,
  root,
  setSetting,
  getSetting,
} from './db.ts';
import { db } from './postgres.ts';
import { contact_queue, contact_runs, sources } from './schema/index.ts';
import { expireLeases } from './leases.ts';
import { REMOTE_WORKERS } from './runtime.mjs';
export async function startContactProjection({
  full = false,
  retry = false,
  drain = false,
  aliases,
}: {
  // Request bodies arrive unchecked; each flag is read for truthiness.
  full?: unknown;
  retry?: unknown;
  drain?: unknown;
  aliases?: unknown;
} = {}) {
  if (aliases !== undefined) {
    if (
      !Array.isArray(aliases) ||
      aliases.some((a) => typeof a !== 'string' || !a.includes('@'))
    )
      throw Error('Provide valid owner aliases.');
    await setSetting(
      'contact_owner_aliases',
      aliases.map((a) => a.trim().toLowerCase()),
    );
  }
  const id = await transaction(async () => {
    await lockWorkspace();
    await expireLeases('contact_runs');
    const [active] = await db
      .select({ id: contact_runs.id })
      .from(contact_runs)
      .where(inArray(contact_runs.state, ['queued', 'running']));
    if (active) return active.id;
    if (retry)
      await db
        .update(contact_queue)
        .set({ state: 'pending', attempts: 0, error: '' })
        .where(eq(contact_queue.state, 'failed'));
    else if (!drain) {
      await db
        .insert(contact_queue)
        .select(
          db
            .select({
              source_id: sources.id,
              content_hash: sources.content_hash,
            })
            .from(sources)
            .where(
              full
                ? undefined
                : or(
                    gte(
                      sources.occurred_at,
                      new Date(Date.now() - 90 * 86400000).toISOString(),
                    ),
                    eq(sources.provider, 'manual'),
                  ),
            ),
        )
        .onConflictDoUpdate({
          target: contact_queue.source_id,
          set: {
            state: 'pending',
            attempts: 0,
            error: '',
            content_hash: sql`excluded.content_hash`,
          },
        });
    }
    const id = uid();
    await db.insert(contact_runs).values({
      id,
      state: 'queued',
      started_at: stamp(),
      updated_at: stamp(),
    });
    return id;
  });
  if (REMOTE_WORKERS) return { id };
  const child = spawn(
    process.execPath,
    [resolve(root, 'scripts/contact-worker.mjs'), id],
    {
      cwd: root,
      env: { ...process.env, XIN_APP_ROOT: root },
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();
  child.on('error', () =>
    db
      .update(contact_runs)
      .set({ state: 'failed', message: 'Could not start extraction' })
      .where(and(eq(contact_runs.id, id), eq(contact_runs.state, 'queued')))
      .catch(() => {}),
  );
  return { id };
}
export async function recoverContactRuns() {
  await expireLeases('contact_runs');
  return db
    .select({ source_id: contact_queue.source_id, error: contact_queue.error })
    .from(contact_queue)
    .where(eq(contact_queue.state, 'failed'))
    .limit(10);
}

// Discover historical sources once, then always drain new source revisions.
export async function scheduleContactHistory() {
  return transaction(async () => {
    await lockWorkspace();
    if (!(await getSetting('contact_history_backfill_v1'))) {
      await db
        .insert(contact_queue)
        .select(
          db
            .select({
              source_id: sources.id,
              content_hash: sources.content_hash,
            })
            .from(sources)
            .where(
              inArray(sources.provider, [
                'gmail',
                'fireflies',
                'granola',
                'beeper',
              ]),
            ),
        )
        .onConflictDoNothing({ target: contact_queue.source_id });
      await setSetting('contact_history_backfill_v1', stamp());
    }
    const [pending] = await db
      .select({ source_id: contact_queue.source_id })
      .from(contact_queue)
      .where(eq(contact_queue.state, 'pending'))
      .limit(1);
    if (!pending) return null;
    return startContactProjection({ drain: true });
  });
}

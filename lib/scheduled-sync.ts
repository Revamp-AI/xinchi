import { calendarGranted } from './calendar.ts';
import { and, desc, eq, getColumns, inArray, sql } from 'drizzle-orm';
import { getSetting } from './db.ts';
import { db, transaction, lockWorkspace } from './postgres.ts';
import { durable_runs, sync_runs } from './schema/index.ts';
import { secrets } from './secret-store.ts';
import { startSync } from './connectors.ts';
import { resumeDurable } from './durable-ingestion.ts';
import { CLOUD_JOBS } from './runtime.mjs';
import { granolaConnections } from './granola-connections.mjs';

const FIVE_MINUTES = 5 * 60000,
  HOUR = 60 * 60000,
  DAY = 24 * HOUR;
export async function scheduleProviderSyncs() {
  if (!CLOUD_JOBS) return [];
  const configured = await secrets(),
    scheduled = [];
  // Each provider gets its own transaction; an active or broken import cannot
  // prevent another provider from being scheduled. No provider HTTP calls here.
  for (const provider of ['granola', 'fireflies', 'gmail', 'calendar']) {
    if (
      provider === 'calendar'
        ? !calendarGranted(configured.calendar_tokens)
        : provider === 'gmail'
          ? !configured.gmail_tokens?.refresh_token
          : provider === 'granola'
            ? !granolaConnections(configured).length
            : !configured[provider + '_key']
    )
      continue;
    try {
      const result = await transaction(async () => {
        await lockWorkspace();
        const [active] = await db
          .select({ id: sync_runs.id })
          .from(sync_runs)
          .where(
            and(
              eq(sync_runs.provider, provider),
              inArray(sync_runs.state, ['queued', 'running', 'uploading']),
            ),
          )
          .limit(1);
        if (active) return;
        const [latest] = await db
          .select({ ...getColumns(sync_runs), outcome: durable_runs.outcome })
          .from(sync_runs)
          .leftJoin(
            durable_runs,
            and(
              eq(durable_runs.kind, 'sync'),
              eq(durable_runs.run_id, sync_runs.id),
            ),
          )
          .where(eq(sync_runs.provider, provider))
          .orderBy(desc(sync_runs.started_at), desc(sync_runs.id))
          .limit(1);
        const outcome = latest?.outcome as { permanent?: boolean } | null;
        const elapsed = latest
          ? Date.now() -
            Date.parse(
              latest.finished_at || latest.updated_at || latest.started_at,
            )
          : Infinity;
        if (
          elapsed <
          (latest?.state === 'failed'
            ? outcome?.permanent
              ? DAY
              : HOUR
            : FIVE_MINUTES)
        )
          return;
        if (latest?.state === 'failed') {
          const resumed = await resumeDurable('sync', latest.id, provider);
          if (resumed) return { provider, ...resumed, resumed: true };
        }
        // Regular Granola discovery already covers every accessible ID. Re-read
        // bodies daily as well, including providers that update text without a date.
        const participant = (
          process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL ||
          process.env.XIN_ALLOWED_EMAIL ||
          ''
        ).trim();
        const cursor = durable_runs.cursor;
        const [lastFull] = await db
          .select({ finished_at: sync_runs.finished_at })
          .from(sync_runs)
          .innerJoin(
            durable_runs,
            and(
              eq(durable_runs.kind, 'sync'),
              eq(durable_runs.run_id, sync_runs.id),
            ),
          )
          .where(
            and(
              eq(sync_runs.provider, provider),
              eq(sync_runs.state, 'complete'),
              eq(durable_runs.completed, true),
              sql`${cursor}->>'phase' = 'done'`,
              sql`(CASE WHEN ${sync_runs.provider} = 'granola' THEN ${cursor}->>'rescan' = 'true' ELSE ${cursor}->>'since' IS NULL AND ${cursor}->>'participant' = ${participant} END)`,
            ),
          )
          .orderBy(desc(sync_runs.finished_at))
          .limit(1);
        const rescan =
          ['granola', 'fireflies'].includes(provider) &&
          !(await getSetting(provider + '_page')) &&
          (!lastFull ||
            Date.now() - Date.parse(String(lastFull.finished_at)) >= DAY);
        const started = await startSync(provider, { rescan });
        await db
          .update(sync_runs)
          .set({
            message: rescan
              ? 'Automatic history check queued'
              : 'Automatic sync queued',
          })
          .where(eq(sync_runs.id, started.id));
        return { provider, ...started, rescan };
      });
      if (result) scheduled.push(result);
    } catch {
      scheduled.push({
        provider,
        error: 'Could not schedule this connection; the next cron will retry.',
      });
    }
  }
  return scheduled;
}

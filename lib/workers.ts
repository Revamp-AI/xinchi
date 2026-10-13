import { and, eq } from 'drizzle-orm';
import { db } from './postgres.ts';
import { contact_runs, jobs, sync_runs } from './schema/index.ts';
import { CLOUD_JOBS } from './runtime.mjs';
export async function workerStatus() {
  return {
    mode: CLOUD_JOBS ? 'cloud' : 'local',
    model: CLOUD_JOBS
      ? process.env.XIN_AGENT_MODEL || 'openai/gpt-6-astra'
      : 'Codex',
  };
}
export const queues = {
  jobs: { state: 'status', script: 'worker.ts' },
  sync_runs: { state: 'state', script: 'sync-worker.ts' },
  contact_runs: { state: 'state', script: 'contact-worker.ts' },
};
// Each queue's table and the column queues[table].state names.
const queueTables = {
  jobs: [jobs, jobs.status],
  sync_runs: [sync_runs, sync_runs.state],
  contact_runs: [contact_runs, contact_runs.state],
} as const;
export async function queuedWork(table: string) {
  const q: { state: string } | undefined = queues[table as keyof typeof queues];
  if (!q) throw Error('Unknown worker queue.');
  const [t, state] = queueTables[table as keyof typeof queueTables];
  const [row] = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(state, 'queued'), eq(t.lease_owner, '')))
    .orderBy(t.updated_at, t.id)
    .limit(1);
  return row;
}

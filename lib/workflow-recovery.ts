import { and, eq, ne } from 'drizzle-orm';
import { db } from './postgres.ts';
import { durable_runs } from './schema/index.ts';
import { recoverStalledRun } from './durable-ingestion.mjs';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
export async function reconcileWorkflows(
  inspectStatus: (workflowId: string) => string | Promise<string>,
) {
  const rows = await db
    .select({
      kind: durable_runs.kind,
      run_id: durable_runs.run_id,
      workflow_id: durable_runs.workflow_id,
      revision: durable_runs.revision,
    })
    .from(durable_runs)
    .where(
      and(eq(durable_runs.completed, false), ne(durable_runs.workflow_id, '')),
    )
    .orderBy(durable_runs.updated_at, durable_runs.kind, durable_runs.run_id)
    .limit(20);
  // Network lookups do not hold locks. A resumed run can change owners while a
  // lookup is in flight; recovery checks both the owner and the saved revision before writing.
  const statuses = await Promise.allSettled(
    rows.map(async (row) => inspectStatus(row.workflow_id)),
  );
  for (let index = 0; index < rows.length; index++) {
    const status = statuses[index]!,
      row = rows[index]!;
    await recoverStalledRun(
      row.kind,
      row.run_id,
      row.workflow_id,
      row.revision,
      {
        terminal:
          status.status === 'fulfilled' && terminalStatuses.has(status.value),
      },
    );
  }
  return rows.length;
}

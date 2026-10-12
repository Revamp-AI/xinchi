import { test } from '@playwright/test';

// The desktop and mobile projects run against one shared test database
// (scripts/test-postgres.mjs --e2e). A spec that resets or fills
// workspace-wide state calls this at file scope, so its copy in the other
// project waits for it instead of interleaving. Each name is a separate lock,
// so every other spec keeps running in parallel. Postgres releases the lock
// when the connection closes, including when a worker process dies.
export function serializeAcrossProjects(name: string) {
  let client;
  test.beforeAll(async () => {
    // The wait can span the other project's whole run of the file.
    test.setTimeout(180_000);
    const pg = (await import('pg')).default;
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    // The two-key form keeps these locks apart from the app's single-key ones.
    await client.query(
      "SELECT pg_advisory_lock(hashtext('focus-e2e'), hashtext($1))",
      [name],
    );
  });
  test.afterAll(async () => {
    await client?.end();
  });
}

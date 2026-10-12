import {
  pgTable,
  text,
  integer,
  jsonb,
  bigint,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { beeper_devices } from './auth.ts';

export const sync_runs = pgTable(
  'sync_runs',
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    started_at: text().notNull(),
    finished_at: text(),
    state: text().notNull(),
    imported: integer().default(0).notNull(),
    message: text().default('').notNull(),
    pid: integer(),
    updated_at: text(),
    changed: integer().default(0).notNull(),
    lease_owner: text().default('').notNull(),
    lease_until: timestamp({ withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('sync_provider_active')
      .using('btree', table.provider.asc().nullsLast())
      .where(
        sql`(state = ANY (ARRAY['queued'::text, 'running'::text, 'uploading'::text]))`,
      ),
  ],
);

export const durable_runs = pgTable(
  'durable_runs',
  {
    kind: text().notNull(),
    run_id: text().notNull(),
    cursor: jsonb(),
    revision: integer().default(0).notNull(),
    workflow_id: text().default('').notNull(),
    dispatch_token: text().default('').notNull(),
    dispatch_until: timestamp({ withTimezone: true, mode: 'string' }),
    unit_token: text().default('').notNull(),
    unit_until: timestamp({ withTimezone: true, mode: 'string' }),
    attempts: integer().default(0).notNull(),
    completed: boolean().default(false).notNull(),
    outcome: jsonb().default({}).notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.kind, table.run_id],
      name: 'durable_runs_pkey',
    }),
    index('durable_pending')
      .using('btree', table.updated_at.asc().nullsLast())
      .where(sql`(completed = false)`),
    check(
      'durable_runs_kind_check',
      sql`(kind = ANY (ARRAY['sync'::text, 'contacts'::text]))`,
    ),
  ],
);

export const import_uploads = pgTable(
  'import_uploads',
  {
    run_id: text()
      .primaryKey()
      .references(() => sync_runs.id),
    format: text().notNull(),
    title: text().notNull(),
    expected_bytes: bigint({ mode: 'number' }).notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    check(
      'import_uploads_expected_bytes_check',
      sql`((expected_bytes >= 0) AND (expected_bytes <= 67108864))`,
    ),
    check(
      'import_uploads_format_check',
      sql`(format = ANY (ARRAY['json'::text, 'text'::text]))`,
    ),
  ],
);

export const import_chunks = pgTable(
  'import_chunks',
  {
    run_id: text()
      .notNull()
      .references(() => import_uploads.run_id, { onDelete: 'cascade' }),
    part: integer().notNull(),
    content: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.run_id, table.part],
      name: 'import_chunks_pkey',
    }),
    check('import_chunks_part_check', sql`(part >= 0)`),
  ],
);

export const import_records = pgTable(
  'import_records',
  {
    run_id: text()
      .notNull()
      .references(() => sync_runs.id),
    ordinal: integer().notNull(),
    payload: jsonb().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.run_id, table.ordinal],
      name: 'import_records_pkey',
    }),
    check('import_records_ordinal_check', sql`(ordinal >= 0)`),
  ],
);

export const beeper_uploads = pgTable('beeper_uploads', {
  run_id: text()
    .primaryKey()
    .references(() => sync_runs.id),
  device_id: text()
    .notNull()
    .references(() => beeper_devices.id),
  part_count: integer().default(0).notNull(),
  record_count: integer().default(0).notNull(),
  last_part_hash: text().default('').notNull(),
  sealed: boolean().default(false).notNull(),
});

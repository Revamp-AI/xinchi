import {
  pgTable,
  text,
  integer,
  bigserial,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { items, source_versions, sources } from './core.ts';

export const jobs = pgTable(
  'jobs',
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    status: text().notNull(),
    prompt: text().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    result_json: text(),
    error: text().default('').notNull(),
    progress: text().default('').notNull(),
    pid: integer(),
    lease_owner: text().default('').notNull(),
    lease_until: timestamp({ withTimezone: true, mode: 'string' }),
    model: text().default('').notNull(),
    usage_json: text(),
  },
  (table) => [
    uniqueIndex('jobs_single_active')
      .using('btree', sql`(true)`)
      .where(sql`(status = ANY (ARRAY['queued'::text, 'running'::text]))`),
  ],
);

export const job_events = pgTable(
  'job_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id, { name: 'job_events_job_id_fkey' }),
    label: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    index('job_events_job').using(
      'btree',
      table.job_id.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
  ],
);

export const proposals = pgTable(
  'proposals',
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id, { name: 'proposals_job_id_fkey' }),
    fingerprint: text().notNull(),
    status: text().default('pending').notNull(),
    payload: text().notNull(),
    created_at: text().notNull(),
    item_id: text().references(() => items.id, {
      name: 'proposals_item_id_fkey',
    }),
    version: integer().default(1).notNull(),
    deliverable_key: text().default('').notNull(),
    priority_score: integer().default(0).notNull(),
    reviewed_at: timestamp({ withTimezone: true, mode: 'string' }),
    review_attempted_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('proposals_deliverable_key')
      .using('btree', table.deliverable_key.asc().nullsLast())
      .where(sql`(deliverable_key <> ''::text)`),
    index('proposals_review_due').using(
      'btree',
      table.status.asc().nullsLast(),
      table.reviewed_at.asc().nullsLast(),
    ),
    unique('proposals_fingerprint_key').on(table.fingerprint),
  ],
);

export const proposal_events = pgTable('proposal_events', {
  id: text().primaryKey(),
  proposal_id: text()
    .notNull()
    .references(() => proposals.id, {
      name: 'proposal_events_proposal_id_fkey',
      onDelete: 'cascade',
    }),
  job_id: text().references(() => jobs.id, {
    name: 'proposal_events_job_id_fkey',
    onDelete: 'set null',
  }),
  action: text().notNull(),
  reason: text().notNull(),
  detail: jsonb().default({}).notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
});

export const proposal_review_batches = pgTable(
  'proposal_review_batches',
  {
    job_id: text()
      .notNull()
      .references(() => jobs.id, {
        name: 'proposal_review_batches_job_id_fkey',
        onDelete: 'cascade',
      }),
    proposal_id: text()
      .notNull()
      .references(() => proposals.id, {
        name: 'proposal_review_batches_proposal_id_fkey',
        onDelete: 'cascade',
      }),
    version: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.job_id, table.proposal_id],
      name: 'proposal_review_batches_pkey',
    }),
  ],
);

export const review_queue = pgTable(
  'review_queue',
  {
    source_id: text()
      .primaryKey()
      .references(() => sources.id, { name: 'review_queue_source_id_fkey' }),
    source_version_id: text()
      .notNull()
      .references(() => source_versions.id, {
        name: 'review_queue_source_version_id_fkey',
      }),
    next_offset: integer().default(0).notNull(),
    job_id: text().references(() => jobs.id, {
      name: 'review_queue_job_id_fkey',
    }),
    completed: boolean().default(false).notNull(),
    attempts: integer().default(0).notNull(),
    retry_after: timestamp({ withTimezone: true, mode: 'string' }),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
    revisit: boolean().default(false).notNull(),
  },
  (table) => [
    index('review_queue_pending')
      .using('btree', table.updated_at.asc().nullsLast())
      .where(sql`(completed = false)`),
  ],
);

export const review_batches = pgTable('review_batches', {
  job_id: text()
    .primaryKey()
    .references(() => jobs.id, { name: 'review_batches_job_id_fkey' }),
  pages: jsonb().notNull(),
});

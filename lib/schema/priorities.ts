import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  primaryKey,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { items } from './core.ts';
import { jobs } from './reviews.ts';

export const priority_stacks = pgTable('priority_stacks', {
  id: text().primaryKey(),
  name: text().notNull(),
  position: integer().notNull(),
});

export const priority_order = pgTable(
  'priority_order',
  {
    id: integer().primaryKey(),
    version: integer().default(1).notNull(),
  },
  (table) => [check('priority_order_id_check', sql`(id = 1)`)],
);

export const priorities = pgTable(
  'priorities',
  {
    id: text().primaryKey(),
    stack_id: text()
      .notNull()
      .references(() => priority_stacks.id, {
        name: 'priorities_stack_id_fkey',
      }),
    title: text().notNull(),
    owner: text().default('You').notNull(),
    financials: text().default('').notNull(),
    notes: text().default('').notNull(),
    keywords: text().default('').notNull(),
    next_decision: text().default('').notNull(),
    commitment_id: text().references(() => items.id, {
      name: 'priorities_commitment_id_fkey',
    }),
    status: text().default('active').notNull(),
    position: integer().notNull(),
    version: integer().default(1).notNull(),
    latest_summary: text().default('').notNull(),
    last_context_at: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    index('priorities_stack').using(
      'btree',
      table.stack_id.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.position.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    check(
      'priorities_status_check',
      sql`(status = ANY (ARRAY['active'::text, 'done'::text]))`,
    ),
  ],
);

export const priority_suggestions = pgTable(
  'priority_suggestions',
  {
    id: text().primaryKey(),
    priority_id: text().references(() => priorities.id, {
      name: 'priority_suggestions_priority_id_fkey',
    }),
    job_id: text().references(() => jobs.id, {
      name: 'priority_suggestions_job_id_fkey',
    }),
    payload: jsonb().notNull(),
    fingerprint: text().notNull(),
    status: text().default('pending').notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    unique('priority_suggestions_fingerprint_key').on(table.fingerprint),
    check(
      'priority_suggestions_status_check',
      sql`(status = ANY (ARRAY['pending'::text, 'applied'::text, 'dismissed'::text]))`,
    ),
  ],
);

export const priority_updates = pgTable(
  'priority_updates',
  {
    id: text().primaryKey(),
    priority_id: text()
      .notNull()
      .references(() => priorities.id, {
        name: 'priority_updates_priority_id_fkey',
      }),
    body: text().notNull(),
    origin: text().notNull(),
    citations: jsonb().default([]).notNull(),
    fingerprint: text().notNull(),
    job_id: text().references(() => jobs.id, {
      name: 'priority_updates_job_id_fkey',
    }),
    occurred_at: text().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    index('priority_updates_history').using(
      'btree',
      table.priority_id.asc().nullsLast(),
      table.occurred_at.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    unique('priority_updates_fingerprint_key').on(table.fingerprint),
    check(
      'priority_updates_origin_check',
      sql`(origin = ANY (ARRAY['user'::text, 'context'::text]))`,
    ),
  ],
);

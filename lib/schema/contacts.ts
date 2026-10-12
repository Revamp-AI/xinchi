import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  date,
  index,
  uniqueIndex,
  foreignKey,
  primaryKey,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { items, source_versions, sources } from './core.ts';
import { jobs } from './reviews.ts';

export const contacts = pgTable(
  'contacts',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    email: text().default('').notNull(),
    role: text().default('').notNull(),
    tags: jsonb().default([]).notNull(),
    notes: text().default('').notNull(),
    tracked: boolean().default(false).notNull(),
    cadence_days: integer().default(30).notNull(),
    paused: boolean().default(false).notNull(),
    snoozed_until: date(),
    do_not_contact: boolean().default(false).notNull(),
    archived: boolean().default(false).notNull(),
    confirmed: boolean().default(true).notNull(),
    merged_into: text(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
    version: integer().default(1).notNull(),
    priority: boolean().default(false).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.merged_into],
      foreignColumns: [table.id],
      name: 'contacts_merged_into_fkey',
    }),
    index('contacts_exact_email')
      .using('btree', sql`lower(btrim(email))`)
      .where(sql`((merged_into IS NULL) AND (email <> ''::text))`),
    index('contacts_search').using(
      'btree',
      sql`lower(name)`,
      sql`lower(email)`,
    ),
    check(
      'contacts_cadence_days_check',
      sql`((cadence_days >= 1) AND (cadence_days <= 3650))`,
    ),
  ],
);

export const contact_identities = pgTable(
  'contact_identities',
  {
    id: text().primaryKey(),
    contact_id: text()
      .notNull()
      .references(() => contacts.id),
    provider: text().notNull(),
    account: text().notNull(),
    external_key: text().notNull(),
    display_name: text().default('').notNull(),
    address: text().default('').notNull(),
    source_id: text().references(() => sources.id),
  },
  (table) => [
    index('contact_identities_exact_email')
      .using(
        'btree',
        sql`lower(btrim(address))`,
        table.contact_id.asc().nullsLast(),
      )
      .where(sql`(address <> ''::text)`),
    unique('contact_identities_provider_account_external_key_key').on(
      table.provider,
      table.account,
      table.external_key,
    ),
  ],
);

export const contact_insights = pgTable('contact_insights', {
  contact_id: text()
    .primaryKey()
    .references(() => contacts.id),
  input_hash: text().notNull(),
  result: jsonb().notNull(),
  model: text().default('').notNull(),
  run_id: text().notNull(),
  dismissed: boolean().default(false).notNull(),
  reviewed_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
});

export const contact_queue = pgTable(
  'contact_queue',
  {
    source_id: text()
      .primaryKey()
      .references(() => sources.id),
    content_hash: text().notNull(),
    state: text().default('pending').notNull(),
    attempts: integer().default(0).notNull(),
    error: text().default('').notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    index('contact_queue_pending')
      .using(
        'btree',
        table.updated_at.asc().nullsLast(),
        table.source_id.asc().nullsLast(),
      )
      .where(sql`(state = 'pending'::text)`),
  ],
);

export const contact_runs = pgTable(
  'contact_runs',
  {
    id: text().primaryKey(),
    state: text().notNull(),
    started_at: text().notNull(),
    updated_at: text().notNull(),
    finished_at: text(),
    imported: integer().default(0).notNull(),
    message: text().default('').notNull(),
    pid: integer(),
    lease_owner: text().default('').notNull(),
    lease_until: timestamp({ withTimezone: true, mode: 'string' }),
    review_requested: boolean().default(false).notNull(),
  },
  (table) => [
    uniqueIndex('contact_single_active')
      .using('btree', sql`true`)
      .where(sql`(state = ANY (ARRAY['queued'::text, 'running'::text]))`),
  ],
);

export const contact_state_history = pgTable('contact_state_history', {
  id: text().primaryKey(),
  contact_id: text()
    .notNull()
    .references(() => contacts.id),
  from_state: text(),
  to_state: text().notNull(),
  reason: text().notNull(),
  basis: jsonb().notNull(),
  changed_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
  rule_version: integer().default(1).notNull(),
});

export const contact_states = pgTable('contact_states', {
  contact_id: text()
    .primaryKey()
    .references(() => contacts.id),
  state: text().notNull(),
  basis: jsonb().notNull(),
  evaluated_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
  rule_version: integer().default(1).notNull(),
});

export const contact_analysis_runs = pgTable('contact_analysis_runs', {
  id: text().primaryKey(),
  state: text().notNull(),
  model: text().default('').notNull(),
  started_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
  finished_at: timestamp({ withTimezone: true, mode: 'string' }),
  reviewed: integer().default(0).notNull(),
  skipped: integer().default(0).notNull(),
  usage: jsonb(),
  error: text().default('').notNull(),
});

export const affiliations = pgTable(
  'affiliations',
  {
    id: text().primaryKey(),
    contact_id: text()
      .notNull()
      .references(() => contacts.id),
    organization_id: text()
      .notNull()
      .references(() => organizations.id),
    role: text().default('').notNull(),
    started_on: date(),
    ended_on: date(),
  },
  (table) => [
    check(
      'affiliations_check',
      sql`((ended_on IS NULL) OR (started_on IS NULL) OR (ended_on >= started_on))`,
    ),
  ],
);

export const organizations = pgTable(
  'organizations',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    domain: text().default('').notNull(),
  },
  (table) => [
    uniqueIndex('organizations_name').using('btree', sql`lower(name)`),
  ],
);

export const identity_decisions = pgTable('identity_decisions', {
  id: text().primaryKey(),
  kind: text().notNull(),
  left_id: text()
    .notNull()
    .references(() => contacts.id),
  right_id: text()
    .notNull()
    .references(() => contacts.id),
  before_snapshot: jsonb().notNull(),
  after_hash: text().notNull(),
  undone_at: timestamp({ withTimezone: true, mode: 'string' }),
  created_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
});

export const identity_reviews = pgTable(
  'identity_reviews',
  {
    id: text().primaryKey(),
    left_id: text()
      .notNull()
      .references(() => contacts.id),
    right_id: text()
      .notNull()
      .references(() => contacts.id),
    reason: text().notNull(),
    status: text().default('pending').notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    unique('identity_reviews_left_id_right_id_key').on(
      table.left_id,
      table.right_id,
    ),
  ],
);

export const interactions = pgTable(
  'interactions',
  {
    id: text().primaryKey(),
    source_id: text().references(() => sources.id),
    kind: text().notNull(),
    title: text().notNull(),
    occurred_at: timestamp({ withTimezone: true, mode: 'string' }),
    direction: text().default('unknown').notNull(),
    qualified: boolean().default(false).notNull(),
    exclusion: text().default('').notNull(),
    thread_key: text().default('').notNull(),
    duplicate_of: text(),
    duplicate_status: text().default('').notNull(),
    version: integer().default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.duplicate_of],
      foreignColumns: [table.id],
      name: 'interactions_duplicate_of_fkey',
    }),
    index('interactions_chronology').using(
      'btree',
      table.occurred_at.desc().nullsFirst(),
    ),
    unique('interactions_source_id_key').on(table.source_id),
    check(
      'interactions_kind_check',
      sql`(kind = ANY (ARRAY['email'::text, 'meeting'::text, 'note'::text, 'message'::text]))`,
    ),
  ],
);

export const interaction_decisions = pgTable('interaction_decisions', {
  id: text().primaryKey(),
  interaction_id: text()
    .notNull()
    .references(() => interactions.id),
  action: text().notNull(),
  before_snapshot: jsonb().notNull(),
  after_snapshot: jsonb().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
});

export const interaction_participants = pgTable(
  'interaction_participants',
  {
    interaction_id: text()
      .notNull()
      .references(() => interactions.id),
    contact_id: text()
      .notNull()
      .references(() => contacts.id),
    role: text().default('').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interaction_id, table.contact_id],
      name: 'interaction_participants_pkey',
    }),
    index('participants_contact').using(
      'btree',
      table.contact_id.asc().nullsLast(),
      table.interaction_id.asc().nullsLast(),
    ),
  ],
);

export const interaction_sources = pgTable(
  'interaction_sources',
  {
    interaction_id: text()
      .notNull()
      .references(() => interactions.id),
    source_version_id: text()
      .notNull()
      .references(() => source_versions.id),
    source_id: text()
      .notNull()
      .references(() => sources.id),
    quote: text().default('').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interaction_id, table.source_version_id],
      name: 'interaction_sources_pkey',
    }),
  ],
);

export const item_contacts = pgTable(
  'item_contacts',
  {
    item_id: text()
      .notNull()
      .references(() => items.id),
    contact_id: text()
      .notNull()
      .references(() => contacts.id),
  },
  (table) => [
    primaryKey({
      columns: [table.item_id, table.contact_id],
      name: 'item_contacts_pkey',
    }),
  ],
);

export const message_drafts = pgTable('message_drafts', {
  id: text().primaryKey(),
  contact_id: text()
    .notNull()
    .references(() => contacts.id),
  job_id: text().references(() => jobs.id),
  subject: text().default('').notNull(),
  body: text().notNull(),
  citations: jsonb().default([]).notNull(),
  status: text().default('draft').notNull(),
  version: integer().default(1).notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
  updated_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
});

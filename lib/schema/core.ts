import {
  pgTable,
  text,
  integer,
  index,
  primaryKey,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const sources = pgTable(
  'sources',
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    external_id: text().notNull(),
    title: text().notNull(),
    occurred_at: text().default('').notNull(),
    body: text().default('').notNull(),
    url: text().default('').notNull(),
    coverage: text().notNull(),
    content_hash: text().notNull(),
    imported_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (table) => [
    index('source_search').using(
      'gin',
      sql`to_tsvector('simple'::regconfig, ((title || ' '::text) || body))`,
    ),
    index('sources_chronology').using(
      'btree',
      table.occurred_at.desc().nullsFirst(),
      table.id.asc().nullsLast(),
    ),
    unique('sources_provider_external_id_key').on(
      table.provider,
      table.external_id,
    ),
  ],
);

export const source_versions = pgTable(
  'source_versions',
  {
    id: text().primaryKey(),
    source_id: text()
      .notNull()
      .references(() => sources.id),
    content_hash: text().notNull(),
    raw_json: text().notNull(),
    fetched_at: text().notNull(),
    normalized_body: text(),
  },
  (table) => [
    index('source_versions_latest').using(
      'btree',
      table.source_id.asc().nullsLast(),
      table.fetched_at.desc().nullsFirst(),
    ),
    unique('source_versions_source_id_content_hash_key').on(
      table.source_id,
      table.content_hash,
    ),
  ],
);

export const items = pgTable('items', {
  id: text().primaryKey(),
  title: text().notNull(),
  kind: text().default('action').notNull(),
  status: text().default('candidate').notNull(),
  done_when: text().default('').notNull(),
  next_action: text().default('').notNull(),
  owner: text().default('You').notNull(),
  checkpoint: text().default('').notNull(),
  hard_deadline: text().default('').notNull(),
  original_checkpoint: text().default('').notNull(),
  dependency: text().default('').notNull(),
  evidence: text().default('').notNull(),
  reason: text().default('').notNull(),
  source_id: text().references(() => sources.id),
  source_quote: text().default('').notNull(),
  shared: integer().default(0).notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
  version: integer().default(1).notNull(),
  last_action: text().default('').notNull(),
  fallback: text().default('').notNull(),
  source_version_id: text().references(() => source_versions.id),
});

export const events = pgTable(
  'events',
  {
    id: text().primaryKey(),
    item_id: text()
      .notNull()
      .references(() => items.id),
    action: text().notNull(),
    before_json: text(),
    after_json: text().notNull(),
    reason: text().notNull(),
    created_at: text().notNull(),
  },
  (table) => [
    index('events_item').using(
      'btree',
      table.item_id.asc().nullsLast(),
      table.created_at.desc().nullsFirst(),
    ),
  ],
);

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const workspace_lock = pgTable(
  'workspace_lock',
  {
    id: integer().primaryKey(),
  },
  (table) => [check('workspace_lock_id_check', sql`(id = 1)`)],
);

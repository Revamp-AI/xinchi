import {
  pgSchema,
  text,
  integer,
  bigserial,
  jsonb,
  bigint,
  timestamp,
  boolean,
  index,
  primaryKey,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const focus_auth = pgSchema('focus_auth');

export const auth_events = focus_auth.table('auth_events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  created_at: text().notNull(),
  stage: text().notNull(),
  outcome: text().notNull(),
  code: text().notNull(),
  http_status: integer(),
  provider_reason: text(),
});

export const beeper_devices = focus_auth.table(
  'beeper_devices',
  {
    id: text().primaryKey(),
    token_hash: text().notNull(),
    owner_email: text().notNull(),
    label: text().notNull(),
    selection: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
    last_seen: timestamp({ withTimezone: true, mode: 'string' }),
    revoked_at: timestamp({ withTimezone: true, mode: 'string' }),
    requested: boolean().default(true).notNull(),
    issue: text().default('').notNull(),
  },
  (table) => [unique('beeper_devices_token_hash_key').on(table.token_hash)],
);

export const beeper_pairings = focus_auth.table('beeper_pairings', {
  token_hash: text().primaryKey(),
  owner_email: text().notNull(),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
});

export const mcp_clients = focus_auth.table('mcp_clients', {
  id: text().primaryKey(),
  name: text().notNull(),
  redirect_uris: jsonb().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
});

export const mcp_codes = focus_auth.table('mcp_codes', {
  token_hash: text().primaryKey(),
  grant_id: text()
    .notNull()
    .references(() => mcp_grants.id, { name: 'mcp_codes_grant_id_fkey' }),
  redirect_uri: text().notNull(),
  challenge: text().notNull(),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
});

export const mcp_grants = focus_auth.table('mcp_grants', {
  id: text().primaryKey(),
  client_id: text()
    .notNull()
    .references(() => mcp_clients.id, { name: 'mcp_grants_client_id_fkey' }),
  owner_sub: text().notNull(),
  owner_email: text().notNull(),
  scope: text().notNull(),
  resource: text().notNull(),
  created_at: timestamp({ withTimezone: true, mode: 'string' })
    .default(sql`now()`)
    .notNull(),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  last_used_at: timestamp({ withTimezone: true, mode: 'string' }),
  revoked_at: timestamp({ withTimezone: true, mode: 'string' }),
});

export const mcp_operations = focus_auth.table(
  'mcp_operations',
  {
    grant_id: text()
      .notNull()
      .references(() => mcp_grants.id, {
        name: 'mcp_operations_grant_id_fkey',
      }),
    tool: text().notNull(),
    request_key: text().notNull(),
    args_hash: text().notNull(),
    result: jsonb().notNull(),
    created_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.grant_id, table.tool, table.request_key],
      name: 'mcp_operations_pkey',
    }),
  ],
);

export const mcp_rate_limits = focus_auth.table('mcp_rate_limits', {
  key: text().primaryKey(),
  count: integer().notNull(),
  expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
});

export const mcp_tokens = focus_auth.table(
  'mcp_tokens',
  {
    token_hash: text().primaryKey(),
    grant_id: text()
      .notNull()
      .references(() => mcp_grants.id, { name: 'mcp_tokens_grant_id_fkey' }),
    kind: text().notNull(),
    expires_at: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    used_at: timestamp({ withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('mcp_tokens_grant').using('btree', table.grant_id.asc().nullsLast()),
    check(
      'mcp_tokens_kind_check',
      sql`(kind = ANY (ARRAY['access'::text, 'refresh'::text]))`,
    ),
  ],
);

export const oauth_attempts = focus_auth.table('oauth_attempts', {
  state_hash: text().primaryKey(),
  browser_hash: text().notNull(),
  verifier: text().notNull(),
  nonce: text().notNull(),
  client_id: text().notNull(),
  expires_at: bigint({ mode: 'number' }).notNull(),
});

export const owner = focus_auth.table(
  'owner',
  {
    id: integer().primaryKey(),
    sub: text().notNull(),
    email: text().notNull(),
    name: text().notNull(),
  },
  (table) => [check('owner_id_check', sql`(id = 1)`)],
);

export const provider_secrets = focus_auth.table(
  'provider_secrets',
  {
    id: integer().primaryKey(),
    payload: jsonb().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [check('provider_secrets_id_check', sql`(id = 1)`)],
);

export const sessions = focus_auth.table('sessions', {
  token_hash: text().primaryKey(),
  sub: text().notNull(),
  created_at: bigint({ mode: 'number' }).notNull(),
  expires_at: bigint({ mode: 'number' }).notNull(),
});

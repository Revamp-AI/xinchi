import { defineConfig } from 'drizzle-kit';

// Migrations are generated here but applied only by `npm run db:migrate`
// (lib/migrations), which holds the schema lock. Do not run `drizzle-kit
// migrate` or `drizzle-kit push` against a real database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/schema/index.ts',
  out: './drizzle',
  schemaFilter: ['public', 'focus_auth'],
  tablesFilter: ['!focus_schema_migrations'],
  introspect: { casing: 'preserve' },
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '',
  },
});

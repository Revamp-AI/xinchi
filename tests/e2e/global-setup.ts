import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

// A fixed 43-character base64url token: the only shape lib/auth.mjs accepts.
export const sessionToken = 'focusE2Esession_0123456789abcdefghijklmnopq';
export const ownerName = 'Alex';

// Fictional fixtures only. Titles and bodies are what the smoke test looks for.
export const sources = [
  {
    provider: 'fireflies',
    external_id: 'e2e-fireflies-1',
    title: 'Orchard roadmap sync',
    occurred_at: '2026-03-03T10:00:00Z',
    coverage: 'transcript',
    body:
      'Priya: The Orchard launch slips unless the billing migration lands by the end of the month.\n' +
      'Alex: Agreed. I will own the migration checklist and report back on Friday.',
  },
  {
    provider: 'granola',
    external_id: 'e2e-granola-1',
    title: 'Lantern pricing review',
    occurred_at: '2026-03-05T15:30:00Z',
    coverage: 'summary',
    body: 'Summary: The team compared three Lantern pricing tiers and asked Alex to draft the recommendation before the next board update.',
  },
  {
    provider: 'manual',
    external_id: 'e2e-manual-1',
    title: 'Harbor release checklist',
    occurred_at: '2026-03-08',
    coverage: 'document',
    body:
      'Harbor release checklist\n' +
      '- Confirm the rollback plan with support.\n' +
      '- Publish the release notes on the status page.\n' +
      '- Schedule the retrospective for the week after launch.',
  },
];
export const candidate = {
  title: 'Confirm the Harbor rollback plan with support',
  kind: 'action',
  status: 'candidate',
  next_action: 'Book twenty minutes with the support lead',
  source_id: 'manual:e2e-manual-1',
  source_quote: 'Confirm the rollback plan with support.',
};

export default async function globalSetup(config: FullConfig) {
  const dataDir = process.env.FOCUS_E2E_DATA_DIR;
  const ownerEmail = config.webServer?.env?.XIN_ALLOWED_EMAIL;
  if (!dataDir || !path.basename(dataDir).startsWith('focus-e2e-')) {
    throw new Error(
      'The e2e data directory must come from playwright.config.ts.',
    );
  }
  if (!ownerEmail) {
    throw new Error(
      'playwright.config.ts must pass XIN_ALLOWED_EMAIL to the server.',
    );
  }
  // The lib modules open their databases on import, so the environment has to
  // point at the isolated directory before they load.
  process.env.XIN_DATA_DIR = dataDir;
  process.env.XIN_ALLOWED_EMAIL = ownerEmail;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = await import('../../lib/db.mjs');
  const auth = await import('../../lib/auth.mjs');
  for (const source of sources) db.upsertSource(source);
  db.saveItem(candidate);
  auth.authDb
    .prepare(
      'INSERT INTO owner VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET sub=excluded.sub,email=excluded.email,name=excluded.name',
    )
    .run('e2e-owner', ownerEmail, ownerName);
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  const tenYears = 10 * 365 * 24 * 60 * 60 * 1000;
  auth.authDb
    .prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)')
    .run(tokenHash, 'e2e-owner', Date.now(), Date.now() + tenYears);
  writeFileSync(
    path.join(dataDir, 'storage-state.json'),
    JSON.stringify({
      cookies: [
        {
          name: auth.SESSION_COOKIE,
          value: sessionToken,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
}

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { dataDir } from './db.mjs';
import { db, transaction } from './postgres.ts';
import { provider_secrets } from './schema/index.ts';
import { POSTGRES_SECRETS } from './runtime.mjs';

type GoogleGrant = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_at?: number;
};
// Provider credentials and connection state. Other modules keep their own
// entries here too; none of it is returned to the browser.
export type Secrets = {
  fireflies_key?: string;
  granola_key?: string;
  granola_label?: string;
  granola_workspaces?: { id: string; label: string; key: string }[];
  gmail_tokens?: GoogleGrant;
  calendar_tokens?: GoogleGrant;
  gmail_issue?: { code: string; at: string };
  calendar_issue?: boolean;
  google_client?: { client_id: string; client_secret: string };
  [key: string]: unknown;
};
// The stored form: AES-256-GCM ciphertext of the JSON-encoded Secrets.
type EncryptedSecrets = { v: number; iv: string; tag: string; data: string };
const secretPath = resolve(dataDir, 'connections.secret.json');
const aad = Buffer.from('focus-provider-secrets:v1');
let localUpdate: Promise<unknown> = Promise.resolve();
export function localSecrets(): Secrets {
  return existsSync(secretPath)
    ? JSON.parse(readFileSync(secretPath, 'utf8'))
    : {};
}
export function saveLocalSecrets(value: Secrets) {
  const tmp = secretPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, secretPath);
}
function key() {
  const value = Buffer.from(process.env.XIN_SECRETS_KEY || '', 'base64url');
  if (value.length !== 32)
    throw Error('Configure the private credential encryption key.');
  return value;
}
export function encryptSecrets(value: Secrets): EncryptedSecrets {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
}
export function decryptSecrets(value: EncryptedSecrets): Secrets {
  if (value.v !== 1) throw Error('Unknown credential storage version.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(value.iv, 'base64url'),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8'),
  );
}
export async function secrets(): Promise<Secrets> {
  if (!POSTGRES_SECRETS) return localSecrets();
  key();
  const [row] = await db
    .select({ payload: provider_secrets.payload })
    .from(provider_secrets)
    .where(eq(provider_secrets.id, 1));
  return row ? decryptSecrets(row.payload as EncryptedSecrets) : {};
}
export async function updateSecrets<T>(
  update: (current: Secrets) => T | Promise<T>,
): Promise<T> {
  if (!POSTGRES_SECRETS) {
    const pending = localUpdate.then(async () => {
      const current = localSecrets();
      const result = await update(current);
      saveLocalSecrets(current);
      return result;
    });
    localUpdate = pending.catch(() => {});
    return pending;
  }
  return transaction(async () => {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('focus-provider-secrets'))`,
    );
    const current = await secrets(),
      result = await update(current);
    await db
      .insert(provider_secrets)
      .values({ id: 1, payload: encryptSecrets(current) })
      .onConflictDoUpdate({
        target: provider_secrets.id,
        set: { payload: sql`excluded.payload`, updated_at: sql`now()` },
      });
    return result;
  });
}
export async function saveSecrets(value: Secrets) {
  return updateSecrets((current) => {
    for (const k of Object.keys(current)) delete current[k];
    Object.assign(current, value);
  });
}

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type KeyInput,
} from 'jose';
import { and, desc, eq, gt, lte, notInArray, sql } from 'drizzle-orm';
import { db } from './postgres.ts';
import { all, one, run, transaction, lockWorkspace } from './db.mjs';
import {
  auth_events,
  oauth_attempts,
  owner,
  sessions,
} from './schema/index.ts';
import {
  googleClient,
  request,
  saveGoogleGrant,
  saveCalendarGrant,
  recordCalendarIssue,
  recordGmailIssue,
} from './connectors.ts';

import { signInFailureCode } from './auth-messages.mjs';
import { APP_ORIGIN, HOSTED } from './runtime.mjs';
export { APP_ORIGIN } from './runtime.mjs';
export const CALLBACK = APP_ORIGIN + '/api/auth/google/callback';
export const SESSION_COOKIE = HOSTED ? '__Host-xin_session' : 'xin_session';
export const FLOW_COOKIE = HOSTED
  ? '__Host-xin_google_flow'
  : 'xin_google_flow';
export const SESSION_SECONDS = 12 * 60 * 60;
const flowSeconds = 10 * 60;
// What a sign-in failure may carry: a fixed auth code, a provider reason or
// code from connectors.mjs, a jose error code, or an HTTP status.
type AuthFailure = {
  authCode?: string;
  providerReason?: unknown;
  providerCode?: unknown;
  code?: unknown;
  status?: unknown;
};
// Authentication lives in a restricted schema and is never part of workspace exports.
const authSQL = (sql: string) =>
  sql.replace(
    /\b(owner|sessions|oauth_attempts|auth_events)\b/g,
    'focus_auth.$1',
  );
export const authDb = {
  prepare(sql: string) {
    return {
      get: async (...args: unknown[]) => await one(authSQL(sql), ...args),
      all: async (...args: unknown[]) => await all(authSQL(sql), ...args),
      run: async (...args: unknown[]) => await run(authSQL(sql), ...args),
    };
  },
  exec: async (sql: string) => await run(authSQL(sql)),
  close: async () => {},
};
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const same = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const allowedEmail = () =>
  String(process.env.XIN_ALLOWED_EMAIL || '')
    .trim()
    .toLowerCase();
export function cookie(name: string, value: string, age: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${HOSTED ? '; Secure' : ''}`;
}
export function readCookie(req: Request, name: string) {
  const matches = (req.headers.get('cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(name + '='));
  return matches.length === 1 ? matches[0]!.slice(name.length + 1) : '';
}
export function checkLocalRequest(req: Request, write = false) {
  if (req.headers.get('host') !== new URL(APP_ORIGIN).host)
    throw Object.assign(Error('Open Focus at its configured address.'), {
      status: 403,
    });
  if (
    write &&
    (req.headers.get('origin') !== APP_ORIGIN ||
      req.headers.get('x-xin-request') !== '1')
  )
    throw Object.assign(Error('Requests must come from this app.'), {
      status: 403,
    });
}
export async function sessionFor(token: string | null | undefined) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  const [row] = await db
    .select({
      sub: owner.sub,
      email: owner.email,
      name: owner.name,
      expires_at: sessions.expires_at,
    })
    .from(sessions)
    .innerJoin(owner, eq(owner.sub, sessions.sub))
    .where(
      and(
        eq(sessions.token_hash, digest(token!)),
        gt(sessions.expires_at, Date.now()),
      ),
    );
  return row && row.email === allowedEmail() ? row : null;
}
export async function requireSession(req: Request) {
  const user = await sessionFor(readCookie(req, SESSION_COOKIE));
  if (!user)
    throw Object.assign(Error('Sign in to open your workspace.'), {
      status: 401,
    });
  return user;
}
export async function endSession(token: string | null | undefined) {
  if (token)
    await db.delete(sessions).where(eq(sessions.token_hash, digest(token)));
}
async function cleanExpired() {
  await db.delete(sessions).where(lte(sessions.expires_at, Date.now()));
  await db
    .delete(oauth_attempts)
    .where(lte(oauth_attempts.expires_at, Date.now()));
}
export async function beginGoogle(oldBrowser = '') {
  if (!allowedEmail())
    throw Error(
      'Set XIN_ALLOWED_EMAIL in .env.local and restart Focus before signing in.',
    );
  const client = googleClient();
  if (!client) throw Error('Set up Google sign-in first.');
  await cleanExpired();
  if (oldBrowser)
    await db
      .delete(oauth_attempts)
      .where(eq(oauth_attempts.browser_hash, digest(oldBrowser)));
  const state = random(),
    browser = random(),
    verifier = randomBytes(48).toString('base64url'),
    nonce = random();
  await db.insert(oauth_attempts).values({
    state_hash: digest(state),
    browser_hash: digest(browser),
    verifier,
    nonce,
    client_id: client.client_id,
    expires_at: Date.now() + flowSeconds * 1000,
  });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    response_type: 'code',
    scope:
      'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly',
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state,
    nonce,
    login_hint: allowedEmail(),
    code_challenge: digestBase64(verifier),
    code_challenge_method: 'S256',
  }))
    u.searchParams.set(k, v);
  return { url: u.href, cookie: cookie(FLOW_COOKIE, browser, flowSeconds) };
}
function digestBase64(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}
const googleKeys = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
  { timeoutDuration: 10000 },
);
export async function verifyGoogleIdentity(
  token: string,
  clientId: string,
  nonce: string,
  keys: KeyInput | JWTVerifyGetKey = googleKeys,
) {
  const { payload: p } = await jwtVerify(token, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'iat', 'exp'],
    maxTokenAge: '10m',
    clockTolerance: 5,
  });
  if (
    !same(p.nonce, nonce) ||
    p.email_verified !== true ||
    typeof p.sub !== 'string' ||
    !p.sub ||
    typeof p.email !== 'string' ||
    (p.azp && p.azp !== clientId)
  )
    throw Error('Google identity could not be verified.');
  if (p.email.toLowerCase() !== allowedEmail())
    throw Object.assign(
      Error('This Google account is not allowed to open this workspace.'),
      { authCode: 'account' },
    );
  const [pinned] = await db.select().from(owner).where(eq(owner.id, 1));
  if (pinned && pinned.sub !== p.sub)
    throw Object.assign(
      Error('This Google identity does not own the workspace.'),
      { authCode: 'account' },
    );
  return {
    sub: p.sub,
    email: p.email.toLowerCase(),
    name: typeof p.name === 'string' ? p.name : 'You',
  };
}
export async function recordAuthEvent(
  stage: string,
  outcome: string,
  code = '',
  error: AuthFailure = {},
) {
  const reasons: unknown[] = [
    'SERVICE_DISABLED',
    'accessNotConfigured',
    'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'ERR_JWT_EXPIRED',
    'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWKS_NO_MATCHING_KEY',
    'ERR_JWKS_TIMEOUT',
    'ERR_JWS_INVALID',
    'ERR_JWT_INVALID',
  ];
  const reason =
    [error.providerReason, error.providerCode, error.code].find((x) =>
      reasons.includes(x),
    ) || null;
  await db.insert(auth_events).values({
    created_at: new Date().toISOString(),
    stage,
    outcome,
    code,
    http_status: Number.isInteger(error.status)
      ? (error.status as number)
      : null,
    provider_reason: reason as string | null,
  });
  await db
    .delete(auth_events)
    .where(
      notInArray(
        auth_events.id,
        db
          .select({ id: auth_events.id })
          .from(auth_events)
          .orderBy(desc(auth_events.id))
          .limit(200),
      ),
    );
}
export async function finishGoogle(
  code: string | null,
  state: string | null,
  browser: string | null,
  keys: KeyInput | JWTVerifyGetKey = googleKeys,
) {
  let stage = 'state';
  try {
    if (!state || !browser) throw Error('Google sign-in expired. Try again.');
    const [pending] = await db
      .delete(oauth_attempts)
      .where(
        and(
          eq(oauth_attempts.state_hash, digest(state)),
          eq(oauth_attempts.browser_hash, digest(browser)),
          gt(oauth_attempts.expires_at, Date.now()),
        ),
      )
      .returning();
    if (
      !pending ||
      pending.expires_at <= Date.now() ||
      !same(pending.browser_hash, digest(browser))
    )
      throw Error('Google sign-in expired or belongs to another browser.');
    // Consume before the token exchange: a callback can never be replayed.

    const client = googleClient();
    if (!code || !client || client.client_id !== pending.client_id)
      throw Error('Google sign-in was cancelled or configuration changed.');
    await recordAuthEvent(stage, 'complete');
    stage = 'token_exchange';
    const tokens = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...client,
        code,
        code_verifier: pending.verifier,
        grant_type: 'authorization_code',
        redirect_uri: CALLBACK,
      }),
    });
    await recordAuthEvent(stage, 'complete');
    stage = 'identity';
    const identity = await verifyGoogleIdentity(
      tokens.id_token,
      client.client_id,
      pending.nonce,
      keys,
    );
    await recordAuthEvent(stage, 'complete');
    stage = 'gmail';
    let gmail = false,
      gmailIssue = '';
    try {
      gmail = await saveGoogleGrant(tokens, identity);
      await recordAuthEvent(stage, gmail ? 'complete' : 'not_granted');
    } catch (error) {
      if ((error as AuthFailure).authCode === 'account') throw error;
      gmailIssue = await recordGmailIssue(error);
      await recordAuthEvent(stage, 'warning', gmailIssue, error as AuthFailure);
    }
    let calendar = false;
    try {
      calendar = await saveCalendarGrant(tokens, identity);
    } catch (error) {
      if ((error as AuthFailure).authCode === 'account') throw error;
      await recordCalendarIssue();
    }
    stage = 'session';
    const token = random();
    await transaction(async () => {
      await lockWorkspace();
      const [current] = await db
        .select({ sub: owner.sub })
        .from(owner)
        .where(eq(owner.id, 1));
      if (current && current.sub !== identity.sub)
        throw Error('Workspace owner changed during sign-in.');
      await db
        .insert(owner)
        .values({
          id: 1,
          sub: identity.sub,
          email: identity.email,
          name: identity.name,
        })
        .onConflictDoUpdate({
          target: owner.id,
          set: { email: sql`excluded.email`, name: sql`excluded.name` },
        });
      await db.insert(sessions).values({
        token_hash: digest(token),
        sub: identity.sub,
        created_at: Date.now(),
        expires_at: Date.now() + SESSION_SECONDS * 1000,
      });
    });
    await recordAuthEvent(stage, 'complete');
    return { identity, gmail, calendar, token, gmailIssue };
  } catch (error) {
    const failure = error as AuthFailure;
    failure.authCode = signInFailureCode(failure, stage);
    await recordAuthEvent(stage, 'failed', failure.authCode, failure);
    throw error;
  }
}

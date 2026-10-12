import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  and,
  desc,
  eq,
  getColumns,
  gt,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { db, transaction } from './postgres.ts';
import { uid } from './db.mjs';
import {
  mcp_clients,
  mcp_codes,
  mcp_grants,
  mcp_operations,
  mcp_rate_limits,
  mcp_tokens,
  owner,
} from './schema/index.ts';
import { APP_ORIGIN, allowedEmail } from './auth.mjs';

// Untrusted OAuth request fields; each one is checked before it is used.
type OAuthInput = Record<string, any>;
type OAuthUser = { sub: string; email: string } | null | undefined;

export const MCP_URL = APP_ORIGIN + '/mcp';
export const MCP_SCOPES = ['focus:read', 'focus:write'];
export const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const equal = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const error = (message: string, code = 'invalid_request', status = 400) =>
  Object.assign(Error(message), { oauthCode: code, status });
export const protectedResourceMetadata = () => ({
  resource: MCP_URL,
  authorization_servers: [APP_ORIGIN],
  scopes_supported: MCP_SCOPES,
  bearer_methods_supported: ['header'],
  resource_name: 'Focus workspace',
});
export const authorizationMetadata = () => ({
  issuer: APP_ORIGIN,
  authorization_endpoint: APP_ORIGIN + '/mcp/authorize',
  token_endpoint: APP_ORIGIN + '/api/mcp/token',
  registration_endpoint: APP_ORIGIN + '/api/mcp/register',
  revocation_endpoint: APP_ORIGIN + '/api/mcp/revoke',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: MCP_SCOPES,
  authorization_response_iss_parameter_supported: true,
});

export function checkMcpOrigin(req: Request) {
  // Next may reconstruct request.url with its internal listening address.
  // Validate the HTTP Host instead, as the workspace's browser auth does.
  if (
    (req.headers.get('host') || new URL(req.url).host) !==
    new URL(APP_ORIGIN).host
  )
    throw error('Use the configured Focus address.', 'invalid_request', 403);
  const origin = req.headers.get('origin');
  if (origin && origin !== APP_ORIGIN)
    throw error('This browser origin is not allowed.', 'invalid_request', 403);
}
export async function rateLimit(key: string, limit = 120) {
  const { count, expires_at } = mcp_rate_limits;
  const expired = sql`${expires_at} <= now()`;
  const [row] = await db
    .insert(mcp_rate_limits)
    .values({ key, count: 1, expires_at: sql`now() + interval '1 minute'` })
    .onConflictDoUpdate({
      target: mcp_rate_limits.key,
      set: {
        count: sql`CASE WHEN ${expired} THEN 1 ELSE ${count} + 1 END`,
        expires_at: sql`CASE WHEN ${expired} THEN now() + interval '1 minute' ELSE ${expires_at} END`,
      },
    })
    .returning({ count });
  if (row!.count > limit)
    throw error(
      'Too many requests. Try again in one minute.',
      'temporarily_unavailable',
      429,
    );
}
export async function readMcpBody(req: Request, limit = 65536) {
  if (Number(req.headers.get('content-length')) > limit)
    throw error('Request is too large.', 'invalid_request', 413);
  const reader = req.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw error('Request is too large.', 'invalid_request', 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  return Buffer.concat(chunks).toString('utf8');
}
const loopback = (u: URL) =>
  u.protocol === 'http:' &&
  ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
function redirectUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048)
    throw error('Invalid redirect URI.');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw error('Invalid redirect URI.');
  }
  if (
    u.username ||
    u.password ||
    u.hash ||
    !(u.protocol === 'https:' || loopback(u))
  )
    throw error('Use HTTPS or a loopback HTTP callback.');
  return u;
}
export function redirectMatches(registered: unknown[], requested: unknown) {
  const actual = redirectUrl(requested);
  return registered.some((value) => {
    const expected = redirectUrl(value);
    if (expected.href === actual.href) return true;
    if (
      loopback(expected) &&
      loopback(actual) &&
      expected.hostname === actual.hostname
    ) {
      const normalized = new URL(actual);
      expected.port = '';
      normalized.port = '';
      return expected.href === normalized.href;
    }
    return false;
  });
}
function scopes(value: unknown = MCP_SCOPES.join(' ')) {
  if (typeof value !== 'string' || value.length > 100)
    throw error('Invalid scope.', 'invalid_scope');
  const requested = [...new Set(value.split(' ').filter(Boolean))];
  if (
    !requested.length ||
    requested.some((s) => !MCP_SCOPES.includes(s)) ||
    !requested.includes('focus:read')
  )
    throw error(
      'Request focus:read, optionally with focus:write.',
      'invalid_scope',
    );
  return requested.sort().join(' ');
}
export async function registerMcpClient(input: OAuthInput) {
  await rateLimit('registration', 30);
  if (
    !Array.isArray(input.redirect_uris) ||
    input.redirect_uris.length < 1 ||
    input.redirect_uris.length > 5
  )
    throw error('Supply one to five redirect URIs.');
  const redirects: string[] = input.redirect_uris.map(
    (value: unknown) => redirectUrl(value).href,
  );
  if (
    input.token_endpoint_auth_method &&
    input.token_endpoint_auth_method !== 'none'
  )
    throw error(
      'This server uses public clients with PKCE.',
      'invalid_client_metadata',
    );
  for (const [field, allowed] of [
    ['grant_types', ['authorization_code', 'refresh_token']],
    ['response_types', ['code']],
  ] as [string, string[]][])
    if (
      input[field] !== undefined &&
      (!Array.isArray(input[field]) ||
        !input[field].length ||
        input[field].length > allowed.length ||
        input[field].some((value: string) => !allowed.includes(value)))
    )
      throw error(
        'Unsupported grant or response type.',
        'invalid_client_metadata',
      );
  const name =
      String(input.client_name || 'MCP client')
        .trim()
        .slice(0, 100) || 'MCP client',
    id = uid();
  await transaction(async () => {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('focus-mcp-registration'))`,
    );
    await db.delete(mcp_clients).where(
      and(
        lt(mcp_clients.created_at, sql`now() - interval '1 day'`),
        notExists(
          db
            .select({ one: sql`1` })
            .from(mcp_grants)
            .where(eq(mcp_grants.client_id, mcp_clients.id)),
        ),
      ),
    );
    await db
      .delete(mcp_rate_limits)
      .where(lt(mcp_rate_limits.expires_at, sql`now()`));
    if ((await db.$count(mcp_clients)) >= 1000)
      throw error(
        'Client registration limit reached.',
        'temporarily_unavailable',
        429,
      );
    await db.insert(mcp_clients).values({ id, name, redirect_uris: redirects });
  });
  return {
    client_id: id,
    client_name: name,
    redirect_uris: redirects,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}
export async function validateAuthorization(input: OAuthInput) {
  if (typeof input.client_id !== 'string' || input.client_id.length > 200)
    throw error('Unknown client.', 'invalid_client');
  const [client] = await db
    .select()
    .from(mcp_clients)
    .where(eq(mcp_clients.id, input.client_id));
  if (!client) throw error('Unknown client.', 'invalid_client');
  if (!redirectMatches(client.redirect_uris as string[], input.redirect_uri))
    throw error('Redirect URI does not match this client.');
  if (
    input.response_type !== 'code' ||
    input.code_challenge_method !== 'S256' ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge || '')
  )
    throw error('Authorization requires code and PKCE S256.');
  if (input.resource !== MCP_URL)
    throw error('Request the Focus MCP resource.', 'invalid_target');
  if (
    typeof input.state !== 'string' ||
    input.state.length < 1 ||
    input.state.length > 2048
  )
    throw error('A client state value is required.');
  return {
    client,
    request: {
      client_id: client.id,
      redirect_uri: redirectUrl(input.redirect_uri).href,
      response_type: 'code',
      resource: MCP_URL,
      scope: scopes(input.scope),
      state: input.state,
      code_challenge: input.code_challenge,
      code_challenge_method: 'S256',
    },
  };
}
export async function authorizeMcp(
  input: OAuthInput,
  user: OAuthUser,
  allow = true,
) {
  if (!user || user.email !== allowedEmail())
    throw error('Sign in to Focus first.', 'access_denied', 401);
  const { client, request } = await validateAuthorization(input);
  const redirect = new URL(request.redirect_uri);
  redirect.searchParams.set('state', request.state);
  redirect.searchParams.set('iss', APP_ORIGIN);
  if (!allow) {
    redirect.searchParams.set('error', 'access_denied');
    return { redirect: redirect.href };
  }
  const code = randomToken(),
    id = uid();
  await transaction(async () => {
    await db.insert(mcp_grants).values({
      id,
      client_id: client.id,
      owner_sub: user.sub,
      owner_email: user.email,
      scope: request.scope,
      resource: MCP_URL,
      expires_at: sql`now() + interval '90 days'`,
    });
    await db.insert(mcp_codes).values({
      token_hash: tokenHash(code),
      grant_id: id,
      redirect_uri: request.redirect_uri,
      challenge: request.code_challenge,
      expires_at: sql`now() + interval '5 minutes'`,
    });
  });
  redirect.searchParams.set('code', code);
  return { redirect: redirect.href };
}
async function liveGrant(id: string, clientId: string) {
  const [grant] = await db
    .select(getColumns(mcp_grants))
    .from(mcp_grants)
    .innerJoin(
      owner,
      and(
        eq(owner.sub, mcp_grants.owner_sub),
        eq(owner.email, mcp_grants.owner_email),
      ),
    )
    .where(
      and(
        eq(mcp_grants.id, id),
        eq(mcp_grants.client_id, clientId),
        eq(mcp_grants.resource, MCP_URL),
        eq(mcp_grants.owner_email, allowedEmail()),
        isNull(mcp_grants.revoked_at),
        gt(mcp_grants.expires_at, sql`now()`),
      ),
    )
    .for('update', { of: mcp_grants });
  return grant;
}
async function issueTokens(
  grant: { id: string; scope: string; expires_at: string },
  scope = grant.scope,
) {
  const access = randomToken(),
    refresh = randomToken();
  await db.insert(mcp_tokens).values([
    {
      token_hash: tokenHash(access),
      grant_id: grant.id,
      kind: 'access',
      expires_at: sql`now() + interval '1 hour'`,
    },
    {
      token_hash: tokenHash(refresh),
      grant_id: grant.id,
      kind: 'refresh',
      expires_at: grant.expires_at,
    },
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refresh,
    scope,
  };
}
export async function exchangeMcpToken(input: OAuthInput) {
  await rateLimit('tokens', 120);
  if (input.resource !== MCP_URL)
    throw error('Request the Focus MCP resource.', 'invalid_target');
  if (typeof input.client_id !== 'string' || input.client_id.length > 200)
    throw error('Unknown client.', 'invalid_client');
  const result = await transaction(async () => {
    if (input.grant_type === 'authorization_code') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.code || ''))
        throw error(
          'Authorization code is invalid or expired.',
          'invalid_grant',
        );
      const [code] = await db
        .select()
        .from(mcp_codes)
        .where(
          and(
            eq(mcp_codes.token_hash, tokenHash(input.code)),
            gt(mcp_codes.expires_at, sql`now()`),
          ),
        )
        .for('update');
      const grant = code && (await liveGrant(code.grant_id, input.client_id));
      if (
        !code ||
        !grant ||
        code.redirect_uri !== input.redirect_uri ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier || '') ||
        !equal(
          code.challenge,
          createHash('sha256').update(input.code_verifier).digest('base64url'),
        )
      )
        throw error(
          'Authorization code or PKCE verifier is invalid.',
          'invalid_grant',
        );
      await db
        .delete(mcp_codes)
        .where(eq(mcp_codes.token_hash, tokenHash(input.code)));
      return issueTokens(grant);
    }
    if (input.grant_type === 'refresh_token') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.refresh_token || ''))
        throw error('Refresh token is invalid.', 'invalid_grant');
      const [token] = await db
        .select()
        .from(mcp_tokens)
        .where(
          and(
            eq(mcp_tokens.token_hash, tokenHash(input.refresh_token)),
            eq(mcp_tokens.kind, 'refresh'),
          ),
        )
        .for('update');
      const grant = token && (await liveGrant(token.grant_id, input.client_id));
      if (!token || !grant || token.expires_at <= new Date().toISOString())
        throw error('Refresh token is invalid or expired.', 'invalid_grant');
      if (token.used_at) {
        await db
          .update(mcp_grants)
          .set({ revoked_at: sql`now()` })
          .where(eq(mcp_grants.id, grant.id));
        return { replay: true };
      }
      if (input.scope && scopes(input.scope) !== grant.scope)
        throw error(
          'Refresh must preserve the granted scope.',
          'invalid_scope',
        );
      await db
        .update(mcp_tokens)
        .set({ used_at: sql`now()` })
        .where(eq(mcp_tokens.token_hash, tokenHash(input.refresh_token)));
      return issueTokens(grant);
    }
    throw error(
      'Use authorization_code or refresh_token.',
      'unsupported_grant_type',
    );
  });
  if ('replay' in result)
    throw error(
      'Refresh token was already used. Reconnect Focus.',
      'invalid_grant',
    );
  return result;
}
export async function requireMcpAccess(req: Request) {
  checkMcpOrigin(req);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
    req.headers.get('authorization') || '',
  );
  if (!match) throw error('Connect Focus with OAuth.', 'invalid_token', 401);
  const [grant] = await db
    .select({ ...getColumns(mcp_grants), client_name: mcp_clients.name })
    .from(mcp_tokens)
    .innerJoin(mcp_grants, eq(mcp_grants.id, mcp_tokens.grant_id))
    .innerJoin(mcp_clients, eq(mcp_clients.id, mcp_grants.client_id))
    .innerJoin(
      owner,
      and(
        eq(owner.sub, mcp_grants.owner_sub),
        eq(owner.email, mcp_grants.owner_email),
      ),
    )
    .where(
      and(
        eq(mcp_tokens.token_hash, tokenHash(match[1]!)),
        eq(mcp_tokens.kind, 'access'),
        gt(mcp_tokens.expires_at, sql`now()`),
        gt(mcp_grants.expires_at, sql`now()`),
        isNull(mcp_grants.revoked_at),
        eq(mcp_grants.resource, MCP_URL),
        eq(mcp_grants.owner_email, allowedEmail()),
      ),
    );
  if (!grant)
    throw error('Focus access expired or was revoked.', 'invalid_token', 401);
  await rateLimit('mcp:' + grant.id, 180);
  await db
    .update(mcp_grants)
    .set({ last_used_at: sql`now()` })
    .where(
      and(
        eq(mcp_grants.id, grant.id),
        or(
          isNull(mcp_grants.last_used_at),
          lt(mcp_grants.last_used_at, sql`now() - interval '1 minute'`),
        ),
      ),
    );
  return grant;
}
export async function revokeMcpToken(input: OAuthInput) {
  if (typeof input.token !== 'string' || input.token.length > 200) return {};
  await db
    .update(mcp_grants)
    .set({ revoked_at: sql`now()` })
    .where(
      and(
        eq(mcp_grants.client_id, String(input.client_id || '')),
        inArray(
          mcp_grants.id,
          db
            .select({ grant_id: mcp_tokens.grant_id })
            .from(mcp_tokens)
            .where(eq(mcp_tokens.token_hash, tokenHash(input.token))),
        ),
      ),
    );
  return {};
}
export async function mcpAccessSettings() {
  return {
    url: MCP_URL,
    grants: await db
      .select({
        id: mcp_grants.id,
        client_name: mcp_clients.name,
        scope: mcp_grants.scope,
        created_at: mcp_grants.created_at,
        expires_at: mcp_grants.expires_at,
        last_used_at: mcp_grants.last_used_at,
        revoked_at: mcp_grants.revoked_at,
        expired: sql<boolean>`${mcp_grants.expires_at} <= now()`,
      })
      .from(mcp_grants)
      .innerJoin(mcp_clients, eq(mcp_clients.id, mcp_grants.client_id))
      .where(eq(mcp_grants.owner_email, allowedEmail()))
      .orderBy(desc(mcp_grants.created_at))
      .limit(50),
    activity: await db
      .select({
        tool: mcp_operations.tool,
        created_at: mcp_operations.created_at,
        client_name: mcp_clients.name,
      })
      .from(mcp_operations)
      .innerJoin(mcp_grants, eq(mcp_grants.id, mcp_operations.grant_id))
      .innerJoin(mcp_clients, eq(mcp_clients.id, mcp_grants.client_id))
      .where(eq(mcp_grants.owner_email, allowedEmail()))
      .orderBy(desc(mcp_operations.created_at))
      .limit(20),
  };
}
export async function revokeMcpGrant(id: string) {
  await db
    .update(mcp_grants)
    .set({ revoked_at: sql`now()` })
    .where(
      and(eq(mcp_grants.id, id), eq(mcp_grants.owner_email, allowedEmail())),
    );
  return { revoked: true };
}

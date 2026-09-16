import { test, expect } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

test('Codex OAuth approval enables real MCP actions and settings can revoke access', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const resource = baseURL + '/mcp',
    clientName = 'Fictional Codex ' + testInfo.project.name;
  const unauthenticated = await request.post('/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  });
  expect(unauthenticated.status()).toBe(401);
  const metadata = await (
    await request.get('/.well-known/oauth-protected-resource/mcp')
  ).json();
  expect(metadata.resource).toBe(resource);
  const issuer = await (
    await request.get('/.well-known/oauth-authorization-server')
  ).json();
  expect(issuer.issuer).toBe(baseURL);
  const registration = await request.post('/api/mcp/register', {
    data: {
      client_name: clientName,
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registration.status()).toBe(201);
  const registered = await registration.json();
  const verifier = randomBytes(48).toString('base64url'),
    redirectUri = 'http://127.0.0.1:54987/callback';
  const params = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    resource,
    scope: 'focus:read focus:write',
    state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  await page.route(redirectUri + '**', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: 'Fictional client received authorization.',
    }),
  );
  await page.goto('/mcp/authorize?' + params);
  await expect(
    page.getByRole('heading', { name: 'Connect ' + clientName + ' to Focus' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('mcp-consent.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Allow read and write access', exact: true })
    .click();
  await page.waitForURL(redirectUri + '**');
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(params.get('state'));
  expect(callback.searchParams.get('iss')).toBe(baseURL);
  const exchanged = await request.post('/api/mcp/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: registered.client_id,
      redirect_uri: redirectUri,
      resource,
      code: callback.searchParams.get('code')!,
      code_verifier: verifier,
    },
  });
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json();
  const client = new Client({ name: clientName, version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    },
  });
  await client.connect(transport);
  try {
    expect((await client.listTools()).tools.length).toBeGreaterThanOrEqual(50);
    const title = 'MCP created commitment ' + testInfo.project.name;
    const action = {
      name: 'focus_save_commitment',
      arguments: {
        idempotency_key: randomUUID(),
        commitment: { title, owner: 'Alex' },
      },
    };
    const created: any = await client.callTool(action);
    expect(created.isError).not.toBe(true);
    const retried: any = await client.callTool(action);
    expect(retried.structuredContent.data.id).toBe(
      created.structuredContent.data.id,
    );
    await page.goto('/#board');
    await page.getByRole('tab', { name: /^To decide/ }).click();
    await expect(
      page.getByRole('button', { name: title, exact: true }),
    ).toBeVisible();
    await page.goto('/#settings');
    await expect(
      page.getByRole('heading', { name: 'Connect Codex', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Focus MCP server URL')).toHaveValue(resource);
    await expect(
      page.getByText(clientName + ' · save commitment', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('mcp-settings.png'),
      fullPage: true,
    });
    const grantRow = page
      .getByText(clientName, { exact: true })
      .locator('../..');
    await grantRow
      .getByRole('button', { name: 'Revoke access', exact: true })
      .click();
    await expect(grantRow.getByText('Revoked', { exact: true })).toBeVisible();
    const rejected = await request.post('/mcp', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(rejected.status()).toBe(401);
  } finally {
    await client.close();
  }
  expect(errors).toEqual([]);
});

test('an invalid authorization redirect stays on Focus and signed-out users must sign in', async ({
  page,
  context,
  request,
}) => {
  const registered = await (
    await request.post('/api/mcp/register', {
      data: {
        client_name: 'Fictional signed-out client',
        redirect_uris: ['http://127.0.0.1/callback'],
      },
    })
  ).json();
  const baseURL = new URL(
    page.url() === 'about:blank' ? 'http://127.0.0.1:3210' : page.url(),
  ).origin;
  const params = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: 'https://attacker.example/callback',
    response_type: 'code',
    resource: baseURL + '/mcp',
    scope: 'focus:read',
    state: 'fixture-state',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
  });
  await page.goto('/mcp/authorize?' + params);
  await expect(
    page.getByRole('heading', { name: 'Connection request is invalid' }),
  ).toBeVisible();
  await context.clearCookies();
  params.set('redirect_uri', 'http://127.0.0.1/callback');
  await page.goto('/mcp/authorize?' + params);
  await expect(
    page.getByRole('link', { name: 'Sign in to Focus', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Allow/ })).toHaveCount(0);
});

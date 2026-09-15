import { cookies } from 'next/headers';
import { sessionFor, SESSION_COOKIE } from '../../../lib/auth.mjs';
import { validateAuthorization } from '../../../lib/mcp-auth.mjs';
import McpConsent from './screen';
export const dynamic = 'force-dynamic';
export default async function Authorize({ searchParams }) {
  let props;
  try {
    const { client, request } = await validateAuthorization(await searchParams);
    const jar = await cookies(),
      user = await sessionFor(jar.get(SESSION_COOKIE)?.value);
    props = { clientName: client.name, request, signedIn: !!user };
  } catch {
    props = null;
  }
  if (!props)
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-semibold">
          Connection request is invalid
        </h1>
        <p className="mt-4">
          Return to Codex and start connecting Focus again.
        </p>
      </main>
    );
  return <McpConsent {...props} />;
}

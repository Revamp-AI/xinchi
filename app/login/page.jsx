import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionFor, SESSION_COOKIE, allowedEmail } from '../../lib/auth.mjs';
import { googleClient } from '../../lib/connectors.mjs';
import { APP_ORIGIN, HOSTED, POSTGRES_SECRETS } from '../../lib/runtime.mjs';
import Login from './screen';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  const jar = await cookies();
  if (await sessionFor(jar.get(SESSION_COOKIE)?.value)) redirect('/');
  return (
    <Login
      configured={!!googleClient()}
      ownerConfigured={!!allowedEmail()}
      callback={APP_ORIGIN + '/api/auth/google/callback'}
      hosted={HOSTED || POSTGRES_SECRETS}
    />
  );
}

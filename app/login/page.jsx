import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionFor, SESSION_COOKIE, allowedEmail } from '../../lib/auth.mjs';
import { googleClient } from '../../lib/connectors.mjs';
import Login from './screen';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  const jar = await cookies();
  if (await sessionFor(jar.get(SESSION_COOKIE)?.value)) redirect('/');
  return (
    <Login configured={!!googleClient()} ownerConfigured={!!allowedEmail()} />
  );
}

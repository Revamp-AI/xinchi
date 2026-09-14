import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionFor, SESSION_COOKIE } from '../lib/auth.mjs';
import Workspace from './workspace';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const jar = await cookies();
  if (!sessionFor(jar.get(SESSION_COOKIE)?.value)) redirect('/login');
  return <Workspace />;
}

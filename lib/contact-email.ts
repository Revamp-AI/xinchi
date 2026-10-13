import addresses from 'email-addresses';
import { and, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from './postgres.ts';
import { contact_identities, contacts } from './schema/index.ts';

export function emailAddress(input: unknown) {
  const parsed = addresses.parseOneAddress(String(input || '').trim());
  return parsed?.type === 'mailbox' ? parsed.address.toLowerCase() : '';
}
// Exact mailbox matching only: dots and +tags are meaningful and stay intact.
const shared =
  /^(no-?reply|do-?not-?reply|notifications?|support|info|hello|team|billing|newsletter|sales|admin|contact|help|office|accounts?|calendar)([.+_-]|@)/i;
export function personalEmail(input: unknown) {
  const email = emailAddress(input);
  return email && !shared.test(email) ? email : '';
}
export async function exactEmailContacts(input: unknown) {
  const email = personalEmail(input);
  if (!email) return [];
  const byEmail = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNull(contacts.merged_into),
        ne(contacts.email, ''),
        sql`lower(btrim(${contacts.email})) = ${email}`,
      ),
    )
    .union(
      db
        .select({ id: contact_identities.contact_id })
        .from(contact_identities)
        .where(
          and(
            ne(contact_identities.address, ''),
            sql`lower(btrim(${contact_identities.address})) = ${email}`,
          ),
        ),
    );
  return db
    .select()
    .from(contacts)
    .where(and(isNull(contacts.merged_into), inArray(contacts.id, byEmail)))
    .orderBy(contacts.created_at, contacts.id);
}
export function combinedNotes(...values: unknown[]) {
  return [
    ...new Set(values.map((v) => String(v || '').trim()).filter(Boolean)),
  ].join('\n\n');
}

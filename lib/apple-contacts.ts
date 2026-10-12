import { and, eq, getColumns, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, transaction, lockWorkspace } from './postgres.ts';
import { hash, uid, stamp } from './db.mjs';
import { emailAddress, personalEmail } from './contact-email.mjs';
import { linkedinProfileUrl } from './linkedin-import.mjs';
import { evaluateContacts as evaluate } from './contacts.mjs';
import {
  affiliations,
  contact_identities,
  contacts as contactsTable,
  identity_reviews,
  organizations,
  source_versions,
  sources,
} from './schema/index.ts';

// contacts.mjs is untyped JavaScript; TypeScript reads its `ids = null`
// default as the type `null`.
const evaluateContacts = evaluate as unknown as (
  ids: string[],
) => Promise<void>;
// Binds rows as one jsonb parameter and reads them back as the record x.
const recordset = (rows: object[], columns: string) =>
  sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(${sql.raw(columns)})`;
// A column of the recordset x, aliased so Drizzle accepts it in an insert.
const field = (column: string) => sql.raw('x.' + column).as(column);
type AppleContact = {
  key: string;
  name: string;
  company: string;
  role: string;
  emails: string[];
  phones: string[];
  urls: string[];
};
// The fields matching reads from contacts and contact_identities rows.
type Contact = {
  id: string;
  name: string;
  email: string;
  role: string;
  confirmed: boolean;
  archived: boolean;
};
type Identity = {
  contact_id: string;
  provider: string;
  account: string;
  external_key: string;
  address: string;
};

export function internationalPhone(value: unknown) {
  const raw = String(value || '').trim();
  if (!/^\+[\d\s().-]+$/.test(raw)) return '';
  const digits = raw.replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? '+' + digits : '';
}
const nameKey = (value: unknown) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
export function normalizeAppleContacts(input: unknown) {
  if (!Array.isArray(input) || input.length > 10000)
    throw Error('Import at most 10,000 Apple contact cards.');
  const rows = new Map<string, AppleContact>();
  for (const value of input) {
    if (
      !value ||
      typeof value.key !== 'string' ||
      !value.key ||
      value.key.length > 300
    )
      throw Error('Apple contact identifier is missing or invalid.');
    const list = (key: string): string[] => {
      if (
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          value[key].some(
            (v: unknown) => typeof v !== 'string' || v.length > 1000,
          ))
      )
        throw Error('Invalid Apple contact fields.');
      return [...new Set<string>(value[key] || [])];
    };
    const emails = list('emails').map(emailAddress).filter(Boolean),
      phones = list('phones'),
      urls = list('urls').filter((v) => {
        try {
          return ['http:', 'https:'].includes(new URL(v).protocol);
        } catch {
          return false;
        }
      });
    const record: AppleContact = {
      key: value.key,
      name:
        String(value.name || '')
          .trim()
          .slice(0, 200) ||
        emails[0] ||
        phones[0] ||
        '',
      company: String(value.company || '')
        .trim()
        .slice(0, 200),
      role: String(value.role || '')
        .trim()
        .slice(0, 200),
      emails,
      phones,
      urls,
    };
    if (!record.name) continue;
    if (rows.has(record.key) && hash(rows.get(record.key)) !== hash(record))
      throw Error('Apple archive contains conflicting versions of a contact.');
    rows.set(record.key, record);
  }
  return [...rows.values()];
}
export async function importAppleContacts(
  input: unknown,
  { apply = false } = {},
) {
  const records = normalizeAppleContacts(input),
    summary = {
      total: records.length,
      added: 0,
      matched: 0,
      unchanged: 0,
      conflicts: 0,
      skipped_owner: 0,
    };
  if (records.length > 50)
    throw Error('Import at most 50 Apple contact cards per batch.');
  return transaction(async () => {
    if (apply) await lockWorkspace();
    else
      await db.execute(
        sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
      );
    const contacts: Contact[] = await db
        .select()
        .from(contactsTable)
        .where(isNull(contactsTable.merged_into)),
      identities: Identity[] = await db
        .select(getColumns(contact_identities))
        .from(contact_identities)
        .innerJoin(
          contactsTable,
          eq(contactsTable.id, contact_identities.contact_id),
        )
        .where(isNull(contactsTable.merged_into));
    const sourceIds = records.map((r) => 'manual:apple-contact-' + hash(r.key));
    const previous = new Map(
      (
        await db
          .select({
            id: sources.id,
            hash: sql<
              string | null
            >`${source_versions.raw_json}::jsonb->>'apple_contact_hash'`,
          })
          .from(sources)
          .innerJoin(
            source_versions,
            and(
              eq(source_versions.source_id, sources.id),
              eq(source_versions.content_hash, sources.content_hash),
            ),
          )
          .where(sql`${sources.id} = ANY(${sql.param(sourceIds)}::text[])`)
      ).map((r) => [r.id, r.hash]),
    );
    const owner = String(process.env.XIN_ALLOWED_EMAIL || '').toLowerCase(),
      byId = new Map(contacts.map((c) => [c.id, c])),
      added = new Map<string, Contact>(),
      updated = new Map<string, Contact>(),
      changed = [],
      bindings = [],
      reviews = new Map();
    const addReview = (a: string, b: string, reason: string) => {
      if (a === b) return;
      const [left_id, right_id] = [a, b].sort();
      reviews.set(left_id + ':' + right_id, {
        id: uid(),
        left_id,
        right_id,
        reason,
      });
    };
    for (const r of records) {
      if (owner && r.emails.includes(owner)) {
        summary.skipped_owner++;
        continue;
      }
      const bound = identities.find(
          (i) =>
            i.provider === 'apple' &&
            i.account === 'archive' &&
            i.external_key === r.key,
        ),
        found = new Set(bound ? [bound.contact_id] : []);
      const external = 'apple-contact-' + hash(r.key),
        sourceId = 'manual:' + external,
        content = hash(r);
      // A stable, unchanged card already belongs to its chosen profile. Avoid
      // rescanning the entire address book or rematching it on every reimport.
      if (bound && previous.get(sourceId) === content) {
        summary.unchanged++;
        continue;
      }
      const emails = r.emails.map(personalEmail).filter(Boolean),
        urls = r.urls.map(linkedinProfileUrl).filter(Boolean),
        phones = r.phones.map(internationalPhone).filter(Boolean);
      for (const c of contacts) {
        const ids = identities.filter((i) => i.contact_id === c.id);
        if (
          emails.includes(personalEmail(c.email)) ||
          ids.some(
            (i) =>
              emails.includes(personalEmail(i.address)) ||
              (i.provider === 'linkedin' &&
                urls.includes(linkedinProfileUrl(i.external_key))),
          )
        )
          found.add(c.id);
        if (
          !c.archived &&
          (nameKey(c.name) === nameKey(r.name) ||
            (!c.confirmed && internationalPhone(c.name))) &&
          [c.name, ...ids.map((i) => i.address)].some((v) =>
            phones.includes(internationalPhone(v)),
          )
        )
          found.add(c.id);
      }
      if (found.size > 1) {
        summary.conflicts++;
        const ids = [...found];
        for (let i = 0; i < ids.length; i++)
          for (let j = i + 1; j < ids.length; j++)
            addReview(
              ids[i]!,
              ids[j]!,
              'Apple contact identifiers point to different profiles; verify the card before merging.',
            );
        continue;
      }
      const id = [...found][0],
        existing = id === undefined ? undefined : byId.get(id);
      let c: Contact;
      if (existing) {
        summary.matched++;
        c = {
          ...existing,
          name:
            !existing.confirmed && internationalPhone(existing.name)
              ? r.name
              : existing.name,
          email: existing.email || emails[0] || '',
          role: existing.role || r.role,
        };
        if (added.has(c.id)) added.set(c.id, c);
        else if (
          (['name', 'email', 'role'] as const).some((k) => c[k] !== existing[k])
        )
          updated.set(c.id, c);
      } else {
        summary.added++;
        c = {
          id: uid(),
          name: r.name,
          email: emails[0] || '',
          role: r.role,
          confirmed: false,
          archived: false,
        };
        added.set(c.id, c);
        for (const other of contacts)
          if (!other.archived && nameKey(other.name) === nameKey(c.name))
            addReview(
              c.id,
              other.id,
              'Same name as an Apple contact; verify the contact details before merging.',
            );
      }
      byId.set(c.id, c);
      const index = contacts.findIndex((x) => x.id === c.id);
      if (index >= 0) contacts[index] = c;
      else contacts.push(c);
      const fields = [
        { key: r.key, address: r.emails[0] || '' },
        ...r.emails.map((email) => ({
          key: r.key + ':email:' + hash(email),
          address: email,
        })),
        ...r.phones.map((phone) => ({
          key: r.key + ':phone:' + hash(phone),
          address: internationalPhone(phone) || phone,
        })),
      ];
      for (const field of fields) {
        const row = {
          id: uid(),
          contact_id: c.id,
          provider: 'apple',
          account: 'archive',
          external_key: field.key,
          display_name: r.name,
          address: field.address,
          source_id: sourceId,
        };
        bindings.push(row);
        const i = identities.findIndex(
          (v) =>
            v.provider === 'apple' &&
            v.account === 'archive' &&
            v.external_key === field.key,
        );
        if (i >= 0) identities[i] = row;
        else identities.push(row);
      }
      changed.push({
        record: r,
        external,
        sourceId,
        contact_id: c.id,
        content,
      });
    }
    if (!apply) return summary;
    const profileColumns = 'id text,name text,email text,role text';
    if (added.size)
      await db.insert(contactsTable).select(
        db
          .select({
            id: field('id'),
            name: field('name'),
            email: field('email'),
            role: field('role'),
            confirmed: sql`false`.as('confirmed'),
          })
          .from(recordset([...added.values()], profileColumns)),
      );
    if (updated.size)
      await db
        .update(contactsTable)
        .set({
          name: sql`x.name`,
          email: sql`x.email`,
          role: sql`x.role`,
          version: sql`${contactsTable.version} + 1`,
          updated_at: sql`now()`,
        })
        .from(recordset([...updated.values()], profileColumns))
        .where(sql`${contactsTable.id} = x.id`);
    if (changed.length) {
      const time = stamp(),
        docs = changed.map(
          ({ record: r, external, sourceId, contact_id, content }) => {
            const values = {
              title: 'Apple contact: ' + r.name,
              body: [
                r.name,
                r.role,
                r.company,
                ...r.emails,
                ...r.phones,
                ...r.urls,
                'Imported address-book details; not evidence of a conversation.',
              ]
                .filter(Boolean)
                .join('\n'),
              coverage: 'document',
            };
            const raw = {
              origin: 'Apple Contacts archive',
              apple_contact: r,
              apple_contact_hash: content,
              contact_profile: contact_id,
            };
            return {
              id: sourceId,
              external_id: external,
              ...values,
              content_hash: hash({ values, raw }),
              raw_json: JSON.stringify(raw),
              version_id: uid(),
              time,
            };
          },
        );
      await db
        .insert(sources)
        .select(
          db
            .select({
              id: field('id'),
              provider: sql`'manual'`.as('provider'),
              external_id: field('external_id'),
              title: field('title'),
              body: field('body'),
              coverage: field('coverage'),
              content_hash: field('content_hash'),
              imported_at: field('time'),
              updated_at: field('time'),
            })
            .from(
              recordset(
                docs,
                'id text,external_id text,title text,body text,coverage text,content_hash text,time text',
              ),
            ),
        )
        .onConflictDoUpdate({
          target: sources.id,
          set: {
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            content_hash: sql`excluded.content_hash`,
            updated_at: sql`excluded.updated_at`,
          },
        });
      await db
        .insert(source_versions)
        .select(
          db
            .select({
              id: field('version_id'),
              source_id: field('id'),
              content_hash: field('content_hash'),
              raw_json: field('raw_json'),
              fetched_at: field('time'),
              normalized_body: field('body'),
            })
            .from(
              recordset(
                docs,
                'version_id text,id text,content_hash text,raw_json text,time text,body text',
              ),
            ),
        )
        .onConflictDoNothing({
          target: [source_versions.source_id, source_versions.content_hash],
        });
      await db
        .insert(contact_identities)
        .select(
          db
            .select({
              id: field('id'),
              contact_id: field('contact_id'),
              provider: sql`'apple'`.as('provider'),
              account: sql`'archive'`.as('account'),
              external_key: field('external_key'),
              display_name: field('display_name'),
              address: field('address'),
              source_id: field('source_id'),
            })
            .from(
              recordset(
                bindings,
                'id text,contact_id text,external_key text,display_name text,address text,source_id text',
              ),
            ),
        )
        .onConflictDoUpdate({
          target: [
            contact_identities.provider,
            contact_identities.account,
            contact_identities.external_key,
          ],
          set: {
            display_name: sql`excluded.display_name`,
            address: sql`excluded.address`,
            source_id: sql`excluded.source_id`,
          },
        });
      const orgs = [
        ...new Map(
          changed
            .filter((c) => c.record.company)
            .map((c) => [
              c.record.company.toLowerCase(),
              { id: uid(), name: c.record.company },
            ]),
        ).values(),
      ];
      if (orgs.length) {
        // Drizzle conflict targets are columns; organizations are unique by lower(name).
        await db.execute(
          sql`INSERT INTO ${organizations} (id, name) SELECT id, name FROM ${recordset(orgs, 'id text,name text')} ON CONFLICT (lower(name)) DO NOTHING`,
        );
        const rows = [
          ...new Map(
            changed
              .filter((c) => c.record.company)
              .map((c) => [
                JSON.stringify([
                  c.contact_id,
                  c.record.company.toLowerCase(),
                  c.record.role,
                ]),
                {
                  id: uid(),
                  contact_id: c.contact_id,
                  company: c.record.company,
                  role: c.record.role,
                },
              ]),
          ).values(),
        ];
        const a = alias(affiliations, 'a');
        await db.insert(affiliations).select(
          db
            .select({
              id: field('id'),
              contact_id: field('contact_id'),
              organization_id: organizations.id,
              role: field('role'),
            })
            .from(
              recordset(rows, 'id text,contact_id text,company text,role text'),
            )
            .innerJoin(
              organizations,
              sql`lower(${organizations.name}) = lower(x.company)`,
            )
            .where(
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(a)
                  .where(
                    and(
                      sql`${a.contact_id} = x.contact_id`,
                      eq(a.organization_id, organizations.id),
                      sql`${a.role} = x.role`,
                    ),
                  ),
              ),
            ),
        );
      }
      await evaluateContacts([...new Set(changed.map((c) => c.contact_id))]);
    }
    if (reviews.size)
      await db
        .insert(identity_reviews)
        .select(
          db
            .select({
              id: field('id'),
              left_id: field('left_id'),
              right_id: field('right_id'),
              reason: field('reason'),
            })
            .from(
              recordset(
                [...reviews.values()],
                'id text,left_id text,right_id text,reason text',
              ),
            ),
        )
        .onConflictDoNothing({
          target: [identity_reviews.left_id, identity_reviews.right_id],
        });
    return summary;
  });
}

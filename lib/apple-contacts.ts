import { and, eq, getColumns, isNull, sql } from 'drizzle-orm';
import { db, run, transaction, lockWorkspace } from './postgres.ts';
import { hash, uid, stamp } from './db.mjs';
import { emailAddress, personalEmail } from './contact-email.mjs';
import { linkedinProfileUrl } from './linkedin-import.mjs';
import { evaluateContacts as evaluate } from './contacts.mjs';
import {
  contact_identities,
  contacts as contactsTable,
  source_versions,
  sources,
} from './schema/index.ts';

// contacts.mjs is untyped JavaScript; TypeScript reads its `ids = null`
// default as the type `null`.
const evaluateContacts = evaluate as unknown as (
  ids: string[],
) => Promise<void>;
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
    if (added.size)
      await run(
        'INSERT INTO contacts(id,name,email,role,confirmed) SELECT id,name,email,role,false FROM jsonb_to_recordset(?::jsonb) AS x(id text,name text,email text,role text)',
        JSON.stringify([...added.values()]),
      );
    if (updated.size)
      await run(
        'UPDATE contacts c SET name=x.name,email=x.email,role=x.role,version=c.version+1,updated_at=now() FROM jsonb_to_recordset(?::jsonb) AS x(id text,name text,email text,role text) WHERE c.id=x.id',
        JSON.stringify([...updated.values()]),
      );
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
      await run(
        "INSERT INTO sources(id,provider,external_id,title,body,coverage,content_hash,imported_at,updated_at) SELECT id,'manual',external_id,title,body,coverage,content_hash,time,time FROM jsonb_to_recordset(?::jsonb) AS x(id text,external_id text,title text,body text,coverage text,content_hash text,time text) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,content_hash=excluded.content_hash,updated_at=excluded.updated_at",
        JSON.stringify(docs),
      );
      await run(
        'INSERT INTO source_versions(id,source_id,content_hash,raw_json,fetched_at,normalized_body) SELECT version_id,id,content_hash,raw_json,time,body FROM jsonb_to_recordset(?::jsonb) AS x(version_id text,id text,content_hash text,raw_json text,time text,body text) ON CONFLICT(source_id,content_hash) DO NOTHING',
        JSON.stringify(docs),
      );
      await run(
        "INSERT INTO contact_identities(id,contact_id,provider,account,external_key,display_name,address,source_id) SELECT id,contact_id,'apple','archive',external_key,display_name,address,source_id FROM jsonb_to_recordset(?::jsonb) AS x(id text,contact_id text,external_key text,display_name text,address text,source_id text) ON CONFLICT(provider,account,external_key) DO UPDATE SET display_name=excluded.display_name,address=excluded.address,source_id=excluded.source_id",
        JSON.stringify(bindings),
      );
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
        await run(
          'INSERT INTO organizations(id,name) SELECT id,name FROM jsonb_to_recordset(?::jsonb) AS x(id text,name text) ON CONFLICT(lower(name)) DO NOTHING',
          JSON.stringify(orgs),
        );
        const affiliations = [
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
        await run(
          'INSERT INTO affiliations(id,contact_id,organization_id,role) SELECT x.id,x.contact_id,o.id,x.role FROM jsonb_to_recordset(?::jsonb) AS x(id text,contact_id text,company text,role text) JOIN organizations o ON lower(o.name)=lower(x.company) WHERE NOT EXISTS(SELECT 1 FROM affiliations a WHERE a.contact_id=x.contact_id AND a.organization_id=o.id AND a.role=x.role)',
          JSON.stringify(affiliations),
        );
      }
      await evaluateContacts([...new Set(changed.map((c) => c.contact_id))]);
    }
    if (reviews.size)
      await run(
        'INSERT INTO identity_reviews(id,left_id,right_id,reason) SELECT id,left_id,right_id,reason FROM jsonb_to_recordset(?::jsonb) AS x(id text,left_id text,right_id text,reason text) ON CONFLICT(left_id,right_id) DO NOTHING',
        JSON.stringify([...reviews.values()]),
      );
    return summary;
  });
}

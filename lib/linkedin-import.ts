import { parse } from 'csv-parse/sync';
import { and, eq, getColumns, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, transaction, lockWorkspace } from './postgres.ts';
import { uid, hash, stamp, dateOK } from './db.mjs';
import { emailAddress, personalEmail } from './contact-email.mjs';
import { evaluateContacts as evaluate } from './contacts.mjs';
import {
  affiliations,
  contact_identities,
  contacts as contactsTable,
  identity_reviews,
  organizations,
  source_versions,
  sources as sourcesTable,
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
export type LinkedinConnection = {
  name: string;
  email: string;
  profile_url: string;
  company: string;
  position: string;
  connected_on: string;
  raw: Record<string, string | undefined>;
  key: string;
};
// The fields planning reads from contacts and contact_identities rows.
type Contact = {
  id: string;
  name: string;
  email: string;
  role: string;
  archived: boolean;
};
type Identity = {
  contact_id: string;
  provider: string;
  external_key: string;
  display_name: string;
  address: string;
};

const headers = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
];
const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
export function linkedinProfileUrl(value: unknown) {
  try {
    const url = new URL(String(value).trim());
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !/(^|\.)linkedin\.com$/i.test(url.hostname)
    )
      return '';
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'in') return '';
    const slug = decodeURIComponent(parts[1]!).normalize('NFC').toLowerCase();
    if (!slug || /[\s/?#\\]/.test(slug)) return '';
    return 'https://www.linkedin.com/in/' + encodeURIComponent(slug);
  } catch {
    return '';
  }
}
function connectionDate(value: string | undefined) {
  if (!value) return '';
  if (dateOK(value)) return value;
  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(value);
  const month = match
    ? months.findIndex((m) => m.toLowerCase() === match[2]!.toLowerCase())
    : -1;
  const iso =
    match && month >= 0
      ? `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`
      : '';
  return dateOK(iso) ? iso : null;
}
export function parseLinkedinConnections(csv: unknown) {
  if (typeof csv !== 'string' || Buffer.byteLength(csv) > 5_000_000)
    throw Error('Choose a LinkedIn Connections.csv smaller than 5 MB.');
  let values: string[][];
  try {
    values = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch {
    throw Error(
      'Could not read LinkedIn Connections.csv. Check the CSV quoting.',
    );
  }
  const start = values.findIndex(
    (row, i) => i < 10 && headers.every((h) => row.includes(h)),
  );
  if (start < 0)
    throw Error(
      'Choose LinkedIn Connections.csv with First Name, Last Name, URL, Email Address, Company, Position and Connected On columns.',
    );
  const columns = values[start]!;
  if (values.length - start - 1 > 5000)
    throw Error('Import up to 5,000 LinkedIn connections at a time.');
  const records: LinkedinConnection[] = [],
    skipped: { row: number; reason: string }[] = [],
    seen = new Map<string, string>();
  for (const [offset, valuesRow] of values.slice(start + 1).entries()) {
    const row = offset + start + 2;
    if (valuesRow.length !== columns.length)
      throw Error('LinkedIn row ' + row + ' has the wrong number of columns.');
    const raw = Object.fromEntries(
      columns.map((key, i) => [key, valuesRow[i]]),
    );
    const name = [raw['First Name'], raw['Last Name']]
      .filter(Boolean)
      .join(' ')
      .trim();
    const email = emailAddress(raw['Email Address']),
      profile_url = linkedinProfileUrl(raw.URL);
    if (raw['Email Address'] && !email)
      throw Error('LinkedIn row ' + row + ' has an invalid email.');
    if (raw.URL && !profile_url)
      throw Error('LinkedIn row ' + row + ' has an invalid profile URL.');
    if (!name || (!profile_url && !personalEmail(email))) {
      skipped.push({ row, reason: 'No identifiable profile' });
      continue;
    }
    const connected_on = connectionDate(raw['Connected On']);
    if (connected_on === null)
      throw Error('LinkedIn row ' + row + ' has an invalid connection date.');
    const record: LinkedinConnection = {
      name: name.slice(0, 200),
      email,
      profile_url,
      company: raw.Company!.slice(0, 200),
      position: raw.Position!.slice(0, 200),
      connected_on,
      raw,
      key: profile_url || 'email:' + personalEmail(email),
    };
    const content = hash(record);
    if (seen.has(record.key)) {
      if (seen.get(record.key) !== content)
        throw Error(
          'LinkedIn export contains conflicting rows for the same profile.',
        );
      skipped.push({ row, reason: 'Duplicate export row' });
      continue;
    }
    seen.set(record.key, content);
    records.push(record);
  }
  return { total: values.length - start - 1, records, skipped };
}
const normalizedName = (value: unknown) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
function nameKey(value: unknown) {
  if (emailAddress(value)) return '';
  const name = normalizedName(value),
    parts = name.split(' ');
  // Name evidence only proposes a review, including reversed two-part names.
  return parts.length < 2
    ? ''
    : parts.length === 2
      ? parts.sort().join(' ')
      : name;
}
function indexAdd(index: Map<string, Set<string>>, key: string, id: string) {
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key)!.add(id);
}
function document(record: LinkedinConnection) {
  const external_id = 'linkedin-connection-' + hash(record.key),
    id = 'manual:' + external_id;
  const raw = {
    origin: 'LinkedIn Connections.csv export',
    linkedin_connection: record,
  };
  const values = {
    title: 'LinkedIn connection: ' + record.name,
    occurred_at: '',
    body: [
      record.name,
      record.position,
      record.company,
      record.email,
      record.profile_url,
      record.connected_on
        ? 'Connected on LinkedIn: ' + record.connected_on
        : '',
      'Profile data from an export; a connection is not evidence of a conversation.',
    ]
      .filter(Boolean)
      .join('\n'),
    url: record.profile_url,
    coverage: 'document',
  };
  return {
    id,
    external_id,
    ...values,
    content_hash: hash({ values, raw }),
    raw_json: JSON.stringify(raw),
  };
}
async function plan(records: LinkedinConnection[]) {
  const sourceIds = records.map((r) => document(r).id);
  const [contacts, identities, sources]: [
    Contact[],
    Identity[],
    { id: string; content_hash: string }[],
  ] = await Promise.all([
    db.select().from(contactsTable).where(isNull(contactsTable.merged_into)),
    db
      .select(getColumns(contact_identities))
      .from(contact_identities)
      .innerJoin(
        contactsTable,
        eq(contactsTable.id, contact_identities.contact_id),
      )
      .where(isNull(contactsTable.merged_into)),
    db
      .select({
        id: sourcesTable.id,
        content_hash: sourcesTable.content_hash,
      })
      .from(sourcesTable)
      .where(sql`${sourcesTable.id} = ANY(${sql.param(sourceIds)}::text[])`),
  ]);
  const byId = new Map(contacts.map((c) => [c.id, c])),
    byEmail = new Map<string, Set<string>>(),
    byName = new Map<string, Set<string>>(),
    byKey = new Map<string, Set<string>>(),
    sourceHashes = new Map(sources.map((s) => [s.id, s.content_hash]));
  for (const c of contacts) {
    indexAdd(byEmail, personalEmail(c.email), c.id);
    if (!c.archived) indexAdd(byName, nameKey(c.name), c.id);
  }
  for (const i of identities) {
    indexAdd(byEmail, personalEmail(i.address), i.contact_id);
    if (!byId.get(i.contact_id)!.archived)
      indexAdd(byName, nameKey(i.display_name), i.contact_id);
    if (i.provider === 'linkedin')
      indexAdd(
        byKey,
        linkedinProfileUrl(i.external_key) || i.external_key,
        i.contact_id,
      );
  }
  const changed: {
      record: LinkedinConnection;
      doc: ReturnType<typeof document>;
      contact_id: string;
    }[] = [],
    newContacts: Contact[] = [],
    updates = new Map<string, { id: string; email: string; role: string }>(),
    reviews = new Map<
      string,
      { id: string; left_id: string; right_id: string; reason: string }
    >(),
    summary = {
      added: 0,
      matched: 0,
      unchanged: 0,
      conflicts: 0,
      review_pairs: 0,
    };
  const addReview = (a: string, b: string, reason: string) => {
    if (a === b) return;
    const [left_id, right_id] = [a, b].sort() as [string, string];
    reviews.set(left_id + ':' + right_id, {
      id: uid(),
      left_id,
      right_id,
      reason,
    });
  };
  for (const record of records) {
    const ids = byKey.get(record.key) || new Set(),
      emailIds = byEmail.get(personalEmail(record.email)) || new Set();
    if (
      ids.size > 1 ||
      emailIds.size > 1 ||
      (ids.size === 1 &&
        emailIds.size === 1 &&
        [...ids][0] !== [...emailIds][0])
    ) {
      const conflicting = [...new Set([...ids, ...emailIds])];
      for (let i = 0; i < conflicting.length; i++)
        for (let j = i + 1; j < conflicting.length; j++)
          addReview(
            conflicting[i]!,
            conflicting[j]!,
            'LinkedIn profile and email bindings conflict; verify the exported profile before merging.',
          );
      summary.conflicts++;
      continue;
    }
    const found = [...ids][0] || [...emailIds][0],
      doc = document(record);
    if (found && sourceHashes.get(doc.id) === doc.content_hash) {
      summary.unchanged++;
      continue;
    }
    let contact = found ? byId.get(found) : null;
    if (contact) {
      summary.matched++;
      // Fill missing fields without replacing chosen names, notes or relationship preferences.
      const email = contact.email || personalEmail(record.email),
        role = contact.role || record.position;
      if (email !== contact.email || role !== contact.role) {
        contact = { ...contact, email, role };
        updates.set(contact.id, { id: contact.id, email, role });
        byId.set(contact.id, contact);
      }
    } else {
      contact = {
        id: uid(),
        name: record.name,
        email: personalEmail(record.email),
        role: record.position,
        archived: false,
      };
      newContacts.push(contact);
      byId.set(contact.id, contact);
      summary.added++;
    }
    indexAdd(byKey, record.key, contact.id);
    indexAdd(byEmail, personalEmail(record.email), contact.id);
    if (!contact.archived) {
      for (const other of byName.get(nameKey(record.name)) || [])
        addReview(
          contact.id,
          other,
          'Same name as a LinkedIn connection; verify the profile and organization before merging.',
        );
      indexAdd(byName, nameKey(record.name), contact.id);
    }
    changed.push({ record, doc, contact_id: contact.id });
  }
  summary.review_pairs = reviews.size;
  return {
    summary,
    changed,
    newContacts,
    updates: [...updates.values()],
    reviews: [...reviews.values()],
  };
}

export async function previewLinkedinConnections(
  parsed: ReturnType<typeof parseLinkedinConnections>,
) {
  const planned = await plan(parsed.records);
  return {
    total: parsed.total,
    identifiable: parsed.records.length,
    skipped: parsed.skipped.length,
    ...planned.summary,
  };
}

// The CLI commits bounded batches. Retrying the same export resumes through stable
// profile bindings and source hashes, without duplicating contacts or snapshots.
export async function importLinkedinBatch(records: LinkedinConnection[]) {
  if (!Array.isArray(records) || records.length > 100)
    throw Error('Import at most 100 LinkedIn connections per batch.');
  return transaction(async () => {
    await lockWorkspace();
    const { summary, changed, newContacts, updates, reviews } =
      await plan(records);
    if (newContacts.length)
      await db.insert(contactsTable).select(
        db
          .select({
            id: field('id'),
            name: field('name'),
            email: field('email'),
            role: field('role'),
            confirmed: sql`false`.as('confirmed'),
          })
          .from(
            recordset(newContacts, 'id text,name text,email text,role text'),
          ),
      );
    if (updates.length)
      await db
        .update(contactsTable)
        .set({
          email: sql`x.email`,
          role: sql`x.role`,
          version: sql`${contactsTable.version} + 1`,
          updated_at: sql`now()`,
        })
        .from(recordset(updates, 'id text,email text,role text'))
        .where(sql`${contactsTable.id} = x.id`);
    if (changed.length) {
      const time = stamp(),
        docs = changed.map(({ doc }) => ({ ...doc, version_id: uid(), time }));
      await db
        .insert(sourcesTable)
        .select(
          db
            .select({
              id: field('id'),
              provider: sql`'manual'`.as('provider'),
              external_id: field('external_id'),
              title: field('title'),
              occurred_at: field('occurred_at'),
              body: field('body'),
              url: field('url'),
              coverage: field('coverage'),
              content_hash: field('content_hash'),
              imported_at: field('time'),
              updated_at: field('time'),
            })
            .from(
              recordset(
                docs,
                'id text,external_id text,title text,occurred_at text,body text,url text,coverage text,content_hash text,time text',
              ),
            ),
        )
        .onConflictDoUpdate({
          target: sourcesTable.id,
          set: {
            title: sql`excluded.title`,
            body: sql`excluded.body`,
            url: sql`excluded.url`,
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
      const bindings = changed.map(({ record: r, doc, contact_id }) => ({
        id: uid(),
        contact_id,
        key: r.key,
        name: r.name,
        email: personalEmail(r.email),
        source_id: doc.id,
      }));
      await db
        .insert(contact_identities)
        .select(
          db
            .select({
              id: field('id'),
              contact_id: field('contact_id'),
              provider: sql`'linkedin'`.as('provider'),
              account: sql`'workspace'`.as('account'),
              external_key: field('key'),
              display_name: field('name'),
              address: field('email'),
              source_id: field('source_id'),
            })
            .from(
              recordset(
                bindings,
                'id text,contact_id text,key text,name text,email text,source_id text',
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
            address: sql`CASE WHEN excluded.address<>'' THEN excluded.address ELSE ${contact_identities.address} END`,
            source_id: sql`excluded.source_id`,
          },
        });
      const companies = [
        ...new Set(
          changed
            .map((c) => c.record.company)
            .filter(Boolean)
            .map((c) => c.toLowerCase()),
        ),
      ];
      const orgs = companies.map((key) => ({
        id: uid(),
        name: changed.find((c) => c.record.company.toLowerCase() === key)!
          .record.company,
      }));
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
                  c.record.position,
                ]),
                {
                  id: uid(),
                  contact_id: c.contact_id,
                  company: c.record.company,
                  role: c.record.position,
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
      // Profile metadata is not an interaction and must never enter the activity queue.
      await evaluateContacts([...new Set(changed.map((c) => c.contact_id))]);
    }
    if (reviews.length) {
      const inserted = await db
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
                reviews,
                'id text,left_id text,right_id text,reason text',
              ),
            ),
        )
        .onConflictDoNothing({
          target: [identity_reviews.left_id, identity_reviews.right_id],
        });
      summary.review_pairs = inserted.rowCount!;
    }
    return summary;
  });
}

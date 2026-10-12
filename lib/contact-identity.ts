import {
  and,
  eq,
  getColumns,
  inArray,
  isNull,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import { db, transaction, lockWorkspace } from './postgres.ts';
import { run, uid, hash } from './db.mjs';
import {
  existingContact,
  evaluateContacts as evaluateUntyped,
} from './contacts.ts';
import {
  emailAddress,
  personalEmail,
  exactEmailContacts,
  combinedNotes,
} from './contact-email.ts';
import {
  affiliations,
  contact_identities,
  contact_insights,
  contacts,
  identity_decisions,
  identity_reviews,
  interaction_participants,
  item_contacts,
  message_drafts,
  organizations,
} from './schema/index.ts';

type Contact = typeof contacts.$inferSelect;
// The rows a merge touches, as preview tokens and audit hashes see them.
type Snapshot = {
  contacts: Contact[];
  contact_identities: (typeof contact_identities.$inferSelect)[];
  interaction_participants: (typeof interaction_participants.$inferSelect)[];
  affiliations: (typeof affiliations.$inferSelect)[];
  item_contacts: (typeof item_contacts.$inferSelect)[];
  message_drafts: (typeof message_drafts.$inferSelect)[];
  identity_reviews: (typeof identity_reviews.$inferSelect)[];
};
// What identity_decisions.before_snapshot holds. Decisions recorded before
// contact priority existed have no priority key.
type DecisionSnapshot = Omit<Snapshot, 'contacts'> & {
  contacts: (Omit<Contact, 'priority'> & { priority?: boolean })[];
  automatic_email?: string;
  automatic_match?: unknown;
  bulk_contact_ids?: string[];
  bulk_review_ids?: string[];
  bulk_token?: string;
};
type EmailGroup = {
  contact: Contact | null;
  merged: number;
  skipped?: string;
  profiles?: number;
};
// contacts.mjs is JavaScript, so TypeScript infers its ids=null default as null.
const evaluateContacts = evaluateUntyped as (
  ids?: string[] | null,
) => Promise<void>;

const related = [
  'contact_identities',
  'interaction_participants',
  'affiliations',
  'item_contacts',
  'message_drafts',
] as const;
const relatedTables = {
  contact_identities,
  interaction_participants,
  affiliations,
  item_contacts,
  message_drafts,
};
const leftContact = alias(contacts, 'l'),
  rightContact = alias(contacts, 'rh');
async function snapshot(ids: string[]): Promise<Snapshot> {
  const data: Partial<Snapshot> = {
    contacts: await db
      .select()
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .orderBy(contacts.id),
  };
  for (const t of related) {
    const table = relatedTables[t];
    (data as Record<string, unknown[]>)[t] = await db
      .select()
      .from(table)
      .where(inArray(table.contact_id, ids))
      .orderBy(sql`row_to_json(${table})::text`);
  }
  data.identity_reviews = await db
    .select()
    .from(identity_reviews)
    .where(
      or(
        inArray(identity_reviews.left_id, ids),
        inArray(identity_reviews.right_id, ids),
      ),
    )
    .orderBy(identity_reviews.id);
  return data as Snapshot;
}
export async function mergePreview(left: string, right: string) {
  if (left === right) throw Error('Choose two different contacts.');
  const target = await existingContact(left),
    source = await existingContact(right),
    data = await snapshot([left, right]);
  return {
    target,
    source,
    counts: Object.fromEntries(
      related.map((t) => [
        t,
        data[t].filter((r) => r.contact_id === right).length,
      ]),
    ),
    token: hash(data),
    note: 'The first profile is kept. Identities, evidence, affiliations, drafts and commitment links move to it. Do-not-contact and pause preferences are preserved.',
  };
}
async function applyMerge(
  target: Contact,
  source: Contact,
  automaticEmail: string | object = '',
  recordDecision = true,
) {
  const target_id = target.id,
    source_id = source.id,
    ids = [target_id, source_id],
    before = await snapshot(ids);
  // If both profiles participated in one event, retain the stronger recorded role.
  await db
    .insert(interaction_participants)
    .select(
      db
        .select({
          interaction_id: interaction_participants.interaction_id,
          contact_id: sql<string>`${target_id}`.as('contact_id'),
          role: interaction_participants.role,
        })
        .from(interaction_participants)
        .where(eq(interaction_participants.contact_id, source_id)),
    )
    .onConflictDoUpdate({
      target: [
        interaction_participants.interaction_id,
        interaction_participants.contact_id,
      ],
      set: {
        role: sql`CASE WHEN interaction_participants.role IN ('cc','mentioned','uncertain','') AND excluded.role NOT IN ('cc','mentioned','uncertain','') THEN excluded.role ELSE interaction_participants.role END`,
      },
    });
  await db
    .delete(interaction_participants)
    .where(eq(interaction_participants.contact_id, source_id));
  await db
    .insert(item_contacts)
    .select(
      db
        .select({
          item_id: item_contacts.item_id,
          contact_id: sql<string>`${target_id}`.as('contact_id'),
        })
        .from(item_contacts)
        .where(eq(item_contacts.contact_id, source_id)),
    )
    .onConflictDoNothing();
  await db.delete(item_contacts).where(eq(item_contacts.contact_id, source_id));
  for (const table of [contact_identities, affiliations, message_drafts])
    await db
      .update(table)
      .set({ contact_id: target_id })
      .where(eq(table.contact_id, source_id));
  if (
    (source.name !== target.name ||
      (source.email && source.email !== target.email)) &&
    !(
      await db
        .select({ id: contact_identities.id })
        .from(contact_identities)
        .where(
          and(
            eq(contact_identities.contact_id, target_id),
            eq(contact_identities.display_name, source.name),
            eq(contact_identities.address, source.email),
          ),
        )
    ).length
  )
    await db.insert(contact_identities).values({
      id: uid(),
      contact_id: target_id,
      provider: 'manual',
      account: 'workspace',
      external_key: 'contact:' + source_id,
      display_name: source.name,
      address: source.email,
    });
  const tags = [
      ...new Set([...(target.tags as string[]), ...(source.tags as string[])]),
    ],
    snooze =
      [target.snoozed_until, source.snoozed_until]
        .filter(Boolean)
        .sort()
        .at(-1) || null;
  await db
    .update(contacts)
    .set({
      email: target.email || source.email,
      role: target.role || source.role,
      notes: combinedNotes(target.notes, source.notes),
      tags,
      do_not_contact: target.do_not_contact || source.do_not_contact,
      paused: target.paused || source.paused,
      snoozed_until: snooze,
      tracked: target.tracked || source.tracked,
      priority: target.priority || source.priority,
      archived: automaticEmail
        ? target.archived || source.archived
        : target.archived,
      confirmed: automaticEmail ? target.confirmed || source.confirmed : true,
      version: sql`${contacts.version} + 1`,
      updated_at: sql`now()`,
    })
    .where(eq(contacts.id, target_id));
  // Stays raw so a failure here reaches callers as the driver's own error;
  // tests/contact-bulk-review and tests/contact-email match its message.
  await run(
    'UPDATE contacts SET merged_into=?,archived=true,version=version+1,updated_at=now() WHERE id=?',
    target_id,
    source_id,
  );
  // Derived insights must be rebuilt against the combined evidence.
  await db
    .delete(contact_insights)
    .where(
      and(
        inArray(contact_insights.contact_id, ids),
        not(contact_insights.dismissed),
      ),
    );
  // Carry unresolved matches and explicit separations to the surviving contact.
  // Merging a pair must not dismiss an unrelated match on the kept profile.
  for (const review of before.identity_reviews) {
    if (![review.left_id, review.right_id].includes(source_id)) continue;
    const other =
      review.left_id === source_id ? review.right_id : review.left_id;
    if (
      other !== target_id &&
      ['pending', 'separate'].includes(review.status)
    ) {
      const [left, right] = [target_id, other].sort();
      await db
        .insert(identity_reviews)
        .values({
          id: uid(),
          left_id: left!,
          right_id: right!,
          reason: review.reason,
          status: review.status,
        })
        .onConflictDoUpdate({
          target: [identity_reviews.left_id, identity_reviews.right_id],
          set: {
            status: sql`CASE WHEN excluded.status='separate' THEN 'separate' ELSE identity_reviews.status END`,
          },
        });
    }
    if (review.status === 'pending')
      await db
        .update(identity_reviews)
        .set({ status: other === target_id ? 'merged' : 'obsolete' })
        .where(eq(identity_reviews.id, review.id));
  }
  if (recordDecision) {
    const id = uid(),
      before_snapshot = automaticEmail
        ? {
            ...before,
            ...(typeof automaticEmail === 'string'
              ? { automatic_email: automaticEmail }
              : { automatic_match: automaticEmail }),
          }
        : before;
    await db.insert(identity_decisions).values({
      id,
      kind: 'merge',
      left_id: target_id,
      right_id: source_id,
      before_snapshot,
      after_hash: hash(await snapshot(ids)),
    });
    return id;
  }
}
// Updates the cadence alone, without bumping the version.
const setCadence = (id: string, cadence_days: number) =>
  db.update(contacts).set({ cadence_days }).where(eq(contacts.id, id));
export async function mergeContacts({
  target_id,
  source_id,
  token,
}: {
  target_id: string;
  source_id: string;
  token: string;
}) {
  const decision = await transaction(async () => {
    await lockWorkspace();
    const preview = await mergePreview(target_id, source_id);
    if (preview.token !== token)
      throw Error('These contacts changed. Preview the merge again.');
    return applyMerge(preview.target, preview.source);
  });
  await evaluateContacts([target_id]);
  return { id: decision, contact_id: target_id };
}

function reviewIds(ids: unknown): string[] {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 30 ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 100) ||
    new Set(ids).size !== ids.length
  )
    throw Error('Select between 1 and 30 distinct review matches.');
  return ids.slice().sort();
}
function subset(data: Snapshot, ids: string[]) {
  const chosen = new Set(ids),
    result: Partial<Snapshot> = {
      contacts: data.contacts.filter((c) => chosen.has(c.id)),
    };
  for (const table of related)
    (result as Record<string, unknown[]>)[table] = data[table].filter((row) =>
      chosen.has(row.contact_id),
    );
  result.identity_reviews = data.identity_reviews.filter(
    (r) => chosen.has(r.left_id) || chosen.has(r.right_id),
  );
  return result as Snapshot;
}
const groupHash = (data: Snapshot, ids: string[]) =>
  hash({ data, review_ids: ids.slice().sort() });
async function reviewGroups(ids: string[]) {
  const reviews = await db
    .select(getColumns(identity_reviews))
    .from(identity_reviews)
    .innerJoin(leftContact, eq(leftContact.id, identity_reviews.left_id))
    .innerJoin(rightContact, eq(rightContact.id, identity_reviews.right_id))
    .where(
      and(
        inArray(identity_reviews.id, ids),
        eq(identity_reviews.status, 'pending'),
        isNull(leftContact.merged_into),
        isNull(rightContact.merged_into),
      ),
    )
    .orderBy(identity_reviews.id);
  if (reviews.length !== ids.length)
    throw Error(
      'Some selected matches changed or were already reviewed. Refresh the list and select them again.',
    );
  const parents = new Map<string, string>(),
    find = (id: string): string => {
      if (!parents.has(id)) parents.set(id, id);
      if (parents.get(id) !== id) parents.set(id, find(parents.get(id)!));
      return parents.get(id)!;
    };
  for (const r of reviews) parents.set(find(r.right_id), find(r.left_id));
  const groups = new Map<
    string,
    { review_ids: string[]; contact_ids: Set<string> }
  >();
  for (const r of reviews) {
    const key = find(r.left_id);
    if (!groups.has(key))
      groups.set(key, { review_ids: [], contact_ids: new Set() });
    const g = groups.get(key)!;
    g.review_ids.push(r.id);
    g.contact_ids.add(r.left_id);
    g.contact_ids.add(r.right_id);
  }
  const data = await snapshot([...parents.keys()]);
  return [...groups.values()].map((g) => {
    const contact_ids = [...g.contact_ids].sort(),
      before = subset(data, contact_ids);
    const blocked =
      contact_ids.length > 10
        ? 'This group has more than 10 profiles. Review a smaller selection.'
        : before.identity_reviews.some(
              (r) =>
                r.status === 'separate' &&
                g.contact_ids.has(r.left_id) &&
                g.contact_ids.has(r.right_id),
            )
          ? 'You previously marked profiles in this group as different people. Review them individually.'
          : '';
    return { ...g, contact_ids, before, blocked };
  });
}
export async function bulkMergePreview(input: { ids?: unknown }) {
  const ids = reviewIds(input.ids);
  return transaction(async () => {
    await db.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
    );
    const groups = await reviewGroups(ids);
    const organizationIds = [
      ...new Set(
        groups.flatMap((g) =>
          g.before.affiliations.map((a) => a.organization_id),
        ),
      ),
    ];
    const organizationNames = new Map(
      (
        await db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, organizationIds))
      ).map((o) => [o.id, o.name]),
    );
    return {
      groups: groups.map((g) => ({
        review_ids: g.review_ids,
        token: groupHash(g.before, g.review_ids) + '.' + uid(),
        blocked: g.blocked,
        target_id: g.before.contacts.slice().sort(canonicalOrder)[0]!.id,
        contacts: g.before.contacts.map((c) => ({
          ...c,
          organizations: [
            ...new Set(
              g.before.affiliations
                .filter((a) => a.contact_id === c.id)
                .map((a) => organizationNames.get(a.organization_id)),
            ),
          ],
          providers: [
            ...new Set(
              g.before.contact_identities
                .filter((i) => i.contact_id === c.id)
                .map((i) => i.provider),
            ),
          ],
          counts: Object.fromEntries(
            related.map((t) => [
              t,
              g.before[t].filter((r) => r.contact_id === c.id).length,
            ]),
          ),
        })),
      })),
    };
  });
}
export async function mergeReviewGroup(input: {
  review_ids?: unknown;
  token?: unknown;
  target_id: string;
}) {
  const ids = reviewIds(input.review_ids);
  if (
    typeof input.token !== 'string' ||
    !/^\w{64}\.[a-f\d-]{36}$/.test(input.token)
  )
    throw Error('Preview the selected matches before merging.');
  return transaction(async () => {
    await lockWorkspace();
    const [previous] = await db
      .select()
      .from(identity_decisions)
      .where(
        sql`${identity_decisions.before_snapshot}->>'bulk_token' = ${input.token}`,
      );
    if (previous) {
      const prior = previous.before_snapshot as DecisionSnapshot;
      if (previous.undone_at)
        throw Error('This merge was undone. Preview the matches again.');
      if (
        previous.left_id !== input.target_id ||
        JSON.stringify(prior.bulk_review_ids) !== JSON.stringify(ids)
      )
        throw Error(
          'This preview has already been used. Preview the matches again.',
        );
      return {
        id: previous.id,
        contact_id: previous.left_id,
        merged: prior.bulk_contact_ids!.length - 1,
        replayed: true,
      };
    }
    const groups = await reviewGroups(ids);
    if (groups.length !== 1)
      throw Error('Merge one connected group of profiles per request.');
    const group = groups[0]!;
    if (group.blocked) throw Error(group.blocked);
    if (groupHash(group.before, ids) !== (input.token as string).split('.')[0])
      throw Error(
        'These profiles changed. Preview the matches again before merging.',
      );
    if (!group.contact_ids.includes(input.target_id))
      throw Error('Choose a kept profile from this preview.');
    let target = group.before.contacts.find((c) => c.id === input.target_id)!;
    const sources = group.before.contacts.filter((c) => c.id !== target.id);
    for (const source of sources) {
      await applyMerge(target, source, '', false);
      target = await existingContact(target.id);
    }
    const id = uid(),
      before = {
        ...group.before,
        bulk_contact_ids: group.contact_ids,
        bulk_review_ids: ids,
        bulk_token: input.token,
      };
    await db.insert(identity_decisions).values({
      id,
      kind: 'merge',
      left_id: target.id,
      right_id: sources[0]!.id,
      before_snapshot: before,
      after_hash: hash(await snapshot(group.contact_ids)),
    });
    await evaluateContacts([target.id]);
    return { id, contact_id: target.id, merged: sources.length };
  });
}
export async function bulkKeepSeparate(input: { ids?: unknown }) {
  const ids = reviewIds(input.ids);
  return transaction(async () => {
    await lockWorkspace();
    // FROM l, rh as a join on true: the ON clause cannot see the updated table.
    const rows = await db
      .update(identity_reviews)
      .set({ status: 'separate' })
      .from(leftContact)
      .innerJoin(rightContact, sql`true`)
      .where(
        and(
          inArray(identity_reviews.id, ids),
          eq(identity_reviews.status, 'pending'),
          eq(leftContact.id, identity_reviews.left_id),
          eq(rightContact.id, identity_reviews.right_id),
          isNull(leftContact.merged_into),
          isNull(rightContact.merged_into),
        ),
      )
      .returning({ id: identity_reviews.id });
    return {
      completed: rows.map((r) => r.id),
      skipped: ids.filter((id) => !rows.some((r) => r.id === id)),
    };
  });
}

const label = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
function nameQuality(contact: Contact) {
  const name = label(contact.name),
    email = emailAddress(contact.email);
  if (
    !name ||
    emailAddress(name) ||
    name === email.split('@')[0] ||
    ['unknown participant', 'beeper contact'].includes(name)
  )
    return 0;
  return name.split(' ').length > 1 ? 2 : 1;
}
function canonicalOrder(a: Contact, b: Contact) {
  return (
    Number(b.confirmed) - Number(a.confirmed) ||
    Number(b.version > 1) - Number(a.version > 1) ||
    nameQuality(b) - nameQuality(a) ||
    Date.parse(a.created_at) - Date.parse(b.created_at) ||
    a.id.localeCompare(b.id)
  );
}
async function mergeBlocker(contacts: Contact[]) {
  const ids = contacts.map((c) => c.id);
  const [separate] = await db
    .select({ id: identity_reviews.id })
    .from(identity_reviews)
    .where(
      and(
        eq(identity_reviews.status, 'separate'),
        inArray(identity_reviews.left_id, ids),
        inArray(identity_reviews.right_id, ids),
      ),
    )
    .limit(1);
  if (separate) return 'Kept separate by you';
  const maintained = contacts.filter((c) => c.confirmed || c.version > 1);
  if (
    new Set(
      maintained.filter((c) => nameQuality(c) > 0).map((c) => label(c.name)),
    ).size > 1
  )
    return 'Conflicting maintained names';
  if (new Set(maintained.map((c) => label(c.role)).filter(Boolean)).size > 1)
    return 'Conflicting maintained roles';
  if (
    new Set(contacts.map((c) => c.cadence_days).filter((n) => n !== 30)).size >
    1
  )
    return 'Conflicting follow-up cadences';
  return '';
}
// Internal only: caller verifies employer evidence again under the same lock.
export async function mergeVerifiedEmployerContacts(
  ids: string[],
  evidence: object,
) {
  return transaction(async () => {
    await lockWorkspace();
    const contacts = await Promise.all(ids.map(existingContact));
    if (
      contacts.length !== 2 ||
      new Set(ids).size !== 2 ||
      contacts.some((c) => c.archived)
    )
      throw Error('These profiles need individual review.');
    const blocked = await mergeBlocker(contacts);
    if (blocked) throw Error(blocked);
    contacts.sort(canonicalOrder);
    const [target, source] = contacts as [Contact, Contact];
    const id = await applyMerge(target, source, evidence);
    if (target.cadence_days === 30 && source.cadence_days !== 30) {
      await setCadence(target.id, source.cadence_days);
      await db
        .update(identity_decisions)
        .set({ after_hash: hash(await snapshot(ids)) })
        .where(eq(identity_decisions.id, id!));
    }
    await evaluateContacts([target.id]);
    return { id, contact_id: target.id };
  });
}
async function reconcileEmailGroup(
  email: string,
  { apply }: { apply: boolean },
): Promise<EmailGroup> {
  const contacts = await exactEmailContacts(email);
  if (!contacts.length) return { contact: null, merged: 0 };
  contacts.sort(canonicalOrder);
  if (contacts.length === 1) return { contact: contacts[0]!, merged: 0 };
  const reason = await mergeBlocker(contacts);
  if (reason)
    return {
      contact: null,
      merged: 0,
      skipped: reason,
      profiles: contacts.length,
    };
  let target = contacts[0]!;
  if (apply)
    for (const source of contacts.slice(1)) {
      // Keep an explicitly configured cadence when the other profile uses the default.
      // Its original value must be in the audit snapshot, so update after the merge.
      const decision = await applyMerge(target, source, email);
      if (target.cadence_days === 30 && source.cadence_days !== 30) {
        await setCadence(target.id, source.cadence_days);
        await db
          .update(identity_decisions)
          .set({ after_hash: hash(await snapshot([target.id, source.id])) })
          .where(eq(identity_decisions.id, decision!));
      }
      target = await existingContact(target.id);
    }
  return { contact: target, merged: contacts.length - 1 };
}
// Called inside import/save transactions; taking the same lock also makes it safe
// for direct callers and serializes concurrent providers before creating profiles.
export async function resolveExactEmailContact(address: unknown) {
  const email = personalEmail(address);
  if (!email) return null;
  return transaction(async () => {
    await lockWorkspace();
    return (await reconcileEmailGroup(email, { apply: true })).contact;
  });
}
export async function reconcileEmailContacts({
  apply = false,
}: { apply?: boolean } = {}) {
  const addresses = db
    .select({
      contact_id: sql<string>`${contacts.id}`.as('contact_id'),
      address: sql<string>`lower(btrim(${contacts.email}))`.as('address'),
    })
    .from(contacts)
    .where(and(isNull(contacts.merged_into), ne(contacts.email, '')))
    .union(
      db
        .select({
          contact_id: sql<string>`${contact_identities.contact_id}`.as(
            'contact_id',
          ),
          address: sql<string>`lower(btrim(${contact_identities.address}))`.as(
            'address',
          ),
        })
        .from(contact_identities)
        .innerJoin(contacts, eq(contacts.id, contact_identities.contact_id))
        .where(
          and(isNull(contacts.merged_into), ne(contact_identities.address, '')),
        ),
    )
    .as('addresses');
  const emails = await db
    .select({ address: addresses.address })
    .from(addresses)
    .groupBy(addresses.address)
    .having(sql`count(DISTINCT ${addresses.contact_id}) > 1`)
    .orderBy(addresses.address);
  let merged = 0,
    groups = 0;
  const skipped: { reason: string; profiles?: number }[] = [],
    affected: string[] = [];
  // Commit one email group at a time so ingestion can continue between groups.
  for (const { address } of emails) {
    const email = personalEmail(address);
    if (!email) {
      skipped.push({ reason: 'Shared or invalid mailbox' });
      continue;
    }
    const result = await transaction(async () => {
      if (apply) await lockWorkspace();
      return reconcileEmailGroup(email, { apply });
    });
    if (result.skipped)
      skipped.push({ reason: result.skipped, profiles: result.profiles });
    if (result.merged) {
      merged += result.merged;
      groups++;
      affected.push(result.contact!.id);
    }
  }
  if (apply && affected.length) await evaluateContacts([...new Set(affected)]);
  return { apply, groups, merged, skipped, affected };
}
export async function undoMerge(id: string) {
  const ids = await transaction(async () => {
    await lockWorkspace();
    const [d] = await db
      .select()
      .from(identity_decisions)
      .where(
        and(
          eq(identity_decisions.id, id),
          eq(identity_decisions.kind, 'merge'),
          isNull(identity_decisions.undone_at),
        ),
      )
      .for('update');
    if (!d) throw Error('Merge not found or already undone.');
    const prior = d.before_snapshot as DecisionSnapshot;
    const ids = prior.bulk_contact_ids || [d.left_id, d.right_id];
    const current = await snapshot(ids);
    // Old decisions predate priority. Only omit its default value for legacy hashes.
    const legacy = {
      ...current,
      contacts: current.contacts.map((c) => {
        const copy: Partial<Contact> = { ...c };
        if (!copy.priority) delete copy.priority;
        return copy;
      }),
    };
    if (hash(current) !== d.after_hash && hash(legacy) !== d.after_hash)
      throw Error(
        'These records changed after the merge. Review them before undoing; no later edits were removed.',
      );
    await db
      .delete(contact_insights)
      .where(
        and(
          inArray(contact_insights.contact_id, ids),
          not(contact_insights.dismissed),
        ),
      );
    for (const t of related) {
      const table = relatedTables[t];
      await db.delete(table).where(inArray(table.contact_id, ids));
    }
    await db
      .delete(identity_reviews)
      .where(
        or(
          inArray(identity_reviews.left_id, ids),
          inArray(identity_reviews.right_id, ids),
        ),
      );
    // Snapshot keys are column names; columns a legacy snapshot lacks keep their values.
    for (const previous of prior.contacts) {
      const { id: contact_id, ...values } = { priority: false, ...previous };
      await db.update(contacts).set(values).where(eq(contacts.id, contact_id));
    }
    const restored = { ...relatedTables, identity_reviews };
    for (const t of [...related, 'identity_reviews'] as const)
      for (const row of prior[t])
        await db.insert(restored[t] as PgTable).values(row);
    if (prior.automatic_email || prior.automatic_match) {
      const [left, right] = ids.slice().sort();
      await db
        .insert(identity_reviews)
        .values({
          id: uid(),
          left_id: left!,
          right_id: right!,
          reason: 'Automatic match undone by you.',
          status: 'separate',
        })
        .onConflictDoUpdate({
          target: [identity_reviews.left_id, identity_reviews.right_id],
          set: { status: 'separate' },
        });
    }
    await db
      .update(identity_decisions)
      .set({ undone_at: sql`now()` })
      .where(eq(identity_decisions.id, id));
    return ids;
  });
  await evaluateContacts(ids);
  return { undone: true };
}
export async function keepSeparate(id: string) {
  await transaction(async () => {
    await lockWorkspace();
    await db
      .update(identity_reviews)
      .set({ status: 'separate' })
      .where(
        and(
          eq(identity_reviews.id, id),
          eq(identity_reviews.status, 'pending'),
        ),
      );
  });
  return { saved: true };
}

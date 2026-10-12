import { parse } from 'csv-parse/sync';
import {
  and,
  count,
  desc,
  eq,
  exists,
  getColumns,
  ilike,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  emailAddress,
  exactEmailContacts,
  combinedNotes,
} from './contact-email.ts';
import { resolveExactEmailContact } from './contact-identity.ts';
import {
  transaction,
  lockWorkspace,
  uid,
  stamp,
  hash,
  dateOK,
  upsertSource,
  getSetting,
  setSetting,
} from './db.ts';
import {
  relationshipState,
  SEGMENTS,
  RULE_VERSION,
} from './relationship-rules.mjs';
import { db } from './postgres.ts';
import {
  affiliations,
  contact_identities,
  contact_insights,
  contact_queue,
  contact_runs,
  contact_state_history,
  contact_states,
  contacts,
  identity_decisions,
  identity_reviews,
  interaction_participants,
  interaction_sources,
  interactions,
  item_contacts,
  items,
  message_drafts,
  organizations,
  settings as settingsTable,
  source_versions,
  sources,
  sync_runs,
} from './schema/index.ts';

// Request bodies, MCP tools and importers pass these fields unchecked; each
// one is validated or coerced where it is used.
type ContactInput = {
  id?: string;
  version?: number;
  name?: unknown;
  email?: unknown;
  role?: unknown;
  notes?: unknown;
  tags?: unknown;
  tracked?: unknown;
  priority?: unknown;
  cadence_days?: unknown;
  paused?: unknown;
  snoozed_until?: unknown;
  do_not_contact?: unknown;
  archived?: unknown;
  confirmed?: unknown;
  organization?: unknown;
  started_on?: unknown;
  ended_on?: unknown;
};
type AffiliationInput = {
  id: string;
  contact_id: string;
  role?: unknown;
  started_on?: unknown;
  ended_on?: unknown;
};
type DraftInput = {
  id?: string;
  contact_id: string;
  version?: number;
  subject?: unknown;
  body?: unknown;
};
type Coverage = { fresh: boolean; reason: string; checked_at?: string };
type ContactState = typeof contact_states.$inferSelect & {
  basis: { last_meaningful_at?: string | null };
};

export { emailAddress } from './contact-email.ts';
const text = (v: unknown, max = 2000) =>
  String(v || '')
    .trim()
    .slice(0, max);
export async function existingContact(id: string | undefined) {
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, id || ''), isNull(contacts.merged_into)));
  if (!row) throw Error('Contact not found.');
  return row;
}
export async function saveContact(input: ContactInput) {
  const row = await transaction(async () => {
    await lockWorkspace();
    const old = input.id ? await existingContact(input.id) : null;
    if (old && old.version !== input.version)
      throw Error('This contact changed. Reopen it before saving.');
    const row = old
      ? { ...old }
      : {
          id: uid(),
          name: '',
          email: '',
          role: '',
          tags: [],
          notes: '',
          tracked: false,
          priority: false,
          cadence_days: 30,
          paused: false,
          snoozed_until: null,
          do_not_contact: false,
          archived: false,
          confirmed: true,
          version: 0,
        };
    for (const k of ['name', 'role', 'notes'] as const)
      if (k in input) row[k] = text(input[k], k === 'notes' ? 12000 : 200);
    if ('email' in input) {
      row.email = emailAddress(input.email);
      if (input.email && !row.email)
        throw Error('Enter a valid email address.');
    }
    if (
      row.email &&
      (!old || row.email !== old.email) &&
      (await exactEmailContacts(row.email)).some((c) => c.id !== row.id)
    )
      throw Error(
        'A contact with this email already exists. Open that profile to edit it.',
      );
    if (!row.name) throw Error('Add a name for this contact.');
    for (const k of [
      'tracked',
      'paused',
      'do_not_contact',
      'archived',
      'confirmed',
    ] as const)
      if (k in input) row[k] = Boolean(input[k]);
    if ('priority' in input) {
      if (typeof input.priority !== 'boolean')
        throw Error('Priority must be true or false.');
      row.priority = input.priority;
    }
    if ('cadence_days' in input) {
      row.cadence_days = Number(input.cadence_days);
      if (
        !Number.isInteger(row.cadence_days) ||
        row.cadence_days < 1 ||
        row.cadence_days > 3650
      )
        throw Error('Choose a cadence between 1 and 3,650 days.');
    }
    if ('snoozed_until' in input) {
      if (input.snoozed_until && !dateOK(input.snoozed_until))
        throw Error('Choose a valid snooze date.');
      row.snoozed_until = (input.snoozed_until as string) || null;
    }
    if ('tags' in input) {
      if (!Array.isArray(input.tags)) throw Error('Tags must be a list.');
      row.tags = [
        ...new Set(input.tags.map((t) => text(t, 40)).filter(Boolean)),
      ].slice(0, 20);
    }
    await db
      .insert(contacts)
      .values({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        tags: row.tags,
        notes: row.notes,
        tracked: row.tracked,
        priority: row.priority,
        cadence_days: row.cadence_days,
        paused: row.paused,
        snoozed_until: row.snoozed_until,
        do_not_contact: row.do_not_contact,
        archived: row.archived,
        confirmed: row.confirmed,
      })
      .onConflictDoUpdate({
        target: contacts.id,
        set: {
          name: sql`excluded.name`,
          email: sql`excluded.email`,
          role: sql`excluded.role`,
          tags: sql`excluded.tags`,
          notes: sql`excluded.notes`,
          tracked: sql`excluded.tracked`,
          priority: sql`excluded.priority`,
          cadence_days: sql`excluded.cadence_days`,
          paused: sql`excluded.paused`,
          snoozed_until: sql`excluded.snoozed_until`,
          do_not_contact: sql`excluded.do_not_contact`,
          archived: sql`excluded.archived`,
          confirmed: sql`excluded.confirmed`,
          version: sql`${contacts.version}+1`,
          updated_at: sql`now()`,
        },
      });
    if (input.organization !== undefined && text(input.organization, 200)) {
      for (const k of ['started_on', 'ended_on'] as const)
        if (input[k] && !dateOK(input[k]))
          throw Error('Choose valid affiliation dates.');
      if (
        input.started_on &&
        input.ended_on &&
        input.ended_on < input.started_on
      )
        throw Error('Affiliation end must follow its start.');
      const started_on = (input.started_on as string) || null,
        ended_on = (input.ended_on as string) || null;
      // Drizzle's conflict target takes columns, not the lower(name) unique index.
      const {
        rows: [org],
      } = await db.execute<{ id: string }>(
        sql`INSERT INTO organizations(id,name) VALUES(${uid()},${text(input.organization, 200)}) ON CONFLICT(lower(name)) DO UPDATE SET name=organizations.name RETURNING id`,
      );
      const [affiliation] = await db
        .select({ id: affiliations.id })
        .from(affiliations)
        .where(
          and(
            eq(affiliations.contact_id, row.id),
            eq(affiliations.organization_id, org!.id),
            eq(affiliations.role, row.role),
            sql`${affiliations.started_on} IS NOT DISTINCT FROM ${started_on}::date`,
            sql`${affiliations.ended_on} IS NOT DISTINCT FROM ${ended_on}::date`,
          ),
        );
      if (!affiliation)
        await db.insert(affiliations).values({
          id: uid(),
          contact_id: row.id,
          organization_id: org!.id,
          role: row.role,
          started_on,
          ended_on,
        });
    }
    if (
      !old ||
      old.notes !== row.notes ||
      old.name !== row.name ||
      old.role !== row.role
    )
      await upsertSource(
        {
          provider: 'manual',
          external_id: 'contact-profile-' + row.id,
          title: 'Contact profile: ' + row.name,
          body: [row.name, row.role, row.notes].filter(Boolean).join('\n\n'),
          coverage: 'document',
        },
        { origin: 'User maintained contact profile', contact_profile: row.id },
      );
    return existingContact(row.id);
  });
  await evaluateContacts([row.id]);
  return row;
}
export async function saveAffiliation(input: AffiliationInput) {
  return transaction(async () => {
    await lockWorkspace();
    await existingContact(input.contact_id);
    const [a] = await db
      .select()
      .from(affiliations)
      .where(
        and(
          eq(affiliations.id, input.id),
          eq(affiliations.contact_id, input.contact_id),
        ),
      );
    if (!a) throw Error('Affiliation not found.');
    for (const k of ['started_on', 'ended_on'] as const)
      if (input[k] && !dateOK(input[k]))
        throw Error('Choose valid affiliation dates.');
    if (input.started_on && input.ended_on && input.ended_on < input.started_on)
      throw Error('Affiliation end must follow its start.');
    await db
      .update(affiliations)
      .set({
        role: text(input.role, 200),
        started_on: (input.started_on as string) || null,
        ended_on: (input.ended_on as string) || null,
      })
      .where(eq(affiliations.id, input.id));
    await db
      .update(contacts)
      .set({ version: sql`${contacts.version}+1`, updated_at: sql`now()` })
      .where(eq(contacts.id, input.contact_id));
    return { saved: true };
  });
}
export async function importContactsCsv(csv: unknown) {
  if (typeof csv !== 'string' || csv.length > 2_000_000)
    throw Error('Choose a CSV smaller than 2 MB.');
  let rows;
  try {
    rows = parse<Record<string, string>>(csv, {
      columns: (headers) =>
        headers.map((h) => h.trim().toLowerCase().replaceAll(' ', '_')),
      bom: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    throw Error('Could not read this CSV. Check its headers and quoting.');
  }
  if (rows.length > 5000) throw Error('Import up to 5,000 contacts at a time.');
  const records = rows.map((r, i) => {
    const name = text(
        r.name || [r.first_name, r.last_name].filter(Boolean).join(' '),
        200,
      ),
      email = emailAddress(r.email);
    if (!name || (r.email && !email))
      throw Error(
        'Row ' + (i + 2) + ' needs a name and a valid email if supplied.',
      );
    return {
      name,
      email,
      role: r.role || '',
      organization: r.organization || r.company || '',
      notes: r.notes || '',
      tags: (r.tags || '').split(';').filter(Boolean),
    };
  });
  let added = 0,
    matched = 0;
  await transaction(async () => {
    await lockWorkspace();
    for (const r of records) {
      const key = hash(r);
      const [imported] = await db
        .select({ id: contact_identities.id })
        .from(contact_identities)
        .where(
          and(
            eq(contact_identities.provider, 'csv'),
            eq(contact_identities.account, 'workspace'),
            eq(contact_identities.external_key, key),
          ),
        );
      if (imported) continue;
      const existing = await resolveExactEmailContact(r.email);
      const c = await saveContact(
        existing
          ? {
              ...r,
              id: existing.id,
              version: existing.version,
              name: existing.name,
              email: existing.email,
              role: existing.role || r.role,
              notes: combinedNotes(existing.notes, r.notes),
              tags: [...new Set([...(existing.tags as string[]), ...r.tags])],
            }
          : r,
      );
      await db.insert(contact_identities).values({
        id: uid(),
        contact_id: c.id,
        provider: 'csv',
        account: 'workspace',
        external_key: key,
        display_name: r.name,
        address: r.email,
      });
      if (existing) matched++;
      else {
        await suggestIdentityMatches(c.id, c.name, c.email);
        added++;
      }
    }
  });
  return { total: records.length, added, matched };
}
export async function suggestIdentityMatches(
  id: string,
  name: string,
  email: string,
) {
  const matches = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      and(
        ne(contacts.id, id),
        isNull(contacts.merged_into),
        eq(contacts.archived, false),
        sql`((${email}<>'' AND lower(${contacts.email})=${email}) OR lower(${contacts.name})=lower(${name}))`,
      ),
    )
    .limit(20);
  for (const other of matches) {
    const [left, right] = [id, other.id].sort();
    await db
      .insert(identity_reviews)
      .values({
        id: uid(),
        left_id: left!,
        right_id: right!,
        reason:
          email && email === other.email
            ? 'Same address across different identity bindings.'
            : 'Same display name; may be different people.',
      })
      .onConflictDoNothing({
        target: [identity_reviews.left_id, identity_reviews.right_id],
      });
  }
}
// cc, mentioned and uncertain participants were not part of the conversation.
const participantQualified = sql<boolean>`CASE WHEN ${interaction_participants.role} IN ('cc','mentioned','uncertain') THEN false ELSE ${interactions.qualified} END`;
export async function readInteractions(
  id: string,
  limit: unknown = 300,
  offset: unknown = 0,
) {
  const citations = db
    .select({
      citations: sql`jsonb_agg(jsonb_build_object('source_id',${interaction_sources.source_id},'source_version_id',${interaction_sources.source_version_id},'quote',${interaction_sources.quote}))`,
    })
    .from(interaction_sources)
    .innerJoin(
      source_versions,
      eq(source_versions.id, interaction_sources.source_version_id),
    )
    .innerJoin(sources, eq(sources.id, interaction_sources.source_id))
    .where(
      and(
        eq(interaction_sources.interaction_id, interactions.id),
        eq(source_versions.content_hash, sources.content_hash),
      ),
    );
  const query = db
    .select({
      ...getColumns(interactions),
      qualified: participantQualified,
      citations: sql<
        { source_id: string; source_version_id: string; quote: string }[]
      >`COALESCE((${citations}),'[]'::jsonb)`,
    })
    .from(interactions)
    .innerJoin(
      interaction_participants,
      eq(interaction_participants.interaction_id, interactions.id),
    )
    .where(eq(interaction_participants.contact_id, id))
    .orderBy(sql`${interactions.occurred_at} DESC NULLS LAST`, interactions.id)
    .$dynamic();
  return limit
    ? query
        .limit(Math.min(1000, Math.max(1, Number(limit) || 300)))
        .offset(Math.max(0, Math.floor(Number(offset) || 0)))
    : query;
}
// One array parameter, however many contacts are evaluated.
const anyOf = (column: SQLWrapper, values: string[]) =>
  sql`${column}=ANY(${sql.param(values)}::text[])`;
export async function evaluateContacts(ids: string[] | null = null) {
  if (!ids) {
    const last = await getSetting('contacts_last_evaluation');
    // A deployment must refresh existing classifications even inside the normal cache window.
    if (
      last &&
      Date.now() - Date.parse(last) < 900000 &&
      !(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .leftJoin(contact_states, eq(contact_states.contact_id, contacts.id))
          .where(
            and(
              isNull(contacts.merged_into),
              eq(contacts.archived, false),
              sql`${contact_states.rule_version} IS DISTINCT FROM ${RULE_VERSION}`,
            ),
          )
          .limit(1)
      ).length
    )
      return;
  }
  await transaction(async () => {
    await lockWorkspace();
    const people = ids
      ? await db
          .select()
          .from(contacts)
          .where(and(anyOf(contacts.id, ids), isNull(contacts.merged_into)))
      : await db
          .select()
          .from(contacts)
          .where(
            and(isNull(contacts.merged_into), eq(contacts.archived, false)),
          );
    if (!people.length) return;
    const contactIds = people.map((c) => c.id),
      oldStates = new Map(
        (
          await db
            .select()
            .from(contact_states)
            .where(anyOf(contact_states.contact_id, contactIds))
        ).map((r) => [r.contact_id, r as ContactState]),
      );
    const events = await db
      .select({
        contact_id: interaction_participants.contact_id,
        ...getColumns(interactions),
        qualified: participantQualified,
      })
      .from(interactions)
      .innerJoin(
        interaction_participants,
        eq(interaction_participants.interaction_id, interactions.id),
      )
      .where(anyOf(interaction_participants.contact_id, contactIds));
    const byContact = new Map<string, typeof events>();
    for (const e of events) {
      if (!byContact.has(e.contact_id)) byContact.set(e.contact_id, []);
      byContact.get(e.contact_id)!.push(e);
    }
    const syncs = new Map(
      (
        await db
          .selectDistinctOn([sync_runs.provider])
          .from(sync_runs)
          .orderBy(
            sync_runs.provider,
            desc(sync_runs.started_at),
            desc(sync_runs.id),
          )
      ).map((r) => [r.provider, r]),
    );
    const settings = new Map(
      (
        await db
          .select()
          .from(settingsTable)
          .where(
            anyOf(settingsTable.key, [
              'gmail_query',
              ...contactIds.map((id) => 'contact_coverage:' + id),
            ]),
          )
      ).map((r) => [r.key, JSON.parse(r.value)]),
    );
    const backlog = new Set(
      (
        await db
          .selectDistinct({ provider: sources.provider })
          .from(contact_queue)
          .innerJoin(sources, eq(sources.id, contact_queue.source_id))
          .where(ne(contact_queue.state, 'complete'))
      ).map((r) => r.provider),
    );
    const states = [],
      history = [];
    for (const contact of people) {
      const interactions = byContact.get(contact.id) || [],
        manual = settings.get('contact_coverage:' + contact.id),
        providers = [
          ...new Set(
            interactions
              .map((i) => i.source_id?.split(':')[0])
              .filter((p): p is string => !!p && p !== 'manual'),
          ),
        ];
      let coverage: Coverage = {
        fresh: true,
        reason: 'Connected providers have complete recent imports.',
      };
      if (manual && Date.now() - Date.parse(manual) < 48 * 3600000)
        coverage = {
          fresh: true,
          reason: 'Timeline coverage confirmed by you.',
          checked_at: manual,
        };
      else if (!providers.length)
        coverage = {
          fresh: false,
          reason:
            'Only recorded activity is available; other conversations may be missing.',
        };
      else if (providers.includes('beeper'))
        coverage = {
          fresh: false,
          reason:
            'Beeper includes selected conversations and locally available history; other conversations may be missing.',
        };
      else
        for (const p of providers) {
          const sync = syncs.get(p);
          if (
            !sync ||
            sync.state !== 'complete' ||
            !sync.finished_at ||
            Date.now() - Date.parse(sync.finished_at) > 48 * 3600000
          ) {
            coverage = {
              fresh: false,
              reason: p + ' has no complete import within 48 hours.',
            };
            break;
          }
          if (
            p === 'gmail' &&
            (settings.get('gmail_query') || '-in:spam -in:trash') !==
              '-in:spam -in:trash'
          ) {
            coverage = {
              fresh: false,
              reason:
                'Gmail search is filtered; relationship coverage is partial.',
            };
            break;
          }
          if (backlog.has(p)) {
            coverage = {
              fresh: false,
              reason: 'Contact extraction is incomplete.',
            };
            break;
          }
        }
      const next = relationshipState(contact, interactions, { coverage }),
        old = oldStates.get(contact.id);
      states.push({
        contact_id: contact.id,
        state: next.state,
        basis: next.basis,
        rule_version: RULE_VERSION,
      });
      if (old?.state !== next.state)
        history.push({
          id: uid(),
          contact_id: contact.id,
          from_state: old?.state || null,
          to_state: next.state,
          reason: next.basis.reason,
          basis: {
            ...next.basis,
            reconnected:
              ['Cooling', 'Dormant'].includes(old?.state as string) &&
              next.state === 'Active' &&
              Date.parse(next.basis.last_meaningful_at!) >
                Date.parse(old?.basis.last_meaningful_at || '1970-01-01'),
          },
          rule_version: RULE_VERSION,
        });
    }
    // Each batch is one jsonb parameter, however many contacts it covers.
    const stateRows = sql`jsonb_to_recordset(${JSON.stringify(states)}::jsonb) AS x(contact_id text,state text,basis jsonb,rule_version int)`;
    await db
      .insert(contact_states)
      .select(
        db
          .select({
            contact_id: sql<string>`x.contact_id`.as('contact_id'),
            state: sql<string>`x.state`.as('state'),
            basis: sql`x.basis`.as('basis'),
            rule_version: sql<number>`x.rule_version`.as('rule_version'),
          })
          .from(stateRows),
      )
      .onConflictDoUpdate({
        target: contact_states.contact_id,
        set: {
          state: sql`excluded.state`,
          basis: sql`excluded.basis`,
          evaluated_at: sql`now()`,
          rule_version: sql`excluded.rule_version`,
        },
      });
    if (history.length) {
      const historyRows = sql`jsonb_to_recordset(${JSON.stringify(history)}::jsonb) AS x(id text,contact_id text,from_state text,to_state text,reason text,basis jsonb,rule_version int)`;
      await db.insert(contact_state_history).select(
        db
          .select({
            id: sql<string>`x.id`.as('id'),
            contact_id: sql<string>`x.contact_id`.as('contact_id'),
            from_state: sql<string | null>`x.from_state`.as('from_state'),
            to_state: sql<string>`x.to_state`.as('to_state'),
            reason: sql<string>`x.reason`.as('reason'),
            basis: sql`x.basis`.as('basis'),
            rule_version: sql<number>`x.rule_version`.as('rule_version'),
          })
          .from(historyRows),
      );
    }
    if (!ids) await setSetting('contacts_last_evaluation', stamp());
  });
}
export async function confirmCoverage(id: string) {
  await existingContact(id);
  await setSetting('contact_coverage:' + id, stamp());
  await evaluateContacts([id]);
  return { saved: true };
}
export async function contactDetail(id: string, evaluate = true) {
  const contact = await existingContact(id);
  if (evaluate) await evaluateContacts([id]);
  return {
    ...contact,
    insight: (
      await db
        .select({
          result: contact_insights.result,
          reviewed_at: contact_insights.reviewed_at,
          dismissed: contact_insights.dismissed,
        })
        .from(contact_insights)
        .where(eq(contact_insights.contact_id, id))
    )[0],
    relationship: (
      await db
        .select()
        .from(contact_states)
        .where(eq(contact_states.contact_id, id))
    )[0],
    identities: await db
      .select({
        ...getColumns(contact_identities),
        profile_url: sql<
          string | null
        >`CASE WHEN ${contact_identities.provider}='linkedin' THEN ${sources.url} END`,
        connected_on: sql<
          string | null
        >`CASE WHEN ${contact_identities.provider}='linkedin' THEN ${source_versions.raw_json}::jsonb #>> '{linkedin_connection,connected_on}' END`,
        source_version_id: source_versions.id,
      })
      .from(contact_identities)
      .leftJoin(sources, eq(sources.id, contact_identities.source_id))
      .leftJoin(
        source_versions,
        and(
          eq(source_versions.source_id, sources.id),
          eq(source_versions.content_hash, sources.content_hash),
        ),
      )
      .where(eq(contact_identities.contact_id, id)),
    affiliations: await db
      .select({ ...getColumns(affiliations), organization: organizations.name })
      .from(affiliations)
      .innerJoin(
        organizations,
        eq(organizations.id, affiliations.organization_id),
      )
      .where(eq(affiliations.contact_id, id))
      .orderBy(
        sql`${affiliations.ended_on} NULLS FIRST`,
        sql`${affiliations.started_on} DESC NULLS LAST`,
      ),
    interactions: await readInteractions(id),
    history: await db
      .select()
      .from(contact_state_history)
      .where(eq(contact_state_history.contact_id, id))
      .orderBy(desc(contact_state_history.changed_at))
      .limit(40),
    items: await db
      .select(getColumns(items))
      .from(items)
      .innerJoin(item_contacts, eq(item_contacts.item_id, items.id))
      .where(eq(item_contacts.contact_id, id))
      .orderBy(desc(items.created_at)),
    drafts: await db
      .select()
      .from(message_drafts)
      .where(eq(message_drafts.contact_id, id))
      .orderBy(desc(message_drafts.created_at))
      .limit(20),
    profile_source_id: 'manual:contact-profile-' + id,
  };
}
// Manual tags win; a dismissed insight contributes none.
const effectivePurpose = sql<
  string[]
>`CASE WHEN jsonb_array_length(${contacts.tags})>0 THEN ${contacts.tags} WHEN ${contact_insights.dismissed} THEN '[]'::jsonb ELSE COALESCE(${contact_insights.result}->'purpose_tags','[]'::jsonb) END`;
const segmentOf = sql<string>`COALESCE(${contact_states.state},'Unclassified')`;
export async function listContacts({
  q = '',
  segment = '',
  tag = '',
  priority = false,
  archived = false,
  offset = 0,
  limit = 500,
  evaluate = true,
}: {
  // Query-string filters arrive as strings.
  q?: string;
  segment?: string;
  tag?: string;
  priority?: boolean | string;
  archived?: boolean | string;
  offset?: unknown;
  limit?: unknown;
  evaluate?: unknown;
} = {}) {
  if (evaluate) await evaluateContacts();
  const archivedValue = archived === true || archived === 'true';
  const conditions = [
    isNull(contacts.merged_into),
    eq(contacts.archived, archivedValue),
  ];
  if (priority === true || priority === 'true')
    conditions.push(eq(contacts.priority, true));
  if (q) {
    const like = '%' + text(q, 200) + '%';
    conditions.push(
      or(
        ilike(contacts.name, like),
        ilike(contacts.email, like),
        ilike(contacts.role, like),
        exists(
          db
            .select({ one: sql`1` })
            .from(affiliations)
            .innerJoin(
              organizations,
              eq(organizations.id, affiliations.organization_id),
            )
            .where(
              and(
                eq(affiliations.contact_id, contacts.id),
                ilike(organizations.name, like),
              ),
            ),
        ),
        exists(
          db
            .select({ one: sql`1` })
            .from(contact_identities)
            .where(
              and(
                eq(contact_identities.contact_id, contacts.id),
                or(
                  ilike(contact_identities.display_name, like),
                  ilike(contact_identities.address, like),
                  and(
                    eq(contact_identities.provider, 'linkedin'),
                    ilike(contact_identities.external_key, like),
                  ),
                ),
              ),
            ),
        ),
      )!,
    );
  }
  if (tag)
    conditions.push(
      sql`(${effectivePurpose}) @> ${JSON.stringify([tag])}::jsonb`,
    );
  if (segment) {
    if (!SEGMENTS.includes(segment))
      throw Error('Unknown relationship segment.');
    conditions.push(sql`${segmentOf}=${segment}`);
  }
  const where = and(...conditions);
  const counts = await db
    .select({ state: segmentOf, n: count() })
    .from(contacts)
    .leftJoin(contact_states, eq(contact_states.contact_id, contacts.id))
    .leftJoin(contact_insights, eq(contact_insights.contact_id, contacts.id))
    .where(where)
    .groupBy(segmentOf);
  const fields = {
    ...getColumns(contacts),
    purpose_tags: effectivePurpose,
    purpose_origin: sql<string>`CASE WHEN jsonb_array_length(${contacts.tags})>0 THEN 'manual' WHEN ${contact_insights.dismissed} THEN 'dismissed' WHEN ${contact_insights.contact_id} IS NULL THEN 'pending' WHEN jsonb_array_length(${contact_insights.result}->'purpose_tags')>0 THEN 'agent' ELSE 'unknown' END`,
    state: segmentOf,
    basis: contact_states.basis,
    organization: sql<string | null>`(${db
      .select({
        names: sql`string_agg(${organizations.name},', ' ORDER BY ${organizations.name})`,
      })
      .from(affiliations)
      .innerJoin(
        organizations,
        eq(organizations.id, affiliations.organization_id),
      )
      .where(
        and(
          eq(affiliations.contact_id, contacts.id),
          isNull(affiliations.ended_on),
        ),
      )})`,
    promises_due: sql<number>`(${db
      .select({ n: count() })
      .from(item_contacts)
      .innerJoin(items, eq(items.id, item_contacts.item_id))
      .where(
        and(
          eq(item_contacts.contact_id, contacts.id),
          notInArray(items.status, ['done', 'dropped']),
          ne(items.checkpoint, ''),
          sql`${items.checkpoint}<=CURRENT_DATE::text`,
        ),
      )})`,
    reconnected: sql<boolean>`${exists(
      db
        .select({ one: sql`1` })
        .from(contact_state_history)
        .where(
          and(
            eq(contact_state_history.contact_id, contacts.id),
            inArray(contact_state_history.from_state, ['Cooling', 'Dormant']),
            eq(contact_state_history.to_state, 'Active'),
            sql`${contact_state_history.basis}->>'reconnected'='true'`,
            sql`${contact_state_history.changed_at}>now()-interval '14 days'`,
            sql`(${contact_state_history.basis}->>'last_meaningful_at')::timestamptz>now()-interval '14 days'`,
          ),
        ),
    )}`,
  };
  const records = await db
    .select(fields)
    .from(contacts)
    .leftJoin(contact_states, eq(contact_states.contact_id, contacts.id))
    .leftJoin(contact_insights, eq(contact_insights.contact_id, contacts.id))
    .where(where)
    .orderBy(desc(contacts.priority), sql`lower(${contacts.name})`, contacts.id)
    .limit(Math.min(500, Math.max(1, Math.floor(Number(limit) || 500))))
    .offset(Math.max(0, Number(offset) || 0));
  const ranked = db
    .select({
      id: contacts.id,
      rank: sql<number>`row_number() OVER(PARTITION BY ${segmentOf} ORDER BY ${contacts.priority} DESC,${contact_states.basis}->>'last_meaningful_at' DESC NULLS LAST,lower(${contacts.name}),${contacts.id})`.as(
        'rank',
      ),
    })
    .from(contacts)
    .leftJoin(contact_states, eq(contact_states.contact_id, contacts.id))
    .leftJoin(contact_insights, eq(contact_insights.contact_id, contacts.id))
    .where(where)
    .as('ranked');
  const mapIds = await db
    .select({ id: ranked.id })
    .from(ranked)
    .where(sql`${ranked.rank}<=15`);
  const mapRecords = mapIds.length
    ? await db
        .select(fields)
        .from(contacts)
        .leftJoin(contact_states, eq(contact_states.contact_id, contacts.id))
        .leftJoin(
          contact_insights,
          eq(contact_insights.contact_id, contacts.id),
        )
        .where(
          and(
            where,
            anyOf(
              contacts.id,
              mapIds.map((c) => c.id),
            ),
          ),
        )
        .orderBy(
          desc(contacts.priority),
          sql`lower(${contacts.name})`,
          contacts.id,
        )
    : [];
  const purposes = await db
    .selectDistinct({
      tag: sql<string>`jsonb_array_elements_text(${effectivePurpose})`.as(
        'tag',
      ),
    })
    .from(contacts)
    .leftJoin(contact_insights, eq(contact_insights.contact_id, contacts.id))
    .where(
      and(isNull(contacts.merged_into), eq(contacts.archived, archivedValue)),
    )
    .orderBy(sql`tag`);
  return {
    records,
    map_records: mapRecords,
    purpose_tags: purposes.map((r) => r.tag),
    counts: Object.fromEntries(
      SEGMENTS.map((s) => [s, counts.find((c) => c.state === s)?.n || 0]),
    ),
    total: counts.reduce((n, c) => n + c.n, 0),
    rule_version: RULE_VERSION,
  };
}
export async function contactStatus() {
  const left = alias(contacts, 'l'),
    right = alias(contacts, 'rh'),
    original = alias(interactions, 'd');
  const pendingReview = and(
    eq(identity_reviews.status, 'pending'),
    isNull(left.merged_into),
    isNull(right.merged_into),
  );
  return {
    review_total: (
      await db
        .select({ n: count() })
        .from(identity_reviews)
        .innerJoin(left, eq(left.id, identity_reviews.left_id))
        .innerJoin(right, eq(right.id, identity_reviews.right_id))
        .where(pendingReview)
    )[0]!.n,
    duplicate_total: (
      await db
        .select({ n: count() })
        .from(interactions)
        .innerJoin(original, eq(original.id, interactions.duplicate_of))
        .where(eq(interactions.duplicate_status, 'review'))
    )[0]!.n,
    queue: await db
      .select({ state: contact_queue.state, n: count() })
      .from(contact_queue)
      .groupBy(contact_queue.state),
    runs: await db
      .select()
      .from(contact_runs)
      .orderBy(desc(contact_runs.started_at))
      .limit(5),
    reviews: await db
      .select({
        ...getColumns(identity_reviews),
        left_name: left.name,
        right_name: right.name,
        left_email: left.email,
        right_email: right.email,
      })
      .from(identity_reviews)
      .innerJoin(left, eq(left.id, identity_reviews.left_id))
      .innerJoin(right, eq(right.id, identity_reviews.right_id))
      .where(pendingReview)
      .orderBy(identity_reviews.created_at, identity_reviews.id)
      .limit(30),
    duplicates: await db
      .select({
        ...getColumns(interactions),
        other_title: original.title,
        other_source_id: original.source_id,
      })
      .from(interactions)
      .innerJoin(original, eq(original.id, interactions.duplicate_of))
      .where(eq(interactions.duplicate_status, 'review'))
      .orderBy(
        sql`${interactions.occurred_at} DESC NULLS LAST`,
        interactions.id,
      )
      .limit(30),
    exclusions: await db
      .select({ exclusion: interactions.exclusion, n: count() })
      .from(interactions)
      .where(ne(interactions.exclusion, ''))
      .groupBy(interactions.exclusion),
    last_evaluation: await getSetting('contacts_last_evaluation'),
    decisions: await db
      .select({
        id: identity_decisions.id,
        kind: identity_decisions.kind,
        left_id: identity_decisions.left_id,
        right_id: identity_decisions.right_id,
        created_at: identity_decisions.created_at,
        automatic_match: sql`${identity_decisions.before_snapshot}->'automatic_match'`,
        merged_count: sql<number>`COALESCE(jsonb_array_length(${identity_decisions.before_snapshot}->'bulk_contact_ids')-1,1)`,
        left_name: left.name,
        right_name: right.name,
      })
      .from(identity_decisions)
      .innerJoin(left, eq(left.id, identity_decisions.left_id))
      .innerJoin(right, eq(right.id, identity_decisions.right_id))
      .where(isNull(identity_decisions.undone_at))
      .orderBy(desc(identity_decisions.created_at))
      .limit(10),
  };
}
export async function saveDraft(input: DraftInput) {
  return transaction(async () => {
    await lockWorkspace();
    const c = await existingContact(input.contact_id);
    if (c.do_not_contact || c.archived)
      throw Error('Drafting is disabled for this contact.');
    const old = input.id
      ? (
          await db
            .select()
            .from(message_drafts)
            .where(
              and(
                eq(message_drafts.id, input.id),
                eq(message_drafts.contact_id, c.id),
              ),
            )
        )[0]
      : null;
    if (input.id && !old) throw Error('Draft not found.');
    if (old && input.version !== old.version)
      throw Error('This draft changed. Reopen it.');
    const body = text(input.body, 12000);
    if (!body) throw Error('Add text to the draft.');
    const id = old?.id || uid();
    await db
      .insert(message_drafts)
      .values({
        id,
        contact_id: c.id,
        subject: text(input.subject, 300),
        body,
      })
      .onConflictDoUpdate({
        target: message_drafts.id,
        set: {
          subject: sql`excluded.subject`,
          body: sql`excluded.body`,
          version: sql`${message_drafts.version}+1`,
          updated_at: sql`now()`,
        },
      });
    return (
      await db.select().from(message_drafts).where(eq(message_drafts.id, id))
    )[0];
  });
}
export async function linkContactItem(input: {
  contact_id: string;
  item_id: string;
  remove?: unknown;
}) {
  return transaction(async () => {
    await lockWorkspace();
    await existingContact(input.contact_id);
    if (
      !(
        await db
          .select({ id: items.id })
          .from(items)
          .where(eq(items.id, input.item_id))
      ).length
    )
      throw Error('Commitment not found.');
    if (input.remove)
      await db
        .delete(item_contacts)
        .where(
          and(
            eq(item_contacts.item_id, input.item_id),
            eq(item_contacts.contact_id, input.contact_id),
          ),
        );
    else
      await db
        .insert(item_contacts)
        .values({ item_id: input.item_id, contact_id: input.contact_id })
        .onConflictDoNothing();
    return { saved: true };
  });
}

import { and, eq, exists, getColumns, isNull, not, or, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, transaction, lockWorkspace } from './postgres.ts';
import { extractInteraction } from './contact-extraction.mjs';
import { suggestIdentityMatches } from './contacts.mjs';
import {
  affiliations,
  contact_identities,
  contacts,
  identity_reviews,
  interaction_participants,
  interactions,
  item_contacts,
  message_drafts,
  source_versions,
  sources,
} from './schema/index.ts';

type BeeperParticipant = { id?: string; fullName?: string };
type BeeperSnapshot = {
  chat?: { participants?: { items?: BeeperParticipant[] } };
  message?: { isSender?: boolean; senderName?: string };
};

const currentVersion = and(
  eq(source_versions.source_id, sources.id),
  eq(source_versions.content_hash, sources.content_hash),
);
// = ANY binds the list as one text[] parameter, however long it is.
const anyOf = (column: AnyPgColumn, ids: string[]) =>
  sql`${column} = ANY(${sql.param(ids)}::text[])`;
const linked = (
  table: typeof affiliations | typeof item_contacts | typeof message_drafts,
) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(table)
      .where(eq(table.contact_id, contacts.id)),
  );

// Repairs only untouched profiles produced by the old outgoing-sender fallback.
// Names are corrected within an existing provider identity; no people are merged.
export async function repairBeeperContactNames({ apply = false } = {}) {
  return transaction(async () => {
    if (apply) await lockWorkspace();
    const selves = await db
      .selectDistinct({
        account: sql<string | null>`r.raw->'chat'->>'accountID'`,
        external_key: sql<string | null>`p->>'id'`,
      })
      .from(sources)
      .innerJoin(source_versions, currentVersion)
      .crossJoinLateral(
        sql`(SELECT ${source_versions.raw_json}::jsonb AS raw) r`,
      )
      .crossJoinLateral(
        sql`jsonb_array_elements(r.raw->'chat'->'participants'->'items') p`,
      )
      .where(
        and(
          eq(sources.provider, 'beeper'),
          sql`(p->>'isSelf'='true' OR (r.raw->'message'->>'isSender'='true' AND p->>'id'=r.raw->'message'->>'senderID'))`,
        ),
      );
    const selfKeys = new Set(
      selves.map((p) => JSON.stringify([p.account, p.external_key])),
    );
    const manual = alias(sources, 'ms'),
      activity = alias(sources, 'es');
    const rows = await db
      .select({
        ...getColumns(contacts),
        identity_id: contact_identities.id,
        account: contact_identities.account,
        external_key: contact_identities.external_key,
        display_name: contact_identities.display_name,
        source_id: contact_identities.source_id,
        coverage: sources.coverage,
        raw_json: source_versions.raw_json,
        // The subquery's contact_identities shadows the joined one.
        identity_count: db.$count(
          contact_identities,
          eq(contact_identities.contact_id, contacts.id),
        ),
        has_links: sql<boolean>`${or(linked(affiliations), linked(item_contacts), linked(message_drafts))}`,
        has_manual_profile: sql<boolean>`${exists(
          db
            .select({ one: sql`1` })
            .from(manual)
            .where(
              and(
                eq(manual.provider, 'manual'),
                eq(
                  manual.external_id,
                  sql`'contact-profile-' || ${contacts.id}`,
                ),
              ),
            ),
        )}`,
        has_meaningful_activity: sql<boolean>`${exists(
          db
            .select({ one: sql`1` })
            .from(interaction_participants)
            .innerJoin(
              interactions,
              eq(interactions.id, interaction_participants.interaction_id),
            )
            .leftJoin(activity, eq(activity.id, interactions.source_id))
            .where(
              and(
                eq(interaction_participants.contact_id, contacts.id),
                or(
                  sql`${activity.provider} IS DISTINCT FROM 'beeper'`,
                  interactions.qualified,
                ),
              ),
            ),
        )}`,
      })
      .from(contacts)
      .innerJoin(
        contact_identities,
        eq(contact_identities.contact_id, contacts.id),
      )
      .innerJoin(sources, eq(sources.id, contact_identities.source_id))
      .innerJoin(source_versions, currentVersion)
      .where(
        and(
          eq(contact_identities.provider, 'beeper'),
          isNull(contacts.merged_into),
          not(contacts.archived),
        ),
      )
      .orderBy(contacts.id);
    const changes = [],
      skipped = [];
    for (const c of rows) {
      const raw: BeeperSnapshot = JSON.parse(c.raw_json),
        p = raw.chat?.participants?.items?.find((p) => p.id === c.external_key);
      const isSelf = selfKeys.has(JSON.stringify([c.account, c.external_key]));
      const person = extractInteraction(
        { provider: 'beeper', coverage: c.coverage },
        raw,
        [],
      )!.participants.find(
        (p: { external_id?: string }) => p.external_id === c.external_key,
      );
      const name = person?.name.slice(0, 200);
      const badFallback =
        p &&
        !p.fullName &&
        raw.message?.isSender === true &&
        c.name === raw.message.senderName &&
        c.display_name === c.name;
      if (
        !isSelf &&
        !(badFallback && name && name !== 'Beeper contact' && name !== c.name)
      )
        continue;
      const untouched =
        !c.confirmed &&
        c.version === 1 &&
        c.identity_count === 1 &&
        !c.has_manual_profile &&
        !c.has_links &&
        !c.tracked &&
        !c.paused &&
        !c.do_not_contact &&
        !c.snoozed_until &&
        !c.notes &&
        !c.role &&
        !(c.tags as unknown[]).length &&
        c.cadence_days === 30;
      if (!untouched || (isSelf && c.has_meaningful_activity)) {
        skipped.push(c.id);
        continue;
      }
      changes.push({
        id: c.id,
        identity_id: c.identity_id,
        before: c.name,
        after: isSelf ? c.name : name,
        archive: isSelf,
        email: c.email,
      });
    }
    const byId = new Map(changes.map((c) => [c.id, c])),
      ids = [...byId.keys()];
    const left = alias(contacts, 'l'),
      right = alias(contacts, 'h');
    const reviews = ids.length
      ? await db
          .select({
            id: identity_reviews.id,
            left_id: identity_reviews.left_id,
            right_id: identity_reviews.right_id,
            left_name: left.name,
            left_email: left.email,
            right_name: right.name,
            right_email: right.email,
          })
          .from(identity_reviews)
          .innerJoin(left, eq(left.id, identity_reviews.left_id))
          .innerJoin(right, eq(right.id, identity_reviews.right_id))
          .where(
            and(
              eq(identity_reviews.status, 'pending'),
              eq(
                identity_reviews.reason,
                'Same display name; may be different people.',
              ),
              or(
                anyOf(identity_reviews.left_id, ids),
                anyOf(identity_reviews.right_id, ids),
              ),
            ),
          )
      : [];
    const obsolete = reviews.filter((r) => {
      const left = byId.get(r.left_id),
        right = byId.get(r.right_id);
      return (
        left?.archive ||
        right?.archive ||
        ((left?.after || r.left_name).toLowerCase() !==
          (right?.after || r.right_name).toLowerCase() &&
          (!r.left_email ||
            r.left_email.toLowerCase() !== r.right_email.toLowerCase()))
      );
    });
    if (apply) {
      for (const c of changes) {
        await db
          .update(contacts)
          .set({
            name: c.after,
            archived: c.archive,
            version: sql`${contacts.version} + 1`,
            updated_at: sql`now()`,
          })
          .where(eq(contacts.id, c.id));
        if (!c.archive)
          await db
            .update(contact_identities)
            .set({ display_name: c.after })
            .where(eq(contact_identities.id, c.identity_id));
      }
      if (obsolete.length)
        await db
          .update(identity_reviews)
          .set({ status: 'obsolete' })
          .where(
            anyOf(
              identity_reviews.id,
              obsolete.map((r) => r.id),
            ),
          );
      for (const c of changes)
        if (!c.archive) await suggestIdentityMatches(c.id, c.after, c.email);
    }
    return {
      applied: apply,
      renamed: changes.filter((c) => !c.archive).length,
      archived_self_profiles: changes.filter((c) => c.archive).length,
      obsolete_name_reviews: obsolete.length,
      skipped_customized: skipped.length,
      changes,
    };
  });
}

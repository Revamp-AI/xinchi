import { and, eq, getColumns, isNull, sql } from 'drizzle-orm';
import {
  getSetting as readSetting,
  setSetting,
  transaction,
  lockWorkspace,
  hash,
  uid,
  stamp,
} from './db.ts';
import { db } from './postgres.ts';
import { mergeVerifiedEmployerContacts } from './contact-identity.ts';
import {
  companyKey,
  corporateDomain,
  plausibleEmployerDomain,
  verifyEmployerDomain,
} from './company-domain.mjs';
import { linkedinProfileUrl } from './linkedin-import.ts';
import {
  affiliations,
  contact_identities,
  contacts,
  identity_reviews,
  organizations,
  source_versions,
  sources,
} from './schema/index.ts';

// db.mjs is untyped: its getSetting infers the fallback as null. A setting
// holds whatever JSON the caller saved under that key.
const getSetting = readSetting as <T>(key: string, fallback?: T) => Promise<T>;
type AutoMatchState = {
  enabled?: boolean;
  lease?: string;
  lease_until?: string | null;
  last_run?: string;
  total_merged?: number;
  [key: string]: unknown;
};
type DomainEvidence = {
  verified: boolean;
  proof?: unknown;
  checked_at: string;
};
type LinkedinProfile = {
  name?: string;
  company?: string;
  profile_url?: string;
};
type Contact = typeof contacts.$inferSelect;
type Identity = typeof contact_identities.$inferSelect & {
  source_version_id: string | null;
  profile_fetched_at: string | null;
  profile: LinkedinProfile | null;
};
type Affiliation = typeof affiliations.$inferSelect & { company: string };
type MatchInputs = {
  contacts: Contact[];
  identities: Identity[];
  affiliations: Affiliation[];
  separate: { left_id: string; right_id: string }[];
};

const DAY = 86400000,
  STATE = 'contact_auto_match',
  CACHE = 'contact_employer_domain:';
export function personNameKey(value: unknown) {
  const name = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return !String(value).includes('@') && name.split(' ').length >= 2
    ? name
    : '';
}
export const employerDomainCacheKey = (company: string, domain: string) =>
  CACHE + hash([companyKey(company), domain]);
export async function autoMatchStatus() {
  const state = await getSetting<AutoMatchState>(STATE, {});
  const { lease, ...visible } = state;
  return {
    enabled: state.enabled !== false,
    ...visible,
    running: Date.parse(state.lease_until || '') > Date.now(),
  };
}
export async function setAutoMatchEnabled(enabled: unknown) {
  if (typeof enabled !== 'boolean')
    throw Error('Choose whether automatic matching is enabled.');
  return transaction(async () => {
    await lockWorkspace();
    const state = await getSetting<AutoMatchState>(STATE, {});
    await setSetting(STATE, { ...state, enabled });
    return autoMatchStatus();
  });
}
async function inputs(): Promise<MatchInputs> {
  const contactRows = await db
    .select()
    .from(contacts)
    .where(and(isNull(contacts.merged_into), eq(contacts.archived, false)));
  const identities = await db
    .select({
      ...getColumns(contact_identities),
      source_version_id: source_versions.id,
      profile_fetched_at: source_versions.fetched_at,
      profile: sql<LinkedinProfile | null>`${source_versions.raw_json}::jsonb->'linkedin_connection'`,
    })
    .from(contact_identities)
    .innerJoin(contacts, eq(contacts.id, contact_identities.contact_id))
    .leftJoin(
      sources,
      and(
        eq(sources.id, contact_identities.source_id),
        eq(contact_identities.provider, 'linkedin'),
      ),
    )
    .leftJoin(
      source_versions,
      and(
        eq(source_versions.source_id, sources.id),
        eq(source_versions.content_hash, sources.content_hash),
      ),
    )
    .where(and(isNull(contacts.merged_into), eq(contacts.archived, false)));
  const affiliationRows = await db
    .select({ ...getColumns(affiliations), company: organizations.name })
    .from(affiliations)
    .innerJoin(
      organizations,
      eq(organizations.id, affiliations.organization_id),
    );
  const separate = await db
    .select({
      left_id: identity_reviews.left_id,
      right_id: identity_reviews.right_id,
    })
    .from(identity_reviews)
    .where(eq(identity_reviews.status, 'separate'));
  return {
    contacts: contactRows,
    identities,
    affiliations: affiliationRows,
    separate,
  };
}
export function employerCandidates(
  { contacts, identities, affiliations, separate }: MatchInputs,
  now = Date.now(),
) {
  const byName = new Map<string, Contact[]>(),
    byContact = new Map<string, Identity[]>(),
    affiliationsByContact = new Map<string, Affiliation[]>(),
    blocked = new Set(
      separate.map((r) => [r.left_id, r.right_id].sort().join(':')),
    ),
    rows: {
      ids: string[];
      company: string;
      domain: string;
      profile_url: string | undefined;
      source_version_id: string | null;
      name: string;
      email: string | undefined;
    }[] = [];
  for (const c of contacts) {
    const key = personNameKey(c.name);
    if (key) {
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(c);
    }
  }
  for (const i of identities) {
    if (!byContact.has(i.contact_id)) byContact.set(i.contact_id, []);
    byContact.get(i.contact_id)!.push(i);
  }
  for (const a of affiliations) {
    if (!affiliationsByContact.has(a.contact_id))
      affiliationsByContact.set(a.contact_id, []);
    affiliationsByContact.get(a.contact_id)!.push(a);
  }
  for (const people of byName.values()) {
    // More than two same-name profiles is inherently ambiguous, even if one
    // currently happens to have the most convenient employer domain.
    if (people.length !== 2) continue;
    const pair = people.map((c) => c.id).sort();
    if (blocked.has(pair.join(':'))) continue;
    for (const linked of people) {
      const other = people.find((c) => c.id !== linked.id)!,
        linkedin = (byContact.get(linked.id) || []).filter(
          (i) => i.provider === 'linkedin',
        );
      if (
        linkedin.length !== 1 ||
        (byContact.get(other.id) || []).some((i) => i.provider === 'linkedin')
      )
        continue;
      const identity = linkedin[0]!,
        profile = identity.profile,
        company = profile?.company || '';
      if (
        !profile ||
        !linkedinProfileUrl(profile.profile_url) ||
        linkedinProfileUrl(identity.external_key) !==
          linkedinProfileUrl(profile.profile_url) ||
        personNameKey(profile.name) !== personNameKey(linked.name)
      )
        continue;
      const age = now - Date.parse(identity.profile_fetched_at || '');
      if (!Number.isFinite(age) || age < 0 || age > 90 * DAY) continue;
      const aff = affiliationsByContact.get(linked.id) || [];
      if (
        !aff.some(
          (a) =>
            companyKey(a.company) === companyKey(company) &&
            !a.ended_on &&
            (!a.started_on || Date.parse(a.started_on) <= now),
        )
      )
        continue;
      const otherAff = (affiliationsByContact.get(other.id) || []).filter(
        (a) => !a.ended_on,
      );
      if (
        otherAff.length &&
        otherAff.some((a) => companyKey(a.company) !== companyKey(company))
      )
        continue;
      if (
        (affiliationsByContact.get(other.id) || []).some(
          (a) => a.ended_on && companyKey(a.company) === companyKey(company),
        )
      )
        continue;
      const emails = [
          other.email,
          ...(byContact.get(other.id) || []).map((i) => i.address),
        ],
        domains = [...new Set(emails.map(corporateDomain).filter(Boolean))];
      if (domains.length !== 1) continue;
      const domain = domains.find((d) => plausibleEmployerDomain(company, d));
      if (!domain) continue;
      // A different work address on the LinkedIn profile is conflicting evidence.
      const linkedDomains = [
        linked.email,
        ...(byContact.get(linked.id) || []).map((i) => i.address),
      ]
        .map(corporateDomain)
        .filter(Boolean);
      if (linkedDomains.some((d) => d !== domain)) continue;
      rows.push({
        ids: pair,
        company,
        domain,
        profile_url: profile.profile_url,
        source_version_id: identity.source_version_id,
        name: linked.name,
        email: emails.find((e) => corporateDomain(e) === domain),
      });
    }
  }
  return rows.sort((a, b) => a.ids.join(':').localeCompare(b.ids.join(':')));
}
export async function previewEmployerMatches() {
  return employerCandidates(await inputs());
}
export async function runAutoContactMatching({
  force = false,
  verify = verifyEmployerDomain as (
    company: string,
    domain: string,
  ) => Promise<unknown>,
} = {}) {
  const lease = uid();
  const claimed = await transaction(async () => {
    await lockWorkspace();
    const state = await getSetting<AutoMatchState>(STATE, {});
    if (
      state.enabled === false ||
      Date.parse(state.lease_until || '') > Date.now() ||
      (!force && Date.now() - Date.parse(state.last_run || '') < 10 * 60000)
    )
      return false;
    await setSetting(STATE, {
      ...state,
      enabled: true,
      lease,
      lease_until: new Date(Date.now() + 120000).toISOString(),
    });
    return true;
  });
  if (!claimed) return { skipped: true, ...(await autoMatchStatus()) };
  let merged = 0,
    checked = 0,
    deferred = 0,
    failed = 0;
  const decisions: string[] = [];
  try {
    const candidates = await previewEmployerMatches();
    for (const candidate of candidates) {
      const key = employerDomainCacheKey(candidate.company, candidate.domain);
      let evidence = await getSetting<DomainEvidence | null>(key);
      const fresh =
        evidence &&
        Date.now() - Date.parse(evidence.checked_at) <
          (evidence.verified ? 30 * DAY : DAY);
      if (!fresh) {
        if (checked >= 5) {
          deferred++;
          continue;
        }
        checked++;
        try {
          const proof = await verify(candidate.company, candidate.domain);
          evidence = { verified: !!proof, proof, checked_at: stamp() };
        } catch {
          evidence = { verified: false, checked_at: stamp() };
        }
        await setSetting(key, evidence);
      }
      if (!evidence!.verified) continue;
      if (merged >= 30) {
        deferred++;
        continue;
      }
      try {
        const decision = await transaction(async () => {
          await lockWorkspace();
          const state = await getSetting<AutoMatchState>(STATE, {});
          if (
            state.enabled === false ||
            state.lease !== lease ||
            Date.parse(state.lease_until!) <= Date.now()
          )
            return;
          // Fresh inputs catch imports, source revisions, edits, new ambiguity and
          // keep-separate decisions made while the public website was loading.
          const current = (await previewEmployerMatches()).find(
            (c) => hash(c) === hash(candidate),
          );
          if (!current) return;
          return mergeVerifiedEmployerContacts(candidate.ids, {
            kind: 'linkedin-employer',
            ...candidate,
            website: evidence!.proof,
            matched_at: stamp(),
          });
        });
        if (decision) {
          merged++;
          decisions.push(decision.id!);
        }
      } catch {
        failed++;
      }
    }
    await transaction(async () => {
      await lockWorkspace();
      const state = await getSetting<AutoMatchState>(STATE, {});
      if (state.lease !== lease) return;
      await setSetting(STATE, {
        ...state,
        lease: '',
        lease_until: null,
        last_run: stamp(),
        last_merged: merged,
        total_merged: (state.total_merged || 0) + merged,
        checked_domains: checked,
        deferred,
        failed,
        error: '',
        decisions,
      });
    });
    return { merged, checked, deferred, failed, decisions };
  } catch (error) {
    await transaction(async () => {
      await lockWorkspace();
      const state = await getSetting<AutoMatchState>(STATE, {});
      if (state.lease === lease)
        await setSetting(STATE, {
          ...state,
          lease: '',
          lease_until: null,
          last_run: stamp(),
          error: 'Automatic matching was interrupted. Try again.',
          last_merged: merged,
        });
    });
    throw error;
  }
}

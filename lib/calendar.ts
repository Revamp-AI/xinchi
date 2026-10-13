import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getSetting } from './db.ts';
import { db } from './postgres.ts';
import { source_versions, sources } from './schema/index.ts';
import { secrets } from './secret-store.ts';

type CalendarTime = { dateTime?: string; date?: string; timeZone?: string };
type CalendarPerson = {
  displayName?: string;
  email?: string;
  responseStatus?: string;
  self?: boolean;
};
// The fields of a Google Calendar event that Focus reads.
export type CalendarEvent = {
  id: string;
  summary?: string;
  status?: string;
  htmlLink?: string;
  start?: CalendarTime;
  end?: CalendarTime;
  attendees?: CalendarPerson[];
  organizer?: CalendarPerson;
  recurringEventId?: string;
  originalStartTime?: CalendarTime;
  location?: string;
  description?: string;
};
export const CALENDAR_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly';
export function calendarGranted(
  grant: { refresh_token?: unknown; scope?: unknown } | null | undefined,
) {
  return Boolean(
    grant?.refresh_token &&
    String(grant.scope || '')
      .split(' ')
      .includes(CALENDAR_SCOPE),
  );
}
export function normalizeCalendar(event: CalendarEvent, zone = 'UTC') {
  const start = event.start?.dateTime || event.start?.date || '',
    end = event.end?.dateTime || event.end?.date || '';
  return {
    provider: 'calendar',
    external_id: 'primary:' + event.id,
    title: event.summary || 'Calendar event',
    occurred_at: start,
    url: event.htmlLink || '',
    coverage: 'calendar event',
    body: [
      'Calendar: primary',
      'Event ID: ' + event.id,
      'Title: ' + (event.summary || 'Calendar event'),
      'Status: ' + (event.status || 'confirmed'),
      'Start: ' + start,
      'End: ' + end,
      'Time zone: ' + (event.start?.timeZone || zone),
      'All day: ' + (event.start?.date ? 'yes' : 'no'),
      'Your response: ' +
        (event.attendees?.find((a) => a.self)?.responseStatus ||
          (event.organizer?.self ? 'organizer' : 'unknown')),
      event.recurringEventId
        ? 'Recurring event: ' + event.recurringEventId
        : '',
      event.originalStartTime
        ? 'Original instance start: ' +
          (event.originalStartTime.dateTime || event.originalStartTime.date)
        : '',
      event.organizer
        ? 'Organizer: ' +
          (event.organizer.displayName || '') +
          ' <' +
          (event.organizer.email || '') +
          '>'
        : '',
      ...(event.attendees || []).map(
        (a) =>
          'Attendee: ' +
          (a.displayName || '') +
          ' <' +
          (a.email || '') +
          '> (' +
          (a.responseStatus || 'unknown') +
          ')',
      ),
      event.location ? 'Location: ' + event.location : '',
      event.description ? 'Description:\n' + event.description : '',
      'Calendar attendance is context, not evidence of a promise or a hard deadline.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
export async function readCalendar({
  offset = 0,
  query = '',
}: { offset?: unknown; query?: string } = {}) {
  const grant = (await secrets()).calendar_tokens,
    synced = await getSetting('calendar_last_sync'),
    connected = calendarGranted(grant);
  const since = new Date(Date.now() - 30 * 86400000).toISOString(),
    until = new Date(Date.now() + 90 * 86400000).toISOString();
  const rows = await db
    .select({
      source_id: sources.id,
      source_version_id: source_versions.id,
      title: sources.title,
      body: sources.body,
      occurred_at: sources.occurred_at,
      updated_at: sources.updated_at,
    })
    .from(sources)
    .innerJoin(
      source_versions,
      and(
        eq(source_versions.source_id, sources.id),
        eq(source_versions.content_hash, sources.content_hash),
      ),
    )
    .where(
      and(
        eq(sources.provider, 'calendar'),
        gte(sources.occurred_at, since),
        lte(sources.occurred_at, until),
        query
          ? sql`to_tsvector('simple', ${sources.title} || ' ' || ${sources.body}) @@ plainto_tsquery('simple', ${query})`
          : undefined,
      ),
    )
    .orderBy(sources.occurred_at, sources.id)
    .limit(11)
    .offset(Math.max(0, Number(offset) || 0));
  return {
    connected,
    last_synced_at: synced?.at || null,
    stale:
      !connected || !synced || Date.now() - Date.parse(synced.at) > 30 * 60000,
    coverage:
      'Primary calendar; past 30 and next 90 days. Event dates can support preparation checkpoints only when tied to a promised output. Cancelled, declined and tentative events cannot establish deadlines.',
    events: rows.slice(0, 10),
    next_offset:
      rows.length > 10 ? Math.max(0, Number(offset) || 0) + 10 : null,
  };
}

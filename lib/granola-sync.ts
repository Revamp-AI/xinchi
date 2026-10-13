import { and, eq, inArray, sql } from 'drizzle-orm';
import { getSetting, stamp } from './db.ts';
import { db } from './postgres.ts';
import { source_versions, sources } from './schema/index.ts';
import { secrets } from './secret-store.ts';
import {
  granolaConnections,
  granolaWorkspaceCursor,
} from './granola-connections.mjs';

// The saved position of a Granola import: a listing page within one workspace.
type GranolaPosition = {
  pageToken?: string | null;
  cursor?: string | null;
  since?: string | null;
  started: string;
  rescan?: boolean;
  workspaceId?: string;
  workspaceIds?: string[];
};
type GranolaNote = { id: string; title?: string; updated_at?: string };

export async function granolaWindow({
  rescan = false,
}: { rescan?: boolean } = {}) {
  const saved = rescan ? null : await getSetting('granola_page');
  // Finish an existing page window exactly as saved. Every fresh run enumerates
  // all accessible IDs: sharing/processing need not advance a note's updated_at.
  const window = saved
    ? {
        ...saved,
        workspaceId: saved.workspaceId || 'default',
        cursor: saved.cursor || null,
      }
    : { cursor: null, since: null, started: stamp(), rescan };
  return {
    ...window,
    ...granolaWorkspaceCursor(window, granolaConnections(await secrets())),
  };
}
export function granolaCheckpoint(cursor: GranolaPosition) {
  return {
    cursor: cursor.pageToken ?? cursor.cursor ?? null,
    since: cursor.since ?? null,
    started: cursor.started,
    rescan: Boolean(cursor.rescan),
    workspaceId: cursor.workspaceId,
    workspaceIds: cursor.workspaceIds,
  };
}
export async function granolaCompletedSettings(cursor: { started: string }) {
  const previous = await getSetting('granola_since'),
    through = new Date(Date.parse(cursor.started) - 60000).toISOString();
  return {
    granola_page: null,
    granola_since:
      previous && Date.parse(previous) > Date.parse(through)
        ? previous
        : through,
  };
}
export async function granolaNotesToFetch<T extends GranolaNote>(
  notes: T[],
  { rescan = false }: { rescan?: boolean } = {},
) {
  if (rescan || !notes.length) return notes;
  const stored = await db
    .select({
      external_id: sources.external_id,
      title: sources.title,
      coverage: sources.coverage,
      provider_updated_at: sql<
        string | null
      >`${source_versions.raw_json}::jsonb->>'updated_at'`,
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
        eq(sources.provider, 'granola'),
        inArray(
          sources.external_id,
          notes.map((n) => n.id),
        ),
      ),
    );
  const byId = new Map(stored.map((s) => [s.external_id, s]));
  return notes.filter((note) => {
    const old = byId.get(note.id);
    // Incomplete coverage and missing version metadata must be checked again.
    return (
      !old ||
      old.coverage !== 'transcript' ||
      old.title !== (note.title || 'Untitled meeting') ||
      !note.updated_at ||
      !Number.isFinite(Date.parse(note.updated_at)) ||
      Date.parse(String(old.provider_updated_at)) !==
        Date.parse(note.updated_at)
    );
  });
}

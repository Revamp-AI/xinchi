import { getSetting, one, stamp } from './db.mjs';

// A Fireflies import window: transcripts up to boundary (and after since),
// read one at a time from skip.
type FirefliesPosition = {
  boundary: string;
  since?: string | null;
  skip: number;
  participant: string;
};
type Completion = { participant: string; through: string };

const OVERLAP_MS = 7 * 86400000;
const validDate = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const configurationError = (message: string) =>
  Object.assign(Error(message), {
    ingestionProviderError: true,
    permanent: true,
  });
function participantEmail() {
  const participant = (
    process.env.XIN_FIREFLIES_PARTICIPANT_EMAIL ||
    process.env.XIN_ALLOWED_EMAIL ||
    ''
  ).trim();
  if (!participant)
    throw configurationError(
      'Configure the workspace owner or XIN_FIREFLIES_PARTICIPANT_EMAIL before importing Fireflies.',
    );
  return participant;
}
async function lastCompletion(participant: string): Promise<Completion | null> {
  const saved = await getSetting('fireflies_sync');
  if (saved?.participant === participant && validDate(saved.through))
    return saved;
  // Existing durable imports already recorded their snapshot boundary and scope.
  // Adopt only a confirmed completion, never infer coverage from the newest source.
  const previous = await one(
    "SELECT d.cursor FROM durable_runs d JOIN sync_runs s ON s.id=d.run_id WHERE d.kind='sync' AND d.completed=true AND s.provider='fireflies' AND s.state='complete' AND d.cursor->>'phase'='done' AND d.cursor->>'participant'=? ORDER BY s.finished_at DESC LIMIT 1",
    participant,
  );
  return validDate(previous?.cursor?.boundary)
    ? { participant, through: previous.cursor.boundary }
    : null;
}
export async function firefliesWindow({
  rescan = false,
}: { rescan?: boolean } = {}) {
  const participant = participantEmail(),
    saved = rescan ? null : await getSetting('fireflies_page');
  if (saved?.participant === participant) {
    if (
      !validDate(saved.boundary) ||
      !Number.isSafeInteger(saved.skip) ||
      saved.skip < 0 ||
      (saved.since != null &&
        (!validDate(saved.since) ||
          Date.parse(saved.since) > Date.parse(saved.boundary)))
    )
      throw configurationError(
        'Fireflies saved progress is invalid. Use Rescan history to start a fresh import.',
      );
    return {
      boundary: saved.boundary,
      since: saved.since ?? null,
      skip: saved.skip,
      participant,
    };
  }
  const previous = rescan ? null : await lastCompletion(participant),
    boundary = stamp();
  return {
    boundary,
    since: previous
      ? new Date(
          Math.max(
            0,
            Math.min(Date.parse(previous.through), Date.parse(boundary)) -
              OVERLAP_MS,
          ),
        ).toISOString()
      : null,
    skip: 0,
    participant,
  };
}
export function firefliesCheckpoint(cursor: FirefliesPosition) {
  return {
    boundary: cursor.boundary,
    since: cursor.since ?? null,
    skip: cursor.skip,
    participant: cursor.participant,
  };
}
export async function firefliesCompletedSettings(
  cursor: Pick<FirefliesPosition, 'boundary' | 'participant'>,
) {
  const previous = await lastCompletion(cursor.participant);
  // Resuming an older failed run must not move a newer successful sync backwards.
  const through =
    previous && Date.parse(previous.through) > Date.parse(cursor.boundary)
      ? previous.through
      : cursor.boundary;
  return {
    fireflies_page: null,
    fireflies_sync: { participant: cursor.participant, through },
  };
}

import { and, eq, inArray, sql } from 'drizzle-orm';
import { uid, stamp } from './db.mjs';
import { db, transaction, lockWorkspace } from './postgres.ts';
import {
  import_chunks,
  import_records,
  import_uploads,
  sync_runs,
} from './schema/index.ts';
import { normalizeResearchArchive } from './imports.mjs';

// Parsed upload JSON. It is untrusted: normalizeRecord checks every field it keeps.
type UploadJson = any;
type UploadRecord = { doc: UploadJson; raw?: unknown };
// A durable file import's position: records are staged, then read one by one.
type ManualCursor = { phase?: string; next?: number; total?: number };

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_CHUNK_BYTES = 512 * 1024;
export const MAX_IMPORT_RECORD_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_RECORDS = 5000;
const MAX_PARTS = 1024;
const fail: (message: string) => never = (message) => {
  throw Object.assign(Error(message), {
    status: 400,
    manualImport: true,
    permanent: true,
  });
};
const validText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  !value.includes('\u0000');

async function uploadRun(id: unknown) {
  if (typeof id !== 'string' || !id || id.length > 100)
    fail('Choose a valid file upload.');
  const [row] = await db
    .select()
    .from(sync_runs)
    .where(and(eq(sync_runs.id, id), eq(sync_runs.provider, 'manual')))
    .for('update');
  const [upload] = row
    ? await db
        .select()
        .from(import_uploads)
        .where(eq(import_uploads.run_id, id))
    : [];
  if (!upload)
    fail('This file upload is no longer available. Choose the file again.');
  return { ...row!, ...upload };
}

export async function createManualUpload({
  format,
  title,
  bytes,
}: {
  format: string;
  title: string;
  bytes: number;
}) {
  if (!['json', 'text'].includes(format)) fail('Choose a JSON or text file.');
  if (!validText(title) || !title.trim() || title.length > 512)
    fail('Choose a file with a name of up to 512 characters.');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_IMPORT_BYTES)
    fail('Choose a non-empty file of up to 64 MiB.');
  return transaction(async () => {
    await lockWorkspace();
    const [active] = await db
      .select({ id: sync_runs.id })
      .from(sync_runs)
      .where(
        and(
          eq(sync_runs.provider, 'manual'),
          inArray(sync_runs.state, ['uploading', 'queued', 'running']),
        ),
      );
    if (active)
      fail(
        'A file import is already active. Wait for it to finish or cancel it.',
      );
    const id = uid(),
      date = stamp();
    await db.insert(sync_runs).values({
      id,
      provider: 'manual',
      state: 'uploading',
      started_at: date,
      updated_at: date,
      message: 'Uploading file',
    });
    await db
      .insert(import_uploads)
      .values({ run_id: id, format, title, expected_bytes: bytes });
    return { id };
  });
}

export async function appendManualChunk({
  id,
  part,
  content,
}: {
  id: string;
  part: number;
  content: string;
}) {
  if (!Number.isInteger(part) || part < 0 || part >= MAX_PARTS)
    fail('The file upload has an invalid part number.');
  if (
    !validText(content) ||
    !content.length ||
    Buffer.byteLength(content, 'utf8') > MAX_IMPORT_CHUNK_BYTES
  )
    fail(
      'File upload parts must contain valid text and be no larger than 512 KiB.',
    );
  return transaction(async () => {
    const upload = await uploadRun(id);
    if (upload.state !== 'uploading')
      fail('This file upload is already closed.');
    const [existing] = await db
      .select({ content: import_chunks.content })
      .from(import_chunks)
      .where(and(eq(import_chunks.run_id, id), eq(import_chunks.part, part)));
    if (existing && existing.content !== content)
      fail(
        'This file upload part differs from the saved part. Choose the file again.',
      );
    const received = (
      await db
        .select({
          bytes: sql<number>`coalesce(sum(octet_length(${import_chunks.content})), 0)`,
        })
        .from(import_chunks)
        .where(eq(import_chunks.run_id, id))
    )[0]!.bytes;
    const total =
      Number(received) + (existing ? 0 : Buffer.byteLength(content, 'utf8'));
    if (total > upload.expected_bytes || total > MAX_IMPORT_BYTES)
      fail('The uploaded file exceeds its declared size.');
    if (!existing)
      await db.insert(import_chunks).values({ run_id: id, part, content });
    await db
      .update(sync_runs)
      .set({
        updated_at: stamp(),
        message: `Uploading file: ${Math.floor((total * 100) / upload.expected_bytes)}%`,
      })
      .where(eq(sync_runs.id, id));
    return { id, part, received_bytes: total };
  });
}

export async function finishManualUpload({
  id,
  parts,
}: {
  id: string;
  parts: number;
}) {
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS)
    fail('The file upload has an invalid part count.');
  return transaction(async () => {
    const upload = await uploadRun(id);
    if (upload.state !== 'uploading') return { id, queued: true };
    const chunks = await db
      .select({
        part: import_chunks.part,
        bytes: sql<number>`octet_length(${import_chunks.content})`,
      })
      .from(import_chunks)
      .where(eq(import_chunks.run_id, id))
      .orderBy(import_chunks.part);
    if (
      chunks.length !== parts ||
      chunks.some((chunk, index) => chunk.part !== index)
    )
      fail('The file upload is incomplete. Retry the missing parts.');
    if (
      chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0) !==
      upload.expected_bytes
    )
      fail('The uploaded file size does not match. Choose the file again.');
    await db
      .update(sync_runs)
      .set({
        state: 'queued',
        message: 'File uploaded; import queued',
        updated_at: stamp(),
      })
      .where(eq(sync_runs.id, id));
    return { id, queued: true };
  });
}

export async function cancelManualUpload({ id }: { id: string }) {
  return transaction(async () => {
    const [row] = await db
      .select({ state: sync_runs.state })
      .from(sync_runs)
      .where(and(eq(sync_runs.id, id), eq(sync_runs.provider, 'manual')))
      .for('update');
    if (row?.state === 'uploading') {
      await db
        .update(sync_runs)
        .set({
          state: 'failed',
          message: 'Upload cancelled; choose the file again',
          updated_at: stamp(),
          finished_at: stamp(),
        })
        .where(eq(sync_runs.id, id));
      await db.delete(import_uploads).where(eq(import_uploads.run_id, id));
    }
    return { id, cancelled: row?.state === 'uploading' };
  });
}

function normalizeRecord({ doc, raw }: UploadRecord) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    fail('The file contains an invalid source record.');
  const provider = String(doc.provider || 'manual'),
    external_id = String(doc.external_id || '').trim();
  if (
    !['fireflies', 'granola', 'gmail', 'manual'].includes(provider) ||
    !external_id ||
    !doc.title
  )
    fail('Every source record needs a supported provider, ID, and title.');
  const normalized = {
    provider,
    external_id,
    title: String(doc.title),
    occurred_at: String(doc.occurred_at || ''),
    body: String(doc.body || ''),
    url:
      typeof doc.url === 'string' && /^https?:\/\//.test(doc.url)
        ? doc.url
        : '',
    coverage: String(doc.coverage || 'metadata'),
  };
  const record = { doc: normalized, raw: raw ?? doc };
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_IMPORT_RECORD_BYTES)
    fail(
      'Each source record must be no larger than 20 MiB after normalization.',
    );
  // PostgreSQL text/JSONB cannot represent NUL or unpaired Unicode surrogates.
  const visit = (value: unknown) => {
    if (typeof value === 'string' && !validText(value))
      fail('The file contains text that cannot be imported.');
    if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        if (!validText(key))
          fail('The file contains text that cannot be imported.');
        visit(item);
      }
  };
  visit(record);
  return record;
}

export async function prepareManualRecords(id: string) {
  return transaction(async () => {
    const upload = await uploadRun(id);
    if (!['queued', 'running'].includes(upload.state))
      fail('This file is not queued for import.');
    const staged = await db.$count(
      import_records,
      eq(import_records.run_id, id),
    );
    if (staged) return { total: staged };
    const text = (
      await db
        .select({ content: import_chunks.content })
        .from(import_chunks)
        .where(eq(import_chunks.run_id, id))
        .orderBy(import_chunks.part)
    )
      .map((chunk) => chunk.content)
      .join('');
    if (Buffer.byteLength(text, 'utf8') !== upload.expected_bytes)
      fail('The saved file is incomplete. Choose the file again.');
    let records: UploadRecord[];
    try {
      if (upload.format === 'text') {
        const doc = {
          provider: 'manual',
          external_id: id,
          title: upload.title,
          body: text,
          coverage: 'document',
          occurred_at: upload.started_at,
        };
        records = [{ doc, raw: doc }];
      } else {
        const parsed = JSON.parse(text);
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          ('fireflies_records' in parsed ||
            'granola_index' in parsed ||
            'tool_responses' in parsed)
        )
          records = normalizeResearchArchive(parsed);
        else
          records = (Array.isArray(parsed) ? parsed : [parsed]).map(
            (doc: UploadJson) => ({
              doc,
              raw: doc?.raw ?? doc,
            }),
          );
      }
      if (records.length > MAX_IMPORT_RECORDS)
        fail('Import an array of up to 5,000 source records.');
      records = records.map(normalizeRecord);
    } catch (error) {
      if ((error as { manualImport?: boolean }).manualImport) throw error;
      fail('The file is not a valid JSON source archive.');
    }
    if (records.length)
      await db
        .insert(import_records)
        .select(
          sql`SELECT ${id}, ordinality - 1, value FROM jsonb_array_elements(${JSON.stringify(records)}::jsonb) WITH ORDINALITY AS records(value, ordinality)`,
        )
        .onConflictDoNothing({
          target: [import_records.run_id, import_records.ordinal],
        });
    return { total: records.length };
  });
}

export async function advanceManual(
  id: string,
  cursor: ManualCursor | null = {},
) {
  cursor ||= {};
  if (cursor.phase !== 'records') {
    const { total } = await prepareManualRecords(id);
    return {
      cursor: { phase: 'records', next: 0, total },
      records: [],
      complete: total === 0,
      message: `File validated: ${total} source records`,
    };
  }
  // Checked just below.
  const { next, total } = cursor as { next: number; total: number };
  if (
    !Number.isInteger(next) ||
    !Number.isInteger(total) ||
    next < 0 ||
    next > total ||
    total > MAX_IMPORT_RECORDS
  )
    fail('The saved file import position is invalid.');
  if (next === total) return { cursor, records: [], complete: true };
  const [record] = await db
    .select({ payload: import_records.payload })
    .from(import_records)
    .where(
      and(eq(import_records.run_id, id), eq(import_records.ordinal, next)),
    );
  if (!record)
    fail('The staged file import is incomplete. Choose the file again.');
  return {
    cursor: { phase: 'records', next: next + 1, total },
    records: [record.payload],
    complete: next + 1 === total,
    message: `Importing file: ${next + 1} of ${total} records`,
  };
}

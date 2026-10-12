import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  all,
  one,
  run,
  transaction,
  lockWorkspace,
  uid,
  stamp,
  hash,
} from './db.mjs';
import { db } from './postgres.ts';
import {
  beeper_devices,
  beeper_pairings,
  beeper_uploads,
  import_records,
  sync_runs,
} from './schema/index.ts';

// Companion-supplied JSON. It is untrusted: normalizeBeeper checks every field it keeps.
type BeeperJson = any;
type BeeperMessage = { chat: BeeperJson; message: BeeperJson };
type SelectedChat = {
  id: string;
  accountID: string;
  title: string;
  network: string;
};

const owner = () =>
  String(process.env.XIN_ALLOWED_EMAIL || '')
    .trim()
    .toLowerCase();
const token = () => randomBytes(32).toString('base64url');
const fail: (message: string, status?: number) => never = (
  message,
  status = 400,
) => {
  throw Object.assign(Error(message), { status });
};
const string = (value: unknown, max = 1000): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  value.isWellFormed() &&
  !value.includes('\0');
const key = (value: unknown): value is string =>
  string(value) && value.length > 0;
const pairPattern = /^[A-Za-z0-9_-]{43}$/;
const issues: Record<string, string> = {
  offline: 'Open Beeper Desktop on your Mac to continue.',
  auth: 'Reconnect Beeper in the companion on your Mac.',
  sync: 'The companion could not finish this import. Check its status on your Mac.',
};

export async function beeperState() {
  const [d] = await db
    .select({
      id: beeper_devices.id,
      label: beeper_devices.label,
      selection: beeper_devices.selection,
      last_seen: beeper_devices.last_seen,
      requested: beeper_devices.requested,
      issue: beeper_devices.issue,
    })
    .from(beeper_devices)
    .where(
      and(
        isNull(beeper_devices.revoked_at),
        eq(beeper_devices.owner_email, owner()),
      ),
    )
    .orderBy(desc(beeper_devices.created_at))
    .limit(1);
  return d
    ? {
        configured: true,
        ...d,
        online: !!d.last_seen && Date.now() - Date.parse(d.last_seen) < 120000,
        issue: issues[d.issue] || '',
      }
    : { configured: false };
}
export async function createBeeperPairing() {
  if (!owner()) fail('Configure the workspace owner first.');
  const code = token();
  await transaction(async () => {
    await lockWorkspace();
    await db.delete(beeper_pairings);
    await db.insert(beeper_pairings).values({
      token_hash: hash(code),
      owner_email: owner(),
      expires_at: sql`now() + interval '10 minutes'`,
    });
  });
  return { code, expires_at: new Date(Date.now() + 600000).toISOString() };
}
async function revokeDevices() {
  await db
    .update(sync_runs)
    .set({
      state: 'failed',
      message: 'Companion disconnected; pair again to start a new import',
      finished_at: stamp(),
      updated_at: stamp(),
    })
    .where(
      and(
        inArray(
          sync_runs.id,
          db
            .select({ run_id: beeper_uploads.run_id })
            .from(beeper_uploads)
            .innerJoin(
              beeper_devices,
              eq(beeper_devices.id, beeper_uploads.device_id),
            )
            .where(isNull(beeper_devices.revoked_at)),
        ),
        eq(sync_runs.state, 'uploading'),
      ),
    );
  await db.delete(import_records).where(
    inArray(
      import_records.run_id,
      db
        .select({ run_id: beeper_uploads.run_id })
        .from(beeper_uploads)
        .innerJoin(sync_runs, eq(sync_runs.id, beeper_uploads.run_id))
        .where(
          and(eq(sync_runs.state, 'failed'), eq(beeper_uploads.sealed, false)),
        ),
    ),
  );
  await db
    .update(beeper_devices)
    .set({ revoked_at: sql`now()`, requested: false })
    .where(isNull(beeper_devices.revoked_at));
}
export async function revokeBeeper() {
  return transaction(async () => {
    await lockWorkspace();
    await revokeDevices();
    await db.delete(beeper_pairings);
    return { revoked: true };
  });
}
export async function pairBeeper({
  code,
  label,
  selection,
}: {
  code: string;
  label: string;
  selection: SelectedChat[];
}) {
  if (!pairPattern.test(code || ''))
    fail('Pairing code is invalid or expired.', 401);
  if (!string(label, 100) || !label.trim()) fail('Give this Mac a name.');
  if (!Array.isArray(selection) || !selection.length)
    fail('Select at least one direct conversation.');
  const selected = selection.map((c) => {
    if (
      !key(c.id) ||
      !key(c.accountID) ||
      !string(c.title, 300) ||
      !string(c.network, 100)
    )
      fail('Conversation selection is invalid.');
    return {
      id: c.id,
      accountID: c.accountID,
      title: c.title,
      network: c.network,
    };
  });
  if (
    new Set(selected.map((c) => JSON.stringify([c.accountID, c.id]))).size !==
    selected.length
  )
    fail('Choose each conversation once.');
  return transaction(async () => {
    await lockWorkspace();
    const [pairing] = await db
      .delete(beeper_pairings)
      .where(
        and(
          eq(beeper_pairings.token_hash, hash(code)),
          gt(beeper_pairings.expires_at, sql`now()`),
          eq(beeper_pairings.owner_email, owner()),
        ),
      )
      .returning({ owner_email: beeper_pairings.owner_email });
    if (!pairing)
      fail(
        'Pairing code is invalid or expired. Generate another code in Focus.',
        401,
      );
    await revokeDevices();
    const id = uid(),
      secret = token();
    await db.insert(beeper_devices).values({
      id,
      token_hash: hash(secret),
      owner_email: owner(),
      label: label.trim(),
      selection: selected,
      last_seen: sql`now()`,
    });
    return { id, token: secret };
  });
}
// Device credentials are accepted only by the dedicated ingestion routes. They
// never establish a browser session or grant archive/review/send-message access.
export async function requireBeeperDevice(req: Request) {
  const value = (req.headers.get('authorization') || '').match(
    /^Bearer ([A-Za-z0-9_-]{43})$/,
  )?.[1];
  const [d] = value
    ? await db
        .select({ id: beeper_devices.id })
        .from(beeper_devices)
        .where(
          and(
            eq(beeper_devices.token_hash, hash(value)),
            isNull(beeper_devices.revoked_at),
            eq(beeper_devices.owner_email, owner()),
          ),
        )
    : [];
  if (!d)
    fail('Companion access expired or was revoked. Pair again in Focus.', 401);
  return d.id;
}
async function deviceFor(id: string) {
  const [d] = await db
    .select()
    .from(beeper_devices)
    .where(
      and(
        eq(beeper_devices.id, id),
        isNull(beeper_devices.revoked_at),
        eq(beeper_devices.owner_email, owner()),
      ),
    )
    .for('update');
  if (!d) fail('Companion access was revoked.', 401);
  return d;
}
export async function requestBeeperSync() {
  return transaction(async () => {
    await lockWorkspace();
    const [d] = await db
      .select({ id: beeper_devices.id })
      .from(beeper_devices)
      .where(
        and(
          isNull(beeper_devices.revoked_at),
          eq(beeper_devices.owner_email, owner()),
        ),
      );
    if (!d) fail('Pair your Mac first.');
    await db
      .update(beeper_devices)
      .set({ requested: true })
      .where(eq(beeper_devices.id, d.id));
    return { queued: true };
  });
}
export async function beeperHeartbeat(
  id: string,
  { issue = '' }: { issue?: string } = {},
) {
  return transaction(async () => {
    const d = await deviceFor(id);
    await db
      .update(beeper_devices)
      .set({ last_seen: sql`now()`, issue: issues[issue] ? issue : '' })
      .where(eq(beeper_devices.id, id));
    const [active] = await db
      .select({
        id: sync_runs.id,
        state: sync_runs.state,
        message: sync_runs.message,
        started_at: sync_runs.started_at,
        part_count: beeper_uploads.part_count,
      })
      .from(sync_runs)
      .innerJoin(beeper_uploads, eq(beeper_uploads.run_id, sync_runs.id))
      .where(eq(beeper_uploads.device_id, id))
      .orderBy(desc(sync_runs.started_at))
      .limit(1);
    return { requested: d.requested, active: active || null };
  });
}
export async function beginBeeperUpload(
  id: string,
  { request_id }: { request_id: string },
) {
  if (!/^[a-f0-9-]{36}$/.test(request_id || ''))
    fail('Invalid import request.');
  return transaction(async () => {
    await lockWorkspace();
    await deviceFor(id);
    const [old] = await db
      .select({
        id: sync_runs.id,
        state: sync_runs.state,
        started_at: sync_runs.started_at,
        part_count: beeper_uploads.part_count,
      })
      .from(sync_runs)
      .innerJoin(beeper_uploads, eq(beeper_uploads.run_id, sync_runs.id))
      .where(
        and(eq(sync_runs.id, request_id), eq(beeper_uploads.device_id, id)),
      );
    if (old) return old;
    const [active] = await db
      .select({ id: sync_runs.id })
      .from(sync_runs)
      .where(
        and(
          eq(sync_runs.provider, 'beeper'),
          inArray(sync_runs.state, ['uploading', 'queued', 'running']),
        ),
      );
    if (active) fail('Beeper is still processing the previous import.', 409);
    await db.insert(sync_runs).values({
      id: request_id,
      provider: 'beeper',
      state: 'uploading',
      started_at: stamp(),
      updated_at: stamp(),
      message: 'Receiving selected conversations from your Mac',
    });
    await db
      .insert(beeper_uploads)
      .values({ run_id: request_id, device_id: id });
    await db
      .update(beeper_devices)
      .set({ requested: false })
      .where(eq(beeper_devices.id, id));
    return {
      id: request_id,
      state: 'uploading',
      started_at: stamp(),
      part_count: 0,
    };
  });
}

export function normalizeBeeper({ chat, message: m }: BeeperMessage) {
  if (
    !chat ||
    !m ||
    !key(chat.id) ||
    !key(chat.accountID) ||
    chat.type !== 'single' ||
    !key(m.id) ||
    m.chatID !== chat.id ||
    m.accountID !== chat.accountID ||
    !key(m.senderID)
  )
    fail('Beeper returned an invalid direct message.');
  if (
    !string(chat.title, 300) ||
    !string(chat.network, 100) ||
    !string(m.text ?? '', 120000) ||
    !string(m.senderName ?? '', 300) ||
    !string(m.linkedMessageID ?? '') ||
    !string(m.type ?? '', 30) ||
    typeof m.isSender !== 'boolean' ||
    !Number.isFinite(Date.parse(m.timestamp))
  )
    fail('Beeper message metadata is incomplete.');
  const participants = chat.participants?.items;
  if (!Array.isArray(participants) || participants.length > 100)
    fail('Beeper participant metadata is incomplete.');
  const people = participants.map((p) => {
    if (
      !key(p.id) ||
      !string(p.fullName ?? '', 300) ||
      !string(p.email ?? '', 300)
    )
      fail('Beeper participant metadata is invalid.');
    return {
      id: p.id,
      fullName: p.fullName || '',
      email: p.email || '',
      isSelf: p.isSelf === true,
      isNetworkBot: p.isNetworkBot === true,
    };
  });
  const raw = {
    chat: {
      id: chat.id,
      accountID: chat.accountID,
      title: chat.title,
      network: chat.network,
      type: 'single',
      participants: {
        items: people,
        hasMore: chat.participants.hasMore === true,
      },
    },
    message: {
      id: m.id,
      accountID: m.accountID,
      chatID: m.chatID,
      senderID: m.senderID,
      senderName: m.senderName || '',
      timestamp: new Date(m.timestamp).toISOString(),
      isSender: m.isSender,
      text: m.text || '',
      type: m.type || '',
      isDeleted: m.isDeleted === true,
      isHidden: m.isHidden === true,
      linkedMessageID: m.linkedMessageID || '',
    },
  };
  const deleted = raw.message.isDeleted || raw.message.isHidden,
    body = deleted
      ? 'This message was deleted or hidden upstream. Prior snapshots remain in the archive.'
      : m.text || '[Message content unavailable; attachments are not imported]';
  return {
    doc: {
      provider: 'beeper',
      external_id: hash([chat.accountID, chat.id, m.id]),
      title:
        (chat.network || 'Beeper') +
        ' · ' +
        (chat.title || 'Direct conversation'),
      occurred_at: raw.message.timestamp,
      url: '',
      coverage: deleted
        ? 'deleted upstream'
        : m.text
          ? 'message body'
          : 'metadata',
      body: [
        'From: ' + (m.isSender ? 'You' : m.senderName || m.senderID),
        'Conversation: ' + chat.title,
        '',
        body,
      ].join('\n'),
    },
    raw,
  };
}
export async function appendBeeperBatch(
  id: string,
  {
    run_id,
    part,
    records,
  }: { run_id: string; part: number; records: BeeperMessage[] },
) {
  if (
    !Number.isSafeInteger(part) ||
    part < 0 ||
    part > 20000 ||
    !Array.isArray(records) ||
    !records.length ||
    records.length > 25
  )
    fail('A Beeper batch must contain 1–25 messages.');
  const normalized = records.map(normalizeBeeper),
    digest = hash(normalized);
  return transaction(async () => {
    await lockWorkspace();
    const d = await deviceFor(id),
      u = await one(
        'SELECT u.*,s.state,s.started_at FROM beeper_uploads u JOIN sync_runs s ON s.id=u.run_id WHERE u.run_id=? AND u.device_id=? FOR UPDATE',
        run_id,
        id,
      );
    if (!u) fail('This import is unavailable.');
    if (part === u.part_count - 1 && digest === u.last_part_hash)
      return { part, received: u.record_count };
    if (u.state !== 'uploading' || u.sealed || part !== u.part_count)
      fail('The saved upload position changed.', 409);
    if (u.record_count + normalized.length > 100000)
      fail('This import exceeds 100,000 messages. Choose fewer conversations.');
    for (const r of normalized) {
      if (
        !(d.selection as SelectedChat[]).some(
          (c: SelectedChat) =>
            c.id === r.raw.chat.id && c.accountID === r.raw.chat.accountID,
        )
      )
        fail('This conversation was not selected.', 403);
      const age = Date.parse(u.started_at) - Date.parse(r.doc.occurred_at);
      if (age > 91 * 86400000 || age < -300000)
        fail('Messages must be within the selected 90-day window.');
    }
    await run(
      'INSERT INTO import_records(run_id,ordinal,payload) SELECT ?,?+ordinality-1,value FROM jsonb_array_elements(?::jsonb) WITH ORDINALITY AS records(value,ordinality)',
      run_id,
      u.record_count,
      JSON.stringify(normalized),
    );
    await run(
      'UPDATE beeper_uploads SET part_count=part_count+1,record_count=record_count+?,last_part_hash=? WHERE run_id=?',
      normalized.length,
      digest,
      run_id,
    );
    await run(
      'UPDATE sync_runs SET updated_at=?,message=? WHERE id=?',
      stamp(),
      u.record_count +
        normalized.length +
        ' messages received; saved on the server',
      run_id,
    );
    await run(
      "UPDATE focus_auth.beeper_devices SET last_seen=now(),issue='' WHERE id=?",
      id,
    );
    return { part, received: u.record_count + normalized.length };
  });
}
export async function finishBeeperUpload(
  id: string,
  { run_id, parts }: { run_id: string; parts: number },
) {
  return transaction(async () => {
    await lockWorkspace();
    await deviceFor(id);
    const u = await one(
      'SELECT * FROM beeper_uploads WHERE run_id=? AND device_id=? FOR UPDATE',
      run_id,
      id,
    );
    if (!u || parts !== u.part_count)
      fail('Upload is incomplete. Resume the companion.');
    if (!u.sealed) {
      await run('UPDATE beeper_uploads SET sealed=true WHERE run_id=?', run_id);
      await run(
        "UPDATE sync_runs SET state='queued',message='Upload saved; processing conversations',updated_at=? WHERE id=? AND state='uploading'",
        stamp(),
        run_id,
      );
    }
    return { id: run_id, queued: true };
  });
}
export async function advanceBeeper(
  id: string,
  cursor: { next?: number } | null | undefined,
) {
  const u = await one(
    'SELECT record_count,sealed FROM beeper_uploads WHERE run_id=?',
    id,
  );
  if (!u?.sealed) throw Error('Beeper upload is not complete.');
  const next = cursor?.next || 0;
  if (next >= u.record_count)
    return { cursor: { next }, records: [], complete: true };
  const r = await one(
    'SELECT payload FROM import_records WHERE run_id=? AND ordinal=?',
    id,
    next,
  );
  if (!r) throw Error('Beeper staging record is missing.');
  return {
    cursor: { next: next + 1 },
    records: [r.payload],
    complete: next + 1 === u.record_count,
    message: `Importing Beeper: ${next + 1} of ${u.record_count} messages`,
  };
}

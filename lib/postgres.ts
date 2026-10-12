import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

// Counts and legacy millisecond timestamps fit safely in JS numbers. Refuse loss of precision.
pg.types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw Error('Database integer exceeds safe precision.');
  return n;
});
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1184, (value) => new Date(value).toISOString());

// Drizzle's node-postgres driver reads timestamptz as raw text; keep the ISO
// strings the rest of the app (and the parser above) uses.
const codecs = {
  'timestamptz:string': {
    normalize: (value: string) => new Date(value).toISOString(),
  },
};

type Transaction = {
  client: pg.PoolClient;
  pending: Promise<unknown>;
  db?: NodePgDatabase;
};
const context = new AsyncLocalStorage<Transaction>();
let pool: pg.Pool | undefined, poolDb: NodePgDatabase | undefined;
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL)
      throw Error(
        'Set DATABASE_URL to your Focus Postgres database and run npm run db:migrate.',
      );
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
      allowExitOnIdle: true,
      application_name: 'focus',
    });
    pool.on('error', () => {}); // Request/worker operations report failures without logging connection credentials.
  }
  return pool;
}
// Existing parameterized queries use ?. Translate placeholders, never quoted text.
export function parameters(sql: string) {
  let n = 0,
    quote = '',
    out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) out += sql[++i];
        else quote = '';
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === '?') out += '$' + ++n;
    else out += c;
  }
  if (/^INSERT OR IGNORE /i.test(out))
    out =
      out.replace(/^INSERT OR IGNORE /i, 'INSERT ') + ' ON CONFLICT DO NOTHING';
  return out;
}
export async function query(
  sql: string,
  args: unknown[] = [],
): Promise<pg.QueryResult> {
  const tx = context.getStore();
  if (!tx) return getPool().query(parameters(sql), args);
  return enqueue(tx, () => tx.client.query(parameters(sql), args));
}
// Statements in a transaction run one at a time on its connection, and every
// one settles before COMMIT or ROLLBACK, even after an earlier one fails.
function enqueue<T>(tx: Transaction, statement: () => Promise<T>) {
  const result = tx.pending.then(statement);
  tx.pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export async function all<T = any>(sql: string, ...args: unknown[]) {
  return (await query(sql, args)).rows as T[];
}
export async function one<T = any>(sql: string, ...args: unknown[]) {
  return (await query(sql, args)).rows[0] as T | undefined;
}
export async function run(sql: string, ...args: unknown[]) {
  const r = await query(sql, args);
  return { changes: r.rowCount, rows: r.rows };
}
export async function transaction<T>(fn: () => T | Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (parent) return fn();
  const client = await getPool().connect(),
    tx: Transaction = { client, pending: Promise.resolve() };
  try {
    await client.query('BEGIN');
    const result = await context.run(tx, fn);
    await tx.pending;
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await tx.pending;
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
// The Postgres or connection error code behind e, including failures Drizzle
// wraps; undefined for application errors. Show a fixed message when it is set:
// a wrapped error's message contains the SQL and its parameters.
export function databaseErrorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (code) return String(code);
  if (e instanceof DrizzleQueryError)
    return databaseErrorCode(e.cause) ?? 'query';
  return undefined;
}
export async function lockWorkspace() {
  await one('SELECT id FROM workspace_lock WHERE id=1 FOR UPDATE');
}
export async function closeDatabase() {
  if (pool) {
    const old = pool;
    pool = undefined;
    poolDb = undefined;
    await old.end();
  }
}

// The Drizzle database for the current context: the pool outside
// transaction(), or the transaction's own connection inside it.
function current() {
  const tx = context.getStore();
  if (!tx) return (poolDb ??= drizzle({ client: getPool(), codecs }));
  return (tx.db ??= drizzle({ client: queued(tx), codecs }));
}
// A client that sends Drizzle's statements through the transaction's queue.
function queued(tx: Transaction) {
  return {
    query: (config: pg.QueryConfig, values?: unknown[]) =>
      enqueue(tx, () => tx.client.query(config, values)),
  } as unknown as pg.PoolClient;
}
export type Database = Omit<NodePgDatabase, 'transaction'> & {
  /** Runs fn inside transaction(); nested calls join the enclosing transaction. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
};
export const db: Database = new Proxy({} as Database, {
  get(_, key) {
    if (key === 'transaction')
      return <T>(fn: (tx: Database) => Promise<T>) => transaction(() => fn(db));
    const target = current();
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

import pg from 'pg';

/**
 * Database access.
 *
 * The only way to obtain a queryable handle is through `withActor` or
 * `withoutActor`. There is no exported pool and no exported `query`. That is
 * deliberate: it makes "I forgot to set the RLS actor" unrepresentable rather
 * than merely discouraged.
 *
 *   withActor(id, fn)   — opens a transaction, sets `app.actor_id` LOCAL to it,
 *                         runs `fn`, commits (or rolls back on throw).
 *   withoutActor(fn)    — no actor. Only the pre-authentication paths may use
 *                         this, and under RLS it can see almost nothing; the
 *                         SECURITY DEFINER auth functions are what it calls.
 *
 * The `local = true` argument to `set_config` is the load-bearing detail. It
 * scopes the setting to the transaction, so a connection returned to the pool
 * cannot carry one request's identity into the next request's queries. A
 * session-level `SET` here would be a cross-user data-disclosure bug that only
 * appears under concurrency.
 */

export interface Tx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface Database {
  withActor<T>(actorId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withoutActor<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly poolMax: number;
  /** Fail a query rather than hanging a request behind a lock, indefinitely. */
  readonly statementTimeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    idle_in_transaction_session_timeout: 15_000,
  });

  async function run<T>(actorId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (actorId !== null) {
        // Defence in depth against SQL injection via the actor id. The value
        // comes from a session row (not from user input), but it is
        // parameterized AND shape-checked because it lands in a session setting
        // that every RLS policy in the schema trusts.
        if (!UUID_RE.test(actorId)) {
          throw new Error('Refusing to set a non-UUID actor id on the database session.');
        }
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A rollback failure means the connection is unusable; releasing it
        // with an error tells the pool to discard rather than reuse it.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    withActor: (actorId, fn) => run(actorId, fn),
    withoutActor: (fn) => run(null, fn),
    close: () => pool.end(),
  };
}

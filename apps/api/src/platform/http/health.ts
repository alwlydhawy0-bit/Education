import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';

/**
 * Health probes: two endpoints, because they answer two different questions and
 * an orchestrator does two different things with the answers.
 *
 * ---------------------------------------------------------------------------
 * LIVENESS vs READINESS, AND WHY CONFLATING THEM CAUSES OUTAGES
 * ---------------------------------------------------------------------------
 *
 * LIVENESS — "is this process wedged?" A failure means RESTART ME. It must
 * therefore depend on NOTHING but the process itself. A liveness probe that
 * checks the database will fail for every replica the moment the database has a
 * bad thirty seconds, the orchestrator will kill every replica at once, and the
 * fleet will come back cold into a database that is already struggling. A
 * database blip becomes a total outage, caused entirely by the health check.
 *
 * READINESS — "should traffic come here right now?" A failure means STOP
 * SENDING ME REQUESTS, and is reversible without a restart. This is where
 * dependencies belong: a replica that cannot reach the database should be taken
 * out of the load balancer and put back when it can.
 *
 * So: `/health` answers from the process alone and always returns 200 while the
 * event loop turns. `/health/ready` checks the database and reports 503 when it
 * cannot be reached.
 *
 * ---------------------------------------------------------------------------
 * NEITHER SAYS ANYTHING USEFUL TO AN ATTACKER
 * ---------------------------------------------------------------------------
 *
 * Both are unauthenticated — they have to be; a probe has no session — so both
 * are reconnaissance surfaces. Neither returns a version, a hostname, a
 * dependency name, a driver error, or a duration. The readiness endpoint
 * distinguishes "ready" from "not ready" and that is the entire vocabulary: the
 * orchestrator needs one bit, and one bit is what it gets. WHY a replica is not
 * ready belongs in the logs, which require access to read.
 *
 * ---------------------------------------------------------------------------
 * THE READINESS CHECK IS MEMOISED, AND THAT IS A CONTROL
 * ---------------------------------------------------------------------------
 *
 * An unauthenticated endpoint that opens a database transaction is an
 * amplifier: one cheap HTTP request becomes one connection checkout, and a
 * flood of them exhausts the pool that real traffic needs — turning a probe
 * into the denial of service it was meant to detect. The result is cached for a
 * second, which is far shorter than any orchestrator's probe interval and far
 * longer than a flood's.
 */

/** Long enough to absorb a flood, short enough that no orchestrator notices. */
const READINESS_CACHE_MS = 1_000;

export interface HealthDeps {
  readonly database: Database;
  readonly now?: () => number;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  const now = deps.now ?? (() => Date.now());

  let cachedAt = 0;
  let cachedReady = false;
  let inFlight: Promise<boolean> | null = null;

  async function probeDatabase(): Promise<boolean> {
    try {
      // `withoutActor` is the pre-authentication handle. Under RLS it can see
      // almost nothing, which is exactly right for a probe: this asks whether
      // the connection works, not whether any particular row is readable.
      await deps.database.withoutActor(async (tx) => {
        await tx.query('SELECT 1');
      });
      return true;
    } catch {
      return false;
    }
  }

  async function isReady(): Promise<boolean> {
    const at = now();
    if (at - cachedAt < READINESS_CACHE_MS) return cachedReady;
    // Concurrent probes share one check rather than each opening a connection.
    inFlight ??= probeDatabase().finally(() => {
      inFlight = null;
    });
    cachedReady = await inFlight;
    cachedAt = now();
    return cachedReady;
  }

  app.get('/api/v1/health', async (_request, reply) => {
    // Deliberately says nothing about version, dependencies, or database state.
    // A health endpoint is unauthenticated, so it must not become a
    // reconnaissance surface.
    //
    // It also does not check anything. See the header: a liveness probe that
    // fails on a dependency outage restarts the entire fleet into it.
    reply.header('cache-control', 'no-store');
    return { status: 'ok' };
  });

  app.get('/api/v1/health/ready', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const ready = await isReady();
    if (!ready) {
      // 503 is the status a load balancer understands as "take me out of
      // rotation". The body carries no reason, for the same reason the liveness
      // body carries no version.
      reply.code(503);
      return { status: 'unavailable' };
    }
    return { status: 'ready' };
  });
}

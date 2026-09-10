import { Redis } from 'ioredis';

/**
 * A SHARED rate-limit store, and the honest account of what happens when it is
 * not there.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXES (RISK-RATE-01, open since Task 008)
 * ---------------------------------------------------------------------------
 *
 * `@fastify/rate-limit` counts in process memory by default. Every header at
 * the top of `rate-limit.ts` has said what that means for a real deployment:
 *
 *   - With N instances behind a load balancer the effective limit is N times
 *     the configured value. A login limit of 10 per 15 minutes across six
 *     replicas is a login limit of 60, and nothing anywhere says so.
 *   - Every deploy resets every counter, so an attacker's budget is refilled
 *     by the platform's own release process.
 *
 * A shared store makes the configured number the enforced number. That is the
 * entire point, and it is why this is a security control rather than a
 * performance one.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN DECISION THAT MATTERS: WHAT HAPPENS WHEN REDIS IS DOWN
 * ---------------------------------------------------------------------------
 *
 * There are three possible answers and only one of them is defensible.
 *
 *   FAIL OPEN — let every request through while the store is unreachable. This
 *   is `@fastify/rate-limit`'s own default (`skipOnError: true`) and it is
 *   wrong for a security control: it hands an attacker who can disturb Redis a
 *   switch that turns rate limiting off, and turns a cache outage into a
 *   credential-stuffing window. Rejected.
 *
 *   FAIL CLOSED — refuse every request with a 429 while the store is
 *   unreachable. Correct in the narrow sense and catastrophic in practice: a
 *   Redis restart takes the entire platform offline, including the login page
 *   the operator needs in order to fix it. A control whose failure mode is a
 *   full outage will be disabled by the first person on call, and then it
 *   protects nothing at all. Rejected.
 *
 *   DEGRADE — fall back to counting in this process, and say so loudly. The
 *   limit stops being global and becomes per-instance, which is exactly the
 *   posture the platform had before this file existed. Requests are still
 *   bounded, the site stays up, and a security event records the window during
 *   which the numbers were per-instance rather than shared. THIS IS WHAT IS
 *   IMPLEMENTED.
 *
 * Degradation is not failing open. The distinction is that the fallback still
 * enforces a limit — a weaker one — and that the weakening is recorded rather
 * than silent. `onDegraded` is called on the transition into and out of the
 * degraded state, not per request: an outage produces two events, not ten
 * thousand.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COUNTER IS A LUA SCRIPT
 * ---------------------------------------------------------------------------
 *
 * `INCR` followed by `PEXPIRE` is two round trips with a gap in between. If the
 * process dies in the gap — or the two land on either side of a failover — the
 * key exists with NO EXPIRY and the bucket never refills. Every subsequent
 * request from that address is rate limited forever, which is a permanent
 * denial of service against one user caused by the control meant to protect
 * them.
 *
 * The script does INCR, sets the expiry only on the transition from absent to
 * 1, and returns the remaining TTL, atomically. One round trip, no window.
 */

/**
 * KEYS[1] — the bucket. ARGV[1] — the window in milliseconds.
 *
 * Returns {count, remaining-ttl-ms}. The expiry is set only when the counter
 * came into existence on this call, so a burst cannot keep sliding the window
 * forward and make the limit unreachable.
 */
/** How often a degraded store checks whether it is back. */
const RECOVERY_PROBE_INTERVAL_MS = 5_000;

const INCR_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  -- Defensive: a key with no expiry would never refill. Repair it rather than
  -- reporting a bucket that is stuck.
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
return {count, ttl}
`;

export interface RateLimitStoreDeps {
  /** Called on entering and leaving the degraded state. Never per request. */
  readonly onDegraded: (degraded: boolean, detail: Record<string, unknown>) => void;
  /** Namespaces the keys, so two deployments sharing one Redis do not share buckets. */
  readonly keyPrefix: string;
}

/** The subset of a Redis client this store uses. Kept tiny so tests can fake it. */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: readonly (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

/**
 * What the plugin hands the constructor.
 *
 * `timeWindow` is `unknown` on purpose. The plugin's own type admits a function
 * as well as a number and a string, and narrowing here rather than restating
 * their union means a future widening on their side cannot silently start
 * flowing an unhandled shape into `parseWindowMs`.
 */
export interface FastifyStoreOptions {
  readonly timeWindow?: unknown;
}

export interface FastifyRateLimitStore {
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
  ): void;
  child(routeOptions: {
    method?: string | string[];
    path?: string;
    prefix?: string;
    timeWindow?: unknown;
  }): FastifyRateLimitStore;
}

/**
 * Per-process counting, used only while the shared store is unreachable.
 *
 * Entries are pruned on read rather than by a timer, matching `actorRateLimiter`
 * in `rate-limit.ts` — there is no interval to leak, and an idle process holds
 * nothing.
 */
class LocalCounter {
  private readonly hits = new Map<string, { count: number; expiresAt: number }>();

  incr(key: string, windowMs: number, now: number): { current: number; ttl: number } {
    const existing = this.hits.get(key);
    if (!existing || existing.expiresAt <= now) {
      const fresh = { count: 1, expiresAt: now + windowMs };
      this.hits.set(key, fresh);
      return { current: 1, ttl: windowMs };
    }
    existing.count += 1;
    return { current: existing.count, ttl: existing.expiresAt - now };
  }

  /** Bounded so a flood of distinct keys cannot grow the map without limit. */
  prune(now: number, max = 50_000): void {
    if (this.hits.size < max) return;
    for (const [key, entry] of this.hits) {
      if (entry.expiresAt <= now) this.hits.delete(key);
    }
  }
}

/**
 * Shared state for one application instance: the client, the degraded flag and
 * the fallback counter, so that every per-route child store observes the same
 * outage rather than each discovering it separately.
 */
class SharedState {
  degraded = false;
  /**
   * When the next recovery probe may run.
   *
   * Without it, every request during an outage probes, and a client that
   * reconnects for one command and drops again produces a degraded/recovered/
   * degraded run in the audit trail for a single outage. That was observed
   * during development, not imagined: the first version emitted three events
   * for one Redis restart.
   */
  nextProbeAt = 0;
  readonly local = new LocalCounter();
  readonly redis: RateLimitRedis;
  readonly deps: RateLimitStoreDeps;
  readonly now: () => number;

  // Written out rather than declared as constructor parameter properties: this
  // application runs under `node --experimental-strip-types`, which erases
  // annotations without transforming syntax, and a parameter property needs a
  // transform. It typechecks and then refuses to start. See rule 9 in
  // tests/architecture/dependency-rules.test.ts.
  constructor(redis: RateLimitRedis, deps: RateLimitStoreDeps, now: () => number) {
    this.redis = redis;
    this.deps = deps;
    this.now = now;
  }

  enterDegraded(error: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.deps.onDegraded(true, {
      // The MESSAGE only. A Redis error can carry the connection string, and a
      // connection string can carry a password.
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  leaveDegraded(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.deps.onDegraded(false, {});
  }
}

function parseWindowMs(window: unknown): number {
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) return window;
  if (typeof window === 'string') {
    const match = /^(\d+)\s*(millisecond|second|minute|hour)s?$/.exec(window.trim());
    if (match) {
      const amount = Number(match[1]);
      const unit = match[2];
      const scale =
        unit === 'millisecond'
          ? 1
          : unit === 'second'
            ? 1_000
            : unit === 'minute'
              ? 60_000
              : 3_600_000;
      return amount * scale;
    }
  }
  // The plugin normalizes `timeWindow` to milliseconds before constructing the
  // store, so reaching here means an unexpected shape. One minute is the
  // platform's global window and the safe assumption: too short a window would
  // weaken the limit, too long would strand a caller.
  return 60_000;
}

class RedisRateLimitStore implements FastifyRateLimitStore {
  private readonly state: SharedState;
  private readonly windowMs: number;
  private readonly namespace: string;

  constructor(state: SharedState, windowMs: number, namespace: string) {
    this.state = state;
    this.windowMs = windowMs;
    this.namespace = namespace;
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
  ): void {
    const now = this.state.now();
    // The bucket key carries the ROUTE as well as the caller. Without it every
    // route would share one counter, so the tightest limit on the platform
    // would be consumed by traffic to the loosest one.
    const bucket = `${this.state.deps.keyPrefix}:${this.namespace}:${key}`;

    if (this.state.degraded) {
      // While degraded the shared store is not consulted at all — a dead Redis
      // times out on every request, and doing that per request turns a cache
      // outage into a latency outage. Recovery is probed below, once the window
      // for the current attempt has passed.
      this.state.local.prune(now);
      callback(null, this.state.local.incr(bucket, this.windowMs, now));
      if (now >= this.state.nextProbeAt) {
        this.state.nextProbeAt = now + RECOVERY_PROBE_INTERVAL_MS;
        void this.probeRecovery(bucket);
      }
      return;
    }

    this.state.redis
      .eval(INCR_SCRIPT, 1, bucket, String(this.windowMs), String(this.windowMs))
      .then((raw) => {
        const [current, ttl] = raw as [number, number];
        callback(null, { current, ttl });
      })
      .catch((error: unknown) => {
        this.state.enterDegraded(error);
        this.state.local.prune(now);
        callback(null, this.state.local.incr(bucket, this.windowMs, now));
      });
  }

  /**
   * One cheap call to see whether the store is back. Failures here are expected
   * and silent — the degraded event was already recorded on the way in.
   */
  private async probeRecovery(bucket: string): Promise<void> {
    try {
      await this.state.redis.eval(INCR_SCRIPT, 1, `${bucket}:probe`, '1000', '1000');
      this.state.leaveDegraded();
    } catch {
      // Still down. Nothing to say that has not already been said.
    }
  }

  child(routeOptions: {
    method?: string | string[];
    path?: string;
    prefix?: string;
    timeWindow?: unknown;
  }): FastifyRateLimitStore {
    const method = Array.isArray(routeOptions.method)
      ? routeOptions.method.join('+')
      : (routeOptions.method ?? 'ALL');
    const path = `${routeOptions.prefix ?? ''}${routeOptions.path ?? ''}` || '*';
    const windowMs =
      routeOptions.timeWindow === undefined
        ? this.windowMs
        : parseWindowMs(routeOptions.timeWindow);
    return new RedisRateLimitStore(this.state, windowMs, `${method} ${path}`);
  }
}

/**
 * Build the store CONSTRUCTOR the plugin wants, closing over one client.
 *
 * `@fastify/rate-limit` takes a class and instantiates it itself, so the client
 * has to arrive by closure. That is also what makes the outage state shared:
 * every route's store is a child of the same `SharedState`.
 */
export function createRedisStoreCtor(
  redis: RateLimitRedis,
  deps: RateLimitStoreDeps,
  now: () => number = () => Date.now(),
): new (options: FastifyStoreOptions) => FastifyRateLimitStore {
  const state = new SharedState(redis, deps, now);
  return class BoundStore extends RedisRateLimitStore {
    constructor(options: FastifyStoreOptions) {
      super(state, parseWindowMs(options.timeWindow), 'global');
    }
  };
}

/**
 * Connect to Redis for rate limiting.
 *
 * `lazyConnect` plus a short, bounded retry is deliberate: a boot must not hang
 * on an unreachable cache, and a request must not wait 30 seconds to discover
 * one. If it is down the store degrades (see the header) rather than blocking.
 */
export async function connectRateLimitRedis(
  redis: { connect(): Promise<unknown> },
  timeoutMs = 3_000,
): Promise<boolean> {
  /**
   * CONNECT AT BOOT, NOT ON THE FIRST REQUEST.
   *
   * `lazyConnect` plus `enableOfflineQueue: false` means an unconnected client
   * REJECTS the first command rather than queueing it. Without this call the
   * first request of every process boot degrades the limiter, emits a
   * `ratelimit.store_degraded` event, and counts locally until the recovery
   * probe fires — a false alarm on every deploy, and a real (if brief) window
   * of per-instance counting. That is exactly what happened the first time this
   * store was exercised end to end.
   *
   * A failure here is NOT fatal. Refusing to boot because a cache is briefly
   * unavailable would make a Redis blip into an inability to deploy, and the
   * degraded path exists precisely so that it does not have to be.
   */
  try {
    await Promise.race([
      redis.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), timeoutMs).unref(),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function createRateLimitRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    // Bounded backoff. Without a cap ioredis reconnects roughly every 2ms at
    // first, which turns an outage into a self-inflicted connection flood.
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  });
}

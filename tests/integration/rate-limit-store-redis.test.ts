import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectRateLimitRedis,
  createRateLimitRedis,
  createRedisStoreCtor,
  type FastifyRateLimitStore,
} from '../../apps/api/src/platform/security/rate-limit-store.ts';

/**
 * THE LUA SCRIPT, AGAINST A REAL REDIS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS (defect injection round 15, F3)
 * ---------------------------------------------------------------------------
 *
 * `tests/unit/rate-limit-store.test.ts` replaces Redis with a fake that
 * INTERPRETS the script's contract rather than executing it. That fake is the
 * right tool for the outage behaviour — you cannot make a real server fail on
 * cue — and it has one blind spot that matters enormously: THE SCRIPT ITSELF IS
 * NEVER RUN.
 *
 * Round 15 proved the blind spot rather than theorising it. Changing the script
 * so `PEXPIRE` fires on every hit instead of only on the counter's creation —
 * which makes a sustained burst slide the window forward forever, so the limit
 * is never reached and rate limiting quietly stops existing — escaped every
 * suite in the repository.
 *
 * So these tests execute the real script against a real server. They are in the
 * `integration` project because they need one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCRIPT HAS TO GUARANTEE
 * ---------------------------------------------------------------------------
 *
 * 1. THE EXPIRY IS SET ON CREATION AND NEVER REFRESHED. A window that slides
 *    forward with each request is a window that never closes.
 *
 * 2. EVERY KEY CARRIES AN EXPIRY. `INCR` then `PEXPIRE` as two commands leaves
 *    a key with no TTL if the process dies between them — and that bucket never
 *    refills, permanently rate-limiting one caller with no way back. This is
 *    the whole reason the operation is a script rather than two round trips.
 *
 * 3. IT IS ATOMIC UNDER CONCURRENCY. Redis runs a script to completion before
 *    anything else, so N concurrent callers see N distinct counts with no lost
 *    updates.
 */
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

/*
 * THE CLIENT COMES FROM THE APPLICATION'S OWN FACTORY, NOT FROM `new Redis(...)`.
 *
 * Two reasons, one practical and one that matters more. The practical one:
 * `ioredis` is a dependency of `@edu/api`, not of the repository root, so a
 * bare `import { Redis } from 'ioredis'` here does not resolve.
 *
 * The one that matters: `createRateLimitRedis` is the client production
 * actually runs, with its own timeouts, retry strategy and offline-queue
 * setting. A client constructed locally with friendlier options would be
 * testing a configuration that is deployed nowhere.
 */
const redis = createRateLimitRedis(REDIS_URL);
const connected = connectRateLimitRedis(redis);

const PREFIX = 'edu:test:rl';

afterAll(async () => {
  if (await connected) {
    const keys = await redis.keys(`${PREFIX}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  /*
   * A MISSING REDIS FAILS THE SUITE; IT DOES NOT SKIP IT.
   *
   * A test that silently skips when its dependency is absent is a test that
   * reports success for a guarantee nobody checked — which is the exact failure
   * this file was written to close. If the server is not there, that is a
   * broken test environment and it should say so.
   */
  expect(
    await connected,
    `Redis is required for this suite. Start one, or set TEST_REDIS_URL. Tried ${REDIS_URL}.`,
  ).toBe(true);

  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
});

function makeStore(windowMs: number): FastifyRateLimitStore {
  const Ctor = createRedisStoreCtor(redis, { keyPrefix: PREFIX, onDegraded: () => undefined });
  return new Ctor({ timeWindow: windowMs });
}

function incr(store: FastifyRateLimitStore, key: string) {
  return new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    store.incr(key, (error, result) => {
      if (error || !result) reject(error ?? new Error('no result'));
      else resolve(result);
    });
  });
}

describe('the window is set on creation and never refreshed', () => {
  it('a sustained burst does not push the expiry forward', async () => {
    // THE DEFECT THIS CATCHES (F3): with PEXPIRE outside the `count == 1`
    // branch, every request resets the TTL to the full window. A caller sending
    // one request per second against a 60-second window would never see the
    // window close — the limit becomes unreachable and the control silently
    // stops existing.
    const store = makeStore(4_000);

    const first = await incr(store, 'burst');
    expect(first.current).toBe(1);
    expect(first.ttl).toBeGreaterThan(3_500);

    await new Promise((r) => setTimeout(r, 1_200));
    const second = await incr(store, 'burst');

    expect(second.current).toBe(2);
    // The TTL must have DECREASED by roughly the elapsed time, not reset.
    expect(second.ttl).toBeLessThan(first.ttl - 1_000);
  });

  it('the counter resets once the window has actually elapsed', async () => {
    const store = makeStore(1_200);
    expect((await incr(store, 'rollover')).current).toBe(1);
    expect((await incr(store, 'rollover')).current).toBe(2);

    await new Promise((r) => setTimeout(r, 1_500));
    // A fresh window, because the key expired rather than being renewed.
    expect((await incr(store, 'rollover')).current).toBe(1);
  });
});

describe('every key carries an expiry', () => {
  it('the bucket has a TTL immediately after the first hit', async () => {
    // Without this, a bucket created by a crash between INCR and PEXPIRE would
    // live forever and rate-limit one caller permanently.
    const store = makeStore(5_000);
    await incr(store, 'ttl-check');

    const key = (await redis.keys(`${PREFIX}*`)).find((k) => k.includes('ttl-check'));
    expect(key).toBeDefined();
    expect(await redis.pttl(key!)).toBeGreaterThan(0);
  });

  it('repairs a key that somehow has no expiry, rather than leaving it stuck', async () => {
    // The script's defensive branch. Simulated by creating the key with no TTL
    // exactly as an interrupted two-command sequence would have left it.
    const store = makeStore(3_000);
    const bucket = `${PREFIX}:global:orphan`;
    await redis.set(bucket, '5');
    expect(await redis.pttl(bucket)).toBe(-1); // no expiry

    const result = await incr(store, 'orphan');

    expect(result.current).toBe(6);
    expect(result.ttl).toBeGreaterThan(0);
    expect(await redis.pttl(bucket)).toBeGreaterThan(0);
  });
});

describe('the script is atomic', () => {
  it('twenty concurrent callers produce twenty distinct counts, with none lost', async () => {
    // Redis runs a script to completion before serving anything else, so this
    // is the property that makes INCR-then-PEXPIRE safe as one operation.
    const store = makeStore(10_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => incr(store, 'concurrent')),
    );

    const counts = results.map((r) => r.current).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('the store is shared, which is the point of using Redis at all', () => {
  it('two application instances against one server share a counter', async () => {
    // The same assertion the unit suite makes against a fake, made here against
    // the real thing: this is what closes RISK-RATE-01.
    const first = makeStore(10_000);
    const second = makeStore(10_000);

    expect((await incr(first, 'shared')).current).toBe(1);
    expect((await incr(second, 'shared')).current).toBe(2);
    expect((await incr(first, 'shared')).current).toBe(3);
  });

  it('keeps each route in its own bucket', async () => {
    const global = makeStore(10_000);
    const login = global.child({ method: 'POST', path: '/api/v1/auth/login', prefix: '' });

    await incr(global, '1.2.3.4');
    expect((await incr(login, '1.2.3.4')).current).toBe(1);
  });
});

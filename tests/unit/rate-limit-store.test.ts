import { describe, expect, it } from 'vitest';
import {
  createRedisStoreCtor,
  type FastifyRateLimitStore,
  type RateLimitRedis,
} from '../../apps/api/src/platform/security/rate-limit-store.ts';

/**
 * THE SHARED RATE-LIMIT STORE, WITH REDIS REPLACED BY SOMETHING THAT CAN BE
 * TOLD TO FAIL.
 *
 * A real Redis proves the happy path and cannot be made to fail on cue. The
 * behaviour worth testing here is the UNHAPPY path — what the limiter does
 * while the store is unreachable — because that is the branch a production
 * incident runs and the branch nobody exercises by accident.
 *
 * The fake is deliberately tiny: it implements the two methods the store
 * actually calls and interprets the Lua script's CONTRACT rather than its text.
 * It is not a Redis emulator and does not pretend to be; the atomicity the
 * script buys is a property of Redis, and the integration path is exercised
 * against the real server in the layered-defence suite.
 */
class FakeRedis implements RateLimitRedis {
  readonly keys = new Map<string, { count: number; expiresAt: number }>();
  failing = false;
  calls = 0;
  now = 1_000_000;

  async eval(_script: string, _numKeys: number, ...args: readonly (string | number)[]) {
    this.calls += 1;
    if (this.failing) throw new Error('connection refused');
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    const existing = this.keys.get(key);
    if (!existing || existing.expiresAt <= this.now) {
      this.keys.set(key, { count: 1, expiresAt: this.now + windowMs });
      return [1, windowMs];
    }
    existing.count += 1;
    return [existing.count, existing.expiresAt - this.now];
  }

  async quit() {
    return 'OK';
  }
}

function incr(
  store: FastifyRateLimitStore,
  key: string,
): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.incr(key, (error, result) => {
      if (error || !result) reject(error ?? new Error('no result'));
      else resolve(result);
    });
  });
}

function build(options: { onDegraded?: (d: boolean, x: Record<string, unknown>) => void } = {}) {
  const redis = new FakeRedis();
  const events: { degraded: boolean; detail: Record<string, unknown> }[] = [];
  const clock = { at: 5_000 };
  const Ctor = createRedisStoreCtor(
    redis,
    {
      keyPrefix: 'edu:rl',
      onDegraded: (degraded, detail) => {
        events.push({ degraded, detail });
        options.onDegraded?.(degraded, detail);
      },
    },
    () => clock.at,
  );
  return { redis, events, clock, Ctor };
}

describe('counting is shared, which is the entire point', () => {
  it('two application instances sharing one store share one counter', async () => {
    // The failure this closes: with per-process counting and six replicas, a
    // "10 logins per 15 minutes" limit enforces sixty, and nothing says so.
    const redis = new FakeRedis();
    const deps = { keyPrefix: 'edu:rl', onDegraded: () => undefined };
    const first = new (createRedisStoreCtor(redis, deps))({ timeWindow: 60_000 });
    const second = new (createRedisStoreCtor(redis, deps))({ timeWindow: 60_000 });

    expect((await incr(first, '1.2.3.4')).current).toBe(1);
    expect((await incr(first, '1.2.3.4')).current).toBe(2);
    expect((await incr(second, '1.2.3.4')).current).toBe(3);
  });

  it('gives each route its own bucket', async () => {
    // Without the route in the key, the tightest limit on the platform would be
    // consumed by traffic to the loosest one.
    const { redis, Ctor } = build();
    const global = new Ctor({ timeWindow: 60_000 });
    const login = global.child({ method: 'POST', path: '/api/v1/auth/login', prefix: '' });

    await incr(global, '1.2.3.4');
    await incr(global, '1.2.3.4');
    expect((await incr(login, '1.2.3.4')).current).toBe(1);
    expect([...redis.keys.keys()].sort()).toEqual([
      'edu:rl:POST /api/v1/auth/login:1.2.3.4',
      'edu:rl:global:1.2.3.4',
    ]);
  });

  it('namespaces every key, so two deployments on one Redis do not share buckets', async () => {
    const redis = new FakeRedis();
    const store = new (createRedisStoreCtor(redis, {
      keyPrefix: 'other-deployment',
      onDegraded: () => undefined,
    }))({ timeWindow: 60_000 });
    await incr(store, '1.2.3.4');
    expect([...redis.keys.keys()][0]).toMatch(/^other-deployment:/);
  });

  it('carries the route window down to the child store', async () => {
    const { Ctor } = build();
    const global = new Ctor({ timeWindow: 60_000 });
    const hourly = global.child({ method: 'GET', path: '/x', prefix: '', timeWindow: '1 hour' });
    expect((await incr(hourly, 'a')).ttl).toBe(3_600_000);
  });
});

describe('when the store is unreachable it DEGRADES — not open, not closed', () => {
  it('keeps enforcing a limit, counted in this process', async () => {
    // Fail-open would hand an attacker a switch that turns rate limiting off by
    // disturbing a cache. This still counts.
    const { redis, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    redis.failing = true;

    expect((await incr(store, '9.9.9.9')).current).toBe(1);
    expect((await incr(store, '9.9.9.9')).current).toBe(2);
    expect((await incr(store, '9.9.9.9')).current).toBe(3);
  });

  it('never reports an error to the limiter, so a cache outage is not a 500', async () => {
    // Fail-closed would take the login page down every time Redis restarts —
    // including for the operator trying to fix it.
    const { redis, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    redis.failing = true;
    await expect(incr(store, '9.9.9.9')).resolves.toBeDefined();
  });

  it('records the degradation once, on the transition — not once per request', async () => {
    const { redis, events, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    redis.failing = true;

    for (let i = 0; i < 20; i++) await incr(store, '9.9.9.9');
    // An outage produces an event, not ten thousand.
    expect(events.filter((e) => e.degraded)).toHaveLength(1);
  });

  it('reports only the error MESSAGE, because a Redis error can carry a password', async () => {
    const { redis, events, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    redis.failing = true;
    await incr(store, '9.9.9.9');
    expect(events[0]?.detail).toEqual({ reason: 'connection refused' });
  });

  it('stops calling a dead store on every request', async () => {
    // A dead network store times out per request; doing that per request turns
    // a cache outage into a latency outage.
    const { redis, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    redis.failing = true;
    await incr(store, '9.9.9.9');
    const afterFirstFailure = redis.calls;

    for (let i = 0; i < 10; i++) await incr(store, '9.9.9.9');
    // At most one recovery probe, gated by the cooldown — not ten more calls.
    expect(redis.calls - afterFirstFailure).toBeLessThanOrEqual(1);
  });

  it('comes back, and says so', async () => {
    const { redis, events, clock, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    redis.failing = true;
    await incr(store, '9.9.9.9');
    expect(events).toEqual([{ degraded: true, detail: { reason: 'connection refused' } }]);

    redis.failing = false;
    // Past the recovery-probe cooldown.
    clock.at += 10_000;
    await incr(store, '9.9.9.9');
    // The probe is asynchronous; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(events.at(-1)).toEqual({ degraded: false, detail: {} });
    // An investigation can now bound the window during which "10 per 15
    // minutes" did not mean what it says.
    expect(events).toHaveLength(2);
  });
});

describe('the window', () => {
  it('rolls over rather than sliding forward under a burst', async () => {
    const { redis, Ctor } = build();
    const store = new Ctor({ timeWindow: 60_000 });
    await incr(store, 'a');
    await incr(store, 'a');
    redis.now += 60_001;
    // A burst that kept pushing the expiry out would make the limit
    // unreachable; the expiry is set only when the counter is created.
    expect((await incr(store, 'a')).current).toBe(1);
  });

  it('falls back to one minute for a window shape it does not recognise', async () => {
    // The plugin normalises `timeWindow` before constructing the store, so this
    // is a defensive default. One minute is the platform's global window: too
    // short would weaken the limit, too long would strand a caller.
    const { Ctor } = build();
    const store = new Ctor({ timeWindow: (() => 5) as unknown as number });
    expect((await incr(store, 'a')).ttl).toBe(60_000);
  });
});

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../../apps/api/src/platform/http/health.ts';
import type { Database, Tx } from '../../apps/api/src/platform/db.ts';

/**
 * THE READINESS PROBE'S UNHAPPY PATH.
 *
 * A readiness endpoint is only worth having if it says "no" when the answer is
 * no, and that branch cannot be exercised against a working database. So the
 * database here is a fake that can be told to fail, and the routes are
 * registered on a bare Fastify instance — the real composition root's health
 * behaviour is the same code, and the surrounding suite in
 * tests/security/deployment-surface.test.ts checks it end to end.
 */
function fakeDatabase(state: { failing: boolean; calls: number }): Database {
  return {
    async withoutActor<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      state.calls += 1;
      if (state.failing) throw new Error('connection refused');
      return fn({
        query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }),
      } as unknown as Tx);
    },
    async withActor<T>(_actorId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return fn({} as Tx);
    },
    async close() {},
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function buildProbe(state: { failing: boolean; calls: number }, now?: () => number) {
  const instance = Fastify({ logger: false });
  registerHealthRoutes(instance, { database: fakeDatabase(state), ...(now ? { now } : {}) });
  await instance.ready();
  app = instance;
  return instance;
}

describe('liveness answers from the process alone', () => {
  it('returns 200 without touching the database', async () => {
    const state = { failing: true, calls: 0 };
    const instance = await buildProbe(state);
    const response = await instance.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    // THE POINT: the database is down and liveness still says 200. A liveness
    // probe that checked it would fail on every replica at once, the
    // orchestrator would restart the whole fleet, and it would come back cold
    // into a database that was already struggling. A dependency outage would
    // become a total outage, caused by the health check.
    expect(state.calls).toBe(0);
  });

  it('says nothing an attacker could use', async () => {
    const instance = await buildProbe({ failing: false, calls: 0 });
    const response = await instance.inject({ method: 'GET', url: '/api/v1/health' });
    // Unauthenticated by necessity — a probe has no session — so no version, no
    // hostname, no dependency name, no timing.
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('readiness answers for the dependencies', () => {
  it('returns 200 when the database is reachable', async () => {
    const state = { failing: false, calls: 0 };
    const instance = await buildProbe(state);
    const response = await instance.inject({ method: 'GET', url: '/api/v1/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    expect(state.calls).toBe(1);
  });

  it('returns 503 when it is not', async () => {
    const state = { failing: true, calls: 0 };
    const instance = await buildProbe(state);
    const response = await instance.inject({ method: 'GET', url: '/api/v1/health/ready' });

    // 503 is what a load balancer reads as "take me out of rotation" — and,
    // unlike a liveness failure, it is reversible without a restart.
    expect(response.statusCode).toBe(503);
  });

  it('reports the failure without describing it', async () => {
    const instance = await buildProbe({ failing: true, calls: 0 });
    const response = await instance.inject({ method: 'GET', url: '/api/v1/health/ready' });
    const body = response.body;

    expect(response.json()).toEqual({ status: 'unavailable' });
    // The orchestrator needs one bit and gets one bit. WHY a replica is not
    // ready belongs in the logs, which require access to read.
    expect(body).not.toContain('connection refused');
    expect(body).not.toContain('database');
    expect(body).not.toContain('postgres');
  });

  it('recovers without a restart', async () => {
    const state = { failing: true, calls: 0 };
    let clock = 1_000;
    const instance = await buildProbe(state, () => clock);

    expect((await instance.inject({ url: '/api/v1/health/ready' })).statusCode).toBe(503);
    state.failing = false;
    clock += 2_000;
    expect((await instance.inject({ url: '/api/v1/health/ready' })).statusCode).toBe(200);
  });
});

describe('the probe cannot be used to exhaust the connection pool', () => {
  it('checks the database at most once per second however often it is called', async () => {
    const state = { failing: false, calls: 0 };
    let clock = 1_000;
    const instance = await buildProbe(state, () => clock);

    for (let i = 0; i < 50; i++) {
      await instance.inject({ method: 'GET', url: '/api/v1/health/ready' });
    }
    // An unauthenticated endpoint that checks out a pooled connection is an
    // amplifier: one cheap HTTP request becoming one connection, and a flood
    // becoming the denial of service the probe exists to detect.
    expect(state.calls).toBe(1);

    clock += 1_500;
    await instance.inject({ method: 'GET', url: '/api/v1/health/ready' });
    // Still far shorter than any orchestrator's probe interval, so the cache is
    // invisible to the thing it serves.
    expect(state.calls).toBe(2);
  });

  it('is never cached by anything in front of it', async () => {
    const instance = await buildProbe({ failing: false, calls: 0 });
    for (const url of ['/api/v1/health', '/api/v1/health/ready']) {
      const response = await instance.inject({ method: 'GET', url });
      // A cached readiness answer is a load balancer sending traffic to a
      // replica that stopped being ready some time ago.
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });
});

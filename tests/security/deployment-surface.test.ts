import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, TEST_ORIGIN, type TestApp } from '../setup/app.ts';
import { closeSeedDb } from '../setup/fixtures.ts';
import { loadConfig } from '../../apps/api/src/platform/config.ts';
import { TEST_APP_URL } from '../setup/env.ts';

/**
 * THE SURFACE A DEPLOYMENT EXPOSES, exercised against the real application.
 *
 * Everything here is about what an UNAUTHENTICATED caller can see. The probes
 * have to be unauthenticated — an orchestrator has no session — which makes
 * them the one part of the API that answers anybody, and therefore the one part
 * where a leak needs no vulnerability at all, just an over-helpful response.
 */
let testApp: TestApp;
let app: FastifyInstance;

beforeAll(async () => {
  testApp = await buildTestApp();
  app = testApp.app;
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('the health probes are not a reconnaissance surface', () => {
  for (const url of ['/api/v1/health', '/api/v1/health/ready']) {
    it(`${url} answers with a status and nothing else`, async () => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(Object.keys(response.json() as object)).toEqual(['status']);
    });

    it(`${url} names no version, host, dependency or path`, async () => {
      const response = await app.inject({ method: 'GET', url });
      const body = response.body.toLowerCase();
      for (const leak of ['postgres', 'redis', 'fastify', 'node', 'version', '/app', 'edu_app']) {
        expect(body).not.toContain(leak);
      }
    });

    it(`${url} is reachable without a session, which is the point`, async () => {
      // If a probe required authentication it would report unhealthy for every
      // deployment, forever.
      const response = await app.inject({ method: 'GET', url, headers: {} });
      expect(response.statusCode).toBe(200);
    });
  }

  it('exposes no third health path that a future edit might make chattier', async () => {
    const routes = app.printRoutes({ commonPrefix: false });
    const healthPaths = [...routes.matchAll(/\/api\/v1\/health\S*/g)].map((m) => m[0]);
    // Two, deliberately: liveness and readiness. A `/health/detail` that listed
    // dependency states would be exactly the endpoint an attacker maps a
    // deployment with.
    expect(healthPaths.length).toBeLessThanOrEqual(2);
  });
});

describe('security headers are on every response, including the ones nobody authenticates for', () => {
  it('sets the full helmet set on a health response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).toContain("object-src 'none'");
  });

  it('sets them on a 404 as well as a 200', async () => {
    // A header applied by a route handler is a header missing from every path
    // that does not reach one.
    const response = await app.inject({ method: 'GET', url: '/api/v1/definitely-not-a-route' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('advertises no server software', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    // Fastify does not set `Server` by default; this is here so that adding a
    // plugin which does is a test failure rather than a silent change.
    expect(response.headers['server']).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('does not send HSTS in a non-hardened environment', async () => {
    // HSTS on a plaintext development origin pins a browser to https for a
    // year against a host that does not serve it — a self-inflicted outage on
    // the developer's own machine.
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('the configuration loader refuses a production posture that is not one', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: TEST_APP_URL,
    REDIS_URL: 'redis://cache.internal:6379',
    ALLOWED_ORIGINS: 'https://app.example.edu',
    SESSION_COOKIE_SECURE: 'true',
    RATE_LIMIT_ENABLED: 'true',
    LOG_LEVEL: 'info',
  };

  it('accepts a complete production posture', () => {
    expect(() => loadConfig(productionEnv)).not.toThrow();
  });

  it('refuses production without a shared rate-limit store', () => {
    const { REDIS_URL: _dropped, ...withoutRedis } = productionEnv;
    // The refusal added in Task 016. Without it, a fleet enforces N times the
    // configured limit and nothing anywhere says so.
    expect(() => loadConfig(withoutRedis)).toThrow(/REDIS_URL is required/);
  });

  it('applies the same refusal to staging', () => {
    const { REDIS_URL: _dropped, ...withoutRedis } = productionEnv;
    expect(() => loadConfig({ ...withoutRedis, NODE_ENV: 'staging' })).toThrow(/REDIS_URL/);
  });

  it('refuses blanket proxy trust before the server object exists', async () => {
    // `parseTrustProxy` runs at the top of buildApp, so a value that would make
    // every rate-limit bucket attacker-chosen fails the boot rather than
    // producing a server whose addresses cannot be trusted.
    await expect(buildTestApp({ TRUST_PROXY: 'true' })).rejects.toThrow(/blanket proxy trust/);
  });

  it('refuses a hop count, which Fastify would silently implement as "trust nothing"', async () => {
    await expect(buildTestApp({ TRUST_PROXY: '2' })).rejects.toThrow(/trusts no peer/);
  });
});

describe('the origin guard still governs everything else', () => {
  it('a state-changing request from an unknown origin is refused', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: { email: 'a@b.test', password: 'irrelevant' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('and the known origin is the configured one, not a wildcard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
      payload: { email: 'nobody@test.local', password: 'wrong-but-well-formed-password' },
    });
    // Reaches the handler and fails on credentials, not on the origin.
    expect(response.statusCode).not.toBe(403);
  });
});

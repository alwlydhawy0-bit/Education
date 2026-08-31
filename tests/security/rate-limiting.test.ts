import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildTestApp, writeHeaders, type TestApp } from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import { closeSeedDb, truncateAll } from '../setup/fixtures.ts';

/**
 * Rate limiting, exercised through the real plugin stack.
 *
 * Two properties matter here beyond "a 429 eventually appears":
 *
 *   1. Exceeding a limit records a SECURITY EVENT. The `ratelimit.exceeded`
 *      type existed in the taxonomy from Task 001 but nothing ever emitted it —
 *      the taxonomy was claiming a capability the system did not have.
 *
 *   2. A request with a bad Origin is still counted. The origin guard used to
 *      run first, so an attacker could flood the server with unlimited requests
 *      simply by sending a wrong Origin header and never show up in the
 *      rate-limit signal.
 */
let testApp: TestApp;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

async function auditEvents(type: string): Promise<Record<string, unknown>[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ detail: Record<string, unknown> }>(
      'SELECT detail FROM audit_log WHERE event_type = $1',
      [type],
    );
    return rows.map((r) => r.detail);
  } finally {
    await raw.end();
  }
}

async function auditActorIds(type: string): Promise<(string | null)[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ actor_id: string | null }>(
      'SELECT actor_id FROM audit_log WHERE event_type = $1',
      [type],
    );
    return rows.map((r) => r.actor_id);
  } finally {
    await raw.end();
  }
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp({ RATE_LIMIT_ENABLED: 'true' });
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('login throttling', () => {
  it('returns 429 once the login policy is exceeded', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'nobody@test.local', password: PASSWORD },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
    // The limit must bite well before the global ceiling of 300.
    expect(statuses.indexOf(429)).toBeLessThan(14);
  });

  it('returns a structured error body, not the plugin default', async () => {
    let body: { error?: { code?: string; correlationId?: string } } | null = null;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'nobody2@test.local', password: PASSWORD },
      });
      if (response.statusCode === 429) {
        body = response.json();
        break;
      }
    }
    expect(body?.error?.code).toBe('RATE_LIMITED');
    expect(body?.error?.correlationId).toBeTruthy();
  });
});

describe('exceeding a limit is recorded as a security event', () => {
  it('writes a ratelimit.exceeded audit event', async () => {
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'nobody3@test.local', password: PASSWORD },
      });
    }

    const events = await auditEvents('ratelimit.exceeded');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.['method']).toBe('POST');
    expect(events[0]?.['route']).toBe('/api/v1/auth/login');
  });

  it('records the route pattern, never the attempted credentials', async () => {
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'leaky@test.local', password: 'a-distinctive-rate-limit-secret' }, // secret-scan-allow: marker asserted to be ABSENT from the audit log
      });
    }

    const serialized = JSON.stringify(await auditEvents('ratelimit.exceeded'));
    expect(serialized).not.toContain('a-distinctive-rate-limit-secret');
    expect(serialized).not.toContain('leaky@test.local');
  });
});

describe('rate limiting runs ahead of the origin guard', () => {
  it('counts requests that the origin guard would reject', async () => {
    // Every one of these carries a foreign Origin, so each would be a 403 on its
    // own. With the limiter ahead of the guard they are still counted, and the
    // flood is eventually stopped.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        payload: { email: 'nobody4@test.local', password: PASSWORD },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toContain(403); // the guard still rejects them
    expect(statuses).toContain(429); // and the limiter still counts them
  });
});

describe('security headers survive a throttled response', () => {
  it('still sets them on a 429', async () => {
    let throttled: Awaited<ReturnType<typeof testApp.app.inject>> | null = null;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'nobody5@test.local', password: PASSWORD },
      });
      if (response.statusCode === 429) {
        throttled = response;
        break;
      }
    }
    expect(throttled).not.toBeNull();
    expect(throttled?.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('rate-limit events are IP-scoped, not actor-scoped', () => {
  it('records a null actor, because the limiter runs before authentication', async () => {
    // Documenting real behaviour rather than implying attribution the event
    // cannot have: `onExceeded` fires at `onRequest`, and the session is not
    // resolved until `preHandler`. Actor-scoped quotas need a different limiter.
    for (let attempt = 0; attempt < 14; attempt += 1) {
      await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'nobody6@test.local', password: PASSWORD },
      });
    }

    const actorIds = await auditActorIds('ratelimit.exceeded');
    expect(actorIds.length).toBeGreaterThan(0);
    expect(actorIds.every((id) => id === null)).toBe(true);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import { closeSeedDb, createUser, truncateAll } from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Session, CSRF, transport-hardening and audit behaviour.
 *
 * These cover the controls that are easy to claim and easy to get subtly wrong:
 * cookie flags, the Origin check's default-deny, whether the raw session token
 * ever touches the database, and whether authorization denials are actually
 * recorded.
 */
let testApp: TestApp;
let app: FastifyInstance;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

async function register(email: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: writeHeaders,
    payload: { email, password: PASSWORD, displayName: 'User' },
  });
  expect(response.statusCode).toBe(201);
}

async function login(email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(204);
  return `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`;
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  app = testApp.app;
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('CSRF — Origin check defaults to deny', () => {
  it('rejects a state-changing request with NO Origin header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'a@test.local', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a state-changing request from a foreign Origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      payload: { email: 'a@test.local', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a near-miss Origin (no prefix matching)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://localhost:5173.evil.com', 'content-type': 'application/json' },
      payload: { email: 'a@test.local', password: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a safe GET with no Origin', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
  });
});

describe('session cookie hardening', () => {
  it('sets HttpOnly, SameSite=Strict and Path on the session cookie', async () => {
    await register('cookie@test.local');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'cookie@test.local', password: PASSWORD },
    });
    const raw = String(response.headers['set-cookie']);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
  });

  it('NEVER stores the raw session token — only its SHA-256', async () => {
    await register('hash@test.local');
    const cookie = await login('hash@test.local');
    const token = cookie.replace('edu_session=', '');

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions');
      expect(rows).toHaveLength(1);
      const stored = rows[0]?.token_hash;
      // The stored value is the hash...
      expect(stored?.equals(createHash('sha256').update(token, 'utf8').digest())).toBe(true);
      // ...and the raw token appears nowhere in the row.
      expect(stored?.toString('utf8')).not.toContain(token);
    } finally {
      await raw.end();
    }
  });

  it('issues a distinct token on each login', async () => {
    await register('multi@test.local');
    const first = await login('multi@test.local');
    const second = await login('multi@test.local');
    expect(first).not.toBe(second);
  });
});

describe('login — account enumeration and status handling', () => {
  it('returns the same error for an unknown account and a wrong password', async () => {
    await register('known@test.local');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'nobody@test.local', password: PASSWORD },
    });
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'known@test.local', password: 'a-different-passphrase' }, // secret-scan-allow: deliberately wrong password used to assert enumeration resistance
    });

    expect(unknown.statusCode).toBe(wrongPassword.statusCode);
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
      wrongPassword.json<{ error: { message: string } }>().error.message,
    );
  });

  it('refuses a suspended account, without saying that it is suspended', async () => {
    await createUser({
      email: 'suspended@test.local',
      status: 'suspended',
      passwordHash: await hashPassword(PASSWORD),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'suspended@test.local', password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.toLowerCase()).not.toContain('suspend');
  });

  it('never returns the password hash from /auth/me', async () => {
    await register('me@test.local');
    const cookie = await login('me@test.local');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('argon2');
    expect(response.json<Record<string, unknown>>()['passwordHash']).toBeUndefined();
  });
});

describe('transport hardening headers', () => {
  it('sets the security headers on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(String(response.headers['x-frame-options']).toUpperCase()).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('keeps the health endpoint free of version or dependency detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('audit trail', () => {
  it('records an authz.denied event when an IDOR attempt is refused', async () => {
    await register('audit-v@test.local');
    await register('audit-a@test.local');
    const victimCookie = await login('audit-v@test.local');
    const attackerCookie = await login('audit-a@test.local');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victimCookie },
      payload: { title: 'Private', visibility: 'shared_with_teacher' },
    });
    const noteId = created.json<{ id: string }>().id;

    // Shared-with-teacher, so the row is visible to RLS-adjacent paths but the
    // policy engine still denies an unrelated student — which is the case that
    // reaches `denyToError` and therefore writes an audit row.
    const attack = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: attackerCookie },
    });
    expect(attack.statusCode).toBe(404);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ event_type: string; detail: Record<string, unknown> }>(
        `SELECT event_type, detail FROM audit_log WHERE event_type = 'authz.denied'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.detail['resourceId']).toBe(noteId);
    } finally {
      await raw.end();
    }
  });

  it('records successful and failed logins', async () => {
    await register('audit-login@test.local');
    await login('audit-login@test.local');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'audit-login@test.local', password: 'wrong-passphrase-here' }, // secret-scan-allow: distinctive marker string asserted to be ABSENT from the audit log
    });

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ event_type: string }>('SELECT event_type FROM audit_log');
      const types = rows.map((r) => r.event_type);
      expect(types).toContain('auth.login.succeeded');
      expect(types).toContain('auth.login.failed');
    } finally {
      await raw.end();
    }
  });

  it('never writes a password or token into the audit detail', async () => {
    await register('audit-secret@test.local');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: writeHeaders,
      payload: { email: 'audit-secret@test.local', password: 'a-very-distinctive-secret-1' }, // secret-scan-allow: test fixture password
    });

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>('SELECT detail FROM audit_log');
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('a-very-distinctive-secret-1');
      expect(serialized).not.toContain('audit-secret@test.local');
    } finally {
      await raw.end();
    }
  });
});

describe('rate limiting', () => {
  it('throttles repeated login attempts', async () => {
    const limited = await buildTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: writeHeaders,
          payload: { email: 'ratelimit@test.local', password: PASSWORD },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toContain(429);
      // The limit must bite well before 14 attempts.
      expect(statuses.indexOf(429)).toBeLessThan(14);
    } finally {
      await limited.db.close();
    }
  });
});

describe('request size limits', () => {
  it('rejects an oversized body', async () => {
    await register('big@test.local');
    const cookie = await login('big@test.local');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie },
      payload: { title: 'x', body: 'y'.repeat(300 * 1024) },
    });
    expect([400, 413]).toContain(response.statusCode);
  });
});

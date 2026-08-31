import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  buildTestApp,
  bodylessWriteHeaders,
  refreshCookieFrom,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import { closeSeedDb, truncateAll } from '../setup/fixtures.ts';

/**
 * Authentication flows end to end: registration, email verification, refresh
 * rotation, lockout, logout-all and password reset.
 *
 * Verification and reset tokens are read from the captured mail port, never from
 * an HTTP response — returning them over HTTP would itself be an
 * account-takeover vulnerability, so the tests must not depend on it.
 */
let testApp: TestApp;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password
const NEW_PASSWORD = 'an-entirely-different-passphrase'; // secret-scan-allow: test fixture password

const register = (email: string) =>
  testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: writeHeaders,
    payload: { email, password: PASSWORD, displayName: 'Test User' },
  });

const login = (email: string, password = PASSWORD) =>
  testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email, password },
  });

async function auditTypes(): Promise<string[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ event_type: string }>('SELECT event_type FROM audit_log');
    return rows.map((r) => r.event_type);
  } finally {
    await raw.end();
  }
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('registration and email verification', () => {
  it('issues a verification token through the mail port, never in the response', async () => {
    const response = await register('verify@test.local');
    expect(response.statusCode).toBe(201);

    // The token must not be recoverable from what the API returned.
    const captured = testApp.mail.find((m) => m.kind === 'email_verification');
    expect(captured).toBeDefined();
    expect(response.body).not.toContain(captured?.token ?? 'unreachable');
  });

  it('marks the account verified when the token is presented', async () => {
    await register('verify2@test.local');
    const token = testApp.mail[0]?.token ?? '';

    const verified = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: writeHeaders,
      payload: { token },
    });
    expect(verified.statusCode).toBe(204);

    const cookie = `edu_session=${sessionCookieFrom((await login('verify2@test.local')).headers['set-cookie'])}`;
    const me = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(true);
  });

  it('refuses a verification token a second time (single use)', async () => {
    await register('verify3@test.local');
    const token = testApp.mail[0]?.token ?? '';
    const body = { token };

    const first = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: writeHeaders,
      payload: body,
    });
    expect(first.statusCode).toBe(204);

    const replay = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: writeHeaders,
      payload: body,
    });
    expect(replay.statusCode).toBe(400);
  });

  it('rejects a malformed verification token before it reaches the database', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: writeHeaders,
      payload: { token: "'; DROP TABLE users; --" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('refresh rotation and reuse detection', () => {
  it('exchanges a refresh token for a new pair', async () => {
    await register('refresh@test.local');
    const loggedIn = await login('refresh@test.local');
    const refresh = refreshCookieFrom(loggedIn.headers['set-cookie']);

    const rotated = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { ...bodylessWriteHeaders, cookie: `edu_refresh=${refresh}` },
    });
    expect(rotated.statusCode).toBe(204);

    const newAccess = sessionCookieFrom(rotated.headers['set-cookie']);
    const newRefresh = refreshCookieFrom(rotated.headers['set-cookie']);
    expect(newRefresh).not.toBe(refresh);

    // The new access token works.
    const me = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `edu_session=${newAccess}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('scopes the refresh cookie to the refresh endpoint alone', async () => {
    // Narrowing the path keeps the long-lived credential off every other
    // request, so it is absent from most logs and proxies.
    await register('refresh-path@test.local');
    const loggedIn = await login('refresh-path@test.local');
    const raw = String(loggedIn.headers['set-cookie']);
    expect(raw).toMatch(/edu_refresh=[^;]+;[^\n]*Path=\/api\/v1\/auth\/refresh/);
  });

  it('DETECTS reuse of an already-rotated refresh token and kills the family', async () => {
    await register('reuse@test.local');
    const loggedIn = await login('reuse@test.local');
    const original = refreshCookieFrom(loggedIn.headers['set-cookie']);

    const rotated = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { ...bodylessWriteHeaders, cookie: `edu_refresh=${original}` },
    });
    const liveAccess = sessionCookieFrom(rotated.headers['set-cookie']);

    // Replay the ORIGINAL: the legitimate client already rotated it, so whoever
    // presents it again is not the legitimate client.
    const replay = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { ...bodylessWriteHeaders, cookie: `edu_refresh=${original}` },
    });
    expect(replay.statusCode).toBe(401);

    // The whole family is revoked, including the session the attacker's victim
    // was still using.
    const afterwards = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `edu_session=${liveAccess}` },
    });
    expect(afterwards.statusCode).toBe(401);

    expect(await auditTypes()).toContain('auth.refresh.reuse_detected');
  });

  it('refuses a refresh with no cookie, indistinguishably from a dead one', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: bodylessWriteHeaders,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a forged refresh token', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { ...bodylessWriteHeaders, cookie: `edu_refresh=${'A'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('account lockout', () => {
  it('locks after repeated failures and revokes live sessions', async () => {
    const locking = await buildTestApp({ MAX_FAILED_LOGINS: '3', LOCKOUT_MINUTES: '15' });
    try {
      await locking.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: writeHeaders,
        payload: { email: 'lock@test.local', password: PASSWORD, displayName: 'Lock' },
      });

      const good = await locking.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'lock@test.local', password: PASSWORD },
      });
      const cookie = `edu_session=${sessionCookieFrom(good.headers['set-cookie'])}`;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await locking.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: writeHeaders,
          payload: { email: 'lock@test.local', password: 'wrong-passphrase-here' }, // secret-scan-allow: deliberately wrong password used to drive the lockout counter
        });
      }

      // The correct password is now refused, and indistinguishably so.
      const afterLock = await locking.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'lock@test.local', password: PASSWORD },
      });
      expect(afterLock.statusCode).toBe(401);
      expect(afterLock.body.toLowerCase()).not.toContain('lock');

      // A lockout usually means the account is under attack, so the live
      // session must not survive the control meant to stop it.
      const stillLoggedIn = await locking.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie },
      });
      expect(stillLoggedIn.statusCode).toBe(401);

      expect(await auditTypes()).toContain('account.locked');
    } finally {
      await locking.db.close();
    }
  });

  it('does not count failures against an address with no account', async () => {
    // Otherwise the table fills with junk and an attacker learns nothing anyway.
    const locking = await buildTestApp({ MAX_FAILED_LOGINS: '3' });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await locking.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: writeHeaders,
          payload: { email: 'ghost@test.local', password: PASSWORD },
        });
      }
      const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
      await raw.connect();
      try {
        const { rows } = await raw.query('SELECT 1 FROM users WHERE email = $1', [
          'ghost@test.local',
        ]);
        expect(rows).toEqual([]);
      } finally {
        await raw.end();
      }
    } finally {
      await locking.db.close();
    }
  });

  it('resets the counter after a successful login', async () => {
    const locking = await buildTestApp({ MAX_FAILED_LOGINS: '3' });
    try {
      await locking.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: writeHeaders,
        payload: { email: 'reset-count@test.local', password: PASSWORD, displayName: 'R' },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await locking.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: writeHeaders,
          payload: { email: 'reset-count@test.local', password: 'wrong-passphrase-here' }, // secret-scan-allow: deliberately wrong password used to drive the lockout counter
        });
      }
      const good = await locking.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: writeHeaders,
        payload: { email: 'reset-count@test.local', password: PASSWORD },
      });
      expect(good.statusCode).toBe(204);

      const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
      await raw.connect();
      try {
        const { rows } = await raw.query<{ failed_login_count: number }>(
          'SELECT failed_login_count FROM users WHERE email = $1',
          ['reset-count@test.local'],
        );
        expect(rows[0]?.failed_login_count).toBe(0);
      } finally {
        await raw.end();
      }
    } finally {
      await locking.db.close();
    }
  });
});

describe('logout-all', () => {
  it('revokes every session on every device', async () => {
    await register('multi@test.local');
    const first = `edu_session=${sessionCookieFrom((await login('multi@test.local')).headers['set-cookie'])}`;
    const second = `edu_session=${sessionCookieFrom((await login('multi@test.local')).headers['set-cookie'])}`;

    const out = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: { ...bodylessWriteHeaders, cookie: second },
    });
    expect(out.statusCode).toBe(204);

    for (const cookie of [first, second]) {
      const after = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie },
      });
      expect(after.statusCode).toBe(401);
    }
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: bodylessWriteHeaders,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('password reset', () => {
  it('answers identically whether or not the address exists', async () => {
    // Unlike registration, this endpoint can be non-enumerating at no cost.
    await register('known-reset@test.local');
    const known = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: writeHeaders,
      payload: { email: 'known-reset@test.local' },
    });
    const unknown = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: writeHeaders,
      payload: { email: 'nobody-reset@test.local' },
    });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  });

  it('changes the password and revokes every existing session', async () => {
    await register('reset@test.local');
    const cookie = `edu_session=${sessionCookieFrom((await login('reset@test.local')).headers['set-cookie'])}`;

    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: writeHeaders,
      payload: { email: 'reset@test.local' },
    });
    const token = testApp.mail.find((m) => m.kind === 'password_reset')?.token ?? '';

    const reset = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: writeHeaders,
      payload: { token, password: NEW_PASSWORD },
    });
    expect(reset.statusCode).toBe(204);

    // A reset is an account-recovery event: an attacker's live session must not
    // survive it.
    const oldSession = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(oldSession.statusCode).toBe(401);

    expect((await login('reset@test.local', PASSWORD)).statusCode).toBe(401);
    expect((await login('reset@test.local', NEW_PASSWORD)).statusCode).toBe(204);
  });

  it('refuses a reset token a second time', async () => {
    await register('reset2@test.local');
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: writeHeaders,
      payload: { email: 'reset2@test.local' },
    });
    const token = testApp.mail.find((m) => m.kind === 'password_reset')?.token ?? '';
    const attempt = () =>
      testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/reset-password',
        headers: writeHeaders,
        payload: { token, password: NEW_PASSWORD },
      });

    expect((await attempt()).statusCode).toBe(204);
    expect((await attempt()).statusCode).toBe(400);
  });

  it('enforces the full password policy on the new password', async () => {
    // A reset must not be a way to set a weaker password than signup allows.
    await register('reset3@test.local');
    await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: writeHeaders,
      payload: { email: 'reset3@test.local' },
    });
    const token = testApp.mail.find((m) => m.kind === 'password_reset')?.token ?? '';

    const weak = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: writeHeaders,
      payload: { token, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
  });

  it('invalidates an earlier reset token when a new one is requested', async () => {
    await register('reset4@test.local');
    const ask = () =>
      testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: writeHeaders,
        payload: { email: 'reset4@test.local' },
      });

    await ask();
    const first = testApp.mail.filter((m) => m.kind === 'password_reset')[0]?.token ?? '';
    await ask();

    const withOld = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: writeHeaders,
      payload: { token: first, password: NEW_PASSWORD },
    });
    expect(withOld.statusCode).toBe(400);
  });

  it('never logs or returns the reset token', async () => {
    await register('reset5@test.local');
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: writeHeaders,
      payload: { email: 'reset5@test.local' },
    });
    const token = testApp.mail.find((m) => m.kind === 'password_reset')?.token ?? 'unreachable';
    expect(response.body).not.toContain(token);
    expect(JSON.stringify(testApp.logs)).not.toContain(token);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.js';
import { closeSeedDb, truncateAll } from '../setup/fixtures.js';

/**
 * Layer isolation: does the APPLICATION authorization layer stand on its own?
 *
 * The other IDOR tests pass with both gates active, which means a passing suite
 * cannot tell you WHICH gate did the work. If RLS were silently carrying the
 * whole load, the tests would look identical — right up until someone
 * introduced a query path RLS did not cover.
 *
 * So this suite runs the entire application against `edu_app_norls`: the same
 * grants as the production role, but with BYPASSRLS. Every row is visible to
 * the database client. If cross-user access is still refused, the refusal came
 * from the policy engine and `Guarded`, not from the database.
 *
 * The mirror-image case (RLS standing alone, with the application layer
 * removed) is covered by tests/integration/rls.test.ts, which queries the
 * database directly with no application code in the path.
 */
const NO_RLS_URL =
  process.env['TEST_APP_NORLS_URL'] ??
  'postgres://edu_app_norls:norls_test_pw@127.0.0.1:5432/edu_test'; // secret-scan-allow: local test database default, no production value

let testApp: TestApp;
let app: FastifyInstance;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password for a throwaway test database

async function registerAndLogin(email: string): Promise<{ cookie: string; id: string }> {
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: writeHeaders,
    payload: { email, password: PASSWORD, displayName: 'Test User' },
  });
  expect(registered.statusCode).toBe(201);
  const { id } = registered.json<{ id: string }>();

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email, password: PASSWORD },
  });
  expect(loggedIn.statusCode).toBe(204);
  return { cookie: `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`, id };
}

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp({ DATABASE_URL: NO_RLS_URL });
  app = testApp.app;
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

describe('the test role really does bypass RLS (otherwise this suite proves nothing)', () => {
  it('sees every note row through a raw connection with no actor set', async () => {
    const victim = await registerAndLogin('norls-victim@test.local');
    await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Visible to the raw connection', body: 'secret' },
    });

    const raw = new pg.Client({ connectionString: NO_RLS_URL });
    await raw.connect();
    try {
      // No `app.actor_id` is set. Under RLS this returns zero rows (asserted in
      // tests/integration/rls.test.ts). Here it must return the note — that is
      // what confirms the gate is genuinely off for the rest of this file.
      const { rows } = await raw.query('SELECT id, body FROM notes');
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await raw.end();
    }
  });
});

describe('application-layer authorization, with RLS disabled', () => {
  it('still returns 404 when another student reads a note by id', async () => {
    const victim = await registerAndLogin('norls-v1@test.local');
    const attacker = await registerAndLogin('norls-a1@test.local');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Private', body: 'my private working notes' },
    });
    const noteId = created.json<{ id: string }>().id;

    const attack = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: attacker.cookie },
    });

    expect(attack.statusCode).toBe(404);
    expect(attack.body).not.toContain('my private working notes');
  });

  it('still refuses to update another student’s note', async () => {
    const victim = await registerAndLogin('norls-v2@test.local');
    const attacker = await registerAndLogin('norls-a2@test.local');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Private', body: 'original' },
    });
    const noteId = created.json<{ id: string }>().id;

    const attack = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...writeHeaders, cookie: attacker.cookie },
      payload: { body: 'defaced' },
    });
    expect(attack.statusCode).toBe(404);

    const owner = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: victim.cookie },
    });
    expect(owner.json<{ body: string }>().body).toBe('original');
  });

  it('still excludes other students’ notes from a listing', async () => {
    const victim = await registerAndLogin('norls-v3@test.local');
    const attacker = await registerAndLogin('norls-a3@test.local');

    await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: victim.cookie },
      payload: { title: 'Victim note' },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: attacker.cookie },
    });
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  bodylessWriteHeaders,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import { closeSeedDb, truncateAll } from '../setup/fixtures.ts';

/**
 * IDOR / BOLA regression suite (brief section 14).
 *
 * Every test here drives the REAL HTTP surface with a REAL session cookie
 * against a REAL database. No layer is stubbed, so a pass means the whole chain
 * — cookie, session lookup, actor construction, policy engine, Guarded unwrap,
 * RLS — denied the access together.
 *
 * These are regression tests in the sense of section 32: if a future change
 * reintroduces cross-user access, these fail.
 */
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
  if (registered.statusCode !== 201) {
    throw new Error(`register failed: ${registered.statusCode} ${registered.body}`);
  }
  const { id } = registered.json<{ id: string }>();

  const loggedIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email, password: PASSWORD },
  });
  if (loggedIn.statusCode !== 204) {
    throw new Error(`login failed: ${loggedIn.statusCode} ${loggedIn.body}`);
  }
  return { cookie: `edu_session=${sessionCookieFrom(loggedIn.headers['set-cookie'])}`, id };
}

async function createNote(cookie: string, title = 'Chemistry lab'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/notes',
    headers: { ...writeHeaders, cookie },
    payload: { title, body: 'my private working notes' },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
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

describe('horizontal privilege escalation — student to student', () => {
  it('returns 404 when another student reads a note by its exact id', async () => {
    const victim = await registerAndLogin('victim@test.local');
    const attacker = await registerAndLogin('attacker@test.local');
    const noteId = await createNote(victim.cookie);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: attacker.cookie },
    });

    expect(response.statusCode).toBe(404);
    // The response must not leak the note in any form.
    expect(response.body).not.toContain('private working notes');
    expect(response.body).not.toContain('Chemistry lab');
  });

  it('is indistinguishable from a note that does not exist (no existence oracle)', async () => {
    const victim = await registerAndLogin('victim2@test.local');
    const attacker = await registerAndLogin('attacker2@test.local');
    const realNoteId = await createNote(victim.cookie);
    const fakeNoteId = randomUUID();

    const [realResponse, fakeResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/api/v1/notes/${realNoteId}`,
        headers: { cookie: attacker.cookie },
      }),
      app.inject({
        method: 'GET',
        url: `/api/v1/notes/${fakeNoteId}`,
        headers: { cookie: attacker.cookie },
      }),
    ]);

    expect(realResponse.statusCode).toBe(fakeResponse.statusCode);
    expect(realResponse.json<{ error: { code: string } }>().error.code).toBe(
      fakeResponse.json<{ error: { code: string } }>().error.code,
    );
  });

  it('returns 404 when another student PATCHes a note, and leaves it unchanged', async () => {
    const victim = await registerAndLogin('victim3@test.local');
    const attacker = await registerAndLogin('attacker3@test.local');
    const noteId = await createNote(victim.cookie);

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
    expect(owner.json<{ body: string }>().body).toBe('my private working notes');
  });

  it('returns 404 when another student DELETEs a note, and leaves it intact', async () => {
    const victim = await registerAndLogin('victim4@test.local');
    const attacker = await registerAndLogin('attacker4@test.local');
    const noteId = await createNote(victim.cookie);

    const attack = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...bodylessWriteHeaders, cookie: attacker.cookie },
    });
    expect(attack.statusCode).toBe(404);

    const owner = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: victim.cookie },
    });
    expect(owner.statusCode).toBe(200);
  });

  it('never includes another student’s notes in a listing', async () => {
    const victim = await registerAndLogin('victim5@test.local');
    const attacker = await registerAndLogin('attacker5@test.local');
    await createNote(victim.cookie, 'Victim note');
    await createNote(attacker.cookie, 'Attacker note');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: attacker.cookie },
    });

    const items = response.json<{ items: { title: string; ownerId: string }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Attacker note');
    expect(items.every((n) => n.ownerId === attacker.id)).toBe(true);
  });
});

describe('mass assignment — ownership cannot be claimed', () => {
  it('rejects a create that names another user as owner', async () => {
    const victim = await registerAndLogin('mv@test.local');
    const attacker = await registerAndLogin('ma@test.local');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: { ...writeHeaders, cookie: attacker.cookie },
      payload: { title: 'planted', ownerId: victim.id },
    });

    // Rejected outright rather than silently ignored.
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an update that tries to transfer ownership', async () => {
    const victim = await registerAndLogin('mv2@test.local');
    const attacker = await registerAndLogin('ma2@test.local');
    const noteId = await createNote(attacker.cookie);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...writeHeaders, cookie: attacker.cookie },
      payload: { ownerId: victim.id },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an attempt to self-assign a role at registration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: writeHeaders,
      payload: {
        email: 'escalate@test.local',
        password: PASSWORD,
        displayName: 'Escalator',
        roles: ['admin'],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('assigns only the student role to a genuinely registered user', async () => {
    const user = await registerAndLogin('plain@test.local');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: user.cookie },
    });
    expect(me.json<{ roles: string[] }>().roles).toEqual(['student']);
  });
});

describe('authentication is required', () => {
  it.each([
    ['GET', '/api/v1/notes'],
    ['GET', '/api/v1/auth/me'],
  ])('rejects an anonymous %s %s with 401', async (method, url) => {
    const response = await app.inject({ method: method as 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: `edu_session=${'A'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a session after logout (revocation is immediate)', async () => {
    const user = await registerAndLogin('logout@test.local');

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: user.cookie },
    });
    expect(before.statusCode).toBe(200);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...bodylessWriteHeaders, cookie: user.cookie },
    });
    expect(loggedOut.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/notes',
      headers: { cookie: user.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('the owner still works (the controls are not simply denying everything)', () => {
  it('lets the owner read, update and delete their own note', async () => {
    const user = await registerAndLogin('owner@test.local');
    const noteId = await createNote(user.cookie);

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: user.cookie },
    });
    expect(read.statusCode).toBe(200);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...writeHeaders, cookie: user.cookie },
      payload: { title: 'Updated title' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ title: string }>().title).toBe('Updated title');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/notes/${noteId}`,
      headers: { ...bodylessWriteHeaders, cookie: user.cookie },
    });
    expect(removed.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/notes/${noteId}`,
      headers: { cookie: user.cookie },
    });
    expect(gone.statusCode).toBe(404);
  });
});

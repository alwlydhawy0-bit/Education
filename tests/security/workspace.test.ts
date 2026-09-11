import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  bodylessWriteHeaders,
  buildTestApp,
  sessionCookieFrom,
  writeHeaders,
  type TestApp,
} from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createUnit,
  createUser,
  grantRole,
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * The student workspace, end to end over the real HTTP stack.
 *
 * Nothing is stubbed: the same composition root, the same policy engine, the
 * same `edu_app` role. This is the file section 2D of the task names, and every
 * scenario it lists is marked so a claim in the report traces to a test that
 * actually ran.
 *
 * The RLS half is `tests/integration/rls-workspace.test.ts`, with no
 * application code in the path; the decision tables are
 * `tests/unit/workspace-policy.test.ts`. None of the three is sufficient alone.
 */
const testApp: TestApp = await buildTestApp();

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

interface Session {
  readonly id: string;
  readonly cookie: string;
}

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
  globalSecurityAdmin?: boolean;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
  if (options.globalSecurityAdmin) await grantRole(user.id, 'security_admin', 'global', null);
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: writeHeaders,
    payload: { email: options.email, password: PASSWORD },
  });
  if (response.statusCode !== 204) {
    throw new Error(`login failed for ${options.email}: ${response.statusCode} ${response.body}`);
  }
  return {
    id: user.id,
    cookie: `edu_session=${sessionCookieFrom(response.headers['set-cookie'])}`,
  };
}

const get = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'GET', url, headers: { cookie } });

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  testApp.app.inject({
    method: 'POST',
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PUT', url, headers: { ...writeHeaders, cookie }, payload });

// `bodylessWriteHeaders` carries the Origin the CSRF guard needs but NOT a
// content-type: declaring `application/json` on a request with no body is a
// malformed request, and Fastify says so with a 400 before any handler runs.
const del = (url: string, cookie: string) =>
  testApp.app.inject({ method: 'DELETE', url, headers: { ...bodylessWriteHeaders, cookie } });

const items = <T>(r: { json: <U>() => U }) => r.json<{ items: T[] }>().items;

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

/**
 * One school, one class, one assigned course — and a second course assigned to
 * nobody, which is what makes the anchoring rule testable.
 */
async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');
  const level = await createEducationLevel();

  const learner = await seedAndLogin({
    email: 'learner@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const peer = await seedAndLogin({
    email: 'peer@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const teacher = await seedAndLogin({
    email: 'teacher@a.test',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const guardian = await seedAndLogin({
    email: 'guardian@a.test',
    roles: ['guardian'],
    organizationId: orgA,
  });
  const admin = await seedAndLogin({
    email: 'admin@a.test',
    roles: ['admin'],
    organizationId: orgA,
  });
  await grantRole(admin.id, 'admin', 'organization', orgA);
  const operator = await seedAndLogin({
    email: 'operator@platform.test',
    roles: ['security_admin'],
    organizationId: null,
    globalSecurityAdmin: true,
  });
  const stranger = await seedAndLogin({
    email: 'stranger@b.test',
    roles: ['student'],
    organizationId: orgB,
  });

  const curriculum = await createCurriculum({ organizationId: orgA, status: 'published' });
  const course = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    status: 'published',
  });
  const unit = await createUnit({ courseId: course, status: 'published' });
  const lesson = await createLesson({ unitId: unit, status: 'published' });

  const unassignedCourse = await createCourse({
    organizationId: orgA,
    curriculumId: curriculum,
    levelId: level,
    title: 'Unassigned',
    status: 'published',
  });
  const unassignedUnit = await createUnit({ courseId: unassignedCourse, status: 'published' });
  const unassignedLesson = await createLesson({ unitId: unassignedUnit, status: 'published' });

  const klass = await createClass(orgA, 'A1');
  await addClassMember(klass, learner.id);
  await addClassMember(klass, peer.id);
  await assignTeacher(teacher.id, klass);
  await assignCourseToClass({ classId: klass, courseId: course });
  await linkGuardian(guardian.id, learner.id, 'verified');

  return {
    orgA,
    learner,
    peer,
    teacher,
    guardian,
    admin,
    operator,
    stranger,
    course,
    lesson,
    unassignedCourse,
    unassignedLesson,
    klass,
  };
}

interface NotebookBody {
  id: string;
  ownerId: string;
  title: string;
  noteCount: number;
}
interface NoteBody {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  notebookId: string | null;
  lessonId: string | null;
}
interface ArtifactBody {
  id: string;
  ownerId: string;
  storageKey: string;
  byteSize: number;
}

async function makeNotebook(who: Session, title = 'Physics'): Promise<NotebookBody> {
  const r = await post('/api/v1/me/notebooks', who.cookie, { title });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<NotebookBody>();
}

async function makeNote(who: Session, payload: Record<string, unknown> = {}): Promise<NoteBody> {
  const r = await post('/api/v1/me/notes', who.cookie, { title: 'My note', ...payload });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<NoteBody>();
}

async function makeArtifact(
  who: Session,
  payload: Record<string, unknown> = {},
): Promise<ArtifactBody> {
  const r = await post('/api/v1/me/artifacts', who.cookie, {
    artifactType: 'image',
    declaredContentType: 'image/png',
    byteSize: 2048,
    ...payload,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json<ArtifactBody>();
}

beforeEach(truncateAll);

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

describe('A — the workspace works for the person it belongs to', () => {
  it('creates, lists, renames and deletes a notebook', async () => {
    const w = await world();
    const created = await makeNotebook(w.learner);
    expect(created.ownerId).toBe(w.learner.id);

    expect(items(await get('/api/v1/me/notebooks', w.learner.cookie))).toHaveLength(1);

    const renamed = await put(`/api/v1/me/notebooks/${created.id}`, w.learner.cookie, {
      title: 'Physics — term 2',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<NotebookBody>().title).toBe('Physics — term 2');

    expect((await del(`/api/v1/me/notebooks/${created.id}`, w.learner.cookie)).statusCode).toBe(
      204,
    );
    expect(items(await get('/api/v1/me/notebooks', w.learner.cookie))).toEqual([]);
  });

  it('files notes in a notebook and counts them', async () => {
    const w = await world();
    const book = await makeNotebook(w.learner);
    await makeNote(w.learner, { notebookId: book.id });
    await makeNote(w.learner, { notebookId: book.id, title: 'Second' });

    const [listed] = items<NotebookBody>(await get('/api/v1/me/notebooks', w.learner.cookie));
    expect(listed?.noteCount).toBe(2);
  });

  it('anchors a note to a lesson and reads it back by lesson', async () => {
    const w = await world();
    await makeNote(w.learner, { lessonId: w.lesson, title: 'Ohm' });
    await makeNote(w.learner, { title: 'Unrelated' });

    const byLesson = await get(`/api/v1/me/notes/lesson/${w.lesson}`, w.learner.cookie);
    expect(byLesson.statusCode).toBe(200);
    const found = items<NoteBody>(byLesson);
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('Ohm');
  });

  it('registers an artifact and reports the quota', async () => {
    const w = await world();
    const made = await makeArtifact(w.learner, { byteSize: 4096 });
    expect(made.ownerId).toBe(w.learner.id);

    const quota = await get('/api/v1/me/storage', w.learner.cookie);
    expect(quota.statusCode).toBe(200);
    const body = quota.json<{ usedBytes: number; quotaBytes: number; artifactCount: number }>();
    expect(body.usedBytes).toBe(4096);
    expect(body.artifactCount).toBe(1);
    expect(body.quotaBytes).toBeGreaterThan(body.usedBytes);
  });

  it('deletes a notebook WITHOUT deleting the notes filed in it', async () => {
    const w = await world();
    const book = await makeNotebook(w.learner);
    const note = await makeNote(w.learner, { notebookId: book.id });

    await del(`/api/v1/me/notebooks/${book.id}`, w.learner.cookie);

    const survivor = await get(`/api/v1/me/notes/${note.id}`, w.learner.cookie);
    expect(survivor.statusCode).toBe(200);
    expect(survivor.json<NoteBody>().notebookId).toBeNull();
  });
});

describe('B — §2D: a student cannot reach another student’s notebook', () => {
  it('refuses reading, updating and deleting it, with 404 every time', async () => {
    const w = await world();
    const theirs = await makeNotebook(w.learner);

    expect((await get(`/api/v1/me/notebooks/${theirs.id}`, w.peer.cookie)).statusCode).toBe(404);
    expect(
      (await put(`/api/v1/me/notebooks/${theirs.id}`, w.peer.cookie, { title: 'Taken' }))
        .statusCode,
    ).toBe(404);
    expect((await del(`/api/v1/me/notebooks/${theirs.id}`, w.peer.cookie)).statusCode).toBe(404);

    // And nothing changed.
    const still = await get(`/api/v1/me/notebooks/${theirs.id}`, w.learner.cookie);
    expect(still.json<NotebookBody>().title).toBe('Physics');
  });

  it('never lists it', async () => {
    const w = await world();
    await makeNotebook(w.learner);
    expect(items(await get('/api/v1/me/notebooks', w.peer.cookie))).toEqual([]);
  });

  it('answers 404 identically for a notebook that does not exist', async () => {
    // The two answers must be indistinguishable, or the API is an oracle for
    // which ids are real.
    const w = await world();
    const theirs = await makeNotebook(w.learner);
    const nothing = '00000000-0000-4000-8000-000000000000';

    const a = await get(`/api/v1/me/notebooks/${theirs.id}`, w.peer.cookie);
    const b = await get(`/api/v1/me/notebooks/${nothing}`, w.peer.cookie);
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json<{ error: { code: string } }>().error.code).toBe(
      b.json<{ error: { code: string } }>().error.code,
    );
  });
});

describe('C — §2D: a student cannot reach another student’s note', () => {
  it('refuses reading, updating and deleting it', async () => {
    const w = await world();
    const theirs = await makeNote(w.learner, { body: 'my working out' });

    expect((await get(`/api/v1/me/notes/${theirs.id}`, w.peer.cookie)).statusCode).toBe(404);
    expect(
      (await put(`/api/v1/me/notes/${theirs.id}`, w.peer.cookie, { body: 'edited' })).statusCode,
    ).toBe(404);
    expect((await del(`/api/v1/me/notes/${theirs.id}`, w.peer.cookie)).statusCode).toBe(404);

    const still = await get(`/api/v1/me/notes/${theirs.id}`, w.learner.cookie);
    expect(still.json<NoteBody>().body).toBe('my working out');
  });

  it('refuses filing a note into another student’s notebook', async () => {
    const w = await world();
    const theirs = await makeNotebook(w.learner);
    const response = await post('/api/v1/me/notes', w.peer.cookie, {
      title: 'sneaky',
      notebookId: theirs.id,
    });
    // 404, not 422: confirming the notebook id is real is the bit being fished
    // for. The composite foreign key is what refuses; the service maps it.
    expect(response.statusCode).toBe(404);
  });

  it('refuses MOVING an existing note into another student’s notebook', async () => {
    const w = await world();
    const theirs = await makeNotebook(w.learner);
    const mine = await makeNote(w.peer);
    expect(
      (await put(`/api/v1/me/notes/${mine.id}`, w.peer.cookie, { notebookId: theirs.id }))
        .statusCode,
    ).toBe(404);
  });
});

describe('D — §2D: a teacher, guardian, admin or operator cannot read private notes', () => {
  it('refuses all four on a private note', async () => {
    const w = await world();
    const note = await makeNote(w.learner, { body: 'private thoughts' });
    for (const who of [w.teacher, w.guardian, w.admin, w.operator, w.stranger]) {
      const r = await get(`/api/v1/me/notes/${note.id}`, who.cookie);
      expect(r.statusCode, who.id).toBe(404);
    }
  });

  it('refuses all four on a NOTEBOOK, even when a note inside is shared', async () => {
    // The notebook has no sharing model at all. A shared note does not open the
    // folder it sits in.
    const w = await world();
    const book = await makeNotebook(w.learner);
    await makeNote(w.learner, { notebookId: book.id, visibility: 'shared_with_teacher' });

    for (const who of [w.teacher, w.guardian, w.admin, w.operator]) {
      expect((await get(`/api/v1/me/notebooks/${book.id}`, who.cookie)).statusCode, who.id).toBe(
        404,
      );
    }
  });

  it('refuses all four on an ARTIFACT, guardian included', async () => {
    const w = await world();
    const made = await makeArtifact(w.learner);
    for (const who of [w.teacher, w.guardian, w.admin, w.operator, w.peer]) {
      expect((await get(`/api/v1/me/artifacts/${made.id}`, who.cookie)).statusCode, who.id).toBe(
        404,
      );
    }
  });

  it('shows a teacher nothing through their OWN workspace listings', async () => {
    // The `/me` routes are the only way in, and `/me` is the session. There is
    // no parameter through which a teacher could name a student.
    const w = await world();
    await makeNotebook(w.learner);
    await makeNote(w.learner);
    await makeArtifact(w.learner);

    for (const path of ['/api/v1/me/notebooks', '/api/v1/me/notes', '/api/v1/me/artifacts']) {
      expect(items(await get(path, w.teacher.cookie)), path).toEqual([]);
    }
  });

  it('still lets a teacher read a note the student SHARED with them', async () => {
    // The negative tests above would pass vacuously if sharing were broken, so
    // this pins the positive case that makes them meaningful.
    const w = await world();
    // `world()` already assigned the teacher to the class; asserting the
    // POSITIVE case here is what stops the five negatives above from passing
    // vacuously against a sharing model that never worked.
    const shared = await makeNote(w.learner, { visibility: 'shared_with_teacher' });
    const r = await get(`/api/v1/notes/${shared.id}`, w.teacher.cookie);
    expect(r.statusCode).toBe(200);
  });
});

describe('E — §2D: a student cannot attach an artifact to another student’s work', () => {
  it('refuses attaching to another student’s note', async () => {
    const w = await world();
    const theirs = await makeNote(w.learner);
    const response = await post('/api/v1/me/artifacts', w.peer.cookie, {
      artifactType: 'image',
      declaredContentType: 'image/png',
      byteSize: 1024,
      noteId: theirs.id,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses deleting another student’s artifact', async () => {
    const w = await world();
    const theirs = await makeArtifact(w.learner);
    expect((await del(`/api/v1/me/artifacts/${theirs.id}`, w.peer.cookie)).statusCode).toBe(404);
    expect((await get(`/api/v1/me/artifacts/${theirs.id}`, w.learner.cookie)).statusCode).toBe(200);
  });

  it('never lists another student’s artifacts', async () => {
    const w = await world();
    await makeArtifact(w.learner);
    expect(items(await get('/api/v1/me/artifacts', w.peer.cookie))).toEqual([]);
  });
});

describe('F — §2D: storage and payload limits are not negotiable from the client', () => {
  it('refuses a size over the per-artifact ceiling', async () => {
    const w = await world();
    const response = await post('/api/v1/me/artifacts', w.learner.cookie, {
      artifactType: 'image',
      declaredContentType: 'image/png',
      byteSize: 26_214_401,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a content type outside the allow-list for that artifact type', async () => {
    const w = await world();
    for (const declaredContentType of ['image/svg+xml', 'text/html', 'application/x-msdownload']) {
      const response = await post('/api/v1/me/artifacts', w.learner.cookie, {
        artifactType: 'image',
        declaredContentType,
        byteSize: 1024,
      });
      expect(response.statusCode, declaredContentType).toBe(400);
    }
  });

  it('refuses a forged storage path, rather than ignoring it', async () => {
    // `.strict()` — the field does not exist, so sending one is a 400 out loud
    // instead of a value silently dropped that a later change might start
    // reading (VULN-028).
    const w = await world();
    for (const forged of [
      { filePath: '/etc/passwd' },
      { storageKey: 'org/other/user/other/x' },
      { fileUrl: 'https://evil.example/payload' },
    ]) {
      const response = await post('/api/v1/me/artifacts', w.learner.cookie, {
        artifactType: 'image',
        declaredContentType: 'image/png',
        byteSize: 1024,
        ...forged,
      });
      expect(response.statusCode, JSON.stringify(forged)).toBe(400);
    }
  });

  it('derives a tenant-scoped storage key the client never chose', async () => {
    const w = await world();
    const made = await makeArtifact(w.learner);
    expect(made.storageKey).toBe(`org/${w.orgA}/user/${w.learner.id}/${made.id}`);
  });

  it('refuses a registration that would cross the learner’s quota', async () => {
    const w = await world();
    const per = 26_214_400;
    // 256 MiB / 25 MiB = 10.24, so ten fit and the eleventh cannot.
    for (let i = 0; i < 10; i += 1) {
      await makeArtifact(w.learner, { byteSize: per });
    }
    const response = await post('/api/v1/me/artifacts', w.learner.cookie, {
      artifactType: 'image',
      declaredContentType: 'image/png',
      byteSize: per,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/storage allowance/i);
  });

  it('counts each learner’s quota separately', async () => {
    const w = await world();
    await makeArtifact(w.learner, { byteSize: 10_000 });
    const quota = await get('/api/v1/me/storage', w.peer.cookie);
    expect(quota.json<{ usedBytes: number }>().usedBytes).toBe(0);
  });
});

describe('G — markdown link schemes are refused, schoolwork is not', () => {
  it('refuses a javascript: link on create and on update', async () => {
    const w = await world();
    const created = await post('/api/v1/me/notes', w.learner.cookie, {
      title: 'x',
      body: '[click](javascript:alert(1))',
    });
    expect(created.statusCode).toBe(400);

    const note = await makeNote(w.learner);
    const updated = await put(`/api/v1/me/notes/${note.id}`, w.learner.cookie, {
      body: '[click](javascript:alert(1))',
    });
    expect(updated.statusCode).toBe(400);
  });

  it('accepts a note that DISCUSSES the scheme in prose and in code', async () => {
    const w = await world();
    const response = await post('/api/v1/me/notes', w.learner.cookie, {
      title: 'XSS notes',
      body: 'A javascript: URL in an href is how XSS happens.\n\n```js\nconst u = "javascript:alert(1)";\n```',
    });
    expect(response.statusCode, response.body).toBe(201);
  });

  it('records the refusal with the scheme and nothing else', async () => {
    const w = await world();
    await post('/api/v1/me/notes', w.learner.cookie, {
      title: 'x',
      body: '[click](javascript:alert(1))',
    });
    expect(await auditTypes()).toContain('workspace.markdown_refused');

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>(
        `SELECT detail FROM audit_log WHERE event_type = 'workspace.markdown_refused'`,
      );
      const serialized = JSON.stringify(rows.map((r) => r.detail));
      expect(serialized).toContain('javascript');
      // Not the note, not the URL, not the text around it.
      expect(serialized).not.toContain('alert(1)');
      expect(serialized).not.toContain('click');
    } finally {
      await raw.end();
    }
  });
});

describe('H — anchoring: retention without a way to reach new coursework', () => {
  it('refuses a note anchored to a course the learner does not study', async () => {
    const w = await world();
    for (const anchor of [{ courseId: w.unassignedCourse }, { lessonId: w.unassignedLesson }]) {
      const response = await post('/api/v1/me/notes', w.learner.cookie, {
        title: 'no',
        ...anchor,
      });
      expect(response.statusCode, JSON.stringify(anchor)).toBe(400);
      expect(response.body).toMatch(/not studying/i);
    }
  });

  it('refuses two anchors on one note', async () => {
    const w = await world();
    const response = await post('/api/v1/me/notes', w.learner.cookie, {
      title: 'both',
      courseId: w.course,
      lessonId: w.lesson,
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps an anchored note readable and EDITABLE after enrolment ends', async () => {
    const w = await world();
    const note = await makeNote(w.learner, { lessonId: w.lesson, body: 'term one' });

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      await raw.query(
        `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
        [w.learner.id],
      );
    } finally {
      await raw.end();
    }

    expect((await get(`/api/v1/me/notes/${note.id}`, w.learner.cookie)).statusCode).toBe(200);
    // Revision notes are the child's, not the school's.
    const edited = await put(`/api/v1/me/notes/${note.id}`, w.learner.cookie, {
      body: 'revised for the exam',
    });
    expect(edited.statusCode, edited.body).toBe(200);
  });

  it('lets a learner CLEAR an anchor, which is not the same as omitting one', async () => {
    /**
     * THE CASE A DEFECT-INJECTION ROUND FOUND MISSING.
     *
     * `null` means "unfile this"; `undefined` means "leave it alone". The
     * repository carries a boolean per nullable field to tell them apart,
     * because COALESCE cannot. Collapsing the two makes unanchoring silently
     * impossible — the request succeeds, the field does not move, and nothing
     * tells the learner. No test covered it until this one.
     */
    const w = await world();
    const book = await makeNotebook(w.learner);
    const note = await makeNote(w.learner, { lessonId: w.lesson, notebookId: book.id });
    expect(note.lessonId).toBe(w.lesson);
    expect(note.notebookId).toBe(book.id);

    const unanchored = await put(`/api/v1/me/notes/${note.id}`, w.learner.cookie, {
      lessonId: null,
    });
    expect(unanchored.statusCode, unanchored.body).toBe(200);
    expect(unanchored.json<NoteBody>().lessonId).toBeNull();
    // And the field that was NOT sent is untouched.
    expect(unanchored.json<NoteBody>().notebookId).toBe(book.id);

    const unfiled = await put(`/api/v1/me/notes/${note.id}`, w.learner.cookie, {
      notebookId: null,
    });
    expect(unfiled.statusCode).toBe(200);
    expect(unfiled.json<NoteBody>().notebookId).toBeNull();
  });

  it('refuses re-anchoring that note to coursework they can no longer study', async () => {
    const w = await world();
    const note = await makeNote(w.learner);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      await raw.query(
        `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
        [w.learner.id],
      );
    } finally {
      await raw.end();
    }

    const moved = await put(`/api/v1/me/notes/${note.id}`, w.learner.cookie, {
      lessonId: w.lesson,
    });
    expect(moved.statusCode).toBe(400);
  });
});

describe('I — the audit trail records what happened, and nothing it should not', () => {
  it('records an artifact registration without the filename or metadata', async () => {
    const w = await world();
    await makeArtifact(w.learner, {
      originalFilename: 'my-diagnosis-letter.png',
      metadata: { note: 'something private' },
    });
    expect(await auditTypes()).toContain('workspace.artifact_registered');

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>(
        `SELECT detail FROM audit_log WHERE event_type = 'workspace.artifact_registered'`,
      );
      const serialized = JSON.stringify(rows.map((r) => r.detail));
      expect(serialized).toContain('image/png');
      expect(serialized).not.toContain('my-diagnosis-letter');
      expect(serialized).not.toContain('something private');
    } finally {
      await raw.end();
    }
  });

  it('does NOT record a learner reading their own workspace', async () => {
    // Deliberate. A child reading their own notes is not a security event, and
    // logging it would build exactly the surveillance trail this domain's
    // policies exist to make unnecessary.
    const w = await world();
    await makeNotebook(w.learner);
    await get('/api/v1/me/notebooks', w.learner.cookie);
    await get('/api/v1/me/notes', w.learner.cookie);

    const types = await auditTypes();
    expect(types.filter((t) => t.startsWith('workspace.'))).toEqual([]);
  });

  it('records a denial with ids and a reason, never the content', async () => {
    const w = await world();
    const theirs = await makeNote(w.learner, { body: 'private thoughts about my family' });
    await get(`/api/v1/me/notes/${theirs.id}`, w.peer.cookie);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>(
        `SELECT detail FROM audit_log WHERE event_type = 'authz.denied'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows.map((r) => r.detail))).not.toContain('private thoughts');
    } finally {
      await raw.end();
    }
  });
});

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
  closeSeedDb,
  createClass,
  createEducationLevel,
  createOrganization,
  createUser,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * The content lifecycle, end to end over the real HTTP stack.
 *
 * Written from section 16 of the task by hand, not from the implementation. A
 * suite derived from the code tests what the code does; these test what the task
 * says must be true — including the cases where the right answer is a clear 409
 * rather than a 500, which is what §11 asks for and what an author actually
 * needs.
 *
 * Everything is built through the API, so the tests exercise the path a real
 * authoring client would take, publish workflow and all.
 */
let testApp: TestApp;

const PASSWORD = 'a-sufficiently-long-passphrase'; // secret-scan-allow: test fixture password

interface Session {
  readonly id: string;
  readonly cookie: string;
}

async function seedAndLogin(options: {
  email: string;
  roles?: readonly string[];
  organizationId?: string | null;
}): Promise<Session> {
  const user = await createUser({
    email: options.email,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.organizationId !== undefined ? { organizationId: options.organizationId } : {}),
    passwordHash: await hashPassword(PASSWORD),
  });
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
  payload === undefined
    ? testApp.app.inject({ method: 'POST', url, headers: { ...bodylessWriteHeaders, cookie } })
    : testApp.app.inject({ method: 'POST', url, headers: { ...writeHeaders, cookie }, payload });

const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PATCH', url, headers: { ...writeHeaders, cookie }, payload });

const id = (r: { json: <T>() => T }) => r.json<{ id: string }>().id;
const message = (r: { json: <T>() => T }) => r.json<{ error: { message: string } }>().error.message;

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

let levelId: string;

/**
 * A school with a PUBLISHED lesson carrying two objectives, plus a draft unit
 * to author into. Built entirely through the API.
 */
async function world() {
  const organizationId = await createOrganization('School A');
  const foreignOrganizationId = await createOrganization('School B');

  const author = await seedAndLogin({
    email: 'author@t.local',
    roles: ['content_author'],
    organizationId,
  });
  const reviewer = await seedAndLogin({
    email: 'reviewer@t.local',
    roles: ['reviewer'],
    organizationId,
  });
  const admin = await seedAndLogin({ email: 'admin@t.local', roles: ['admin'], organizationId });
  const teacher = await seedAndLogin({
    email: 'teacher@t.local',
    roles: ['teacher'],
    organizationId,
  });
  const student = await seedAndLogin({ email: 'student@t.local', organizationId });
  const foreignAuthor = await seedAndLogin({
    email: 'author@b.local',
    roles: ['content_author'],
    organizationId: foreignOrganizationId,
  });
  const foreignReviewer = await seedAndLogin({
    email: 'reviewer@b.local',
    roles: ['reviewer'],
    organizationId: foreignOrganizationId,
  });

  const curriculumId = id(
    await post('/api/v1/curricula', author.cookie, { code: 'sci', name: 'Science' }),
  );
  const courseId = id(
    await post('/api/v1/courses', author.cookie, { curriculumId, levelId, title: 'Physics' }),
  );
  const unitId = id(
    await post(`/api/v1/courses/${courseId}/units`, author.cookie, { title: 'Mechanics' }),
  );
  const lessonId = id(
    await post(`/api/v1/units/${unitId}/lessons`, author.cookie, {
      title: "Newton's Laws",
      contentBody: 'A body remains at rest…',
      objectives: ["Explain Newton's second law", 'Apply F=ma to a trolley'],
    }),
  );

  for (const url of [
    `/api/v1/curricula/${curriculumId}/publish`,
    `/api/v1/courses/${courseId}/publish`,
    `/api/v1/units/${unitId}/publish`,
    `/api/v1/lessons/${lessonId}/publish`,
  ]) {
    const response = await post(url, reviewer.cookie);
    if (response.statusCode !== 200) throw new Error(`publish failed: ${url} ${response.body}`);
  }

  // A second, still-draft unit to author into.
  const draftUnitId = id(
    await post(`/api/v1/courses/${courseId}/units`, author.cookie, { title: 'Optics' }),
  );

  const classId = await createClass(organizationId, 'A1');
  await addClassMember(classId, student.id);
  await assignCourseToClass({ classId, courseId });

  return {
    organizationId,
    foreignOrganizationId,
    author,
    reviewer,
    admin,
    teacher,
    student,
    foreignAuthor,
    foreignReviewer,
    curriculumId,
    courseId,
    unitId,
    draftUnitId,
    lessonId,
    classId,
  };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

beforeEach(async () => {
  await truncateAll();
  testApp = await buildTestApp();
  levelId = await createEducationLevel();
  w = await world();
});

afterAll(async () => {
  await testApp?.db.close();
  await closeSeedDb();
});

// =====================================================================
// The happy path first — a suite of only negatives passes when
// everything is broken.
// =====================================================================

describe('the authoring flow', () => {
  it('an author drafts, edits freely, and a reviewer publishes', async () => {
    const lessonId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, {
        title: 'Draft',
        contentBody: 'First draft',
        objectives: ['First wording'],
      }),
    );

    // Everything is editable while it is a draft, objectives included.
    expect(
      (
        await patch(`/api/v1/lessons/${lessonId}`, w.author.cookie, {
          title: 'Better title',
          contentBody: 'Second draft',
          objectives: ['Better wording', 'And another'],
        })
      ).statusCode,
    ).toBe(200);

    const read = await get(`/api/v1/lessons/${lessonId}`, w.author.cookie);
    expect(read.json<{ objectives: string[] }>().objectives).toEqual([
      'Better wording',
      'And another',
    ]);

    expect((await post(`/api/v1/lessons/${lessonId}/publish`, w.reviewer.cookie)).statusCode).toBe(
      200,
    );
    expect((await get(`/api/v1/lessons/${lessonId}`, w.student.cookie)).statusCode).toBe(200);
  });

  it('a published lesson keeps the objectives it was published with', async () => {
    const read = await get(`/api/v1/lessons/${w.lessonId}`, w.student.cookie);
    expect(read.json<{ objectives: string[] }>().objectives).toEqual([
      "Explain Newton's second law",
      'Apply F=ma to a trolley',
    ]);
  });

  it('the title and body of a published lesson stay editable', async () => {
    // Deliberately NOT frozen. A published lesson's prose is material, not a
    // claim about a learner: "completed this lesson on that date" stays true
    // when a typo is fixed. The cost — that the body a learner completed may
    // since have changed — is recorded in docs/api/curriculum.md.
    expect(
      (
        await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
          title: 'Newton’s Laws (revised)',
          contentBody: 'A body remains at rest unless acted upon…',
        })
      ).statusCode,
    ).toBe(200);
  });
});

// =====================================================================
// Published immutability
// =====================================================================

describe('a published lesson’s objectives cannot change', () => {
  it('REWORDING IS REFUSED WITH A CLEAR 409, not a 500', async () => {
    // §11: "Return clear validation errors." Before Task 011 the database's
    // refusal reached the error handler unrecognised and became "Internal
    // error", which tells an author their content is broken when their REQUEST
    // was.
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      objectives: ['Something entirely different', 'Apply F=ma to a trolley'],
    });
    expect(response.statusCode).toBe(409);
    expect(message(response)).toMatch(/objectives cannot be changed/i);
  });

  it('ADDING one is refused', async () => {
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      objectives: ["Explain Newton's second law", 'Apply F=ma to a trolley', 'A new one'],
    });
    expect(response.statusCode).toBe(409);
  });

  it('REMOVING one is refused', async () => {
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      objectives: ["Explain Newton's second law"],
    });
    expect(response.statusCode).toBe(409);
  });

  it('and the objectives are unchanged after every refusal', async () => {
    await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, { objectives: ['X'] });
    const read = await get(`/api/v1/lessons/${w.lessonId}`, w.author.cookie);
    expect(read.json<{ objectives: string[] }>().objectives).toEqual([
      "Explain Newton's second law",
      'Apply F=ma to a trolley',
    ]);
  });

  it('a refusal is RECORDED as a security event', async () => {
    await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, { objectives: ['X'] });
    expect(await auditTypes()).toContain('content.lifecycle_refused');
  });

  it('sending the SAME objectives is still refused — the rewrite is what is closed', async () => {
    // An honest limitation, pinned rather than hidden: the API replaces the
    // objective list wholesale, so it cannot tell "no change" from "a change
    // that happens to match". An author editing only a lesson's title must omit
    // `objectives` from the patch. Documented in docs/api/curriculum.md.
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      objectives: ["Explain Newton's second law", 'Apply F=ma to a trolley'],
    });
    expect(response.statusCode).toBe(409);
  });
});

// =====================================================================
// Publish validation and tree consistency
// =====================================================================

describe('publish validation', () => {
  it('AN EMPTY LESSON CANNOT BE PUBLISHED, and the reason says why', async () => {
    const lessonId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, { title: 'Title only' }),
    );
    const response = await post(`/api/v1/lessons/${lessonId}/publish`, w.reviewer.cookie);
    expect(response.statusCode).toBe(409);
    expect(message(response)).toMatch(/no content and no external link/i);
  });

  it('A LESSON UNDER A DRAFT UNIT CANNOT BE PUBLISHED', async () => {
    const lessonId = id(
      await post(`/api/v1/units/${w.draftUnitId}/lessons`, w.author.cookie, {
        title: 'Early',
        contentBody: 'Body',
      }),
    );
    const response = await post(`/api/v1/lessons/${lessonId}/publish`, w.reviewer.cookie);
    expect(response.statusCode).toBe(409);
    expect(message(response)).toMatch(/unit or course/i);
  });

  it('and publishing in order succeeds — the rule is about sequence', async () => {
    expect(
      (await post(`/api/v1/units/${w.draftUnitId}/publish`, w.reviewer.cookie)).statusCode,
    ).toBe(200);
    const lessonId = id(
      await post(`/api/v1/units/${w.draftUnitId}/lessons`, w.author.cookie, {
        title: 'Now fine',
        contentBody: 'Body',
      }),
    );
    expect((await post(`/api/v1/lessons/${lessonId}/publish`, w.reviewer.cookie)).statusCode).toBe(
      200,
    );
  });

  it('a lesson with NO OBJECTIVES is publishable, deliberately', async () => {
    // Not an oversight: a reading lesson with nothing assessable is legitimate.
    // It records progress and produces no mastery evidence, which is the honest
    // outcome rather than a validation failure invented for tidiness.
    const lessonId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, {
        title: 'Just read this',
        contentBody: 'Some text',
      }),
    );
    expect((await post(`/api/v1/lessons/${lessonId}/publish`, w.reviewer.cookie)).statusCode).toBe(
      200,
    );
  });
});

describe('archival retires a subtree in one act', () => {
  it('ARCHIVING A COURSE RETIRES EVERYTHING UNDER IT, atomically', async () => {
    // §10: a lifecycle change either completes or leaves the previous valid
    // state. The cascade runs inside one transaction, and 0022's trigger is
    // what makes a partial cascade impossible rather than merely unlikely.
    expect((await get(`/api/v1/lessons/${w.lessonId}`, w.student.cookie)).statusCode).toBe(200);
    expect(
      (await post(`/api/v1/courses/${w.courseId}/archive`, w.reviewer.cookie)).statusCode,
    ).toBe(200);

    expect((await get(`/api/v1/lessons/${w.lessonId}`, w.student.cookie)).statusCode).toBe(404);
    const lesson = await get(`/api/v1/lessons/${w.lessonId}`, w.author.cookie);
    expect(lesson.json<{ status: string }>().status).toBe('archived');
    const unit = await get(`/api/v1/units/${w.unitId}`, w.author.cookie);
    expect(unit.json<{ status: string }>().status).toBe('archived');
  });

  it('archiving a unit retires its lessons but leaves its siblings alone', async () => {
    const otherUnitId = id(
      await post(`/api/v1/courses/${w.courseId}/units`, w.author.cookie, { title: 'Waves' }),
    );
    expect((await post(`/api/v1/units/${otherUnitId}/publish`, w.reviewer.cookie)).statusCode).toBe(
      200,
    );

    expect((await post(`/api/v1/units/${w.unitId}/archive`, w.reviewer.cookie)).statusCode).toBe(
      200,
    );
    expect(
      (await get(`/api/v1/lessons/${w.lessonId}`, w.author.cookie)).json<{ status: string }>()
        .status,
    ).toBe('archived');
    expect(
      (await get(`/api/v1/units/${otherUnitId}`, w.author.cookie)).json<{ status: string }>()
        .status,
    ).toBe('published');
  });

  it('publishing does NOT cascade — a parent going live drags no drafts with it', async () => {
    // The asymmetry is deliberate. Archival is a withdrawal and may sweep;
    // publication is a disclosure and must never sweep unreviewed work into
    // view.
    const draftLessonId = id(
      await post(`/api/v1/units/${w.draftUnitId}/lessons`, w.author.cookie, {
        title: 'Unreviewed',
        contentBody: 'Body',
      }),
    );
    expect(
      (await post(`/api/v1/units/${w.draftUnitId}/publish`, w.reviewer.cookie)).statusCode,
    ).toBe(200);
    expect(
      (await get(`/api/v1/lessons/${draftLessonId}`, w.author.cookie)).json<{ status: string }>()
        .status,
    ).toBe('draft');
    expect((await get(`/api/v1/lessons/${draftLessonId}`, w.student.cookie)).statusCode).toBe(404);
  });
});

// =====================================================================
// §16 — IDOR / BOLA
// =====================================================================

describe('cross-organization authoring', () => {
  it.each([
    ['a lesson', (): string => `/api/v1/lessons/${w.lessonId}`, { title: 'Theirs' }],
    ['a course', (): string => `/api/v1/courses/${w.courseId}`, { title: 'Theirs' }],
    ['a unit', (): string => `/api/v1/units/${w.unitId}`, { title: 'Theirs' }],
    ['a curriculum', (): string => `/api/v1/curricula/${w.curriculumId}`, { name: 'Theirs' }],
  ])('AN AUTHOR OF ANOTHER ORGANIZATION CANNOT EDIT %s', async (_label, url, payload) => {
    // 404, not 403: a foreign author must not learn that the content exists.
    expect((await patch(url(), w.foreignAuthor.cookie, payload)).statusCode).toBe(404);
  });

  it.each([
    ['publish', 'publish'],
    ['archive', 'archive'],
  ])('A REVIEWER OF ANOTHER ORGANIZATION CANNOT %s', async (_label, verb) => {
    expect(
      (await post(`/api/v1/lessons/${w.lessonId}/${verb}`, w.foreignReviewer.cookie)).statusCode,
    ).toBe(404);
  });

  it('nor can they read a draft of ours', async () => {
    const draftId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, { title: 'Ours' }),
    );
    expect((await get(`/api/v1/lessons/${draftId}`, w.foreignAuthor.cookie)).statusCode).toBe(404);
  });

  it('nor create content inside our course', async () => {
    expect(
      (await post(`/api/v1/units/${w.unitId}/lessons`, w.foreignAuthor.cookie, { title: 'Theirs' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('publish abuse', () => {
  it.each([
    ['a LEARNER', (): string => w.student.cookie],
    ['a TEACHER', (): string => w.teacher.cookie],
    ['an AUTHOR (who may write but not publish)', (): string => w.author.cookie],
  ])('%s cannot publish', async (_label, cookie) => {
    const lessonId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, {
        title: 'D',
        contentBody: 'B',
      }),
    );
    const response = await post(`/api/v1/lessons/${lessonId}/publish`, cookie());
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      (await get(`/api/v1/lessons/${lessonId}`, w.author.cookie)).json<{ status: string }>().status,
    ).toBe('draft');
  });

  it.each([
    ['a LEARNER', (): string => w.student.cookie],
    ['a TEACHER', (): string => w.teacher.cookie],
  ])('%s cannot archive published content either', async (_label, cookie) => {
    expect(
      (await post(`/api/v1/lessons/${w.lessonId}/archive`, cookie())).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await get(`/api/v1/lessons/${w.lessonId}`, w.author.cookie)).json<{ status: string }>()
        .status,
    ).toBe('published');
  });

  it('A REVIEWER CANNOT EDIT CONTENT — the duty split cuts both ways', async () => {
    expect(
      (await patch(`/api/v1/lessons/${w.lessonId}`, w.reviewer.cookie, { title: 'Theirs' }))
        .statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  it('an unauthenticated caller can neither author nor publish', async () => {
    for (const [method, url] of [
      ['POST', `/api/v1/units/${w.unitId}/lessons`],
      ['POST', `/api/v1/lessons/${w.lessonId}/publish`],
      ['POST', `/api/v1/lessons/${w.lessonId}/archive`],
      ['PATCH', `/api/v1/lessons/${w.lessonId}`],
    ] as const) {
      const response = await testApp.app.inject({
        method,
        url,
        headers: writeHeaders,
        payload: { title: 'X' },
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('draft leakage', () => {
  let draftLessonId: string;

  beforeEach(async () => {
    draftLessonId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, {
        title: 'Unreviewed',
        contentBody: 'Not ready',
        objectives: ['Unreviewed objective'],
      }),
    );
  });

  it('A LEARNER CANNOT READ A DRAFT LESSON', async () => {
    expect((await get(`/api/v1/lessons/${draftLessonId}`, w.student.cookie)).statusCode).toBe(404);
  });

  it('a draft does not appear in a learner’s listing', async () => {
    const listed = await get(`/api/v1/units/${w.unitId}/lessons`, w.student.cookie);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: { id: string }[] }>().items.map((i) => i.id)).not.toContain(
      draftLessonId,
    );
  });

  it('A DRAFT OBJECTIVE DOES NOT LEAK through any lesson response', async () => {
    // The objectives ride on the lesson DTO, so a draft lesson leaking would
    // leak unreviewed objectives with it. Asserted on the body rather than the
    // status, because a 200 carrying the statement would pass a status check.
    const listed = await get(`/api/v1/units/${w.unitId}/lessons`, w.student.cookie);
    expect(listed.body).not.toContain('Unreviewed objective');
    expect((await get(`/api/v1/lessons/${draftLessonId}`, w.student.cookie)).body).not.toContain(
      'Unreviewed objective',
    );
  });

  it('a learner cannot record progress against a draft lesson', async () => {
    // The write gate, not just the read gate: a draft must not be able to
    // become progress, and therefore must not become mastery evidence.
    const response = await testApp.app.inject({
      method: 'PUT',
      url: `/api/v1/lessons/${draftLessonId}/progress`,
      headers: { ...writeHeaders, cookie: w.student.cookie },
      payload: { status: 'completed' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('but the AUTHOR sees their own draft', async () => {
    expect((await get(`/api/v1/lessons/${draftLessonId}`, w.author.cookie)).statusCode).toBe(200);
  });
});

// =====================================================================
// §16 — content tampering
// =====================================================================

describe('parameter tampering', () => {
  it.each([
    ['organizationId', { organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['authorId', { authorId: '00000000-0000-4000-8000-000000000000' }],
    ['ownerId', { ownerId: '00000000-0000-4000-8000-000000000000' }],
    ['createdBy', { createdBy: '00000000-0000-4000-8000-000000000000' }],
    ['unitId', { unitId: '00000000-0000-4000-8000-000000000000' }],
    ['status', { status: 'published' }],
    ['publishedAt', { publishedAt: '2001-01-01T00:00:00.000Z' }],
  ])('a lesson patch carrying %s is REFUSED, not silently ignored', async (_label, extra) => {
    // `.strict()` turns an unexpected field into a 400. Dropping it silently
    // would leave a caller believing the platform accepted their value.
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      title: 'Fine',
      ...extra,
    });
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['organizationId', { organizationId: '00000000-0000-4000-8000-000000000000' }],
    ['status', { status: 'published' }],
  ])('a lesson CREATE carrying %s is refused too', async (_label, extra) => {
    const response = await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, {
      title: 'New',
      ...extra,
    });
    expect(response.statusCode).toBe(400);
  });

  it('A PUBLISH BODY CARRYING PRIVILEGED FIELDS IS REFUSED', async () => {
    // §21: "Publishing endpoints must accept only fields actually intended to
    // be changed." They intend to change nothing — the URL names the resource
    // and the session names the actor.
    const lessonId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, {
        title: 'D',
        contentBody: 'B',
      }),
    );
    for (const payload of [
      { status: 'published' },
      { organizationId: '00000000-0000-4000-8000-000000000000' },
      { publishedAt: '2001-01-01T00:00:00.000Z' },
      { objectives: ['Sneaked in'] },
    ]) {
      const response = await post(
        `/api/v1/lessons/${lessonId}/publish`,
        w.reviewer.cookie,
        payload,
      );
      expect(response.statusCode).toBe(400);
    }
    expect(
      (await get(`/api/v1/lessons/${lessonId}`, w.author.cookie)).json<{ status: string }>().status,
    ).toBe('draft');
  });

  it('a forged parent id cannot move a lesson into another organization’s course', async () => {
    const theirCurriculum = id(
      await post('/api/v1/curricula', w.foreignAuthor.cookie, { code: 'b', name: 'Theirs' }),
    );
    const theirCourse = id(
      await post('/api/v1/courses', w.foreignAuthor.cookie, {
        curriculumId: theirCurriculum,
        levelId,
        title: 'Theirs',
      }),
    );
    const theirUnit = id(
      await post(`/api/v1/courses/${theirCourse}/units`, w.foreignAuthor.cookie, { title: 'U' }),
    );
    // There is no field for it, which is the strongest form of the refusal.
    expect(
      (await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, { unitId: theirUnit }))
        .statusCode,
    ).toBe(400);
  });

  it('a malformed id is a 400, not a 500', async () => {
    expect((await post('/api/v1/lessons/not-a-uuid/publish', w.reviewer.cookie)).statusCode).toBe(
      400,
    );
    expect(
      (await patch('/api/v1/lessons/not-a-uuid', w.author.cookie, { title: 'X' })).statusCode,
    ).toBe(400);
  });
});

// =====================================================================
// Historical safety
// =====================================================================

describe('history survives the lifecycle', () => {
  it('ARCHIVING PRESERVES A LEARNER’S PROGRESS AND MASTERY EVIDENCE', async () => {
    const complete = await testApp.app.inject({
      method: 'PUT',
      url: `/api/v1/lessons/${w.lessonId}/progress`,
      headers: { ...writeHeaders, cookie: w.student.cookie },
      payload: { status: 'completed' },
    });
    expect(complete.statusCode).toBe(200);

    const before = await get('/api/v1/me/objectives', w.student.cookie);
    expect(before.json<{ items: unknown[] }>().items).toHaveLength(2);

    expect(
      (await post(`/api/v1/courses/${w.courseId}/archive`, w.reviewer.cookie)).statusCode,
    ).toBe(200);

    // The content is gone from the catalogue; the record of what the child did
    // is not. §15: archived content must not silently disappear from historical
    // learner records.
    expect((await get(`/api/v1/lessons/${w.lessonId}`, w.student.cookie)).statusCode).toBe(404);
    const after = await get('/api/v1/me/objectives', w.student.cookie);
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(2);

    const progress = await get('/api/v1/me/progress', w.student.cookie);
    expect(progress.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('and the objective STATEMENTS a learner demonstrated are still legible', async () => {
    // The point of freezing the statement: what the child is recorded as
    // understanding still reads the same after the content is withdrawn.
    await testApp.app.inject({
      method: 'PUT',
      url: `/api/v1/lessons/${w.lessonId}/progress`,
      headers: { ...writeHeaders, cookie: w.student.cookie },
      payload: { status: 'completed' },
    });
    await post(`/api/v1/courses/${w.courseId}/archive`, w.reviewer.cookie);

    const objectives = (await get('/api/v1/me/objectives', w.student.cookie)).json<{
      items: { statement: string }[];
    }>().items;
    expect(objectives.map((o) => o.statement).sort()).toEqual([
      'Apply F=ma to a trolley',
      "Explain Newton's second law",
    ]);
  });
});

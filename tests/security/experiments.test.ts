import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildTestApp, sessionCookieFrom, writeHeaders, type TestApp } from '../setup/app.ts';
import { TEST_SUPERUSER_URL } from '../setup/env.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createActivity,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createExperiment,
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
 * Interactive labs, end to end over the real HTTP stack.
 *
 * Nothing is stubbed: the same composition root, the same policy engine, the
 * same `edu_app` role. The RLS half of these same boundaries is asserted in
 * `tests/integration/rls-experiments.test.ts` with no application code in the
 * path; the pure decision table is in `tests/unit/experiment-policy.test.ts`.
 * Neither of those is sufficient alone, and neither is this.
 *
 * Written from the TASK by hand, not from the implementation. A suite derived
 * from the code tests what the code does; these test what must be true.
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

async function asSuperuser(sql: string, params: unknown[] = []): Promise<void> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    await raw.query(sql, params);
  } finally {
    await raw.end();
  }
}

/** The lab every published fixture below is marked against. */
const CIRCUIT_RULES = {
  rules: [
    { path: 'circuit.closed', op: 'isTrue' },
    { path: 'circuit.voltage', op: 'approx', value: 5, tolerance: 0.1 },
  ],
};
const PASSING = { circuit: { closed: true, voltage: 5.02 } };
const FAILING = { circuit: { closed: false, voltage: 0 } };

/**
 * Two schools, two classes in the first, one teacher each.
 *
 * `learner` is in A1 and `otherClassLearner` in A2, so "I teach a class" and
 * "I teach THIS learner in THIS class" can be told apart — the distinction the
 * whole teacher rule turns on.
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
  const otherClassLearner = await seedAndLogin({
    email: 'other-class@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const teacher = await seedAndLogin({
    email: 'teacher@a.test',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const otherTeacher = await seedAndLogin({
    email: 'teacher2@a.test',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const strangerTeacher = await seedAndLogin({
    email: 'teacher@b.test',
    roles: ['teacher'],
    organizationId: orgB,
  });
  const guardian = await seedAndLogin({
    email: 'guardian@a.test',
    roles: ['guardian'],
    organizationId: orgA,
  });
  const author = await seedAndLogin({
    email: 'author@a.test',
    roles: ['content_author'],
    organizationId: orgA,
  });
  const foreignAuthor = await seedAndLogin({
    email: 'author@b.test',
    roles: ['content_author'],
    organizationId: orgB,
  });
  const operator = await seedAndLogin({
    email: 'operator@platform.test',
    roles: ['security_admin'],
    organizationId: null,
    globalSecurityAdmin: true,
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

  const classA1 = await createClass(orgA, 'A1');
  const classA2 = await createClass(orgA, 'A2');
  await addClassMember(classA1, learner.id);
  await addClassMember(classA1, peer.id);
  await addClassMember(classA2, otherClassLearner.id);
  await assignTeacher(teacher.id, classA1);
  await assignTeacher(otherTeacher.id, classA2);
  await assignCourseToClass({ classId: classA1, courseId: course });
  await assignCourseToClass({ classId: classA2, courseId: course });
  await linkGuardian(guardian.id, learner.id, 'verified');

  const lab = await createExperiment({
    lessonId: lesson,
    status: 'published',
    rules: CIRCUIT_RULES,
  });

  return {
    orgA,
    orgB,
    lesson,
    course,
    classA1,
    classA2,
    learner,
    peer,
    otherClassLearner,
    teacher,
    otherTeacher,
    strangerTeacher,
    guardian,
    author,
    foreignAuthor,
    operator,
    lab,
  };
}

interface SessionBody {
  id: string;
  status: string;
  passed: boolean | null;
  currentState: Record<string, unknown>;
  experimentTitle: string;
  courseTitle: string;
}

async function startSession(w: Awaited<ReturnType<typeof world>>, who: Session) {
  const response = await post(`/api/v1/experiments/${w.lab.experimentId}/sessions`, who.cookie);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ session: SessionBody; experiment: Record<string, unknown> }>();
}

beforeEach(truncateAll);

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

describe('A — the validation rules never reach a learner', () => {
  it('omits `rules` entirely from the lab a learner reads', async () => {
    const w = await world();
    const response = await get(`/api/v1/experiments/${w.lab.experimentId}`, w.learner.cookie);
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('rules');
    // Not merely absent — no key anywhere in the payload names a rule.
    expect(JSON.stringify(body)).not.toMatch(/voltage|closed|isTrue|approx/);
  });

  it('returns the rules to the author who wrote them', async () => {
    const w = await world();
    const response = await get(`/api/v1/experiments/${w.lab.experimentId}`, w.author.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ rules: unknown[] }>().rules).toHaveLength(2);
  });

  it('hides them from an author at ANOTHER school, along with the lab itself', async () => {
    const w = await world();
    const response = await get(`/api/v1/experiments/${w.lab.experimentId}`, w.foreignAuthor.cookie);
    expect(response.statusCode).toBe(404);
  });

  it('never discloses them through a session response', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const read = await get(`/api/v1/experiment-sessions/${session.id}`, w.learner.cookie);
    expect(JSON.stringify(read.json())).not.toMatch(/isTrue|approx|tolerance/);
  });
});

describe('B — the outcome is the server’s, never the client’s', () => {
  it('discards a forged `passed` and `status` on submit', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);

    const response = await post(
      `/api/v1/experiment-sessions/${session.id}/submit`,
      w.learner.cookie,
      // The whole attack: a failing state, claiming success.
      { currentState: FAILING, passed: true, status: 'completed' },
    );
    // `.strict()` refuses the extra fields outright rather than ignoring them,
    // so the forgery never even reaches the trigger that would have discarded
    // it. Both defences are real; this is the outer one.
    expect(response.statusCode).toBe(400);
  });

  it('marks a failing state as failed even when the request is well formed', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await post(
      `/api/v1/experiment-sessions/${session.id}/submit`,
      w.learner.cookie,
      { currentState: FAILING },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionBody>();
    expect(body.passed).toBe(false);
    expect(body.status).toBe('submitted');
  });

  it('marks a genuinely satisfying state as completed', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await post(
      `/api/v1/experiment-sessions/${session.id}/submit`,
      w.learner.cookie,
      { currentState: PASSING },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionBody>();
    expect(body.passed).toBe(true);
    expect(body.status).toBe('completed');
  });

  it('refuses a second submission of the same session', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await post(`/api/v1/experiment-sessions/${session.id}/submit`, w.learner.cookie, {
      currentState: FAILING,
    });
    const again = await post(
      `/api/v1/experiment-sessions/${session.id}/submit`,
      w.learner.cookie,
      { currentState: PASSING },
    );
    expect(again.statusCode).toBe(403);
  });

  it('refuses a save after submission, so a mark cannot be revised', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await post(`/api/v1/experiment-sessions/${session.id}/submit`, w.learner.cookie, {
      currentState: FAILING,
    });
    const save = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: PASSING },
    );
    expect(save.statusCode).toBe(403);
  });
});

describe('C — a session belongs to the learner who ran it', () => {
  it('refuses a peer reading it', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    expect((await get(`/api/v1/experiment-sessions/${session.id}`, w.peer.cookie)).statusCode).toBe(
      404,
    );
  });

  it('refuses a peer writing into it', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.peer.cookie,
      { currentState: PASSING },
    );
    expect(response.statusCode).toBe(404);

    const still = await get(`/api/v1/experiment-sessions/${session.id}`, w.learner.cookie);
    expect(still.json<SessionBody>().currentState).toEqual({});
  });

  it('refuses the TEACHER submitting a learner’s lab for them', async () => {
    // The sharpest denial in this file. A lab is finished by REACHING A STATE,
    // so an adult who could write here could assemble the passing circuit and
    // let the trigger record it as the child's work.
    const w = await world();
    const { session } = await startSession(w, w.learner);
    expect(
      (
        await post(`/api/v1/experiment-sessions/${session.id}/submit`, w.teacher.cookie, {
          currentState: PASSING,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a verified GUARDIAN writing into it', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    expect(
      (
        await put(`/api/v1/experiment-sessions/${session.id}/state`, w.guardian.cookie, {
          currentState: PASSING,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a PLATFORM OPERATOR writing into it, while letting them read it', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    expect(
      (await get(`/api/v1/experiment-sessions/${session.id}`, w.operator.cookie)).statusCode,
    ).toBe(200);
    expect(
      (
        await post(`/api/v1/experiment-sessions/${session.id}/submit`, w.operator.cookie, {
          currentState: PASSING,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('D — who may read a session', () => {
  it('shows it to the learner, their guardian and the teacher of their class', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    for (const who of [w.learner, w.guardian, w.teacher]) {
      expect(
        (await get(`/api/v1/experiment-sessions/${session.id}`, who.cookie)).statusCode,
        who.id,
      ).toBe(200);
    }
  });

  it('hides it from a teacher who teaches a DIFFERENT class', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    expect(
      (await get(`/api/v1/experiment-sessions/${session.id}`, w.otherTeacher.cookie)).statusCode,
    ).toBe(404);
  });

  it('hides it from a teacher at another school', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    expect(
      (await get(`/api/v1/experiment-sessions/${session.id}`, w.strangerTeacher.cookie)).statusCode,
    ).toBe(404);
  });

  it('refuses a teacher using a class they teach as a lens onto a learner not in it', async () => {
    const w = await world();
    await startSession(w, w.learner);
    // `otherTeacher` teaches A2 and `learner` is in A1. The class exists and the
    // teacher has standing in it — the missing fact is the membership, and the
    // answer must not distinguish which of the three failed.
    const response = await get(
      `/api/v1/classes/${w.classA2}/students/${w.learner.id}/experiment-sessions`,
      w.otherTeacher.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('lets the right teacher list their own student’s sessions in their own class', async () => {
    const w = await world();
    await startSession(w, w.learner);
    const response = await get(
      `/api/v1/classes/${w.classA1}/students/${w.learner.id}/experiment-sessions`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(items(response)).toHaveLength(1);
  });

  it('refuses a guardian listing a child who is not theirs', async () => {
    const w = await world();
    await startSession(w, w.peer);
    const response = await get(
      `/api/v1/guardians/children/${w.peer.id}/experiment-sessions`,
      w.guardian.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('returns only the caller’s own sessions from /me, whoever asks', async () => {
    const w = await world();
    await startSession(w, w.learner);
    await startSession(w, w.peer);
    const mine = await get('/api/v1/me/experiment-sessions', w.learner.cookie);
    expect(items<SessionBody>(mine)).toHaveLength(1);
    const theirs = await get('/api/v1/me/experiment-sessions', w.teacher.cookie);
    expect(items(theirs)).toEqual([]);
  });
});

describe('E — instant state isolation', () => {
  it('refuses the next save the moment the learner leaves the class', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);

    const ok = await put(`/api/v1/experiment-sessions/${session.id}/state`, w.learner.cookie, {
      currentState: { circuit: { closed: false } },
    });
    expect(ok.statusCode).toBe(200);

    await asSuperuser(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );

    const refused = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: PASSING },
    );
    expect(refused.statusCode).toBe(404);
  });

  it('refuses the next save the moment the course is withdrawn', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await asSuperuser(
      `UPDATE class_course_assignments SET status = 'archived', ended_at = now() WHERE class_id = $1`,
      [w.classA1],
    );
    const refused = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: PASSING },
    );
    expect(refused.statusCode).toBe(404);
  });

  it('still shows the learner their own past work after they lose the class', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await asSuperuser(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );
    const read = await get(`/api/v1/experiment-sessions/${session.id}`, w.learner.cookie);
    expect(read.statusCode).toBe(200);
    // And the breadcrumb survives, which is why the label is a definer helper
    // rather than a join: the lesson and course rows are no longer visible to
    // this learner, but the NAMES of the work they did are still theirs.
    expect(read.json<SessionBody>().courseTitle).not.toBe('');
  });
});

describe('F — payload limits', () => {
  it('refuses a state payload over the byte ceiling, before it is even parsed', async () => {
    // 413, not 400: Fastify's global body limit rejects this at the transport
    // before any schema sees it, which is the cheapest possible place to refuse
    // it and the reason the contract's own cap is a SECOND line rather than the
    // first. Asserted as 413 so that if the global limit is ever raised above
    // the contract's, this test notices the reordering instead of passing on a
    // different defence than it names.
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: { blob: 'x'.repeat(300_000) } },
    );
    expect(response.statusCode).toBe(413);
  });

  it('refuses a state payload the transport allows but the contract does not', async () => {
    // Just over the 192 KiB contract cap and comfortably under the 256 KiB
    // body limit, so this is the SCHEMA's refusal rather than the transport's —
    // which is the whole reason the contract cap sits below the transport one.
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: { blob: 'x'.repeat(200_000) } },
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses a payload that is small but pathologically DEEP', async () => {
    // The case a byte ceiling cannot catch. Depth is what costs a recursive
    // serializer, and the payload below is a few hundred bytes.
    const w = await world();
    const { session } = await startSession(w, w.learner);
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i += 1) nested = { a: nested };
    const response = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: nested },
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses a non-object state', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: [1, 2, 3] as unknown as Record<string, unknown> },
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: {}, userId: w.peer.id },
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('G — starting a lab', () => {
  it('resumes rather than duplicating', async () => {
    const w = await world();
    const first = await startSession(w, w.learner);
    const second = await startSession(w, w.learner);
    expect(second.session.id).toBe(first.session.id);
    expect(items(await get('/api/v1/me/experiment-sessions', w.learner.cookie))).toHaveLength(1);
  });

  it('allows a NEW session once the previous one is finished', async () => {
    // A lab has no attempt limit, deliberately: "keep adjusting it until the
    // circuit works" is the pedagogy. This asserts that on purpose, so a future
    // change that adds a limit has to change a test that says why.
    const w = await world();
    const first = await startSession(w, w.learner);
    await post(`/api/v1/experiment-sessions/${first.session.id}/submit`, w.learner.cookie, {
      currentState: FAILING,
    });
    const second = await startSession(w, w.learner);
    expect(second.session.id).not.toBe(first.session.id);
  });

  it('refuses a learner who does not reach the lab', async () => {
    const w = await world();
    const response = await post(
      `/api/v1/experiments/${w.lab.experimentId}/sessions`,
      w.otherClassLearner.cookie,
    );
    // A2 has the course assigned, so this learner CAN reach it. The negative
    // case is the teacher below; this asserts the positive so the negative
    // cannot pass vacuously.
    expect(response.statusCode).toBe(201);
  });

  it('refuses a teacher starting a lab session at all', async () => {
    const w = await world();
    const response = await post(
      `/api/v1/experiments/${w.lab.experimentId}/sessions`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses a body on start, rather than ignoring a forged one', async () => {
    const w = await world();
    const response = await post(
      `/api/v1/experiments/${w.lab.experimentId}/sessions`,
      w.learner.cookie,
      { userId: w.peer.id, passed: true },
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses starting a DRAFT lab, and does not confirm it exists', async () => {
    const w = await world();
    const draft = await createExperiment({ lessonId: w.lesson, status: 'draft' });
    const response = await post(
      `/api/v1/experiments/${draft.experimentId}/sessions`,
      w.learner.cookie,
    );
    expect(response.statusCode).toBe(404);
    expect((await get(`/api/v1/experiments/${draft.experimentId}`, w.learner.cookie)).statusCode)
      .toBe(404);
  });
});

describe('H — authoring', () => {
  it('attaches a lab body and its rules in one request', async () => {
    const w = await world();
    const { activityId } = await createActivity({
      lessonId: w.lesson,
      activityType: 'simulation',
      status: 'draft',
    });
    const response = await put(`/api/v1/activities/${activityId}/experiment`, w.author.cookie, {
      simulationType: 'logic_gate',
      initialConfig: { gates: [] },
      rules: [{ path: 'output.value', op: 'isTrue' }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ rules: unknown[] }>().rules).toHaveLength(1);
  });

  it('refuses an author at another school', async () => {
    const w = await world();
    const { activityId } = await createActivity({
      lessonId: w.lesson,
      activityType: 'simulation',
      status: 'draft',
    });
    const response = await put(
      `/api/v1/activities/${activityId}/experiment`,
      w.foreignAuthor.cookie,
      { simulationType: 'circuit', rules: [] },
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses a learner authoring a lab', async () => {
    const w = await world();
    const { activityId } = await createActivity({
      lessonId: w.lesson,
      activityType: 'simulation',
      status: 'draft',
    });
    const response = await put(`/api/v1/activities/${activityId}/experiment`, w.learner.cookie, {
      simulationType: 'circuit',
      rules: [],
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses editing a PUBLISHED lab', async () => {
    // 403, and the code path matters: `learning_activity:update` refuses a
    // published activity outright, so the service's own draft check and the
    // database's `experiments_draft_only` trigger are the second and third
    // gates rather than the first. All three exist; the policy is the one that
    // answers, and it answers `reveal` because the author can already see the
    // activity and hiding it would only confuse.
    const w = await world();
    const response = await put(
      `/api/v1/activities/${w.lab.activityId}/experiment`,
      w.author.cookie,
      { simulationType: 'circuit', rules: [] },
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses an operator outside the closed set', async () => {
    const w = await world();
    const { activityId } = await createActivity({
      lessonId: w.lesson,
      activityType: 'simulation',
      status: 'draft',
    });
    const response = await put(`/api/v1/activities/${activityId}/experiment`, w.author.cookie, {
      simulationType: 'circuit',
      rules: [{ path: 'a.b', op: 'evaluate', value: 1 }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a path that could wander', async () => {
    const w = await world();
    const { activityId } = await createActivity({
      lessonId: w.lesson,
      activityType: 'simulation',
      status: 'draft',
    });
    for (const path of ['a..b', '../secret', 'a.b.c.d.e.f.g.h.i', "a'; DROP TABLE users; --"]) {
      const response = await put(`/api/v1/activities/${activityId}/experiment`, w.author.cookie, {
        simulationType: 'circuit',
        rules: [{ path, op: 'exists' }],
      });
      expect(response.statusCode, path).toBe(400);
    }
  });

  it('refuses attaching a lab to an ASSESSMENT activity', async () => {
    const w = await world();
    const { activityId } = await createActivity({
      lessonId: w.lesson,
      activityType: 'assessment',
      status: 'draft',
    });
    const response = await put(`/api/v1/activities/${activityId}/experiment`, w.author.cookie, {
      simulationType: 'circuit',
      rules: [],
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('I — artifacts are append-only', () => {
  it('lets the owner append while the session is live', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await post(
      `/api/v1/experiment-sessions/${session.id}/artifacts`,
      w.learner.cookie,
      { artifactType: 'telemetry_log', payload: { events: [1, 2, 3] } },
    );
    expect(response.statusCode, response.body).toBe(201);
    expect(
      items(await get(`/api/v1/experiment-sessions/${session.id}/artifacts`, w.learner.cookie)),
    ).toHaveLength(1);
  });

  it('refuses a peer appending to somebody else’s session', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const response = await post(
      `/api/v1/experiment-sessions/${session.id}/artifacts`,
      w.peer.cookie,
      { artifactType: 'snapshot' },
    );
    expect(response.statusCode).toBe(404);
  });

  it('exposes no route that edits or deletes one', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    const created = await post(
      `/api/v1/experiment-sessions/${session.id}/artifacts`,
      w.learner.cookie,
      { artifactType: 'snapshot' },
    );
    const artifactId = created.json<{ id: string }>().id;
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await testApp.app.inject({
        method,
        url: `/api/v1/experiment-artifacts/${artifactId}`,
        headers: { ...writeHeaders, cookie: w.learner.cookie },
        payload: {},
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  it('lets the teacher of the shared class read them', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await post(`/api/v1/experiment-sessions/${session.id}/artifacts`, w.learner.cookie, {
      artifactType: 'snapshot',
    });
    const response = await get(
      `/api/v1/experiment-sessions/${session.id}/artifacts`,
      w.teacher.cookie,
    );
    expect(response.statusCode).toBe(200);
    expect(items(response)).toHaveLength(1);
  });
});

describe('J — the audit trail records what happened, and nothing it should not', () => {
  it('records a start and a submission', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await post(`/api/v1/experiment-sessions/${session.id}/submit`, w.learner.cookie, {
      currentState: PASSING,
    });
    const types = await auditTypes();
    expect(types).toContain('lab.session_started');
    expect(types).toContain('lab.submitted');
  });

  it('records a denial without recording what was refused', async () => {
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await post(`/api/v1/experiment-sessions/${session.id}/submit`, w.peer.cookie, {
      currentState: PASSING,
    });

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: unknown }>(
        `SELECT detail FROM audit_log WHERE event_type = 'authz.denied'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(rows.map((r) => r.detail));
      // Ids and reasons, never the state that was refused and never a rule.
      expect(serialized).not.toMatch(/voltage|circuit|closed|isTrue/);
    } finally {
      await raw.end();
    }
  });

  it('records a denial — not a write refusal — when a learner loses access', async () => {
    // WHICH EVENT FIRES IS THE POINT. The policy reads `learnerMayWork` from the
    // same statement that loaded the row, so an access loss that has already
    // happened is refused by the POLICY and recorded as `authz.denied`.
    //
    // `lab.state_write_refused` covers the strictly narrower case the policy
    // cannot see: the loss landing between the decision and the UPDATE, where
    // RLS matches zero rows and says nothing. That race is not reproducible
    // from here without instrumenting the transaction, so this asserts the
    // boundary it CAN reach and names the one it cannot, rather than claiming
    // coverage it does not have.
    const w = await world();
    const { session } = await startSession(w, w.learner);
    await asSuperuser(
      `UPDATE class_memberships SET status = 'ended', ended_at = now() WHERE user_id = $1`,
      [w.learner.id],
    );
    const refused = await put(
      `/api/v1/experiment-sessions/${session.id}/state`,
      w.learner.cookie,
      { currentState: PASSING },
    );
    expect(refused.statusCode).toBe(404);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      const { rows } = await raw.query<{ detail: { reason?: string } }>(
        `SELECT detail FROM audit_log WHERE event_type = 'authz.denied'`,
      );
      expect(rows.map((r) => r.detail.reason)).toContain(
        'experiment_session.lab_not_accessible',
      );
    } finally {
      await raw.end();
    }
  });
});

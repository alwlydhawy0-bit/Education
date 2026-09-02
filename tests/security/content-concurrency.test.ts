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
 * Concurrent authoring, and the whole chain from a course to a mastery level.
 *
 * TWO THINGS ARE UNDER TEST HERE and they are related.
 *
 * The first is the LOST UPDATE. Two authors open the same draft; one saves; the
 * other saves the form they filled in five minutes ago. Without a concurrency
 * token the second write silently destroys the first — no error, no trace, and
 * the only evidence is an author insisting they wrote something that is no
 * longer there. Every case below asserts not merely that the second write was
 * refused but that the FIRST AUTHOR'S TEXT SURVIVED, because a refusal that
 * still overwrote would pass a weaker test.
 *
 * The second is that none of the lifecycle machinery may disturb work already
 * done by learners. A lesson that is edited, published, republished or archived
 * must leave every completed attempt, released result, objective evidence row
 * and mastery level exactly as it was — no rescoring, no re-pointing, no
 * silently changed meaning. That is asserted over the full chain rather than
 * per table, because the failure mode is a broken JOIN somewhere in the middle.
 *
 * Everything goes over real HTTP against a real database as `edu_app`, so the
 * policy engine and RLS are both in the path exactly as in production.
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

interface LessonBody {
  readonly id: string;
  readonly title: string;
  readonly contentBody: string;
  readonly objectives: readonly string[];
  readonly status: 'draft' | 'published' | 'archived';
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly permissions: { update: boolean; publish: boolean; archive: boolean };
}

const lessonOf = (r: { json: <T>() => T }) => r.json<LessonBody>();
const id = (r: { json: <T>() => T }) => r.json<{ id: string }>().id;
const errorOf = (r: { json: <T>() => T }) =>
  r.json<{ error: { message: string; detail?: Record<string, unknown> } }>().error;

/** Reads the lesson as the author would, returning the current token. */
const readLesson = async (lessonId: string, cookie: string): Promise<LessonBody> => {
  const response = await get(`/api/v1/lessons/${lessonId}`, cookie);
  if (response.statusCode !== 200) throw new Error(`read failed: ${response.body}`);
  return lessonOf(response);
};

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

/** Reads rows the API deliberately does not expose, to prove they survived. */
async function rawRows<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<T>(sql, [...params]);
    return rows;
  } finally {
    await raw.end();
  }
}

let levelId: string;

/**
 * A school, a draft lesson to fight over, and a second author who can fight.
 *
 * Both authors hold `content_author` in the SAME organization, which is the
 * situation the token exists for: they are equally entitled to edit, so nothing
 * in the authorization layer separates them and only the concurrency check can.
 */
async function world() {
  const organizationId = await createOrganization('School A');

  const author = await seedAndLogin({
    email: 'author@t.local',
    roles: ['content_author'],
    organizationId,
  });
  const coauthor = await seedAndLogin({
    email: 'coauthor@t.local',
    roles: ['content_author'],
    organizationId,
  });
  const reviewer = await seedAndLogin({
    email: 'reviewer@t.local',
    roles: ['reviewer'],
    organizationId,
  });
  const learner = await seedAndLogin({ email: 'learner@t.local', organizationId });

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
      title: 'Newton',
      contentBody: 'A body remains at rest…',
      objectives: ['Explain the second law'],
    }),
  );

  // The curriculum and course go live during seeding, because a class may only
  // be assigned a PUBLISHED course. The unit and the lesson stay drafts: they
  // are what these tests move around.
  for (const url of [
    `/api/v1/curricula/${curriculumId}/publish`,
    `/api/v1/courses/${courseId}/publish`,
  ]) {
    const response = await post(url, reviewer.cookie);
    if (response.statusCode !== 200)
      throw new Error(`seed publish failed: ${url} ${response.body}`);
  }

  const classId = await createClass(organizationId, 'A1');
  await addClassMember(classId, learner.id);
  await assignCourseToClass({ classId, courseId });

  return {
    organizationId,
    author,
    coauthor,
    reviewer,
    learner,
    curriculumId,
    courseId,
    unitId,
    lessonId,
    classId,
  };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

/**
 * Publishes the unit, completing the chain above the lesson.
 *
 * The curriculum and course are already live from seeding; 0022 refuses to
 * publish a node beneath a draft parent, so the unit is the last thing standing
 * between the lesson and a learner.
 */
async function publishAncestors(): Promise<void> {
  const response = await post(`/api/v1/units/${w.unitId}/publish`, w.reviewer.cookie);
  if (response.statusCode !== 200) throw new Error(`publish failed: ${response.body}`);
}

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
// The token itself.
// =====================================================================

describe('the concurrency token', () => {
  it('is issued on every read and moves after every write', async () => {
    const first = await readLesson(w.lessonId, w.author.cookie);
    expect(first.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const saved = lessonOf(
      await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
        title: 'Newton I',
        expectedUpdatedAt: first.updatedAt,
      }),
    );
    // Strictly later, so a client that reused the old one is detected. This is
    // the property `GREATEST(now(), updated_at + 1ms)` exists to guarantee.
    expect(new Date(saved.updatedAt).getTime()).toBeGreaterThan(
      new Date(first.updatedAt).getTime(),
    );
  });

  it('advances on a lifecycle move too, not only on an edit', async () => {
    await publishAncestors();
    const before = await readLesson(w.lessonId, w.author.cookie);
    const published = lessonOf(
      await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie, {
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    expect(new Date(published.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime(),
    );
  });

  it('is optional — a caller with no earlier read is not forced to invent one', async () => {
    // Last-write-wins for a script. Demanding a token from a caller that never
    // read would break every non-browser client to protect a read it never made.
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      title: 'From a script',
    });
    expect(response.statusCode).toBe(200);
  });

  it('is not a field: a patch carrying ONLY the token is refused as empty', async () => {
    const current = await readLesson(w.lessonId, w.author.cookie);
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      expectedUpdatedAt: current.updatedAt,
    });
    expect(response.statusCode).toBe(400);
    // And nothing moved, so a no-op cannot be used to invalidate everyone
    // else's token.
    const after = await readLesson(w.lessonId, w.author.cookie);
    expect(after.updatedAt).toBe(current.updatedAt);
  });

  it('rejects a malformed token rather than ignoring it', async () => {
    for (const bad of ['not-a-date', '', 12345, null, { at: 'now' }]) {
      const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
        title: 'X',
        expectedUpdatedAt: bad,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('a token invented from the future is a conflict, never a success', async () => {
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      title: 'Forged',
      expectedUpdatedAt: '2099-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).detail).toMatchObject({ reason: 'stale_write' });
  });

  it('another lesson’s token does not unlock this one', async () => {
    const otherId = id(
      await post(`/api/v1/units/${w.unitId}/lessons`, w.author.cookie, { title: 'Other' }),
    );
    const other = await readLesson(otherId, w.author.cookie);

    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      title: 'Cross-wired',
      expectedUpdatedAt: other.updatedAt,
    });
    expect(response.statusCode).toBe(409);
  });
});

// =====================================================================
// The five scenarios the task names.
// =====================================================================

describe('two authors editing the same draft', () => {
  it('the second save is refused and the first author’s work survives', async () => {
    // Both open the same draft and see the same version.
    const asAuthor = await readLesson(w.lessonId, w.author.cookie);
    const asCoauthor = await readLesson(w.lessonId, w.coauthor.cookie);
    expect(asCoauthor.updatedAt).toBe(asAuthor.updatedAt);

    const first = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      contentBody: 'Carefully written by the first author',
      expectedUpdatedAt: asAuthor.updatedAt,
    });
    expect(first.statusCode).toBe(200);

    const second = await patch(`/api/v1/lessons/${w.lessonId}`, w.coauthor.cookie, {
      contentBody: 'Typed from a form loaded ten minutes ago',
      expectedUpdatedAt: asCoauthor.updatedAt,
    });
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).detail).toMatchObject({ reason: 'stale_write' });

    // THE ASSERTION THAT MATTERS. A 409 that had still written would pass a
    // weaker test; what must hold is that the first author's text is intact.
    const after = await readLesson(w.lessonId, w.author.cookie);
    expect(after.contentBody).toBe('Carefully written by the first author');
  });

  it('the loser can reload and then succeed, without being told who won', async () => {
    const stale = await readLesson(w.lessonId, w.coauthor.cookie);
    await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      contentBody: 'First',
      expectedUpdatedAt: stale.updatedAt,
    });

    const refused = await patch(`/api/v1/lessons/${w.lessonId}`, w.coauthor.cookie, {
      contentBody: 'Second',
      expectedUpdatedAt: stale.updatedAt,
    });
    expect(refused.statusCode).toBe(409);
    // The message names no actor. The author who lost the race is not entitled
    // to learn that a particular colleague exists, let alone which one.
    const body = JSON.stringify(errorOf(refused));
    expect(body).not.toContain('author@t.local');
    expect(body).not.toContain(w.author.id);

    const reloaded = await readLesson(w.lessonId, w.coauthor.cookie);
    const retried = await patch(`/api/v1/lessons/${w.lessonId}`, w.coauthor.cookie, {
      contentBody: 'Second, reapplied',
      expectedUpdatedAt: reloaded.updatedAt,
    });
    expect(retried.statusCode).toBe(200);
  });

  it('records the refusal for audit, without recording the content', async () => {
    const stale = await readLesson(w.lessonId, w.coauthor.cookie);
    await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      contentBody: 'First',
      expectedUpdatedAt: stale.updatedAt,
    });
    await patch(`/api/v1/lessons/${w.lessonId}`, w.coauthor.cookie, {
      contentBody: 'A secret second draft',
      expectedUpdatedAt: stale.updatedAt,
    });

    expect(await auditTypes()).toContain('content.stale_write_refused');
    const details = await rawRows<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE event_type = 'content.stale_write_refused'`,
    );
    expect(details).toHaveLength(1);
    expect(details[0]?.detail).toMatchObject({ resourceKind: 'lesson', resourceId: w.lessonId });
    // The rejected content is NOT in the audit trail, which is more widely
    // readable than the draft it describes.
    expect(JSON.stringify(details[0]?.detail)).not.toContain('secret second draft');
  });
});

describe('an author edits while another user publishes', () => {
  it('the edit written against the pre-publish version is refused', async () => {
    await publishAncestors();
    const beforePublish = await readLesson(w.lessonId, w.author.cookie);

    const published = await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie, {
      expectedUpdatedAt: beforePublish.updatedAt,
    });
    expect(published.statusCode).toBe(200);

    // The author's form still holds the draft's token.
    const late = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      contentBody: 'Edited as if still a draft',
      expectedUpdatedAt: beforePublish.updatedAt,
    });
    expect(late.statusCode).toBe(409);
    expect(errorOf(late).detail).toMatchObject({ reason: 'stale_write' });

    // And the published lesson is untouched — including its status, which is
    // the part a learner is already reading.
    const after = await readLesson(w.lessonId, w.author.cookie);
    expect(after.status).toBe('published');
    expect(after.contentBody).toBe('A body remains at rest…');
  });

  it('an objective edit racing a publish cannot slip in under the old version', async () => {
    await publishAncestors();
    const beforePublish = await readLesson(w.lessonId, w.author.cookie);
    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);

    // Two independent controls would refuse this: the stale token, and 0022's
    // freeze on a published lesson's objectives. The token is reached first,
    // which is why the reason is `stale_write` — and the objectives are still
    // what the learners' evidence points at either way.
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      objectives: ['Something else entirely'],
      expectedUpdatedAt: beforePublish.updatedAt,
    });
    expect(response.statusCode).toBe(409);

    const after = await readLesson(w.lessonId, w.author.cookie);
    expect(after.objectives).toEqual(['Explain the second law']);
  });
});

describe('an author edits after publication', () => {
  it('the title and body are still editable with a CURRENT token', async () => {
    await publishAncestors();
    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);
    const current = await readLesson(w.lessonId, w.author.cookie);

    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      title: 'Newton, corrected',
      expectedUpdatedAt: current.updatedAt,
    });
    // Publication does not freeze prose. Correcting a typo in live material is
    // ordinary editorial work and freezing it would be a rule with no reason.
    expect(response.statusCode).toBe(200);
    expect(lessonOf(response).title).toBe('Newton, corrected');
  });

  it('the objectives are refused with a CURRENT token, by the lifecycle rule', async () => {
    await publishAncestors();
    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);
    const current = await readLesson(w.lessonId, w.author.cookie);

    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      objectives: ['Reworded after learners were measured against it'],
      expectedUpdatedAt: current.updatedAt,
    });
    expect(response.statusCode).toBe(409);
    // NOT a stale write — the token was current. A different rule refused it,
    // and the client must be able to tell, because reloading would not help.
    expect(errorOf(response).detail?.['reason']).not.toBe('stale_write');
    expect(errorOf(response).message).toMatch(/objectives cannot be changed/i);
  });
});

describe('publish while another lifecycle mutation is occurring', () => {
  it('a publish carrying a superseded token is refused', async () => {
    await publishAncestors();
    const seen = await readLesson(w.lessonId, w.reviewer.cookie);

    // Somebody edits the lesson between the reviewer's read and their click.
    await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      contentBody: 'Substantially rewritten after review began',
    });

    const response = await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie, {
      expectedUpdatedAt: seen.updatedAt,
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).detail).toMatchObject({ reason: 'stale_write' });

    // Still a draft: nothing a reviewer did not read has been shown to a child.
    expect((await readLesson(w.lessonId, w.author.cookie)).status).toBe('draft');
  });

  it('a double publish is refused the second time rather than republishing', async () => {
    await publishAncestors();
    const seen = await readLesson(w.lessonId, w.reviewer.cookie);
    const first = await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie, {
      expectedUpdatedAt: seen.updatedAt,
    });
    expect(first.statusCode).toBe(200);

    // The same click again — a double-submitted form, or a replayed request.
    const second = await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie, {
      expectedUpdatedAt: seen.updatedAt,
    });
    // 403, not 409, and the order is the point: TWO independent controls would
    // refuse this — the policy ("a published lesson may not be published") and
    // the stale token — and the policy is consulted first, so it answers. The
    // caller learns they may not do it, which is the more useful of the two
    // true statements. Either way the replay achieves nothing.
    expect(second.statusCode).toBe(403);

    // `published_at` is unchanged, so the audit answer to "when did learners
    // first see this?" is still the first publish.
    const rows = await rawRows<{ published_at: Date }>(
      'SELECT published_at FROM lessons WHERE id = $1',
      [w.lessonId],
    );
    expect(rows[0]?.published_at?.toISOString()).toBe(lessonOf(first).publishedAt);
  });
});

describe('archive while another operation is occurring', () => {
  it('a stale archive is refused and the cascade does not run', async () => {
    await publishAncestors();
    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);
    const seen = await readLesson(w.lessonId, w.reviewer.cookie);

    // A published activity beneath the lesson: the cascade's target.
    const created = (
      await post(`/api/v1/lessons/${w.lessonId}/activities`, w.author.cookie, {
        activityType: 'assessment',
        title: 'Quiz',
        assessment: { passingPercentage: 50, maxAttempts: 3 },
      })
    ).json<{ id: string; assessmentId: string }>();
    const activityId = created.id;
    const assessmentId = created.assessmentId;
    await post(`/api/v1/assessments/${assessmentId}/questions`, w.author.cookie, {
      questionType: 'single_choice',
      prompt: 'Q',
      options: ['Right', 'Wrong'],
      correctOptions: [0],
    });
    await post(`/api/v1/activities/${activityId}/publish`, w.reviewer.cookie);

    // Somebody edits the lesson; the reviewer's archive click is now stale.
    await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, { title: 'Renamed' });

    const response = await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie, {
      expectedUpdatedAt: seen.updatedAt,
    });
    expect(response.statusCode).toBe(409);

    // THE CASCADE IS ATOMIC WITH THE REFUSAL. The archive walks the subtree
    // before it touches the lesson, so a rollback that missed anything would
    // leave a live lesson with retired activities under it.
    expect((await readLesson(w.lessonId, w.author.cookie)).status).toBe('published');
    const activity = await rawRows<{ status: string }>(
      'SELECT status FROM learning_activities WHERE id = $1',
      [activityId],
    );
    expect(activity[0]?.status).toBe('published');
  });

  it('the same archive succeeds once the caller reloads', async () => {
    await publishAncestors();
    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);
    const fresh = await readLesson(w.lessonId, w.reviewer.cookie);

    const response = await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie, {
      expectedUpdatedAt: fresh.updatedAt,
    });
    expect(response.statusCode).toBe(200);
    expect(lessonOf(response).status).toBe('archived');
  });
});

// =====================================================================
// The permissions block: it must agree with what is enforced.
// =====================================================================

describe('server-computed permissions', () => {
  it('an author is told they may edit but not publish, and both are true', async () => {
    await publishAncestors();
    const asAuthor = await readLesson(w.lessonId, w.author.cookie);
    expect(asAuthor.permissions).toEqual({ update: true, publish: false, archive: false });

    // The claim is checked against the enforcement, not taken on faith.
    expect((await post(`/api/v1/lessons/${w.lessonId}/publish`, w.author.cookie)).statusCode).toBe(
      403,
    );
    expect(
      (await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, { title: 'ok' })).statusCode,
    ).toBe(200);
  });

  it('a reviewer is told they may publish, and they can', async () => {
    await publishAncestors();
    const asReviewer = await readLesson(w.lessonId, w.reviewer.cookie);
    expect(asReviewer.permissions.publish).toBe(true);
    expect(
      (await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie)).statusCode,
    ).toBe(200);
  });

  it('moves with the lesson’s status, because the answer depends on it', async () => {
    await publishAncestors();
    // A draft may be published; a published lesson may not be published again.
    expect((await readLesson(w.lessonId, w.reviewer.cookie)).permissions.publish).toBe(true);

    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);
    const afterPublish = await readLesson(w.lessonId, w.reviewer.cookie);
    expect(afterPublish.permissions.publish).toBe(false);
    expect(afterPublish.permissions.archive).toBe(true);

    // Checked against the enforcement, not asserted about it: a claim of
    // `publish: false` that the server would nonetheless honour would be worse
    // than no claim at all.
    expect(
      (await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie)).statusCode,
    ).toBe(403);
    expect(
      (await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie)).statusCode,
    ).toBe(200);
  });

  it('a DRAFT may be archived, and says so — retiring unpublished work is allowed', async () => {
    await publishAncestors();
    const draft = await readLesson(w.lessonId, w.reviewer.cookie);
    expect(draft.status).toBe('draft');
    // Not an oversight in the capability block: a draft nobody has seen can be
    // retired without ever going live, and the claim is proved by doing it.
    expect(draft.permissions.archive).toBe(true);
    expect(
      (await post(`/api/v1/lessons/${w.lessonId}/archive`, w.reviewer.cookie)).statusCode,
    ).toBe(200);
  });

  it('a learner reading a published lesson is granted nothing', async () => {
    await publishAncestors();
    await post(`/api/v1/lessons/${w.lessonId}/publish`, w.reviewer.cookie);
    const asLearner = await readLesson(w.lessonId, w.learner.cookie);
    expect(asLearner.permissions).toEqual({ update: false, publish: false, archive: false });
  });

  it('is never accepted FROM a client — it is output only', async () => {
    // The obvious attack on a capability field: send it back.
    const response = await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, {
      title: 'X',
      permissions: { update: true, publish: true, archive: true },
    });
    expect(response.statusCode).toBe(400);

    const onPublish = await post(`/api/v1/lessons/${w.lessonId}/publish`, w.author.cookie, {
      permissions: { publish: true },
    });
    expect(onPublish.statusCode).toBe(400);
  });

  it('does not record a denial for every capability it computes', async () => {
    // Three policy decisions per read. Logging the refusals would bury real
    // probing under a flood of questions nobody asked.
    // One ALLOWED read, which internally asks three further questions. A denial
    // recorded here would be self-inflicted: nobody attempted anything.
    expect((await get(`/api/v1/lessons/${w.lessonId}`, w.author.cookie)).statusCode).toBe(200);
    expect((await auditTypes()).filter((t) => t === 'authz.denied')).toHaveLength(0);
  });
});

// =====================================================================
// Direct HTTP, bypassing the frontend entirely.
// =====================================================================

describe('direct HTTP calls that no interface would make', () => {
  const tamper = async (payload: Record<string, unknown>): Promise<number> =>
    (await patch(`/api/v1/lessons/${w.lessonId}`, w.author.cookie, payload)).statusCode;

  it('refuses forged identity, ownership and lifecycle fields on a patch', async () => {
    for (const field of [
      { organizationId: '00000000-0000-4000-8000-000000000000' },
      { authorId: '00000000-0000-4000-8000-000000000000' },
      { createdBy: '00000000-0000-4000-8000-000000000000' },
      { ownerId: '00000000-0000-4000-8000-000000000000' },
      { publisherId: '00000000-0000-4000-8000-000000000000' },
      { userId: '00000000-0000-4000-8000-000000000000' },
      { role: 'admin' },
      { status: 'published' },
      { publishedAt: '2020-01-01T00:00:00.000Z' },
      { updatedAt: '2020-01-01T00:00:00.000Z' },
      { unitId: '00000000-0000-4000-8000-000000000000' },
      { id: '00000000-0000-4000-8000-000000000000' },
      { permissions: { publish: true } },
    ]) {
      expect(await tamper({ title: 'X', ...field })).toBe(400);
    }
  });

  it('refuses the same fields on publish and archive', async () => {
    for (const url of [
      `/api/v1/lessons/${w.lessonId}/publish`,
      `/api/v1/lessons/${w.lessonId}/archive`,
    ]) {
      for (const payload of [
        { status: 'published' },
        { organizationId: '00000000-0000-4000-8000-000000000000' },
        { publisherId: '00000000-0000-4000-8000-000000000000' },
        { publishedAt: '2020-01-01T00:00:00.000Z' },
        { objectives: ['injected'] },
      ]) {
        expect((await post(url, w.reviewer.cookie, payload)).statusCode).toBe(400);
      }
    }
  });

  it('a learner cannot reach the authoring endpoints at all', async () => {
    expect(
      (await patch(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie, { title: 'Mine' }))
        .statusCode,
    ).toBe(404);
    expect((await post(`/api/v1/lessons/${w.lessonId}/publish`, w.learner.cookie)).statusCode).toBe(
      404,
    );
    expect((await post(`/api/v1/lessons/${w.lessonId}/archive`, w.learner.cookie)).statusCode).toBe(
      404,
    );
  });

  it('a draft lesson is invisible to a learner, token or no token', async () => {
    // Not merely "the editor does not show it" — the row is not readable.
    expect((await get(`/api/v1/lessons/${w.lessonId}`, w.learner.cookie)).statusCode).toBe(404);
  });
});

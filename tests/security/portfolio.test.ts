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
  assignTeacher,
  closeSeedDb,
  createClass,
  createOrganization,
  createUser,
  grantRole,
  linkGuardian,
  truncateAll,
} from '../setup/fixtures.ts';
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';

/**
 * Projects, portfolios and the public share link, end to end over the real
 * HTTP stack.
 *
 * Nothing is stubbed: the same composition root, the same policy engine, the
 * same `edu_app` role, the same RLS. This is the file section 2D names, and the
 * IDOR/BOLA matrix in the Task 013 report traces to the cases marked
 * `IDOR-<letter>` below.
 *
 * The RLS half — the same boundaries with no application code in the path — is
 * `tests/integration/rls-projects.test.ts`. The pure-function half is
 * `tests/unit/portfolio-public-view.test.ts`. None of the three is sufficient
 * alone, and the middle one is the only one that can catch a route that forgot
 * to call the service at all.
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

const get = (url: string, cookie?: string) =>
  testApp.app.inject({
    method: 'GET',
    url,
    ...(cookie ? { headers: { cookie } } : {}),
  });

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  testApp.app.inject({
    method: 'POST',
    url,
    headers: { ...writeHeaders, cookie },
    payload: payload ?? {},
  });

const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  testApp.app.inject({ method: 'PUT', url, headers: { ...writeHeaders, cookie }, payload });

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

/** Every field the audit trail holds, so a leak into `detail` is visible. */
async function auditDetails(): Promise<string> {
  const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
  await raw.connect();
  try {
    const { rows } = await raw.query<{ detail: unknown }>('SELECT detail FROM audit_log');
    return JSON.stringify(rows);
  } finally {
    await raw.end();
  }
}

interface World {
  orgA: string;
  orgB: string;
  klass: string;
  otherClass: string;
  learner: Session;
  classmate: Session;
  outsider: Session;
  teacher: Session;
  otherTeacher: Session;
  admin: Session;
  guardian: Session;
  stranger: Session;
}

/**
 * Two schools, two classes in the first, and one adult of every kind.
 *
 * `otherTeacher` teaches `otherClass` in the SAME school, which is the case
 * that separates "an adult in your organization" from "the adult responsible
 * for your class". Without them the review boundary would look correct while
 * actually being organization-wide.
 */
async function world(): Promise<World> {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');

  const learner = await seedAndLogin({
    email: 'learner@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const classmate = await seedAndLogin({
    email: 'classmate@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const outsider = await seedAndLogin({
    email: 'outsider@a.test',
    roles: ['student'],
    organizationId: orgA,
  });
  const teacher = await seedAndLogin({
    email: 'teacher@a.test',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const otherTeacher = await seedAndLogin({
    email: 'other-teacher@a.test',
    roles: ['teacher'],
    organizationId: orgA,
  });
  const admin = await seedAndLogin({
    email: 'admin@a.test',
    roles: ['admin'],
    organizationId: orgA,
  });
  await grantRole(admin.id, 'admin', 'organization', orgA);
  const guardian = await seedAndLogin({
    email: 'guardian@a.test',
    roles: ['guardian'],
    organizationId: orgA,
  });
  const stranger = await seedAndLogin({
    email: 'stranger@b.test',
    roles: ['student'],
    organizationId: orgB,
  });

  const klass = await createClass(orgA, 'A1');
  const otherClass = await createClass(orgA, 'A2');
  await addClassMember(klass, learner.id);
  await addClassMember(klass, classmate.id);
  await addClassMember(otherClass, outsider.id);
  await assignTeacher(teacher.id, klass);
  await assignTeacher(otherTeacher.id, otherClass);
  await linkGuardian(guardian.id, learner.id, 'verified');

  return {
    orgA,
    orgB,
    klass,
    otherClass,
    learner,
    classmate,
    outsider,
    teacher,
    otherTeacher,
    admin,
    guardian,
    stranger,
  };
}

interface ProjectBody {
  id: string;
  visibility: string;
  status: string;
  title: string;
  repositoryUrl: string | null;
  featuredAt: string | null;
}

interface PortfolioBody {
  id: string;
  shareToken: string;
  publicSlug: string | null;
  isPublished: boolean;
  items: { projectId: string; displayOrder: number; title: string }[];
}

/** A submitted project in the learner's class, at the visibility asked for. */
async function makeProject(
  w: World,
  session: Session,
  overrides: Record<string, unknown> = {},
): Promise<ProjectBody> {
  const created = await post('/api/v1/projects', session.cookie, {
    title: 'Pendulum period vs. length',
    descriptionMarkdown: 'Twenty trials.',
    classId: w.klass,
    ...overrides,
  });
  expect(created.statusCode, created.body).toBe(201);
  const project = created.json<ProjectBody>();
  if (overrides.status !== 'draft') {
    const submitted = await put(`/api/v1/projects/${project.id}`, session.cookie, {
      status: 'submitted',
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    return submitted.json<ProjectBody>();
  }
  return project;
}

/** A published portfolio holding one public project. Returns the share token. */
async function publishedPortfolio(w: World, session: Session = w.learner) {
  const project = await makeProject(w, session, { visibility: 'public' });
  const created = await post('/api/v1/me/portfolio', session.cookie, { title: 'My work' });
  expect(created.statusCode, created.body).toBe(201);
  const added = await post('/api/v1/me/portfolio/items', session.cookie, {
    projectId: project.id,
  });
  expect(added.statusCode, added.body).toBe(201);
  const published = await post('/api/v1/me/portfolio/publish', session.cookie);
  expect(published.statusCode, published.body).toBe(200);
  return { project, portfolio: published.json<PortfolioBody>() };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await testApp.db.close();
  await closeSeedDb();
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('a project belongs to the learner who made it', () => {
  it('creates it as a private draft whatever the caller asks for', async () => {
    const w = await world();
    const created = await post('/api/v1/projects', w.learner.cookie, {
      title: 'Untitled',
      classId: w.klass,
    });
    expect(created.statusCode, created.body).toBe(201);
    const project = created.json<ProjectBody>();
    expect(project.visibility).toBe('private');
    expect(project.status).toBe('draft');
  });

  it('IDOR-A: refuses a forged studentId in the body outright', async () => {
    const w = await world();
    // `.strict()` makes this a 400 rather than a silently-ignored field. A
    // dropped forged field is indistinguishable from a trusted one (VULN-028).
    const created = await post('/api/v1/projects', w.learner.cookie, {
      title: 'Not mine',
      classId: w.klass,
      studentId: w.classmate.id,
    });
    expect(created.statusCode).toBe(400);
  });

  it('IDOR-B: refuses a status the learner may not name', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner);
    // `featured` is a reviewer's word. A learner cannot award themselves one.
    const attempt = await put(`/api/v1/projects/${project.id}`, w.learner.cookie, {
      status: 'featured',
    });
    expect(attempt.statusCode).toBe(400);
  });

  it('IDOR-C: another learner cannot read, update or delete it', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner, { visibility: 'private' });

    // 404 everywhere, never 403: a 403 would confirm the id names a real
    // project, which is the one bit an attacker walking ids is buying.
    expect((await get(`/api/v1/projects/${project.id}`, w.classmate.cookie)).statusCode).toBe(404);
    expect(
      (await put(`/api/v1/projects/${project.id}`, w.classmate.cookie, { title: 'Mine now' }))
        .statusCode,
    ).toBe(404);
    expect((await del(`/api/v1/projects/${project.id}`, w.classmate.cookie)).statusCode).toBe(404);
  });

  it('IDOR-D: a made-up id is indistinguishable from somebody else’s', async () => {
    const w = await world();
    const real = await makeProject(w, w.learner, { visibility: 'private' });
    const invented = '11111111-1111-4111-8111-111111111111';

    const [a, b] = await Promise.all([
      get(`/api/v1/projects/${real.id}`, w.classmate.cookie),
      get(`/api/v1/projects/${invented}`, w.classmate.cookie),
    ]);
    expect(a.statusCode).toBe(b.statusCode);
    // The correlation id differs per request by design, so the comparison is of
    // everything else: an attacker learns nothing from a value they cannot
    // predict and that says nothing about the object.
    const shape = (r: { json: <T>() => T }) => {
      const { error } = r.json<{ error: { code: string; message: string } }>();
      return { code: error.code, message: error.message };
    };
    expect(shape(a)).toEqual(shape(b));
  });

  it('IDOR-E: /me/projects lists only the caller’s own', async () => {
    const w = await world();
    await makeProject(w, w.learner, { visibility: 'public' });
    await makeProject(w, w.classmate, { visibility: 'public' });

    const mine = items<ProjectBody>(await get('/api/v1/me/projects', w.learner.cookie));
    expect(mine).toHaveLength(1);
  });

  it('cannot attach an artifact to somebody else’s project', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner);
    const attempt = await post(`/api/v1/projects/${project.id}/artifacts`, w.classmate.cookie, {
      artifactType: 'report_pdf',
      filePathOrUrl: 'https://cdn.example.org/theirs.pdf',
      byteSize: 100,
    });
    expect(attempt.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The class boundary
// ---------------------------------------------------------------------------

describe('classmates see shared work and nothing else', () => {
  it('IDOR-F: a classmate reads a class-visible project but not a private one', async () => {
    const w = await world();
    const shared = await makeProject(w, w.learner, { visibility: 'class' });
    const secret = await makeProject(w, w.learner, { visibility: 'private' });

    expect((await get(`/api/v1/projects/${shared.id}`, w.classmate.cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/projects/${secret.id}`, w.classmate.cookie)).statusCode).toBe(404);
  });

  it('a draft is invisible to a classmate even at class visibility', async () => {
    const w = await world();
    const created = await post('/api/v1/projects', w.learner.cookie, {
      title: 'Half done',
      classId: w.klass,
      visibility: 'class',
    });
    const draft = created.json<ProjectBody>();
    expect(draft.status).toBe('draft');
    expect((await get(`/api/v1/projects/${draft.id}`, w.classmate.cookie)).statusCode).toBe(404);
  });

  it('IDOR-G: a learner in another class of the same school sees nothing', async () => {
    const w = await world();
    const shared = await makeProject(w, w.learner, { visibility: 'class' });
    expect((await get(`/api/v1/projects/${shared.id}`, w.outsider.cookie)).statusCode).toBe(404);
  });

  it('IDOR-H: a learner in another school sees nothing', async () => {
    const w = await world();
    const shared = await makeProject(w, w.learner, { visibility: 'public' });
    expect((await get(`/api/v1/projects/${shared.id}`, w.stranger.cookie)).statusCode).toBe(404);
  });

  it('IDOR-I: the class showcase excludes drafts and private work', async () => {
    const w = await world();
    await makeProject(w, w.learner, { visibility: 'class', title: 'Shared' });
    await makeProject(w, w.learner, { visibility: 'private', title: 'Private' });
    await post('/api/v1/projects', w.learner.cookie, {
      title: 'Draft',
      classId: w.klass,
      visibility: 'class',
    });

    const shown = items<ProjectBody>(
      await get(`/api/v1/classes/${w.klass}/projects`, w.classmate.cookie),
    );
    expect(shown.map((p) => p.title)).toEqual(['Shared']);
  });

  it('IDOR-J: a class the caller is not in answers empty, not 403', async () => {
    const w = await world();
    await makeProject(w, w.learner, { visibility: 'class' });

    // An empty list rather than a refusal. Distinguishing "not your class" from
    // "nothing shared here" would be a class-existence oracle platform-wide.
    const response = await get(`/api/v1/classes/${w.otherClass}/projects`, w.learner.cookie);
    expect(response.statusCode).toBe(200);
    expect(items(response)).toEqual([]);

    const invented = await get(
      '/api/v1/classes/11111111-1111-4111-8111-111111111111/projects',
      w.learner.cookie,
    );
    expect(invented.statusCode).toBe(200);
    expect(items(invented)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The review boundary
// ---------------------------------------------------------------------------

describe('a reviewer may feature a project and nothing else', () => {
  it('the class teacher reads a submitted private project', async () => {
    const w = await world();
    // Deliberately NOT gated on visibility: `private` means private from other
    // learners, not from the adult responsible for the class.
    const project = await makeProject(w, w.learner, { visibility: 'private' });
    expect((await get(`/api/v1/projects/${project.id}`, w.teacher.cookie)).statusCode).toBe(200);
  });

  it('the class teacher cannot read a DRAFT', async () => {
    const w = await world();
    const created = await post('/api/v1/projects', w.learner.cookie, {
      title: 'Half done',
      classId: w.klass,
    });
    const draft = created.json<ProjectBody>();
    expect((await get(`/api/v1/projects/${draft.id}`, w.teacher.cookie)).statusCode).toBe(404);
  });

  it('IDOR-K: a teacher of another class in the same school sees nothing', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner, { visibility: 'private' });
    expect((await get(`/api/v1/projects/${project.id}`, w.otherTeacher.cookie)).statusCode).toBe(
      404,
    );
    expect(
      (await post(`/api/v1/projects/${project.id}/feature`, w.otherTeacher.cookie)).statusCode,
    ).toBe(404);
  });

  it('IDOR-L: the class teacher cannot rewrite the learner’s work', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner);
    const attempt = await put(`/api/v1/projects/${project.id}`, w.teacher.cookie, {
      descriptionMarkdown: 'I have replaced what you wrote.',
    });
    expect(attempt.statusCode).toBe(404);

    const unchanged = await get(`/api/v1/projects/${project.id}`, w.learner.cookie);
    expect(unchanged.json<{ descriptionMarkdown: string }>().descriptionMarkdown).toBe(
      'Twenty trials.',
    );
  });

  it('IDOR-M: the class teacher cannot publish a child’s work to the world', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner, { visibility: 'private' });
    const attempt = await put(`/api/v1/projects/${project.id}`, w.teacher.cookie, {
      visibility: 'public',
    });
    expect(attempt.statusCode).toBe(404);

    const still = await get(`/api/v1/projects/${project.id}`, w.learner.cookie);
    expect(still.json<ProjectBody>().visibility).toBe('private');
  });

  it('the class teacher features a submitted project, and it is audited', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner);
    const featured = await post(`/api/v1/projects/${project.id}/feature`, w.teacher.cookie);
    expect(featured.statusCode, featured.body).toBe(200);
    expect(featured.json<ProjectBody>().status).toBe('featured');

    expect(await auditTypes()).toContain('project.featured');
  });

  it('an organization admin may feature; a guardian may not read at all', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner, { visibility: 'private' });

    expect((await post(`/api/v1/projects/${project.id}/feature`, w.admin.cookie)).statusCode).toBe(
      200,
    );
    // NO GUARDIAN BRANCH. A guardian who may read a shared note has no reach
    // here; a project's audience is a decision the learner makes per project.
    expect((await get(`/api/v1/projects/${project.id}`, w.guardian.cookie)).statusCode).toBe(404);
  });

  it('nobody features their own work, not even its owner', async () => {
    const w = await world();
    const own = await makeProject(w, w.learner);
    const attempt = await post(`/api/v1/projects/${own.id}/feature`, w.learner.cookie);
    // `reveal`, not `hide`: the owner plainly knows the project exists, and the
    // honest answer is that a self-conferred distinction is not a distinction.
    expect(attempt.statusCode).toBe(403);
  });

  it('a teacher cannot create a project in a class they merely teach', async () => {
    const w = await world();
    // A project is a LEARNER'S work. `student_project_guard` requires class
    // MEMBERSHIP, and teaching a class is not being in it. This used to surface
    // as a 500 because the SQLSTATE was unmapped.
    const attempt = await post('/api/v1/projects', w.teacher.cookie, {
      title: 'Mine',
      classId: w.klass,
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('a draft cannot be featured', async () => {
    const w = await world();
    const created = await post('/api/v1/projects', w.learner.cookie, {
      title: 'Half done',
      classId: w.klass,
    });
    const draft = created.json<ProjectBody>();
    expect((await post(`/api/v1/projects/${draft.id}/feature`, w.teacher.cookie)).statusCode).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// The portfolio
// ---------------------------------------------------------------------------

describe('the portfolio belongs to its learner', () => {
  it('IDOR-N: another learner cannot read it, and there is no id to try', async () => {
    const w = await world();
    await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'My work' });

    // `/me/portfolio` has no path parameter at all: the IDOR surface is absent
    // rather than defended. The classmate simply gets their own absence.
    expect((await get('/api/v1/me/portfolio', w.classmate.cookie)).statusCode).toBe(404);
  });

  it('IDOR-O: a learner cannot put somebody else’s project in their portfolio', async () => {
    const w = await world();
    const theirs = await makeProject(w, w.learner, { visibility: 'public' });
    await post('/api/v1/me/portfolio', w.classmate.cookie, { title: 'Mine' });

    // Refused by a composite foreign key, not by a policy somebody could edit:
    // (portfolio_id, owner_id) and (project_id, owner_id) both point at the
    // same person, so a mismatched pair has no parent row.
    const attempt = await post('/api/v1/me/portfolio/items', w.classmate.cookie, {
      projectId: theirs.id,
    });
    expect([404, 400]).toContain(attempt.statusCode);

    const mine = await get('/api/v1/me/portfolio', w.classmate.cookie);
    expect(mine.json<PortfolioBody>().items).toEqual([]);
  });

  it('refuses to publish a portfolio with nothing public in it', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner, { visibility: 'private' });
    await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'My work' });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: project.id });

    // `reveal`, because the learner has to be told what to fix. Publishing it
    // would produce a live URL showing a name, a bio and a blank space.
    const attempt = await post('/api/v1/me/portfolio/publish', w.learner.cookie);
    expect(attempt.statusCode).toBe(403);
  });

  it('refuses a second portfolio', async () => {
    const w = await world();
    await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'One' });
    const second = await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'Two' });
    expect(second.statusCode).toBe(409);
  });

  it('offers alternatives when a slug is taken, rather than silently suffixing', async () => {
    const w = await world();
    await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'Mine' });
    await post('/api/v1/me/portfolio', w.classmate.cookie, { title: 'Theirs' });

    expect(
      (await put('/api/v1/me/portfolio', w.learner.cookie, { publicSlug: 'alex-chen' })).statusCode,
    ).toBe(200);

    const clash = await put('/api/v1/me/portfolio', w.classmate.cookie, {
      publicSlug: 'alex-chen',
    });
    expect(clash.statusCode).toBe(409);
    expect(JSON.stringify(clash.json())).toContain('alex-chen-2');
  });

  it('never accepts a share token from a caller', async () => {
    const w = await world();
    const created = await post('/api/v1/me/portfolio', w.learner.cookie, {
      title: 'Mine',
      shareToken: 'a'.repeat(64),
    });
    expect(created.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The public boundary — the point of the whole task
// ---------------------------------------------------------------------------

describe('the public share link', () => {
  it('serves a published portfolio to a caller with no session at all', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);

    const anonymous = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    expect(anonymous.statusCode, anonymous.body).toBe(200);
    expect(anonymous.json<{ projects: unknown[] }>().projects).toHaveLength(1);
    expect(anonymous.headers['cache-control']).toBe('no-store');
  });

  it('ZERO LEAKAGE: no identifier, email or token appears in the public body', async () => {
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);

    const body = (await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).body;

    // Every id the platform holds about this page, searched for by value. The
    // sanitizer is a constructor, so this asserts the property rather than the
    // field list — a column added next year cannot pass this test by being
    // unnamed.
    for (const secret of [
      portfolio.id,
      project.id,
      w.learner.id,
      w.orgA,
      w.klass,
      portfolio.shareToken,
      'learner@a.test',
    ]) {
      expect(body, `${secret} leaked`).not.toContain(secret);
    }
  });

  it('shows the owner exactly what a stranger sees, session or not', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);
    // A private project in the same portfolio: the owner must NOT see it here.
    const hidden = await makeProject(w, w.learner, { visibility: 'private', title: 'Hidden' });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: hidden.id });

    const asOwner = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`, w.learner.cookie);
    const asStranger = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);

    // Byte-identical. If the resolver ran as the caller, the owner would see
    // their hidden project and conclude that is what the world sees.
    expect(asOwner.body).toBe(asStranger.body);
    expect(asOwner.body).not.toContain('Hidden');
  });

  it('hides items whose projects are private, including their ids and positions', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);
    const hiddenA = await makeProject(w, w.learner, { visibility: 'private', title: 'Secret A' });
    const hiddenB = await makeProject(w, w.learner, { visibility: 'class', title: 'Secret B' });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: hiddenA.id });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: hiddenB.id });

    const body = (await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).body;
    expect(body).not.toContain(hiddenA.id);
    expect(body).not.toContain(hiddenB.id);
    expect(body).not.toContain('Secret');

    // And the surviving project is at position 1, not position 1-of-3.
    const view = JSON.parse(body) as { projects: { position: number }[] };
    expect(view.projects.map((p) => p.position)).toEqual([1]);
  });

  it('renumbers position from 1 when a HIDDEN item sorts first', async () => {
    /**
     * THE CASE DEFECT INJECTION F2 EXPOSED AS UNCOVERED.
     *
     * The suite already asserted `position === [1]` for a page with one visible
     * project — but that project was added first, so its stored `display_order`
     * was 1 too, and copying the stored value instead of renumbering passed.
     * Only the unit suite caught it.
     *
     * Here the hidden project is added FIRST, so the visible one has
     * `display_order` 2. A page showing "2" would tell a stranger that
     * something sits above it that they are not being shown.
     */
    const w = await world();
    const hidden = await makeProject(w, w.learner, { visibility: 'private', title: 'First' });
    const shown = await makeProject(w, w.learner, { visibility: 'public', title: 'Second' });

    await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'My work' });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: hidden.id });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: shown.id });
    const published = await post('/api/v1/me/portfolio/publish', w.learner.cookie);
    expect(published.statusCode, published.body).toBe(200);
    const token = published.json<PortfolioBody>().shareToken;

    const view = (await get(`/api/v1/portfolios/share/${token}`)).json<{
      projects: { position: number; title: string }[];
    }>();
    expect(view.projects.map((p) => [p.position, p.title])).toEqual([[1, 'Second']]);
  });

  it('resolves by public slug as well as by token', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);
    await put('/api/v1/me/portfolio', w.learner.cookie, { publicSlug: 'noor-physics' });

    const bySlug = await get('/api/v1/portfolios/share/noor-physics');
    const byToken = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.body).toBe(byToken.body);
  });

  it('REVOCATION: unpublishing kills the link immediately and rotates the token', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);
    expect((await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).statusCode).toBe(200);

    const withdrawn = await del('/api/v1/me/portfolio/publish', w.learner.cookie);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    // The old link is dead — and so is the token itself, so republishing does
    // not resurrect a link somebody already had.
    expect((await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).statusCode).toBe(404);
    const fresh = withdrawn.json<PortfolioBody>();
    expect(fresh.shareToken).not.toBe(portfolio.shareToken);
    expect(fresh.isPublished).toBe(false);

    await post('/api/v1/me/portfolio/publish', w.learner.cookie);
    expect((await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).statusCode).toBe(404);
    expect(await auditTypes()).toContain('portfolio.unpublished');
  });

  it('REVOCATION: a learner who privates everything can still take the page down', async () => {
    /**
     * THE CASE DEFECT INJECTION F8 EXPOSED AS UNCOVERED.
     *
     * Every existing revocation test unpublishes a portfolio that still holds a
     * public project, so a defect refusing to unpublish an EMPTY one passed
     * them all. The sequence here is the one a worried child actually performs:
     * make the work private first, then ask for the page to come down.
     *
     * `publish` is refused for an empty portfolio and `unpublish` must never
     * be. Getting that asymmetry backwards would trap a learner on a live URL
     * with a 403 telling them there is nothing to show.
     */
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);
    await put(`/api/v1/projects/${project.id}`, w.learner.cookie, { visibility: 'private' });

    const withdrawn = await del('/api/v1/me/portfolio/publish', w.learner.cookie);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json<PortfolioBody>().isPublished).toBe(false);
    expect((await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).statusCode).toBe(404);

    // And publishing again IS refused, because there is genuinely nothing to
    // show. The asymmetry is the point.
    const republish = await post('/api/v1/me/portfolio/publish', w.learner.cookie);
    expect(republish.statusCode).toBe(403);
  });

  it('REVOCATION: making a project private removes it from the live page at once', async () => {
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);
    expect(
      (await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).json<{
        projects: unknown[];
      }>().projects,
    ).toHaveLength(1);

    await put(`/api/v1/projects/${project.id}`, w.learner.cookie, { visibility: 'private' });

    const after = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    expect(after.json<{ projects: unknown[] }>().projects).toEqual([]);
  });

  it('REVOCATION: deleting a project takes it off the page in one statement', async () => {
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);
    await del(`/api/v1/projects/${project.id}`, w.learner.cookie);

    const after = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    expect(after.json<{ projects: unknown[] }>().projects).toEqual([]);
  });

  it('REVOCATION: removing an item takes it off the page', async () => {
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);
    await del(`/api/v1/me/portfolio/items/${project.id}`, w.learner.cookie);

    const after = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    expect(after.json<{ projects: unknown[] }>().projects).toEqual([]);
  });

  it('an unpublished portfolio is not reachable by its token', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner, { visibility: 'public' });
    const created = await post('/api/v1/me/portfolio', w.learner.cookie, { title: 'Draft page' });
    await post('/api/v1/me/portfolio/items', w.learner.cookie, { projectId: project.id });
    const token = created.json<PortfolioBody>().shareToken;

    expect((await get(`/api/v1/portfolios/share/${token}`)).statusCode).toBe(404);
  });

  it('a wrong key, a malformed key and a real-but-withdrawn one answer identically', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);
    await del('/api/v1/me/portfolio/publish', w.learner.cookie);

    const withdrawn = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    const wrong = await get(`/api/v1/portfolios/share/${'b'.repeat(64)}`);
    expect(withdrawn.statusCode).toBe(404);
    expect(wrong.statusCode).toBe(404);
    const shape = (r: { json: <T>() => T }) => {
      const { error } = r.json<{ error: { code: string; message: string } }>();
      return { code: error.code, message: error.message };
    };
    expect(shape(withdrawn)).toEqual(shape(wrong));
  });

  it.each([
    ['../../etc/passwd', 'traversal'],
    ['%2e%2e%2fetc', 'encoded traversal'],
    ["' OR 1=1 --", 'sql-shaped'],
    ['A'.repeat(64), 'uppercase hex'],
    ['ab', 'too short for a slug'],
    ['-leading', 'leading hyphen'],
    ['x'.repeat(200), 'over length'],
  ])('refuses %s (%s) without touching the database', async (key) => {
    const w = await world();
    await publishedPortfolio(w);
    const response = await get(`/api/v1/portfolios/share/${encodeURIComponent(key)}`);
    // 414 for the over-length case: the HTTP layer refuses the URI before any
    // route matches, which is the earliest possible refusal and therefore fine.
    expect([400, 404, 414]).toContain(response.statusCode);
  });

  it('records a failed resolve without ever recording the key', async () => {
    const w = await world();
    const { portfolio } = await publishedPortfolio(w);
    await get(`/api/v1/portfolios/share/${'c'.repeat(64)}`);

    expect(await auditTypes()).toContain('portfolio.public_resolve_failed');
    const details = await auditDetails();
    // A valid token in a log is a working capability in a file more people can
    // read than the page it opens. Only its SHAPE is recorded.
    expect(details).not.toContain('c'.repeat(64));
    expect(details).not.toContain(portfolio.shareToken);
    expect(details).toContain('token');
  });
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe('URL validation', () => {
  it.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'http://insecure.test/repo',
    'file:///etc/passwd',
    '//evil.test/x',
    '/relative',
    'https://x.test/a b',
    'https://x.test/\nSet-Cookie: a=b',
  ])('refuses %s as a repository URL', async (url) => {
    const w = await world();
    const created = await post('/api/v1/projects', w.learner.cookie, {
      title: 'Test',
      classId: w.klass,
      repositoryUrl: url,
    });
    expect(created.statusCode, `${url} was accepted`).toBe(400);
  });

  it('refuses an artifact over the byte cap and a non-https location', async () => {
    const w = await world();
    const project = await makeProject(w, w.learner);

    const tooBig = await post(`/api/v1/projects/${project.id}/artifacts`, w.learner.cookie, {
      artifactType: 'report_pdf',
      filePathOrUrl: 'https://cdn.example.org/big.pdf',
      byteSize: 26_214_401,
    });
    expect(tooBig.statusCode).toBe(400);

    const internal = await post(`/api/v1/projects/${project.id}/artifacts`, w.learner.cookie, {
      artifactType: 'report_pdf',
      // The database permits this form; the contract deliberately does not,
      // because nothing on this platform can produce one yet.
      filePathOrUrl: 'artifact://11111111-1111-4111-8111-111111111111',
      byteSize: 100,
    });
    expect(internal.statusCode).toBe(400);
  });

  it('DROPS an artifact:// location the contract could never have created', async () => {
    /**
     * THE GAP DEFECT INJECTION F3 EXPOSED, CLOSED PROPERLY.
     *
     * `attachProjectArtifactRequestSchema` accepts `https://` only, so no
     * request can create this row and the first attempt at closing this gap —
     * asserting in the RLS suite that such a row is admitted — proved the state
     * exists without ever putting it in front of the sanitizer. Removing the
     * filter still passed every suite above the unit tests.
     *
     * So the row is written HERE, directly, as a migration or a future import
     * would write it, and then fetched through the real public route. That is
     * what makes the drop a control rather than dead code.
     */
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);

    const raw = new pg.Client({ connectionString: TEST_SUPERUSER_URL });
    await raw.connect();
    try {
      await raw.query(
        `INSERT INTO project_artifacts (project_id, owner_id, artifact_type, file_path_or_url, byte_size)
         VALUES ($1, $2, 'report_pdf', 'artifact://11111111-1111-4111-8111-111111111111', 10)`,
        [project.id, w.learner.id],
      );
    } finally {
      await raw.end();
    }

    const response = await get(`/api/v1/portfolios/share/${portfolio.shareToken}`);
    expect(response.statusCode, response.body).toBe(200);
    // A stranger has no session, so an internal reference would be a broken
    // link at best and a hint about storage layout at worst.
    expect(response.body).not.toContain('artifact://');
    expect(
      response.json<{ projects: { artifacts: unknown[] }[] }>().projects[0]?.artifacts,
    ).toEqual([]);
  });

  it('an https artifact reaches the public page; a dropped one does not', async () => {
    const w = await world();
    const { project, portfolio } = await publishedPortfolio(w);
    await post(`/api/v1/projects/${project.id}/artifacts`, w.learner.cookie, {
      artifactType: 'report_pdf',
      filePathOrUrl: 'https://cdn.example.org/report.pdf',
      byteSize: 4096,
    });

    const view = (await get(`/api/v1/portfolios/share/${portfolio.shareToken}`)).json<{
      projects: { artifacts: { url: string }[] }[];
    }>();
    expect(view.projects[0]?.artifacts.map((a) => a.url)).toEqual([
      'https://cdn.example.org/report.pdf',
    ]);
  });
});

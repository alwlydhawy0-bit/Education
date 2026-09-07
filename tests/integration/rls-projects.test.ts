import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
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

/**
 * Row-Level Security for projects, artifacts, portfolios and portfolio items.
 *
 * No application code is in the path. Every statement runs as `edu_app`
 * (NOBYPASSRLS, non-owner) with `app.actor_id` set exactly as a request would
 * set it, or with NO actor at all for the public path. If the entire policy
 * engine were deleted tomorrow, these are the boundaries that would hold.
 *
 * THIS SUITE WRITES THROUGH `edu_app`, not through superuser fixtures.
 * VULN-042 was an insert policy that refused every legitimate author and
 * survived a whole RLS suite because every fixture seeded as superuser. Here
 * the fixtures create only PEOPLE and CLASSES; every project, portfolio and
 * item below is written by the application role through the real policies.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

/**
 * Did the statement actually do anything?
 *
 * NOT simply "did it throw". An UPDATE or DELETE whose rows are excluded by an
 * RLS USING clause does not raise — it matches nothing and reports zero rows.
 * `WITH CHECK` raises; `USING` goes quiet; both are refusals.
 */
async function attempt(actorId: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    const result = await db.withActor(actorId, (tx) => tx.query(sql, params));
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

async function rows<T extends Record<string, unknown>>(
  actorId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.withActor(actorId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** The public path: no actor, one key, transaction-local. */
async function publicRows<T extends Record<string, unknown>>(
  key: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return db.withoutActor(async (tx) => {
    await tx.query('SELECT app_begin_public_portfolio($1)', [key]);
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function world() {
  const orgA = await createOrganization('School A');
  const orgB = await createOrganization('School B');

  const mk = (email: string, roles?: readonly string[], org: string | null = orgA) =>
    createUser({ email, ...(roles ? { roles } : {}), organizationId: org });

  const learner = await mk('learner@a.test', ['student']);
  const peer = await mk('peer@a.test', ['student']);
  const outsider = await mk('outsider@a.test', ['student']);
  const teacher = await mk('teacher@a.test', ['teacher']);
  const otherTeacher = await mk('other-teacher@a.test', ['teacher']);
  const guardian = await mk('guardian@a.test', ['guardian']);
  const stranger = await mk('stranger@b.test', ['student'], orgB);
  const admin = await mk('admin@a.test', ['admin']);
  await grantRole(admin.id, 'admin', 'organization', orgA);

  const klass = await createClass(orgA, 'A1');
  const otherClass = await createClass(orgA, 'A2');
  await addClassMember(klass, learner.id);
  await addClassMember(klass, peer.id);
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
    peer,
    outsider,
    teacher,
    otherTeacher,
    guardian,
    stranger,
    admin,
  };
}

/** A project written BY the learner THROUGH `edu_app`. */
async function insertProject(
  actorId: string,
  classId: string,
  options: { visibility?: string; status?: string; title?: string } = {},
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    actorId,
    `INSERT INTO student_projects (student_id, class_id, title, description_markdown, visibility)
     VALUES ($1, $2, $3, 'body', $4) RETURNING id`,
    [actorId, classId, options.title ?? 'A project', options.visibility ?? 'private'],
  );
  if (!row) throw new Error('the project was refused by RLS or a trigger');
  if (options.status && options.status !== 'draft') {
    await rows(actorId, `UPDATE student_projects SET status = $2 WHERE id = $1`, [
      row.id,
      options.status,
    ]);
  }
  return row.id;
}

async function insertPortfolio(actorId: string): Promise<{ id: string; token: string }> {
  const [row] = await rows<{ id: string; share_token: string }>(
    actorId,
    `INSERT INTO student_portfolios (student_id, title, bio)
     VALUES ($1, 'My work', 'A bio') RETURNING id, share_token`,
    [actorId],
  );
  if (!row) throw new Error('the portfolio was refused');
  return { id: row.id, token: row.share_token };
}

// ---------------------------------------------------------------------------

describe('an owner writes their own work through the application role', () => {
  it('creates, reads, updates and deletes a project as edu_app', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass);

    expect(await rows(w.learner.id, 'SELECT id FROM student_projects')).toHaveLength(1);
    expect(
      await attempt(w.learner.id, `UPDATE student_projects SET title = 'Renamed' WHERE id = $1`, [
        project,
      ]),
    ).toBe(true);
    expect(
      await attempt(w.learner.id, 'DELETE FROM student_projects WHERE id = $1', [project]),
    ).toBe(true);
  });

  it('creates a portfolio with a server-minted token it never supplied', async () => {
    const w = await world();
    const { token } = await insertPortfolio(w.learner.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cannot choose its own share token', async () => {
    const w = await world();
    const [row] = await rows<{ share_token: string }>(
      w.learner.id,
      `INSERT INTO student_portfolios (student_id, title, share_token)
       VALUES ($1, 'Mine', $2) RETURNING share_token`,
      [w.learner.id, 'a'.repeat(64)],
    );
    // The trigger overwrites it on every insert regardless of what was sent.
    expect(row?.share_token).not.toBe('a'.repeat(64));
  });
});

describe('a project is not another learner’s to touch', () => {
  it('refuses an insert naming somebody else as the owner', async () => {
    const w = await world();
    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO student_projects (student_id, class_id, title) VALUES ($1, $2, 'Theirs')`,
        [w.learner.id, w.klass],
      ),
    ).toBe(false);
  });

  it('refuses an update and a delete by a classmate', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass, { visibility: 'class' });
    await rows(w.learner.id, `UPDATE student_projects SET status = 'submitted' WHERE id = $1`, [
      project,
    ]);

    // Readable — and still not writable. The two are separate policies.
    expect(await rows(w.peer.id, 'SELECT id FROM student_projects')).toHaveLength(1);
    expect(
      await attempt(w.peer.id, `UPDATE student_projects SET title = 'Mine' WHERE id = $1`, [
        project,
      ]),
    ).toBe(false);
    expect(await attempt(w.peer.id, 'DELETE FROM student_projects WHERE id = $1', [project])).toBe(
      false,
    );
  });

  it('refuses an owner rewriting their row into somebody else’s', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass);
    // Without the WITH CHECK half of the UPDATE policy this would pass USING on
    // the way in and land outside the writer's reach.
    expect(
      await attempt(w.learner.id, `UPDATE student_projects SET student_id = $2 WHERE id = $1`, [
        project,
        w.peer.id,
      ]),
    ).toBe(false);
  });

  it('refuses moving a project to another class', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass);
    expect(
      await attempt(w.learner.id, `UPDATE student_projects SET class_id = $2 WHERE id = $1`, [
        project,
        w.otherClass,
      ]),
    ).toBe(false);
  });
});

describe('the class and review boundaries', () => {
  it('a classmate sees class-visible submitted work only', async () => {
    const w = await world();
    await insertProject(w.learner.id, w.klass, { visibility: 'class', status: 'submitted' });
    await insertProject(w.learner.id, w.klass, { visibility: 'private', status: 'submitted' });
    await insertProject(w.learner.id, w.klass, { visibility: 'class', status: 'draft' });

    expect(await rows(w.peer.id, 'SELECT id FROM student_projects')).toHaveLength(1);
  });

  it('a learner in another class of the same school sees nothing', async () => {
    const w = await world();
    await insertProject(w.learner.id, w.klass, { visibility: 'class', status: 'submitted' });
    expect(await rows(w.outsider.id, 'SELECT id FROM student_projects')).toHaveLength(0);
  });

  it('a learner in another school sees nothing, even of public work', async () => {
    const w = await world();
    await insertProject(w.learner.id, w.klass, { visibility: 'public', status: 'submitted' });
    expect(await rows(w.stranger.id, 'SELECT id FROM student_projects')).toHaveLength(0);
  });

  it('the class teacher reads a submitted private project but not a draft', async () => {
    const w = await world();
    await insertProject(w.learner.id, w.klass, { visibility: 'private', status: 'submitted' });
    await insertProject(w.learner.id, w.klass, { visibility: 'private', status: 'draft' });
    expect(await rows(w.teacher.id, 'SELECT id FROM student_projects')).toHaveLength(1);
  });

  it('a teacher of another class in the same school reads nothing', async () => {
    const w = await world();
    await insertProject(w.learner.id, w.klass, { visibility: 'private', status: 'submitted' });
    expect(await rows(w.otherTeacher.id, 'SELECT id FROM student_projects')).toHaveLength(0);
  });

  it('a guardian reads nothing at all', async () => {
    const w = await world();
    await insertProject(w.learner.id, w.klass, { visibility: 'public', status: 'submitted' });
    expect(await rows(w.guardian.id, 'SELECT id FROM student_projects')).toHaveLength(0);
  });

  it('a reviewer may move status but NOT rewrite the work', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass, { status: 'submitted' });

    expect(
      await attempt(
        w.teacher.id,
        `UPDATE student_projects
            SET status = 'featured', featured_by = $2, featured_at = now()
          WHERE id = $1`,
        [project, w.teacher.id],
      ),
    ).toBe(true);

    // `student_projects_feature` admits a ROW; `student_project_review_guard`
    // is what makes the authority one column wide. The probe found a teacher
    // rewriting a child's description with only the policy in place.
    expect(
      await attempt(
        w.teacher.id,
        `UPDATE student_projects SET description_markdown = 'Teacher wrote this' WHERE id = $1`,
        [project],
      ),
    ).toBe(false);

    // And cannot publish it to the world on the child's behalf.
    expect(
      await attempt(w.teacher.id, `UPDATE student_projects SET visibility = 'public' WHERE id = $1`, [
        project,
      ]),
    ).toBe(false);
  });

  it('a reviewer cannot delete a learner’s project', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass, { status: 'submitted' });
    expect(
      await attempt(w.teacher.id, 'DELETE FROM student_projects WHERE id = $1', [project]),
    ).toBe(false);
  });
});

describe('artifacts inherit their project’s visibility', () => {
  it('an owner attaches one; a classmate sees it only when the project is shared', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass, {
      visibility: 'private',
      status: 'submitted',
    });
    const written = await attempt(
      w.learner.id,
      `INSERT INTO project_artifacts (project_id, owner_id, artifact_type, file_path_or_url, byte_size)
       VALUES ($1, $2, 'report_pdf', 'https://cdn.example.org/a.pdf', 10)`,
      [project, w.learner.id],
    );
    expect(written).toBe(true);

    expect(await rows(w.peer.id, 'SELECT id FROM project_artifacts')).toHaveLength(0);
    await rows(w.learner.id, `UPDATE student_projects SET visibility = 'class' WHERE id = $1`, [
      project,
    ]);
    expect(await rows(w.peer.id, 'SELECT id FROM project_artifacts')).toHaveLength(1);
  });

  it('refuses an artifact attached to somebody else’s project', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass, {
      visibility: 'class',
      status: 'submitted',
    });
    // The composite foreign key: (project_id, owner_id) has no parent row when
    // the pair does not name one person. Not a policy anybody could edit away.
    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO project_artifacts (project_id, owner_id, artifact_type, file_path_or_url, byte_size)
         VALUES ($1, $2, 'report_pdf', 'https://cdn.example.org/a.pdf', 10)`,
        [project, w.peer.id],
      ),
    ).toBe(false);
  });
});

describe('portfolio items belong to one person, structurally', () => {
  it('refuses an item pairing your portfolio with another learner’s project', async () => {
    const w = await world();
    const theirs = await insertProject(w.learner.id, w.klass, {
      visibility: 'public',
      status: 'submitted',
    });
    const mine = await insertPortfolio(w.peer.id);

    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO portfolio_items (portfolio_id, project_id, owner_id) VALUES ($1, $2, $3)`,
        [mine.id, theirs, w.peer.id],
      ),
    ).toBe(false);
  });

  it('refuses an item claiming an owner who is not the caller', async () => {
    const w = await world();
    const project = await insertProject(w.learner.id, w.klass);
    const portfolio = await insertPortfolio(w.learner.id);
    expect(
      await attempt(
        w.peer.id,
        `INSERT INTO portfolio_items (portfolio_id, project_id, owner_id) VALUES ($1, $2, $3)`,
        [portfolio.id, project, w.learner.id],
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The public path — no actor at all
// ---------------------------------------------------------------------------

describe('the public path, with no actor', () => {
  async function publish(w: Awaited<ReturnType<typeof world>>) {
    const project = await insertProject(w.learner.id, w.klass, {
      visibility: 'public',
      status: 'submitted',
      title: 'Shown',
    });
    const portfolio = await insertPortfolio(w.learner.id);
    await rows(
      w.learner.id,
      `INSERT INTO portfolio_items (portfolio_id, project_id, owner_id) VALUES ($1, $2, $3)`,
      [portfolio.id, project, w.learner.id],
    );
    await rows(w.learner.id, `UPDATE student_portfolios SET is_published = true WHERE id = $1`, [
      portfolio.id,
    ]);
    const [fresh] = await rows<{ share_token: string }>(
      w.learner.id,
      'SELECT share_token FROM student_portfolios WHERE id = $1',
      [portfolio.id],
    );
    return { project, portfolioId: portfolio.id, token: fresh?.share_token ?? '' };
  }

  it('serves a published portfolio to a caller holding its token', async () => {
    const w = await world();
    const { token } = await publish(w);
    expect(await publicRows(token, 'SELECT id FROM student_portfolios')).toHaveLength(1);
    expect(await publicRows(token, 'SELECT id FROM student_projects')).toHaveLength(1);
    expect(await publicRows(token, 'SELECT id FROM portfolio_items')).toHaveLength(1);
  });

  it('shows nothing at all with no key presented', async () => {
    const w = await world();
    await publish(w);
    // `app_portfolio_key()` is NULL, and NULL equals nothing. An ordinary
    // request that never called the resolver matches no public branch.
    const seen = await db.withoutActor(async (tx) => ({
      portfolios: (await tx.query('SELECT id FROM student_portfolios')).rowCount,
      projects: (await tx.query('SELECT id FROM student_projects')).rowCount,
      items: (await tx.query('SELECT id FROM portfolio_items')).rowCount,
    }));
    expect(seen).toEqual({ portfolios: 0, projects: 0, items: 0 });
  });

  it('shows nothing for a key that names no portfolio', async () => {
    const w = await world();
    await publish(w);
    expect(await publicRows('b'.repeat(64), 'SELECT id FROM student_portfolios')).toHaveLength(0);
  });

  it('shows nothing once the portfolio is withdrawn, and rotates the token', async () => {
    const w = await world();
    const { token, portfolioId } = await publish(w);
    await rows(w.learner.id, `UPDATE student_portfolios SET is_published = false WHERE id = $1`, [
      portfolioId,
    ]);

    expect(await publicRows(token, 'SELECT id FROM student_portfolios')).toHaveLength(0);
    const [after] = await rows<{ share_token: string }>(
      w.learner.id,
      'SELECT share_token FROM student_portfolios WHERE id = $1',
      [portfolioId],
    );
    // The rotation is what makes revocation real: republishing does not
    // resurrect a link somebody already holds.
    expect(after?.share_token).not.toBe(token);
  });

  it('hides items whose projects are not public, ids included', async () => {
    const w = await world();
    const { token, portfolioId } = await publish(w);
    for (const visibility of ['private', 'class']) {
      const hidden = await insertProject(w.learner.id, w.klass, {
        visibility,
        status: 'submitted',
        title: `Hidden ${visibility}`,
      });
      await rows(
        w.learner.id,
        `INSERT INTO portfolio_items (portfolio_id, project_id, owner_id) VALUES ($1, $2, $3)`,
        [portfolioId, hidden, w.learner.id],
      );
    }

    // THREE ITEMS EXIST; ONE IS PUBLIC. The probe found this returning three,
    // which leaked the internal project ids of work the child chose not to show
    // along with the fact that there was any.
    expect(await publicRows(token, 'SELECT id FROM portfolio_items')).toHaveLength(1);
    const titles = await publicRows<{ title: string }>(token, 'SELECT title FROM student_projects');
    expect(titles.map((r) => r.title)).toEqual(['Shown']);
  });

  it('serves an artifact:// row to the public path — which is why the sanitizer drops it', async () => {
    /**
     * THE STATE THE CONTRACT CANNOT PRODUCE, WHICH IS THE POINT.
     *
     * `attachProjectArtifactRequestSchema` accepts `https://` only, so no HTTP
     * request can create an `artifact://` row and no HTTP test can reach the
     * sanitizer's drop. The database CHECK permits the form — for a file the
     * platform will one day store itself — so a migration, a fixture or a
     * future import can produce one.
     *
     * This asserts the row IS admitted here, which is what makes
     * `toPublicPortfolio` dropping it a real control rather than dead code.
     * Defect injection F3 removed that drop and only the unit suite noticed;
     * this is the layer that establishes the state it defends against.
     */
    const w = await world();
    const { token, project } = await publish(w);
    await rows(
      w.learner.id,
      `INSERT INTO project_artifacts (project_id, owner_id, artifact_type, file_path_or_url, byte_size)
       VALUES ($1, $2, 'report_pdf', 'artifact://11111111-1111-4111-8111-111111111111', 10)`,
      [project, w.learner.id],
    );

    const seen = await publicRows<{ file_path_or_url: string }>(
      token,
      'SELECT file_path_or_url FROM project_artifacts',
    );
    expect(seen.map((r) => r.file_path_or_url)).toEqual([
      'artifact://11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('hides a draft even when the project says public', async () => {
    const w = await world();
    const { token, portfolioId } = await publish(w);
    const draft = await insertProject(w.learner.id, w.klass, {
      visibility: 'public',
      status: 'draft',
      title: 'Unfinished',
    });
    await rows(
      w.learner.id,
      `INSERT INTO portfolio_items (portfolio_id, project_id, owner_id) VALUES ($1, $2, $3)`,
      [portfolioId, draft, w.learner.id],
    );
    const titles = await publicRows<{ title: string }>(token, 'SELECT title FROM student_projects');
    expect(titles.map((r) => r.title)).toEqual(['Shown']);
  });

  it('cannot write anything, in any table, with a key', async () => {
    const w = await world();
    const { token, project } = await publish(w);
    const wrote = await db.withoutActor(async (tx) => {
      await tx.query('SELECT app_begin_public_portfolio($1)', [token]);
      const results: boolean[] = [];
      for (const sql of [
        `UPDATE student_projects SET title = 'Defaced' WHERE id = '${project}'`,
        `DELETE FROM student_projects WHERE id = '${project}'`,
        `UPDATE student_portfolios SET is_published = false`,
        `DELETE FROM portfolio_items`,
      ]) {
        try {
          results.push(((await tx.query(sql)).rowCount ?? 0) > 0);
        } catch {
          results.push(false);
        }
      }
      return results;
    });
    expect(wrote).toEqual([false, false, false, false]);
  });

  it('the key does not survive into the next transaction', async () => {
    const w = await world();
    const { token } = await publish(w);
    expect(await publicRows(token, 'SELECT id FROM student_portfolios')).toHaveLength(1);

    // `set_config(..., true)` is transaction-local. On a pooled connection the
    // next request may be a different child's, so this is the property that
    // stops one page's key from opening another's.
    const afterwards = await db.withoutActor(
      async (tx) => (await tx.query('SELECT id FROM student_portfolios')).rowCount,
    );
    expect(afterwards).toBe(0);
  });

  it('a slug opens the same page as a token, and only while published', async () => {
    const w = await world();
    const { token, portfolioId } = await publish(w);
    await rows(w.learner.id, `UPDATE student_portfolios SET public_slug = 'noor' WHERE id = $1`, [
      portfolioId,
    ]);

    expect(await publicRows('noor', 'SELECT id FROM student_portfolios')).toHaveLength(1);
    expect(await publicRows(token, 'SELECT id FROM student_portfolios')).toHaveLength(1);

    await rows(w.learner.id, `UPDATE student_portfolios SET is_published = false WHERE id = $1`, [
      portfolioId,
    ]);
    // The slug survives the withdrawal — it is a name, not a capability — and
    // opens nothing, because `app_portfolio_is_public` asks about publication.
    expect(await publicRows('noor', 'SELECT id FROM student_portfolios')).toHaveLength(0);
  });

  it('an empty key is not a key', async () => {
    const w = await world();
    await publish(w);
    // `app_portfolio_key()` nullifies the empty string, so a caller passing ''
    // is a caller who presented nothing rather than one who matches a NULL slug.
    expect(await publicRows('', 'SELECT id FROM student_portfolios')).toHaveLength(0);
  });
});

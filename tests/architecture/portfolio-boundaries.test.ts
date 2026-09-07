import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUDENT_PORTFOLIO_ACTIONS, STUDENT_PROJECT_ACTIONS } from '@edu/authz';
import { MAX_SLUG_LENGTH } from '../../apps/api/src/modules/portfolio/public-view.ts';

/**
 * Fitness functions for projects, portfolios and the public boundary.
 *
 * SOURCE TEXT, NOT BEHAVIOUR. `tests/security/portfolio.test.ts` proves the
 * pipeline does the right thing today; this proves the wrong thing cannot be
 * written tomorrow without somebody reading a failure that explains why.
 *
 * The properties here are the ones a passing behavioural suite would not notice
 * being broken, because breaking them produces the same responses on the paths
 * anybody thought to test. The public sanitizer is the sharpest example: a
 * spread that leaks a column added next year passes every test written this
 * year, because that column does not exist yet to be asserted about.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const MODULE = 'apps/api/src/modules/portfolio';

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(absolute);
  return out;
}

/** Prose about a query is not a query. Same rule as the other fitness suites. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('--');
    })
    .join('\n');
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const code = (path: string): string => stripComments(read(path));

const PUBLIC_VIEW = `${MODULE}/public-view.ts`;
const REPOSITORY = `${MODULE}/portfolio.repository.ts`;
const SERVICE = `${MODULE}/portfolio.service.ts`;
const ROUTES = `${MODULE}/portfolio.routes.ts`;

describe('the public sanitizer is a constructor, not a filter', () => {
  it('never spreads, never deletes, and never touches a key by name', () => {
    const source = code(PUBLIC_VIEW);
    // A spread of a SOURCE ROW is how a filter is written, and a filter is a
    // deny-list: the column added next year arrives on the public page by
    // default. `[...projects]` is permitted and present — it copies the array
    // so the sort does not mutate the caller's.
    // THE PARENTHESIS MATTERS, and defect injection F1 is why. The first
    // version of this assertion required the identifier immediately after the
    // dots, so `...(portfolio as Record<string, never>)` — a perfectly ordinary
    // way to write the defect — walked straight past it. A fitness function
    // that only catches the tidy spelling of a mistake is not a control.
    expect(source).not.toMatch(/\.\.\.\s*\(?\s*(portfolio|project|artifact|row|source)\b/);
    expect(source).not.toMatch(/\bdelete\s+\w+\[/);
    expect(source).not.toMatch(/\bOmit</);
  });

  it('reads no database, no clock and no randomness', () => {
    const source = code(PUBLIC_VIEW);
    // Pure input-to-output is what lets the unit suite enumerate the leak cases
    // without a server, and what makes the leak assertion exhaustive.
    for (const forbidden of ['tx.query', 'Date.now', 'new Date', 'Math.random', 'randomUUID']) {
      expect(source, `${forbidden} in the sanitizer`).not.toContain(forbidden);
    }
  });

  it('declares no field whose name suggests an identifier', () => {
    // The interfaces are the allow-list. A field called `id`, `projectId`,
    // `studentId` or `ownerId` appearing here is the whole failure this module
    // exists to prevent, so it fails as a NAME rather than waiting for a value
    // to be asserted about at runtime.
    const interfaces = code(PUBLIC_VIEW).match(/export interface Public[\s\S]*?\n}/g) ?? [];
    expect(interfaces.length).toBeGreaterThan(2);
    for (const block of interfaces) {
      expect(block, block).not.toMatch(/^\s*readonly\s+\w*[Ii]d\b/m);
      expect(block, block).not.toMatch(/email|shareToken|organizationId|studentId|ownerId/);
    }
  });

  it('is the only place a public view is built', () => {
    // One constructor. A second one somewhere else would be a second boundary
    // with its own opinion about what a stranger may see.
    const builders = sourceFiles(MODULE).filter((file) =>
      /function\s+toPublicPortfolio\b/.test(readFileSync(file, 'utf8')),
    );
    expect(builders).toHaveLength(1);
  });
});

describe('the public path never runs as an actor', () => {
  it('resolvePublic uses withoutActor and never withActor', () => {
    const source = code(SERVICE);
    const body = source.slice(source.indexOf('async resolvePublic'));
    expect(body).toContain('db.withoutActor');
    // If it ran as the caller, a learner opening their own share link would see
    // their private projects and conclude that is what the world sees.
    expect(body).not.toContain('db.withActor');
  });

  it('the public resolver takes no ActorContext', () => {
    expect(code(SERVICE)).toMatch(
      /resolvePublic\(\s*key: string,\s*request: PublicRequestContext\s*\)/,
    );
  });

  it('the public route is the only one without requireActor', () => {
    const source = code(ROUTES);
    const registrations = source.match(/app\.(get|post|put|delete|route)\(/g) ?? [];
    const guards = source.match(/preHandler: requireActor/g) ?? [];
    // Every registration but one carries the guard. `app.route(` is used for
    // the PUT/PATCH pairs, which are inside a loop and guarded the same way.
    expect(registrations.length - guards.length).toBe(1);
    expect(source).toContain("app.get('/api/v1/portfolios/share/:shareToken'");
  });

  it('the public route sends only through the strict public schema', () => {
    const source = code(ROUTES);
    const handler = source.slice(source.indexOf("'/api/v1/portfolios/share/:shareToken'"));
    // `.strict()` on the response means a field that appeared without being
    // declared is a 500 rather than a disclosure.
    expect(handler).toContain('publicPortfolioResponseSchema.parse(view)');
    expect(handler).toContain("header('Cache-Control', 'no-store')");
  });
});

describe('the public query asks the key itself — the second gate', () => {
  it('both public statements filter on app_portfolio_key()', () => {
    const source = code(REPOSITORY);
    const fn = source.slice(source.indexOf('async publicPortfolio'));
    const guards = fn.match(/app_portfolio_key\(\)/g) ?? [];
    // Four: `IS NOT NULL` plus the two-column comparison, in each of the two
    // statements. Without them the resolver stands on RLS alone, which is what
    // the layered-defence suite caught.
    expect(guards.length).toBeGreaterThanOrEqual(4);
    expect(fn).toContain('f.is_published');
    expect(fn).toContain("p.visibility = 'public'");
    expect(fn).toContain("p.status <> 'draft'");
  });

  it('the public query takes no caller-supplied parameter', () => {
    const source = code(REPOSITORY);
    const fn = source.slice(source.indexOf('async publicPortfolio'), source.indexOf('async function readProject'));
    // No `$1` anywhere: the key is in the transaction's GUC, so this function
    // cannot be made to return a different portfolio by passing an argument.
    expect(fn).not.toMatch(/\$\d/);
  });

  it('the public query selects no identifier column', () => {
    const source = code(REPOSITORY);
    const fn = source.slice(source.indexOf('async publicPortfolio'), source.indexOf('async function readProject'));
    // Ids are kept out of the object entirely rather than dropped later, so
    // there is never a moment when one is in the same value as the payload.
    // Only the SELECT lists are inspected: `f.id` appears in a JOIN condition,
    // which is how the second gate reaches the portfolio, and joining on a
    // column is not returning it.
    const selectLists = (fn.match(/SELECT[\s\S]*?FROM/g) ?? []).join('\n');
    expect(selectLists.length).toBeGreaterThan(0);
    for (const column of [
      'f.id',
      'f.student_id',
      'f.share_token',
      'f.organization_id',
      'p.id',
      'i.id',
      'i.project_id',
    ]) {
      expect(selectLists, `${column} is selected on the public path`).not.toContain(column);
    }
  });
});

describe('ownership is structural, not remembered', () => {
  it('no statement in the module writes organization_id or featured_by by hand', () => {
    const source = code(REPOSITORY);
    // `organization_id` is derived by a trigger; `featured_by` is set only in
    // the one narrow featuring statement.
    expect(source.match(/SET[\s\S]{0,200}?organization_id\s*=/g) ?? []).toEqual([]);
    expect((source.match(/featured_by\s*=/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('the featuring statement sets exactly status, featured_by and featured_at', () => {
    const source = code(REPOSITORY);
    const fn = source.slice(source.indexOf('async featureProject'), source.indexOf('async deleteProject'));
    const setClause = fn.slice(fn.indexOf('SET'), fn.indexOf('WHERE'));
    const assignments = (setClause.match(/(\w+)\s*=/g) ?? []).map((m) =>
      m.replace(/\s*=$/, '').trim(),
    );
    expect(new Set(assignments)).toEqual(new Set(['status', 'featured_by', 'featured_at']));
  });

  it('no SQL in the module is built by concatenation or interpolation of a value', () => {
    for (const file of sourceFiles(MODULE)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      // Only files that actually talk to the database. `public-view.ts` builds
      // a slug suffix with a template literal, which is not SQL.
      if (!source.includes('tx.query')) continue;
      // The only interpolations permitted are the named SQL fragments and a
      // sort column resolved through an allow-list.
      const interpolations = source.match(/\$\{[^}]+\}/g) ?? [];
      for (const interpolation of interpolations) {
        expect(interpolation, `${file}: ${interpolation}`).toMatch(
          /^\$\{(ARTIFACTS_JSON|PROJECT_SELECT|PORTFOLIO_SELECT|PORTFOLIO_ITEMS_JSON|PUBLIC_ITEM_COUNT|column|direction)\}$/,
        );
      }
    }
  });
});

describe('the vocabulary says only what the system does', () => {
  it('has no student_project:publish action', () => {
    // Making a project public is an ordinary `update` by its owner. A verb for
    // it would suggest somebody else might hold the power.
    expect(STUDENT_PROJECT_ACTIONS).not.toContain('student_project:publish');
  });

  it('separates publish from unpublish, so an audit can name which happened', () => {
    expect(STUDENT_PORTFOLIO_ACTIONS).toContain('student_portfolio:publish');
    expect(STUDENT_PORTFOLIO_ACTIONS).toContain('student_portfolio:unpublish');
  });

  it('every action in the vocabulary is authorized somewhere in the module', () => {
    const source = sourceFiles(MODULE)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const action of [...STUDENT_PROJECT_ACTIONS, ...STUDENT_PORTFOLIO_ACTIONS]) {
      // `:create` IS EXCLUDED, and the exclusion is worth stating rather than
      // hiding. There is no object yet to decide about at creation time: the
      // owner is the session, and what binds it is the RLS `WITH CHECK
      // (student_id = app_current_actor())` plus `student_project_guard`, which
      // refuses a class the actor is not a learner in. That is the pattern
      // every owner-scoped domain on this platform already follows —
      // `notebook:create` and `note:create` are the same — so the verb exists
      // for a vocabulary that is complete, not for a check nobody runs.
      //
      // It is a genuine single-gate spot, recorded in the Task 013 report
      // rather than fixed here, because changing it would change the
      // established pattern across five modules.
      if (action.endsWith(':create')) continue;
      expect(source, `${action} is declared but never authorized`).toContain(action);
    }
  });
});

describe('constants agree across the layers', () => {
  it('the slug length matches the database CHECK', () => {
    const migration = read('db/migrations/0028_projects_and_portfolios.sql');
    // 1 + 62 + 1 = 64. The regex in the migration is the authority.
    expect(migration).toContain("'^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$'");
    expect(MAX_SLUG_LENGTH).toBe(64);
  });

  it('the contract, the sanitizer and the migration agree on https-only', () => {
    const contract = code('packages/contracts/src/portfolio.contract.ts');
    const sanitizer = code(PUBLIC_VIEW);
    const migration = read('db/migrations/0028_projects_and_portfolios.sql');
    expect(contract).toContain('^https:\\/\\/\\S+$');
    expect(sanitizer).toContain("startsWith('https://')");
    expect(migration).toContain("repository_url LIKE 'https://%'");
  });

  it('the byte cap is the same number in the contract and the migration', () => {
    expect(code('packages/contracts/src/portfolio.contract.ts')).toContain('26_214_400');
    expect(read('db/migrations/0028_projects_and_portfolios.sql')).toContain('26214400');
  });
});

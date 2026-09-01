import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Architecture fitness functions.
 *
 * Documented dependency rules decay: someone adds an import at 2am, the review
 * misses it, and eighteen months later two domains cannot be separated. These
 * tests turn docs/architecture/dependency-rules.md into something CI enforces.
 *
 * The layering (see also section 31 of the brief):
 *
 *     apps/web  ─┐
 *                ├─►  apps/api/src/modules/*  ─►  apps/api/src/platform  ─►  packages/*
 *     (HTTP only)│         (domain logic)          (infrastructure)         (pure)
 *                └─►  NEVER the database directly
 *
 * Rules asserted here:
 *   1. Pure packages import no infrastructure.
 *   2. `platform` never imports from `modules` (dependency inversion instead).
 *   3. No module imports another module's internals.
 *   4. Only the composition root wires modules together.
 *   5. Route/HTTP files never talk to the database directly.
 *   6. Repositories for protected resources return `Guarded`.
 *   7. Only `platform/db.ts` constructs a connection pool.
 */

const ROOT = resolve(import.meta.dirname, '../..');

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

/**
 * Strips comments before scanning for imports.
 *
 * Without this, prose describing an import (a JSDoc line explaining the very
 * regexes below) is matched as if it were code. Only block comments and lines
 * that BEGIN with a comment marker are removed, so a `//` inside a string
 * literal — a URL, say — is left intact and cannot truncate a real line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/** Import specifiers, from static imports and dynamic `import(...)` alike. */
function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

const INFRASTRUCTURE = [
  'pg',
  'postgres',
  'fastify',
  '@fastify/',
  'node:fs',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  '@node-rs/argon2',
];

describe('rule 1 — pure packages contain no infrastructure', () => {
  it.each(['packages/kernel', 'packages/authz', 'packages/contracts'])(
    '%s imports nothing from the infrastructure layer',
    (pkg) => {
      const violations: string[] = [];
      for (const file of sourceFiles(pkg)) {
        for (const specifier of importsOf(file)) {
          if (INFRASTRUCTURE.some((infra) => specifier.startsWith(infra))) {
            violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
          }
        }
      }
      expect(violations).toEqual([]);
    },
  );

  it('the policy engine depends on nothing but the kernel', () => {
    // The authorization decision must stay a pure function of its inputs, so
    // that the decision table can be exhaustively unit-tested.
    const allowed = new Set(['@edu/kernel']);
    const violations: string[] = [];
    for (const file of sourceFiles('packages/authz')) {
      for (const specifier of importsOf(file)) {
        const isRelative = specifier.startsWith('.');
        if (!isRelative && !allowed.has(specifier)) {
          violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('rule 2 — platform never depends on modules', () => {
  it('no file under platform/ imports from modules/', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('apps/api/src/platform')) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes('modules/')) {
          violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
        }
      }
    }
    // platform sits BELOW the domain modules. It expresses what it needs as
    // local interfaces, and the composition root supplies implementations.
    expect(violations).toEqual([]);
  });
});

describe('rule 3 — modules do not reach into each other', () => {
  const modulesDir = join(ROOT, 'apps/api/src/modules');
  const moduleNames = readdirSync(modulesDir).filter((entry) =>
    statSync(join(modulesDir, entry)).isDirectory(),
  );

  it('has more than one module, so the rule is meaningful', () => {
    expect(moduleNames.length).toBeGreaterThan(1);
  });

  it.each(moduleNames)('module "%s" imports no other module', (moduleName) => {
    const others = moduleNames.filter((name) => name !== moduleName);
    const violations: string[] = [];
    for (const file of sourceFiles(`apps/api/src/modules/${moduleName}`)) {
      for (const specifier of importsOf(file)) {
        for (const other of others) {
          if (specifier.includes(`modules/${other}`) || specifier.includes(`../${other}/`)) {
            violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
          }
        }
      }
    }
    // Cross-domain access goes through a contract supplied by the composition
    // root, never through a direct import — that is what keeps a module
    // extractable into its own service later.
    expect(violations).toEqual([]);
  });
});

describe('rule 4 — only the composition root wires modules together', () => {
  it('app.ts is the single file importing from more than one module', () => {
    const modulesDir = join(ROOT, 'apps/api/src/modules');
    const moduleNames = readdirSync(modulesDir).filter((entry) =>
      statSync(join(modulesDir, entry)).isDirectory(),
    );

    const offenders: string[] = [];
    for (const file of sourceFiles('apps/api/src')) {
      if (file.endsWith('/app.ts')) continue;
      const touched = new Set<string>();
      for (const specifier of importsOf(file)) {
        for (const name of moduleNames) {
          if (specifier.includes(`modules/${name}`)) touched.add(name);
        }
      }
      if (touched.size > 1) {
        offenders.push(`${relative(ROOT, file)} wires ${[...touched].join(' + ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('rule 5 — HTTP files never touch the database directly', () => {
  it('no route file imports pg or the database module', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('apps/api/src')) {
      if (!file.endsWith('.routes.ts')) continue;
      for (const specifier of importsOf(file)) {
        if (specifier === 'pg' || specifier.endsWith('platform/db.js')) {
          violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
        }
      }
    }
    // UI -> API -> Domain -> Infrastructure. A route reaching the database
    // directly skips the authorization funnel in the service layer.
    expect(violations).toEqual([]);
  });

  it('no route file constructs an Actor by hand', () => {
    // An Actor may only come from a validated session. A route assembling one
    // from request data would be an authentication bypass.
    const violations: string[] = [];
    for (const file of sourceFiles('apps/api/src')) {
      if (!file.endsWith('.routes.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (/roles\s*:\s*\[/.test(source)) violations.push(relative(ROOT, file));
    }
    expect(violations).toEqual([]);
  });
});

describe('rule 6 — protected resources are returned guarded', () => {
  it('notebook.repository exposes findById as Guarded', () => {
    const source = readFileSync(
      join(ROOT, 'apps/api/src/modules/notebook/notebook.repository.ts'),
      'utf8',
    );
    // Loading a protected record by id must not hand back a bare payload; the
    // caller has to present an allow-decision to read it.
    expect(source).toMatch(/findById\s*\([^)]*\)\s*:\s*Promise<Guarded<[^>]+>\s*\|\s*null>/);
  });

  it('every repository that loads a protected resource by id returns it guarded', () => {
    // Enumerated, not discovered: a new protected resource must be added here
    // deliberately, which is the point at which somebody asks whether its
    // by-id loader is guarded.
    const loaders: ReadonlyArray<readonly [string, string]> = [
      ['notebook/notebook.repository.ts', 'findById'],
      ['users/users.repository.ts', 'findUserById'],
      ['users/users.repository.ts', 'findProfileByUserId'],
      ['organizations/organizations.repository.ts', 'findById'],
      ['relationships/classes.repository.ts', 'findById'],
      ['relationships/classes.repository.ts', 'findAssignment'],
      ['relationships/guardians.repository.ts', 'findById'],
      ['curriculum/curriculum.repository.ts', 'findCurriculum'],
      ['curriculum/curriculum.repository.ts', 'findCourse'],
      ['curriculum/curriculum.repository.ts', 'findUnit'],
      ['curriculum/curriculum.repository.ts', 'findLesson'],
      ['class-courses/class-courses.repository.ts', 'findById'],
      ['class-courses/class-courses.repository.ts', 'findActive'],
      ['progress/progress.repository.ts', 'find'],
      ['assessment/assessment.repository.ts', 'findActivity'],
      ['assessment/assessment.repository.ts', 'findActivityForAssessment'],
      ['assessment/assessment.repository.ts', 'findAttempt'],
    ];
    const violations: string[] = [];
    for (const [file, method] of loaders) {
      const source = readFileSync(join(ROOT, 'apps/api/src/modules', file), 'utf8');
      const pattern = new RegExp(
        `${method}\\s*\\([^)]*\\)\\s*:\\s*Promise<Guarded<[^>]+>\\s*\\|\\s*null>`,
      );
      if (!pattern.test(source)) violations.push(`${file}#${method}`);
    }
    expect(violations).toEqual([]);
  });

  it('the notebook service unwraps only with a decision', () => {
    const source = readFileSync(
      join(ROOT, 'apps/api/src/modules/notebook/notebook.service.ts'),
      'utf8',
    );
    expect(source).toContain('engine.decide(');
    expect(source).toMatch(/\.unwrap\(decision,\s*action\)/);
  });
});

describe('rule 7 — connection pooling is centralized', () => {
  it('only platform/db.ts constructs a pool', () => {
    const violations: string[] = [];
    for (const file of sourceFiles('apps/api/src')) {
      if (file.endsWith('platform/db.ts')) continue;
      const source = readFileSync(file, 'utf8');
      if (/new\s+pg\.(Pool|Client)\b/.test(source)) violations.push(relative(ROOT, file));
    }
    // Centralizing this is what guarantees every query runs inside
    // `withActor`/`withoutActor`, and therefore that `app.actor_id` is always
    // set correctly for RLS.
    expect(violations).toEqual([]);
  });
});

describe('rule 8 — the frontend cannot reach server-only code or secrets', () => {
  const webFiles = [...sourceFiles('apps/web/src'), ...sourceFiles('apps/web')].filter(
    (file, index, all) => all.indexOf(file) === index,
  );

  it('never imports from apps/api', () => {
    // The browser bundle is public. An import from the API app would pull
    // server code — and anything it references — into a downloadable artifact.
    const violations: string[] = [];
    for (const file of webFiles) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes('apps/api') || specifier.includes('@edu/api')) {
          violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('imports only the shared contracts package from the workspace', () => {
    // `@edu/contracts` is designed for both sides of the wire. The others are
    // server-oriented; pulling them client-side would be a slow drift toward
    // shipping server logic to the browser.
    const allowed = new Set(['@edu/contracts']);
    const violations: string[] = [];
    for (const file of webFiles) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('@edu/') && !allowed.has(specifier)) {
          violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never reads process.env — server configuration is not client configuration', () => {
    const violations = webFiles
      .filter((file) => !file.includes('vite.config'))
      .filter((file) => /\bprocess\.env\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(violations).toEqual([]);
  });

  it('reads import.meta.env in exactly one module', () => {
    // One validated entry point, so no feature can introduce an unchecked value.
    const readers = webFiles
      .filter((file) => /import\.meta\.env/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(readers).toEqual(['apps/web/src/shared/config/index.ts']);
  });

  it('contains no server-only environment variable names', () => {
    // A tripwire for the copy-paste that puts a server value in client code.
    const forbidden = ['DATABASE_URL', 'SESSION_COOKIE_SECURE', 'ALLOWED_ORIGINS'];
    const violations: string[] = [];
    for (const file of webFiles) {
      const source = readFileSync(file, 'utf8');
      for (const name of forbidden) {
        if (source.includes(name)) violations.push(`${relative(ROOT, file)} mentions ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('rule 9 — the application must actually be runnable', () => {
  it('never writes a relative import with a .js extension', () => {
    // Node's type stripping does NOT rewrite `./x.js` to `./x.ts`. Task 001 used
    // `.js` specifiers throughout, so `pnpm start` failed with ERR_MODULE_NOT_FOUND
    // — the API could not boot at all. It went unnoticed because Vitest had a
    // resolver plugin papering over it, so every test passed against code that
    // could not run.
    //
    // Relative imports therefore carry the real `.ts` extension, which Node,
    // Vite and TypeScript all resolve. tests/integration/boot.test.ts proves the
    // process starts; this rule catches the cause directly.
    const violations: string[] = [];
    for (const dir of ['apps/api/src', 'apps/web/src', 'packages', 'db', 'tools']) {
      for (const file of sourceFiles(dir)) {
        for (const specifier of importsOf(file)) {
          if (specifier.startsWith('.') && specifier.endsWith('.js')) {
            violations.push(`${relative(ROOT, file)} imports "${specifier}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every relative import resolves to a file that exists', () => {
    // `tsc` is lenient here — it happily resolved `./App.ts` to `App.tsx` — but
    // Rollup and Node are not, so a wrong extension is a broken build or a
    // broken boot rather than a type error. This rule checks the specifier
    // against the filesystem, which is what both runtimes actually do.
    // Root-level config files are included: a dead import there does not fail
    // the build (the config loader tree-shakes it) but it is still a lie about
    // what the project depends on.
    const rootConfigs = readdirSync(ROOT)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => join(ROOT, entry));

    const violations: string[] = [];
    for (const dir of ['apps/api/src', 'apps/web/src', 'packages', 'db', 'tools', 'tests']) {
      for (const file of [...sourceFiles(dir), ...rootConfigs]) {
        for (const specifier of importsOf(file)) {
          if (!specifier.startsWith('.')) continue;
          const target = resolve(dirname(file), specifier);
          if (!existsSync(target)) {
            violations.push(`${relative(ROOT, file)} imports "${specifier}" (no such file)`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Rule 10 — the answer key never leaves the database.
 *
 * This is the only architecture rule in the file that guards a single table,
 * and it earns that because the property it protects cannot be re-established
 * by review once it is lost: a `SELECT` that pulls correctness into a repository
 * is one careless spread away from a response body, and nobody reading the
 * response schema would see it.
 *
 * The rule is mechanical rather than tasteful. `assessment_answer_keys` may
 * appear in application CODE only in an INSERT — never after FROM or JOIN — and
 * `app_score_attempt` may not appear at all, because it is granted to nobody
 * and calling it would be a permission error at runtime rather than a design
 * decision at review time.
 *
 * Comments are stripped first, for the same reason `importsOf` strips them:
 * these files EXPLAIN the rule at length, and prose describing what must not
 * happen is not the thing happening. Every assertion below was verified to fail
 * when the corresponding query was actually reintroduced.
 */
describe('rule 10 — the answer key stays in the database', () => {
  const apiCode = sourceFiles('apps/api/src').map(
    (file) => [relative(ROOT, file), stripComments(readFileSync(file, 'utf8'))] as const,
  );

  it('no application query reads from assessment_answer_keys', () => {
    // Matches `FROM assessment_answer_keys`, `JOIN assessment_answer_keys`, and
    // the same with a schema qualifier or extra whitespace.
    const reads = /\b(from|join)\s+(public\.)?assessment_answer_keys\b/i;
    const violations = apiCode.filter(([, code]) => reads.test(code)).map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('the answer key is written, and only written', () => {
    // Every surviving mention must be part of an INSERT. This catches a
    // subquery or CTE that reads the table under a name the regex above would
    // miss, by requiring the mentioning line to be the writing one.
    const violations: string[] = [];
    for (const [name, code] of apiCode) {
      for (const line of code.split('\n')) {
        if (!/assessment_answer_keys/i.test(line)) continue;
        if (!/insert\s+into\s+assessment_answer_keys/i.test(line)) {
          violations.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the scorer is never called from application code', () => {
    // `app_score_attempt` is granted to no role. It is reachable only from the
    // submit trigger, which is SECURITY DEFINER for exactly that reason. A call
    // from here would be a runtime permission error — and, worse, an attempt to
    // load marks for an attempt without consulting a policy first.
    const violations = apiCode
      .filter(([, code]) => /app_score_attempt/.test(code))
      .map(([name]) => name);
    expect(violations).toEqual([]);
  });

  it('no response schema carries a field that could hold a correct answer', () => {
    // The contracts package is where a leak would have to surface, because
    // every response in the assessment module is built field by field through
    // one of these schemas. A property named for correctness is refused here
    // rather than caught in review.
    //
    // `correctOptions` on the AUTHORING request is legitimate and different: it
    // travels inbound, from an author who already holds the key. Only the
    // response half of the file is scanned.
    const forbidden = /\b(isCorrect|correctOptionIds|correctAnswers?|answerKey)\b/;
    const contract = stripComments(
      readFileSync(join(ROOT, 'packages/contracts/src/assessment.contract.ts'), 'utf8'),
    );
    const responses = contract.slice(contract.indexOf('export const activityResponseSchema'));
    expect(responses).not.toMatch(forbidden);
  });
});

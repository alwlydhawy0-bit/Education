import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(absolute);
  return out;
}

/** Import specifiers, from both `import ... from '...'` and `import('...')`. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
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

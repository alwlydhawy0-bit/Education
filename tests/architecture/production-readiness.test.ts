import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../../apps/api/src/platform/config.ts';

/**
 * FITNESS FUNCTIONS FOR THE DEPLOYMENT SURFACE (Task 016).
 *
 * These assert on SOURCE TEXT, like the other files in this directory, and for
 * the same reason: the properties below have no runtime to observe. Nobody can
 * write a behavioural test proving the image runs as an unprivileged user
 * without an image, and this environment cannot build one — every container
 * registry is blocked by egress policy. What can be checked is that the
 * Dockerfile still says what it said when it was reviewed, and that the
 * invariants nobody would think to re-check are not quietly edited away.
 *
 * A fitness function is weaker than a behavioural test and stronger than a
 * comment. Where a behavioural test exists, it is elsewhere and this file does
 * not duplicate it.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/**
 * Strip comments before asserting on code.
 *
 * Learned twice now, and the second time was in this very file. Every rule
 * below is explained in a comment ABOVE the thing it checks, and those comments
 * quote the code they are about — `console.error('Failed to start:', error)`,
 * `HEALTHCHECK`. An assertion over the raw file therefore reads its own
 * rationale as evidence and reports the opposite of the truth: two of these
 * tests failed on their own prose while the code was correct.
 *
 * Task 015 hit the same thing in SQL and added `stripSqlComments`. The general
 * rule is the same: A FITNESS FUNCTION MUST ASSERT ON CODE, NEVER ON THE
 * DOCUMENTATION OF CODE — in either direction, since the failure mode is a
 * false alarm one way and a vacuous pass the other.
 */
function stripComments(source: string, style: 'ts' | 'hash'): string {
  if (style === 'hash') {
    return source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
  }
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every .ts file the API image actually ships. */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === 'node_modules') continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(join(ROOT, 'apps/api/src'));
  walk(join(ROOT, 'packages'));
  return out.filter((f) => !f.includes('/dist/'));
}

describe('the Redis client stays behind the store', () => {
  it('only platform/security/rate-limit-store.ts imports ioredis', () => {
    // The same rule the Anthropic SDK lives under (rule: vendor SDK confined to
    // platform/ai). A driver imported from a service is a driver that will
    // eventually be used from a service, and then the failure semantics — which
    // this platform has decided carefully — become whatever that call site
    // happened to do.
    const importers = shippedSources()
      .filter((file) => /from ['"]ioredis['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(importers).toEqual(['apps/api/src/platform/security/rate-limit-store.ts']);
  });
});

describe('the shipped source runs under --experimental-strip-types', () => {
  /**
   * Node ERASES type annotations; it does not TRANSFORM syntax. A handful of
   * TypeScript constructs need a transform, and each one typechecks perfectly
   * and then refuses to start with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
   *
   * This is not hypothetical: the first version of the rate-limit store used
   * constructor parameter properties. `pnpm typecheck` was clean and the
   * process died on import. There is no build step to catch it, so the check
   * has to be here.
   */
  it('uses no constructor parameter properties', () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const source = readFileSync(file, 'utf8');
      // `constructor(` followed by a modifier on a parameter.
      if (/constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+\w+\s*:/s.test(source)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no enum or namespace declarations', () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const source = readFileSync(file, 'utf8');
      if (/^\s*(?:export\s+)?(?:const\s+)?enum\s+\w+/m.test(source)) {
        offenders.push(`${relative(ROOT, file)} (enum)`);
      }
      if (/^\s*(?:export\s+)?namespace\s+\w+/m.test(source)) {
        offenders.push(`${relative(ROOT, file)} (namespace)`);
      }
    }
    // `SecurityEventType` is an object literal with `as const` rather than an
    // enum precisely because of this; the pattern is already the platform's,
    // and this stops it drifting.
    expect(offenders).toEqual([]);
  });
});

describe('the process entry point logs through the redactor', () => {
  it('main.ts calls no console method', () => {
    // It used to. `console.error('Failed to start:', error)` printed a raw pg
    // error, and a pg connection error carries the connection string, which
    // carries the password. The redacting logger exists so that no context
    // object reaches a sink unredacted, and this was the one file going around
    // it — the file that runs first.
    expect(stripComments(read('apps/api/src/main.ts'), 'ts')).not.toMatch(/\bconsole\.\w+\(/);
  });

  it('logs a startup failure without the error object', () => {
    const source = read('apps/api/src/main.ts');
    expect(source).toContain("error instanceof Error ? error.message : 'unknown'");
    // `{ error }` would put the whole object — connection string included —
    // into the log context.
    expect(source).not.toMatch(/logger\.error\([^)]*\{\s*error\s*\}/);
  });
});

describe('the container image', () => {
  const dockerfile = stripComments(read('Dockerfile'), 'hash');

  it('runs as an unprivileged user', () => {
    // Root inside a container is not a sandbox; an escape starts from whatever
    // the process already had.
    expect(dockerfile).toMatch(/^USER node$/m);
    // ...and the switch happens before the entrypoint, not after it.
    expect(dockerfile.indexOf('USER node')).toBeLessThan(dockerfile.indexOf('CMD ['));
  });

  it('installs production dependencies only, scoped to the API', () => {
    expect(dockerfile).toContain('--frozen-lockfile --prod --filter @edu/api...');
  });

  it('pins the base image and the package manager', () => {
    // A floating base tag makes the image non-reproducible; a floating pnpm
    // resolves a different tree from the lockfile CI verified.
    const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    expect(bases.length).toBeGreaterThan(1);
    for (const base of bases) expect(base).toMatch(/^node:\d+\.\d+-\S+$/);
    expect(dockerfile).toContain(`corepack prepare pnpm@`);
  });

  it('health-checks READINESS, not liveness', () => {
    // Docker's health state gates traffic, which is the readiness question. The
    // liveness endpoint reports healthy with the database unreachable.
    const healthcheck = /HEALTHCHECK[\s\S]*?\n(?=\n|#|CMD \[)/.exec(dockerfile)?.[0] ?? '';
    expect(healthcheck).toContain('/api/v1/health/ready');
    expect(healthcheck).not.toMatch(/health'\)/);
  });

  it('copies the whole dependency tree, not just the root node_modules', () => {
    // A pnpm workspace install writes node_modules into every package that has
    // a dependency, and those symlinks are what the resolver follows. Copying
    // only /app/node_modules produces an image that builds and cannot resolve
    // @edu/kernel from inside @edu/authz.
    expect(dockerfile).toMatch(/COPY[^\n]*--from=deps \/app \.\//);
  });

  it('bakes in no credential', () => {
    // Every ENV in the image is visible in `docker history` to anyone who can
    // pull it. Configuration values are fine; secrets arrive at run time.
    const envs = [...dockerfile.matchAll(/^ENV\s+(\w+)=/gm)].map((m) => m[1] ?? '');
    for (const name of envs) {
      expect(name).not.toMatch(/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|REDIS_URL/i);
    }
  });

  it('is excluded from carrying the repository secrets it does not need', () => {
    const ignored = read('.dockerignore');
    for (const entry of ['.env', 'tests', '.git']) expect(ignored).toContain(entry);
  });
});

describe('the compose stack', () => {
  const compose = stripComments(read('docker-compose.yml'), 'hash');

  it('never hands the API the migrator credential', () => {
    // Running the server as the schema owner silently disables Row-Level
    // Security across the whole database, with no error and no symptom.
    const api = compose.slice(compose.indexOf('\n  api:'));
    expect(api).not.toContain('edu_migrator');
    expect(api).toContain('edu_app');
  });

  it('runs migrations from the same image as the API', () => {
    // So the schema applied is the one the code about to serve traffic was
    // written against, not whatever a separate runner checked out.
    const images = [...compose.matchAll(/^\s{4}image:\s*(\S+)/gm)].map((m) => m[1]);
    expect(images.filter((i) => i === 'edu-api:local')).toHaveLength(2);
  });

  it('starts the API only after migrations have SUCCEEDED', () => {
    expect(compose).toContain('condition: service_completed_successfully');
  });

  it('publishes no database or cache port to the host', () => {
    // A database port on 0.0.0.0 is the most commonly exposed service in a
    // developer's compose file, and this one holds children's coursework.
    const published = [...compose.matchAll(/^\s+-\s+'([^']*:\d+:\d+|\d+:\d+)'/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(published).toEqual(['127.0.0.1:3000:3000']);
  });

  it('does not claim to be production', () => {
    // It serves plaintext with a password in a file. Labelling that
    // `production` would make the configuration loader refuse to start — which
    // would be the loader working correctly.
    expect(compose).not.toMatch(/NODE_ENV:\s*production/);
  });
});

describe('the production environment template', () => {
  // NOT comment-stripped: this template names several keys in commented-out
  // form deliberately (TRUST_PROXY, AI_API_KEY), and "is the key named and
  // explained" is exactly what the first assertion below is asking.
  const template = read('.env.production.example');

  it('names every configuration key the application reads', () => {
    // A template missing a key is how a deployment ends up relying on a default
    // nobody chose. Commented-out keys count: they are named and explained.
    const missing = CONFIG_KEYS.filter((key) => !new RegExp(`^#?\\s*${key}=`, 'm').test(template));
    expect(missing).toEqual([]);
  });

  it('holds no value that looks like a real credential', () => {
    // It is a template. Every secret-bearing line carries the placeholder its
    // own validator refuses to deploy.
    for (const key of ['DATABASE_URL', 'REDIS_URL']) {
      const line = new RegExp(`^${key}=(.*)$`, 'm').exec(template)?.[1] ?? '';
      expect(line).toContain('CHANGE_ME');
    }
  });

  it('sets NODE_ENV=production, so the hardened refusals are the ones being validated', () => {
    expect(template).toMatch(/^NODE_ENV=production$/m);
  });
});

describe('the audits are runnable, not just present', () => {
  it('each has a package script', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['security:rls']).toContain('tools/security/audit-rls.ts');
    expect(scripts['db:audit-indexes']).toContain('tools/db/audit-indexes.ts');
    expect(scripts['deploy:check-env']).toContain('tools/deploy/check-env.ts');
  });
});

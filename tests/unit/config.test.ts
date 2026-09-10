import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoPrivateLeakage,
  loadConfig,
  toPublicConfig,
} from '../../apps/api/src/platform/config.ts';

/**
 * Configuration must fail fast and must refuse unsafe production combinations.
 * A server that boots with insecure cookies is worse than one that refuses to
 * boot, because nobody notices the first one.
 */
const base = {
  DATABASE_URL: 'postgres://user:pw@localhost/db', // secret-scan-allow: inert example connection string for config parsing tests
  ALLOWED_ORIGINS: 'https://app.example.com',
};

describe('loadConfig', () => {
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('defaults to secure cookies', () => {
    expect(loadConfig({ ...base }).SESSION_COOKIE_SECURE).toBe(true);
  });

  it('defaults the locale-independent safe values', () => {
    const config = loadConfig({ ...base });
    expect(config.NODE_ENV).toBe('development');
    expect(config.HOST).toBe('127.0.0.1'); // Not 0.0.0.0 by accident.
  });

  it('REFUSES to start in production with insecure cookies', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/SESSION_COOKIE_SECURE must be true in production/);
  });

  it('REFUSES to start in production with a plaintext allowed origin', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://app.example.com' }),
    ).toThrow(/must be https/);
  });

  it('permits insecure cookies in development', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'development',
      SESSION_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    });
    expect(config.SESSION_COOKIE_SECURE).toBe(false);
  });

  it('parses a comma-separated origin list', () => {
    const config = loadConfig({
      ...base,
      ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(config.ALLOWED_ORIGINS).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('rejects a malformed port instead of silently defaulting', () => {
    expect(() => loadConfig({ ...base, PORT: 'not-a-number' })).toThrow(/Invalid configuration/);
  });
});

describe('hardened environments (production AND staging)', () => {
  // Staging holds real-shaped data and is reachable over the network. Every
  // production safety rule must apply to it too, otherwise adding an
  // environment silently opens a hole.
  const hardened = ['production', 'staging'] as const;

  it.each(hardened)('%s refuses to start with insecure cookies', (environment) => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: environment, SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/SESSION_COOKIE_SECURE must be true/);
  });

  it.each(hardened)('%s refuses to start with rate limiting disabled', (environment) => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: environment, RATE_LIMIT_ENABLED: 'false' }),
    ).toThrow(/RATE_LIMIT_ENABLED must not be false/);
  });

  it.each(hardened)('%s refuses to start with a plaintext allowed origin', (environment) => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: environment, ALLOWED_ORIGINS: 'http://app.example.com' }),
    ).toThrow(/must be https/);
  });

  it.each(hardened)('%s refuses to start with an empty origin list', (environment) => {
    expect(() => loadConfig({ ...base, NODE_ENV: environment, ALLOWED_ORIGINS: '  ,  ' })).toThrow(
      /must not be empty/,
    );
  });

  it.each(hardened)('%s refuses to start with debug logging', (environment) => {
    expect(() => loadConfig({ ...base, NODE_ENV: environment, LOG_LEVEL: 'debug' })).toThrow(
      /LOG_LEVEL must not be "debug"/,
    );
  });

  it.each(hardened)('%s refuses to start without a shared rate-limit store', (environment) => {
    // Added in Task 016. Without one, limits are counted per process: with six
    // replicas a "10 logins per 15 minutes" limit enforces sixty, and nothing
    // in the response, the logs or the dashboard says so (RISK-RATE-01).
    expect(() => loadConfig({ ...base, NODE_ENV: environment, LOG_LEVEL: 'info' })).toThrow(
      /REDIS_URL is required/,
    );
  });

  it.each(hardened)('%s refuses a REDIS_URL that is not a Redis URL', (environment) => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: environment,
        LOG_LEVEL: 'info',
        REDIS_URL: 'http://cache.internal:6379',
      }),
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it.each(hardened)('%s starts when every rule is satisfied', (environment) => {
    const config = loadConfig({
      ...base,
      NODE_ENV: environment,
      LOG_LEVEL: 'info',
      REDIS_URL: 'rediss://cache.internal:6379',
    });
    expect(config.NODE_ENV).toBe(environment);
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.REDIS_URL).toBe('rediss://cache.internal:6379');
  });

  it('development remains permissive', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug',
      SESSION_COOKIE_SECURE: 'false',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    });
    expect(config.SESSION_COOKIE_SECURE).toBe(false);
  });
});

describe('PUBLIC vs PRIVATE configuration', () => {
  const config = loadConfig({
    ...base,
    DATABASE_URL: 'postgres://someuser:a-very-distinctive-db-secret@db.internal/app', // secret-scan-allow: inert fixture asserted to be ABSENT from public config
  });

  it('never places a database credential in the public config', () => {
    const serialized = JSON.stringify(toPublicConfig(config));
    expect(serialized).not.toContain('a-very-distinctive-db-secret');
    expect(serialized).not.toContain('db.internal');
    expect(serialized).not.toContain('someuser');
  });

  it('exposes only the allow-listed public fields', () => {
    // If this fails, a field was added to PublicConfig. That is a decision that
    // must be made deliberately, so the test is meant to be noticed.
    expect(Object.keys(toPublicConfig(config)).sort()).toEqual(['apiVersion', 'environment']);
  });

  it('does not expose the session cookie name (the cookie is HttpOnly)', () => {
    expect(JSON.stringify(toPublicConfig(config))).not.toContain('edu_session');
  });

  it('throws if a private value ever reaches the public object', () => {
    // Simulates a future careless edit to toPublicConfig.
    const leaky = { ...toPublicConfig(config), databaseUrl: config.DATABASE_URL } as never;
    expect(() => assertNoPrivateLeakage(config, leaky)).toThrow(
      /would expose a server-only secret/,
    );
  });

  it('the leakage guard runs on every boot, not just in production', () => {
    // loadConfig itself calls it, so a passing load is evidence the guard ran.
    expect(() => loadConfig({ ...base, NODE_ENV: 'development' })).not.toThrow();
  });
});

describe('environment variable handling', () => {
  it('ignores variables it does not know about', () => {
    const config = loadConfig({ ...base, SOME_UNRELATED_VARIABLE: 'x', AWS_SECRET: 'y' });
    expect(Object.keys(config)).not.toContain('SOME_UNRELATED_VARIABLE');
    expect(Object.keys(config)).not.toContain('AWS_SECRET');
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'prod' })).toThrow(/Invalid configuration/);
  });
});

// =====================================================================
// TASK 014 — the provider is configured server-side, or not at all
// =====================================================================

describe('AI provider configuration', () => {
  it('defaults to the offline composer with no credential needed', () => {
    const config = loadConfig({ ...base });
    expect(config.AI_PROVIDER).toBe('none');
    expect(config.AI_API_KEY).toBeUndefined();
  });

  it('REFUSES TO START when a provider is named without a credential', () => {
    // A server that boots fine and then fails on a child's first question is
    // the worst version of this failure: nobody finds out until a learner
    // does. Refusing at startup turns it into a deployment error.
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'anthropic' })).toThrow(/AI_API_KEY/);
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'anthropic', AI_API_KEY: '   ' })).toThrow(
      /AI_API_KEY/,
    );
  });

  it('starts when the provider and its credential are both present', () => {
    const config = loadConfig({
      ...base,
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'a-test-value-that-is-not-a-credential', // secret-scan-allow: inert fixture for config parsing
    });
    expect(config.AI_PROVIDER).toBe('anthropic');
    expect(config.AI_MODEL).toBe('claude-opus-5');
  });

  it('REFUSES a model outside the allowlist', () => {
    // A model identifier reaches a paid API. An arbitrary value is whatever an
    // operator typed, and a typo is a failed request in front of a child.
    for (const model of ['gpt-4', 'claude-instant', 'claude-opus-5-20991231', '']) {
      expect(() => loadConfig({ ...base, AI_MODEL: model })).toThrow();
    }
  });

  it('REFUSES an out-of-range output ceiling', () => {
    for (const tokens of ['0', '-1', '999999', 'lots']) {
      expect(() => loadConfig({ ...base, AI_MAX_OUTPUT_TOKENS: tokens })).toThrow();
    }
    expect(loadConfig({ ...base, AI_MAX_OUTPUT_TOKENS: '512' }).AI_MAX_OUTPUT_TOKENS).toBe(512);
  });

  it('REFUSES an out-of-range timeout', () => {
    for (const ms of ['0', '500', '600000']) {
      expect(() => loadConfig({ ...base, AI_TIMEOUT_MS: ms })).toThrow();
    }
  });

  it('pins the provider destination, and requires https', () => {
    // VULN-038. The destination of a credential-bearing request is a security
    // decision, so it is a validated configuration value with a safe default
    // rather than whatever `ANTHROPIC_BASE_URL` happens to say.
    expect(loadConfig({ ...base }).AI_BASE_URL).toBe('https://api.anthropic.com');
    expect(loadConfig({ ...base, AI_BASE_URL: 'https://gateway.example.com' }).AI_BASE_URL).toBe(
      'https://gateway.example.com',
    );
    for (const bad of [
      'http://gateway.example.com', // plaintext: the credential would travel in clear
      'not-a-url',
      'ftp://example.com',
      '',
    ]) {
      expect(() => loadConfig({ ...base, AI_BASE_URL: bad })).toThrow();
    }
  });

  it('never places the provider credential in the public config', () => {
    const config = loadConfig({
      ...base,
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'a-very-distinctive-provider-secret', // secret-scan-allow: inert fixture asserted to be ABSENT from public config
    });
    expect(JSON.stringify(toPublicConfig(config))).not.toContain(
      'a-very-distinctive-provider-secret',
    );
  });

  it('the leakage guard catches an AI key reaching the public object', () => {
    // The same backstop that protects DATABASE_URL, asserted for the new
    // secret — because a guard that only knows about the first secret it was
    // written for is a guard that stops working the day a second one is added.
    const config = loadConfig({
      ...base,
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'another-distinctive-provider-secret', // secret-scan-allow: inert fixture for the leakage guard
    });
    const leaky = { ...toPublicConfig(config), aiApiKey: config.AI_API_KEY } as never;
    expect(() => assertNoPrivateLeakage(config, leaky)).toThrow(
      /would expose a server-only secret/,
    );
  });
});

describe('the environment allowlist and the schema cannot disagree', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TEST THAT WOULD HAVE CAUGHT VULN-037
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `loadConfig` copies only the keys named in `CONFIG_KEYS` out of the
   * environment. A key declared in the schema but missing from that list is
   * SILENTLY IGNORED: the variable can be set, documented, and described in a
   * final report, and it does nothing. Task 013 shipped three such keys.
   *
   * The reverse direction is already loud — the schema is `.strict()`, so a key
   * in the list and not in the schema fails at boot. Only this direction was
   * unguarded, so only this direction needs asserting.
   *
   * It is a source-level test because both facts live in the same file and
   * neither is exported. Comparing them at runtime would need the schema's
   * internals; comparing the declarations is what actually catches the drift.
   */
  const source = readFileSync(
    resolve(import.meta.dirname, '../../apps/api/src/platform/config.ts'),
    'utf8',
  );

  const allowlisted = new Set(
    [
      ...(/const CONFIG_KEYS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? '').matchAll(
        /'([A-Z0-9_]+)'/g,
      ),
    ].map((match) => match[1] ?? ''),
  );

  const declared = [
    ...(
      /const configSchema = z[\s\S]*?\n {2}\}\)\n {2}\.strict\(\)/.exec(source)?.[0] ?? ''
    ).matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm),
  ].map((match) => match[1] ?? '');

  it('finds both declarations, so a parsing change cannot make this vacuous', () => {
    // Without this, a rename that broke the regexes above would leave the
    // real assertion comparing two empty sets and passing forever.
    expect(allowlisted.size).toBeGreaterThan(15);
    expect(declared.length).toBeGreaterThan(15);
  });

  it('every schema key is read from the environment', () => {
    const ignored = declared.filter((key) => !allowlisted.has(key));
    expect(ignored).toEqual([]);
  });

  it('specifically, every AI key is read', () => {
    // Named explicitly as well as covered by the rule above, because these are
    // the ones that were wrong and a regression here re-breaks the provider.
    for (const key of [
      'AI_PROVIDER',
      'AI_API_KEY',
      'AI_MODEL',
      'AI_MAX_OUTPUT_TOKENS',
      'AI_BASE_URL',
      'AI_TIMEOUT_MS',
    ]) {
      expect({ key, read: allowlisted.has(key) }).toEqual({ key, read: true });
    }
  });
});

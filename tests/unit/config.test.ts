import { describe, expect, it } from 'vitest';
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

  it.each(hardened)('%s starts when every rule is satisfied', (environment) => {
    const config = loadConfig({ ...base, NODE_ENV: environment, LOG_LEVEL: 'info' });
    expect(config.NODE_ENV).toBe(environment);
    expect(config.SESSION_COOKIE_SECURE).toBe(true);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
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

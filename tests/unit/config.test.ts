import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/api/src/platform/config.js';

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

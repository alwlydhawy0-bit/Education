import { describe, expect, it } from 'vitest';
import { checkEnv, parseEnvFile } from '../../tools/deploy/check-env.ts';

/**
 * THE PRE-DEPLOY ENVIRONMENT CHECK.
 *
 * `platform/config.ts` already refuses to start on a bad configuration. This
 * validator exists to move that refusal EARLIER — before an image is built and
 * scheduled — and its value depends entirely on it enforcing the same rules.
 * So the tests below check two things: that it catches what the server would
 * catch, and that it catches the two classes a schema cannot.
 */

/** A configuration that should pass cleanly, used as the base for each mutation. */
function goodEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgres://edu_app:a-real-looking-password@db.internal:5432/edu', // secret-scan-allow: an obviously fake value, present so the leakage test has something to look for
    REDIS_URL: 'rediss://default:another-password@cache.internal:6379',
    ALLOWED_ORIGINS: 'https://app.example.edu',
    SESSION_COOKIE_SECURE: 'true',
    RATE_LIMIT_ENABLED: 'true',
    AI_PROVIDER: 'none',
  };
}

const keysWithErrors = (env: Record<string, string>) =>
  checkEnv(env)
    .filter((p) => p.severity === 'error')
    .map((p) => p.key);

describe('a well-formed production environment', () => {
  it('passes', () => {
    expect(keysWithErrors(goodEnv())).toEqual([]);
  });
});

describe('it enforces exactly what the server enforces at startup', () => {
  it('refuses an insecure session cookie', () => {
    expect(keysWithErrors({ ...goodEnv(), SESSION_COOKIE_SECURE: 'false' })).toContain(
      'SESSION_COOKIE_SECURE',
    );
  });

  it('refuses a plaintext origin', () => {
    expect(keysWithErrors({ ...goodEnv(), ALLOWED_ORIGINS: 'http://app.example.edu' })).toContain(
      'ALLOWED_ORIGINS',
    );
  });

  it('refuses debug logging', () => {
    expect(keysWithErrors({ ...goodEnv(), LOG_LEVEL: 'debug' })).toContain('LOG_LEVEL');
  });

  it('refuses rate limiting turned off', () => {
    expect(keysWithErrors({ ...goodEnv(), RATE_LIMIT_ENABLED: 'false' })).toContain(
      'RATE_LIMIT_ENABLED',
    );
  });

  it('refuses a missing shared rate-limit store', () => {
    const { REDIS_URL: _dropped, ...withoutRedis } = goodEnv();
    // Without it the configured limit is a per-instance limit, and nothing in
    // the response, the logs or the dashboard says so.
    expect(keysWithErrors(withoutRedis)).toContain('REDIS_URL');
  });

  it('refuses a provider named without a credential', () => {
    expect(keysWithErrors({ ...goodEnv(), AI_PROVIDER: 'anthropic' })).toContain('AI_API_KEY');
  });

  it('refuses a missing database URL', () => {
    const { DATABASE_URL: _dropped, ...withoutDb } = goodEnv();
    expect(keysWithErrors(withoutDb)).toContain('DATABASE_URL');
  });

  it('reports EVERY problem at once, not whichever one Zod hit first', () => {
    // The whole reason to run this before a deploy rather than discovering it
    // in a crash loop: one pass, one list.
    const broken = {
      ...goodEnv(),
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'debug',
      ALLOWED_ORIGINS: 'http://nope.example',
    };
    const keys = keysWithErrors(broken);
    expect(keys).toContain('SESSION_COOKIE_SECURE');
    expect(keys).toContain('LOG_LEVEL');
    expect(keys).toContain('ALLOWED_ORIGINS');
  });

  it('applies the production rules to staging too', () => {
    expect(keysWithErrors({ ...goodEnv(), NODE_ENV: 'staging', LOG_LEVEL: 'debug' })).toContain(
      'LOG_LEVEL',
    );
  });
});

describe('it catches the two classes a schema cannot', () => {
  it('refuses a placeholder left in a copied template', () => {
    // CHANGE_ME is a perfectly valid non-empty string, and
    // postgres://user:CHANGE_ME@host/db is a perfectly valid URL. The failure
    // it produces is a deployment that boots and then cannot authenticate,
    // which looks like an infrastructure problem rather than a copied template.
    const env = { ...goodEnv(), DATABASE_URL: 'postgres://edu_app:CHANGE_ME@db:5432/edu' };
    expect(keysWithErrors(env)).toContain('DATABASE_URL');
    expect(checkEnv(env).find((p) => p.key === 'DATABASE_URL')?.message).toContain('placeholder');
  });

  it('warns about a variable the application will silently ignore', () => {
    // The mirror image of VULN-037. An operator sets REDIS_HOST where the code
    // reads REDIS_URL, believes the cache is configured, and gets no error
    // anywhere.
    const problems = checkEnv({ ...goodEnv(), REDIS_HOST: 'cache.internal' });
    const warning = problems.find((p) => p.key === 'REDIS_HOST');
    expect(warning?.severity).toBe('warning');
    // A warning, not an error: a deployment legitimately carries variables for
    // a log shipper or a sidecar.
    expect(keysWithErrors({ ...goodEnv(), REDIS_HOST: 'cache.internal' })).toEqual([]);
  });
});

describe('it validates the proxy setting the schema deliberately leaves alone', () => {
  it('refuses blanket proxy trust', () => {
    expect(keysWithErrors({ ...goodEnv(), TRUST_PROXY: 'true' })).toContain('TRUST_PROXY');
  });

  it('refuses a hop count', () => {
    const problems = checkEnv({ ...goodEnv(), TRUST_PROXY: '2' });
    expect(problems.find((p) => p.key === 'TRUST_PROXY')?.message).toContain('trusts no peer');
  });

  it('accepts an address list', () => {
    expect(keysWithErrors({ ...goodEnv(), TRUST_PROXY: '10.0.0.0/8' })).toEqual([]);
  });
});

describe('it never prints a value', () => {
  it('reports keys and descriptions, never the right-hand side', () => {
    // The file this reads is the most secret-dense a deployment has. Every
    // message must be safe to paste into a ticket.
    const env = {
      ...goodEnv(),
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'debug',
      ALLOWED_ORIGINS: 'http://plain.example',
      SOMETHING_UNKNOWN: 'super-secret-value',
    };
    const serialised = JSON.stringify(checkEnv(env));
    expect(serialised).not.toContain('a-real-looking-password');
    expect(serialised).not.toContain('another-password');
    expect(serialised).not.toContain('super-secret-value');
  });
});

describe('the .env parser', () => {
  it('reads the forms a real file contains', () => {
    expect(
      parseEnvFile(
        [
          '# a comment',
          '',
          'PLAIN=value',
          'export EXPORTED=value2',
          'QUOTED="has spaces"',
          "SINGLE='also quoted'",
          'EMPTY=',
          'URL=postgres://u:p@h:5432/d?x=1', // secret-scan-allow: a parser fixture, not a credential
        ].join('\n'),
      ),
    ).toEqual({
      PLAIN: 'value',
      EXPORTED: 'value2',
      QUOTED: 'has spaces',
      SINGLE: 'also quoted',
      EMPTY: '',
      URL: 'postgres://u:p@h:5432/d?x=1', // secret-scan-allow: a parser fixture, not a credential
    });
  });

  it('ignores lines that are not assignments rather than guessing', () => {
    expect(parseEnvFile('just some text\n=novalue\n# KEY=commented')).toEqual({});
  });
});

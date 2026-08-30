import { describe, expect, it } from 'vitest';
import { createLogger, createMemorySink, redact, REDACTED } from '@edu/observability';

/**
 * Log redaction (brief section 22: never log passwords, tokens, keys, secrets).
 *
 * These tests assert the property that matters operationally: a developer
 * cannot leak a credential by logging the wrong object, because redaction is
 * applied centrally and has no bypass.
 */
describe('redact', () => {
  it.each([
    'password',
    'newPassword',
    'password_hash',
    'token',
    'accessToken',
    'refresh_token',
    'apiKey',
    'API_KEY',
    'authorization',
    'Cookie',
    'clientSecret',
    'privateKey',
    'totp',
  ])('redacts the "%s" field regardless of naming style', (key) => {
    const out = redact({ [key]: 'super-secret-value' }) as Record<string, unknown>;
    expect(out[key]).toBe(REDACTED);
  });

  it('redacts nested secrets', () => {
    const out = redact({ user: { profile: { password: 'hunter2' } } }) as any;
    expect(out.user.profile.password).toBe(REDACTED);
  });

  it('redacts secrets inside arrays', () => {
    const out = redact({ items: [{ apiKey: 'abc' }] }) as any;
    expect(out.items[0].apiKey).toBe(REDACTED);
  });

  it('redacts a bearer token that appears under an innocent key name', () => {
    const out = redact({ note: 'Authorization: Bearer abcdefghijklmnop1234567890' }) as any;
    expect(out.note).not.toContain('abcdefghijklmnop1234567890');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----'; // secret-scan-allow: fake PEM fragment; the test asserts it IS redacted
    const out = redact({ blob: pem }) as any;
    expect(out.blob).toBe(REDACTED);
  });

  it('redacts anything shaped like one of our session tokens', () => {
    // 43+ base64url characters is exactly the shape of a 32-byte token.
    const token = 'A'.repeat(43);
    const out = redact({ someField: `value=${token}` }) as any;
    expect(out.someField).not.toContain(token);
  });

  it('leaves ordinary values alone', () => {
    const out = redact({ id: 42, title: 'Chemistry lab', locale: 'ar' }) as any;
    expect(out).toEqual({ id: 42, title: 'Chemistry lab', locale: 'ar' });
  });

  it('preserves Arabic content unchanged', () => {
    const out = redact({ title: 'تجربة الكيمياء' }) as any;
    expect(out.title).toBe('تجربة الكيمياء');
  });

  it('survives a circular structure instead of hanging', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect((redact(cyclic) as any).self).toBe('[CIRCULAR]');
  });

  it('reduces an Error to name and message, dropping the stack', () => {
    const out = redact({ error: new Error('boom') }) as any;
    expect(out.error).toEqual({ name: 'Error', message: 'boom' });
    expect(out.error.stack).toBeUndefined();
  });
});

describe('logger', () => {
  it('redacts context on every level, with no bypass', () => {
    const { sink, records } = createMemorySink();
    const logger = createLogger({ level: 'debug', sink });

    logger.debug('d', { password: 'p' });
    logger.info('i', { token: 't' });
    logger.warn('w', { apiKey: 'k' });
    logger.error('e', { secret: 's' });

    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toMatch(/"(p|t|k|s)"/);
    }
  });

  it('redacts bindings inherited through child()', () => {
    const { sink, records } = createMemorySink();
    const logger = createLogger({ level: 'info', sink }).child({ sessionToken: 'leaky' });
    logger.info('hello');
    expect(JSON.stringify(records[0])).not.toContain('leaky');
  });

  it('honours the level threshold', () => {
    const { sink, records } = createMemorySink();
    const logger = createLogger({ level: 'warn', sink });
    logger.info('dropped');
    logger.warn('kept');
    expect(records.map((r) => r.message)).toEqual(['kept']);
  });
});

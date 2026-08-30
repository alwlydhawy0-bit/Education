import { describe, expect, it } from 'vitest';
import {
  createNoteRequestSchema,
  registerRequestSchema,
  updateNoteRequestSchema,
  loginRequestSchema,
  containsDisallowedTextControls,
  noteBodySchema,
} from '@edu/contracts';

/**
 * Contract validation as a security control.
 *
 * The mass-assignment tests are the important ones: every request schema is
 * `.strict()`, so a field the server does not expect is REJECTED rather than
 * silently ignored. Silent ignoring is what makes mass assignment dangerous —
 * the field sits harmlessly in the payload until some future refactor starts
 * reading it.
 */
describe('registerRequestSchema — mass assignment', () => {
  const valid = {
    email: 'Student@Example.COM',
    password: 'a-long-enough-passphrase', // secret-scan-allow: test fixture password used to assert the length policy
    displayName: 'طالب',
  };

  it('accepts a valid registration and normalizes the email', () => {
    const parsed = registerRequestSchema.parse(valid);
    expect(parsed.email).toBe('student@example.com');
    expect(parsed.locale).toBe('ar'); // Arabic is the default, not English.
  });

  it.each(['roles', 'role', 'isAdmin', 'status', 'organizationId', 'id'])(
    'rejects an attempt to set "%s" at registration',
    (field) => {
      const result = registerRequestSchema.safeParse({ ...valid, [field]: 'admin' });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a password below the length floor', () => {
    expect(registerRequestSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('rejects an absurdly long password (bounds Argon2 work per request)', () => {
    const result = registerRequestSchema.safeParse({ ...valid, password: 'x'.repeat(5000) });
    expect(result.success).toBe(false);
  });

  it('accepts Arabic display names unchanged', () => {
    const parsed = registerRequestSchema.parse({ ...valid, displayName: 'محمد بن عبد الله' });
    expect(parsed.displayName).toBe('محمد بن عبد الله');
  });

  it('rejects a display name containing a bidi override', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE — used to make text render deceptively.
    const spoofed = `admin${String.fromCodePoint(0x202e)}evil`;
    expect(containsDisallowedTextControls(spoofed)).toBe(true);
    expect(registerRequestSchema.safeParse({ ...valid, displayName: spoofed }).success).toBe(false);
  });

  it('rejects a display name containing a null byte', () => {
    const withNul = `name${String.fromCodePoint(0)}`;
    expect(registerRequestSchema.safeParse({ ...valid, displayName: withNul }).success).toBe(false);
  });
});

describe('note contracts — ownership cannot be asserted by the client', () => {
  it.each(['ownerId', 'id', 'state', 'createdAt'])('rejects a client-supplied "%s"', (field) => {
    const result = createNoteRequestSchema.safeParse({
      title: 'My note',
      [field]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(result.success).toBe(false);
  });

  it('defaults new notes to private', () => {
    expect(createNoteRequestSchema.parse({ title: 'My note' }).visibility).toBe('private');
  });

  it('rejects an unknown visibility value', () => {
    const result = createNoteRequestSchema.safeParse({ title: 'x', visibility: 'public' });
    expect(result.success).toBe(false);
  });

  it('rejects a body over the 64 KiB cap', () => {
    expect(noteBodySchema.safeParse('x'.repeat(65_537)).success).toBe(false);
  });

  it('rejects an empty update (no fields to change)', () => {
    expect(updateNoteRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an update that tries to change the owner', () => {
    const result = updateNoteRequestSchema.safeParse({
      title: 'x',
      ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('does not apply the registration password policy to login', () => {
    // Rejecting a short password at login would tell an attacker that the
    // policy changed, and would lock out users whose password predates it.
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });

  it('rejects extra fields', () => {
    const result = loginRequestSchema.safeParse({
      email: 'a@b.co',
      password: 'x',
      impersonate: 'admin',
    });
    expect(result.success).toBe(false);
  });
});

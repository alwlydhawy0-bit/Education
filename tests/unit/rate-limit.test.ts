import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_POLICIES,
  RESERVED_RATE_LIMIT_POLICIES,
  routeLimit,
} from '../../apps/api/src/platform/security/rate-limit.ts';

/**
 * The rate-limit policy catalogue.
 *
 * These tests are mostly about honesty: they assert that the enforced policies
 * are sane, and that the RESERVED ones are not mistaken for active protection.
 */
describe('enforced policies', () => {
  it('applies a tighter limit to login than to the global default', () => {
    // Login is the brute-force target; a global ceiling is not protection.
    expect(RATE_LIMIT_POLICIES.authLogin.max).toBeLessThan(RATE_LIMIT_POLICIES.global.max);
  });

  it('applies the tightest limit of all to registration', () => {
    // Registration costs an Argon2 hash and is the enumeration vector.
    expect(RATE_LIMIT_POLICIES.authRegister.max).toBeLessThanOrEqual(
      RATE_LIMIT_POLICIES.authLogin.max,
    );
  });

  it('gives every policy a rationale', () => {
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
      expect(policy.rationale.length).toBeGreaterThan(20);
      expect(policy.max).toBeGreaterThan(0);
      expect(policy.timeWindow).toMatch(/\d/);
    }
  });

  it('converts a policy into the shape a route expects', () => {
    expect(routeLimit(RATE_LIMIT_POLICIES.authLogin)).toEqual({
      rateLimit: {
        max: RATE_LIMIT_POLICIES.authLogin.max,
        timeWindow: RATE_LIMIT_POLICIES.authLogin.timeWindow,
      },
    });
  });
});

describe('reserved policies are NOT active protection', () => {
  it('is kept separate from the enforced catalogue', () => {
    // If a reserved policy ever appears in RATE_LIMIT_POLICIES without a route
    // using it, the catalogue starts claiming protection that does not exist.
    const enforced: string[] = Object.values(RATE_LIMIT_POLICIES).map((p) => p.name);
    const reserved: string[] = Object.values(RESERVED_RATE_LIMIT_POLICIES).map((p) => p.name);
    expect(enforced.filter((name) => reserved.includes(name))).toEqual([]);
  });

  it('covers the surfaces still awaiting a route', () => {
    const reserved: string[] = Object.values(RESERVED_RATE_LIMIT_POLICIES).map((p) => p.name);
    expect(reserved).toContain('ai.request');
    expect(reserved).toContain('file.upload');
    expect(reserved).toContain('operation.expensive');
  });

  it('now ENFORCES password reset, which moved out of the reserved set', () => {
    // Task 003 built the reset flow, so its policy graduated from documented
    // intent to active protection.
    const enforced: string[] = Object.values(RATE_LIMIT_POLICIES).map((p) => p.name);
    expect(enforced).toContain('auth.password_reset');
    expect(enforced).toContain('auth.refresh');
    expect(enforced).toContain('auth.verify_email');
  });
});

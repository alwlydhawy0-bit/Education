import { describe, expect, it } from 'vitest';
import {
  BLANKET_TRUST_REFUSAL,
  HOP_COUNT_REFUSAL,
  describeTrustProxy,
  parseTrustProxy,
  trustsAProxy,
} from '../../apps/api/src/platform/security/trusted-proxy.ts';

/**
 * THE DECISION TABLE FOR `request.ip`.
 *
 * This value is the key of every IP-scoped rate limit and the `ip` field of
 * every security event. There is no behavioural test that can prove it is set
 * correctly for a deployment nobody has built yet, so the rule itself is the
 * thing under test: which strings are accepted, which are refused, and — for
 * the two refusals that matter — that the message says why.
 */
describe('parseTrustProxy — the accepted forms', () => {
  it('treats absent and empty as "trust nothing"', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('accepts an explicit false, in any case', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('False')).toBe(false);
    expect(parseTrustProxy('FALSE')).toBe(false);
  });

  it('accepts a single IPv4 address and a CIDR range', () => {
    expect(parseTrustProxy('10.0.0.1')).toEqual(['10.0.0.1']);
    expect(parseTrustProxy('10.0.0.0/8')).toEqual(['10.0.0.0/8']);
  });

  it('accepts a comma-separated list, trimming as it goes', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12 ,192.168.0.0/16')).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
    ]);
  });

  it('accepts IPv6 and the named ranges proxy-addr understands', () => {
    expect(parseTrustProxy('::1')).toEqual(['::1']);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
    expect(parseTrustProxy('loopback')).toEqual(['loopback']);
    expect(parseTrustProxy('uniquelocal, linklocal')).toEqual(['uniquelocal', 'linklocal']);
  });
});

describe('parseTrustProxy — the refusals', () => {
  it('refuses the blanket `true`, and says what it would cost', () => {
    // Blanket trust believes the last X-Forwarded-For hop unconditionally. That
    // header is client-supplied, so an attacker sends a new address per request
    // and no bucket ever fills: rate limiting stops existing while continuing
    // to report success.
    expect(() => parseTrustProxy('true')).toThrow(BLANKET_TRUST_REFUSAL);
    expect(() => parseTrustProxy('TRUE')).toThrow(BLANKET_TRUST_REFUSAL);
    expect(BLANKET_TRUST_REFUSAL).toContain('X-Forwarded-For');
  });

  it('refuses a hop count, because Fastify 5 implements it as "trust nothing"', () => {
    // The refusal that is not obvious. `getTrustProxyFn` in Fastify's
    // lib/request.js returns `function () { return false }` for a number, so
    // TRUST_PROXY=2 boots cleanly, logs a hop count, and keys every request to
    // the load balancer. Accepting it would make this module the source of the
    // confusion it exists to remove.
    expect(() => parseTrustProxy('1')).toThrow(HOP_COUNT_REFUSAL);
    expect(() => parseTrustProxy('2')).toThrow(HOP_COUNT_REFUSAL);
    expect(() => parseTrustProxy('0')).toThrow(HOP_COUNT_REFUSAL);
    expect(HOP_COUNT_REFUSAL).toContain('trusts no peer');
  });

  it('refuses hostnames — a name resolves at runtime, and this server does not control that', () => {
    expect(() => parseTrustProxy('proxy.internal')).toThrow(/not addresses or CIDR ranges/);
    expect(() => parseTrustProxy('10.0.0.1, proxy.internal')).toThrow(/proxy.internal/);
  });

  it('refuses malformed addresses rather than passing them to proxy-addr', () => {
    expect(() => parseTrustProxy('999.1.1.1')).toThrow(/not addresses/);
    expect(() => parseTrustProxy('10.0.0.0/64')).toThrow(/not addresses/);
    expect(() => parseTrustProxy('"10.0.0.1"')).toThrow(/not addresses/);
  });

  it('throws rather than falling back to a default', () => {
    // A misconfigured proxy setting is a broken security control. Defaulting
    // would produce a running server whose addresses cannot be trusted, which
    // is the failure this module exists to make impossible.
    let threw = false;
    try {
      parseTrustProxy('true');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('reporting the posture', () => {
  it('knows whether a forwarding header is believed', () => {
    expect(trustsAProxy(false)).toBe(false);
    expect(trustsAProxy(['10.0.0.0/8'])).toBe(true);
  });

  it('describes the setting without naming the addresses', () => {
    // The description goes in a boot log line. An internal subnet is topology,
    // and topology is reconnaissance.
    const description = describeTrustProxy(['10.0.0.0/8', '172.16.0.0/12']);
    expect(description).toBe('address list (2 entries)');
    expect(description).not.toContain('10.0.0.0');
    expect(describeTrustProxy(['loopback'])).toBe('address list (1 entry)');
    expect(describeTrustProxy(false)).toContain('no forwarding header is believed');
  });
});

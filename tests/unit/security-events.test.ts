import { describe, expect, it, vi } from 'vitest';
import { SecurityEventType, createLogger, createMemorySink } from '@edu/observability';
import type { SecurityEvent } from '@edu/observability';
import { createSecurityEventRecorder } from '../../apps/api/src/platform/security/security-events.ts';
import type { AuditWriter } from '../../apps/api/src/platform/audit.ts';

/**
 * The security event recorder, including repeated-denial escalation.
 *
 * Escalation is the piece worth testing carefully: it must fire once per window
 * (not on every denial past the threshold), reset when the window rolls over,
 * and never grow memory without bound.
 */
function harness(options?: { threshold?: number; windowMs?: number; maxTrackedActors?: number }) {
  const written: SecurityEvent[] = [];
  const audit: AuditWriter = { write: async (event) => void written.push(event) };
  const { sink, records } = createMemorySink();
  const recorder = createSecurityEventRecorder({
    audit,
    logger: createLogger({ level: 'debug', sink }),
    repeatedDenial: {
      threshold: options?.threshold ?? 5,
      windowMs: options?.windowMs ?? 60_000,
      maxTrackedActors: options?.maxTrackedActors ?? 10_000,
    },
    now: () => Date.now(),
  });
  return { recorder, written, records };
}

function denial(actorId: string | null, resourceId = 'r1'): SecurityEvent {
  return {
    type: SecurityEventType.AUTHZ_DENIED,
    actorId,
    correlationId: 'corr',
    ip: '127.0.0.1',
    detail: { action: 'note:read', resourceId },
    occurredAt: new Date(),
  };
}

describe('record', () => {
  it('persists the event to the audit writer', async () => {
    const { recorder, written } = harness();
    await recorder.record(denial('actor-1'));
    expect(written).toHaveLength(1);
    expect(written[0]?.type).toBe(SecurityEventType.AUTHZ_DENIED);
  });
});

describe('recordTransient', () => {
  it('writes to the log stream but NOT to the audit table', async () => {
    // Durable writes here would let anyone with a socket append rows to the
    // database for free.
    const { recorder, written, records } = harness();
    recorder.recordTransient({
      type: SecurityEventType.VALIDATION_REJECTED,
      actorId: null,
      correlationId: 'c',
      ip: '127.0.0.1',
      detail: {},
      occurredAt: new Date(),
    });
    expect(written).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]?.context['securityEvent']).toBe('validation.rejected');
  });
});

describe('repeated-denial escalation', () => {
  it('does not escalate below the threshold', async () => {
    const { recorder, written } = harness({ threshold: 5 });
    for (let i = 0; i < 4; i += 1) await recorder.record(denial('actor-1', `r${i}`));
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toEqual([]);
  });

  it('escalates once the threshold is reached', async () => {
    const { recorder, written } = harness({ threshold: 5 });
    for (let i = 0; i < 5; i += 1) await recorder.record(denial('actor-1', `r${i}`));
    const escalations = written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.actorId).toBe('actor-1');
    expect(escalations[0]?.detail['threshold']).toBe(5);
  });

  it('escalates only ONCE per window, however many more denials arrive', async () => {
    // Otherwise one noisy actor turns into unbounded audit writes — a
    // self-inflicted amplification.
    const { recorder, written } = harness({ threshold: 3 });
    for (let i = 0; i < 50; i += 1) await recorder.record(denial('actor-1', `r${i}`));
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toHaveLength(
      1,
    );
  });

  it('tracks actors independently', async () => {
    const { recorder, written } = harness({ threshold: 3 });
    for (let i = 0; i < 2; i += 1) await recorder.record(denial('actor-1', `r${i}`));
    for (let i = 0; i < 2; i += 1) await recorder.record(denial('actor-2', `r${i}`));
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toEqual([]);
  });

  it('starts a fresh window after the previous one expires', async () => {
    vi.useFakeTimers();
    try {
      const { recorder, written } = harness({ threshold: 3, windowMs: 1000 });
      for (let i = 0; i < 3; i += 1) await recorder.record(denial('actor-1', `r${i}`));
      vi.advanceTimersByTime(2000);
      for (let i = 0; i < 3; i += 1) await recorder.record(denial('actor-1', `s${i}`));
      expect(
        written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores denials with no actor (unauthenticated requests)', async () => {
    // Unauthenticated abuse is the rate limiter's job; this tracker keys on
    // actor identity and must not accumulate a null bucket.
    const { recorder, written } = harness({ threshold: 2 });
    for (let i = 0; i < 10; i += 1) await recorder.record(denial(null, `r${i}`));
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toEqual([]);
  });

  it('bounds memory when an attacker cycles identities', async () => {
    const { recorder, written } = harness({ threshold: 3, maxTrackedActors: 10 });
    // 200 distinct actors, one denial each: nothing escalates, and the tracker
    // must not retain all 200.
    for (let i = 0; i < 200; i += 1) await recorder.record(denial(`actor-${i}`));
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toEqual([]);
    // Behavioural proof the cap evicted: an early actor's counter was dropped,
    // so it takes a full threshold of NEW denials to escalate it.
    for (let i = 0; i < 2; i += 1) await recorder.record(denial('actor-0', `x${i}`));
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toEqual([]);
  });

  it('does not escalate on non-denial events', async () => {
    const { recorder, written } = harness({ threshold: 2 });
    for (let i = 0; i < 10; i += 1) {
      await recorder.record({
        type: SecurityEventType.AUTH_LOGIN_SUCCEEDED,
        actorId: 'actor-1',
        correlationId: 'c',
        ip: null,
        detail: {},
        occurredAt: new Date(),
      });
    }
    expect(written.filter((e) => e.type === SecurityEventType.AUTHZ_REPEATED_DENIAL)).toEqual([]);
  });
});

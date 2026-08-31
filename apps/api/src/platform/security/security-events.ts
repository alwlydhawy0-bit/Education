import { SecurityEventType, type Logger, type SecurityEvent } from '@edu/observability';
import type { AuditWriter } from '../audit.ts';

/**
 * The single way a domain records a security event.
 *
 * Before this existed, each module assembled a `SecurityEvent` literal by hand
 * and called the audit writer directly. That duplicated the shape, and left no
 * place to add cross-cutting behaviour — which is exactly what repeated-denial
 * detection needs.
 *
 * Two sinks, chosen per event:
 *
 *   `record`    — durable. Writes to `audit_log` AND the log stream. For events
 *                 an investigator must still be able to see next month:
 *                 authentication outcomes, authorization denials, throttling.
 *
 *   `recordTransient` — log stream only. For high-volume, low-value events
 *                 driven entirely by client behaviour (malformed requests). A
 *                 durable write here would let anyone with a socket append rows
 *                 to our database for free — audit-log flooding as a service.
 *                 They stay in the log stream, where retention is bounded and
 *                 volume is somebody else's problem.
 */
export interface SecurityEventRecorder {
  record(event: SecurityEvent): Promise<void>;
  recordTransient(event: SecurityEvent): void;
}

export interface RepeatedDenialOptions {
  /** Denials by one actor within the window before escalating. */
  readonly threshold: number;
  readonly windowMs: number;
  /**
   * Cap on tracked actors. Bounds memory: without it, an attacker cycling
   * identities would grow this map without limit.
   */
  readonly maxTrackedActors: number;
}

export const DEFAULT_REPEATED_DENIAL_OPTIONS: RepeatedDenialOptions = {
  threshold: 5,
  windowMs: 60_000,
  maxTrackedActors: 10_000,
};

export interface SecurityEventRecorderDeps {
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly repeatedDenial?: RepeatedDenialOptions;
  readonly now?: () => number;
}

interface DenialWindow {
  count: number;
  windowStartedAt: number;
  escalated: boolean;
}

/**
 * Repeated-denial detection.
 *
 * KNOWN LIMITATION — this is per-process and in-memory, exactly like the rate
 * limiter. Across N instances an attacker gets N times the threshold, and a
 * restart clears the state. It is a foundation for detection, not a SIEM, and
 * it is not a substitute for one. See docs/security/observability.md.
 */
export function createSecurityEventRecorder(
  deps: SecurityEventRecorderDeps,
): SecurityEventRecorder {
  const { audit, logger } = deps;
  const options = deps.repeatedDenial ?? DEFAULT_REPEATED_DENIAL_OPTIONS;
  const now = deps.now ?? (() => Date.now());

  const denials = new Map<string, DenialWindow>();

  function trackDenial(actorId: string): boolean {
    const currentTime = now();
    const existing = denials.get(actorId);

    if (!existing || currentTime - existing.windowStartedAt > options.windowMs) {
      // Evict before inserting so the map cannot exceed its cap. Map preserves
      // insertion order, so the oldest key is the first one.
      if (!existing && denials.size >= options.maxTrackedActors) {
        const oldest = denials.keys().next();
        if (!oldest.done) denials.delete(oldest.value);
      }
      denials.set(actorId, { count: 1, windowStartedAt: currentTime, escalated: false });
      return false;
    }

    existing.count += 1;
    // Escalate once per window, not on every denial past the threshold —
    // otherwise crossing it turns one noisy actor into unbounded audit writes.
    if (existing.count >= options.threshold && !existing.escalated) {
      existing.escalated = true;
      return true;
    }
    return false;
  }

  function toLogContext(event: SecurityEvent): Record<string, unknown> {
    return {
      securityEvent: event.type,
      actorId: event.actorId,
      correlationId: event.correlationId,
      ip: event.ip,
      detail: event.detail,
    };
  }

  return {
    async record(event) {
      await audit.write(event);

      if (event.type === SecurityEventType.AUTHZ_DENIED && event.actorId !== null) {
        if (trackDenial(event.actorId)) {
          await audit.write({
            type: SecurityEventType.AUTHZ_REPEATED_DENIAL,
            actorId: event.actorId,
            correlationId: event.correlationId,
            ip: event.ip,
            detail: {
              threshold: options.threshold,
              windowMs: options.windowMs,
              // The triggering action only. Not the ids probed — the individual
              // AUTHZ_DENIED rows already carry those, and duplicating them here
              // would multiply retained identifiers for no benefit.
              action: event.detail['action'] ?? null,
            },
            occurredAt: event.occurredAt,
          });
        }
      }
    },

    recordTransient(event) {
      logger.info('security event (transient)', toLogContext(event));
    },
  };
}

import type { SecurityEvent } from '@edu/observability';
import type { Logger } from '@edu/observability';
import type { Database } from './db.js';

/**
 * Writes security events to the durable audit table and to the log stream.
 *
 * Failure policy: an audit write failure is logged at error level but does NOT
 * fail the request. That is a deliberate availability-over-completeness choice
 * for THIS class of event (authentication and authorization outcomes), because
 * the alternative — a database hiccup logging users out of the platform — is
 * worse for a school. It is the wrong policy for future financial or
 * grade-mutation events, which should fail closed; when those arrive they need
 * a separate writer with `mustPersist` semantics.
 *
 * This is recorded in docs/security/observability.md as a known limitation.
 */
export interface AuditWriter {
  write(event: SecurityEvent): Promise<void>;
}

export function createAuditWriter(db: Database, logger: Logger): AuditWriter {
  return {
    async write(event) {
      logger.info('security event', {
        securityEvent: event.type,
        actorId: event.actorId,
        correlationId: event.correlationId,
        ip: event.ip,
        detail: event.detail,
      });

      try {
        // `edu_app` holds INSERT and nothing else on this table (migration
        // 0004), so this cannot read or amend existing entries.
        await db.withoutActor((tx) =>
          tx.query(
            `INSERT INTO audit_log (event_type, actor_id, correlation_id, ip, detail, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              event.type,
              event.actorId,
              event.correlationId,
              event.ip,
              JSON.stringify(event.detail),
              event.occurredAt,
            ],
          ),
        );
      } catch (error) {
        logger.error('AUDIT WRITE FAILED — event recorded in logs only', {
          securityEvent: event.type,
          correlationId: event.correlationId,
          error,
        });
      }
    },
  };
}

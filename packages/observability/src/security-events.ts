/**
 * Security event taxonomy.
 *
 * These are distinct from application logs: they are the events a security
 * reviewer or an automated detection rule cares about, and they are written to
 * a durable audit table (see the `audit_log` table in the migrations) as well as
 * to the log stream.
 *
 * A closed enum rather than free-form strings, so that detection rules cannot
 * silently stop matching because someone reworded a log message.
 */
export const SecurityEventType = {
  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_SESSION_REJECTED: 'auth.session.rejected',
  AUTH_REGISTERED: 'auth.registered',
  AUTH_REGISTER_FAILED: 'auth.register.failed',

  /** A refresh token was exchanged for a new pair. Routine, but worth counting. */
  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',

  /**
   * A refresh token was presented AFTER it had already been rotated.
   *
   * This is the platform's strongest single indicator of a stolen credential:
   * the legitimate client rotates on use, so a second presentation means someone
   * else holds a copy. The whole session family is revoked in response.
   */
  AUTH_REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',

  AUTH_EMAIL_VERIFIED: 'auth.email.verified',

  /** Repeated failures locked an account. Also revokes its live sessions. */
  ACCOUNT_LOCKED: 'account.locked',

  PASSWORD_RESET_REQUESTED: 'password.reset.requested',
  PASSWORD_RESET_SUCCEEDED: 'password.reset.succeeded',
  PASSWORD_RESET_FAILED: 'password.reset.failed',

  /**
   * Role grants and revocations. Privilege changes are the events an
   * investigator reaches for first after a suspected compromise, so they are
   * recorded with the actor who made the change, not just the affected user.
   */
  ROLE_GRANTED: 'role.granted',
  ROLE_REVOKED: 'role.revoked',

  /** An operator changed an account's status. */
  USER_STATUS_CHANGED: 'user.status_changed',

  /**
   * Emitted on every authorization denial. A burst of these from one actor
   * across many resource ids is the primary IDOR/BOLA probing signal.
   */
  AUTHZ_DENIED: 'authz.denied',

  /**
   * Escalation of AUTHZ_DENIED: one actor has been denied repeatedly inside a
   * short window. A single denial is noise; a run of them across different
   * object ids is the shape of enumeration.
   */
  AUTHZ_REPEATED_DENIAL: 'authz.repeated_denial',

  RATE_LIMIT_EXCEEDED: 'ratelimit.exceeded',
  VALIDATION_REJECTED: 'validation.rejected',
  PAYLOAD_TOO_LARGE: 'payload.too_large',

  /**
   * Emitted at startup when the running security posture deviates from the safe
   * defaults (rate limiting off, insecure cookies, debug logging). The
   * configuration loader refuses these outright in production and staging, so
   * this records the deviations that ARE permitted elsewhere.
   */
  SECURITY_CONFIG_DEVIATION: 'security.config_deviation',
} as const;

/**
 * Event types that are DELIBERATELY NOT DECLARED yet, because nothing would
 * emit them.
 *
 * Task 001 declared `ratelimit.exceeded` and never emitted it, so the taxonomy
 * advertised a detection capability the system did not have. To stop that
 * recurring, `tests/architecture/security-events.test.ts` asserts that every
 * member of `SecurityEventType` has a real emitter in the API source. Adding a
 * type here instead of there is the honest way to record future intent:
 *
 *   - `admin.action`           — no administrative endpoints exist.
 *   - `file.activity.unusual`  — no file storage exists.
 *   - `moderation.action`      — no moderation exists.
 *
 * Move one into `SecurityEventType` in the same change that adds its emitter.
 */
export const RESERVED_SECURITY_EVENT_TYPES = [
  'file.activity.unusual',
  'moderation.action',
] as const;

export type SecurityEventType = (typeof SecurityEventType)[keyof typeof SecurityEventType];

export interface SecurityEvent {
  readonly type: SecurityEventType;
  /** Null when the request was unauthenticated. */
  readonly actorId: string | null;
  readonly correlationId: string;
  readonly ip: string | null;
  /**
   * Non-sensitive structured detail. Must never contain user content,
   * credentials, or tokens — it passes through the same redaction as logs, but
   * callers are expected not to put content here in the first place.
   */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

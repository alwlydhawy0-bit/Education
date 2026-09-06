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
   * Structural changes to organizations and classes.
   *
   * These are recorded because the class graph IS the authorization graph:
   * teacher-to-student access is derived from shared class membership, so a
   * roster change silently changes who can read a child's shared work. An
   * investigator asking "why could this teacher see that?" needs the history.
   */
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  CLASS_CREATED: 'class.created',
  CLASS_UPDATED: 'class.updated',
  CLASS_ARCHIVED: 'class.archived',
  CLASS_MEMBER_ADDED: 'class.member_added',
  CLASS_MEMBER_REMOVED: 'class.member_removed',
  TEACHER_ASSIGNED: 'class.teacher_assigned',
  TEACHER_UNASSIGNED: 'class.teacher_unassigned',

  /**
   * Guardian-link lifecycle. Verification is the moment a claim becomes access
   * to a minor's work, so it is the single most consequential event here.
   */
  GUARDIAN_LINK_CREATED: 'guardian_link.created',
  GUARDIAN_LINK_VERIFIED: 'guardian_link.verified',
  GUARDIAN_LINK_REVOKED: 'guardian_link.revoked',

  /**
   * Course-to-class assignment.
   *
   * This edge decides which learners a piece of published content reaches, so
   * it belongs in the same category as a roster change rather than in a
   * scheduling log: assigning a course widens what a class can see, and
   * withdrawing one revokes it instantly. "Why could that student read this
   * lesson?" has to be answerable from the audit trail alone.
   */
  COURSE_ASSIGNED_TO_CLASS: 'class.course_assigned',
  COURSE_WITHDRAWN_FROM_CLASS: 'class.course_withdrawn',

  /**
   * Educational content lifecycle.
   *
   * PUBLISHING is the event that matters here: it is the moment material
   * becomes visible to learners, and it is held behind a permission that
   * authoring does not confer. "Who made this visible to children, and when?"
   * has to be answerable from the audit trail alone.
   *
   * Deletion is recorded too, and is only ever possible for never-published
   * drafts — so an absent CONTENT_DELETED for something learners saw is itself
   * evidence that the archive path was used, as intended.
   */
  CONTENT_CREATED: 'content.created',
  CONTENT_UPDATED: 'content.updated',
  CONTENT_PUBLISHED: 'content.published',
  CONTENT_ARCHIVED: 'content.archived',
  CONTENT_DELETED: 'content.deleted',

  /**
   * A write was refused by the content lifecycle rules (Task 011).
   *
   * Distinct from `authz.denied`, which records that an actor had no standing.
   * This records that an actor WITH standing tried to do something the content's
   * STATE forbids: reword a published objective, add one to a closed lesson,
   * publish beneath a draft parent, archive over live children.
   *
   * Worth its own type because the two mean different things operationally. A
   * burst of `authz.denied` from one actor is probing. A burst of these is more
   * often an author fighting a rule they do not understand — a documentation
   * problem — but a burst aimed at PUBLISHED assessment content is the shape of
   * somebody testing whether an answer key can still be moved, which is why it
   * is recorded rather than left as a 409 in an access log.
   *
   * Carries the resource kind, its id, and the database's reason. Never the
   * content: not a statement, not a prompt, and above all not a key.
   */
  CONTENT_LIFECYCLE_REFUSED: 'content.lifecycle_refused',

  /**
   * A write refused because the caller's optimistic-concurrency token was stale.
   *
   * Distinct from `CONTENT_LIFECYCLE_REFUSED`, which means the transition itself
   * was illegal. This one means the transition might well have been legal — and
   * was refused because the caller was describing a version of the row that no
   * longer exists, so applying it would have silently destroyed somebody's work.
   *
   * Ordinarily benign: two authors in the same lesson. Worth recording anyway,
   * because a stream of them against one lesson id from one session is what a
   * replayed captured request looks like.
   *
   * Carries the resource kind and id only. Never who won the race — the caller
   * whose write lost is not entitled to learn that another actor exists.
   */
  CONTENT_STALE_WRITE_REFUSED: 'content.stale_write_refused',
  CONTENT_REORDERED: 'content.reordered',
  EDUCATION_LEVEL_CHANGED: 'content.education_level_changed',

  /**
   * Assessment attempts.
   *
   * An attempt is the moment the platform starts measuring a child, so the
   * lifecycle is recorded for the same reason a roster change is: "why does
   * this mark exist, and who was watching?" has to be answerable from the audit
   * trail alone.
   *
   * ATTEMPT_LIMIT_EXCEEDED is separate from a plain `authz.denied` because it
   * means something different. A denial says an actor reached for something
   * they may not have; this says a learner is repeatedly re-attempting one
   * assessment, which — on an assessment scored by exact answer match — is the
   * shape of probing for the key rather than of studying.
   *
   * SUSPICIOUS_SUBMISSION is emitted for a payload NO INTERFACE CAN PRODUCE: a
   * question belonging to another assessment, an option belonging to another
   * question, or more selections than the question type permits. Each of those
   * is refused by the database regardless; the event exists because the person
   * sending them is doing something a learner sitting a test cannot do by
   * accident.
   *
   * Deliberately NOT declared: an event per submission denial. `authz.denied`
   * already carries those, and a second path to the same fact would split the
   * detection rule that reads them (section 24 of the task, and the reason
   * `RESERVED_SECURITY_EVENT_TYPES` exists at all).
   */
  ASSESSMENT_ATTEMPT_STARTED: 'assessment.attempt_started',
  ASSESSMENT_SUBMITTED: 'assessment.submitted',
  ASSESSMENT_ATTEMPT_LIMIT_EXCEEDED: 'assessment.attempt_limit_exceeded',
  ASSESSMENT_SUSPICIOUS_SUBMISSION: 'assessment.suspicious_submission',

  /**
   * A result was released to the learner (Task 009).
   *
   * Distinct from `assessment.submitted`, which records that a paper was
   * scored. This records the separate DECISION that a child may see that
   * score — an act with a named human behind it, taken over somebody else's
   * data. "Who decided this learner could see their mark, and when?" has to be
   * answerable from the audit trail alone, in the same way "who published this
   * lesson?" is.
   *
   * Carries the attempt, the assessment, the learner and whether a comment was
   * left. Never the score, never the comment's text, never any part of the
   * paper — the audit trail is more widely readable than the result is.
   */
  ASSESSMENT_RESULT_RELEASED: 'assessment.result_released',

  /**
   * Interactive labs (Task 009).
   *
   * LAB_SESSION_STARTED and LAB_SUBMITTED mirror their assessment
   * counterparts, and for the same reason: a lab session is a record about a
   * child that a school will act on, so "when did this child run this lab, and
   * when did they hand it in?" has to be answerable from the audit trail alone.
   * Neither carries the state the learner built, and neither carries the
   * verdict — the trail is more widely readable than the work is.
   *
   * LAB_STATE_WRITE_REFUSED is the one that is not a mirror. It records a write
   * the POLICY allowed and Row Level Security then matched zero rows for, which
   * means the learner lost the lesson in the interval between the two — a class
   * ended, a course was withdrawn, a lab was archived mid-session. It is
   * expected, it is not an error, and it is worth counting: a burst of them
   * across many learners is a roster change nobody warned the teachers about,
   * and a burst from ONE actor across many sessions is somebody replaying a
   * session id they no longer hold.
   *
   * Deliberately NOT declared: an event per lab denial. `authz.denied` already
   * carries those, and a second path to the same fact would split the detection
   * rule that reads them.
   */
  LAB_SESSION_STARTED: 'lab.session_started',
  LAB_SUBMITTED: 'lab.submitted',
  LAB_STATE_WRITE_REFUSED: 'lab.state_write_refused',

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
   * The learning assistant refused to retrieve for a lesson (Task 013).
   *
   * The AI equivalent of `authz.denied`, and separate from it because the
   * question an investigator asks is different. A run of `authz.denied` is
   * somebody probing the API; a run of THESE is somebody probing the assistant
   * — trying lesson ids to find one whose material the model will summarise for
   * them. That is a retrieval-layer IDOR attempt and it deserves its own name.
   *
   * Carries the lesson id and one flat reason. Never the question, never any
   * retrieved text, and never which of "absent", "another school's", "another
   * class's", "draft" or "archived" applied — the caller is not told, so the
   * audit trail does not become the oracle the response refuses to be.
   */
  AI_RETRIEVAL_REFUSED: 'ai.retrieval_refused',

  /**
   * A provider call failed (Task 013).
   *
   * Carries the provider name and which of the four normalized failure kinds it
   * was. NOT the provider's own error text, which is vendor-shaped and can echo
   * fragments of the request — including the learner's question.
   */
  AI_PROVIDER_FAILED: 'ai.provider_failed',

  /**
   * A provider cited sources it was never given (Task 013).
   *
   * The citation is dropped before the answer leaves the server, so this is not
   * a breach — it is the sound of the control working. Recorded because a
   * provider inventing references is either malfunctioning or being steered by
   * injected text, and an operator should be able to see which model started
   * doing it and when.
   *
   * Carries a COUNT. The invented ids are model output and are not stored.
   */
  AI_CITATION_REJECTED: 'ai.citation_rejected',

  /**
   * The provider answered, and the answer was thrown away.
   *
   * ADDED IN TASK 014, and distinct from `ai.provider_failed` on purpose. A
   * failure means the provider did not answer — an outage, a timeout, a quota.
   * THIS means it answered with something the server refused to use: output
   * that did not match the schema, an answer past the size tripwire, absurd
   * citation counts, a request the API rejected as malformed.
   *
   * Worth separating because the two have different causes and different
   * responses. A run of failures is an incident with the vendor; a run of
   * REJECTIONS is a model change, a bad model identifier, a stale request
   * shape, or something sitting in the middle of the connection rewriting
   * responses — and none of those look like an outage.
   *
   * Carries the provider name and the failure KIND. Never the response body,
   * never the vendor's error text, never a fragment of the request.
   */
  AI_OUTPUT_REJECTED: 'ai.output_rejected',

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

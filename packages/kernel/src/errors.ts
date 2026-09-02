/**
 * Stable, machine-readable error codes.
 *
 * These are part of the public API contract: clients branch on `code`, never on
 * `message`. Messages may be localized or reworded; codes may not change
 * meaning without an API version bump.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Safe to return to the client. Never put internal detail here. */
  readonly publicDetail: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    message: string,
    publicDetail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.publicDetail = publicDetail;
  }
}

export const unauthenticated = (message = 'Authentication required'): AppError =>
  new AppError(ErrorCode.UNAUTHENTICATED, 401, message);

export const forbidden = (message = 'Forbidden'): AppError =>
  new AppError(ErrorCode.FORBIDDEN, 403, message);

/**
 * Used for BOTH "resource does not exist" and "resource exists but the actor
 * may not know that it exists".
 *
 * Returning 403 for the second case turns the API into an existence oracle: an
 * attacker enumerating identifiers can distinguish real resources from unreal
 * ones. See docs/security/authorization.md ("Existence disclosure").
 */
export const notFound = (message = 'Not found'): AppError =>
  new AppError(ErrorCode.NOT_FOUND, 404, message);

/**
 * A well-formed request that the CURRENT STATE refuses.
 *
 * `detail` exists so a client can branch on WHICH conflict without parsing the
 * message. Two are distinguishable and must be, because the remedy differs: a
 * lifecycle refusal ("archive the published lessons first") is fixed by acting
 * on other content, while a stale write ("someone saved after you loaded") is
 * fixed by reloading and re-applying. See `ConflictReason`.
 */
export const ConflictReason = {
  /** The optimistic-concurrency token did not match the stored row. */
  STALE_WRITE: 'stale_write',
  /** A content-lifecycle rule refused the transition. */
  LIFECYCLE: 'lifecycle',
} as const;

export type ConflictReason = (typeof ConflictReason)[keyof typeof ConflictReason];

export const conflict = (
  message = 'Conflict',
  detail?: Readonly<Record<string, unknown>>,
): AppError => new AppError(ErrorCode.CONFLICT, 409, message, detail);

export const validationFailed = (
  message = 'Validation failed',
  detail?: Readonly<Record<string, unknown>>,
): AppError => new AppError(ErrorCode.VALIDATION_FAILED, 400, message, detail);

export const rateLimited = (message = 'Too many requests'): AppError =>
  new AppError(ErrorCode.RATE_LIMITED, 429, message);

export const internal = (message = 'Internal error'): AppError =>
  new AppError(ErrorCode.INTERNAL, 500, message);

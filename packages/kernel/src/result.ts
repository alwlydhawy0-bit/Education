/**
 * A `Result` makes failure part of a function's type instead of a side channel.
 *
 * Security rationale: authorization and validation failures must be impossible
 * to ignore accidentally. A thrown exception can be swallowed by a broad
 * `catch`; an unhandled `Result` is a type error.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

/** Unwrap, or throw. Only for call sites that have already proven success. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`Called unwrap() on an error Result: ${JSON.stringify(r.error)}`);
}

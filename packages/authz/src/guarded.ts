import type { Decision } from './decision.js';
import type { Action, Resource } from './types.js';

/**
 * Raised when code tries to read a protected payload without a matching
 * allow-decision. This is a programming error, not a user error: reaching it
 * means an authorization check was skipped or mismatched.
 */
export class AuthorizationNotEvaluatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationNotEvaluatedError';
  }
}

/**
 * A protected payload that cannot be read without presenting an allow-decision
 * for that exact object.
 *
 * This is the platform's structural answer to IDOR/BOLA. Repositories that load
 * a protected record return `Guarded<T>` rather than `T`, so "fetch by id and
 * return it" does not compile into something usable. The caller must run the
 * policy engine and hand the resulting decision to `unwrap`.
 *
 * `unwrap` re-checks three things, because a decision object on its own proves
 * nothing about WHICH object it was made for:
 *   1. the decision allows,
 *   2. it was made for this resource id,
 *   3. it was made for the action the caller claims to be performing.
 *
 * Check (2) is the one that actually stops IDOR: without it, a handler could
 * authorize the actor's own note and then return somebody else's row.
 *
 * This is a defence-in-depth control, not a proof. It cannot stop code that
 * never wraps a record in the first place; the architecture fitness test
 * `tests/architecture/repository-guard.test.ts` covers that gap by asserting
 * protected repositories declare `Guarded<...>` return types.
 */
export class Guarded<T> {
  readonly #value: T;
  readonly #resource: Resource;

  private constructor(value: T, resource: Resource) {
    this.#value = value;
    this.#resource = resource;
  }

  static of<T>(value: T, resource: Resource): Guarded<T> {
    return new Guarded(value, resource);
  }

  /**
   * The authorization-relevant attributes only. Safe to read without a
   * decision: this is exactly what the policy engine needs as input, and it
   * carries no user content.
   */
  get resource(): Resource {
    return this.#resource;
  }

  unwrap(decision: Decision, action: Action): T {
    if (decision.effect !== 'allow') {
      throw new AuthorizationNotEvaluatedError(
        `Refused to unwrap ${this.#resource.kind}:${this.#resource.id} — decision was deny (${decision.reason}).`,
      );
    }
    if (decision.resourceId !== this.#resource.id) {
      throw new AuthorizationNotEvaluatedError(
        `Decision/resource mismatch: decision authorized "${decision.resourceId}" but the payload is "${this.#resource.id}". ` +
          'This is the signature of an IDOR bug — a check was performed against a different object than the one being returned.',
      );
    }
    if (decision.action !== action) {
      throw new AuthorizationNotEvaluatedError(
        `Decision/action mismatch: decision authorized "${decision.action}" but the caller is performing "${action}".`,
      );
    }
    return this.#value;
  }

  /** Map the payload while keeping it guarded (e.g. to a response DTO). */
  map<U>(fn: (value: T) => U): Guarded<U> {
    return new Guarded(fn(this.#value), this.#resource);
  }
}

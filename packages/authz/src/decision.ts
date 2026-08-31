import type { Action } from './types.ts';

/**
 * The outcome of one authorization evaluation.
 *
 * `disclosure` exists to keep authorization failures from becoming an
 * enumeration oracle. When a policy denies because the actor may not even learn
 * that the object exists, it sets `disclosure: 'hide'` and the HTTP layer
 * translates that into 404 rather than 403.
 */
export type Disclosure = 'hide' | 'reveal';

export interface AllowDecision {
  readonly effect: 'allow';
  readonly action: Action;
  readonly resourceId: string;
  /** Human-readable rule name. Logged for audit; never shown to the client. */
  readonly reason: string;
}

export interface DenyDecision {
  readonly effect: 'deny';
  readonly action: Action;
  readonly resourceId: string;
  readonly reason: string;
  readonly disclosure: Disclosure;
}

export type Decision = AllowDecision | DenyDecision;

export const allow = (action: Action, resourceId: string, reason: string): AllowDecision => ({
  effect: 'allow',
  action,
  resourceId,
  reason,
});

export const deny = (
  action: Action,
  resourceId: string,
  reason: string,
  disclosure: Disclosure = 'hide',
): DenyDecision => ({ effect: 'deny', action, resourceId, reason, disclosure });

export const isAllow = (d: Decision): d is AllowDecision => d.effect === 'allow';
export const isDeny = (d: Decision): d is DenyDecision => d.effect === 'deny';

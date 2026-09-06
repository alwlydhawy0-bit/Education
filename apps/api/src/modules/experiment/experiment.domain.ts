import { RULE_PATH_PATTERN, type StatePayload, type ValidationRule } from '@edu/contracts';

/**
 * The pure parts of the lab domain.
 *
 * WHAT IS NOT HERE: any function that decides whether a state satisfies a lab.
 * That lives in SQL and nowhere else, because marking needs the validation
 * rules and the rules must never enter application memory for a learner's
 * request. A TypeScript evaluator would be a second implementation of the same
 * decision — and the moment the two disagreed, the one a learner could reach
 * would be the one that mattered.
 */

/**
 * How deep a client-supplied payload may nest.
 *
 * A rule path reaches at most eight segments, so nothing DEEPER than that can
 * ever be read by a rule; anything below the limit is dead weight a client is
 * asking the database to store and every reader to parse. The byte ceiling does
 * not catch this on its own — `{"a":{"a":{"a":…}}}` is small and deep, and deep
 * is what costs a recursive JSON serializer.
 */
export const MAX_STATE_DEPTH = 12;

/**
 * How many keys and array entries a payload may hold in total.
 *
 * Also not caught by the byte ceiling: 256 KiB of `{"a":1,"b":1,…}` is a lot of
 * nodes, and node count is what a JSON parse and a jsonb build actually cost.
 */
export const MAX_STATE_NODES = 20_000;

export interface PayloadRejection {
  readonly reason: 'too_deep' | 'too_many_nodes' | 'not_an_object';
  readonly limit: number;
}

/**
 * Structural bounds on a state payload, checked before it reaches the database.
 *
 * This does not attempt to understand the payload — a lab's state is whatever
 * that simulation needs, and the server deliberately has no opinion about a
 * circuit. It bounds the SHAPE, which is the part that costs the platform
 * rather than the part that means something to the learner.
 */
export function checkStatePayload(value: unknown): PayloadRejection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { reason: 'not_an_object', limit: 0 };
  }

  let nodes = 0;
  // An explicit stack rather than recursion: the input is attacker-shaped, and
  // a recursive walk would answer "too deep" with a stack overflow — which is a
  // 500, not a 400.
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    const { node, depth } = entry;
    if (depth > MAX_STATE_DEPTH) return { reason: 'too_deep', limit: MAX_STATE_DEPTH };
    if (node === null || typeof node !== 'object') continue;

    const children = Array.isArray(node) ? node : Object.values(node);
    nodes += children.length;
    if (nodes > MAX_STATE_NODES) return { reason: 'too_many_nodes', limit: MAX_STATE_NODES };
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }

  return null;
}

/**
 * Serializes the rules into the `{"rules": [...]}` envelope the SQL evaluator
 * reads.
 *
 * The envelope exists so the column can grow a sibling key later — a version,
 * a description — without every stored row having to be rewritten. The
 * evaluator already tolerates its absence: `jsonb_typeof(rules -> 'rules')`
 * that is not `array` is treated as an empty rule list rather than as an error.
 */
export function toRulesEnvelope(rules: readonly ValidationRule[]): { rules: ValidationRule[] } {
  return { rules: [...rules] };
}

/**
 * Reads the envelope back, discarding anything that is not a rule this platform
 * recognises.
 *
 * TOTAL, like its SQL counterpart. A rules row written by an older version, or
 * by hand, must not make an author's page fail to load — the worst a
 * malformed rule can do here is not appear, which is the same thing the
 * evaluator does with it.
 */
export function fromRulesEnvelope(stored: unknown): ValidationRule[] {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return [];
  const list = (stored as { rules?: unknown }).rules;
  if (!Array.isArray(list)) return [];
  return list.filter(isRecognisableRule);
}

function isRecognisableRule(candidate: unknown): candidate is ValidationRule {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const rule = candidate as { path?: unknown; op?: unknown };
  return (
    typeof rule.path === 'string' &&
    RULE_PATH_PATTERN.test(rule.path) &&
    typeof rule.op === 'string'
  );
}

/** Narrowing helper so the repository never hands a non-object to `jsonb`. */
export function asStatePayload(value: unknown): StatePayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as StatePayload)
    : {};
}

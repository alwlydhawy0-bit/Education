/**
 * Model identifiers the platform may be pointed at.
 *
 * INSIDE `platform/ai/` because a model identifier is vendor knowledge, and the
 * architecture rule says vendor knowledge lives here. It is a separate module
 * from the adapter for one reason: `config.ts` needs the allowlist to validate
 * an environment variable at boot, and importing it from the adapter would drag
 * the vendor SDK into the process on every startup — including the startups
 * where `AI_PROVIDER=none` and no vendor is involved at all.
 *
 * AN ALLOWLIST, NOT A FREE STRING. A model identifier reaches a paid API: a
 * typo becomes a failed request in front of a child, and an arbitrary value
 * becomes whatever an operator typed. Validating it at boot turns both into a
 * startup failure, which is the only place a configuration mistake is cheap.
 *
 * The default is the most capable model rather than the cheapest. Choosing a
 * weaker model to save money is a decision for whoever pays for it, taken
 * deliberately by setting this variable — not one made quietly here.
 */
export const ALLOWED_AI_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

export type AllowedAiModel = (typeof ALLOWED_AI_MODELS)[number];

export const DEFAULT_AI_MODEL: AllowedAiModel = 'claude-opus-5';

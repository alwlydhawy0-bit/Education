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

/**
 * Where provider requests are sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS PINNED AND NOT LEFT TO THE SDK (VULN-038)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The vendor SDK defaults its base URL to `process.env.ANTHROPIC_BASE_URL`.
 * Task 014's adapter only passed a base URL when one was handed to it, and
 * nothing ever handed it one — so the destination of every request was decided
 * by an ambient environment variable that no part of this application read,
 * validated, or logged.
 *
 * That is a data-exfiltration path, not a configuration nicety. Those requests
 * carry the platform's credential in an `x-api-key` header and authorized
 * curriculum passages in the body. Anything able to set an environment
 * variable — a compromised base image, a careless deployment template, a
 * developer's shell — could silently redirect all of it to a host of its
 * choosing, and every response would still look completely normal.
 *
 * Found by probing the running adapter with an ambient value set, during the
 * pre-flight checks for the first live call. The adapter now ALWAYS passes an
 * explicit base URL, so the ambient variable can never take effect.
 */
export const DEFAULT_AI_BASE_URL = 'https://api.anthropic.com';

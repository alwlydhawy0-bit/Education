/**
 * Log redaction.
 *
 * The platform logs a lot (it must, for audit), and it handles minors' data. So
 * redaction is applied CENTRALLY and by default, rather than relying on every
 * call site to remember. The logger has no method that bypasses this.
 *
 * Two rules:
 *   1. Deny-list by key name, matched case-insensitively on a normalized key,
 *      so `apiKey`, `api_key`, `API-KEY` and `x-api-key` all collapse to the
 *      same check.
 *   2. Value-shape detection for things that look like credentials even under
 *      an innocent key name (bearer tokens, PEM blocks, long base64url blobs
 *      that match our session-token shape).
 *
 * Known limitation, stated plainly: this cannot catch a secret embedded in
 * arbitrary free text (for example a password pasted inside a note body). The
 * mitigation for that is not logging user content at all — see
 * `docs/security/observability.md`.
 */

const REDACTED = '[REDACTED]';

/** Normalizes `x-api-key`, `api_key`, `apiKey` -> `apikey`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    'password',
    'newpassword',
    'currentpassword',
    'passwordhash',
    'passwordconfirmation',
    'token',
    'accesstoken',
    'refreshtoken',
    'sessiontoken',
    'sessionsecret',
    'idtoken',
    'apikey',
    'apisecret',
    'secret',
    'clientsecret',
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'privatekey',
    'credentials',
    'otp',
    'mfacode',
    'totp',
    'recoverycode',
    'creditcard',
    'cardnumber',
    'cvv',
    'ssn',
    'nationalid',
    // Student content is private by default. If a field named like this ever
    // reaches the logger it is a mistake, so redact rather than emit.
    'notebody',
    'noteconctent',
    'notecontent',
  ].map(normalizeKey),
);

const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const PEM_RE = /-----BEGIN[\s\S]*?-----END[^-]*-----/g;
/** Matches the shape of our own opaque session tokens (43+ base64url chars). */
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{43,}\b/g;

export function redactString(value: string): string {
  return value
    .replace(PEM_RE, REDACTED)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(LONG_TOKEN_RE, REDACTED);
}

export interface RedactOptions {
  /** Guards against cyclic or pathologically deep structures. */
  readonly maxDepth: number;
}

const DEFAULT_OPTIONS: RedactOptions = { maxDepth: 8 };

export function redact(value: unknown, options: RedactOptions = DEFAULT_OPTIONS): unknown {
  return redactAt(value, 0, options, new WeakSet());
}

function redactAt(
  value: unknown,
  depth: number,
  options: RedactOptions,
  seen: WeakSet<object>,
): unknown {
  if (depth > options.maxDepth) return '[TRUNCATED]';

  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  // A cycle would otherwise hang the logger — a trivially triggerable DoS if any
  // request-scoped object ever gets logged.
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactAt(item, depth + 1, options, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return '[UNSERIALIZABLE]';

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(normalizeKey(key))
      ? REDACTED
      : redactAt(item, depth + 1, options, seen);
  }
  return out;
}

export { REDACTED };

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque session tokens.
 *
 * Chosen over JWTs deliberately. A JWT is a bearer credential the server cannot
 * revoke before it expires; for a platform serving minors, immediate revocation
 * (a compromised account, a guardian request, a moderator action) matters more
 * than saving a database lookup. See docs/architecture/adr/0005-sessions.md.
 *
 * 32 bytes from the CSPRNG, base64url-encoded. Only the SHA-256 of the token is
 * stored, so a database disclosure yields no usable credential. SHA-256 is
 * correct here — unlike a password, the token is high-entropy, so there is
 * nothing for an attacker to brute-force and no need for a slow KDF.
 */

export const SESSION_TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Constant-time comparison, for any place a secret is compared directly. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

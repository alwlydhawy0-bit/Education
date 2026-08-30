import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing — Argon2id.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's Argon2id baseline:
 * 19 MiB of memory, 2 iterations, parallelism 1. Memory cost is what makes GPU
 * and ASIC cracking expensive, so it is the parameter to raise over time — not
 * the iteration count.
 *
 * These are pinned explicitly rather than left to the library's defaults so
 * that a dependency upgrade cannot silently weaken (or unexpectedly slow) the
 * hash. Changing them requires a deliberate edit here and a rehash-on-login
 * migration path.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a password. Returns false rather than throwing on a malformed stored
 * hash, so that a corrupted row is a failed login and not a 500 that leaks the
 * fact that the account exists.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A hash of a fixed dummy password, used to equalize the cost of a login
 * against a NON-EXISTENT account with one against a real account.
 *
 * Without this, "no such user" returns in microseconds while a real user costs
 * ~50ms of Argon2 — a timing oracle that lets an attacker enumerate which email
 * addresses have accounts on a platform used by children.
 */
let dummyHashPromise: Promise<string> | null = null;

export function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('a-fixed-string-that-is-never-a-real-password');
  return dummyHashPromise;
}

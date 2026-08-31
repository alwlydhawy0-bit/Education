# ADR 0005 — Opaque server-side sessions, not JWTs

**Status:** Accepted · **Date:** 2026-08-30 · **Reaffirmed and extended:** 2026-08-31 (Task 003)

## Context

The platform serves minors. Revocation scenarios are routine, not exceptional: a
compromised account, a guardian request, a moderator action, a device handed to
someone else.

## Decision

Opaque 32-byte CSPRNG tokens in an `HttpOnly; Secure; SameSite=Strict` cookie.
Only the SHA-256 of the token is stored. Expiry and revocation are evaluated in
SQL inside `auth_resolve_session`.

## Rationale

A JWT cannot be revoked before it expires without a server-side blocklist — at
which point the database lookup it was meant to avoid is back, plus the
complexity. For this platform, immediate revocation outweighs saving one indexed
lookup per request.

Storing only the hash means a database disclosure yields no usable credential.
SHA-256 (not Argon2) is correct here: the token is high-entropy, so there is
nothing to brute-force and no reason to pay a slow KDF on every request.

Putting expiry in SQL means application code _cannot_ accidentally accept an
expired session — an expired session simply produces no row.

## Consequences

- One indexed database lookup per authenticated request.
- Sessions are shared state, so the API stays stateless and horizontally
  scalable without sticky sessions.
- Cookies mean CSRF must be handled: `SameSite=Strict` plus an `Origin`
  allow-list that rejects a _missing_ Origin.
- Non-browser API clients will need a separate token mechanism. Not built.

---

## Amendment (Task 003) — refresh tokens, and the JWT question

Task 003 specified _"JWT access tokens (short-lived); refresh tokens
(rotatable)"_ alongside _"session revocation (logout all devices)"_. Those two
requirements are in tension: a JWT cannot be revoked before it expires without a
server-side blocklist, at which point the database lookup JWTs exist to avoid is
back, plus key management and rotation.

**The conflict was raised rather than resolved silently, and the decision was to
keep opaque sessions and add the refresh mechanism on top.** For a platform whose
users are children, immediate revocation — a compromised account, a guardian
request, a moderator action, a device handed to someone else — outweighs saving
one indexed lookup per request.

What was added:

- **A refresh token per session**, long-lived, stored only as SHA-256, rotated on
  every use.
- **Reuse detection.** A refresh token is single use. Presenting one that has
  already been rotated means the legitimate client rotated it, so whoever is
  presenting it again is not the legitimate client. The response is to revoke the
  **entire session family**, forcing a fresh login. `rotated_from` records the
  chain so the sequence is reconstructable afterwards.
- **A separate cookie, scoped to `/api/v1/auth/refresh`.** The browser does not
  attach the long-lived credential to ordinary API calls, so it is absent from
  the vast majority of requests, logs and proxies.
- **`logout-all`**, and automatic revocation on password change and on lockout.

Everything remains revocable in one statement, which is the property the JWT
design would have given up.

**If JWTs are revisited**, the trigger would be a genuine cross-service
verification need — several services validating a token without a shared
database. That does not exist today, and adopting the format before the problem
would buy the costs without the benefit.

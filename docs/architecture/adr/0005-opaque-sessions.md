# ADR 0005 — Opaque server-side sessions, not JWTs

**Status:** Accepted · **Date:** 2026-08-30

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

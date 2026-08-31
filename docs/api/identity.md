# Identity API

All routes are under `/api/v1`. Every response is JSON; every error uses the
shape in [API conventions](#api-conventions) below.

## Authentication model

Opaque, server-side sessions in two `HttpOnly; Secure; SameSite=Strict` cookies:

| Cookie        | Lifetime                 | Path                   | Purpose                               |
| ------------- | ------------------------ | ---------------------- | ------------------------------------- |
| `edu_session` | `SESSION_TTL_HOURS` (12) | `/`                    | Access token, sent with every request |
| `edu_refresh` | `REFRESH_TTL_DAYS` (30)  | `/api/v1/auth/refresh` | Refresh token, rotated on every use   |

The refresh cookie is **path-scoped to the refresh endpoint**, so the long-lived
credential is not attached to ordinary API calls. Neither token is readable from
JavaScript, and only the SHA-256 of each is stored.

See [ADR 0005](../architecture/adr/0005-opaque-sessions.md) for why these are not
JWTs.

## Endpoints

### `POST /auth/register` → `201 { id }`

Creates the account, its profile, and a global `student` role grant — atomically,
inside one SECURITY DEFINER function. The role is a literal in that function, so
registration cannot grant anything else.

Issues an email-verification token **through the mail port only**. It is never in
the response: anyone able to trigger a registration could otherwise read it.

Rate limit: 5 / 15 min. Returns `409` if the address is registered — a known,
compensated enumeration weakness (RISK-ENUM-01).

### `POST /auth/login` → `204` + cookies

Rate limit: 10 / 15 min.

Returns an identical `401 Invalid email or password` for **every** failure mode:
unknown account, wrong password, suspended, locked, and (when enabled)
unverified. A real Argon2 verification runs even for unknown accounts so timing
does not distinguish them.

Repeated failures against a **real** account advance the lockout counter;
failures against an unknown address do not, so the table cannot be filled with
junk. On lockout, every live session for that account is revoked — a lockout
usually means the account is under attack, and a live session would survive the
control meant to stop it.

### `POST /auth/refresh` → `204` + new cookies

Rate limit: 60 / 15 min. Reads `edu_refresh`; issues a new access **and** refresh
token, revoking the old session.

**Reuse detection:** presenting an already-rotated refresh token revokes the
entire session family and returns `401`. A missing cookie, an expired token and a
forged one are all indistinguishable from each other.

### `POST /auth/logout` → `204`

Revokes the current session and clears both cookies. Always `204`, so it never
reports whether the token was real.

### `POST /auth/logout-all` → `204` _(authenticated)_

Revokes every session for the actor, on every device.

### `POST /auth/verify-email` → `204`

Body `{ token }`. Single use, expiry enforced in SQL, and bound to the address
the token was issued for — so it cannot confirm an address changed to afterwards.
Invalid, expired and already-used are one `400`.

### `POST /auth/forgot-password` → `202`

Body `{ email }`. **Always `202`**, whether or not the address exists. Unlike
registration, this endpoint can be non-enumerating at no cost, so it is.
Requesting a new token invalidates any outstanding one. Rate limit: 5 / hour.

### `POST /auth/reset-password` → `204`

Body `{ token, password }`. The full registration password policy applies — a
reset must not be a way to set a weaker password than signup allows.

Consuming the token changes the password **and revokes every session** in the
same transaction: a reset is an account-recovery event, so leaving an attacker's
session alive would defeat it.

### `GET /auth/me` → `200` _(authenticated)_

Returns id, email, display name, locale, organization, `emailVerified`, the role
names held, the **scoped grants**, and the flattened permission set. Every field
is server-derived; the token carries no claims.

## Profile

### `GET /profile`, `PATCH /profile` _(authenticated)_

The caller's own profile. The update contract has **no `userId` field**, so the
request cannot name anyone else. `avatarUrl` must be `https://` — a `data:` or
`javascript:` URL is an XSS vector and an arbitrary scheme is an SSRF vector.

### `GET /users/:id/profile` _(authenticated)_

Another person's profile, subject to object-level authorization: self, a teacher
of a class the person is actively enrolled in, a verified guardian, or an
administrator of the same organization. Anything else is `404`.

**Nobody may update another person's profile** — not a teacher, not an
administrator. A profile is self-description.

## Administration

All under `/admin`, all object-level authorized, all `404` when not permitted.

| Route                           | Requires                                                         |
| ------------------------------- | ---------------------------------------------------------------- |
| `GET /admin/users`              | `users:list` + same organization                                 |
| `GET /admin/users/:id`          | `users:read` + same organization                                 |
| `PATCH /admin/users/:id`        | `users:suspend` + **security administrator** + same organization |
| `POST /admin/users/:id/roles`   | `roles:assign` + admin, with containment rules below             |
| `DELETE /admin/users/:id/roles` | same as assign                                                   |

**Privilege containment** (see `roleGrantPolicy`):

1. **Nobody may change their own roles** — not an admin, not a security admin.
   Self-grant is the shortest path from a compromised account to permanent
   control, and has no legitimate use.
2. **Only a security administrator may grant `admin` or `security_admin`**, so
   compromising one ordinary admin does not compound.
3. Every grant is confined to the actor's own organization, and a privileged role
   may never be granted globally.

Suspension is separated from ordinary administration: an admin may read and
correct a record but cannot lock a person out.

## API conventions

Errors always take this shape, and never include a stack trace, SQL, or internal
detail:

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "...", "correlationId": "..." } }
```

| Status | When                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| `400`  | Validation failed, or an invalid/expired single-use token                              |
| `401`  | No session, or a session that is no longer valid                                       |
| `403`  | Refused, and the actor already knows the object exists                                 |
| `404`  | Refused, and the actor may not learn the object exists — **also used for "not found"** |
| `409`  | Conflict (duplicate email, no-op status change)                                        |
| `413`  | Body too large                                                                         |
| `429`  | Rate limited                                                                           |
| `500`  | Internal error; detail is logged, never returned                                       |

**404 versus 403 is deliberate.** Returning `403` for an object the caller may
not see would confirm that the id names something real — exactly the signal an
enumerator wants. `403` is reserved for cases where the actor plainly already
knows the object exists, such as their own suspended account.

## Not implemented

Email delivery (the port exists; nothing sends). Login is **not** blocked on an
unverified address by default — `REQUIRE_VERIFIED_EMAIL_FOR_LOGIN` exists and is
tested, but enabling it without a mail provider would lock every user out. MFA,
password change while logged in, and session listing.

Organizations, classes, rosters and guardian links **are** now implemented; they
are documented separately in
[the relationship & class management API](relationships.md). Curricula, courses,
units and lessons are in
[the curriculum & course API](curriculum.md).

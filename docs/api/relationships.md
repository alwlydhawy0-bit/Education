# Relationship & Class Management API

Organizations, classes, rosters and guardian links. All routes are under
`/api/v1`, all require a session, and all follow the error shape and the
`404`-versus-`403` rule documented in [the identity API](identity.md#api-conventions).

## The shape of every decision here

Three properties hold across this whole surface, and they are worth stating once
rather than repeating per endpoint.

**No request body ever names an organization.** Organization scope comes from the
authenticated session. A cross-tenant write is not _expressible_ in the contract,
before any policy runs — and the policy and RLS refuse it independently anyway.

**Nothing about the actor comes from the client.** Roles, permissions, the
actor's user id and the actor's organization are all loaded server-side from the
session. Where a body carries a `userId` or `teacherId` it names the _object_ of
the operation, never the subject.

**A listing is filtered twice.** RLS scopes the rows; the service then runs the
policy over each one and keeps only the allows. Because the policy pass happens
after pagination, a page can come back short — never over-full.

**Two gates, independently.** Every operation passes the pure policy engine
(`@edu/authz`) and PostgreSQL row-level security. Neither is allowed to be
load-bearing on its own:
`tests/integration/rls-relationship-writes.test.ts` asserts the database refuses
with no application code in the path, and
`tests/security/layered-defense.test.ts` asserts the application refuses with RLS
switched off.

## Organizations

| Route                      | Who                                              |
| -------------------------- | ------------------------------------------------ |
| `POST /organizations`      | **Platform operator only**                       |
| `GET /organizations`       | Any actor — returns only their own organization  |
| `GET /organizations/:id`   | Own organization; platform operator sees any     |
| `PATCH /organizations/:id` | `admin` or `security_admin` of that organization |

A **platform operator** is `security_admin` held at **global** scope. A school's
own security administrator holds the same role scoped to their organization and
is _not_ a platform operator — they administer their school, they do not create
new ones.

That distinction is safe to rely on because the global grant cannot be minted
over HTTP at all: migration 0013 refuses to grant any privileged role globally
through `auth_assign_role`, whoever asks. A platform operator is provisioned out
of band by someone with database access, and `granted_by` records who did it.

## Classes

| Route                       | Who                                                             |
| --------------------------- | --------------------------------------------------------------- |
| `POST /classes`             | `admin` + `classes:manage`, in their own organization           |
| `GET /classes`              | Classes the actor teaches, is enrolled in, or administers       |
| `GET /classes/:id`          | Same, per class                                                 |
| `PATCH /classes/:id`        | `admin` + `classes:manage`, same organization, class **active** |
| `POST /classes/:id/archive` | Same as `PATCH`                                                 |

`POST /classes` takes `{ name, academicTerm? }` — **no `organizationId`**; the
class is created in the caller's own organization.

**A teacher cannot create or reshape a class.** A teacher _runs_ a class; they do
not decide which classes exist or which organization owns one. Teacher-to-student
access is derived from a shared class ([ADR 0008](../architecture/adr/0008-rbac-scopes.md)),
so letting a teacher shape classes would make "teacher of this class" partly
self-asserted.

**A class cannot move between organizations.** The column is guarded by a trigger
(migration 0014) as well as by the policies, so even an administrator of the
owning school cannot re-point it. Every membership and assignment underneath it
would silently change tenant.

**Archiving is terminal.** An archived class is settled history: further edits
are refused with `403` (the caller can see the class, so hiding it would be
pointless), and the archive revokes every teacher's derived access to the
students in it — which is why it emits `class.archived` rather than being treated
as bookkeeping. A new term gets a new class.

## Student roster

| Route                                 | Who                                                            |
| ------------------------------------- | -------------------------------------------------------------- |
| `GET /classes/:id/members`            | A **teacher of that class**, or an `admin` of its organization |
| `POST /classes/:id/members`           | Same                                                           |
| `DELETE /classes/:id/members/:userId` | Same                                                           |

**An enrolled student cannot read the roster.** They can read the class itself,
and their own membership — but enumerating classmates is a separate grant they do
not hold, and `GET /classes/:id/members` answers `404`. This is enforced by a
distinct action, `class_membership:list`, whose resource is the roster as a whole
and which refuses to be aimed at a single member; an earlier version authorized
the caller's _own_ membership row and then returned everyone's
([VULN-013](../security/vulnerability-log.md)).

**Removal is a status change, never a `DELETE`.** The roster history is the audit
trail for who could read whose work, and when. Removing a student ends their
membership and immediately revokes the teacher's derived access to them.

**Re-enrolment creates a new row.** An ended membership cannot be reopened — the
`UPDATE` policy matches only active rows and the triggers forbid re-pointing the
parties — so a returning student gets a fresh membership with its own
`joinedAt`. The uniqueness constraint covers **active** rows only (migration
0015): nobody is on a roster twice at once, but history may repeat. A second
active enrolment is `409`.

## Teacher assignments

| Route                                        | Who                                   |
| -------------------------------------------- | ------------------------------------- |
| `GET /classes/:id/teachers`                  | Anyone who can read the class         |
| `POST /classes/:id/teachers`                 | **`admin` of that organization only** |
| `DELETE /classes/:id/teachers/:assignmentId` | Same                                  |

**No teacher may assign anybody to any class, including themselves.** This is the
single most load-bearing rule on this surface, and it is stated three times: the
policy refuses every teacher outright, RLS requires `app_actor_is_org_admin()`,
and both also require the class to be in the actor's own organization. If a
teacher could self-assign, "teacher of this class" would be self-asserted — and
that relationship is what unlocks every enrolled student's shared work.

An administrator is also refused **assigning themselves**, with `403`
(`teacher_assignment.self_assignment_forbidden`): the same escalation by a
different door.

`DELETE` checks that the assignment id actually belongs to the class named in the
URL, so an id from another class cannot be actioned under a class the caller
happens to administer.

## Guardian links

| Route                             | Who                                                   |
| --------------------------------- | ----------------------------------------------------- |
| `POST /guardian-links`            | A `guardian`, about **themselves** → always `202`     |
| `GET /guardian-links`             | The caller's own links, either side                   |
| `GET /users/:id/guardian-links`   | Participants and administrators of the child's school |
| `POST /guardian-links/:id/verify` | **An `admin` of the child's organization only**       |
| `POST /guardian-links/:id/revoke` | **Either** participant, or an administrator           |

**A claim is always `pending` and grants nothing.** There is no `status` field in
the request, so a claim cannot assert its own approval. `guardianId` is taken
from the session — a guardian may only claim a link about themselves — and a
child cannot file a claim naming their own guardian.

**`POST /guardian-links` always answers `202`,** whether or not the child exists
and whether or not a claim already existed. Any other behaviour makes the
endpoint an oracle for "is this user id real?", callable by anyone holding the
guardian role. The guardian learns the outcome by listing their own links.
Unknown-child and duplicate attempts are recorded as `authz.denied` with a
reason, so a burst of probing is visible to defenders while the response stays
uninformative.

**Neither participant may verify.** Verification is what turns a claim into
standing access over a child's work, so the guardian is refused (`403`) and so is
the child. Only an administrator of the child's organization may verify, and an
administrator of a _different_ school gets `404`.

**Either participant may revoke,** without anyone's approval — including the
child. Revocation only ever removes access, so the asymmetry with verification is
deliberate: granting requires a third party, withdrawing does not.

## Audit events

Every state change on this surface emits a security event
(`docs/security/observability.md`): `organization.created`,
`organization.updated`, `class.created`, `class.updated`, `class.archived`,
`class.member_added`, `class.member_removed`, `class.teacher_assigned`,
`class.teacher_unassigned`, `guardian_link.created`, `guardian_link.verified`,
`guardian_link.revoked`. Denials emit `authz.denied` with the action, the
resource kind and the policy reason — never the protected content.

An architecture fitness test asserts that every declared event type has an
emitter, so a type cannot be declared and then quietly never used.

## Not implemented

Bulk enrolment or CSV import. Class-level role grants (the `class` scope exists in
the RBAC model but no endpoint issues one). Invitations, join codes, or any
self-service enrolment path. Guardian claims initiated by a school rather than by
the guardian. Transferring a class between academic terms.

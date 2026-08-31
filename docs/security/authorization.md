# Authorization & IDOR/BOLA Strategy

Object-level authorization is non-negotiable (brief §14). This document
describes how it works, why it is built this way, and exactly what proves it.

## Two independent gates

Every read or write of a protected object passes through **both**:

|                 | Application gate                                      | Database gate                                 |
| --------------- | ----------------------------------------------------- | --------------------------------------------- |
| **Where**       | `packages/authz` policy engine                        | PostgreSQL Row-Level Security                 |
| **Covers**      | Paths that call it                                    | _Every_ query, including ones not yet written |
| **Can express** | Relationships, state, disclosure rules, audit reasons | Row predicates                                |
| **Fails if**    | A developer forgets to call it                        | A policy is subtly wrong; superuser connects  |

They are complementary, not redundant. The application gate is expressive and
reviewable; the database gate is unforgettable.

**Neither is trusted alone, and each is tested with the other removed:**

- `tests/integration/rls.test.ts` — queries the database directly, no
  application code in the path.
- `tests/security/layered-defense.test.ts` — runs the full application against a
  role with `BYPASSRLS`, and asserts cross-user access is still refused. It
  begins with a test proving the bypass role _really does_ bypass RLS; without
  that, the whole file could pass vacuously.

## The authorization sequence

```
authenticate → resolve actor from server state → load the resource
    → load relationship edges → decide → allow / deny → unwrap
```

Every input to the decision is server-derived. Nothing on the request can
influence it — not a header, not a body field, not a JWT claim (there are no
claims; sessions are opaque).

## Why the policy engine is pure

`packages/authz` performs no I/O, reads no globals, consults no clock. Two
consequences:

1. The decision table can be enumerated exhaustively in unit tests without a
   database — 39 tests for `notePolicy` alone.
2. It forces callers to be explicit about what they loaded. A relationship
   snapshot that is accidentally empty shows up as a failing test rather than as
   a silent denial (or, worse, a silent grant).

The purity is enforced mechanically: `tests/architecture/dependency-rules.test.ts`
asserts `packages/authz` imports nothing but `@edu/kernel`.

## `Guarded<T>` — making IDOR structural

The classic IDOR bug is not "no check happened". It is **"a check happened, but
against a different object than the one returned"**. Reviewers miss it because
the code _looks_ correct — there is an authorization call right there.

`Guarded<T>` makes that shape throw:

```ts
const guarded = await repository.findById(tx, noteId); // Guarded<NoteRecord>
const decision = engine.decide(ctx, 'note:read', guarded.resource);
const note = guarded.unwrap(decision, 'note:read'); // re-verifies id + action
```

`unwrap` checks three things, because a decision object alone proves nothing
about _which_ object it was made for:

1. the decision allows;
2. `decision.resourceId === this.resource.id` — **this is the check that stops
   IDOR**;
3. `decision.action === action` — a read grant is not reusable as a delete grant.

The payload lives in a `#private` field, so it is unreachable without `unwrap` —
not merely conventionally private. A test asserts it does not appear in
`JSON.stringify` or `Object.values`.

**What `Guarded` does not do:** it cannot protect code that never wraps a record.
That gap is covered by the fitness test asserting protected repositories declare
`Guarded<…>` return types — and by the reality that RLS is still underneath.

## Existence disclosure: 404, not 403

A denial that hides existence returns **404**. Returning 403 would confirm that
an id names a real object, turning the API into an enumeration oracle.

Policies express this explicitly via `disclosure: 'hide' | 'reveal'`:

- `hide` → 404. The actor may not learn the object exists.
- `reveal` → 403. The actor already knows it exists (e.g. their own archived
  note, which they may read but not edit).

`tests/security/idor.test.ts` asserts a real-but-forbidden note and a random UUID
produce the same status _and_ the same error code.

## The decision table (notebook)

| Actor                                         | Visibility             | Relationship            | read   | write                |
| --------------------------------------------- | ---------------------- | ----------------------- | ------ | -------------------- |
| Owner                                         | any                    | —                       | ✅     | ✅ (not if archived) |
| Owner, note deleted                           | —                      | —                       | ❌ 404 | ❌                   |
| Other student                                 | any                    | —                       | ❌ 404 | ❌ 404               |
| Teacher                                       | `shared_with_teacher`  | assigned + same org     | ✅     | ❌                   |
| Teacher                                       | `private`              | assigned                | ❌     | ❌                   |
| Teacher                                       | `shared_with_teacher`  | not assigned            | ❌     | ❌                   |
| Teacher                                       | `shared_with_teacher`  | assigned, different org | ❌     | ❌                   |
| Teacher                                       | `shared_with_teacher`  | assignment ended        | ❌     | ❌                   |
| Guardian                                      | `shared_with_guardian` | verified link           | ✅     | ❌                   |
| Guardian                                      | `shared_with_guardian` | pending link            | ❌     | ❌                   |
| Admin / security admin / moderator / reviewer | any                    | —                       | ❌     | ❌                   |
| Suspended or unverified actor                 | any                    | own note                | ❌ 403 | ❌ 403               |

Two rows are deliberate product decisions, not oversights:

- **Administrators cannot read note content.** Admins manage accounts, not
  private student writing. A break-glass path would need to be audited,
  time-boxed and separately authorized. It does not exist.
- **Sharing is the student's decision.** A relationship alone is never consent;
  a share alone is never sufficient. Both are required.

Guardian access is intentionally _not_ gated on organization — guardianship is a
family relationship, not an institutional one. Teacher access _is_, so that a
stale assignment cannot survive a school transfer as an access grant.

## Defence against vertical escalation

Three independent layers, all verified:

1. The registration contract has no `roles` field and is `.strict()` → 400.
2. `edu_app` has **no write privilege on `user_roles`** → _permission denied_.
3. The only function that writes roles hardcodes `'student'`, and an RLS policy
   independently restricts that insert to `role = 'student'`.

## Detection

Every denial writes an `authz.denied` audit event with the action, resource id
and rule name — never the content. Crucially this **includes denials where RLS
hid the row before the policy engine ran**; otherwise id enumeration blocked by
RLS would generate no signal at all. See VULN-002 in the
[vulnerability log](./vulnerability-log.md).

Detection should threshold on rate and distinct-id count, since the same event
fires for innocent 404s (stale bookmarks, typos).

## Roles, scopes and permissions (Task 003)

A role grant carries a **scope**: `global`, `organization`, or `class`. A global
grant covers everything; a scoped grant covers only its own target. An
organization-scoped grant deliberately does **not** cover classes inside that
organization — class containment is a relationship question, and answering it
from an id alone would mean guessing at data the pure policy package cannot see.

**A permission is necessary, never sufficient.** Holding `notes:read` says the
actor's roles permit reading notes in general; it says nothing about any
particular note. Object-level authorization always still runs. Policies check
permission _and_ scope _and_ relationship _and_ resource state.

### Privilege containment

| Rule                                                        | Why                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Nobody may change their own roles                           | Self-grant is the shortest path from a compromised admin account to permanent control, and has no legitimate use       |
| Only `security_admin` may grant `admin` or `security_admin` | Compromising one ordinary admin must not compound                                                                      |
| A privileged role may never be granted globally             | It would reach every organization on the platform                                                                      |
| Every grant is confined to the actor's own organization     | An admin of one school cannot reach another                                                                            |
| Only `security_admin` may suspend                           | Suspension is a denial-of-service capability over a real person's account, kept separable from ordinary administration |

### Guardian verification

**A guardian may not verify their own relationship.** Verification turns a claim
into access over a child's private work, so self-verification would let anyone
claim guardianship of any student and confirm it themselves. Refused for every
role, including administrators acting on their own relationships.

Revocation is the opposite: it only ever removes access, so **either participant
may revoke** — a student must always be able to cut off an adult without asking
permission.

### Relationship and class management (Task 004)

Three rules on this surface are worth stating as rules, not as endpoint notes,
because each one protects a relationship that is itself an authorization input.

**A teacher may not assign anybody to a class, themselves included.**
Teacher-to-student access is _derived_ from a shared active class, so an actor
able to create their own assignment could grant themselves access to any
student's shared work. Assignment is an administrator's act, in their own
organization only. An administrator assigning _themselves_ is refused too
(`403`), which is the same escalation by a different door.

**Being in a class does not let you enumerate it.** `class_membership:list` is a
separate action from `class_membership:read`, its resource is the roster as a
whole (`memberUserId: null`), and it refuses to be aimed at a single member so
it cannot stand in for the row-scoped action. An enrolled student reads the
class and their own membership; the list of classmates needs a teacher or
administrator grant. The reverse also holds — every row-scoped action denies
when no member is named. See [VULN-013](vulnerability-log.md).

**Every administrator branch names an organization.** `classPolicy`,
`classMembershipPolicy`, `teacherAssignmentPolicy` and
`guardianRelationshipPolicy` all compare the resource's organization against the
actor's own, and treat `null` on either side as no match. RLS enforces the same
confinement independently. Where a policy omitted it, the tenancy boundary
silently became RLS's alone — see [VULN-016](vulnerability-log.md).

**A listing runs the policy over every row RLS returns.** RLS scopes the result
set; the service then filters it with the authoritative policy and keeps only
the allows. The filter is a no-op whenever RLS is working — which is exactly why
it belongs there, since without it the highest-volume read paths would be the
ones standing on a single gate. See [VULN-017](vulnerability-log.md).

A **platform operator** — `security_admin` at `global` scope — is the one actor
above organization scope, and exists only to create organizations. It cannot be
granted through the API at any privilege level (migration 0013), so the
escalation path to it is not reachable over HTTP.

### Educational content (Task 005)

Content is the first domain that is **published to children**, and that changes
what the authorization question is. Three rules carry it.

**Two axes, evaluated in that order.** First SCOPE — may this actor see this
catalog at all? A failure is `hide` (404). Then STATE — is the content in a
state that permits this action? A failure is `reveal` (403), because by then the
actor can already see the object. Reversing the order would turn "this draft
exists" into an oracle: a 403 on another school's draft confirms the id is real.

**A node is only as visible as its least-visible ancestor.** A published lesson
inside a draft unit is not student-visible. The whole-chain answer is computed in
SQL and carried on the resource as `ancestorsPublished`, so the pure policy never
walks the tree and the two gates cannot disagree about where the chain breaks.

**Authoring and publishing are different permissions** — `content:author` and
`content:publish`. See [ADR 0009](../architecture/adr/0009-content-lifecycle-and-duty-split.md).
Enforcing this needed the two gates to be phrased differently rather than
mirrored: the row-level policy admits either authority (it cannot see which
columns moved), and a trigger compares the row's non-lifecycle columns to decide
which permission the change actually required.

One policy function serves all four content kinds. The rule genuinely is the
same at every level of the tree; four copies would be four places for it to
drift, and the drift would be invisible because each copy would have its own
tests.

### Class-scoped content access (Task 006)

The narrowing that turned "published to my school" into "assigned to my class".

**A learner reaches published content only through a class.** The course must be
actively assigned to an active class in which they hold an active membership.
Four statuses, any one of which breaks the chain — and because the edge is
recomputed per request rather than cached, breaking any of them revokes access
on the very next call.

**It narrows, it never widens.** The class-reachability test runs INSIDE the
catalog branch, after the tenancy and publication checks. An assignment can only
remove content from the set those checks already permitted; it cannot carry a
learner across an organization boundary, reveal a draft, or revive an archived
course. That is asserted directly rather than reasoned about: the RLS suite
forces rows the database normally refuses into existence and checks the read
path refuses them anyway.

**The requirement is on learners, not on staff.** Anyone holding a content
permission still browses the published catalog, because choosing what to assign
means reading the candidates first. Applying the narrowing to them made the
assignment endpoint unusable, which is how the distinction was found rather than
reasoned to — see [VULN-023](vulnerability-log.md).

**Assigning is roster-level authority**, not content authority: a teacher of
that class, or an administrator of its organization. Choosing among published
courses is running a class; deciding what content exists is not, and a teacher
still may not do it.

### Profiles

Several roles can read a profile they have a relationship with. **Nobody may
update another person's profile** — not a teacher, not an administrator. A
profile is self-description; removing inappropriate content is a moderation
action against the account, which is a different capability and does not exist.

## Adding a new protected resource

1. Add the table with `owner_id`, `organization_id`, `visibility`, `state`.
2. Add RLS policies mirroring the intended access, remembering that an UPDATE's
   new row must remain visible under the SELECT policy
   (ADR [0007](../architecture/adr/0007-soft-delete-and-rls.md)).
3. Add a `<Resource>` type and actions to `packages/authz/src/types.ts`.
4. Write `<domain>.policy.ts` and register it in the engine. **Do not edit
   another domain's policy.**
5. Return `Guarded<T>` from the repository's by-id loader.
6. Funnel every by-id operation through one `authorize<Thing>` helper.
7. Write the decision table as unit tests, and the cross-user attacks as
   security tests.

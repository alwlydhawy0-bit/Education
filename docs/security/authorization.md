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

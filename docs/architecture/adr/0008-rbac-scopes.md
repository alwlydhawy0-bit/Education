# ADR 0008 — Scoped role grants, and deriving teacher–student from classes

**Status:** Accepted · **Date:** 2026-08-31 · **Supersedes part of** ADR 0002's data model

## Context

Task 001 modelled a role as a string on `user_roles`. That was adequate for two
domains and wrong for a school, because **"teacher" is never a global fact** — it
is _teacher of this class_. A flat role column forces every policy to re-derive
scope from somewhere else, which is how authorization logic ends up duplicated
and then inconsistent.

Task 003 also asked for a direct `teacher_assignments(teacher_id, student_id)`
edge. That shape has a quieter problem: when a student leaves a class, _every_
teacher-student row for that pair must be found and updated, and the one nobody
remembers is a stale access grant over a child's private work.

## Decision

**1. Role grants carry a scope.**

```
user_roles(user_id, role_id, scope_type, scope_id)
scope_type ∈ { global, organization, class }
```

`scope_type = 'global'` reproduces the old behaviour exactly, so a student grant
is unchanged in meaning. A CHECK constraint enforces that `scope_id` is present
exactly when the scope is not global — a scoped grant missing its target would
otherwise silently widen into a global one.

A global grant covers every scope. An organization-scoped grant deliberately
does **not** automatically cover classes inside that organization: class
containment is a relationship question, and answering it from an id alone would
mean guessing at data the pure policy package cannot see.

**2. Teacher-to-student is derived, not stored.**

```
teacher --(teacher_assignments.class_id)--> class <--(class_memberships)-- student
```

The relationship holds when the assignment is `active`, the class is `active`,
and the membership is `active`. Ending any one of the three revokes access
immediately.

The derivation lives in exactly one place — `relationshipReader.loadSnapshot` —
and is mirrored by the RLS policies. No caller can check two of the three
conditions and forget the third.

**3. Permissions are `resource:action` rows attached to roles.**

A permission is **necessary but never sufficient**. Holding `notes:read` says the
actor's roles permit reading notes in general; it says nothing about any
particular note. Object-level authorization always still runs.

## Rationale

Scope is the thing policies actually need, so storing it is cheaper than
recomputing it. Derivation is what makes revocation correct by construction
rather than by diligence — the property that matters most when the data is a
child's private work.

## Consequences

- **Breaking.** `user_roles`, `teacher_assignments` and `guardian_links` were
  dropped and recreated (migrations 0007–0008). Approved explicitly; nothing was
  deployed and there were no users.
- Seeding a teacher-student relationship now means seeding a class, an
  assignment and a membership. `linkTeacherToStudent` in the test fixtures does
  all three, so tests state the intent rather than the mechanics.
- RLS policies became more complex (a three-way join instead of one lookup) and
  had to be written acyclically to avoid PostgreSQL's
  "infinite recursion detected in policy". The ordering is documented in
  migration 0008.
- Reading another user's grants needs a SECURITY DEFINER function, because
  `user_roles`' own policy is deliberately "own grants only" — an admin branch
  would have to read `user_roles` from inside `user_roles`' policy.

## Revisit when

A role needs a scope the three types cannot express (a district spanning several
organizations, say), or when class containment genuinely needs to be resolved
inside the policy package.

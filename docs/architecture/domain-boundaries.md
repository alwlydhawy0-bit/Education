# Domain Boundaries & Data Ownership

## The ownership rule

**One module owns each table, and it is the only module that queries it.**

Cross-domain access goes through a contract the owning module exposes. This is
what makes a domain extractable into its own service later: if a module's tables
are only ever touched by that module, the seam is already cut.

## Domains today

### `identity` — **[BUILT]**

Owns `users`, `user_roles`, `sessions`. Responsible for registration, login,
logout, session lifecycle, and constructing the `Actor`.

Exposes `IdentityService` (`register`, `login`, `logout`, `authenticate`).
Structurally satisfies `platform`'s `SessionAuthenticator` interface — note the
direction: `platform` does not import `identity`.

### `relationships` — **[BUILT]**

Owns `guardian_links`, `teacher_assignments`.

These tables are **authorization inputs**, not descriptive data — a wrong row
silently widens who can read a child's work. That is why their constraints are
tighter than reference data would warrant (no self-guardianship; a `verified`
link must record _when_; an `ended` assignment must record _when_).

Exposes `RelationshipReader.loadSnapshot(tx, actorId)`, returning only
**verified** guardianships and **active** assignments, so no caller can forget to
filter.

**Teacher-to-student is derived, not stored** — the actor has an active
assignment to an active class in which the student has an active membership. The
join lives here and only here, so ending any one of the three revokes access
immediately and no caller can check two conditions and forget the third. See
[ADR 0008](./adr/0008-rbac-scopes.md).

### `notebook` — **[BUILT]**

Owns `notes`. The worked example of the protected-resource pattern:
`owner_id` + `organization_id` + `visibility` + `state`. Future owned resources
(projects, submissions, portfolios, files) follow the same shape.

Consumes a `RelationshipSnapshot`. It never queries `guardian_links` or
`teacher_assignments`.

### `platform` — **[BUILT]**, not a domain

Infrastructure: config, database access, HTTP wiring, error handling, audit,
password hashing, token generation. Owns `audit_log` (append-only).

## Planned domains — **[DESIGNED]**, boundaries only

`curriculum` (courses, modules, lessons) · `learning-paths` · `activities` ·
`assessments` · `mastery` · `experiments` · `projects` · `portfolio` · `files` ·
`knowledge-base` · `ai-gateway` · `ai-tutor` · `ai-assistant` ·
`recommendations` · `community` · `moderation` · `notifications` · `analytics` ·
`administration` · `organizations`.

None exist. They are listed so their boundaries are considered before code is
written, not after.

## Data ownership rules

1. **One writer per table** — the owning module.
2. **No cross-domain joins.** Do not join into another domain's tables. Ask the
   owner via its contract.
3. **Denormalization requires justification.** Exactly one instance exists:
   `notes.organization_id`, copied from the owner at write time so the RLS policy
   can evaluate the organization check without joining `users` — which is itself
   RLS-protected and would make the policy recursive. The comment in the
   migration says so.
   - **[OPEN]** No flow keeps this correct across an organization transfer,
     because no transfer flow exists. When one is built it must update existing
     notes in the same transaction, or the column must become a lookup.
4. **Foreign keys may cross domains.** A schema-level reference to `users(id)` is
   fine; a _query_ into another domain's tables is not. Referential integrity is
   the database's job.
5. **Events, not reach-ins.** When a domain needs to react to another's change,
   it subscribes to an event. Never place a security control or a data-integrity
   invariant in an event handler — those belong in the publishing transaction
   (see `packages/kernel/src/events.ts`).

## Extraction readiness

A domain can be extracted into its own service when its tables are touched only
by it, its contract is explicit, it has no imports from sibling modules, and its
tests do not depend on another domain's internals. All three current domains meet
this today — enforced by `tests/architecture/dependency-rules.test.ts`, not by
inspection.

**No domain should be extracted until scale, reliability, or team structure
demands it.** The point of the boundary is that the option stays open, not that
it should be exercised.

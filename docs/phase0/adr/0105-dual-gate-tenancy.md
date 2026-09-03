# ADR 0105 — Multi-tenancy is enforced twice: policy engine and RLS

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**
Carries forward ADR-0002 for a new product and a new tenant model.

## Context

The education platform enforces authorization at two independent layers: a pure
policy engine (`packages/authz`) and PostgreSQL `FORCE ROW LEVEL SECURITY`, with
two database roles (`edu_app` NOBYPASSRLS, `edu_app_norls` BYPASSRLS) that exist
so **each layer can be tested with the other removed**. 136 policies across 11
migrations. The Phase 0 audit called this the single most valuable asset in the
repository.

The automation platform's tenant is a **workspace**, and the consequence of a
cross-tenant read is now not a leaked lesson but a leaked credential reference,
a leaked run payload from a customer's CRM, or an automation that acts with
someone else's authority.

## Decision

**Carry the mechanism over unchanged.** Every tenant table gets
`workspace_id`, `FORCE ROW LEVEL SECURITY`, and at least one policy. The
application connects as a NOBYPASSRLS role and sets `app.actor_id` per
transaction. Every route calls the policy engine explicitly before touching
data. The BYPASSRLS role continues to exist **for tests only**.

Two policies are elevated to structural requirements because the AI-authoring
path makes them load-bearing:

- `spec:approve` **denies when the actor is the version's author** (separation of
  duty), enforced by policy **and** by a database constraint on `approvals`.
- `deployment:promote` to production requires an approval and a successful
  staging run — conditions read from the resource rows, never from the request.

## Rationale

Defence in depth is a cliché until you can say what each layer catches. Here:

- **The policy engine catches** logic errors, missing checks, role confusion, and
  anything that never reaches SQL. It is pure and total, so it is exhaustively
  testable without a database.
- **RLS catches** a forgotten `WHERE` clause, a new query path added six months
  later by someone who did not read the policy, a raw SQL helper, and a partially
  compromised application layer.

Neither catches the other's class. A single gate would be a single point of
failure for the platform's most consequential property.

The two roles are the part people skip, and they are the part that makes the
claim checkable: without them, "we have two gates" is untestable, because every
test passes for the wrong reason.

## Consequences

- Every migration adding a tenant table adds its policies in the same file. A
  fitness test enumerates tables and fails on any that lacks `FORCE ROW LEVEL
SECURITY` plus a policy.
- The cross-tenant security suite runs twice: once against the BYPASSRLS role
  (policy engine alone must deny), once with the policy engine's decision
  short-circuited (RLS alone must deny).
- Denormalized `workspace_id` on child tables (step attempts, connection
  versions) so a policy is never a join. Slight redundancy, large simplification
  of the thing that must never be wrong.
- An RLS-layer denial in production is an **alert**: it means the policy engine
  already failed.

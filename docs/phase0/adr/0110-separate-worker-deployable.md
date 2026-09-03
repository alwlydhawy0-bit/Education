# ADR 0110 — The worker is a separate deployable, not a thread

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**

## Context

ADR-0001 chose a modular monolith and it has served the control plane well. The
tempting extension is to run the execution plane inside the same process: no new
deployable, no new pipeline, shared config, shared connection pool, easy local
development.

## Decision

**`apps/worker` is a separate process and a separate deployable, on a separate
network, with a separate configuration.** The control plane remains a modular
monolith; the execution plane is the one thing split out.

## Rationale

The entire trust boundary in §B is a _process_ boundary. Inside one process:

- `DATABASE_URL` is in the same environment, so B1 ("a worker never holds the
  tenant database connection string") becomes a comment.
- The heap is shared, so a compromised connector parser can read another
  tenant's in-flight data.
- The environment is shared, so THREAT-EXEC-04 (ambient credential inheritance)
  is guaranteed rather than merely possible.
- Egress policy cannot be applied per-run, because the process's sockets are the
  API's sockets.
- Resource exhaustion by one run takes the API down with it.

**A boundary you can violate with an import is not a boundary.** Every control
in the security spec that says "the worker cannot" is untestable and untrue in a
shared process. Splitting is what makes the execution-plane test project able to
assert on the worker's resolved environment, its network reach, and its database
unreachability at all.

## Consequences

- A second deployable, a second image, a second rollout, a second set of
  dashboards. Accepted cost, and it is small relative to what it buys.
- The worker talks to the control plane over the narrow `/internal` surface
  (plan fetch, credential broker, attempt reporting, completion), authenticated
  by a run-scoped token, never by a session. "Internal" is not a security
  property, so that surface is specified and tested like any other (§E.3).
- Local development runs both processes. A dev-mode shortcut that runs the
  worker in-process is **not** offered, because the moment it exists it is what
  gets tested.
- Architecture fitness tests enforce the import boundary: `apps/worker` may not
  import `platform/db`, any API module, or the vault's internals.

## What would make this wrong

If the operational cost of two deployables genuinely blocks delivery, the honest
alternative is to ship the control plane first with **no execution plane at
all** — not to merge them. A platform that can author and approve specs but not
run them is a smaller product; a platform that runs untrusted work in its API
process is a different and worse one.

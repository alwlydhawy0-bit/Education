# ADR 0106 — Immutable versions, append-only deployments, rollback as promotion

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**

## Context

Automations change. Changes are approved by humans and then act on real systems.
After an incident, the questions are always: what was running, who approved it,
what did they see, and how fast can we get back to the last good state.

## Decision

- A **spec version is immutable**, content-addressed, and identified by
  `(automation, version_no)`. Editing creates a new version.
- A **compilation is immutable** and records its compiler version. Determinism
  means recompiling reproduces `plan_hash`.
- An **approval is immutable** and records the **hash of the diff the approver
  saw**.
- **Deployments are append-only.** The live deployment for
  `(automation, environment)` is the row with `superseded_at is null`, enforced
  by a partial unique index.
- **Rollback inserts a deployment row** pointing at an older, already-approved
  spec version. It is not an update, not a delete, and **requires no new
  approval**.
- A **run records the plan hash it executed**.

## Rationale

The chain `run → plan hash → compilation → spec version → approval → approver +
diff hash` answers every incident question with rows rather than reconstruction.
Break any link and the answer becomes an inference.

**Rollback needs no approval precisely because the target was already approved.**
That is not a shortcut; it is what makes rollback fast enough to be the first
incident response instead of the last. A design where rollback needs a fresh
approval is a design where people edit production instead.

**The diff hash is the part that is easy to omit and expensive to lack.** An
approval that does not name what was approved is not evidence. Recording it also
makes "the spec changed between render and click" a 409 rather than the silent
authorization of different behaviour.

## Consequences

- Ledger tables have no `UPDATE`/`DELETE` grant for the application role.
  Append-only is a grant, not a convention.
- Storage grows monotonically. Accepted for the ledger; run **payloads** are
  separated into their own table with short, configurable retention (§D.4) so
  the expensive-to-hold data is not entangled with the cheap-to-hold record.
- A plan compiled by a compiler version that no longer exists is **not
  executed** — it is recompiled, re-diffed, and re-approved. Silently running an
  old plan under new semantics is the failure this rule prevents.
- "Edit and save" is not an operation the API offers, and the UI must not
  pretend otherwise.

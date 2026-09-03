# ADR 0101 — The automation spec is a declarative IR, not code

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**

## Context

The platform must turn natural language into something that executes. The
spectrum runs from "generate code and run it" through "generate script in a
sandboxed embedded language" to "generate a document in a closed, declarative
vocabulary".

The author of that something is a language model, and the text it reads may
contain attacker-controlled content.

## Decision

The spec is a **declarative intermediate representation**: a JSON document with
a finite step-type vocabulary, a static acyclic step graph, structural data
references (`{from: "s1.value"}`), a small total comparison grammar for
branching, and no general expression evaluator.

**No user-supplied code and no general expression language in v1.**

## Rationale

Every property the platform's safety rests on is decidable for an IR and
undecidable for code:

| Property                                   | IR                                | Code            |
| ------------------------------------------ | --------------------------------- | --------------- |
| What hosts will this contact?              | computed from declared connectors | unknowable      |
| What credentials will it need?             | enumerated from the graph         | unknowable      |
| Will it terminate?                         | acyclic graph, bounded steps      | halting problem |
| What is the worst-case cost?               | computable                        | unbounded       |
| Can a human review this diff meaningfully? | yes                               | depends         |
| Is there an evaluator to escape from?      | **no**                            | yes, always     |

The last row is the decisive one. Sandboxing an expression evaluator is a
never-ending arms race; not having one is a property.

Structural data references rather than string interpolation is the same
argument at a smaller scale: interpolation is injection, a reference either
resolves at validation time or the spec is rejected.

## Consequences

- Real product needs — loops, fan-out, sub-workflows, "just call this URL" — are
  **not expressible in v1**. Each will be requested. Each converts a decidable
  property above into an undecidable one, and each therefore needs its own ADR
  with its own containment argument. They are not conveniences to be added under
  delivery pressure.
- The step vocabulary is compiled into the worker, so adding a capability is a
  deploy, not a configuration change. This is the intended friction.
- The IR must be versioned (`irVersion`) because it outlives every HTTP call and
  must be readable years later.

## What would make this wrong

If the bounded vocabulary cannot express a majority of the automations users
actually want, the product fails on usefulness rather than on safety. The
measurement is §A.8's "refusal correctness" and the proportion of proposals the
validator rejects as inexpressible. **If that proportion is high, the answer is
to grow the vocabulary deliberately — not to add an escape hatch.**

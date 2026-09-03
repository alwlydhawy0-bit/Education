# ADR 0102 — Execution isolation: requirements now, technology in Phase 1

**Status:** Accepted (as a deferral with conditions) · **Date:** 2026-09-03
**No implementation exists. All isolation claims are UNVERIFIED.**

## Context

The execution plane runs specs authored with a language model's help, against
third-party systems, on behalf of mutually distrusting tenants. Its isolation is
the single control the rest of the security design leans on hardest.

Nothing exists today: no sandbox, no container runtime, no worker (audit §4).
The deployment substrate is also undecided — there is no API deployment at all.

## Decision

**Phase 0 fixes the requirement set and defers the technology choice to Phase 1,
where it must be decided by measurement.**

Requirements (any candidate must satisfy all seven):

| #   | Requirement                                                                       |
| --- | --------------------------------------------------------------------------------- |
| I1  | Per-run isolation, no shared writable filesystem between runs                     |
| I2  | Explicit, closed environment injection — no host env inheritance                  |
| I3  | Egress default-deny with a per-run allow-list, enforced **below** the application |
| I4  | Cloud instance-metadata endpoint unreachable from the isolate                     |
| I5  | Hard CPU, memory, PID, FD and wall-clock limits                                   |
| I6  | Cold start fast enough that per-run isolation is affordable                       |
| I7  | Control-plane database port unreachable from the execution network                |

**Conditions on the deferral** (this is what makes it a decision rather than a
punt):

1. No isolation claim may be made in any report until I3 and I4 are
   demonstrated by an execution-plane test that **fails when the control is
   removed**.
2. I6 must be **measured**, not estimated, before the choice is locked.
3. Until the choice is made, no connector with write capability ships.

## Alternatives sketched (not decided)

| Option                                                   | Strength                                                | Cost / risk                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container per run + network namespace + egress proxy** | Familiar, good tooling, I3 enforceable at the proxy     | Kernel shared with host; container escape is a real class; I6 acceptable                                                                        |
| **MicroVM per run**                                      | Strongest isolation boundary short of separate hardware | Higher cold start (I6 at risk); more operational surface                                                                                        |
| **gVisor-class user-space kernel**                       | Strong syscall containment, moderate start cost         | Syscall compatibility gaps can surface as strange connector bugs                                                                                |
| **In-process V8 isolate**                                | Fastest by far                                          | Fails I1 and I2 in practice; shares a heap with other work. **Rejected outright** — it is the option that makes every other control conditional |

## Consequences

- §G and §I are written against the requirement set, not against a product, so
  the choice can be made without rewriting them.
- The execution-plane test project (§H) is designed to be the arbiter. Its
  assertions are the acceptance criteria for whichever substrate is chosen.
- **OPEN-EXEC-01 / OPEN-INFRA-01 remain open risks for the whole of Phase 0.**
  This ADR does not close them; it makes closing them a gate.

## What would make this wrong

Deferring is wrong if implementation starts building connectors and workers
against an assumed substrate and then discovers it fails I3 or I6. Condition 3
(no write-capable connector before the choice) exists specifically to prevent
that ordering.

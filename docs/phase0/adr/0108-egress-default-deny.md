# ADR 0108 — Egress is default-deny, enforced below the application

**Status:** Accepted (mechanism), substrate **OPEN** · **Date:** 2026-09-03

## Context

The worker executes plans against third-party systems. Exfiltration
(THREAT-EXEC-03) is the highest-value attack on an automation platform: the
data is already gathered and already authorized; the attacker only needs it to
go somewhere else.

## Decision

- **Default deny.** A run reaches nothing unless the plan's egress allow-list
  names it.
- **The allow-list is computed by the compiler** as the union of the declared
  hosts of exactly the connectors the plan uses — not the workspace's connectors,
  not the connector registry's, the **plan's**.
- **Enforcement is below the application**: a network policy plus a filtering
  egress proxy, not an HTTP-client wrapper.
- **No redirect-following to a host outside the allow-list.**
- **The instance-metadata endpoint is unreachable** (THREAT-EXEC-04).
- **An egress denial is a security event** with the run, step and attempted host.

## Rationale

An application-level allow-list is bypassed by the first library that opens its
own socket, by DNS rebinding, and by a redirect. The control has to sit where
the packet does. That is why §I draws the egress proxy as its own box.

Computing the list from the **plan** rather than the workspace is what makes the
blast radius per-run: compromising one automation does not grant the union of
everything the tenant has ever connected.

Denial as a security event matters because it is the earliest visible signal of
either an attack or a broken connector declaration — and the two look identical
at first, which is exactly why a human should see it.

## Consequences

- Connectors must **declare their hosts** completely. A connector that talks to
  an undeclared CDN or auth domain will fail at runtime. Good: the declaration
  becomes accurate because it must be.
- Vendors that use wildcard or rotating hostnames are painful. That is a real
  cost and it is a connector-admission criterion, not something to solve with a
  wildcard rule.
- Enforcement depends on the substrate, which is undecided (ADR-0102). **Until
  then this is a requirement with no enforcer (OPEN-EXEC-04 / OPEN-INFRA-01),
  and no egress claim may be made.**

## Acceptance tests (§H, execution project)

1. A run whose plan declares no connector makes **zero** egress.
2. A run with connector X cannot reach host Y.
3. The metadata endpoint is unreachable.
4. A redirect to an off-list host fails the step.

Each must fail when the control is removed. That is the only thing that will
turn this ADR's status into VERIFIED.

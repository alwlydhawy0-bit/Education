# ADR 0104 — Credentials are brokered, never shipped

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**
**No implementation exists. There is no KMS in this environment (OPEN-SEC-02).**

## Context

Automations act on third-party systems with the tenant's credentials. The
component doing the acting is the worker, which §B classifies as **untrusted**:
it executes model-authored plans and parses attacker-influenced responses.

The obvious design — put the credentials in the queue message or the plan — is
the one that makes a leaked message or a compromised worker a tenant-wide
credential breach.

## Decision

Two mechanisms:

**1. Envelope encryption at rest.** Each workspace has a data encryption key
(DEK); the DEK is wrapped by a KMS master key. `connection_versions` stores
ciphertext and the wrapped DEK. Database access alone does not yield plaintext.

**2. A broker at runtime.** The worker never receives credentials with its work.
It presents `(runId, leaseToken, stepId, connectionRef)` to
`POST /internal/runs/{runId}/credentials`, and the control plane returns a
short-lived, single-purpose credential **only if** the compiled plan's step
actually references that connection. Every release writes a `credential_grants`
row.

## Rationale

The broker moves the authorization decision from the untrusted side to the
trusted side. The worker cannot ask for what the plan does not name, and it
cannot ask on behalf of another run, because the plan is the authority and the
plan is fetched server-side by `runId`.

It also produces the ledger. "Which credentials were released, to which run, for
which step, when" becomes a table rather than an inference from logs. Without
it, credential release is invisible, and an invisible control cannot be audited
after an incident.

Envelope encryption bounds the at-rest blast radius: a database dump is
ciphertext, and rotation of a workspace's DEK does not require re-encrypting
every row of every other workspace.

## Consequences

- An extra network round trip per credentialed step. Acceptable: steps are
  network calls anyway, and the alternative is shipping secrets.
- The control plane must be available for a run to proceed. A run whose broker
  call fails fails as `unavailable` rather than proceeding without credentials —
  which is the correct failure.
- Credential lifetime must be short and single-purpose. Where a connector's auth
  cannot be short-lived (a static API key), the broker still gates _access_ and
  still writes the grant row, but the credential's own lifetime is the vendor's.
  **That limitation must be stated in the connector's declaration**, not hidden.
- KMS is a hard dependency that does not exist yet. Until it does, envelope
  encryption has no root of trust and the vault is **UNVERIFIED**.

## Rules this ADR makes binding

1. A credential value never appears in: a spec, a plan, a queue message, a log
   line, a run record, a step attempt, an error, or an API response.
2. Auth fields in the IR accept **only** `{ref}`, by type. An inline secret is a
   validation failure (THREAT-CRED-04).
3. A broker denial is a security event, not a 404.

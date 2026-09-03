# C. Security Specification

**Phase 0 deliverable. No implementation.**
Status: every control below is **DESIGN INTENT / UNVERIFIED**. Nothing in this
document may be described as implemented, and no threat below may be described
as mitigated, until a test exists that fails when the control is removed.

That last clause is the house rule this repository already lives by: seven
rounds of defect injection, 67 injected defects, 5 escapes, each escape
producing a permanent structural test (audit §8). It carries over verbatim.

---

## 1. Trust zones

| Zone                           | Trust               | Holds                                                                                         |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------------------------- |
| Browser                        | none                | session cookie only                                                                           |
| Control plane (`apps/api`)     | trusted             | tenant DB credentials, vault master key reference, policy engine                              |
| Queue (in Postgres)            | semi-trusted        | run identifiers and scoped tokens — **never plans, never secrets**                            |
| Worker (`apps/worker`)         | **untrusted**       | one run's plan, brokered credentials for the steps it is running                              |
| Connector target (third party) | untrusted, external | whatever the workspace authorized                                                             |
| AI provider                    | untrusted, external | the authoring prompt and the workspace's spec vocabulary — **no tenant secrets, no run data** |

## 2. Threat model

Threats are numbered so tests and ADRs can reference them. Each has an owning
control and a _disconfirming test_ — the test that would fail if the control
were removed. Absent that column, a threat is not addressed, it is merely
described.

### Tenancy

| ID            | Threat                                                            | Control                                                                                                                                             | Disconfirming test                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| THREAT-TEN-01 | Workspace A reads Workspace B's automations, runs, or credentials | **Dual gate**: policy engine + `FORCE ROW LEVEL SECURITY`, each testable with the other removed (`edu_app` NOBYPASSRLS / `edu_app_norls` BYPASSRLS) | Run the full cross-tenant suite against the BYPASSRLS role: policy engine alone must still deny. Then against the policy-engine-disabled build: RLS alone must still deny. |
| THREAT-TEN-02 | A run executes with another workspace's authority                 | Authority derived from the **deployment row**, never the queue message (B6)                                                                         | Forge every field of a queue message; assert resolved workspace unchanged and run refused                                                                                  |
| THREAT-TEN-03 | Platform admin reads tenant content                               | Admin role has no tenant-data policy grants; RLS has no admin exemption                                                                             | Admin actor + every tenant read path → deny, at both gates                                                                                                                 |

### Execution plane

| ID                 | Threat                                                                                                                                                | Control                                                                                                                   | Disconfirming test                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| THREAT-EXEC-01     | Worker escapes its sandbox and reaches the control plane or the database                                                                              | Separate deployable; no `DATABASE_URL` in worker config; network policy denies the DB port                                | Assert the worker's resolved config key set; attempt a DB connect from inside a run and assert refusal                                                                                                                                          |
| THREAT-EXEC-02     | A spec causes unbounded resource use (CPU, memory, time, spend)                                                                                       | Hard per-run bounds enforced by the sandbox **and** an independent server-side deadline                                   | Remove the sandbox bound: the outer deadline must still terminate the run. (Same two-layer pattern as `callWithDeadline` in the education assistant, and for the same reason: the layer being protected against is the one making the promise.) |
| THREAT-EXEC-03     | A spec exfiltrates data to an attacker-controlled host                                                                                                | Egress **deny-by-default**; only the declared connector's declared hosts are reachable                                    | A run whose spec declares no connector must make zero egress; a run with connector X must be unable to reach host Y                                                                                                                             |
| **THREAT-EXEC-04** | **Ambient credential inheritance** — the worker process inherits environment variables (cloud role credentials, CI tokens) that no spec ever declared | Worker spawned with an **explicit closed env map**; no `process.env` passthrough; no cloud instance-metadata reachability | Assert the spawned env's key set exactly equals the allow-list; assert the metadata endpoint (169.254.169.254 and equivalents) is unreachable from a run                                                                                        |
| THREAT-EXEC-05     | One tenant starves all others                                                                                                                         | Per-workspace concurrency and rate caps at lease time                                                                     | Saturate with one workspace; assert another still progresses                                                                                                                                                                                    |
| THREAT-EXEC-06     | A poisoned connector response drives the worker (SSRF-by-response, decompression bomb, huge body)                                                     | Response size caps, no redirect-following to new hosts, no content-type-driven code paths                                 | Oversized/redirecting/compressed-bomb responses → step fails, worker survives                                                                                                                                                                   |

THREAT-EXEC-04 is not hypothetical here. The Phase 0 audit found
`AWS_ACCESS_KEY_ID` **PRESENT as an ambient container variable** in this very
environment (audit §5), and Task 014's VULN-038 was exactly this failure mode in
miniature: the Anthropic SDK silently defaulted `baseURL` to an ambient
`ANTHROPIC_BASE_URL`, and the adapter dialled a host nobody configured. **An
execution plane inheriting ambient environment is the same bug with a much
larger blast radius.**

### Credentials

| ID             | Threat                                                         | Control                                                                                                                                                               | Disconfirming test                                                                                      |
| -------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| THREAT-CRED-01 | Secrets in source control                                      | Existing secret scanner in CI (already caught a `password:` line during Task 016 and it was removed, not exempted)                                                    | Plant a fixture secret in a branch; CI must fail                                                        |
| THREAT-CRED-02 | Secrets in logs, run records, error messages, or API responses | `packages/observability` redaction + **normalized error kinds only** — the AI adapter's rule that vendor `error.message` is never read generalizes to every connector | Inject a secret into a connector error path; assert it appears in no log line, no run row, no HTTP body |
| THREAT-CRED-03 | A worker reads a credential it did not need                    | **Broker**: worker presents (runId, stepId, connectionRef) and receives a short-lived, single-purpose credential; the vault decides, not the worker                   | Ask the broker for a connection the plan's step does not reference → deny + security event              |
| THREAT-CRED-04 | A spec inlines a secret as a literal                           | Validator rejects string literals matching credential shapes in connector auth fields; auth fields accept **only** connection references by type                      | A spec with an inline token must fail validation                                                        |
| THREAT-CRED-05 | Vault compromise at rest                                       | Envelope encryption; per-workspace data keys; master key in a KMS, never in the database or the app config                                                            | Assert ciphertext columns are non-decryptable with database access alone                                |

### AI

| ID           | Threat                                                                             | Control                                                                                                                                                                    | Disconfirming test                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| THREAT-AI-01 | Prompt injection via connector data or user text causes an unintended automation   | The model **cannot cause an effect** — it emits an IR proposal that is schema-validated, policy-validated, diffed, and human-approved                                      | An adversarial prompt corpus (Task 016's injection cases, generalized) must produce zero approved-without-human deployments — trivially true by construction, and the test exists to keep it true |
| THREAT-AI-02 | Model output is trusted structurally (fabricated connector, fabricated capability) | Parse into IR or reject; every referenced connector/capability/connection checked against the registry, exactly as citations are validated against the retrieved set today | A proposal naming a non-existent connector must be rejected, not "repaired"                                                                                                                       |
| THREAT-AI-03 | Tenant data leaks to the provider                                                  | The authoring prompt contains the user's own text and the **public** step vocabulary; never credentials, never run payloads, never another tenant's specs                  | Assert on the **bytes sent on the wire**, not on the request object — the T015-F7 lesson                                                                                                          |
| THREAT-AI-04 | Provider is swapped/tampered (`baseURL` hijack)                                    | Config-pinned HTTPS base URL, no ambient default, allow-listed models                                                                                                      | VULN-038's two regression tests carry over                                                                                                                                                        |
| THREAT-AI-05 | Cost blow-up via proposal spam                                                     | Per-workspace token/cost budget checked **before** the call, enforced server-side                                                                                          | Exhaust budget; assert next call is refused with zero provider calls                                                                                                                              |

### Ingress

| ID           | Threat                        | Control                                                                                            | Disconfirming test                               |
| ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| THREAT-IN-01 | Forged webhook triggers a run | Per-trigger secret, HMAC signature verification, timestamp window, replay cache                    | Valid body + wrong signature → zero runs created |
| THREAT-IN-02 | Webhook flood                 | Per-trigger and per-workspace rate limits before any DB write beyond the counter                   | Flood → 429, bounded rows                        |
| THREAT-IN-03 | Approval CSRF / clickjacking  | Existing CSRF protection; approval requires re-authentication and an explicit diff acknowledgement | Cross-origin approval attempt → refused          |
| THREAT-IN-04 | Session theft                 | Existing opaque server-side sessions, Argon2id, secure cookies                                     | Existing suite                                   |

## 3. Authorization design

**The dual gate is non-negotiable and is the single most valuable asset in the
repository** (audit §3). It carries over unchanged in mechanism:

1. **Policy engine** (`packages/authz`) — pure, total, testable without a
   database. Decides `allow`/`deny` for `(actor, action, resource)`.
2. **Row Level Security** — `FORCE ROW LEVEL SECURITY` on every tenant table;
   the application connects as a NOBYPASSRLS role and sets `app.actor_id`.

New resource kinds: `automation`, `spec_version`, `deployment`, `run`,
`connection`, `trigger`, `workspace_member`.
New actions include `automation:read|write`, `spec:propose|read`,
`spec:approve`, `deployment:promote|rollback`, `run:read|trigger|cancel`,
`connection:create|attach|rotate|delete`, `trigger:manage`.

Two policies that must be written as policies, not as UI:

- `spec:approve` **denies when `actor.id === specVersion.createdBy`.**
- `deployment:promote` to `production` requires the target spec version to have
  an approval **and** a successful staging run — a data condition the policy
  engine reads from the resource, never from the request.

### The rule that makes the second gate real

Every deny must be provable with the other gate removed. The education platform
has the roles for this (`edu_app_norls` BYPASSRLS) and the tests that use them.
**Any new tenant table without an RLS policy is a failure of this spec**, and
the fitness test that enumerates tables and asserts each has `FORCE ROW LEVEL
SECURITY` plus at least one policy is the mechanism that catches it.

## 4. Secrets handling rules (binding)

1. No secret value is ever printed, logged, hashed-for-display, length-reported,
   or prefix-reported. Status vocabulary is exactly **PRESENT / ABSENT /
   UNAVAILABLE TO THIS RUNTIME**.
2. No credential belonging to the operator's own tooling or CI environment is
   ever used as an application credential.
3. Configuration is fail-fast: a named provider without a credential **refuses
   to boot**. Weakening validation to make a boot succeed is prohibited.
4. Every environment variable the app reads is in the `CONFIG_KEYS` allow-list
   _and_ the schema, and a fitness test asserts the two agree (VULN-037).
5. Connector credentials are referenced by `connectionRef`, never by value, at
   every layer: spec, plan, queue message, log, run record.

## 5. Data classification

| Class                | Examples                                                        | At rest                        | In logs                          | To AI provider                        |
| -------------------- | --------------------------------------------------------------- | ------------------------------ | -------------------------------- | ------------------------------------- |
| **Secret**           | connection credentials, webhook signing keys, session tokens    | envelope-encrypted, KMS master | never                            | never                                 |
| **Sensitive tenant** | run payloads, connector responses, spec bodies                  | DB, RLS-protected              | redacted, structured fields only | **never**                             |
| **Tenant metadata**  | automation names, run status, timings, cost                     | DB, RLS-protected              | yes                              | never                                 |
| **Public**           | step vocabulary, connector capability declarations, error kinds | DB / code                      | yes                              | yes (this is what the model is given) |

## 6. Audit and non-repudiation

An **append-only ledger** covers: spec version creation (with author and whether
AI-proposed), validation findings, approval (approver, timestamp, the diff hash
they saw), deployment and rollback, credential create/rotate/delete (never the
value), run start/end/outcome/cost, and every security event.

Append-only is enforced at the database level (no `UPDATE`/`DELETE` grants for
the application role on ledger tables), not by convention — the same reason RLS
is used rather than careful `WHERE` clauses.

## 7. Known unknowns (OPEN RISK, not hand-waved)

| ID          | Open risk                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN-SEC-01 | The sandbox technology is not chosen (ADR-0102 records the decision _frame_, not a verified choice). Isolation strength is therefore **UNVERIFIED**.              |
| OPEN-SEC-02 | No KMS exists in this environment. Envelope encryption's root of trust is undecided and unimplemented.                                                            |
| OPEN-SEC-03 | No AI credential exists (audit §5), so THREAT-AI-03's wire-level assertion cannot be exercised against a real provider. Unchanged from Task 015's BLOCKED result. |
| OPEN-SEC-04 | Egress control depends on the deployment substrate (§I). Without a chosen substrate, THREAT-EXEC-03's control is a requirement, not a design.                     |
| OPEN-CI-01  | CI does not run the `web` or `evaluation` projects (audit §6). Carried forward; must be fixed in the first implementation phase.                                  |

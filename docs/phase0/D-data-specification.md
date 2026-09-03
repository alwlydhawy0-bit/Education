# D. Data Specification

**Phase 0 deliverable. No implementation, no migrations written.**
This is the intended shape, the invariants it must carry, and the reasons.

---

## 1. Principles carried over from the existing platform

These are not restated for form's sake — each one already has a migration
pattern and a test pattern in this repository, and reusing them is most of why
ADR-0100 chose reuse.

1. **Every tenant table has `FORCE ROW LEVEL SECURITY` and at least one
   policy.** 136 policies across 11 migrations already do this. A fitness test
   enumerates tables and fails on any that lacks it.
2. **The application connects as a NOBYPASSRLS role** and sets `app.actor_id`
   per transaction (`db.withActor`). A second role with BYPASSRLS exists **only
   so tests can prove the policy engine denies without RLS's help.**
3. **Hand-written, forward-only SQL migrations.** No ORM-generated schema. 23
   exist; automation tables continue the sequence.
4. **Soft delete interacts with RLS deliberately** (ADR-0007): deleted rows stay
   visible to nothing by default.
5. **Timestamps are `timestamptz`, always UTC.** Scheduling makes this
   load-bearing rather than stylistic.

## 2. Entity model

```
workspace 1─┬─* workspace_member ──* (user)
            ├─* connection ───────* connection_version   (secret material)
            ├─* automation 1─┬─* spec_version (immutable)
            │                │      └─1 compilation (immutable)
            │                │      └─* approval (immutable)
            │                ├─* deployment (append-only) ──► spec_version
            │                └─* trigger
            ├─* run (append-only) ──* step_attempt (append-only)
            └─* security_event / audit_entry (append-only)
```

## 3. Tables

Types are indicative. `ws` = `workspace_id uuid not null` — the RLS anchor
present on **every** tenant table, including child tables where it is
denormalized on purpose so a policy never needs a join.

### Tenancy

| Table               | Key columns                                         | Notes                                       |
| ------------------- | --------------------------------------------------- | ------------------------------------------- |
| `workspaces`        | `id`, `name`, `status`, `created_at`                | The isolation root                          |
| `workspace_members` | `ws`, `user_id`, `role`, `invited_by`, `created_at` | Role is one of §A.3. Unique `(ws, user_id)` |

### Authoring

| Table              | Key columns                                                                                                                           | Invariants                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `automations`      | `id`, `ws`, `name`, `created_by`, `archived_at`                                                                                       | Holds no behaviour                                                                                                                                                |
| `spec_versions`    | `id`, `ws`, `automation_id`, `version_no`, `content_hash`, `ir jsonb`, `origin` (`ai`\|`human`\|`import`), `created_by`, `created_at` | **Immutable.** No `UPDATE`/`DELETE` grant. Unique `(automation_id, version_no)` and `(automation_id, content_hash)`                                               |
| `spec_validations` | `id`, `ws`, `spec_version_id`, `validator_version`, `findings jsonb`, `verdict`, `created_at`                                         | Append-only; a version may be re-validated by a newer validator                                                                                                   |
| `compilations`     | `id`, `ws`, `spec_version_id`, `compiler_version`, `plan jsonb`, `plan_hash`, `created_at`                                            | **Immutable.** Unique `(spec_version_id, compiler_version)` — determinism is checkable: recompiling must reproduce `plan_hash`                                    |
| `approvals`        | `id`, `ws`, `spec_version_id`, `approved_by`, `diff_hash`, `approved_at`                                                              | **Immutable.** `approved_by <> spec_versions.created_by` enforced by a CHECK-backed trigger **and** by policy — the dual-gate habit applied to separation of duty |

### Deployment

| Table         | Key columns                                                                                                                                 | Invariants                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployments` | `id`, `ws`, `automation_id`, `environment`, `spec_version_id`, `compilation_id`, `deployed_by`, `deployed_at`, `superseded_at`              | Append-only. **Rollback inserts a row**, it never updates one. The current deployment is the row with `superseded_at is null`; a partial unique index on `(automation_id, environment) where superseded_at is null` makes "exactly one live deployment" a database fact |
| `triggers`    | `id`, `ws`, `automation_id`, `environment`, `kind` (`schedule`\|`webhook`\|`manual`), `config jsonb`, `secret_ref`, `enabled`, `created_at` | `secret_ref` points at the vault; the signing key is never a column here                                                                                                                                                                                                |

### Execution

| Table           | Key columns                                                                                                                                                                                | Invariants                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs`          | `id`, `ws`, `automation_id`, `deployment_id`, `environment`, `trigger_kind`, `idempotency_key`, `status`, `queued_at`, `started_at`, `finished_at`, `outcome`, `error_kind`, `cost_micros` | Append-only except a narrow status/outcome transition. Unique `(ws, idempotency_key)` where the key is present — this is what makes webhook replay safe |
| `step_attempts` | `id`, `ws`, `run_id`, `step_id`, `attempt_no`, `status`, `started_at`, `finished_at`, `error_kind`, `request_digest`, `response_digest`, `cost_micros`                                     | **Retries insert; nothing is overwritten.** Digests, not bodies (§5)                                                                                    |
| `run_payloads`  | `run_id`, `ws`, `kind`, `body jsonb`, `expires_at`                                                                                                                                         | Separated so retention can be short and independent of the ledger                                                                                       |

### Queue (ADR-0103 — the queue is a table)

| Table            | Key columns                                                                                                         | Notes                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue_messages` | `id`, `ws`, `run_id`, `available_at`, `leased_until`, `lease_token`, `attempts`, `max_attempts`, `dead_lettered_at` | Leasing is `UPDATE ... WHERE available_at <= now() AND leased_until IS NULL ... FOR UPDATE SKIP LOCKED RETURNING`. Carries **no plan and no secret** |

`SKIP LOCKED` is the whole reason a Postgres queue is viable here; it is named
in the spec because a future reader must not "optimize" it into a plain
`SELECT`.

### Credentials

| Table                 | Key columns                                                                                                                               | Notes                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `connections`         | `id`, `ws`, `connector`, `name`, `environment`, `created_by`, `created_at`, `revoked_at`                                                  | **No secret material.** Environment-scoped so a test deployment cannot resolve a production connection                |
| `connection_versions` | `id`, `ws`, `connection_id`, `version_no`, `ciphertext bytea`, `wrapped_dek bytea`, `kms_key_id`, `algorithm`, `created_at`, `retired_at` | Envelope encryption. Rotation inserts; nothing is updated in place                                                    |
| `credential_grants`   | `id`, `ws`, `run_id`, `step_id`, `connection_id`, `issued_at`, `expires_at`                                                               | The broker's ledger: every credential release is a row. If this table has no row, the credential was never handed out |

### Audit

| Table             | Notes                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `audit_entries`   | Append-only. Actor, action, resource, correlation id, before/after **hashes** for spec-shaped changes |
| `security_events` | The existing typed mechanism from `packages/observability`, extended with automation event types      |

## 4. Retention

| Data                                                   | Retention                                                       | Why                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Ledger (runs, attempts, approvals, deployments, audit) | long (years), configurable                                      | This is the record of what the platform did                                                               |
| `run_payloads`                                         | short (days), per-workspace configurable                        | The highest-sensitivity, lowest-value-over-time data. A payload table is where a breach becomes expensive |
| `queue_messages`                                       | until ack + a short tail                                        | Not a log                                                                                                 |
| `connection_versions` (retired)                        | until rotation is confirmed everywhere, then destroy ciphertext | Retired secrets are liability                                                                             |

**Payload retention is a product setting, not a constant**, and the default is
the short one. Choosing the safe default is cheap now and impossible later.

## 5. What is stored about a step, and what is not

A step attempt stores: which step, which attempt, when, outcome, a **normalized
error kind**, cost, and a **digest** of request and response.

It does **not** store request or response bodies by default. Bodies go to
`run_payloads` only when the workspace has enabled payload capture for that
environment, and never for fields a connector declares as secret.

The reason is the one Task 014 wrote down: a vendor's own error text is
vendor-shaped and can echo fragments of the request. Storing a digest keeps
debugging possible ("the same request as attempt 1") while keeping the blast
radius of a database read bounded.

## 6. Indexing and the queries that matter

| Query                                         | Index                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Lease next runnable message                   | `(available_at) where leased_until is null and dead_lettered_at is null` partial |
| Live deployment for (automation, environment) | partial unique `(automation_id, environment) where superseded_at is null`        |
| Runs for an automation, newest first          | `(ws, automation_id, queued_at desc)`                                            |
| Attempts for a run                            | `(run_id, step_id, attempt_no)`                                                  |
| Idempotency check                             | unique `(ws, idempotency_key)`                                                   |
| Due schedules                                 | `(next_fire_at) where enabled`                                                   |

Every one of these indexes carries `workspace_id` in the leading position where
the query is tenant-scoped, so RLS and the index agree rather than fight.

## 7. Migration discipline

- Forward-only, hand-written, reviewed as security artifacts (they define RLS).
- One migration = one coherent change; a migration that adds a tenant table
  **must** add its RLS policies in the same file, because a table that is
  unprotected for one deploy is unprotected.
- The existing `db:migrate --reset` globalSetup means overlapping test runs
  corrupt each other. That is a known operational hazard, already documented,
  and it constrains CI parallelism (§H, §I).

## 8. Open data risks

| ID           | Risk                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| OPEN-DATA-01 | `plan jsonb` may be large; storing it inline versus in object storage is undecided and depends on real plan sizes, which do not exist yet |
| OPEN-DATA-02 | Whether `runs` needs partitioning by time is unknown without volume data. Designing partitioning now would be speculation                 |
| OPEN-DATA-03 | Envelope encryption's key hierarchy depends on a KMS that this environment does not have (OPEN-SEC-02)                                    |

# E. API Specification

**Phase 0 deliverable. No implementation.** Routes below are a contract sketch;
none exists.

---

## 1. Conventions carried over unchanged

These already exist in `apps/api/src/platform/http` and are reused rather than
redesigned:

- **Error envelope**: `{ error: { code, message, correlationId, details? } }`.
  `code` is from a closed enum; `message` is **server-authored**, never a
  framework's or a vendor's text. Only status is taken from framework errors.
- **Validation**: Zod `.strict()` on every body, query and param. Unknown fields
  are an error, not ignored. Validation failures return field paths and Zod
  issue codes — safe, because they describe the caller's own input.
- **Auth**: opaque server-side session cookie; CSRF protection on unsafe
  methods; `SameSite` + `Secure` in hardened environments.
- **Authorization**: every route calls the policy engine explicitly. There is no
  "authorized because it's under `/admin`". RLS is the second gate underneath.
- **404 over 403 for existence-revealing resources.** "No such automation",
  "another workspace's", and "archived" are one answer, as they already are for
  lessons.
- **Rate limiting**: per-actor and per-route, existing mechanism.
- **Correlation id** on every request and every log line.

## 2. Route map

`{ws}` is a workspace id; every route below is workspace-scoped and every one is
authorized against the policy engine before anything else happens.

### Automations & versions

| Method | Path                                                          | Action             | Notes                                                                                                                      |
| ------ | ------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/w/{ws}/automations`                                         | `automation:write` |                                                                                                                            |
| `GET`  | `/w/{ws}/automations`                                         | `automation:read`  | paginated, cursor                                                                                                          |
| `GET`  | `/w/{ws}/automations/{id}`                                    | `automation:read`  |                                                                                                                            |
| `POST` | `/w/{ws}/automations/{id}/versions/propose`                   | `spec:propose`     | **The only AI route.** Body: `{prompt, baseVersionId?}`. Returns a draft spec version + validator findings. Never deploys. |
| `POST` | `/w/{ws}/automations/{id}/versions`                           | `spec:propose`     | Human-authored/edited IR. Same validator, same gates.                                                                      |
| `GET`  | `/w/{ws}/automations/{id}/versions/{vid}`                     | `spec:read`        |                                                                                                                            |
| `GET`  | `/w/{ws}/automations/{id}/versions/{vid}/diff?against={vid2}` | `spec:read`        | What an approver reads                                                                                                     |
| `POST` | `/w/{ws}/automations/{id}/versions/{vid}/validate`            | `spec:read`        | Re-run validation with the current validator                                                                               |

### Approval & deployment

| Method | Path                                              | Action                | Notes                                                                                                                  |
| ------ | ------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/w/{ws}/automations/{id}/versions/{vid}/approve` | `spec:approve`        | Body **must** include `diffHash` the approver saw. Mismatch → 409. Denied if `actor.id == createdBy`.                  |
| `POST` | `/w/{ws}/automations/{id}/deployments`            | `deployment:promote`  | Body `{environment, specVersionId}`. Production requires an approval and a successful staging run.                     |
| `POST` | `/w/{ws}/automations/{id}/deployments/rollback`   | `deployment:rollback` | Body `{environment, toDeploymentId}`. Inserts a new deployment row. No new approval — the target was already approved. |
| `GET`  | `/w/{ws}/automations/{id}/deployments`            | `automation:read`     | Full history, append-only                                                                                              |

`diffHash` deserves its sentence: an approval that does not name what was
approved is not evidence of anything. Requiring the hash the approver's screen
rendered makes "the spec changed between render and click" a 409 rather than a
silent authorization of different behaviour.

### Triggers & runs

| Method | Path                                | Action           | Notes                                                                                                         |
| ------ | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST` | `/w/{ws}/automations/{id}/triggers` | `trigger:manage` | schedule / webhook / manual                                                                                   |
| `POST` | `/w/{ws}/automations/{id}/runs`     | `run:trigger`    | Manual run. Environment from body; policy decides which environments this actor may trigger.                  |
| `GET`  | `/w/{ws}/runs`                      | `run:read`       | Filter by automation, environment, status, time                                                               |
| `GET`  | `/w/{ws}/runs/{runId}`              | `run:read`       | Includes step attempts                                                                                        |
| `POST` | `/w/{ws}/runs/{runId}/cancel`       | `run:cancel`     | Best-effort: sets a cancel flag the worker checks between steps; **never claims a step in flight was undone** |

### Connections (credentials)

| Method   | Path                              | Action              | Notes                                                                                               |
| -------- | --------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `POST`   | `/w/{ws}/connections`             | `connection:create` | Secret in body, over TLS, written straight to the vault. **Never echoed.**                          |
| `GET`    | `/w/{ws}/connections`             | `connection:read`   | Metadata only: connector, name, environment, created, last rotated. No value, no prefix, no length. |
| `POST`   | `/w/{ws}/connections/{id}/rotate` | `connection:rotate` | Inserts a new `connection_version`                                                                  |
| `DELETE` | `/w/{ws}/connections/{id}`        | `connection:delete` | Revokes; refuses if a live deployment references it, with the list of blockers                      |

### Webhook ingress — a different surface entirely

| Method | Path                     | Notes                                                                                                                                                    |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/ingress/t/{triggerId}` | **Unauthenticated by session. Authenticated by HMAC signature over the raw body with the trigger's secret, plus a timestamp window and a replay cache.** |

This route is deliberately outside the `/w/{ws}` tree because it obeys different
rules and must be read as such. It:

- reads the **raw body** for signature verification before any parsing;
- enforces a hard body size cap before that;
- rate-limits per trigger and per workspace before any write beyond a counter;
- returns `202` with no detail on success and an indistinguishable `202` for a
  disabled trigger — a webhook endpoint that reports _why_ it declined is an
  oracle for enumerating triggers;
- creates **one** run per `(triggerId, delivery id)` via the idempotency unique
  index; a replay is a no-op, not a second run.

### Platform

| Method | Path            | Notes                                          |
| ------ | --------------- | ---------------------------------------------- |
| `GET`  | `/health`       | liveness, no auth, no detail                   |
| `GET`  | `/ready`        | DB + queue reachability, no auth, boolean only |
| `GET`  | `/w/{ws}/usage` | run counts, cost, per environment              |

## 3. The internal worker API

The worker is a client of a **separate, narrow surface**, authenticated by a
run-scoped token, not by a session. It is specified here because "internal" is
not a security property.

| Method | Path                                 | Notes                                                                                                                                                                        |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/internal/runs/{runId}/plan`        | Returns the compiled plan. Token must match this run. Read-only.                                                                                                             |
| `POST` | `/internal/runs/{runId}/credentials` | Body `{stepId, connectionRef}`. **The broker.** Returns a short-lived credential only if the plan's step actually references it. Every release is a `credential_grants` row. |
| `POST` | `/internal/runs/{runId}/attempts`    | Report a step attempt. Append-only.                                                                                                                                          |
| `POST` | `/internal/runs/{runId}/complete`    | Terminal outcome. Idempotent by `(runId, leaseToken)`.                                                                                                                       |

Properties this surface must have, each testable:

1. A token for run A cannot read run B — not the plan, not a credential, not the
   attempts. (Assert with a valid token and a foreign `runId`.)
2. A token cannot request a credential the plan does not reference.
3. A token expires with the lease; a worker that lost its lease cannot report.
4. Nothing on this surface accepts a workspace id from the caller. Workspace is
   derived from `runId` server-side. This is THREAT-TEN-02 expressed as a route
   rule.

## 4. Versioning

- URL-versionless; the **contract** is versioned by additive-only evolution and
  strict schemas, exactly as the existing API does it.
- The **spec IR** is versioned explicitly (`irVersion`) inside the document,
  because it outlives any HTTP call and must be readable years later.
- The **compiler** is versioned and recorded on every compilation, so a plan is
  always attributable to a compiler.

## 5. Idempotency

- Every mutating route accepts `Idempotency-Key`; keys are per-workspace and
  stored with the response hash.
- Run creation always has a key: manual runs generate one, schedules derive one
  from `(triggerId, fireTime)`, webhooks derive one from the delivery id. This
  is what makes "the scheduler fired twice" harmless.

## 6. What the API must never do

- Return a credential value, prefix, length, or hash.
- Return a vendor error message or a stack trace.
- Accept a workspace id as authority (it is a _path segment used for lookup_,
  then checked; it is never the source of truth for who the caller is).
- Auto-approve, auto-deploy, or auto-promote as a side effect of any route.
- Let a query parameter select the database role, the environment's credentials,
  or the policy set.

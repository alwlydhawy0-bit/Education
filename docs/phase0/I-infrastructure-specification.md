# I. Infrastructure Specification

**Phase 0 deliverable. No implementation.**
Honest starting position, from the audit: **there is no API deployment today.**
`vercel.json` builds the web client only. CI has no deploy stage, no
migration-validation stage, and no smoke test. Everything below is therefore
design, and the substrate decision is **OPEN** (ADR-0102, ADR-0108).

---

## 1. Deployable units

| Unit                            | Trust             | Scaling                          | Holds                                                 |
| ------------------------------- | ----------------- | -------------------------------- | ----------------------------------------------------- |
| `web`                           | none              | CDN                              | static assets                                         |
| `apps/api` (control plane)      | trusted           | horizontal, stateless            | DB credentials, KMS access, policy engine             |
| `apps/worker` (execution plane) | **untrusted**     | horizontal, per-workspace-capped | one run at a time per isolate                         |
| PostgreSQL 16                   | trusted           | vertical + read replicas later   | everything, including the queue                       |
| KMS                             | trusted, external | n/a                              | the master key (**does not exist yet** — OPEN-SEC-02) |

Three processes, one database. That is the whole topology, and keeping it that
small is a deliberate choice: every additional stateful component is another
thing to secure, back up, and reason about during an incident.

## 2. The substrate requirement, stated as requirements not as a product

The execution plane's isolation is the thing the platform's safety rests on, and
Phase 0 does **not** pick a technology, because picking one without measuring it
would be exactly the "declared secure" failure §58 forbids. What Phase 0 does
fix is the requirement set any candidate must satisfy:

| #   | Requirement                                                                         | Why                                                                                                        |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| I1  | Per-run process/kernel isolation with no shared writable filesystem                 | one isolate per run (§G.5)                                                                                 |
| I2  | Explicit, closed environment injection — no host env inheritance                    | THREAT-EXEC-04                                                                                             |
| I3  | Egress default-deny with a **per-run** allow-list, enforced below the application   | THREAT-EXEC-03; an application-level allow-list is bypassed by the first library that opens its own socket |
| I4  | Cloud instance-metadata endpoint unreachable from the isolate                       | THREAT-EXEC-04                                                                                             |
| I5  | Hard CPU, memory, PID, file-descriptor and wall-clock limits                        | THREAT-EXEC-02                                                                                             |
| I6  | Cold start fast enough that per-run isolation is affordable                         | otherwise the safe design gets abandoned for a pooled one                                                  |
| I7  | The control plane's database port is unreachable from the execution plane's network | B1, THREAT-EXEC-01                                                                                         |

Candidates that satisfy some of these (containers with a per-run network
namespace and a filtering egress proxy; microVMs; a gVisor-class sandbox) are
listed in ADR-0102 with their trade-offs. **The decision is deferred to Phase 1
with a mandatory measurement**: I6 must be measured, and I3/I4 must be
demonstrated by an execution-plane test that fails when the control is removed
(§H), before any isolation claim is made.

## 3. Networking

```
internet ──► CDN ──► web (static)
internet ──► API (TLS, WAF/rate limit) ──► Postgres  :5432   [private]
                                       └─► KMS               [private]
worker ──► API /internal only          (mTLS or signed run token, private network)
worker ──► egress proxy ──► allow-listed connector hosts only
worker ──✗──► Postgres, KMS, metadata endpoint, the public internet at large
```

The **egress proxy** is the enforcement point for I3. It is drawn as a separate
box because the allow-list has to live somewhere the run cannot edit; a run that
enforces its own egress policy enforces nothing.

## 4. Secrets and configuration

Rules, binding, carried over:

1. All configuration through `platform/config` — parsed once, fail-fast, and
   the process refuses to start on anything missing or malformed.
2. Every key in **both** the schema and `CONFIG_KEYS`, with a fitness test
   asserting they agree (VULN-037).
3. `toPublicConfig` is the only path to the browser, and `assertNoPrivateLeakage`
   runs at startup.
4. No default that reaches the network. `AI_BASE_URL` is pinned in code, never
   inherited from ambient env (VULN-038). The same rule applies to every
   connector's base URL.
5. Secret status vocabulary is **PRESENT / ABSENT / UNAVAILABLE**. No prefix, no
   length, no hash, no env dump — in logs, in reports, or in chat.
6. The worker's environment is an explicit closed map (I2), and the map's key
   set is asserted by a test.

Current environment reality (audit §5): `DATABASE_URL` PRESENT;
`AI_API_KEY`/`ANTHROPIC_API_KEY` **ABSENT**; `REDIS_URL` ABSENT;
`STRIPE_SECRET_KEY` ABSENT; `AWS_ACCESS_KEY_ID` PRESENT **as an ambient
container variable the application does not read** — which is precisely why
THREAT-EXEC-04 exists.

## 5. Database operations

- Migrations run as a **separate, gated CI stage** before the API rolls, not on
  application boot. An app that migrates on boot migrates N times under a rolling
  deploy.
- Forward-only. Expand/contract for anything destructive: add, backfill, switch
  reads, then drop in a later release.
- The application role is **NOBYPASSRLS**. A BYPASSRLS role exists only for tests
  and never appears in a deployed configuration — a config fitness test can
  assert that.
- Ledger tables have no `UPDATE`/`DELETE` grant for the application role (§D.6).
  Append-only enforced by grant, not by convention.
- Backups: point-in-time recovery. **Restore is rehearsed on a schedule**; a
  backup that has never been restored is a belief, not a control.

## 6. Observability

Reuse `packages/observability` (structured logging with secret redaction, typed
security events) and add:

| Signal            | Content                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Run metrics       | queued/started/finished counts, duration, cost, per workspace and environment                                      |
| Queue metrics     | depth, oldest available age, lease expiries, dead-letter rate                                                      |
| Connector metrics | latency, error kind distribution, rate-limit hits, per connector                                                   |
| AI metrics        | proposal count, validation-rejection rate, tokens, cost                                                            |
| Security events   | the existing typed mechanism, extended (broker denials, forged-token attempts, egress denials, signature failures) |

Alerts worth waking someone for: dead-letter rate above baseline, oldest queued
age beyond SLO, egress denial spikes (an egress denial is a _policy working_,
but a spike is a signal), broker denials, and any cross-tenant deny at the RLS
layer — because RLS denying means the policy engine already failed.

Every log line and every run carries the correlation id, as the existing HTTP
layer already does.

## 7. Environments

| Environment | Data                     | Credentials                                 | Runs         |
| ----------- | ------------------------ | ------------------------------------------- | ------------ |
| development | synthetic                | developer's own sandbox connections         | local worker |
| test (CI)   | ephemeral, reset per run | none real                                   | in-CI worker |
| staging     | real-shaped, not real    | staging connections, separate vault entries | full         |
| production  | real                     | production connections                      | full         |

Staging is configured **as hardened as production** — that is already how
`HARDENED_ENVIRONMENTS` in `platform/config` treats it, deliberately, because
"we'll tighten it before launch" is where safety goes to die.

## 8. CI/CD target

```
PR:    lint → typecheck → unit + architecture + web
            → migrate --reset → integration → security → execution → evaluation
            → secret scan → CodeQL
main:  the above → build images → migrate (gated) → deploy api → deploy worker
            → smoke test → (auto-rollback on smoke failure)
```

Gaps between this and reality, all recorded as open:

| ID            | Gap                                                                  |
| ------------- | -------------------------------------------------------------------- |
| OPEN-CI-01    | `web` and `evaluation` projects are not in CI today                  |
| OPEN-CI-02    | No deploy stage exists for the API at all                            |
| OPEN-CI-03    | No migration-validation stage                                        |
| OPEN-CI-04    | No smoke test, therefore no auto-rollback trigger                    |
| OPEN-INFRA-01 | No substrate chosen; I1–I7 are requirements with no implementation   |
| OPEN-INFRA-02 | No KMS; envelope encryption has no root of trust yet                 |
| OPEN-INFRA-03 | Backup/restore untested because there is nothing deployed to back up |

## 9. Cost and capacity

Recorded as unknowns rather than guessed:

- Per-run infrastructure cost depends entirely on the §2 substrate decision and
  I6's measurement.
- Queue throughput ceiling is an **estimate** (order of hundreds of leases/second
  on a single primary), not a measurement (OPEN-EXEC-02).
- AI proposal cost is bounded per workspace by budget (§F.8) but its real
  distribution is unknown with no traffic and no credential.

None of these numbers should appear in a plan as if they were measured.

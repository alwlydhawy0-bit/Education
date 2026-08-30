# Threat Model — Task 001 Baseline

**Date:** 2026-08-30 · **Scope:** the foundation as built, plus designed-but-unbuilt
surfaces named explicitly as such.

> This is a _baseline_, not a completed threat model. It covers the three domains
> that exist (identity, relationships, notebook) in depth, and sketches the
> surfaces that do not exist yet so they are not forgotten. No automated or
> AI-assisted review can establish that a system is secure; this document records
> what was considered, what was tested, and what was not.

Status markers match the architecture report: **[BUILT]** (implemented and
tested), **[BUILT, UNTESTED]**, **[DESIGNED]** (no code), **[OPEN]** (undecided).

---

## 1. Assets

| Asset                                      | Sensitivity                                        | Exists today        |
| ------------------------------------------ | -------------------------------------------------- | ------------------- |
| Student notebook content                   | High — a minor's private working thoughts          | Yes                 |
| Authentication credentials                 | Critical                                           | Yes                 |
| Session tokens                             | Critical                                           | Yes                 |
| User profiles (email, name, org)           | High — minors' PII                                 | Yes                 |
| Guardian / teacher relationship edges      | High — they _are_ access grants                    | Yes                 |
| Audit log                                  | High — integrity matters more than confidentiality | Yes                 |
| Role assignments                           | Critical — the escalation target                   | Yes                 |
| Grades, mastery, assessments               | High                                               | No — **[DESIGNED]** |
| Student uploads                            | High, and actively hostile input                   | No — **[DESIGNED]** |
| AI conversations                           | High                                               | No — **[DESIGNED]** |
| Curriculum content                         | Moderate (integrity ≫ confidentiality)             | No — **[DESIGNED]** |
| Platform secrets (DB creds, provider keys) | Critical                                           | Partially           |

## 2. Threat actors

| Actor                       | Capability assumed                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unauthenticated attacker    | Full API access, can enumerate ids, automate                                                         |
| Malicious student           | A valid session; will try every id and every field                                                   |
| Compromised student account | Same as above, but the victim is a real user                                                         |
| Malicious teacher           | A valid privileged session, a _legitimate_ relationship to some students, and curiosity about others |
| Malicious guardian          | A valid session and a real link to one student                                                       |
| Privileged insider (admin)  | Database and application access                                                                      |
| Automated attacker          | Credential stuffing, scraping, DoS                                                                   |
| Malicious uploaded document | Code execution, parser exploits, stored XSS                                                          |
| Prompt-injection attacker   | Content that reaches an LLM context                                                                  |

## 3. Trust boundaries

```
  Internet
    │  (1) unauthenticated HTTP
    ▼
  Fastify: origin guard → rate limit → session resolution
    │  (2) actor established from server state only
    ▼
  Domain services: policy engine + Guarded<T>
    │  (3) every query runs inside withActor(), app.actor_id set transaction-LOCAL
    ▼
  PostgreSQL as edu_app (NOBYPASSRLS) — RLS applies
    │  (4) the pre-auth boundary: 5 SECURITY DEFINER functions
    ▼
  Tables owned by edu_migrator (non-superuser)
```

Boundary (3) is the one most often broken in practice, and it is why
`platform/db.ts` exports no pool and no `query` — a handle can only be obtained
through `withActor`/`withoutActor`.

---

## 4. Threats

### T1 — IDOR / BOLA (horizontal privilege escalation)

- **Attack surface:** every route taking an `:id`.
- **Boundaries:** contract validation, policy engine, `Guarded<T>`, RLS.
- **Mitigations [BUILT]:** ownership never accepted from the client (no such
  field exists, and schemas are `.strict()`); `Guarded.unwrap` re-verifies the
  decision matches the resource id _and_ action; RLS returns zero rows for a
  forgotten filter; denials return 404 so existence is not disclosed.
- **Verification:** `tests/security/idor.test.ts` (14) — read/update/delete/list
  by exact id as another student, plus an oracle test proving a real-but-
  forbidden note is indistinguishable from a nonexistent one.
  `tests/integration/rls.test.ts` (24) — the same attacks straight at the
  database. `tests/security/layered-defense.test.ts` (4) — the same attacks with
  RLS bypassed, proving the application layer stands alone.
- **Residual risk:** only the `notebook` domain exists. Every future domain must
  repeat this pattern; the fitness test enforces the `Guarded` return type for
  `notebook` but cannot yet enforce it for domains that do not exist.

### T2 — Vertical privilege escalation

- **Attack surface:** registration, profile update, any future role management.
- **Mitigations [BUILT]:** registration contract has no `roles` field and is
  strict; `edu_app` has **no INSERT/UPDATE/DELETE privilege on `user_roles`**;
  the only writing function hardcodes `'student'`; an RLS policy independently
  constrains that insert to `role = 'student'`.
- **Verification:** direct `INSERT INTO user_roles … 'admin'` as the application
  role fails with _permission denied_ (`rls.test.ts`); registering with
  `roles: ['admin']` returns 400; a freshly registered user has exactly
  `['student']`.
- **Residual risk:** no legitimate role-granting path exists, so the _audited_
  version of it is unwritten and unmodelled.

### T3 — Account takeover

- **Mitigations [BUILT]:** Argon2id with pinned OWASP parameters; login rate
  limited to 10 per 15 minutes per IP; opaque tokens stored only as SHA-256;
  immediate server-side revocation; identical 401 for every failure mode; a real
  Argon2 verification even for unknown accounts, to flatten timing.
- **Verification:** `session-hardening.test.ts` — identical responses for unknown
  account vs. wrong password; suspended accounts refused without saying why; the
  raw token proven absent from the database; revocation effective immediately.
- **Residual risk [OPEN]:** no MFA. No account-lockout (rate limiting only). No
  password-breach corpus check. No notification on new-device login.

### T4 — Cross-site request forgery

- **Mitigations [BUILT]:** `SameSite=Strict; HttpOnly; Secure` (Secure forced in
  production by config); plus an `Origin` allow-list check on every
  state-changing method that **rejects a missing Origin** rather than allowing it.
  Defaulting to allow-when-absent is what makes most Origin checks decorative.
- **Verification:** missing Origin → 403; foreign Origin → 403; a near-miss
  (`http://localhost:5173.evil.com`) → 403; safe GET without Origin → 200.

### T5 — Data leakage through errors, logs, or responses

- **Mitigations [BUILT]:** the error handler returns a stable code and a
  correlation id only — never a stack, SQL, or driver message; framework 4xx
  errors keep their status instead of becoming a misleading 500; logging is
  redacted centrally with no bypass; `/auth/me` is validated on the way out so an
  accidentally-selected column becomes a 500 rather than a disclosure; the health
  endpoint returns `{status:'ok'}` and nothing else.
- **Verification:** 25 redaction tests; `/auth/me` proven not to contain a hash;
  audit details proven to contain neither the attempted password nor the email.
- **Residual risk:** redaction cannot catch a secret embedded in free text.

### T6 — Malicious uploads · **[DESIGNED] — NOT IMPLEMENTED**

No upload endpoint, no storage, **no malware scanning** exists. Design in
[`file-security.md`](./file-security.md). Until built, this threat is entirely
unmitigated _because the surface does not exist_ — which is a very different
statement from "handled".

### T7 — Prompt injection · **[DESIGNED] — NOT IMPLEMENTED**

No AI code exists. Design in [`ai-security.md`](./ai-security.md). The governing
rule: retrieved content is data, never instructions, and tools are authorized
against the user's actor so an injected instruction cannot exceed the user's own
reach.

### T8 — RAG poisoning / unauthorized retrieval · **[DESIGNED]**

The highest-consequence unbuilt control. **Authorization must filter the
candidate set before similarity search, not after.** Post-filtering leaks through
ranking, counts, and latency. Semantic similarity must never widen access.

### T9 — Denial of service

- **Mitigations [BUILT]:** global 300 req/min per IP; 10 login attempts per 15
  min; 256 KiB body limit; 64 KiB note body cap enforced in both the contract and
  a CHECK constraint; 200-character password ceiling bounding Argon2 work per
  request; 10 s statement timeout; 15 s idle-in-transaction timeout; audit detail
  size-capped at 8 KiB.
- **Verification:** rate limiting produces 429; oversized bodies are rejected.
- **Residual risk [OPEN]:** rate limiting is in-process, so it does not hold
  across replicas. `trustProxy` is false, which is correct for direct exposure but
  **must** be configured together with the proxy when one is introduced —
  otherwise per-IP limits become header-spoofable.

### T10 — Data manipulation / grade tampering

- **Mitigations [BUILT] for what exists:** writes are owner-only at both layers;
  RLS `WITH CHECK` prevents re-parenting a note to another user; server-side
  values are never taken from the client.
- **[DESIGNED]:** grades and mastery do not exist. When they do, they must be
  server-computed, never client-submitted, and mutations must be audited with
  fail-closed semantics (unlike the current audit writer — see below).

### T11 — Audit trail tampering

- **Mitigations [BUILT]:** `edu_app` holds `INSERT` on `audit_log` and nothing
  else — it cannot read, amend, or delete entries. An attacker with arbitrary
  query execution through the application role cannot erase their trail or mine
  the log.
- **Verification:** `SELECT` and `UPDATE` as the application role fail with
  _permission denied_; `INSERT` succeeds.
- **Known weakness [BUILT, deliberate]:** the audit writer is best-effort — a
  write failure is logged but does not fail the request. Correct for auth events
  (a database hiccup should not log a school out), wrong for future
  grade-mutation events, which need a separate fail-closed writer.

### T12 — Privacy violation by a legitimately privileged user

- **Mitigations [BUILT]:** administrators have **no** implicit read access to
  note content — verified for `admin`, `security_admin`, `moderator`, `reviewer`
  and `content_author`, including an actor holding every role at once. Teacher and
  guardian access requires _both_ an explicit student-chosen share _and_ a live
  relationship edge, and teacher access additionally requires an organization
  match so a stale edge cannot survive a transfer.
- **Residual risk:** a database superuser can read everything. Mitigated only by
  operational controls, which are out of scope for this task and unbuilt.

---

## 5. Risk register

| ID                 | Risk                                                  | Severity                        | Status                                                 |
| ------------------ | ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| RISK-ENUM-01       | Registration discloses whether an email is registered | Medium                          | Accepted; rate-limited; needs an email pipeline to fix |
| RISK-UPLOAD-01     | No malware scanning                                   | High                            | Surface does not exist yet                             |
| RISK-RAG-01        | Retrieval could bypass authorization                  | Critical                        | Design only                                            |
| RISK-MFA-01        | No second factor                                      | Medium                          | Open                                                   |
| RISK-RATE-01       | Rate limiting is per-process                          | Medium                          | Open; needs shared state at >1 replica                 |
| RISK-ORG-01        | `notes.organization_id` may go stale on transfer      | Medium                          | Open; no transfer flow exists                          |
| RISK-AUDIT-01      | Audit writes are best-effort                          | Low now, High once grades exist | Accepted for auth events only                          |
| RISK-BREAKGLASS-01 | No audited emergency access path                      | Low                             | Deliberate                                             |

## 6. What was NOT threat-modelled

Honestly and specifically: payments; third-party integrations; mobile clients;
offline sync; real-time/websocket surfaces; email and notification delivery;
backup and restore; key management and rotation; multi-region data residency;
Saudi PDPL compliance specifics; physical and cloud-infrastructure security;
insider threat at the hosting provider; supply-chain compromise of the build
pipeline itself.

None of these are handled. Several will need their own task.

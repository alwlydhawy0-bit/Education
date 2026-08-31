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

### T3a — Stolen refresh token (added in Task 003)

- **Attack surface:** the refresh cookie.
- **Mitigations [BUILT]:** rotation on every use; single-use enforcement in SQL;
  **reuse detection** that revokes the entire session family when an
  already-rotated token is presented; the cookie is path-scoped to the refresh
  endpoint so it is absent from ordinary requests; only the SHA-256 is stored.
- **Verification:** `tests/security/auth-flows.test.ts` proves the replay is
  refused, the victim's still-live session is killed, and
  `auth.refresh.reuse_detected` is recorded.
- **Residual risk:** detection is retrospective — the attacker holds a valid
  token until either party next rotates.

### T3b — Privilege escalation through role administration (added in Task 003)

- **Attack surface:** `POST /admin/users/:id/roles`.
- **Mitigations [BUILT]:** no self-modification of roles by anyone; only
  `security_admin` may grant privileged roles; privileged roles may never be
  granted globally; every grant confined to the actor's own organization;
  `edu_app` holds no write privilege on `user_roles`, so all writes go through an
  audited SECURITY DEFINER function; every grant and revoke is recorded with the
  **operator's** id.
- **Verification:** 12 tests in `tests/security/rbac-authorization.test.ts` and
  the decision table in `tests/unit/rbac-policies.test.ts`.

### T3c — False guardianship (added in Task 003)

- **Attack surface:** `guardian_relationships`.
- **Mitigations [BUILT]:** self-guardianship blocked by a CHECK constraint;
  **self-verification refused for every role**; only a `verified` link grants
  access, and a verified row must record when it was verified; either
  participant may revoke.
- **Update (Task 004):** the workflow now exists — `POST /guardian-links`,
  `/verify`, `/revoke`. A claim is always created `pending` and grants nothing;
  the guardian is taken from the session; **both participants are refused
  verification** (`403`); only an administrator **of the child's own
  organization** may verify, enforced in the policy and in RLS independently
  ([VULN-016](vulnerability-log.md)); either participant may revoke without
  approval. `POST /guardian-links` answers `202` regardless of whether the child
  exists, so it is not an existence oracle for the guardian role.
- **Verification:** 16 cases in `tests/security/relationship-management.test.ts`,
  the cross-school case again in `tests/security/layered-defense.test.ts` with
  RLS disabled, and the write-side policies in
  `tests/integration/rls-relationship-writes.test.ts` with the application out
  of the path.
- **Residual risk:** verification depends entirely on an administrator
  recognising a genuine family relationship. The platform has no way to check
  that claim against anything external, so a compromised or careless school
  administrator can still create a false verified link within their own school.
  Nothing here mitigates that; it is a process control, not a technical one.

### T3d — Self-granted teaching relationships (added in Task 004)

- **Attack surface:** `POST /classes/:id/teachers`, `POST /classes`,
  `POST /classes/:id/members`.
- **Why it matters:** teacher-to-student access is **derived** from a shared
  active class (ADR 0008). Any actor able to create their own assignment, or to
  create a class and enrol students into it, would be granting themselves access
  to those students' shared work.
- **Mitigations [BUILT]:** no teacher may assign anybody to any class, including
  themselves — refused by `teacherAssignmentPolicy` and, independently, by an
  RLS policy requiring `app_actor_is_org_admin()`; an administrator assigning
  _themselves_ is refused (`403`); classes are administrator-only to create and
  reshape; a class cannot move between organizations (trigger, migration 0014);
  the parties of an assignment or membership are immutable (trigger); removal is
  a status change, so ending an assignment or membership revokes derived access
  immediately.
- **Verification:** `tests/security/relationship-management.test.ts` (the named
  §3 scenarios), `tests/integration/rls-relationship-writes.test.ts` (the
  database refusing on its own), `tests/security/layered-defense.test.ts` (the
  application refusing with RLS off).
- **Residual risk:** an administrator of a school can still assign any teacher
  in that school to any class in it. That is the intended authority; the
  boundary is the organization, and there is no smaller unit of trust in the
  model today.

### T3e — Roster enumeration (added in Task 004)

- **Attack surface:** `GET /classes/:id/members`, `GET /classes/:id/teachers`.
- **Why it matters:** a class roster is a list of children, and being able to
  read the class is not a reason to be handed one.
- **Mitigations [BUILT]:** a distinct `class_membership:list` action, refused to
  everyone but a teacher of the class and an administrator of its organization,
  and refused outright if aimed at a single member so it cannot substitute for
  the row-scoped read. An enrolled student gets `404`.
- **Verification:** `relationship-management.test.ts`, `layered-defense.test.ts`
  and five unit cases. Found as [VULN-013](vulnerability-log.md) — the first
  implementation authorized the caller's own membership row and then returned
  everyone's.
- **Residual risk:** the **teacher** roster (`GET /classes/:id/teachers`) is
  readable by anyone who can read the class, students included. That is a
  deliberate choice — knowing who teaches your class is not sensitive — but it
  is a choice, not an oversight, and it is the one asymmetry on this surface.

### T3f — Unauthorized access to unpublished content (added in Task 005)

- **Attack surface:** every `GET` on `/curricula`, `/courses`, `/units`,
  `/lessons`, single and list.
- **Why it matters:** a draft is work in progress — wrong answers, placeholder
  text, material not yet reviewed. A learner reading it is a correctness problem
  before it is a privacy one, and the platform's priority order puts scientific
  integrity above convenience.
- **Mitigations [BUILT]:** `published` is the only learner-visible state;
  `draft` and `archived` both answer `404` rather than `403`, so the id is not
  confirmed; a node is only as visible as its least-visible ancestor, computed
  in SQL and carried on the resource; RLS expresses the same rule independently.
- **Verification:** `tests/security/curriculum.test.ts` (draft, archived and
  partial-chain reads), `tests/integration/rls-content.test.ts` (the database
  alone), `tests/security/layered-defense.test.ts` (the application alone, with
  RLS off — verified to fail when the chain check is removed).
- **Residual risk:** an editor of a school can read every draft in that school.
  There is no per-author or per-team confinement inside an organization, and no
  such unit of trust exists in the model (RISK-CONTENT-03).

### T3g — Cross-organization content leakage (added in Task 005)

- **Attack surface:** the same routes, plus `POST /courses` (which names a
  curriculum id) and the reorder endpoints (which name child ids).
- **Mitigations [BUILT]:** organization content is invisible outside its school
  at both gates; `organizationId` appears in no request body, so a cross-tenant
  write is not expressible; a course may only be filed under a curriculum the
  caller can **see** (application) and one in the global catalog or its own
  school (database trigger); a reorder must name exactly the current set, so it
  cannot reposition or probe an id from elsewhere.
- **Verification:** `curriculum.test.ts` and `curriculum-adversarial.test.ts`,
  plus the RLS-only and application-only suites.
- **Residual risk:** `app_course_organization` and `app_curriculum_organization`
  disclose one fact each — which catalog an id belongs to — to a caller who
  guesses a valid id. Judged not sensitive, and required to keep the policy
  graph acyclic.

### T3h — Unreviewed material reaching a classroom (added in Task 005)

- **Attack surface:** `POST …/publish`.
- **Why it matters:** publishing is the moment content becomes visible to
  children. A compromised teacher account that could also publish would put
  arbitrary material in front of a class with no second person involved.
- **Mitigations [BUILT]:** `content:author` and `content:publish` are separate
  permissions (ADR 0009); a teacher and a content author hold only the first; a
  reviewer holds only the second and cannot edit the text; the split is enforced
  by the policy engine AND by a trigger that compares which columns changed;
  `security_admin` holds neither; every publish emits `content.published` with
  the actor.
- **Verification:** `curriculum.test.ts` (author and teacher refused, reviewer
  allowed), `rls-content.test.ts` (the same with no application code in the
  path), `content-policies.test.ts` (the decision table).
- **Residual risk:** a school with one administrator holding both roles has no
  second person in the loop (RISK-CONTENT-02). That is a staffing fact the
  platform cannot fix; the audit trail records who did it either way.

### T3i — Content reaching learners it was never meant for (added in Task 006)

- **Attack surface:** every `GET` on `/courses`, `/units`, `/lessons`, plus
  `/me/courses` and `/classes/:id/courses`.
- **Why it matters:** publication made content available to a whole school. That
  is the right unit for "may this school use it" and the wrong one for "should
  this child be studying it": a Grade 12 course was reachable by a Grade 7
  learner, and there was no expressible way to say otherwise.
- **Mitigations [BUILT]:** a learner reaches published content only through an
  ACTIVE assignment to an ACTIVE class in which they hold an ACTIVE membership;
  the edge is recomputed per request, never cached; the test runs inside the
  catalog branch so it can only narrow; the same rule is expressed independently
  in RLS and in `contentPolicy`.
- **Verification:** `tests/security/class-courses.test.ts` (end to end),
  `tests/integration/rls-class-courses.test.ts` (the database alone — including
  forcing rows the write path refuses, to prove the READ path defends itself),
  `tests/security/layered-defense.test.ts` (the application alone, with RLS off;
  verified to fail when the class check is removed).
- **Residual risk:** the unit of assignment is the CLASS. Everybody in a class
  sees the same courses; there is no per-learner assignment and no way to give
  one child different material (RISK-ASSIGN-02).

### T3j — Cross-tenant assignment (added in Task 006)

- **Attack surface:** `POST /classes/:id/courses`.
- **Why it matters:** an assignment is the one operation that names a class and
  a course together, so it is the natural place to try to bridge two schools —
  and a successful bridge would hand a whole class another school's private
  content in one request.
- **Mitigations [BUILT]:** the policy refuses both directions (another school's
  class, another school's course) with `hide`, and a database TRIGGER refuses
  the pairing structurally — the trigger is not an RLS policy, so it binds the
  table owner and the superuser too, and the test suite asserts exactly that.
  Only a GLOBAL course may legally cross, which is the shared catalog behaving
  as designed.
- **Verification:** `class-courses.test.ts`, `rls-class-courses.test.ts`,
  `class-course-assignment-policy.test.ts`, and 39 live HTTP checks.
- **Residual risk:** none identified for the bridging case itself. The trigger
  makes the row impossible rather than merely refused, which is the strongest
  form available.

### T3k — Stale access after revocation (added in Task 006)

- **Attack surface:** a live session held by a learner who has just been removed
  from a class, or whose class has just lost a course.
- **Why it matters:** a revocation that takes effect "at next login" is not a
  revocation. Removing a child from a class has to stop their access to that
  class's material immediately, or the control is theatre.
- **Mitigations [BUILT]:** nothing is cached. `coursesViaClasses` is recomputed
  from the database on every request as part of the relationship snapshot, and
  RLS re-evaluates the same four statuses on every query. Withdrawing the
  assignment, ending the membership, archiving the class and archiving the
  course each break the chain on the very next call.
- **Verification:** four end-to-end cases asserting the next request on the SAME
  live session returns 404, and the same again with RLS disabled.
- **Residual risk:** revocation costs a per-request query. That is the price of
  not caching, and it is the right trade here; it is also untested at scale
  (RISK-ASSIGN-03).

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

### T9a — Audit-log flooding (added in Task 002)

- **Attack surface:** any endpoint whose failure writes a durable audit row.
- **Mitigation [BUILT]:** client-driven, high-volume events (`validation.rejected`,
  `payload.too_large`) are recorded **transiently** — log stream only. A durable
  write would let an unauthenticated attacker append rows to the database for
  free. Repeated-denial escalation fires once per window, not per denial, for the
  same reason. `audit_log.detail` is size-capped at 8 KiB.
- **Verification:** a unit test asserts `recordTransient` never reaches the audit
  writer; another asserts escalation happens exactly once per window.

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

| ID                 | Risk                                                                                                              | Severity                        | Status                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| RISK-ENUM-01       | Registration discloses whether an email is registered                                                             | Medium                          | Accepted; rate-limited; needs an email pipeline to fix                 |
| RISK-UPLOAD-01     | No malware scanning                                                                                               | High                            | Surface does not exist yet                                             |
| RISK-RAG-01        | Retrieval could bypass authorization                                                                              | Critical                        | Design only                                                            |
| RISK-MFA-01        | No second factor                                                                                                  | Medium                          | Open                                                                   |
| RISK-RATE-01       | Rate limiting is per-process                                                                                      | Medium                          | Open; needs shared state at >1 replica                                 |
| RISK-ORG-01        | `notes.organization_id` may go stale on transfer                                                                  | Medium                          | Open; no transfer flow exists                                          |
| RISK-AUDIT-01      | Audit writes are best-effort                                                                                      | Low now, High once grades exist | Accepted for auth events only                                          |
| RISK-BREAKGLASS-01 | No audited emergency access path                                                                                  | Low                             | Deliberate                                                             |
| RISK-GUARD-01      | Guardian verification relies on an administrator's judgement; nothing checks the claim against an external source | Medium                          | Accepted; process control, no technical mitigation                     |
| RISK-ORGADMIN-01   | A school administrator has full authority over every class, roster and family link in their school                | Medium                          | Accepted; the organization is the smallest unit of trust in the model  |
| RISK-CONTENT-01    | Lesson bodies are stored verbatim; escaping is the renderer's job, and no renderer exists yet to audit            | Medium                          | Open; HTML is refused as a format, which bounds but does not remove it |
| RISK-CONTENT-02    | A single account holding both content roles publishes with no second person involved                              | Medium                          | Accepted; recorded in the audit trail                                  |
| RISK-CONTENT-03    | Any editor in a school can read every draft in that school                                                        | Low                             | Accepted; no smaller unit of trust exists                              |
| RISK-ASSIGN-01     | A teacher of a class may assign any published course in their school without a second person                      | Low                             | Accepted; the content itself was already reviewed to be published      |
| RISK-ASSIGN-02     | The unit of assignment is the class; no per-learner differentiation exists                                        | Low                             | Accepted; deliberate scope                                             |
| RISK-ASSIGN-03     | Reachability is recomputed per request and never cached; untested at scale                                        | Low                             | Open; correctness chosen over throughput                               |

## 6. What was NOT threat-modelled

Honestly and specifically: payments; third-party integrations; mobile clients;
offline sync; real-time/websocket surfaces; email and notification delivery;
backup and restore; key management and rotation; multi-region data residency;
Saudi PDPL compliance specifics; physical and cloud-infrastructure security;
insider threat at the hosting provider; supply-chain compromise of the build
pipeline itself.

None of these are handled. Several will need their own task.

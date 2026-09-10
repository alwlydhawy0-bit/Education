# Task 015 — School-Wide Analytics & Institutional Reporting Engine

Branch `claude/platform-foundation-architecture-dop21k`. Migrations 0032 and
0033. One new domain, `analytics`.

---

## 1. IMPLEMENTED

**Migration 0032** (778 lines) — two derived tables, three refresh/reader
functions, two mastery helpers, six covering indexes on the source tables, and
the RLS that makes the tenant boundary real.

- `analytics_daily_school_metrics` — one row per school per day.
  `UNIQUE (organization_id, metric_date)`. `average_mastery_score` nullable on
  purpose; counts constrained non-negative; no future dates.
- `analytics_course_performance` — one row per school/class/course.
  `UNIQUE (organization_id, class_id, course_id)`, and the tenant bound by a
  **composite foreign key** to `classes (id, organization_id)`.
- `app_analytics_refresh_daily(org, date)` and
  `app_analytics_refresh_courses(org, threshold)` — `SECURITY DEFINER`, revoked
  from `PUBLIC`, not granted to `edu_app`, bounded by tenant at the top.
- `app_analytics_at_risk(threshold)` — the named-children reader, which
  authorizes itself from `app_actor_teaches_class` inside the definer.
- `app_analytics_authoritative_mastery` — the actor-free sibling of 0021's
  mastery function, with the withholding clause removed and the reason stated.
- `classes` gains `UNIQUE (id, organization_id)`, the only change to another
  domain's schema and additive.

**Migration 0033** — the mastery scale correction. See §9.

**`csv-safety.ts`** (249 lines, zero imports) — `csvCell`, `csvRow`, `toCsv`,
`csvFilename`, plus the exported payload and must-not-mangle lists.

**`analytics.policy.ts`** (142) — four read verbs, no write verb.

**`analytics.contract.ts`** (212) — every schema `.strict()`, and **no
`organizationId` field anywhere**.

**`analytics.repository.ts`** (236), **`analytics.service.ts`** (521),
**`analytics.routes.ts`** (152) — the four endpoints from §2D.

**Two security events** — `analytics.report_read` and `analytics.exported`.
**Two rate-limit policies** — `analytics.read` (120/15m) and `analytics.export`
(10/hour, the tightest on the platform).

**Six test files**, 125 tests.

---

## 2. VERIFIED

| Gate                           | Result                        |
| ------------------------------ | ----------------------------- |
| `pnpm typecheck`               | clean, exit 0                 |
| `pnpm lint`                    | clean, exit 0                 |
| `pnpm test` (all six projects) | 96 files, 3,406 tests, green  |
| Defect injection round 14      | see §7                        |
| Live boot check                | see below                     |

**The live boot check, in full.** Migrations 0032–0033 applied to the
development database; the API booted as a real process; a session was promoted
to organization administrator and the endpoints driven over HTTP with a
browser-shaped origin.

```
GET /analytics/school/overview                200, one day, masteryIndex null
GET /analytics/courses/performance            200
GET /analytics/school/overview?organizationId=<other>   400 — no such field
GET /analytics/export?dataset=school_overview 200, text/csv
GET /analytics/students/at-risk (as admin)    403 "available to the teachers of each class"
GET /analytics/export?dataset=users           400
```

The export's headers came back exactly as designed —
`content-type: text/csv; charset=utf-8`, `content-disposition: attachment;
filename="school-overview.csv"`, `x-content-type-options: nosniff`,
`cache-control: no-store` — and the file itself shows the null mastery score as
an **empty cell**:

```
"metric_date","total_active_students",...,"average_mastery_score","ai_tutor_sessions"
"2026-09-10","0",...,"","0"
```

Not `null`, not `0`. That is the property VULN-059 is about, verified at the far
end of the real pipeline rather than in a unit test.

**The audit events landed and carry no numbers**, which is the other thing only a
live boot proves:

```
analytics.report_read  detail: {"grain":"school","days":1}
analytics.report_read  detail: {"grain":"class","rows":0}
analytics.exported     detail: {"dataset":"school_overview","format":"csv","rows":1}
```

A grain and a row count. No metric value anywhere — an audit trail containing the
figures would be a second copy of the dashboard in a place with different access
rules. Reading and exporting are distinct event types, as §3 requires.

**Verified with each gate removed, separately.**
`tests/integration/rls-analytics.test.ts` runs 27 statements as `edu_app` with
no application code in the path. The analytics block of
`tests/security/layered-defense.test.ts` runs the application against
`edu_app_norls` (BYPASSRLS), where every row of every school is visible to the
client — and asserts the precondition first, so a vacuous pass is impossible.

**The numbers are verified, not only the boundaries.** A boundary that holds
around a wrong metric is a boundary around a wrong answer, and people make
decisions about staff and children from these. The fixture is two schools
studying one **shared course** (`organization_id` null, which is what centrally
authored curriculum looks like): learner A answers correctly and learner B does
not, so identical curriculum yields 50.00 mastery with no flagged learners in
school A against 0.00 and one flagged learner in school B.

**Section 2B's non-blocking requirement is measured, not asserted.** The refresh
is held open inside a transaction and `pg_locks` is asked what it holds:
`AccessShareLock` on `assessment_attempts`, `ai_messages`, `lesson_progress` and
`objective_evidence`, and write locks only on tables named `analytics_*`.

---

## 3. SECURITY

**The tenant is derived from the learner's class and never from the content.**
`courses.organization_id` is nullable because null means shared curriculum, so a
content-derived tenant answers NULL for exactly the courses most schools use and
the wrong school for one a school happens to own. `classes.organization_id` is
NOT NULL and `class_memberships` says who is in it.

**No request carries an organization.** Not in a path, a query string or a body.
The schemas are `.strict()` and none declares the field, so naming another school
is a **400 about a field that does not exist** rather than a refusal somebody
maintains.

**Every query carries its own tenant predicate as well as relying on RLS**, and
calls `app_actor_organization()` rather than taking it as a parameter. VULN-056's
lesson applied before it could recur.

**The tenant is bound structurally at the class grain.** A row whose
organization disagrees with its class cannot be written by anybody holding
INSERT — no trigger, no policy, a composite foreign key.

**Nobody writes a metric.** `edu_app` has SELECT and nothing else on both
tables: no write grant, no write policy, no write verb in the vocabulary. On a
table used to judge teachers and children, a write path is the failure mode
worth designing out rather than auditing.

**Seniority narrows rather than widens at the FERPA line.** The named at-risk
list goes to the teacher who will act on it and is refused to the organization
administrator above them, whose legitimate view is the count. It cannot be
exported at all — the dataset enum does not contain it, so the door is not there
rather than being guarded.

**Export is authorized separately from read and audited separately**, and is not
wider. The bytes may be identical; a dashboard closes with the tab and a file
does not.

**CSV formula injection is neutralized at export time**, including the
tab- and CR-prefixed forms the specification's list of four omits, with numbers
exempted on their TYPE so a negative metric does not become spreadsheet text.

---

## 4. IDOR / BOLA MATRIX

Every row traces to a marker in `tests/security/analytics.test.ts`. All run over
the real HTTP stack with both gates active.

| ID | Attempt | Result |
| -- | ------- | ------ |
| IDOR-A | A student reaches any of the four endpoints | 403/404 (×4) |
| IDOR-B | A guardian reaches any of the four | 403/404 (×4) |
| IDOR-C | No session | 401 (×4) |
| IDOR-D | School B's administrator reads their own overview | 200, non-empty |
| IDOR-E | `?organizationId=<other school>` on any endpoint | **400** — no such field |
| IDOR-F | An administrator names another school's class | 404 |
| IDOR-G | School B's rows in school A's own list | absent |
| IDOR-H | An invented class id vs. another school's real one | identical status |
| IDOR-I | A teacher reads the executive dashboard | **403**, naming who holds it |
| IDOR-J | The same teacher reads their own class | 200, exactly one row |
| IDOR-K | A teacher reads a colleague's class in the same school | 404 |
| IDOR-L | A teacher exports the executive dataset | 403 |
| IDOR-M | The class teacher reads their at-risk learners | 200, the right learner |
| IDOR-N | The administrator reads the named at-risk list | **403** |
| IDOR-O | A teacher of another class, threshold 100 | 200, empty |
| IDOR-P | Answers or per-assessment scores in the at-risk payload | absent |
| IDOR-Q | Exporting the at-risk dataset | 400 — not in the enum |
| IDOR-R | A class named `=cmd\|' /C calc'!A0` in an export | neutralized |
| IDOR-S | Export headers | attachment, nosniff, no-store |
| IDOR-T | Internal identifiers in an export | absent |
| IDOR-U | A teacher's course export | one data row |
| IDOR-V | An unknown dataset name, including a traversal | 400 (×4) |
| IDOR-W | The JSON format | authorized identically to CSV |
| IDOR-X | **A global admin role grant** | still only their own school |
| IDOR-Y | An administrator with no organization | no rows from anywhere |

**The same boundaries, twice more.** Twenty-seven of these run again in
`tests/integration/rls-analytics.test.ts` with the application deleted, and
eight run again in the layered-defence block with RLS switched off.

---

## 5. ARCHITECTURE

**This is the first domain whose tables are derived and the first whose subject
is an institution.** Both change the shape of the usual pattern.

*The decision is taken before the aggregate is computed.* Elsewhere a service
reads a row, builds a resource from it and decides — right when the resource IS
the row. Here it would mean computing a school's numbers and then deciding
whether the caller may have them, leaving those numbers in memory in a process
serving somebody with no right to them. The resource is built first, from the
actor's own facts.

*The refresh has no actor, so its vantage point is declared.* 0021's
`app_objective_mastery` is actor-dependent — it withholds an unreleased result
from the learner and their guardian. A stored aggregate has no reader whose
entitlements could apply, so the refresh recomputes the same tally without the
withholding clause: the staff view, stated rather than inherited, and safe only
because the RLS admits no learner at any grain.

*The tenant is one fact, resolved in SQL.* `app_actor_is_org_admin()` answers
only "holds the role, anywhere" — the established shape from 0014, safe because
every caller pairs it with a tenant equality. The repository makes that pairing
when it builds the resource, so the policy is never handed a bare "is an admin"
it could apply to the wrong school.

**Nothing established was redesigned.** `Guarded`/`unwrap`, `db.withActor`,
`FORCE ROW LEVEL SECURITY`, the two-role test split, the disclosure model, the
security-event taxonomy and the migration checksum discipline are used as they
were. One additive constraint was added to `classes`, to make the composite
foreign key possible.

---

## 6. FILES CHANGED

**New**

```
db/migrations/0032_institutional_analytics.sql          778
db/migrations/0033_mastery_scale_correction.sql          76
apps/api/src/modules/analytics/csv-safety.ts            249
apps/api/src/modules/analytics/analytics.repository.ts  236
apps/api/src/modules/analytics/analytics.service.ts     521
apps/api/src/modules/analytics/analytics.routes.ts      152
packages/authz/src/policies/analytics.policy.ts         142
packages/contracts/src/analytics.contract.ts            212
tests/unit/analytics-csv-safety.test.ts                 ~240
tests/unit/analytics-policy.test.ts                     370
tests/architecture/analytics-boundaries.test.ts         439
tests/integration/rls-analytics.test.ts                 753
tests/security/analytics.test.ts                        643
docs/api/analytics.md                                   ~330
```

**Modified**

```
apps/api/src/app.ts                            +11   composition root
apps/api/src/platform/security/rate-limit.ts   +31   two policies
packages/authz/src/types.ts                    +80   resource and actions
packages/authz/src/engine.ts                    +2   dispatch
packages/authz/src/index.ts                     +1   export
packages/contracts/src/index.ts                 +1   export
packages/observability/src/security-events.ts  +34   two events
tests/security/layered-defense.test.ts        +227   the analytics block
docs/architecture/domain-boundaries.md         +~55  the analytics domain
docs/security/vulnerability-log.md            +~110  VULN-059, VULN-060
docs/security/limitations.md                   +~75  RISK-AN-01…12
```

---

## 7. TEST RESULTS

**The full gate, on the clean tree, after everything below.**

```
pnpm typecheck   exit 0
pnpm lint        exit 0
pnpm test        96 files, 3,406 tests, all passing  (922s)
```

All six vitest projects — unit, architecture, web, integration, security,
evaluation. Nothing skipped, nothing quarantined.

**This task's suites**

| Suite | Tests | What it removes |
| ----- | ----- | --------------- |
| `tests/unit/analytics-csv-safety.test.ts` | 54 | the server |
| `tests/unit/analytics-policy.test.ts` | 27 | the server |
| `tests/architecture/analytics-boundaries.test.ts` | 29 | behaviour — asserts on source text |
| `tests/integration/rls-analytics.test.ts` | 27 | the application layer |
| `tests/security/analytics.test.ts` | 35 | nothing — both gates, real HTTP |
| `tests/security/layered-defense.test.ts` (analytics) | 8 | RLS |

**Defect injection round 14 — 16 injected, 16 caught.**

| # | Defect | Caught by |
| - | ------ | --------- |
| F1 | The daily query drops its own tenant predicate | arch, **then layered** |
| F2 | The course query drops its tenant predicate | arch, layered |
| F3 | `classResource` loses the class-to-school conjunct | sec, layered |
| F4 | The null-organization guard is dropped | sec |
| F5 | An administrator is allowed the named at-risk list | unit, arch, sec, layered |
| F6 | A teacher is admitted to the executive dashboard | unit |
| F7 | A class-grained refusal reveals rather than hides | unit, sec, layered |
| F8 | `actorTeachesClass` tested for truthiness, so null counts | unit |
| F9 | The whitespace formula triggers are dropped | unit, arch |
| F10 | The cell is quoted before it is neutralized | unit, arch, sec, layered |
| F11 | Every string is exempted from neutralization | unit, arch, sec, layered |
| F12 | `at_risk` becomes an exportable dataset | arch, sec |
| F13 | The query schemas stop being strict | sec, layered |
| F14 | The unnamed course list stops being authorized | sec, layered |
| F15 | The export is decided at the school grain regardless of dataset | sec |
| F16 | The mastery scale reverts to scoring `attempted` as zero | rls, sec |

**Two results taught something, and both are recorded in the code.**

**F1 was caught only by the architecture suite reading the source**, and that
exposed a vacuous assertion in the layered-defence block. It checked that school
B's id was absent from the overview response — but **the overview response
deliberately carries no organization id at all**, because the caller has exactly
one school and already knows which. The string could never appear whether the
tenant predicate was present or not.

The fix asserts the observable CONSEQUENCE instead. The daily table is one row
per school per day, so two schools merged means two rows for today; uniqueness of
the date is what the boundary holding looks like from outside. *When a response
is deliberately stripped of the field a leak would name, the leak has to be
detected by its cardinality.* F1 re-verified as caught by arch **and** layered.

**F6 is inert on the real path, and that is itself a defence worth naming.**
Admitting a teacher to the executive dashboard changed nothing over HTTP,
because `schoolResource` sets `actorTeachesClass: null` at the school grain —
the resource structurally cannot carry a teaching claim there, so the widened
branch has nothing to match. The unit suite caught it by constructing the
resource directly. Reporting it as an escape would have been a false alarm
pointing at a hole that is not there.

**The baseline check earned its keep again.** Round 14 refused to start until
the clean tree was green, which it was — but the same check caught a stopped
PostgreSQL in round 13 and would have reported sixteen meaningless catches
without it.



---

## 8. NOT IMPLEMENTED

**Explicitly excluded by the task.**

- **Production Hardening.** No deployment configuration beyond what existed.
- **Load Testing.** No benchmark, no synthetic volume, no measured throughput.
  The lock behaviour is asserted; the *cost* of a refresh at scale is not.
- **CI/CD Deployment Pipelines.** Untouched.

**Not asked for, and not built.**

- **No frontend.** Every endpoint is server-side JSON. There is no dashboard, no
  chart, no at-risk screen.
- **No scheduler.** The refresh functions exist and are tested; nothing calls
  them. See RISK-AN-02 — this is the largest gap in the domain.
- **No departments.** The platform has no such concept, so "Department Head" is
  served as an ordinary teacher's scope. See RISK-AN-01 and §9.
- **No trend analysis, forecasting or comparison between schools.** The
  endpoints return what happened, not what it means.
- **No per-learner drill-down from an aggregate.** Deliberate: that path is the
  FERPA line, and the at-risk list is the only crossing.
- **No alerting on a stale refresh.** RISK-AN-12.
- **No timezone handling.** Days are UTC. RISK-AN-03.

---

## 9. KNOWN RISKS & DEFECTS FOUND

**Two defects found and fixed during this task, both in
`docs/security/vulnerability-log.md`.**

**VULN-059 — the mastery index ranked an unassessed learner below a failing
one.** Migration 0032 put 0021's five mastery states on an ordinal 0..3 line.
But `attempted` means *evidence exists and none of it is graded* while
`developing` means *an assessment was sat and not passed* — so the scale gave
the unassessed learner 0.00 and the failing one 33.33. **A class that had done
the reading and not yet reached the quiz reported total failure to its head
teacher, and the school's index went UP the moment they sat the quiz and failed
it.** Migration 0033 excludes `attempted` alongside `no_evidence` and scores the
graded states 0 / 50 / 100.

*The lesson is about reasoning rather than code.* The 0032 header argued
carefully and correctly about why `no_evidence` must be excluded — "a learner who
has not yet reached an objective has not failed it" — and every word of that
applies to `attempted` too. **A well-reasoned justification for one case is not a
justification for the cases next to it**, and the comment explaining the first
exclusion read as though the neighbouring state had been considered.

*No security test would have found it.* Every boundary held perfectly around a
number that was wrong.

**VULN-060 — an analytics endpoint answered 200 to a learner.**
`/analytics/courses/performance` with no `classId` returned an empty list with a
200 to learners and guardians. Nothing escaped — both data gates give them
nothing — but §2C requires 403, and the distinction is not pedantry: **an
endpoint that answers 200 to a learner is one whose safety rests entirely on the
filter beneath it staying correct forever.** Fixed by authorizing the unnamed
shape too.

*And immediately, a second defect from the first fix*: every teacher's course
export became a 404, because the export built its resource with
`actorTeachesClass` left null. **Two doors onto the same data must be authorized
by the same facts, or one of them is wrong — and it is always the one nobody
opens on screen.** The policy suite now asserts export and read agree across all
six actor shapes.

**Three test errors of mine, corrected rather than worked around.** An attempt is
born unscored and graded only on the submit transition, so a fixture writing a
percentage tests a number no learner could receive; objectives are draft-only;
an assessment activity cannot be published before it has a scoreable question.
And three imprecise fitness assertions — one flagged a non-SQL template literal,
one matched nothing at all and passed vacuously, one read the migration's own
prose promising the property it was checking for.

**A specification requirement this task cannot meet as written.**
§2C asks for "Teachers / Department Heads ... within their assigned department".
**This platform has no departments** — organizations, classes, teacher
assignments and eight roles, none of them a department. Inventing a
`departments` table would have been redesigning the project rather than filling a
gap in it, which §1 forbids. A head of department therefore sees exactly the
classes they personally teach, which is **narrower than the specification
intends**, and a school that organises by department cannot express that here
(RISK-AN-01).

**Twelve standing risks, RISK-AN-01…12.** The four that matter most:

- **RISK-AN-02 — nothing calls the refresh functions.** They exist, are correct
  and are tested; there is no scheduler on this platform. Until something invokes
  them the tables stay empty and every endpoint honestly returns nothing. This
  is the largest gap in the domain and it is a deployment gap.
- **RISK-AN-08 — the metrics are computed from the staff vantage point**, so
  they include results a teacher has not released. Safe only for as long as no
  learner or guardian can read any row; widening the RLS at any grain turns the
  mastery index into a way of announcing an unreleased mark.
- **RISK-AN-04 — `total_active_teachers` counts only teachers who released a
  result that day.** It is the one teacher action this platform timestamps. A
  school reading it as "staff engagement" will be misled.
- **RISK-AN-06 — a school with nothing assessed shows null.** Correct, and
  harder for a frontend to draw than a zero; a frontend that coerces it will
  reintroduce VULN-059 at the presentation layer, where no test here can see it.

**Carried forward, unchanged and still true.** The API is not deployed. Vercel's
Root Directory is still `apps/api` rather than the repo root, and
`apps/api/vercel.json` should be deleted once corrected. `@vercel/speed-insights`
sends Web Vitals to a third party from a children's platform.

---

## 10. NEXT TASK — ONE RECOMMENDATION

**Task 016: Production Hardening & CI/CD Deployment.**

This is the recommendation the task itself proposes and it is the right one, for
a reason this task made concrete rather than for sequence.

The platform now has fifteen tasks of domain work behind two tested gates, and
**none of it runs anywhere.** The API is not deployed. Vercel's Root Directory
has been wrong since Task 019-A and `apps/api/vercel.json` is still there to be
deleted. There is no scheduler, which is why the analytics tables this task built
will stay empty until something calls the refresh (RISK-AN-02) — a gap that is
not fixable inside a domain task because it is not a domain problem.

The pattern is now unmistakable across the last two reports: Task 014 ended with
a moderation queue nobody is notified about, and Task 015 ends with a reporting
engine nothing populates. **Both are correct, tested, and inert for the same
reason** — the platform has no way to run anything on a schedule and no
deployment to run it in. Another domain would make that three.

Concretely, in this order: fix the Vercel Root Directory and delete the stale
`vercel.json`; get the API deployed with migrations applied; add a scheduler and
point it at the two refresh functions and a moderation-queue digest; then the CI
pipeline that runs the six test projects on every push, so the 3,200-test gate
this project has been running by hand becomes a gate that actually gates.

The security work has been done to a standard the deployment story has not
matched, and that gap is now the largest risk in the repository — not because any
control is weak, but because none of them is protecting anybody yet.

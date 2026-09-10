# Institutional Analytics & Reporting API

Task 015. What the adults who run a school are told about it, and — more
carefully — what they are not.

## The one-paragraph version

Two derived tables hold the numbers: **`analytics_daily_school_metrics`**, one
row per school per day, and **`analytics_course_performance`**, one row per
school/class/course. Neither is written by any request; a refresh function
running as the table owner recomputes them from the underlying facts. A **school
administrator** reads their own school's executive dashboard and every class in
it. A **teacher** reads the classes they actively teach and is refused the
institutional view. **Learners and guardians reach nothing at all.** One endpoint
returns rows about named children — the at-risk list — and it goes only to the
teacher who will act on it, not to the administrator above them. Exports are
authorized separately from reads, audited separately, and every cell is
neutralized against spreadsheet formula injection.

## Endpoints

| Method | Path                                  | Who                                       |
| ------ | ------------------------------------- | ----------------------------------------- |
| `GET`  | `/analytics/school/overview`          | administrators of the caller's own school |
| `GET`  | `/analytics/courses/performance`      | that school's administrators, or a class's teacher |
| `GET`  | `/analytics/students/at-risk`         | **the teacher only** — not administrators |
| `GET`  | `/analytics/export`                   | as the corresponding read                 |

All paths are under `/api/v1`. **Every route requires a session.** There is no
public analytics route and no unauthenticated aggregate of any kind.

## The tenant comes from the learner's class, never from the content

The obvious way to scope a metric about an assessment attempt is to walk the
content chain — attempt → assessment → activity → lesson → unit → course — and
read `courses.organization_id`.

**That is wrong here, and wrong in a way that produces a plausible-looking number
rather than an error.** `courses.organization_id` is nullable *on purpose*: null
means shared curriculum, authored centrally and studied by many schools. The
content chain therefore answers NULL for exactly the courses most schools use,
and for a course a school does own it answers that school even when the learner
studying it belongs to another.

Activity belongs to the school whose **learner** performed it. `classes` carries
`organization_id NOT NULL`, `class_memberships` says who is in a class, and that
pair is the only tenant anchor in this schema that is both non-null and about a
person.

`tests/integration/rls-analytics.test.ts` proves the difference with a fixture
of two schools studying one shared course: learner A answers correctly and
learner B does not, so identical curriculum yields 50.00 mastery and no flagged
learners in school A against 0.00 and one flagged learner in school B.
Content-chain derivation would have returned nothing for either.

## No request anywhere carries an organization

Section 2B asks that the tenant be *"derived directly from the authenticated
user's auth context"*. The way to fail that is to accept an `organizationId`
parameter and check it — which works until somebody adds a branch, an endpoint,
or a "just for support staff" flag.

The way to pass it structurally is to have **nowhere to put one**. Every request
schema is `.strict()` and none declares an organization, so
`?organizationId=<other school>` is a **400 about a field that does not exist**
rather than a refusal somebody has to maintain. `tests/architecture/analytics-boundaries.test.ts`
fails if such a field ever appears.

The same applies to `classId` on the at-risk endpoint. A teacher does not name
the classes they teach; the query already knows.

## Two gates, and each one tested with the other removed

| The rule                                    | Application                              | Database                                    |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| Only this school's administrator reads the executive report | `analytics_report.not_an_administrator` | `analytics_daily_school_metrics_select`     |
| A teacher reads only the classes they teach | `analytics_report.not_this_class`        | `analytics_course_performance_select`       |
| Learners and guardians read nothing         | both branches fall through to a deny     | neither policy admits them                  |
| Every query is bounded to one school        | the repository's own tenant predicate    | the same predicate in RLS                   |
| Named at-risk children go only to a teacher | `analytics_report.at_risk_is_for_teachers` | `app_analytics_at_risk` authorizes itself |
| A row's school matches its class            | —                                        | composite foreign key                       |
| Nobody writes a metric                      | no write verb in the vocabulary          | no write grant, no write policy             |

Both directions are tested. `tests/integration/rls-analytics.test.ts` runs the
database with no application code in the path; the analytics block of
`tests/security/layered-defense.test.ts` runs the application against a
`BYPASSRLS` role, where every row of every school is visible to the client and
the refusals come from the policy engine and the repository's own predicates.

**Every repository query says `organization_id = app_actor_organization()`
itself**, in addition to the identical predicate in RLS. That is VULN-056's
lesson applied before it could recur: in Task 013 the public portfolio resolver
carried no `WHERE` clause and returned any row to anybody against a BYPASSRLS
role. It is the same predicate from the same source, so the two cannot drift.
And the helper is **called, never passed** — there is no `$1 = organizationId`
anywhere, so no caller can point a query at another school by handing it an
argument.

## The FERPA line

Section 2B: *"high-level admin reports must summarize trends without leaking raw
individual student responses outside assigned teacher-student boundaries."*

`GET /analytics/students/at-risk` is the one endpoint that returns rows about
named children, so it is the one where that sentence has to be a rule rather
than an intention. The rule is drawn in two places at once.

**Who it answers for.** Only classes the caller actively teaches. **An
organization administrator gets nothing** — not a reduced list, not pseudonyms.
A head teacher running a school does not need a browsable list of struggling
minors to do it; their legitimate view is the *count* in
`analytics_course_performance`, which tells them where to put resources.
Somebody who genuinely needs a name can ask the teacher, and that conversation
leaves a trace an endpoint does not.

**What it returns.** A learner id, a display name, a rounded index, and how much
evidence is behind it. **No answers, no per-assessment scores, no question
breakdown.** Complying with "no raw individual student responses" means never
putting them in the shape, not filtering them out downstream.

**It cannot be exported.** `at_risk` is absent from the export dataset enum, so
the request is a 400 rather than a policy decision — the door is not there. A
CSV of struggling minors is precisely the artefact that gets forwarded, left on
a laptop, and read by people the school never authorized.

*Seniority narrows rather than widens here, which inverts the usual shape of a
permission hierarchy.* A head of department who administers the school **and**
still teaches gets the list for their own classes — because they teach, not
because they administer.

## The mastery scale

0021 produces a mastery *state*, which is a word. A dashboard wants a number,
and turning one into the other is a modelling choice written down once:

| State          | Score | Meaning                                  |
| -------------- | ----- | ---------------------------------------- |
| `no_evidence`  | —     | Nothing has happened. Excluded.          |
| `attempted`    | —     | Something happened; none of it graded. **Excluded.** |
| `developing`   | 0     | Graded, passed nothing.                  |
| `demonstrated` | 50    | Graded, passed one assessment.           |
| `mastered`     | 100   | Graded, passed more than one.            |

**`attempted` is excluded, and migration 0033 exists because it was not.** The
original scale put the five states on an ordinal 0..3 line, scoring `attempted`
at 0.00 and `developing` at 33.33 — so **a learner nobody had assessed yet
ranked below one who sat an assessment and failed it**, and a school's index went
*up* the moment its class sat a quiz and failed. A class that had done the
reading and not yet reached the assessment reported total failure to its head
teacher.

Both excluded states mean "we do not know", and the honest rendering of that is
absence from the average rather than a zero that reads as failure. The cost — a
school with nothing assessed shows `null` rather than a number — is the right way
round. `average_mastery_score` is nullable all the way through the stack: column,
DTO and CSV cell.

**This number must never be shown to a learner.** It is computed from the *staff*
vantage point, which includes results a teacher has not released — see below.

## The refresh

```sql
SELECT app_analytics_refresh_daily(:organization, :date);
SELECT app_analytics_refresh_courses(:organization);
```

Both are `SECURITY DEFINER`, revoked from `PUBLIC`, and **not granted to
`edu_app`**. They are called by a scheduled job running as the owner. A request
cannot trigger one.

**The refresh has no actor, so its vantage point is declared rather than
inherited.** `app_objective_mastery` (0021) is actor-dependent: it withholds an
unreleased result from the learner and their guardian and reports the truth to
everybody else. That is right for an endpoint and impossible for a stored
aggregate, which is computed once, by nobody, and read later by many. So the
refresh calls `app_analytics_authoritative_mastery` — the same tally without the
withholding clause, which is the staff view. **That is safe only because the RLS
below admits no learner and no guardian at any grain.** If that ever changes,
this function becomes a disclosure and the change must start there.

### It does not contend with live traffic

Section 2B asks for aggregation that avoids lock contention on the transaction
tables, and the shape of the work is most of the answer:

- **No locks are taken on the source tables.** Every read is a plain `SELECT` at
  READ COMMITTED — no `FOR UPDATE`, no `FOR SHARE`, no `LOCK TABLE` — so a
  rollup over `assessment_attempts` cannot block a learner submitting one.
  `tests/integration/rls-analytics.test.ts` holds a refresh open inside a
  transaction and asks `pg_locks` what it actually holds: `AccessShareLock` and
  nothing heavier, with write locks only on tables named `analytics_*`.
- **The write is an upsert**, not DELETE-then-INSERT, so a reader is never shown
  the gap between two halves of a refresh. Running it twice does not double a
  count.
- **It is not `REFRESH MATERIALIZED VIEW`.** That statement takes an ACCESS
  EXCLUSIVE lock for its whole duration, so every dashboard in the school blocks
  behind the nightly job; the `CONCURRENTLY` form still rewrites the entire view
  for all tenants. A plain table with a per-tenant upsert refreshes one school
  without the others noticing.

### It is not a sequential scan

Six partial indexes were added to the source tables — none of them was indexed on
the date column a rollup filters by. Each covers only the rows a rollup reads:
only completed lessons have a `completed_at`, only submitted attempts a
`submitted_at`.

## The tables are derived, and nobody writes to them

`edu_app` has **`SELECT` and nothing else** on both tables — no INSERT grant, no
UPDATE grant, no DELETE grant, and no write policy. Every number is a fact about
rows that live elsewhere, and the only correct way to change one is to change the
underlying fact and refresh. A write path would be a way to make the dashboard
say something the school's data does not, which on a table used to judge teachers
and children is the failure mode worth designing out rather than auditing.

**The tenant is bound by a composite foreign key.**
`analytics_course_performance` references `classes (id, organization_id)`, so a
row whose organization disagrees with its class **cannot be written** — not by a
bug in the refresh, not by a future endpoint, not by anybody holding INSERT.
`classes` gained the `UNIQUE (id, organization_id)` that makes this possible.

## CSV export safety

**The threat is not the file; it is the spreadsheet that opens it.** A cell whose
first character is `=`, `+`, `-` or `@` is parsed as a formula, and a
spreadsheet's formula language reaches further than most people expect —
`=HYPERLINK` to exfiltrate neighbouring cells to a URL, `=cmd|...` to reach DDE
on Windows, `=WEBSERVICE` to fetch.

The attack on this platform is: somebody names a class with a leading `=`.
Nothing happens for weeks. Then a head teacher exports the compliance report and
opens it, and the formula runs with that head teacher's authority, on that head
teacher's machine, with the rest of the school's data on the same sheet.

**We prefix, we do not strip.** Section 2E says "sanitizing formulas like `=`,
`@`, `+`, `-`", and the two readings give different files. Stripping changes the
data: a course legitimately called `=Mathematics` becomes `Mathematics`, and a
compliance export whose whole purpose is to be an accurate record now disagrees
with the platform, silently. Prefixing with an apostrophe is the OWASP defence —
the value survives, only its interpretation changes.

**The trigger list is longer than the specification's four.** Excel strips
leading whitespace before deciding whether a cell is a formula, so a tab- or
CR-prefixed `=cmd` reaches the formula parser while walking past a check that
looks at index 0 for the four printable characters. Both are triggers here.

**Numbers, booleans and dates are exempt, and the exemption is on the TYPE.** A
negative number starts with a formula trigger, and a prefixed cell is *text* to a
spreadsheet — so the naive rule drops every negative metric out of the ranges a
head teacher sums and averages, which is most of what anybody opens an export to
do. A number reaching the sanitizer came from `count(*)`, not from anything a
person typed. A string that merely *looks* numeric, arriving as a class name, is
still neutralized.

Other export properties:

- **Order matters.** Control characters are removed, then the trigger is
  neutralized, then the field is quoted per RFC 4180. Quoting first would hide
  the trigger from the check, and the spreadsheet would unwrap it back into a
  formula.
- **The header row goes through the same sanitizer** — a column name is a cell.
- **No identifiers in the export.** A compliance report travels; a uuid in it is
  a thing to try against other endpoints once it has.
- **`Content-Disposition: attachment`** so a browser saves rather than renders,
  **`X-Content-Type-Options: nosniff`**, and **`Cache-Control: no-store`**. The
  filename is sanitized separately, because there the danger is header injection
  rather than a formula.
- A null renders as an **empty cell**, not `null` and not `0`.

## Rate limits

| Policy             | Limit         | What it is for                                       |
| ------------------ | ------------- | ---------------------------------------------------- |
| `analytics.read`   | 120 / 15 min  | A polling dashboard, or a sweep across report grains |
| `analytics.export` | **10 / hour** | Bulk extraction through a compromised staff session  |

`analytics.export` is the tightest limit on the platform. No legitimate workflow
needs ten exports in an hour, and the illegitimate one — a compromised
administrator session pulling every dataset before anybody notices — is exactly
what a low ceiling makes slow and loud.

## Audit

| Event                    | When                                    |
| ------------------------ | --------------------------------------- |
| `analytics.report_read`  | Any institutional report is read        |
| `analytics.exported`     | A report leaves as a file               |
| `authz.denied`           | Any refusal, with the rule name and no numbers |

**This is the only READ this platform logs.** Every other read event was
rejected as noise in Task 003 and that judgement still holds — logging that a
learner opened a lesson tells nobody anything. An institutional report is the
only read whose *subject* is other people, hundreds of them, and the only one
where "who has been looking at this, and how often" is a question a school may
have to answer to a regulator or a parent. The volume is bounded by the number
of adults with the role.

**Exporting is a separate event from reading**, and the separation is the point.
The bytes may be identical; the acts are not. A dashboard closes with the tab. A
file is on a laptop, forwarded by email, opened on a home machine, still readable
after the person leaves the school. An investigation asking "how did this
school's data get out" cannot distinguish those two if they share an event type.

The detail carries the grain and a row count, **never a metric value**. An audit
trail containing the numbers is a second copy of the dashboard in a place with
different access rules.

## Errors

| Status | When                                                                |
| ------ | ------------------------------------------------------------------- |
| 400    | An undeclared field (including `organizationId`), a bad range, an unknown dataset |
| 401    | No session                                                          |
| 403    | A refusal the caller is entitled to understand — a teacher reaching for the executive report, an administrator reaching for the named list |
| 404    | A refusal that must not confirm a class exists — another school's class, an invented id |
| 429    | A rate limit                                                        |

**403 and 404 are chosen case by case.** A member of staff asking about the
school they work in is told plainly that the report belongs to administrators —
pretending the dashboard does not exist would read as a broken product. A caller
naming a class in another school learns nothing, because the id itself is what
must not be confirmed. `tests/unit/analytics-policy.test.ts` asserts the
disclosure as often as the effect.

## Tests

| File                                              | What it proves                                    |
| ------------------------------------------------- | ------------------------------------------------- |
| `tests/unit/analytics-csv-safety.test.ts`          | 12 injection payloads and 11 ordinary values, no server |
| `tests/unit/analytics-policy.test.ts`              | The decision grid, effect and disclosure          |
| `tests/architecture/analytics-boundaries.test.ts`  | The properties a passing suite would not notice breaking |
| `tests/integration/rls-analytics.test.ts`          | The database alone — plus the numbers and `pg_locks` |
| `tests/security/analytics.test.ts`                 | End to end, both gates, IDOR-A … IDOR-Y           |
| `tests/security/layered-defense.test.ts`           | The application alone, RLS bypassed               |

## What this task did not build

There is no **frontend** — every endpoint is server-side JSON. There is no
**scheduler**: the refresh functions exist and something must call them, which
today is a manual `SELECT`. There are no **departments** on this platform, so
"Department Head" is served as an ordinary teacher's scope; see RISK-AN-01.

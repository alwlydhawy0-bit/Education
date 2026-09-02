# Known Limitations & Unverified Claims

Brief §3 and §4: never claim the system is secure, and never claim something
exists or passed when it did not. This document is the counterweight to the rest
of the documentation — it states what was **not** done.

## The headline

**This system is not proven secure, and no such claim is made anywhere in this
repository.** 1,560 automated tests passed against a real PostgreSQL database.
That establishes that specific, enumerated properties held at a point in time. It
does not establish the absence of vulnerabilities.

## What was actually verified

**Updated for Task 010.** The counts and the "not verified" list below reflect
the current state.

- 1,560 tests executed and passing: 598 unit, 108 architecture, 349 integration,
  505 security.
- Migrations applied cleanly from empty to full schema, repeatedly.
- RLS enforced against a real non-superuser role — verified by attack, not by
  reading the policy.
- The application authorization layer verified _independently_ of RLS, using a
  role with `BYPASSRLS`.
- Secret scan and dependency audit executed; the audit found two real advisories
  (vite high, vitest critical), which were fixed by upgrading, not exempted.
- **The assessment surface was driven over HTTP against a booted server** — 47
  checks covering authoring and the duty split, publication validation, the
  learner flow end to end, server-side scoring, every refused write shape, the
  teacher, guardian and administrator read paths, the attempt limit, and
  revocation — with the server log then searched for passwords, database
  credentials, session tokens, every option body, every question prompt, and
  every answer-key option id. **None were present.** The only match for
  `correctOption` was a validation-error field PATH from an author's own
  rejected request, carrying no values.
- **The Task 009 release and review surface was driven over HTTP against a
  booted server**, on a withheld assessment seeded through the real fixtures:
  the submission response carried `score: null` for the learner while the
  teacher's read of the same attempt showed `2`; the learner's review returned
  403 and their attempt to release their own result returned 403; a release body
  carrying `score` returned 400; the teacher's release returned the marks, the
  explanation and the comment to the learner; and a second release returned the
  SAME `releasedAt`. The server log was then searched for the correct option id,
  the question prompt, the authored explanation, the teacher's comment, the
  password, a session token, and the strings `isCorrect` and `correctOption`.
  **None were present.** The `assessment.result_released` event carried the
  attempt, assessment and learner ids and `hasComment: true` — no mark, no
  comment text.
- **The Task 010 mastery surface was driven over HTTP against a booted server**,
  through the real endpoints on a seeded course: `no_evidence` before anything;
  `attempted` after completing the lesson; `demonstrated` after passing one
  assessment; **still `demonstrated` after passing the SAME assessment a second
  time**; `mastered` only after passing a DIFFERENT one; the teacher's view of
  the same learner matching; a forged `?learnerId=` on `/me/objectives` returning
  the caller's own (empty) record; and `POST /me/objectives/:id/mastery`
  returning **404**, because no such route exists. The server log was then
  searched for the password, a session token, any mastery state, and the
  objective statements. **None were present.** `tools/live-check/seed-mastery.ts`
  makes the run repeatable.
- **The learner progress surface was driven over HTTP against a booted
  server** — 39 checks covering the write asymmetry, every refused write shape,
  the learner's own history, the teacher, guardian and administrator read paths,
  and retention after class removal — with the server log then searched for
  passwords, session tokens, database credentials and lesson titles. None were
  present.
- **The class–course assignment surface was driven over HTTP against a booted
  server** — 39 checks covering the narrowing, every refused assignment shape,
  the syllabus and learner endpoints, and instant revocation on four different
  triggers — with the server log then searched for passwords, session tokens,
  database credentials and content titles. None were present.
- **The curriculum surface was driven over HTTP against a booted server** — 36
  checks covering authoring, content-safety rejection, server-assigned ordering,
  reordering, the publish and archive workflow, the whole-chain visibility rule
  and cross-organization refusal — with the server log then searched for
  passwords, session tokens, database credentials and lesson content. None were
  present.
- **The API was booted as a real process** and driven over HTTP with curl:
  security headers, register, login, note creation, a rejected sort-injection
  attempt, a 401 on a protected route and a 403 on a missing Origin. The server
  logs were then searched for the password, the session token and the database
  password — none were present.
- **The web client was built** (`vite build`) and the emitted bundle searched for
  `DATABASE_URL`, `postgres://`, role names, development passwords and cookie and
  origin settings. None were present.
- Rate limiting verified to return 429, to record a `ratelimit.exceeded` audit
  event, and to count requests the CSRF origin guard rejects.
- The CI database-provisioning script executed locally, with the full suite
  passing against the database it creates.

## What was NOT verified

- **The GitHub Actions workflows have never run on GitHub.** They are
  syntactically valid, the provisioning script they call was executed locally,
  and the new build and bundle-scan steps were executed locally verbatim — but no
  hosted run has occurred. CodeQL has never analysed this code.
- **No DAST.** No running instance was scanned by an external tool.
- **No penetration test.** No human adversary has attempted to break this.
- **No load, stress, or soak testing.** Zero performance data exists. Every
  performance-related statement in the docs is reasoning, not measurement.
- **No production deployment.** No TLS termination, WAF, secrets manager, backup,
  or restore has been configured or tested.
- **The web frontend was never run in a browser.** It typechecks, lints, builds,
  and its pure i18n logic is unit-tested. No component render test, no E2E test,
  and no visual RTL verification — nobody has looked at a rendered page.
- **No accessibility testing.** Nothing was checked against WCAG, and no screen
  reader was used. Accessibility ranks above performance in the brief's priority
  order and currently has no coverage at all.
- **Argon2 parameters were not benchmarked** on target hardware. They match the
  OWASP baseline but were not tuned or timed.
- **The timing-equalization defence was not measured.** The dummy-hash mechanism
  is implemented and reasoned about; no statistical timing analysis was run, so
  it is unproven that the remaining difference is undetectable.
- **Rate limiting was verified in-process only**, single instance. Behaviour
  across replicas is untested and, by design, currently incorrect.

## Added in Task 003

- **No email delivery.** The `MailDelivery` port exists and is exercised by
  tests, but nothing sends. Verification and reset tokens therefore reach nobody
  in a real deployment.
- **Login is not blocked on an unverified address by default.**
  `REQUIRE_VERIFIED_EMAIL_FOR_LOGIN` exists and is tested, but enabling it
  without a mail provider would lock every user out permanently — a worse failure
  than the risk it addresses. It must be enabled in the same change that
  configures delivery.
- **No MFA**, no password change while logged in, no session listing, no
  device-management UI.
- ~~**No endpoints for managing classes, class membership, or guardian
  relationships.**~~ Built in Task 004; see `docs/api/relationships.md`.
- ~~**`organizations` has no management API.**~~ Built in Task 004. Creating one
  still requires a **platform operator**, and that role is still only grantable
  directly in the database — deliberately.
- **Account lockout is a fixed window**, not exponential backoff, and locks on a
  per-account basis only. An attacker spreading attempts across many accounts is
  bounded only by the per-IP rate limiter, which is per-process.
- **Admin listing is offset-paginated** with a 10,000 ceiling, and fetches each
  user's roles in a separate query — correct, but N+1. Not a problem at current
  scale; it will be at a few thousand users.
- **`auth_user_grants` is a SECURITY DEFINER read** with no internal
  authorization: the caller must authorize first. The service does, and a test
  covers it, but the function itself would return any user's grants if called
  directly by application code.

## Added in Task 008

- **Per-question correctness is never returned, even after submission.**
  **CLOSED IN TASK 009**, on the terms this entry set out: a learner is now shown
  which questions they got wrong, the correct answers and the author's
  explanation — but only through `GET /attempts/:id/review`, and only once the
  result has been released. See "Added in Task 009" below for what that
  introduced.
- **A question cannot be corrected once created.** There is no UPDATE grant on
  `assessment_questions`, `assessment_options` or `assessment_answer_keys`, and
  no endpoint. A typo in a prompt means creating a new assessment. Immutability
  was chosen so that a mark always names the exact paper it scored
  (RISK-ASSESS-05); the cost falls on authors, and it is a real cost.
- **An attempt left in progress when access is revoked can never be closed.**
  Writes require current access, consistently with progress, so a learner
  removed from a class mid-attempt keeps an `in_progress` row forever. Nothing
  cleans it up and no endpoint can (RISK-ASSESS-04).
- **Every teacher in a school can read every answer key in it.** The `teacher`
  role carries `content:author`, which is what the key policy admits. Intended,
  but a much wider audience than "the person who wrote it" (RISK-ASSESS-02).
- **Nothing records who read an answer key, or whose marks were looked at.** The
  same gap as RISK-PROGRESS-02, now over higher-stakes data. An audit event per
  read remains unbuilt for the same reason: a per-touch event stream on the
  highest-volume read path needs a retention and access policy that does not
  exist yet (RISK-ASSESS-03).
- **Rate limiting on these endpoints is honestly weak.** It is per-IP and a
  classroom shares an IP, so the limits (200 per 15 minutes) are set where a
  class of thirty is unaffected. The real control against answer-key probing is
  the per-learner attempt limit; the limiter is a backstop, and it is still
  per-process, not distributed (RISK-ASSESS-01, RISK-RATE-01).
- **The scoring rule is enforced in SQL and has no TypeScript counterpart.**
  That is deliberate — the answer key never enters application memory — but it
  means the rule cannot be unit-tested and is only ever exercised against a real
  PostgreSQL. If the integration suite were skipped, nothing would check how
  children are marked.
- **No partial credit, and no negative marking.** A multiple-choice question is
  all-or-nothing on exact set equality. That is a pedagogical decision with no
  obvious right answer, made here by fiat and stated rather than buried.
- **`app_assessment_label` is a SECURITY DEFINER function returning activity,
  lesson and course titles plus the passing percentage for any assessment id to
  any authenticated caller.** It is what makes retention work, and it is a
  deliberate hole in the row-level model — bounded to titles, no question, no
  option, no key. Same shape and same caveat as `app_lesson_label` in Task 007.
- **Timing, deadlines and time limits do not exist.** An attempt can be left
  open indefinitely. `startsOn` and `dueOn` on a course assignment still gate
  nothing.
- **No gradebook, transcript, GPA, roll-up or cohort view.** A result is one
  attempt at one assessment. Nothing aggregates them.
- **No essay, free-text, oral, code-execution, AI or teacher-graded questions.**
  Only the three objective types the server can mark without judgement, which is
  the only reason a score can be computed at all.
- **Assessment results are evidence, not mastery.** Nothing infers competence,
  readiness or understanding from a score, and this system makes no claim that a
  passing mark means a child has learned anything.
- **The web build emits source maps** (`vite.config.ts`, `sourcemap: true`,
  unchanged since Task 001), and they embed the full TypeScript source of
  `@edu/contracts` — including the comments explaining what the assessment
  contracts deliberately do NOT contain. Noticed while scanning the bundle for
  answer-key leakage in this task: the emitted JavaScript has zero occurrences
  of `isCorrect`, and the only matches anywhere are prose in the `.map` saying
  the field does not exist. No key and no correctness field is present in either
  file. It is recorded because shipping source maps to production is a
  disclosure decision that was never explicitly made, and it is out of this
  task's scope to change.

## Added in Task 010

- **Mastery cannot tell one objective of a lesson from another.** An assessment
  attaches evidence to EVERY objective of its lesson, because nothing in the
  schema says which question tested which objective. Within a lesson, objectives
  assessed by the same quiz move together. Per-question tagging would fix it and
  would also let the platform claim a precision it has not earned; the coarse
  version is documented rather than dressed up (RISK-MASTERY-01).
- **The mastery thresholds are chosen by fiat.** `demonstrated` is one passed
  assessment and `mastered` is two distinct ones. Those numbers are defensible
  and they are not validated against anything — no learning-science literature,
  no outcome data, no pilot. They are stated in `docs/api/mastery.md` precisely
  so a teacher can argue with them (RISK-MASTERY-02).
- **`mastered` is not a claim that a child has mastered anything.** It is a claim
  that two different assessments covering the objective were passed. The name is
  the most misleading thing in this task, and it is used because the task
  specified the vocabulary; the rule behind it is deliberately weak.
- **Rewriting a draft lesson's objectives deletes and re-inserts them.** An
  objective removed from the list loses its identity, and evidence pointing at it
  cascades away. That is bounded to DRAFT lessons by the delete policy — a
  published lesson refuses the delete, so no learner's record can be erased this
  way — but authoring is therefore rewording-safe and reordering-unsafe. A future
  task that lets an author edit objectives individually should carry their ids
  (RISK-MASTERY-03).
- **Nothing records who READ a learner's mastery or evidence.** Only denials are
  audited. Same gap as RISK-PROGRESS-02 and RISK-ASSESS-07, over data that is now
  a judgement about a child rather than a record of what they did
  (RISK-MASTERY-04).
- **`app_objective_label` is a SECURITY DEFINER function returning objective
  statements and lesson, unit and course names for any objective id to any
  authenticated caller.** It is what makes retention work for a guardian, who has
  no content access at all, and it is a deliberate hole in the row-level model —
  bounded to names, no lesson body, no links. Same shape and same caveat as
  `app_lesson_label` in Task 007 (RISK-MASTERY-05).
- **Course mastery is computed per request, with no caching or materialization.**
  One statement per course rather than N+1, but still a full recomputation every
  time. It has not been tested at catalogue scale. Caching was deliberately not
  introduced: a stale mastery state is worse than a slow one, and the task
  forbids premature optimization (RISK-MASTERY-06).
- **The learner's own mastery view depends on result release.** The stored
  evidence and the authoritative state do not — a teacher sees the truth
  immediately — but a learner is shown `attempted` for an attempt whose result
  Task 009 is still withholding. This is a deliberate reading of the task's "do
  not make mastery depend on result visibility": the alternative announces a
  withheld mark through a second endpoint. Recorded because it is a choice, not
  an implementation detail.

## Added in Task 009

- **A release cannot be undone.** There is no endpoint, and the database refuses
  it. A result disclosed early stays disclosed, and the honest reason is that
  un-releasing a mark a child has already read achieves nothing — the child
  knows the number (RISK-ASSESS-06).
- **Nothing records who READ a released result or a marked paper.** Only the
  release itself is audited. This is the same gap as RISK-ASSESS-03, and Task
  009 widened the data it applies to: the review endpoint returns answer keys,
  and no event says who fetched one (RISK-ASSESS-07).
- **Release authority follows the class roster, not the authorship of the
  assessment.** Any teacher of the learner's class may release any of that
  class's results, including for an assessment somebody else wrote. The class is
  the platform's unit of teaching authority and no smaller one exists
  (RISK-ASSESS-08).
- **A platform operator may release a result.** Unlike `start` and `submit`,
  which they may not perform, releasing is permitted, so an operator can
  disclose a mark a school intended to withhold. The reasoning is in
  authorization.md: the act discloses a number the database computed rather than
  fabricating evidence about a child. It is still an operator capability with no
  school-side check (RISK-ASSESS-09).
- **`teacherComment` is free text, stored and rendered as written.** It is
  bounded at 2000 characters and escaped by the renderer, and nothing moderates
  what a teacher writes to a child. There is no review, no reporting path and no
  record of edits — because there are no edits: a comment is fixed at release
  (RISK-ASSESS-10).
- **There is no bulk release.** A teacher releases one attempt at a time. For a
  class of thirty that is thirty requests, which is a usability cost accepted in
  order to keep every release a single, individually audited decision.
- **`explanation` is authored once and shown to everyone who reviews the
  assessment.** Nothing prevents an author writing something about a particular
  learner into it, where it would be disclosed to every other learner who
  reviews the same paper. The separation from `teacherComment` is stated in the
  contract and the schema comment; it is not enforced, and could not be.
- **The withheld-marks redaction is a query, not a policy.** Row-level security
  cannot hide a column, so `score`, `max_score`, `percentage` and `passed` are
  redacted by a `CASE` in `ATTEMPT_SELECT`. Any FUTURE query that reads those
  columns without the same expression would return a withheld mark. Nothing
  structurally prevents that — the mitigation is that all attempt reads go
  through the one constant, and a new one would be a visible addition in review.

## Added in Task 007

- **Nothing records who read a child's progress.** Writes are traceable through
  the row itself; reads are not. A teacher or an administrator can page through
  every learner's record in their school and leave no trace
  (RISK-PROGRESS-02). An audit event per read is the obvious fix and was not
  built, because a per-touch event stream on the highest-volume read path in the
  system needs a retention and access policy of its own that does not exist yet.
  This is a real gap, not a deferred nicety.
- **Progress moves forward only, and there is no way back.** A learner who marks
  a lesson complete by accident cannot undo it: not through the API, and not
  through RLS, which grants no DELETE and forbids a rank decrease in a trigger.
  Correcting a record is an out-of-band database operation today
  (RISK-PROGRESS-03). Integrity of the record was chosen over correctability,
  and the cost falls on the learner.
- **A school `admin` reads every learning record in their school.** There is no
  smaller unit of trust, no per-class administrator, and no consent step
  (RISK-PROGRESS-01).
- **There is no roll-up.** Progress exists per lesson only. "How far through this
  course is this class" is not answered anywhere; a caller must fetch the rows
  and count. No unit, course or class aggregate, no percentage, no cohort view.
- **No time-on-task, and no attempt at one.** `last_accessed_at` is the last time
  the learner wrote to the row, not a duration, not a session, and not evidence
  of attention. Reading it as engagement data would be wrong.
- **Titles are read live, not snapshotted.** A learner keeps their rows after
  losing access, and `app_lesson_label` resolves the lesson, unit and course
  titles at read time — so renaming or re-titling a lesson rewrites what their
  history appears to say. Storing a copy at write time would freeze the label but
  duplicate content into a per-child table, which was judged the worse trade.
- **`app_lesson_label` is a SECURITY DEFINER function that returns lesson, unit
  and course titles for any lesson id to any authenticated caller.** That is the
  whole reason retention works, and it is a deliberate hole in the row-level
  model: it discloses titles, and only titles, of a lesson whose id the caller
  already holds. It returns no body, no state and no organization, and the
  progress rows it labels are themselves gated. It has not been reviewed by
  anybody but its author.
- **The forward-only guarantee is a trigger, not a constraint.** A superuser or
  the migration role can move a row backwards; `edu_app` cannot.
- **No quizzes, grading, mastery, AI tutor or experiments.** Recording that a
  lesson was completed says nothing about whether anything was learned, and this
  system makes no claim that it does.

## Added in Task 006

- **The unit of assignment is the CLASS.** Everybody in a class sees the same
  courses. There is no per-learner assignment, no differentiation, and no way to
  give one child different material (RISK-ASSIGN-02).
- **`startsOn` and `dueOn` gate nothing.** They are stored and returned, and
  that is all. A date that silently controlled visibility would be an
  authorization rule hiding in a calendar field, depending on a clock this
  system does not treat as a gate — so they are deliberately inert, and a client
  must not read them as access control.
- **Reachability is recomputed on every request and never cached.** That is what
  makes revocation instant, and it costs a query per request. It has not been
  measured at any scale (RISK-ASSIGN-03).
- **A teacher of a class may assign any published course in their school**
  without a second person involved. The content was reviewed to be published, so
  this is choosing among approved material rather than introducing new material
  — but it is still one person's decision (RISK-ASSIGN-01).
- **`app_actor_teaches_course` is currently redundant.** Every teacher also
  holds `content:author`, which already covers the published catalog, so the
  teacher route into a course changes nothing today. It is kept because it is
  the correct expression of the rule the task specifies and would carry a
  teacher if that role mapping ever changed; the RLS suite isolates it with an
  actor holding no content permission, which is the only way to show it works.
- **Guardians see no course content.** A guardian is not a class member and
  holds no content permission, so the narrowing removed the blanket published
  access they previously had. Guardian access to a child's coursework was never
  built and is not built now; this is a real reduction in what the API would
  return for them, recorded rather than glossed.
- **No notification** when a course is assigned or withdrawn. A class's syllabus
  can change under them silently.
- **Nothing records whether anybody studied anything.** An assignment says a
  class studies a course. Progress, completion and grading do not exist.

## Added in Task 005

- **Lesson bodies are stored verbatim and nothing renders them.** HTML is
  refused as a content format and `https://` is the only accepted URL scheme, so
  the stored-XSS surface is bounded — but a body may still contain
  script-looking text, and **the renderer that must escape it does not exist
  yet**. Nothing in this repository has been audited for output encoding
  (RISK-CONTENT-01).
- **No content versioning.** An edit overwrites. There is no revision history,
  no diff, and no way to answer "what did this lesson say last term?" beyond the
  archived/published status and the audit events.
- **No review workflow beyond the permission split.** There is no
  submit-for-review state, no reviewer comment, and no approval record other
  than the `content.published` audit event. A school with one account holding
  both content roles publishes with no second person involved (RISK-CONTENT-02).
- **Any editor in a school can read every draft in that school.** No per-author
  or per-team confinement exists inside an organization (RISK-CONTENT-03).
- **A course is not connected to a class.** Nothing links published content to
  the learners who should study it; visibility is organization-wide, not
  class-scoped. That link is the learning engine's, and it is not built.
- **No localisation of a single lesson.** A lesson has one title and one body.
  An Arabic-first platform that also serves English will need a translation
  model, and this schema does not have one.
- **No media, files, or attachments.** `externalUrl` points elsewhere and
  nothing validates what is there.
- **`app_course_organization` and `app_curriculum_organization` each disclose
  one fact** — which catalog an id belongs to — to any authenticated caller who
  guesses a valid id. Judged not sensitive and required to break the policy
  recursion, but it is a real, if small, disclosure.
- **Listings are offset-paginated** with the same limits as every other list; a
  course with thousands of lessons is walkable but has no cursor stability.
- **Reordering loads the whole sequence.** A course with 500 units rewrites 500
  rows in one statement. Correct, and untested above that bound.

## Added in Task 004

- **The management APIs were never driven by a human through a UI.** There is no
  frontend for any of the organization, class, roster or guardian-link
  endpoints. They _were_ driven over real HTTP against a booted server — 22
  checks covering the §3 scenarios, with the server log then searched for
  passwords, session tokens and database credentials (none present) — but no
  browser has ever touched them.
- **Guardian verification has no external check.** An administrator verifying a
  claim is asserting a family relationship the platform cannot corroborate
  against anything. A compromised or careless school administrator can create a
  false verified link within their own school, and nothing technical prevents it
  (RISK-GUARD-01).
- **A school administrator is unbounded within their school.** They may create
  and archive any class, assign any teacher, enrol or remove any student, and
  verify or revoke any family link. That is the intended authority, but there is
  no smaller unit of trust and no second-person control on any of it
  (RISK-ORGADMIN-01).
- **The teacher roster is readable by anyone who can read the class**, students
  included. Deliberate, but it is the one place on this surface where a
  relationship list is not administratively gated.
- **`relationships` joins `users` for `display_name`.** A documented, bounded
  exception to the no-cross-domain-joins rule
  (`docs/architecture/domain-boundaries.md`). It is read-only, one column, and
  runs under the caller's own RLS — but it is a reach into another domain's
  table, and it should move behind a contract if a second column is ever needed.
- **No bulk enrolment, import, invitation, or join-code path exists.** Every
  roster change is one authenticated request per person, which is correct but
  will not survive a real school's onboarding without a batch surface designed
  to the same rules.
- **Listings are offset-paginated and unbounded in total size.** A class with
  thousands of members returns them in pages, but nothing caps how many pages a
  caller may walk, and no cursor stability is guaranteed across writes.
- **`app_class_organization` and `app_user_organization` disclose one fact
  each** — which organization a class or user id belongs to — to any
  authenticated caller who can guess an id. Judged not sensitive and required to
  break the RLS policy recursion (VULN-012), but it is a real, if small,
  disclosure and it is not hidden.

## Added in Task 002

- **Production would run on `--experimental-strip-types`.** The codebase contains
  no non-erasable syntax (checked: no enums, no parameter properties, no
  decorators), and stripping is erasure-only. But an experimental flag in
  production is a real dependency on unstable behaviour. A compile step should be
  added before the first production deployment. See ADR 0003.
- **Rate limiting is per-process and in-memory.** With N replicas the effective
  limit is N times the configured value, and a restart clears it. A shared store
  is required for production and is not implemented (RISK-RATE-01).
- **Repeated-denial detection shares that limitation** — per-process, in-memory,
  cleared on restart.
- **`trustProxy` is false.** Correct for direct exposure. Introducing a proxy
  REQUIRES configuring it at the same time, or per-IP limiting silently collapses
  into a single global limit.
- **No production secret management.** No vault, no rotation, no per-environment
  injection. The expectation is that the deployment platform injects environment
  variables.
- **Offset pagination has a 10,000 ceiling.** Beyond that a list is simply not
  reachable; cursor pagination is required and is not implemented.
- **No actor-scoped rate limiting.** The limiter runs before authentication, so
  quotas are per-IP only. The reserved `ai.request` policy will need per-actor
  quotas, since provider cost is real money.

## Structural limitations

- **`Guarded<T>` cannot protect code that never wraps a record.** The fitness
  test asserts the notebook repository's return type; it cannot enforce this for
  domains that do not exist.
- **RLS does not apply to superusers.** This is a PostgreSQL property that cannot
  be switched off. The mitigation is operational: the application never connects
  as one, and the test harness refuses to run if it detects one.
- **Redaction cannot catch a secret in free text** — a password pasted into a
  note body would be logged if note bodies were ever logged. The mitigation is
  not logging user content.
- **The secret scanner is homegrown** and pattern-based. It will miss novel
  formats and high-entropy strings without a recognizable shape. It should be
  replaced by gitleaks or trufflehog.
- **The audit writer is best-effort.** A write failure does not fail the request.
  Deliberate for auth events; wrong for future grade mutations.
- **`notes.organization_id` is denormalized** and there is no flow keeping it
  correct across an organization transfer, because no transfer flow exists.
- **Only three domains exist.** The architecture is designed for ~30. That the
  patterns generalize is a reasoned expectation, not a demonstrated fact.

## Explicitly not built

Courses, lessons, curriculum, learning paths, activities, experiments and
simulations, assessments, mastery, projects, portfolios, research tools, the AI
Tutor, the AI Assistant, the AI Gateway, the knowledge base, RAG, file uploads,
malware scanning, community, moderation, notifications, analytics, admin
surfaces, feature flags, email, MFA, password reset, and account recovery.

Several of these are _described_ in this documentation. None of them exist.

## Compliance

No compliance assessment was performed. Saudi PDPL, and any obligations arising
from processing minors' data, have not been analysed. Data residency, retention
schedules, deletion rights and consent flows are unaddressed. This needs
qualified legal input, not an engineering opinion.

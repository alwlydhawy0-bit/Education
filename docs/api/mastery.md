# Learning Objectives, Evidence & Mastery API

Task 010. The layer that turns "what did this learner do?" into "what does this
learner appear to understand?" — and the first surface where the platform makes
an inference rather than recording a fact.

That distinction governs the whole design. A score is computed; a mastery state
is _judged_, and this system's judgement is deliberately weak, explicit and
reversible by inspection.

## The one-paragraph version

A **learning objective** belongs to a lesson and has a stable id. Completing a
lesson, or submitting an assessment, emits an **evidence** row for every
objective of that lesson — written by a database trigger, never by a request.
**Mastery** is a function of those rows, computed on every read; it is not stored
anywhere. Five states, five rules, no arithmetic a reader cannot check by hand.

## Why objectives became a table

0016 gave lessons an `objectives text[]`. That column could not anchor evidence,
for a reason that is a property of 0016 rather than a matter of taste:

> **A published lesson is still editable.** `lessons_update` admits a content
> author for a published lesson, unlike an activity, which 0019 freezes.

An evidence row referencing an objective _by its text_ would be silently
re-pointed when an author fixed a typo, and orphaned when they reordered the
array. A child's mastery record would change meaning because somebody edited a
sentence.

Migration 0021 promotes the array to `learning_objectives`, backfills every
statement in authored order, and **drops the column** — two authoring surfaces
for one concept is the duplication that produces a divergence nobody notices.
The lesson API still returns `objectives: string[]`, derived from the rows, so no
reader sees a change.

**Rollback:** re-add the column and repopulate from `learning_objectives`
ordered by position. The table is a superset of what the array held, so nothing
authored is lost in either direction.

## Evidence

|                                 |                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------- |
| **Written by**                  | Database triggers on `lesson_progress` and `assessment_attempts`. Nothing else.  |
| **Writable by the application** | **No.** `edu_app` holds `SELECT` on `objective_evidence` and no other privilege. |
| **Mutable**                     | No. No `UPDATE`, no `DELETE`, for any role the application can use.              |
| **Idempotent**                  | `UNIQUE (user_id, objective_id, source_kind, source_id)`.                        |

Every attack §15 of the task enumerates — a client inserting evidence, changing
its timestamp, changing its owner, changing its objective — is refused by a
**missing privilege**, not by a check somebody could get wrong. Evidence exists
only because a trigger observed a real educational event that had already passed
every authorization check the platform has.

### What counts

| Event                               | Evidence                |
| ----------------------------------- | ----------------------- |
| Lesson marked `completed`           | `lesson_completed`      |
| Assessment submitted and passed     | `assessment_passed`     |
| Assessment submitted and not passed | `assessment_not_passed` |

**Opening a lesson produces nothing.** `in_progress` is engagement, and 0018
already records it; a row saying "viewed the page" would be the fake progress
this task is told to avoid. Completion is learner-authored and forward-only, so
it is a durable claim.

**A failure is evidence.** It is recorded and it counts — towards `developing`,
never against a pass already earned.

### What attaches to what — the honest limit

An objective belongs to a lesson; both evidence sources resolve to a lesson; so
an event produces one row per objective **of its lesson**.

This is coarse, and it is stated rather than hidden: **within one lesson,
objectives assessed by the same quiz move together.** Attributing a lesson-wide
quiz to one objective rather than another would need per-question objective
tagging — a taxonomy this task declines to invent, and inventing one would let
the platform claim a precision it does not have.

## Mastery

Derived on every read by `app_objective_mastery(learner, objective)`. **There is
no mastery column in the schema**, so there is nothing for a client to forge,
nothing for a service to write, and no possibility of a stored level disagreeing
with the evidence it claims to summarise.

| State          | Rule                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `no_evidence`  | No evidence rows.                                                                                                                   |
| `attempted`    | Evidence exists, but no _countable_ assessment outcome — a completed lesson, or an attempt whose result the reader may not yet see. |
| `developing`   | Countable assessment outcomes exist; none passed.                                                                                   |
| `demonstrated` | Exactly **one** distinct assessment passed.                                                                                         |
| `mastered`     | **Two or more distinct** assessments passed.                                                                                        |

**Distinct by assessment, not by attempt.** Passing the same quiz three times is
one piece of evidence repeated; passing two different assessments covering the
objective is genuinely stronger. Counting attempts would make `mastered` mean
"sat the same paper twice", which is a claim about persistence rather than
understanding.

**It never goes down.** Every rule counts things that only accumulate, so a
later failure adds a row without removing a pass.

**There is no decay** — not because forgetting is unreal, but because a decay
rate is a claim about a child that this platform has no evidence to support.
Task 010 explicitly does not introduce one.

**There is no mastery score.** A number invites arithmetic across objectives,
and averaging incommensurable evidence is exactly the misleading aggregation the
task warns against.

### The withheld-result rule

An attempt whose result Task 009 has not released counts as `attempted` **for
the subject and their guardian**, and as its true outcome for everybody else.

A mastery state that jumped to `demonstrated` on submission would announce the
withheld mark through a different endpoint; one that read `developing` would
announce the failure. `attempted` leaks nothing — the learner knows they sat it.

Neither the evidence nor the authoritative state depends on release: a teacher
sees the truth immediately, and the stored rows are identical either way. Only
what the child is _shown_ changes, and it updates the moment a teacher releases.
It is the same expression that redacts the score columns in
`assessment.repository.ts` and gates `app_attempt_review`, so all three withhold
from exactly the same people.

> This is a deliberate reading of the task's "do not make mastery depend on
> result visibility". The stored evidence and the authoritative state do not;
> the subject's own view does, because the alternative discloses a mark Task 009
> withheld. Security outranks the literal reading, and the choice is recorded
> here rather than made silently.

## Aggregation

**Counts per state, never a blended average.** Averaging five ordinal states onto
one number requires weights nobody can defend, and it hides the distinction a
teacher most needs: whether a class is uniformly `developing` or split between
`no_evidence` and `mastered`.

One percentage _is_ offered, with a stated definition:

```
demonstratedPercentage = (demonstrated + mastered) / total × 100
```

`null` when there are no objectives — a course with nothing to demonstrate is
unmeasurable, and reporting `0` would read as failure.

**Objective mastery and lesson completion are reported separately.** A learner
can complete every lesson and demonstrate nothing; a course view that blended
them would hide exactly that. Lessons are counted **once**, however many
objectives they carry, so a course does not appear more complete the more finely
its objectives were written.

## Endpoints

| Route                                                            | Who                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /me/courses/:id/mastery`                                    | The authenticated learner, for a course they reach                 |
| `GET /me/objectives`                                             | The authenticated learner — every objective they have evidence for |
| `GET /me/objectives/:id/evidence`                                | The authenticated learner — the events behind one objective        |
| `GET /guardians/children/:childId/objectives`                    | A **verified** guardian                                            |
| `GET /classes/:id/students/:studentId/courses/:courseId/mastery` | A teacher of that class, or an `admin` of its organization         |

**There is no write route, for anyone**, including a platform operator. "The
client submitted `MASTERED`" is not a request that gets rejected; it is a request
with nowhere to go.

### Whose record is it

Never a parameter. `/me/...` is scoped by the **session**; the guardian and
teacher routes take the learner in the **path**, where it is part of the
authorization question. A forged `?learnerId=` changes nothing.

### The teacher route takes three ids

Class, student and course are all in the path because all three are part of the
question: the actor must have standing in that class, the student must be
enrolled in it, and the course must be one that class reaches. A query parameter
for any of them would invite a caller to vary one and probe.

Three different failures give the **same 404** — the class does not exist, the
actor has no standing, the student is not enrolled — so the endpoint cannot be
used to probe rosters.

## Who may read whose record

The same five readers as [learner progress](progress.md), through the same
relationships:

| Reader                  | May read                                                 |
| ----------------------- | -------------------------------------------------------- |
| The learner             | Their own, always — no access check                      |
| A **verified** guardian | Their linked child's record                              |
| A teacher               | A student in a class they teach, on that class's courses |
| An `admin`              | Any learner in their own organization                    |
| A platform operator     | Everything                                               |

`admin`, **not** `security_admin`: a security administrator manages accounts and
lockouts, and every child's learning record is a different authority that must
not ride along with it (VULN-020).

### Retention

`GET /me/objectives` and the guardian route are driven off the **evidence**, and
their labels come from `app_objective_label` — a definer function — rather than a
join to the content tree.

That is not an optimization. A verified guardian has _no_ content access at all,
and a learner who leaves a class loses theirs, so a join would return zero rows
for exactly the two readers retention exists to protect: a guardian would be told
their child had demonstrated nothing. The course view still joins, because
enumerating every objective of a course legitimately requires seeing the course.

The disclosure this makes: whoever may read an evidence row learns the objective
statement and the lesson, unit and course names attached to it. No lesson
content — the body and links stay behind `lessons_select`.

## Not built

No AI, no recommendations, no adaptive sequencing, no spaced repetition, no
prediction, no badges, no leaderboards, no decay, no mastery score, no
per-question objective tagging, no bulk teacher views, and no way for any human
to assert a mastery state. Task 010 is a foundation; each of those is a decision
that has not been made.

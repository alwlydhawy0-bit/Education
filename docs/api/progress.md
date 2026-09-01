# Learner Progress API

A learner's record of what they have studied. All routes are under `/api/v1`,
all require a session, and all follow the error shape and the `404`-versus-`403`
rule documented in [the identity API](identity.md#api-conventions).

## The asymmetry that defines this surface

Reading your own progress and writing it are gated **differently**, on purpose:

|                     | Gate                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WRITE**           | Only the learner, and only for a lesson they currently reach through a class — the whole [Task 006 chain](class-courses.md): active assignment, active class, active membership, published content. |
| **READ (your own)** | Always. No access check at all.                                                                                                                                                                     |

That asymmetry **is** the retention rule. A learner removed from a class, or
whose class loses a course, keeps every row they wrote — the record of what they
studied is theirs, and an administrative change to a timetable must not erase it
— but they can no longer add to or change it.

Gating the read the same way as the write would quietly delete a child's history
from their own view every time a timetable changed.

## Nobody writes a record about somebody else

There is no branch anywhere — not for a teacher, an administrator, a guardian,
or a **platform operator** — through which one person may author a claim about
what another person studied. This is the one place in the platform where a
platform operator is not above the rule: "who studied this" is not an
administrative fact, and no operator should be able to manufacture one.

Nor is there a `DELETE`. Progress is a record of what a child did; rows leave
only when the learner's account does.

## Who may read whose progress

| Reader                  | May read                                                                        | Through                |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| The learner             | Their own, always                                                               | —                      |
| A **verified** guardian | Their linked child's whole record                                               | Task 003 guardian link |
| A teacher               | A student enrolled in a class they teach, **on courses assigned to that class** | Tasks 004 + 006        |
| An `admin`              | Any learner in their own organization                                           | Organization boundary  |
| A platform operator     | Everything                                                                      | —                      |

Three details in that table are load-bearing:

**The teacher rule is a conjunction, evaluated on ONE class.** The learner must
be enrolled in a class the teacher teaches _and_ the lesson's course must be
assigned to **that same class**. Two separate checks — "I teach them somewhere"
and "I reach that course somewhere" — would both be true for a teacher who
reaches the course through a _different_ class they also teach, and would leak.

**`admin`, not `security_admin`.** A security administrator manages accounts and
lockouts. Giving them every child's learning record would merge two unrelated
authorities into one compromise — the same reasoning that withheld
`content:publish` from them in [ADR 0009](../architecture/adr/0009-content-lifecycle-and-duty-split.md).
Both gates say `admin` specifically, so they agree.

**A guardian sees the whole record, not the current timetable.** Withdrawing a
course from a class does not hide what the child already did; a guardian is
entitled to their child's history, not to a view that changes when staff
reorganise. A teacher's view is the opposite: it _ends_ when the enrolment does,
because that enrolment is what makes them this child's teacher at all.

## Endpoints

| Route                                           | Who                                                        |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `PUT /lessons/:id/progress`                     | The learner, for a lesson they currently reach             |
| `GET /me/progress`                              | The authenticated learner's own record                     |
| `GET /classes/:id/students/:studentId/progress` | A teacher of that class, or an `admin` of its organization |
| `GET /guardians/children/:childId/progress`     | A **verified** guardian of that child                      |

### Recording

```
PUT /lessons/:id/progress
{ "status": "completed" }
```

The body carries **one field**. Not the learner (that is the session), not the
lesson (that is the URL), and **not a timestamp of any kind**. `completedAt` and
`lastAccessedAt` come from the server clock, always: a client-supplied
completion time is a client writing history.

`PUT`, not `POST`, because recording progress is idempotent. Sending `completed`
twice is the same request twice and answers the same way both times — including
keeping the **original** completion moment.

### The state machine

```
not_started ──▶ in_progress ──▶ completed
```

**Forward only, and `completed` is terminal.** A learner may not un-complete a
lesson. This is a record their teacher and their guardian read, so "completed"
has to mean something durable; a status its own subject can toggle back is not
evidence of anything, and a learner who could retract a completion could also
erase what a teacher had already seen.

Nothing about re-study is lost — every touch moves `lastAccessedAt`, so "I went
back over this" is recorded. Only the retraction is refused, with `409`.

Enforced twice: the service answers `409` before the database is reached, and a
trigger refuses the move regardless of which code path attempts it.

### Reading

`GET /me/progress` scopes by the session and nothing else. No parameter names a
user on any of these routes.

`GET /classes/:id/students/:studentId/progress` puts **both** ids in the path,
because both are part of the authorization question. Three different failures
answer the same `404` — the class does not exist, the actor has no standing in
it, or the student is not enrolled in it — so the endpoint cannot be used to
probe a roster.

### What a progress row contains

The lesson, unit and course **names**, so the record is legible — and no lesson
**content**. The body, the objectives and the external link stay behind the
content policy; a progress row says what was studied, never the material.

The names are resolved through a `SECURITY DEFINER` helper rather than a join.
That is not an optimisation: a learner who has left the class can no longer see
the lesson at all, so a join would return **nothing** and silently erase their
own history — defeating the very rule it was meant to serve. The same is true
for a guardian, who has no content access whatsoever.

## Filtering

| Sortable                                       | Filterable           |
| ---------------------------------------------- | -------------------- |
| `lastAccessedAt`, `completedAt`, `lessonTitle` | `status`, `courseId` |

Allow-listed, as everywhere: a sort field reaches SQL as an identifier, where a
parameter placeholder cannot help. Unknown parameters are rejected rather than
ignored — including any that names a user.

## Audit

Refused reads and writes emit `authz.denied` with the action, the resource kind
and the ids. **Successful progress updates emit no event**, and that is
deliberate rather than an omission: every lesson touch would be an audit row,
and flooding the log would make the signals that matter harder to see. The
consequence is recorded honestly in
[limitations](../security/limitations.md) — there is currently no audit trail of
who _read_ a child's record.

Denial details carry ids only, never lesson titles or content: a denial record
must not become a way to read what it just refused.

## Not implemented

Quizzes, grading, scores, mastery — none of it. A progress row says a learner
reached a lesson; it records nothing about how well.

Also absent: progress at course or unit level (only lessons are tracked, and any
roll-up is the caller's arithmetic); time-on-task or any duration; a class-wide
view for a teacher (one student at a time); an audit trail of reads; and any
notification when a learner completes something.

## Where a progress row can come from

A learner writing one, and one other place: submitting an assessment marks its
lesson ENGAGED. Never complete —
[the activities & assessments API](assessment.md) is given an interface with no
parameter through which it could claim otherwise. Passing an assessment is
evidence about one paper on one day; completion is a claim only the learner may
author.

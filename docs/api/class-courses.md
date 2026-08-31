# Class–Course Assignment API

The edge that decides which learners a piece of published content actually
reaches. All routes are under `/api/v1`, all require a session, and all follow
the error shape and the `404`-versus-`403` rule documented in
[the identity API](identity.md#api-conventions).

## What this changes

Before Task 006, a published course was visible to an entire **organization**.
That was the loosest correct answer and not the right one: a Grade 7 physics
course should reach Grade 7 physics.

Since migration 0017:

> A **learner** sees a published course — and its published units and lessons —
> only when that course is **actively assigned** to an **active class** they are
> an **active member** of.

Four statuses, any one of which breaks the chain. Nothing is cached: the edge is
recomputed per request, so revocation takes effect on the very next call with
the same live session.

**The narrowing applies to learners, not to staff.** Anyone holding
`content:author` or `content:publish` still browses the published catalog — their
own school's and the global one — without an assignment. Choosing what to assign
to a class means reading the candidates first, and a person who cannot see a
course cannot assign it. That branch grants nothing publication had not already
made available to their organization.

**Curricula are deliberately NOT narrowed.** The subject catalog names subjects,
not content. Gating it behind an assignment would mean a learner could not see
that their school teaches mathematics until somebody assigned them a maths
course, which is not a boundary anyone asked for.

**An assignment can only narrow, never widen.** The catalog check from
[the curriculum API](curriculum.md) still runs first and still decides: an
assignment cannot carry a learner across an organization boundary, cannot reveal
a draft, and cannot revive an archived course. That is asserted directly — the
RLS suite forces impossible rows into existence and checks the read path refuses
them anyway.

## Endpoints

| Route                                   | Who                                                              |
| --------------------------------------- | ---------------------------------------------------------------- |
| `POST /classes/:id/courses`             | A **teacher of that class**, or an **admin** of its organization |
| `GET /classes/:id/courses`              | Members of the class, its teachers, admins of its organization   |
| `DELETE /classes/:id/courses/:courseId` | Same as `POST`                                                   |
| `GET /me/courses`                       | The authenticated learner's own courses                          |

### Assigning

```
POST /classes/:id/courses
{ "courseId": "…", "startsOn": "2026-09-01", "dueOn": "2026-12-15" }
```

The body names a **course and nothing else**. The class comes from the URL, the
assigner from the session, and the status is always `active` — so the only thing
a caller can express is "this class studies that course". There is no
`organizationId`, no `status` and no `assignedBy` field, and `.strict()` rejects
them with `400` rather than dropping them silently.

Who may assign is exactly the standing that manages a **roster**: a teacher of
that class, or an administrator of its organization. Choosing among published
courses is running the class; it is not deciding what content exists, which a
teacher may not do.

Refused, at both gates:

| Attempt                                           | Result |
| ------------------------------------------------- | ------ |
| Another school's course into this class           | `404`  |
| This school's course into another school's class  | `404`  |
| An administrator of another school assigning here | `404`  |
| A **draft** or **archived** course                | `403`  |
| A teacher who does not teach that class           | `404`  |
| A student, enrolled or not                        | `404`  |
| An **archived** class                             | `403`  |
| A duplicate active assignment                     | `409`  |

**A global course is the one case where the two organizations legally differ.**
The shared catalog is assignable by any school; a private course is assignable
only within its own.

`startsOn` and `dueOn` are **descriptive**. Neither gates access. A date that
silently controlled visibility would be an authorization rule hiding in a
calendar field, and it would depend on a clock this system does not treat as a
gate. What a class may see is decided by the assignment's status.

### Withdrawing

`DELETE /classes/:id/courses/:courseId` sets the assignment to `inactive`. It is
a **status change, never a `DELETE`**: which courses a class was taught, and
when, is part of the record of what a child was shown.

Withdrawal is addressed by **(class, course)** rather than by assignment id.
That is the pairing the caller actually knows, and it removes a whole class of
mistake — an assignment id from another class cannot be actioned under a class
the caller happens to administer, because the lookup requires both to match
before authorization even runs.

Re-assigning afterwards creates a **new row**, so each spell keeps its own dates.
The uniqueness constraint covers active rows only.

### The class syllabus

`GET /classes/:id/courses` returns every assignment on the class, withdrawn ones
included — that is the history of what the class was taught. Learners in the
class see it: the syllabus is not a secret from the people following it.

A caller with no attachment to the class gets `{ "items": [] }`, **not** a
`404`. A class with nothing assigned and a class the caller may not see answer
identically, which is the point.

### The learner's own courses

`GET /me/courses` returns the courses the authenticated actor reaches through
their **active class memberships**, with the class each came through — because
"why can I see this?" is a question a learner interface has to answer, and the
answer is the whole access rule in one field.

No parameter names a user or a class. There is no `status` filter either: a
learner's list is by definition the active assignments, and offering the filter
would imply the endpoint could return the others.

**A teacher gets an empty list.** This is a learner endpoint, scoped to
membership; a teacher reaches a class's courses through
`GET /classes/:id/courses`.

## Assignment lifecycle

```
active ⇄ inactive          withdrawn by staff, and re-assignable
   ↓         ↓
    archived               the CLASS ended; terminal
```

`archived` is set by a trigger when the class is archived, not by any endpoint.
That is **bookkeeping, not the control**: access already stops the moment the
class stops being active, because every read checks the class's status. What the
trigger does is stop an archived class leaving rows behind that claim to be
active assignments. An archived assignment cannot be reopened.

The **parties are immutable**. Re-pointing an assignment at a different class or
course would inherit its status and its history, so a trigger refuses it — the
same reasoning as the relationship tables in migration 0014.

## Revocation

Every one of these takes effect on the **next request**, on the same live
session, with no cache to expire and no re-login:

- withdrawing the assignment,
- removing the learner from the class,
- archiving the class,
- archiving the course.

## Audit events

`class.course_assigned` and `class.course_withdrawn`, both recorded with the
class, the course and the actor. Assigning a course is the moment a class's
learners gain access to a body of content, so it belongs in the same category as
a roster change rather than in a scheduling log.

## Not implemented

Progress, completion, grading, mastery — none of it. An assignment says a class
studies a course; it records nothing about whether anybody did.

Also absent: per-learner assignment (the unit of assignment is the class);
scheduling that actually gates access (the dates are descriptive); assignment to
a whole school or year group; copying an assignment between classes; and any
notification when a course is assigned or withdrawn.

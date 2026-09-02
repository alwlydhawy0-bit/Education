# Learning Activities & Assessments API

Task 008. The layer that turns
`lesson → activity → assessment → attempt → result` into something a teacher can
act on — and the first surface where **the platform makes a judgement about a
child** rather than recording one somebody asserted.

Everything before this stored claims: a roster entry an administrator made, a
progress row the learner wrote about themselves. A score is different. The
system computes it, the learner cannot argue with it, and somebody will act on
it. That raises the cost of every mistake here, and the design reflects it.

## The one-paragraph version

A **learning activity** hangs off a lesson and is the generic extension point
every future practical feature will use — simulations, experiments, exercises.
An activity of type `assessment` carries an **assessment**: questions, options,
and an **answer key that lives in its own table with its own policy**. A learner
starts an **attempt**, which is when they are handed the paper; they submit it;
**the database computes the score** and freezes the attempt. Nothing about who
may read the result is invented here — it is the same rule, through the same
helpers, that governs learner progress.

## Endpoints

### Authoring — requires a content permission

| Method | Path                                | Permission        |
| ------ | ----------------------------------- | ----------------- |
| `POST` | `/api/v1/lessons/:id/activities`    | `content:author`  |
| `POST` | `/api/v1/assessments/:id/questions` | `content:author`  |
| `POST` | `/api/v1/activities/:id/publish`    | `content:publish` |
| `POST` | `/api/v1/activities/:id/archive`    | `content:publish` |

### Reading

| Method | Path                             | Who                           |
| ------ | -------------------------------- | ----------------------------- |
| `GET`  | `/api/v1/lessons/:id/activities` | anyone who can see the lesson |
| `GET`  | `/api/v1/activities/:id`         | ”                             |
| `GET`  | `/api/v1/assessments/:id`        | ” — **metadata only**         |

### Attempts

| Method | Path                                               | Who                                                                             |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST` | `/api/v1/assessments/:id/attempts`                 | the learner, if they reach it through a class                                   |
| `POST` | `/api/v1/attempts/:id/submit`                      | the attempt's owner, while in progress                                          |
| `GET`  | `/api/v1/attempts/:id`                             | owner · verified guardian · teacher of the shared class · `admin` of the school |
| `GET`  | `/api/v1/me/attempts`                              | the learner                                                                     |
| `GET`  | `/api/v1/classes/:id/students/:studentId/attempts` | teacher of that class · `admin` of its school                                   |
| `GET`  | `/api/v1/guardians/children/:childId/attempts`     | verified guardian                                                               |

### Review and release — Task 009

| Method | Path                           | Who                                                                     |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| `GET`  | `/api/v1/attempts/:id/review`  | every reader of the attempt — the SUBJECT only once released            |
| `POST` | `/api/v1/attempts/:id/release` | teacher of the shared class · `admin` of the school · platform operator |

## Withholding a result

An assessment carries a `reviewPolicy`, fixed at authoring and frozen with the
rest of its configuration when the activity is published:

| Value           | What happens at submission                                                            |
| --------------- | ------------------------------------------------------------------------------------- |
| `on_submission` | scored and released in the same statement. The default, and exactly what Task 008 did |
| `on_release`    | scored, and the mark is **withheld from the learner** until somebody releases it      |

`on_submission` is the default so that no assessment written before Task 009
changes behaviour. Every attempt submitted before this migration was backfilled
as released at the moment it was submitted — leaving them unreleased would have
retracted results children had already been shown.

**There is no third value.** "Release after a date" was considered and refused:
it puts an authorization rule inside a clock, which this platform already
declined for `startsOn`/`dueOn` in Task 006.

### Withheld means the number is not sent

A withheld result does not arrive with a flag telling the client to hide it.
`score`, `maxScore`, `percentage` and `passed` are `null` in the response,
redacted in SQL by `assessment.repository.ts`:

```
(t.released_at IS NOT NULL
 OR NOT (t.user_id = app_current_actor() OR app_actor_guards(t.user_id)))
```

Note the shape of that expression. The withholding is from **the subject** — the
learner and their verified guardian — not from everybody. A teacher sees the
mark on an unreleased attempt, because a teacher who cannot see a result cannot
decide whether to release it. The same expression gates `app_attempt_review`, so
the two layers withhold from exactly the same people.

Row-level security cannot hide a column, which is why this lives in the query
rather than in a policy; and it lives in the repository rather than in a
serializer so that a withheld score never crosses the process boundary at all.

## Releasing

`POST /api/v1/attempts/:id/release` takes an optional `teacherComment` and
**nothing else**. No learner, no class, no organization, and no score —
`.strict()` turns any of those into a `400` rather than a silently ignored
field. The attempt is the URL; the actor is the session.

- **A learner can never release their own result.** Checked in the policy before
  any read branch, and again by the RLS release policy, which has no learner
  branch at all. Everything else in this task follows from that one rule: a
  result the subject can disclose is not a result anyone else can rely on.
- **A verified guardian cannot release either.** They may read what their child
  was told; deciding what a child is told about their own assessment is a
  teaching act, not a parental one.
- **A platform operator may** — unlike `start` and `submit`, which they may not.
  The direction of the act is what separates them: releasing discloses a mark
  the database already computed; starting or submitting would manufacture
  evidence about what a child did.
- **Releasing twice is idempotent.** The RLS policy carries
  `released_at IS NULL` in its `USING` clause, so a second release matches zero
  rows, changes nothing, and returns the current state. The original releaser
  and timestamp are never overwritten.
- **A release cannot be undone.** There is no endpoint, and the database refuses
  it: once `released_at` is set the row is invisible to the release policy.
- **A release cannot carry anything else.** The submit guard compares the whole
  row minus the three release columns, so a statement setting `released_at` and
  `score` together is refused outright rather than partially applied. A teacher
  who may release is still not a teacher who may mark.

The release timestamp is the server's. A caller-supplied `released_at` is
overwritten with `now()` by the guard, so a release cannot be backdated.

Each release emits `assessment.result_released` carrying the attempt, the
assessment, the learner and whether a comment was attached — never the mark.
"Who decided this child could see their result, and when?" has to be answerable
from the audit trail alone; the mark itself does not.

## The marked paper

`GET /api/v1/attempts/:id/review` is the **only** response in the system that
carries correct answers, and it carries them for exactly one attempt.

```
{
  "attempt": { ... }, "released": true, "releasedAt": "...", "teacherComment": null,
  "questions": [
    { "questionId": "...", "position": 1, "prompt": "...", "points": 2,
      "awarded": 0, "isCorrect": false,
      "selectedOptionIds": ["..."], "correctOptionIds": ["..."],
      "explanation": "...", "options": [ ... ] }
  ]
}
```

It is a separate endpoint rather than a flag on `GET /attempts/:id` because they
are different disclosures that open at different moments.

Three properties make it safe to grant `EXECUTE` on the underlying
`app_attempt_review` to the application role:

1. **It self-authorizes.** `app_score_attempt` is granted to nobody because it
   answers unconditionally for any id. This one re-asks both questions in its own
   `WHERE` clause, so an id alone buys nothing.
2. **It requires release — of the subject.** Before release a learner and their
   guardian get **no rows at all**: not the key, not correctness, not even how
   many questions there were. Empty rather than redacted, because a redacted
   paper still discloses its shape.
3. **It is scoped to one attempt.** There is no form of the query that walks an
   assessment, a class or a learner.

`assessment_answer_keys` is **not** widened by any of this. A learner's own
connection still reads zero rows from that table; what changed is that one
released paper can be rendered.

### `explanation` vs `teacherComment`

Two feedback fields with different audiences, kept apart on purpose:

- `explanation` is authored **on the question**, shown to everyone who reviews
  that assessment. It must never mention a particular learner.
- `teacherComment` is written **on the attempt** at release, and is that one
  learner's.

Neither is generated. Task 009 introduces no AI feedback of any kind.

## The answer key

**It is not a column, it is a table.** `assessment_options` holds what a learner
is shown; `assessment_answer_keys` holds which of them is right, in a separate
relation whose RLS policy has **no learner branch at all** — not a narrowed one,
none.

This is the difference between a boundary and a discipline. Storing correctness
as a boolean on the option row would make non-disclosure depend on every
`SELECT` list in the codebase being written carefully, forever. Row-level
security cannot say "you may read this row but not that column". A separate
table can say "you may not read these rows", and it says it to a learner holding
a database connection and arbitrary SQL.

Four independent things have to fail before a key reaches a learner:

1. **RLS** — `assessment_answer_keys_select` admits only a platform operator, or
   an actor holding a content permission _in the owning school_.
2. **The repository** — nothing in `apps/api` reads the table. Architecture
   rule 10 asserts that mechanically: `assessment_answer_keys` may appear only
   in an `INSERT`, never after `FROM` or `JOIN`.
3. **The response schemas** — `attemptQuestionSchema` has no field that could
   hold correctness, and every response is built field by field through it.
   Rule 10 also refuses a schema that grows one.
4. **The scorer** — `app_score_attempt` compares the key inside the database and
   returns two integers. It is granted to **no role**, so the application cannot
   execute it even by mistake.

**Who CAN read a key:** a platform operator, and any actor with `content:author`
or `content:publish` in the school that owns the content. That includes **every
teacher in the school**, because the `teacher` role carries `content:author`.
Intended — a teacher discussing an assessment needs its answers — but a wider
audience than "the person who wrote it", and recorded as `RISK-ASSESS-02`.

### What a learner never learns

- Which option is correct, at any point, including **after submitting**.
- **Per-question correctness.** On a two-option question, "you got this wrong"
  _is_ the key. A review-after-close feature needs a deliberate release policy
  and a teacher's control over it; it is not being smuggled in as a convenience.
  See `limitations.md`.
- **How many options a multiple-choice key contains.** `selectionLimit` is
  derived from the question TYPE, never from the key: `single_choice` and
  `true_false` return 1, `multiple_choice` returns `null`. Publishing the size
  would narrow the guess space from 2ⁿ subsets to n-choose-k, for free.

### Questions are handed out at the START of an attempt

`GET /api/v1/assessments/:id` returns metadata: title, instructions, question
count, maximum score, passing percentage, attempts allowed and attempts used. It
does **not** return the paper.

The paper comes back from `POST .../attempts`, and from `GET /attempts/:id`
while that attempt is still in progress. Question-bank harvesting is therefore
bounded by the attempt limit rather than open to anyone who can see the
assessment, and re-reading a _submitted_ attempt returns no questions at all.

## Scoring

**The application does not compute a score, and has none to send.** The entire
submission statement is:

```sql
UPDATE assessment_attempts SET status = 'submitted' WHERE id = $1
```

A `BEFORE UPDATE` trigger then assigns `score`, `max_score`, `percentage`,
`passed` and `submitted_at` from `app_score_attempt`. That is a stronger claim
than validation: a forged score is not rejected, it is **overwritten**, so there
is no code path — correct or compromised — through which one could be written.

**The rule.** A question is awarded its full `points` when the SET of options
selected is exactly the SET in its key. Otherwise nothing. No partial credit, no
negative marking. `max_score` sums every question regardless of what was
answered, so an unanswered question lowers the percentage rather than shrinking
the denominator.

Set equality is order- and duplicate-independent by construction (`array_agg`
with `ORDER BY`, over tables with primary keys). A question whose key is empty
awards nothing even if the learner also answered nothing — publication
validation makes that unreachable, and the scorer refuses to pay out on it
anyway.

The rule is specified and enforced in **one** place, SQL, and is therefore
tested against a real database in `tests/integration/rls-assessment.test.ts`
rather than as a unit. A second TypeScript implementation would be unit-testable
and could disagree with the one that actually marks children's work.

## Attempts

Every authoritative column is written by the database:

| Column                                                       | Written by                                               |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `attempt_number`                                             | a `BEFORE INSERT` trigger, from a SECURITY DEFINER count |
| `status`, `started_at`                                       | the same trigger                                         |
| `score`, `max_score`, `percentage`, `passed`, `submitted_at` | the submit trigger                                       |

An INSERT arriving as `{attempt_number: 99, status: 'submitted', score: 100}` is
stored as attempt 1, in progress, with no result — silently, because there is
nothing for the caller to be told.

**The attempt limit has no "unlimited" value.** `max_attempts` is `1..50`. An
assessment a learner may attempt without bound is an answer-key oracle: submit,
read the score, vary one answer, repeat. The limit is enforced by a trigger over
a _definer_ count, so an attempt RLS had hidden still counts — counting only
visible attempts would grant a free extra one in exactly the case with least
standing.

**A submitted attempt is frozen.** No column may change, and no answer may be
added. Enforced by the trigger (which can see `OLD`) _and_ by the RLS `UPDATE`
policy carrying `status = 'in_progress'` in its `USING` clause. There is no
`DELETE` grant on any table in this domain.

## Access

Assessment access **inherits** the content graph; it does not restate it.

```
lessons_select  ← the single source of truth for lesson visibility
  └─ learning_activities_select   asks it via app_actor_sees_lesson()
       └─ assessments_select      asks the activity
            └─ assessment_questions_select
                 └─ assessment_options_select
```

Each link is an **INVOKER** (not `SECURITY DEFINER`) SQL function, so the query
inside runs under the caller's own policies. "May this actor see this lesson?"
took three migrations and two vulnerabilities to get right; restating it here
would create a copy that could drift, and the drift would be invisible because
each copy would have its own tests. Narrowing lesson access — as Task 006 did —
narrows all of these on the next request, with nothing to remember to update.

**Reading an attempt** uses the same five branches as `lesson_progress`, through
the same helpers:

| Reader            | Edge required                                                                  |
| ----------------- | ------------------------------------------------------------------------------ |
| The learner       | — (own row, unconditionally)                                                   |
| Guardian          | a **verified** guardianship (Task 003)                                         |
| Teacher           | teaches a class **and** the learner is an active member of **that same** class |
| Administrator     | `admin` — not `security_admin` — of the learner's own organization             |
| Platform operator | reads only; may not start or submit                                            |

**Writing is the learner's alone.** No branch admits a teacher, guardian,
administrator or platform operator to `start` or `submit`. Both are checked
_before_ the platform-operator branch — the one inversion of the usual ordering
in this codebase — because a mark an adult can manufacture is not evidence that
a child sat anything.

**Individual answers are narrower than the attempt.** A teacher may read a
score; `assessment_attempt_answers` is readable by the owner only, and no
endpoint returns selections at all. Widening that later is a visible decision in
a migration rather than something a new endpoint inherits.

## Retention

Losing class access stops new attempts and hides the assessment. It does **not**
erase results — and making that true took the same care as it did for progress
(VULN-024, met again here). A learner who has left the class can no longer see
the `assessments` row, so any query joining it to label a result would return
zero rows and silently delete their marks from their own view while the rows sat
intact. Nothing in the module joins the content tree; titles come from
`app_assessment_label`, a definer helper.

One consequence, recorded rather than hidden: an attempt left **in progress**
when access is revoked can never be submitted, because writes require current
access. It stays in progress indefinitely.

## The lifecycle, and the duty split

An activity is `draft → published → archived`, one way, and its status **is** the
assessment's status — the assessment has no lifecycle of its own. Two
independently publishable rows describing one thing a learner sees can disagree,
and every combination would then need a rule.

The existing separation of duties is preserved exactly:
`content:author` writes, `content:publish` decides children will be scored by it
(ADR 0009). `content_lifecycle_guard` from migration 0016 is reused verbatim —
the activity's lifecycle columns were shaped to match so it could be.

**Publication validates the whole question set**, once, and it is the only
moment that means anything: questions, options and keys are immutable after
publication, so what was well-formed when published stays well-formed. It
refuses an assessment with no questions; a question with fewer than 2 or more
than 10 options; a `true_false` without exactly 2; a `single_choice` or
`true_false` without exactly one correct answer; and a `multiple_choice` where
every option is correct (unfailable, so it adds marks without measuring
anything).

**A published activity can no longer be edited at all** — stricter than the
content policy, which permits editing published lessons. An activity's content
is the paper a learner sits; changing it would mean two attempts at "the same
assessment" had been marked against different papers, with no way to recover
which.

## Rate limiting

Two named policies, `assessment.attempt` and `assessment.submit`, both 200 per
15 minutes, wired through the existing catalogue.

Stated honestly: these are **secondary**. The limiter is per-IP and a classroom
shares an IP, so a limit tight enough to stop a determined grinder would also
stop thirty children sitting a test. The primary control against answer-key
probing is the per-learner attempt limit. The limiter remains per-process and is
not distributed — see `docs/security/rate-limiting.md` and `RISK-RATE-01`.

## Security events

| Event                                                       | When                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `assessment.attempt_started`                                | an attempt is opened                                       |
| `assessment.submitted`                                      | an attempt is submitted, with the pass flag and no answers |
| `assessment.attempt_limit_exceeded`                         | the limit refuses a start                                  |
| `assessment.suspicious_submission`                          | a payload no interface can produce                         |
| `authz.denied`                                              | every denial, reused rather than duplicated                |
| `content.created` / `.updated` / `.published` / `.archived` | authoring, reused                                          |

Every record carries **ids only** — never a prompt, an option body, a selected
option, or anything from the key. The audit trail is more widely readable than
the assessment is, so a denial record that carried what it refused would be a
way to read it.

## Progress

Submitting an assessment marks the lesson **engaged**, never **complete**. The
interface the assessment module is given (`LessonEngagementRecorder`) has no
parameter through which it could do otherwise. Passing an assessment is evidence
about one paper on one day; completion is a claim only the learner may author
(migration 0018), and inferring it would be exactly the mastery reasoning this
platform does not do.

## Not built

No essay or free-text answers, no AI grading, no teacher manual grading, no
partial credit, no timing or deadlines, no question editing after creation, no
gradebook, no roll-up beyond a single attempt's score, and no mastery.
Assessment results are evidence; they are not mastery, and this API makes no
claim that they are.

Task 009 added per-question review and controlled release. It did **not** add:
bulk release for a whole class, release scheduling, un-release, a teacher's
ability to adjust a mark, or generated feedback of any kind. A teacher who
disagrees with a mark publishes a corrected assessment — the same answer Task
008 gave for a bad question, and for the same reason: a mark must always name
the paper it scored.

# Curriculum & Course API

Educational levels, curricula, courses, units and lessons. All routes are under
`/api/v1`, all require a session, and all follow the error shape and the
`404`-versus-`403` rule documented in [the identity API](identity.md#api-conventions).

## The model

```
education_levels          global reference data — Primary, Middle, Grade 7 …
curricula                 the subject catalog — Mathematics, Physics …
  └── courses             a subject taught at a level
        └── course_units  ordered
              └── lessons ordered
```

Two axes govern everything on this surface, and they are independent.

**Ownership.** `organizationId: null` means the **global catalog** — authored by
a platform operator, readable by everybody. A non-null value means the content
belongs to one school and is invisible outside it. There is no third state, and
no row may move between the two: a trigger pins `organization_id` for the life
of the row.

**Lifecycle.** `draft → published → archived`, one way. `published` is the only
state a learner may see; `draft` and `archived` are editorial states, hidden
(404) rather than refused (403) from anyone without editorial standing. There is
no un-publish — retracting content a class is midway through has consequences
beyond this table, so the supported move is to archive and supersede.

## Separation of duties

Two permissions, deliberately not one:

| Permission        | Grants                                               | Held by                              |
| ----------------- | ---------------------------------------------------- | ------------------------------------ |
| `content:author`  | create and edit **draft** content in your own school | `content_author`, `teacher`, `admin` |
| `content:publish` | move content along the **lifecycle**                 | `reviewer`, `admin`                  |

A teacher may write a lesson. Making it visible to students is an editorial act
they do not hold. Collapsing the two into one permission is how unreviewed
material reaches a classroom, so the split is enforced twice: `contentPolicy`
refuses the action, and a database trigger refuses the UPDATE by comparing which
**columns** changed — something a row-level policy cannot see.

`security_admin` holds **neither**. That role administers accounts and lockouts;
giving it editorial control over what children read would merge two unrelated
authorities into one compromise. A **platform operator** (global
`security_admin`) is exempt from the split, because they are the only actor who
can author global content and would otherwise be unable to publish it.

## Who sees what

**Since Task 006 a learner also needs the course to be assigned to a class they
are in** — see [the class–course assignment API](class-courses.md). For a
learner the table below is the CATALOG rule: necessary, not sufficient. Staff
holding a content permission are exempt from the assignment requirement, because
choosing what to assign means reading the candidates first.

| Actor                   | Published, own school | Published, global | Draft / archived, own school | Anything, another school |
| ----------------------- | --------------------- | ----------------- | ---------------------------- | ------------------------ |
| Student, guardian       | ✅ if assigned        | ✅ if assigned    | ❌ 404                       | ❌ 404                   |
| Teacher, content author | ✅                    | ✅                | ✅                           | ❌ 404                   |
| Reviewer                | ✅                    | ✅                | ✅ (must, to review)         | ❌ 404                   |
| Admin                   | ✅                    | ✅                | ✅                           | ❌ 404                   |
| Platform operator       | ✅                    | ✅                | ✅                           | ✅                       |

**A lesson is only as visible as its least-visible ancestor.** A published lesson
inside a draft unit is not student-visible, and neither is a published unit
inside a draft course. The whole-chain answer is computed in SQL and carried on
the resource as `ancestorsPublished`, so the policy never walks the tree and the
two gates cannot disagree about it.

**No school actor may write to the global catalog** — not a teacher, not an
admin. Reading published global content is open to everyone; writing it is a
platform-operator act, and the operator role cannot be granted over HTTP at all
(migration 0013).

## Endpoints

### Education levels

| Route                         | Who                                          |
| ----------------------------- | -------------------------------------------- |
| `GET /education-levels`       | Any authenticated actor                      |
| `POST /education-levels`      | **Platform operator only** (`403` otherwise) |
| `PATCH /education-levels/:id` | Same                                         |

Levels are shared vocabulary. If each school could mint its own, content would
stop being comparable between schools and the vocabulary a national curriculum
depends on would fork silently. Refusals here are `403`, not `404`: every actor
can already read every level, so hiding one would be theatre.

### Curricula, courses, units, lessons

The same shape at every level of the tree:

| Route                                                          | Requires                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /curricula`, `POST /courses`                             | `content:author` in your own school; `global: true` needs a platform operator |
| `POST /courses/:id/units`, `POST /units/:id/lessons`           | Editorial standing on the **parent**                                          |
| `GET …` (single and list)                                      | Published, or editorial standing                                              |
| `PATCH …`                                                      | `content:author`; refused on archived content (`403`)                         |
| `POST …/publish`                                               | `content:publish`; only from `draft`                                          |
| `POST …/archive`                                               | `content:publish`; from `draft` or `published`                                |
| `DELETE …`                                                     | `content:author`, and **only while `draft`** (`403` otherwise)                |
| `PUT /courses/:id/units/order`, `PUT /units/:id/lessons/order` | `content:author` on the parent                                                |

**Nothing in a request body carries `status`, `organizationId`, `createdBy`, or
`position`.** All four are server-derived, and all four are rejected with `400`
rather than silently dropped — sending them is a mass-assignment attempt, and a
quietly ignored field is a lie to the client.

`global: true` is a **boolean**, not an organization id. The only two
destinations are "my school" and "the shared catalog", so there is no field
through which a caller could aim at another school.

### Reordering

`PUT /courses/:id/units/order` takes `{ "order": [id, id, …] }` — the **complete
new sequence**, not a move.

A move ("put X at position 4") is ambiguous under concurrency and cannot be
validated against anything. A full ordering can: the service checks the
submitted set is exactly the current set, so a reorder can neither introduce an
id from another course (which would silently reposition it, and confirm it
exists) nor omit one (which would leave a hole). A mismatch is `409`; a repeated
id is `400`.

Positions are rewritten in one statement with the unique constraint deferred —
mid-shuffle a position is briefly occupied twice, and an immediate constraint
would reject a legitimate reorder.

### Deletion

`DELETE` works **only on a draft**. Published content has been seen by learners
and removing the record of what was taught is not an editing operation;
archiving is the supported move and keeps the history. Attempting to delete
published or archived content is `403`.

Deleting a course cascades to its units and lessons. Deleting a **curriculum**
that still has courses is `409` (`ON DELETE RESTRICT`): a catalog entry may not
vanish from under the courses filed in it.

### Listing and filtering

Sortable fields and filters are allow-listed per resource. A sort field reaches
SQL as an **identifier**, where a parameter placeholder cannot help, so the
allow-list _is_ the injection defence; anything else is `400`. Filters are
allow-listed too, because filtering by an attribute the caller may not read and
counting the results discloses it.

| Endpoint                                           | Sort                        | Filters                                      |
| -------------------------------------------------- | --------------------------- | -------------------------------------------- |
| `GET /curricula`                                   | `createdAt`, `name`, `code` | `status`, `scope`                            |
| `GET /courses`                                     | `createdAt`, `title`        | `status`, `scope`, `levelId`, `curriculumId` |
| `GET /courses/:id/units`, `GET /units/:id/lessons` | `position`                  | `status`                                     |

`scope=organization` resolves to the **session's** organization, never a
parameter. Unknown query parameters are rejected rather than ignored.

Every listing is filtered twice: RLS scopes the rows, then the service runs the
policy over each one and keeps only the allows. The second pass is a no-op
whenever RLS is working, which is exactly why it belongs there.

## Content lifecycle integrity (Task 011)

The tree already had three statuses. What it did not have was any rule tying a
node's status to its parent's, or protecting the parts of a lesson that a
learner's record points at. Migration `0022_content_lifecycle_integrity.sql`
adds those rules **in the database**, as triggers, so they hold for any writer —
the API, a future job, a DBA with `psql`.

There is deliberately **no versioning and no review state**. The existing
`draft → published → archived` model plus these rules covers every requirement
of the task; a revision history would be a large, permanent structure bought for
a problem nobody has yet stated, and a `pending_review` state would encode a
workflow nobody has designed. The separation of duties that matters — authoring
cannot publish — is already enforced by permissions.

### What the rules are

| Rule                                                                                | Why                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A lesson's **objectives** are frozen once it leaves `draft`                         | Learners' evidence points at objective ids. Rewording one silently changes what a stored mastery record _means_. |
| A published activity's **definition** is frozen (title, instructions, type, lesson) | The same, for the thing a learner was actually assessed on.                                                      |
| A node may be **published** only when its parent is published                       | Otherwise a "live" lesson hangs off a draft unit and the published chain stops meaning visibility.               |
| A node may be **archived** only when no published child remains                     | A retired subtree must not leave children claiming to be live.                                                   |
| A lesson may be published only with `contentBody` **or** `externalUrl`              | Publishing an empty lesson to children is the one validation with a real reason.                                 |

Nothing else is required at publish. Objectives, activities, a summary and a
duration are all **optional**, because no rule anywhere makes a lesson without
them wrong.

Archiving **cascades** — a course archives its units, lessons and published
activities, deepest first, in one transaction. Publishing does **not** cascade:
a parent going live must never drag unreviewed drafts out with it.

A refusal is `409` with the database's own message, not `500`, and is recorded
as `content.lifecycle_refused`.

### Optimistic concurrency on a lesson

`GET /lessons/:id` returns `updatedAt`. `PATCH /lessons/:id`,
`POST /lessons/:id/publish` and `POST /lessons/:id/archive` accept an optional
`expectedUpdatedAt`; when present it must equal the stored value or the write is
refused with:

```json
{ "error": { "code": "CONFLICT", "message": "…", "detail": { "reason": "stale_write" } } }
```

Branch on `detail.reason`, never on the message. A `stale_write` is fixed by
reloading and reapplying; any other `409` is a lifecycle rule and reloading will
not help.

The token is a **precondition, not a field**: it is never stored, a patch
carrying only the token is `400` ("at least one field"), and omitting it is
allowed — a script with no earlier read has nothing to be stale against, so
last-write-wins remains the default for non-browser callers.

The check takes a row lock (`SELECT … FOR UPDATE`) before comparing, so two
authors cannot both read the same token, both find it current and both write.
`updated_at` is bumped with `GREATEST(now(), updated_at + interval '1 ms')`, so
it strictly increases per row and two writes in the same millisecond cannot
produce the same token.

**Only lessons carry a token.** Curricula, courses and units do not, because
nothing edits them interactively yet and an untested token nobody sends is worse
than none. Recorded in [limitations](../security/limitations.md).

### Server-computed permissions

`GET /lessons/:id` and every single-lesson write response include:

```json
"permissions": { "update": true, "publish": false, "archive": false }
```

These come from the **same policy engine call the write path makes**, evaluated
on the row as it stands after the write. They exist so a client does not have to
hold a second copy of the publish rule that can drift from the enforced one.

They are a rendering hint, **not a grant**. Every write re-decides regardless,
and a client that ignores them entirely gets identical answers. The field is
**output only** — sending `permissions` in a request body is `400`.

List endpoints (`GET /units/:id/lessons`) omit the block: a list is a catalogue,
not a set of action targets, and three policy decisions per row would put the
cost of the authoring screen on every browse.

Computing them records **no** `authz.denied` events. Those exist for attempted
actions; logging a question nobody asked would bury real probing.

## Learner delivery (Task 012)

Delivery adds **no new endpoints**. A learner walks the same routes staff do,
and the difference is entirely in what the policy engine and RLS return.

### The one visibility rule

A learner reaches a node **iff**:

```
status = 'published'
  AND every ancestor is published
  AND (the catalogue is global OR it belongs to the learner's organization)
  AND the course reaches them through a class they are in
```

All four conjuncts are enforced **twice** — once in `contentPolicy`
(`packages/authz`) and once in the RLS `SELECT` policies (0016, narrowed by
0017). Neither layer is permitted to be the only one that holds; see
_Independent layers_ below.

Curricula are deliberately exempt from the class conjunct: the subject catalogue
names subjects, not content, and a learner should be able to see that their
school teaches mathematics before anybody assigns them a maths course.

### Navigation, and why there is no tree endpoint

A learner screen costs a **constant** number of requests:

| Screen     | Requests                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------- |
| My courses | `GET /me/courses`                                                                             |
| One course | `GET /me/courses/:id/mastery` — units, lessons, objectives, progress and mastery in one query |
| One lesson | `GET /lessons/:id` + `GET /lessons/:id/activities`                                            |

A second course-tree endpoint was considered and refused. `/me/courses/:id/mastery`
already returns the whole authorized tree in one statement; a delivery-shaped
copy would be a second query answering "what may this learner see", and the copy
nobody tests is the one that drifts.

Two requests per lesson is **not** an N+1: it is O(1) per screen and stays O(1)
however many activities the lesson has. Asserted in `tests/web`.

### What a learner receives

The lesson response is the same DTO an author receives. Reviewed field by field
in Task 012 and found to carry nothing an author may see and a learner may not:

- `createdBy` is **absent** from the schema entirely — authorship is audit data.
- `permissions` describes the **reader's own** capabilities and is all-false for
  a learner. It is not content data and discloses nothing about the lesson.
- `status` is always `published` for a learner, because nothing else is
  reachable.
- `updatedAt` is a write precondition. Useless to a reader who cannot write, and
  retained because it reveals only when staff last edited material the learner
  can already see.

Rather than trusting that review to stay true, the exact key set is **asserted**
in `tests/security/learner-delivery.test.ts`, alongside a deny-list
(`createdBy`, `organizationId`, `isCorrect`, `answerKey`, …) applied to every
learner-facing payload. A field added later is a failing test, not a silent
widening.

Assessment delivery is separately shaped: `attemptQuestionSchema` carries
`{ id, position, body }` per option and **nothing else** — asserted as an exact
set, because a deny-list cannot name a field nobody has invented yet.

### Independent layers

Defect injection in Task 012 showed that these two layers cover for each other,
which is what they are for and also a testing hazard:

- Removing the organization boundary from `contentPolicy` left every HTTP test
  passing (RLS held) and failed **7 policy unit tests**.
- Removing `status = 'published'` from the `lessons_select` RLS policy left every
  HTTP test passing (the policy held) and, at the time, failed **nothing** —
  every existing RLS test varied an _ancestor's_ status rather than the lesson's
  own. Two tests were added to close that gap.

So each layer is now challenged where it can be observed alone: the policy in
`tests/unit`, RLS in `tests/integration/rls-*`, and the application layer with
RLS switched off in `tests/security/layered-defense.test.ts`.

### Query hygiene

Every route that takes no query parameters parses `emptyQuerySchema` — a
`z.object({}).strict()`. See VULN-034: `/me/objectives` answered `200` to
`?learnerId=<somebody else>` while every sibling answered `400`, which is an
encouraging signal to give a caller who is probing.

## Content safety

Lesson bodies are **markdown or plain text, never HTML**. Accepting HTML would
make every lesson a stored-XSS vector aimed at children, and the renderer that
would have to neutralise it is not in this repository to be audited. A body is
stored verbatim; **a renderer must still escape it** — this is an input
restriction, not sanitisation.

`externalUrl` is `https://` only, with no whitespace, enforced in the contract
and again by a database CHECK. A `javascript:` URL is script injection, a
`data:` URL is the same thing wearing a hat, and an arbitrary scheme becomes an
SSRF vector the moment anything server-side follows it.

`contentBody` is capped at **64,000 characters** — deliberately well under the
256 KiB request-body limit, and with room for Arabic, where a character is two
UTF-8 bytes. A limit the transport rejects first is not a limit.

## Audit events

`content.created`, `content.updated`, `content.published`, `content.archived`,
`content.deleted`, `content.reordered`, `content.education_level_changed`, plus
`authz.denied` on every refusal.

Task 011 adds two more. `content.lifecycle_refused` records an actor **with**
standing attempting something the content's _state_ forbids — a burst aimed at
published assessment content is somebody testing whether an answer key can still
be moved. `content.stale_write_refused` records a write rejected because its
concurrency token was stale; ordinarily two authors colliding, but a stream of
them against one lesson id from one session is what a replayed request looks
like. Both carry the resource kind and id and nothing else: never the rejected
content, and never which actor won the race.

`content.published` is the one that matters: it is the moment material becomes
visible to learners, behind a permission that authoring does not confer. "Who
made this visible to children, and when?" is answerable from the audit trail
alone.

## Not implemented

Content versioning or revision history — an edit overwrites, and Task 011
deliberately did not add one (see _Content lifecycle integrity_ above for why).
Optimistic concurrency exists only for **lessons**. Review workflows
beyond the permission split — no submit-for-review state, no reviewer comments,
no approval record beyond the audit event. Localisation of a single lesson into
multiple languages. Media or file attachments. Prerequisites, dependencies, or
any ordering constraint between courses. Copying or forking global content into
a school. Bulk import. Learner-facing progress and mastery. (A course IS now
connected to a class — Task 006 — but nothing records whether anybody studied
it.)

## What hangs off a lesson

A lesson is content to read. What a learner DOES with it — an assessment today,
a simulation or an experiment later — is a learning activity, documented in
[the activities & assessments API](assessment.md). An activity inherits this
tree's visibility exactly, by asking it rather than restating it.

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

`content.published` is the one that matters: it is the moment material becomes
visible to learners, behind a permission that authoring does not confer. "Who
made this visible to children, and when?" is answerable from the audit trail
alone.

## Not implemented

Content versioning or revision history (an edit overwrites). Review workflows
beyond the permission split — no submit-for-review state, no reviewer comments,
no approval record beyond the audit event. Localisation of a single lesson into
multiple languages. Media or file attachments. Prerequisites, dependencies, or
any ordering constraint between courses. Copying or forking global content into
a school. Bulk import. Learner-facing progress and mastery. (A course IS now
connected to a class — Task 006 — but nothing records whether anybody studied
it.)

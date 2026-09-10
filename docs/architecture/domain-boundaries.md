# Domain Boundaries & Data Ownership

## The ownership rule

**One module owns each table, and it is the only module that queries it.**

Cross-domain access goes through a contract the owning module exposes. This is
what makes a domain extractable into its own service later: if a module's tables
are only ever touched by that module, the seam is already cut.

## Domains today

### `identity` — **[BUILT]**

Owns `users`, `user_roles`, `sessions`. Responsible for registration, login,
logout, session lifecycle, and constructing the `Actor`.

Exposes `IdentityService` (`register`, `login`, `logout`, `authenticate`).
Structurally satisfies `platform`'s `SessionAuthenticator` interface — note the
direction: `platform` does not import `identity`.

### `relationships` — **[BUILT]**

Owns `classes`, `class_memberships`, `teacher_assignments`,
`guardian_relationships`.

These tables are **authorization inputs**, not descriptive data — a wrong row
silently widens who can read a child's work. That is why their constraints are
tighter than reference data would warrant (no self-guardianship; a `verified`
link must record _when_; an `ended` assignment must record _when_).

Exposes `RelationshipReader.loadSnapshot(tx, actorId)`, returning only
**verified** guardianships and **active** assignments, so no caller can forget to
filter. Since Task 004 it also exposes `ClassesService` and `GuardiansService`
for the management APIs (`docs/api/relationships.md`).

Two invariants hold across all four tables and are enforced in the database, not
only in code:

- **The parties of a relationship are immutable.** A `BEFORE UPDATE` trigger
  (migration 0014) rejects any change to `class_id`, `user_id`, `teacher_id`,
  `guardian_id` or `child_id`, and to a class's `organization_id`. RLS can say
  who may update a row but not which columns may change, so without the trigger
  an actor permitted to update a row they participate in could re-point it at
  somebody else and inherit its status.
- **Detachment is a status change, never a `DELETE`.** The roster history is the
  audit trail for who could read whose work, and when. Ended rows are immutable;
  re-attaching creates a new row, and the unique indexes cover **active** rows
  only (migration 0015).

**Teacher-to-student is derived, not stored** — the actor has an active
assignment to an active class in which the student has an active membership. The
join lives here and only here, so ending any one of the three revokes access
immediately and no caller can check two conditions and forget the third. See
[ADR 0008](./adr/0008-rbac-scopes.md).

### `users` — **[BUILT]**

Owns `profiles`, and the administrative read/write surface over `users` that
`identity` does not provide (listing, reading, suspension, role grants).

**[OPEN]** `users` and `identity` therefore both query `users`. Splitting the
authentication path from the administrative path was deliberate — the former is
pre-authentication and definer-bounded, the latter is fully authorized — but it
means the "one module owns each table" rule is honoured at the level of
_columns and operations_ here rather than of the table. If a third writer
appears, extract a shared owner instead of adding one.

### `organizations` — **[BUILT]**

Owns `organizations`. Deliberately thin: create, read, list, rename. It is
separate from `relationships` because the tenancy root has a different authority
model — only a **platform operator** (global `security_admin`) may create one,
and every other domain treats an organization id as a value it was given, never
one it may choose.

### `assessment` — **[BUILT]**

Owns `learning_activities`, `assessments`, `assessment_questions`,
`assessment_options`, `assessment_answer_keys`, `assessment_attempts` and
`assessment_attempt_answers`. The domain where the platform first computes a
judgement about a child rather than recording one.

**It owns the generic ACTIVITY boundary as well as assessments**, and that is a
deliberate temporary arrangement rather than a permanent shape.
`learning_activities` carries identity, a lesson, a type, ordering and a
lifecycle, and knows nothing about what an activity DOES; `assessments` is a 1:1
extension of an activity whose type is `assessment`. When a second activity type
is implemented — the 2D experiment engine is the expected one — the activity
table is extracted into its own `activities` module, which is a rename plus a
policy split rather than a redesign, because nothing about the table presumes
assessments.

An assessment has **no lifecycle of its own**: the activity's status is its
status. Two independently publishable rows describing one thing a learner sees
can disagree, and every combination would then need a rule.

**It reads no other domain's tables**, and one cross-domain write is arranged by
dependency inversion: the module declares a `LessonEngagementRecorder` interface
that the `progress` module happens to satisfy, and `app.ts` joins them. The
interface has no parameter through which submitting an assessment could mark a
lesson COMPLETE.

The invariants live in the database:

- **The answer key is a separate table** with a policy that has no learner
  branch. Not a column, because row-level security cannot say "read this row but
  not that column". A composite foreign key means a key row can only ever name
  an option of its own question.
- **The score is computed by a trigger**, from `app_score_attempt` — a SECURITY
  DEFINER function granted to no role. The application sets `status` and nothing
  else, so a forged score is overwritten rather than rejected.
- **A submitted attempt is frozen**, and there is no DELETE grant anywhere in
  the domain.
- **Questions, options and keys are writable only while the activity is a
  draft**, so the paper a learner sat is permanently the paper their mark was
  computed against.
- **Publication validates the whole question set**, once, which is the only
  moment that means anything given the immutability above.

Visibility is composed one level at a time through INVOKER SQL functions —
activity asks `lessons_select`, assessment asks the activity, question asks the
assessment — so there is exactly one definition of lesson visibility in the
system and everything downstream inherits it.

### `progress` — **[BUILT]**

Owns `lesson_progress`: one row per (learner, lesson), recording that a learner
started or completed a lesson. The platform's first table of **per-child
behavioural data**, and the first whose read rule and write rule differ.

It is downstream of everything: it needs `class-courses` to decide whether a
learner may still write, `relationships` to decide which teacher or guardian may
read, and `curriculum` to label a row. It is a module of its own so that none of
those three has to know it exists — the dependency points one way only, and the
architecture rules assert it.

**It reads no other domain's tables directly.** That is a stronger statement here
than elsewhere and it is deliberate: a query in this module that joined `lessons`
for a title would return nothing once the learner lost access, silently erasing
their retained history. Lesson, unit and course titles come from the SECURITY
DEFINER helper `app_lesson_label`, and the write gate comes from
`app_actor_may_study_lesson` — both owned by the database, both the acyclic-graph
technique used since Task 004.

The invariants live in the database:

- **One row per learner and lesson**, a total unique index; the write path is an
  upsert on it, not a read-then-write.
- **Forward only.** `not_started → in_progress → completed` by rank, in a
  trigger. `completed_at` is written once and immutable; a row's learner and
  lesson can never be re-pointed.
- **`status = 'completed'` if and only if `completed_at IS NOT NULL`**, a CHECK,
  so the two can never disagree.
- **No DELETE policy and no DELETE privilege.** Retention is enforced by the
  absence of the grant, not by nobody calling it.

### `class-courses` — **[BUILT]**

Owns `class_course_assignments`: the edge from the class graph to the content
tree, and therefore the answer to "which learners does this lesson reach?".

It is a module of its own rather than part of either neighbour, because it
belongs to neither: `relationships` owns classes and would have to reach into
`courses` to validate an assignment, and `curriculum` owns courses and would
have to reach into `classes`. A separate owner for the edge keeps both of them
free of the other's tables.

The invariants live in the database. A course may only be assigned to a class in
its own organization or from the global catalog; only a **published** course may
be assigned; the parties are immutable; and at most one assignment per (class,
course) may be active at a time — a **deferrable partial exclusion constraint**,
the only form PostgreSQL offers that is both partial and deferrable.

`relationships` consumes it: `coursesViaClasses` in the relationship snapshot is
the union of the learner and teacher routes into a course, computed in one query
so no caller can check three of the four statuses and forget the fourth.

### `curriculum` — **[BUILT]**

Owns `education_levels`, `curricula`, `courses`, `course_units`, `lessons`.

The platform's first **publishable** domain: its rows are shown to children, so
the questions it answers are "who may see this?" and "who decided they should?".
Three invariants are enforced in the database rather than only in code:

- **Ownership is immutable.** `organization_id IS NULL` is the global catalog and
  a non-null value is one school; a trigger refuses any move between them, since
  every unit and lesson underneath would silently change tenant.
- **The lifecycle is one-way** (`draft → published → archived`), and the trigger
  that enforces it also enforces the author/publisher split by comparing which
  columns changed — something a row-level policy cannot see.
- **Ordering is a deferrable unique constraint** per parent, so a whole sequence
  can be rewritten in one transaction while a partial ordering can never commit.

It reads no other domain's tables. It stores `organization_id` on `curricula` and
`courses` — denormalized from the session at write time, for the same reason as
`notes.organization_id`, and pinned immutable so it cannot go stale.

### `notebook` — **[BUILT]**

Owns `notes`. The worked example of the protected-resource pattern:
`owner_id` + `organization_id` + `visibility` + `state`. Future owned resources
(projects, submissions, portfolios, files) follow the same shape.

Consumes a `RelationshipSnapshot`. It never queries `guardian_relationships` or
`teacher_assignments`.

### `platform` — **[BUILT]**, not a domain

Infrastructure: config, database access, HTTP wiring, error handling, audit,
password hashing, token generation. Owns `audit_log` (append-only).

### `knowledge` — **[BUILT]** (Task 011)

Owns `curriculum_embeddings`. A **derived** store: it holds nothing that is not
already in `lessons`, and dropping it loses no fact.

It READS the curriculum tables — `lessons`, `course_units`, `courses`,
`learning_objectives` — which is a cross-domain read and needs saying out loud
under rule 2 below. The justification is that this module's entire job is to be
a projection of that domain's published content: it is not asking the curriculum
a question it could ask through a contract, it is maintaining a searchable copy
of it, and the mandatory join to the live rows on every retrieval is what keeps
the copy honest. An arm's-length contract call per lesson would turn one
statement into hundreds and would not make the coupling smaller.

It reads `class_memberships` and `class_course_assignments` to compute the
retrieval scope, and nothing else. In particular it reads **no student-owned
table**: `notes`, `student_notebooks` and `student_artifacts` appear in no query
in the module, `curriculum_embeddings` has no column that could point at one,
and `tests/architecture/knowledge-boundaries.test.ts` enforces both with an
allow-list — so a private table added by a future task is covered on the day it
is created.

It writes to no other domain's tables at all.

### `tutor` — **[BUILT]** (Task 012)

Owns `ai_conversations` and `ai_messages`. The only domain on this platform
whose READ set is deliberately wider than its WRITE set: a teacher who teaches
the learner, an organization administrator and a safety moderator may read a
transcript, and nobody but the learner may write to it. Nobody at all may edit
one after the fact.

It COMPOSES rather than duplicates, which is most of what is worth knowing about
it. Retrieval is `knowledge`'s vector search with `assistant`'s live full-text
search as a floor; the provider boundary is `platform/ai`; the policy engine and
the class-course graph are the platform's. What this module actually owns is the
conversation and the guardrails around one turn.

It reads `lessons` and `course_units` for a lesson title, and that read is
LEFT-joined on purpose: `lessons` is RLS-narrowed to the classes an actor is in,
so an inner join would silently give a display lookup a veto over the moderation
policy. It reads NO student-owned table and no answer key —
`tests/architecture/tutor-boundaries.test.ts` enforces the list.

It writes to no other domain's tables.

### `portfolio` — **[BUILT]** (Task 013)

Owns `student_projects`, `project_artifacts`, `student_portfolios` and
`portfolio_items`. **The only domain with an unauthenticated read path**, which
is the fact that shapes everything else about it.

Its boundary is unusual in one respect worth stating plainly: the public path is
not decided by the policy engine at all. A stranger has no actor, so there is no
`AuthorizationContext` to evaluate, and a public branch in `portfolioPolicy`
would be a second place deciding publication with no way to be exercised by the
gate that normally decides. The public boundary is instead held by two things
that CAN run without an actor — the RLS policies keyed on a transaction-local
GUC, and `public-view.ts`, a pure constructor that builds the response out of
named pieces and therefore cannot leak a column nobody has thought about yet.

It reads `users` — no longer. The public resolver joined `users` for a display
name and, on a path with no actor, that inner join to an RLS-protected table
matched nothing and killed every public page (VULN-055). Both the join and the
field were removed: an account display name is registration data a child gave
their school, and this page is served to anybody with a link.

It reads `class_memberships`, `classes` and `teacher_assignments` only through
the platform's own SQL helpers — `app_actor_shares_project_class` and
`app_actor_reviews_project` — which are the same functions the RLS policies
call, so the policy engine and the database answer from one definition rather
than from two implementations of one idea.

It writes to no other domain's tables.

`tests/architecture/portfolio-boundaries.test.ts` enforces the shape of the
sanitizer (no spread, no `delete`, no field whose name looks like an
identifier), that the public resolver never runs `withActor`, and that the
public queries carry their own key check as well as relying on RLS.

### `community` — **[BUILT]** (Task 014)

Owns `discussion_threads`, `discussion_replies` and `content_flags`. **The only
domain where one user's writing is served to another user**, which is the fact
that shapes everything about it — every other domain decides what a person
discloses, and this one also decides what a child is exposed to.

Its boundary is a CLASS, not an organization, and it is one boundary rather than
a hierarchy of widening ones. `app_actor_in_class_forum(class_id)` resolves to a
single fact — a member or teacher of this active class — and there is no
organization-wide read anywhere in the domain, no cross-class visibility, and no
public path at all. An administrator's reach stops at their own school's
classes; a teacher moderates the classes they actually teach.

It reads `class_memberships`, `classes` and `teacher_assignments` only through
SQL helpers the RLS policies also call — `app_actor_in_class_forum`,
`app_actor_moderates_class`, `app_actor_owns_thread`, `app_class_organization` —
so the policy engine and the database answer from one definition.

**It does not read `users`.** A post's author name comes from
`app_forum_display_name(user_id, class_id)`, a `SECURITY DEFINER` function
bounded twice: the caller must be in the room and so must the person being
named. This is the third domain to meet the same lesson — VULN-054 was a join to
`lessons`, VULN-055 a join to `users` — and the rule is now enforced rather than
remembered: `tests/architecture/community-boundaries.test.ts` fails on `JOIN
users` anywhere in the module.

It imports `checkMarkdown` from `platform/security/markdown-safety.ts`. That
file was written for Task 010 and lived under `modules/notebook/` until this
task needed it; importing it from there would have violated dependency rule 3,
so **it moved to `platform/`** rather than being copied or reached across for.
It was always a platform primitive and the notebook module was only its first
caller.

It writes to no other domain's tables. `content_flags` rows disappear only with
the thread they concern, through the foreign key, or with the reply, through
`content_flag_reply_cleanup` — a `SECURITY DEFINER` trigger, because as
invoker-rights it made a reported reply permanently undeletable (VULN-057).

The reply tree is held by a **composite foreign key** rather than a check:
`(parent_reply_id, thread_id)` references `(id, thread_id)`, so a reply whose
parent lives in another class's thread is refused by the schema. Every policy on
the platform would admit that row.

`tests/architecture/community-boundaries.test.ts` also enforces that the content
filter is pure and imports nothing, that every content-bearing write is screened
and re-screened on edit, that `createFlag` carries no `RETURNING` clause
(VULN-058), and that an author's edit statement names exactly the columns an
author owns.

## Planned domains — **[DESIGNED]**, boundaries only

`learning-paths` · `activities` ·
`assessments` · `mastery` · `experiments` · `files` ·
`ai-gateway` · `ai-assistant` ·
`recommendations` · `notifications` · `analytics` ·
`administration`.

None exist. They are listed so their boundaries are considered before code is
written, not after.

## Data ownership rules

1. **One writer per table** — the owning module.
2. **No cross-domain joins.** Do not join into another domain's tables. Ask the
   owner via its contract.
3. **Denormalization requires justification.** Exactly one instance exists:
   `notes.organization_id`, copied from the owner at write time so the RLS policy
   can evaluate the organization check without joining `users` — which is itself
   RLS-protected and would make the policy recursive. The comment in the
   migration says so.
   - **[OPEN]** No flow keeps this correct across an organization transfer,
     because no transfer flow exists. When one is built it must update existing
     notes in the same transaction, or the column must become a lookup.
   - **[OPEN]** A second instance arrived with Task 004: the roster queries in
     `relationships` join `users` for `display_name`, so a roster row can be
     rendered without a second round trip. The join is read-only, limited to
     that one column, and runs under the caller's own RLS — a name the caller
     could not otherwise see is not returned. It is still a reach into another
     domain's table, and the standing rule is that it does not grow: any further
     field belongs behind a `users` contract, and the roster should move to one
     if a second column is ever needed.
4. **Foreign keys may cross domains.** A schema-level reference to `users(id)` is
   fine; a _query_ into another domain's tables is not. Referential integrity is
   the database's job.
5. **Events, not reach-ins.** When a domain needs to react to another's change,
   it subscribes to an event. Never place a security control or a data-integrity
   invariant in an event handler — those belong in the publishing transaction
   (see `packages/kernel/src/events.ts`).

## Extraction readiness

A domain can be extracted into its own service when its tables are touched only
by it, its contract is explicit, it has no imports from sibling modules, and its
tests do not depend on another domain's internals. `notebook`, `curriculum`,
`class-courses`, `progress`, `assessment` and `organizations` meet this cleanly today; `relationships` meets it except for the
`display_name` join noted above, and `identity`/`users` share the `users` table.
Both exceptions are recorded rather than papered over — enforced by `tests/architecture/dependency-rules.test.ts`, not by
inspection.

**No domain should be extracted until scale, reliability, or team structure
demands it.** The point of the boundary is that the option stays open, not that
it should be exercised.

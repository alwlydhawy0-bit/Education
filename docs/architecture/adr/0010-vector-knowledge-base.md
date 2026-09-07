# ADR 0010 — A derived vector index, and the conditions for building one

**Status:** Accepted (Task 011)
**Amends:** the "WHY THERE IS NO `content_chunks` TABLE" reasoning in migration
`0023_content_retrieval_index.sql` — which is **still correct** and is not
superseded; see below.
**Related:** [0002 RLS defence in depth](0002-postgres-rls-defense-in-depth.md),
[0004 AI gateway](0004-ai-gateway.md),
[0009 content lifecycle](0009-content-lifecycle-and-duty-split.md)

## Context

Migration 0023 argued, at length and in the file itself, that this platform
should **not** copy lesson text into a chunk table. It gave three reasons, and
Task 011 was asked to build exactly the thing those reasons argued against.

That is the interesting part of this decision, so it is worth being precise
about it. The reasons were not obsolete, and "a later task said to" is not an
argument. Migration 0026 exists because each of the three has a **mechanism**
answering it — and if any one of them had lacked an answer, the right outcome
would have been to say so rather than to build the table.

This ADR records both the answers and, more importantly, the shape of the
answers, because the next person to overrule a written-down objection should
have to clear the same bar.

Migrations are checksummed, so 0023 cannot be edited to point here. This
document is the amendment; the two are read together.

## Decision — build the index, with each objection answered by a mechanism

### 1. "Duplicated truth" → the copy cannot outlive its original

Every chunk stores `source_updated_at`, and **every read compares it for
equality** against the live `lessons.updated_at`. A chunk whose lesson has been
edited is not stale: it is invisible. The duplicate can only ever answer for a
version of the lesson that still exists in the lesson.

This is weaker than "there is no copy" and stronger than "we refresh the copy".
It converts a consistency problem into a visibility one, and visibility this
platform already knows how to reason about.

### 2. "Staleness is a security bug" → the join to the live row is mandatory

Every retrieval joins `lessons`, `course_units` and `courses` and requires all
three published. An archived lesson's chunks stop being served the instant its
status changes.

The objection was that a copy "requires an invalidation path that runs on every
lifecycle move, and the day it misses one the assistant serves retired
material". There is still **no invalidation path**, because there is still
nothing to invalidate: the rows may sit there indefinitely and remain unservable
until a re-index clears them.

### 3. "A second authorization surface" → delegation, not mirroring

`curriculum_embeddings_select` calls `app_actor_sees_lesson(lesson_id)` — the
same helper the curriculum itself uses. There is one set of rules, not two that
resemble each other.

The objection was specifically about a mirror that can be **wrong separately**.
A delegation cannot: if the enrolment rules change, both surfaces change with
them, because there is only one surface.

## What actually changed in the world

`pgvector` was genuinely unavailable when 0023 was written — that migration
recorded the check rather than asserting it. It is now installed, in an
`extensions` schema created by `db/bootstrap.sql` as a superuser, so that
`db:migrate --reset` dropping `public` does not take the extension with it.
`edu_migrator` cannot `CREATE EXTENSION`, and giving it that power to avoid a
bootstrap step would have been a much larger decision than the one it solved.

## What did NOT change, and why this ADR is short

0023 ended its embeddings section with:

> THE SECURITY PROPERTY IS INDEPENDENT OF THE RANKING FUNCTION. Authorization
> constrains WHICH ROWS are searched; similarity only orders them. Swapping FTS
> for vector similarity later changes the ORDER BY, not the WHERE.

That held. Migration 0026 and the knowledge module changed the `ORDER BY` and
left the `WHERE` alone. An interface shaped around *a permitted scope* rather
than *a search algorithm* absorbed a change of search algorithm without a
security review of its own — which is the return on having shaped it that way,
collected two tasks later.

## Consequences

**0023's index is not superseded.** It still serves the assistant's keyword
retrieval, it requires no indexing step, and it is what remains if an embedding
provider is unavailable. The two coexist deliberately: one is always current and
never needs building, the other is better at meaning and must be maintained.

**The index is a derived store, and the schema says so.** No `UPDATE` grant and
no `UPDATE` policy. Chunks are replaced wholesale by a re-index; a row whose
text could be edited in place could drift from the lesson it claims to quote
while still declaring itself fresh.

**Indexing is a publish-level authority**, not an authoring one. A chunk is text
the assistant may quote to a child, so deciding what is in the index is the same
kind of decision as deciding what is published — which ADR 0009 already
separated from the authority to write it.

**The pre-filter is now a load-bearing architectural rule**, enforced by a
fitness function rather than only by a behavioural test. Ranking before
filtering returns the same rows, so no assertion about a result can detect it;
`tests/architecture/knowledge-boundaries.test.ts` asserts on the SQL text
instead.

**A precision hazard is now a typed one.** The freshness equality failed
silently and totally because a `timestamptz` was round-tripped through a
JavaScript `Date` (VULN-048). `LessonSource.updatedAt` is `string` so that
reintroducing the parse is a compile error.

## The general rule this establishes

**A recorded objection may be overruled only by a mechanism, never by a
deadline.** If a design note says "we did not do X because A, B and C", the task
that does X owes the next reader an answer to each of A, B and C — in the code,
where it can be tested, and in a document like this one, where it can be
challenged.

# Curriculum Knowledge Base & RAG Retrieval

Task 011. The indexing pipeline behind grounded assistance: published
curriculum content is chunked, embedded, stored in pgvector, and retrieved by
similarity — **inside the same access boundary as the content itself**.

This is a derived store. It holds nothing that is not already in `lessons`, it
decides nothing, and it can be dropped and rebuilt from the curriculum at any
time without losing a fact. Everything below follows from that: it is why there
is no `UPDATE` path, why every read joins the live lesson, and why the retrieval
query asks `app_actor_sees_lesson` rather than restating who may see what.

## The one-paragraph version

`POST /curriculum/courses/:id/index` reads a course's **published** lessons,
cuts them into chunks, embeds each one, and replaces that course's rows in
`curriculum_embeddings`. `POST /rag/retrieve` takes a question, works out which
courses the caller may study, and searches **only within those courses** —
narrowing before ranking, never after. A learner outside every class gets an
empty result and a scope count of zero, not an error and not somebody else's
curriculum.

## Endpoints

| Method | Path                            | Who                                 |
| ------ | ------------------------------- | ----------------------------------- |
| `POST` | `/curriculum/courses/:id/index` | publish standing in the same school |
| `POST` | `/rag/retrieve`                 | any authenticated actor             |

### `POST /curriculum/courses/:id/index`

Rebuilds one course's entry. The request body is **empty and `.strict()`** — not
absent. A route that never reads `request.body` would ignore
`{"organizationId": "<another school>"}` silently, and silently ignoring a
forged field looks identical, in every test and every log, to trusting it
(VULN-028).

```json
{
  "courseId": "…",
  "lessonsIndexed": 12,
  "chunksWritten": 96,
  "chunksRemoved": 91,
  "embeddingModel": "deterministic-hash-v1",
  "lessonsSkipped": 3
}
```

`lessonsSkipped` is **a count, never a list of ids**. An author knows their own
drafts, and a number explains a smaller-than-expected index without enumerating
unpublished work into a response body.

**Indexing takes publish standing, not author standing.** Writing content and
deciding what a child may be told are different authorities, and this is the
second one: a chunk in this table is text the assistant may quote to a learner.
A `content_author` who may freely edit the very same lesson is refused here, and
`tests/security/rag.test.ts` holds that case under its own name.

**Only published lessons are read**, and the predicate lives in the SQL rather
than in a filter afterwards, because the safest place for it is the one where
forgetting it is impossible. Draft wording never enters the store — not merely
never leaves it in a response. The difference matters: unpublished text resting
in a table is visible in a backup, in a database console, and to whatever query
path a future task adds over it.

**Re-indexing replaces; it never appends.** The course's rows for that model are
deleted in the same transaction as the insert. Appending would make the index a
growing record of everything a course has ever said, including the paragraph an
author removed _because it was wrong_ — which is exactly the paragraph you would
least like quoted back to a child a year later.

### `POST /rag/retrieve`

```json
{ "query": "why do cells need mitochondria", "topK": 5, "courseId": "…?" }
```

`courseId` and `lessonId` are optional **narrowing** filters. Sending one you
cannot reach is not an error — it narrows to nothing. Distinguishing "not yours"
from "does not exist" would make this endpoint an oracle for other schools'
catalogs, one 403 at a time.

The response always carries `coursesInScope`: how many courses the caller may
actually study right now. A learner between enrolments sees
`{"chunks": [], "coursesInScope": 0}` with status 200.

**There is no field for a vector.** A caller supplying its own embedding would
be choosing its neighbourhood in the index rather than describing a question,
and "nearest to this arbitrary point" is a very different power from "relevant
to what I asked". The query is embedded server-side.

## The pre-filter, and why it is the whole design

Retrieval runs in three steps, and the ORDER is the security property:

1. **Compute the reachable courses** from the live enrolment graph —
   `class_memberships` → `class_course_assignments` → `courses`, each required
   to be active or published. Nothing the client sent participates.
2. **Intersect** any client filter with that set.
3. **Only then search**, with `WHERE e.course_id = ANY($1)` _before_
   `ORDER BY e.embedding <=> $2`.

A version that ranked first and filtered afterwards would return the same rows.
That is precisely why no test of the RESULT can tell the two apart, and why
`tests/architecture/knowledge-boundaries.test.ts` asserts on the SQL text: the
course filter must appear before the `ORDER BY`. It is the one rule in this
feature that only a structural test can hold.

It matters because an unbounded search reads every tenant's vectors into memory
in order to decide it was not allowed to. That is a cost, a timing signal, and a
row set one careless log line away from being written down.

## Freshness and lifecycle, without an invalidation path

Every retrieval joins the live `lessons`, `course_units` and `courses` rows and
requires all three published. Nothing has to remember to delete a chunk when a
lesson is archived — the join stops serving it the moment the status changes.

Alongside that, `e.source_updated_at = l.updated_at` withdraws the chunks of a
lesson that has been EDITED since it was indexed. A stale chunk is not a
performance problem here; it is a correctness one, because the thing it would
serve is text an author deliberately replaced.

**That timestamp travels as PostgreSQL's own text and is never parsed.** This is
worth stating in the documentation because it cost a total outage of the feature
to learn: `timestamptz` keeps microseconds, a JavaScript `Date` does not, and
reading the column into a `Date` and writing it back stores a truncated copy.
The equality was then false for every chunk in the table, and retrieval returned
an empty result to every learner with no error anywhere. An equality is only as
good as the fidelity of the carrier between the two reads.

## What is NOT in this index

**No student workspace content.** Notes, notebooks and artifacts from Task 010
are absent from the ingestion path by name, `curriculum_embeddings` has no
column that could point at one, and a fitness function checks both — using an
allow-list of readable tables, so a private table added by some future task is
covered the day it is created rather than the day somebody remembers it.

A knowledge base that contained one child's private writing would answer another
child's question with it. That is the failure mode, stated plainly, and it is
why the exclusion is enforced in three places rather than assumed in one.

**No answer keys, no attempts, no assessment content.** Same allow-list.

## Authorization, in both layers

| Layer                 | Mechanism                                                                        |
| --------------------- | -------------------------------------------------------------------------------- |
| Policy engine         | `contentPolicy`, verb `index` — publish permission, own school, published course |
| RLS `SELECT`          | `app_actor_sees_lesson(lesson_id)` — the same helper the curriculum itself uses  |
| RLS `INSERT`/`DELETE` | author-or-publisher standing, `app_actor_sees_lesson`, and an organization match |
| RLS `UPDATE`          | **none, and no grant either**                                                    |

The SELECT policy **delegates** rather than mirrors. Restating the enrolment
rules on this table would create a second authorization surface that could drift
from the first — and the drift would be invisible, because both would keep
returning rows.

There is no `UPDATE` because chunks are replaced wholesale. An update path would
let a row's text drift from the lesson it claims to quote while its
`source_updated_at` still said it was fresh.

## Rate limits

| Policy              | Budget       |
| ------------------- | ------------ |
| `knowledgeIndex`    | 20 / hour    |
| `knowledgeRetrieve` | 300 / 15 min |

Indexing is expensive and rare; retrieval is cheap and constant. The retrieval
budget is generous enough for a conversation and tight enough that enumerating a
catalog through similarity queries is slow.

## Audit trail

`KNOWLEDGE_INDEX_REBUILT` records counts and the model. `AUTHZ_DENIED` records a
refused index attempt. `KNOWLEDGE_RETRIEVAL_EMPTY_SCOPE` records a retrieval
that found nothing to search.

**No event carries a query string or a chunk.** A learner's question is a record
of what they did not understand, which is close enough to private that an audit
trail — read by more people than the lesson is — must not hold it. An ordinary
successful retrieval is not logged at all; only ids, counts and denials are.

## The embedding provider

`createDeterministicEmbeddingProvider()` is a hashed bag-of-tokens: 768
dimensions, L2-normalized, two signed buckets per token. It is **deterministic
and reproducible, and it is not semantic** — it matches shared vocabulary, not
shared meaning. It exists so the pipeline, the storage, the isolation and the
retrieval path can be built and tested end to end without a network call or a
key, and so that a test asserting "this chunk came back" is asserting about the
pipeline rather than about a vendor's model.

Swapping in a real embedding model is a change of one implementation behind
`EmbeddingProvider`. `embedding_model` is part of the chunk's unique key, so two
models can coexist in the table during a migration and a retrieval never mixes
them.

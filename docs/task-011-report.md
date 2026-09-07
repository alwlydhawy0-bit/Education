# Task 011 — Curriculum knowledge base and vector RAG pipeline

**Status: COMPLETE for the pipeline. There is no AI tutor, no answer generation
and no user interface, and none was built.** That boundary is stated first
because the task's own constraints require it: this is the index and the
retrieval endpoint, deliberately stopping short of the thing they exist for.

Vocabulary: **VERIFIED** — measured here. **PARTIALLY VERIFIED** — measured in
one layer only. **UNVERIFIED** — not measured. **OPEN RISK** — known and
accepted.

---

## 1. IMPLEMENTED

| Layer         | File                                                        |
| ------------- | ----------------------------------------------------------- |
| Extension     | `db/bootstrap.sql` — pgvector in an `extensions` schema      |
| Schema        | `db/migrations/0026_curriculum_embeddings.sql` (293 lines)   |
| Chunking      | `apps/api/src/modules/knowledge/chunking.ts`                 |
| Embeddings    | `apps/api/src/platform/ai/embeddings.ts`                     |
| Authorization | `packages/authz/src/policies/content.policy.ts` — verb `index` |
| Contract      | `packages/contracts/src/knowledge.contract.ts`               |
| API           | `apps/api/src/modules/knowledge/` — repository, service, routes |
| Docs          | `docs/api/knowledge-base.md`, `docs/architecture/adr/0010-vector-knowledge-base.md` |

One table, one new action, two routes:

- `POST /api/v1/curriculum/courses/:id/index` — rebuild a course's entry.
- `POST /api/v1/rag/retrieve` — scope-guarded similarity search.

`curriculum_embeddings` holds `embedding extensions.vector(768)` with an HNSW
index over cosine distance, `source_updated_at` for freshness, and a unique key
of `(lesson_id, embedding_model, chunk_index)` so two models can coexist during
a migration without a retrieval ever mixing them.

**pgvector was installed as part of this task.** Migration 0023 had recorded it
as unavailable — a check, not an assumption. It now lives in an `extensions`
schema created by the superuser bootstrap, because `edu_migrator` cannot
`CREATE EXTENSION` and `db:migrate --reset` drops `public`. Granting the
migrator that power to avoid a bootstrap step would have been a far larger
decision than the one it solved.

### The three decisions that shaped everything

1. **The scope is computed before the search, never after.** `coursesInScope`
   reads the live enrolment graph, the client's filter is INTERSECTED with it,
   and the result becomes `WHERE course_id = ANY($1)` ahead of the `ORDER BY`.
2. **Every retrieval joins the live lesson.** Not for the text — the chunk has
   that — but for the lifecycle and the freshness. This is what makes an
   archived lesson need no invalidation path.
3. **Visibility is delegated, not mirrored.** The SELECT policy calls
   `app_actor_sees_lesson`, the same helper the curriculum uses. One set of
   rules, not two that resemble each other.

---

## 2. VERIFIED

| Requirement                                                   | Status   | Evidence                                                                 |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Embeddings inherit the curriculum's RLS and access controls    | VERIFIED | `rls-embeddings.test.ts` (25); SELECT policy delegates to `app_actor_sees_lesson`; F1 |
| Never an unbounded vector search filtered post-hoc             | VERIFIED | Fitness rule on SQL text ordering; F1, F2 — and **F2 is caught by that rule alone** |
| Pre-filter through class boundaries FIRST                      | VERIFIED | `coursesInScope` joins memberships and assignments; 8 layered-defence cases with RLS off |
| Private notes and artifacts excluded from the index            | VERIFIED | Allow-list fitness rule over every `FROM`/`JOIN`; no pointer column on the table |
| Cross-tenant similarity returns zero, not a 403                | VERIFIED | `rag.test.ts` group B; identical query text across two schools           |
| Draft content never enters the store                           | VERIFIED | Published-only in SQL; direct table read as superuser; F7, F13           |
| Archived lessons stop being served with no re-index            | VERIFIED | Mandatory join; layered case with `updated_at` pinned; F5                |
| An edited lesson stops serving its old text                    | VERIFIED | `source_updated_at` equality; F4                                        |
| Indexing takes publish standing, not author standing           | VERIFIED | `contentPolicy` verb `index`; the author case has its own test; F6       |
| Re-index replaces, never appends                               | VERIFIED | Clear-then-insert in one transaction; F8                                |
| Revocation is immediate                                        | VERIFIED | Membership, assignment and course status, each isolated with RLS off; F9, F11, F12 |
| The audit trail never records the question                     | VERIFIED | `rag.test.ts` group G asserts no query string in any event               |
| Retrieval relevance / answer quality                           | **UNVERIFIED** | The provider is not semantic — see §9 (RISK-RAG-01)               |
| AI tutor, portfolios, community                                | **NOT BUILT** | Excluded by the task's own constraints                              |

---

## 3. SECURITY

**The pre-filter is the security property, and it is enforced structurally.**
A post-hoc filter returns the same rows as a pre-filter, so no assertion about a
RESULT can distinguish them. `tests/architecture/knowledge-boundaries.test.ts`
asserts on the SQL text: `course_id = ANY(` must appear before the `ORDER BY`.
Injected defect F2 — a ranked subquery filtered from outside, the exact forbidden
shape — is caught by **that one rule and nothing else in the entire suite**.

**The index holds no student-owned data, by allow-list rather than deny-list.**
Every `FROM` and `JOIN` in the knowledge repository is checked against a list of
permitted curriculum tables. A private table added by a future task is covered
on the day it is created, not on the day somebody remembers to add it to a list
of things to avoid.

**No UPDATE exists at any layer** — no grant, no policy, no route. A row whose
text could be edited in place could drift from the lesson it claims to quote
while still declaring itself fresh.

**The query is embedded server-side.** The contract has no field for a vector.
"Nearest to this arbitrary point" is a materially different power from "relevant
to what I asked", and only the second one is offered.

**Denials record ids, never text.** A learner's question is a record of what they
did not understand. The audit trail is read by more people than the lesson is.

---

## 4. IDOR / BOLA matrix

All exercised over real HTTP, in `tests/security/rag.test.ts` (28 cases,
groups A–G) unless noted.

| # | Attempt                                                        | Result | Where the refusal comes from |
| - | -------------------------------------------------------------- | ------ | ---------------------------- |
| 1 | School B learner queries text that only school A's chunks match | 200, empty | Pre-filter (app) + RLS |
| 2 | School A learner, symmetric case                               | 200, empty | Pre-filter (app) + RLS |
| 3 | Learner names another school's `courseId` explicitly           | 200, empty | Intersection — narrows, never widens |
| 4 | Learner names an unassigned course in their OWN school          | 200, empty | Not in the enrolment graph |
| 5 | Learner in no class at all                                     | 200, empty, `coursesInScope: 0` | Empty scope short-circuits |
| 6 | Learner queries a draft lesson's distinctive text               | 200, empty | Never indexed; also never served |
| 7 | Direct table read: is draft text present at all?                | absent | Ingestion filter (data-at-rest) |
| 8 | Learner after leaving the class                                | 200, empty | `cm.status` (app) — isolated with RLS off |
| 9 | Learner after the course is withdrawn from the class            | 200, empty | `a.status` (app) — isolated with RLS off |
| 10 | Learner after the course is archived                          | 200, empty, scope 0 | `co.status` (app) — isolated with RLS off |
| 11 | Learner after the lesson is archived                          | 200, empty | Mandatory join — isolated with `updated_at` pinned |
| 12 | Retrieval after the lesson is EDITED                          | 200, empty | Freshness equality |
| 13 | Learner attempts to index                                     | 404 | Write verb, non-editor: hidden |
| 14 | Content author attempts to index                              | 403 | Separation of duties; reveal |
| 15 | Reviewer indexes another school's course                      | 404 | Not an editor there |
| 16 | Reviewer indexes a draft course                               | 403 | State axis; reveal |
| 17 | Forged body `{organizationId: <other school>}`                | 400 | `.strict()` empty schema |
| 18 | Non-existent course id                                        | 404 | Indistinguishable from hidden |
| 19 | Anonymous caller, both routes                                 | 401 | Confirmed on a live boot |

**Cases 1–5 and 8–11 were re-run against `edu_app_norls` (BYPASSRLS)** in
`layered-defense.test.ts`, with a case first proving both schools' vectors are
visible to the raw connection — so the isolation demonstrated there is the
application's, not the database's.

**On 13 versus 14.** A learner gets 404 and an author gets 403, and the
difference is deliberate. Indexing is a write verb, and `contentPolicy` hides
every write from an actor without editorial standing — the same answer a learner
gets for create, update and publish. What is concealed is not the course (the
learner is studying it) but the existence of the operation. The author, who has
standing, is told plainly that they lack the specific authority.

---

## 5. ARCHITECTURE

The knowledge module owns `curriculum_embeddings` and writes to no other
domain's tables. It reads the curriculum tables, which is a cross-domain read
and is justified explicitly in `domain-boundaries.md`: this module's entire job
is to be a projection of that domain's published content, and the mandatory join
to the live rows is what keeps the projection honest.

**ADR 0010 records the amendment to migration 0023.** That migration argued in
its own text that this platform should not build a chunk table, and gave three
reasons. Each is answered by a mechanism — bounded duplication via the freshness
equality, no invalidation path via the mandatory join, no second authorization
surface via delegation. Migrations are SHA-256 checksummed, so 0023 cannot be
edited to point at the ADR; the two are read together.

**0023's index is not superseded.** Full-text retrieval still serves the
assistant, needs no indexing step, and is what remains if an embedding provider
is unavailable. The two coexist deliberately.

**What 0023 got right, collected two tasks later:** "the security property is
independent of the ranking function". Task 011 changed the `ORDER BY` and left
the `WHERE` alone. An interface shaped around a permitted scope rather than a
search algorithm absorbed a change of search algorithm with no security review
of its own.

---

## 6. FILES CHANGED

**Added**

- `db/migrations/0026_curriculum_embeddings.sql`
- `apps/api/src/modules/knowledge/{chunking,knowledge.repository,knowledge.service,knowledge.routes}.ts`
- `apps/api/src/platform/ai/embeddings.ts`
- `packages/contracts/src/knowledge.contract.ts`
- `tests/unit/knowledge-chunking.test.ts` (30)
- `tests/integration/rls-embeddings.test.ts` (25)
- `tests/security/rag.test.ts` (28)
- `tests/architecture/knowledge-boundaries.test.ts` (18)
- `docs/api/knowledge-base.md`, `docs/architecture/adr/0010-vector-knowledge-base.md`

**Modified**

- `db/bootstrap.sql` — pgvector in an `extensions` schema, surviving `--reset`
- `packages/authz/src/{types.ts,policies/content.policy.ts}` — the `index` verb
- `packages/observability/src/security-events.ts` — two event types
- `apps/api/src/platform/security/rate-limit.ts` — two policies
- `tests/setup/fixtures.ts` — embedding fixtures; `truncateAll`
- `tests/security/layered-defense.test.ts` — +11 cases (66 → 77)
- `docs/security/{limitations,vulnerability-log}.md`, `docs/architecture/domain-boundaries.md`

---

## 7. TEST RESULTS

Full serial gate, all six projects, from a clean tree:

| Project      | Files | Tests |
| ------------ | ----- | ----- |
| unit         | 23    | 913   |
| architecture | 8     | 206   |
| web          | 3     | 53    |
| integration  | 15    | 491   |
| security     | 24    | 829   |
| evaluation   | 2     | 38    |
| **total**    | **75** | **2,530** |

Typecheck and lint clean across all seven workspace projects.

### Defect injection — round 10

Thirteen defects, each applied to the working tree, run against the suites that
should notice, then reverted with `git checkout --`. **All thirteen caught.**

| #   | Defect                                                    | Caught by |
| --- | --------------------------------------------------------- | --------- |
| F1  | Course pre-filter removed — unbounded search               | 17 tests across three suites |
| F2  | Ranked subquery filtered from outside — the real post-hoc shape | **the fitness rule alone** |
| F3  | Client `courseId` trusted instead of intersected           | the named cross-tenant case |
| F4  | Freshness equality removed                                 | 3, incl. the fitness rule |
| F5  | Lesson lifecycle check removed                             | 2 (fitness + `updated_at` pinned) |
| F6  | Content author allowed to index                            | the separation-of-duties case |
| F7  | Unpublished lessons indexed                                | 3, incl. the data-at-rest read |
| F8  | Re-index appends instead of replacing                      | 2 |
| F9  | Membership status ignored in the scope                     | the RLS-off membership case |
| F10 | `UPDATE` granted on the embeddings table                   | the grant fitness rule |
| F11 | Assignment status ignored in the scope                     | the RLS-off withdrawal case |
| F12 | Course published-status ignored in the scope               | the scope-count case |
| F13 | Every lesson indexed regardless of status                  | 3 |

**Four of these escaped on the first pass** (F2, F5, F9, F12) and produced
VULN-049 plus five new permanent tests. The escapes were the useful part of the
round; the catches were the confirmation.

---

## 8. NOT IMPLEMENTED

Excluded by the task's own constraints, and deliberately not started:

- **The AI conversational tutor.** No answer generation, no conversation
  persistence, no citation rendering, no UI.
- **Portfolios and community features.**
- **Any frontend at all** for indexing or retrieval.

Not excluded, but not built, and worth naming as gaps rather than omissions:

- **Automatic re-indexing** on publish or edit. Retrieval fails closed
  meanwhile, but silently.
- **A real embedding model.** The provider is a hashed bag-of-tokens.
- **Chunk-level evaluation.** No recall measurement, no relevance harness.
- **Index size bounds.** No quota, no eviction, no growth reporting.

---

## 9. KNOWN RISKS AND DEFECTS FOUND

### Defects found and fixed during this task

**VULN-048 — a freshness equality that was false for every row ever written.**
`node-pg` parses `timestamptz` into a JavaScript `Date`, which is
millisecond-resolution against the column's microsecond-resolution, so reading
the value out and writing it back stored `…613` where the row held `…613776`.
Retrieval returned an empty result to every learner, always, with no error
anywhere. It failed closed, which is why it is a functional defect and not a
disclosure — and why it could have shipped.

The interesting part is that it is the **second version of the same mistake**.
The original design hashed lesson text in SQL and compared it against a digest
computed in TypeScript; that was rejected mid-build on the reasoning that one
value cannot disagree with itself. One value can disagree with itself if it is
**reshaped in transit**. The timestamp now travels as PostgreSQL's own text and
`LessonSource.updatedAt` is typed `string`, so reintroducing the parse is a
compile error rather than a silent outage.

**A dead `source_hash` column reference** in the insert path, left by the same
mid-build change, made every index request a 500. Caught by the security suite
on its first run.

**VULN-049 — three more masked controls**, and a correction to VULN-046's rule.
That entry said redundant controls make each other unobservable and prescribed
running a suite with RLS off. Too narrow: two of the four controls found masked
here are both application-layer, hidden behind each other rather than behind the
database. **Any two controls that normally fire together mask each other**,
whatever layers they live in, and the remedy is to construct the state that
separates them — which for the lesson lifecycle clause meant archiving a lesson
with `updated_at` pinned, a state no ordinary code path produces.

### A process defect, recorded because it shipped a regression

`git add -A` run while an injection round had a defect applied **staged and
committed that defect** — `AND l.status = 'published'` was deleted from the
retrieval query in commit `1e577ab`. Because the driver reverts with
`git checkout --`, the contaminated commit became the new baseline, and every
defect measured after it was measured against a tree already missing a control.

Restored in `94cc858` to the exact pre-contamination blob, and the round re-run
from a verified-clean tree; the driver now refuses to start when the tree is
dirty. **What made it recoverable was the fitness function**: because it asserts
on SQL text, the missing clause surfaced as an anomaly in the injection output
rather than as a quietly-passing behavioural suite. RLS and the freshness
equality both mask that clause — which is exactly what VULN-049 is about.

### Open risks

| Id          | Risk |
| ----------- | ---- |
| RISK-RAG-01 | The embedding provider matches vocabulary, not meaning. Every test here is a test of the pipeline; none is evidence that retrieval returns relevant results. |
| RISK-RAG-02 | Re-indexing is manual. Retrieval fails closed on stale content, but with no alert and no staleness metric. |
| RISK-RAG-03 | Questions are deliberately not logged, so probing through `/rag/retrieve` leaves only ids and counts. Privacy chosen over forensics. |
| RISK-RAG-04 | `coursesInScope` is one bit more than the question requires; a caller can watch it change to infer roster edits. |
| RISK-RAG-05 | HNSW built with default parameters and no recall measurement. A missed neighbour is a worse answer, never a leak — but the recall is unknown. |

Carried forward from earlier tasks and still open: the API is not deployed; the
Vercel Root Directory is still `apps/api` and `apps/api/vercel.json` should be
removed once that is corrected; `@vercel/speed-insights` sends Web Vitals to a
third party from a children's platform, which is a privacy decision that
deserves to be made deliberately rather than inherited.

---

## 10. NEXT TASK

**Recommend ONE: automatic re-indexing on the content lifecycle.**

Not the tutor. The tutor is the obvious next step and it is the wrong one,
because it would be built on an index that nobody has established stays current.
Right now, publishing a lesson does nothing to the knowledge base, and editing
one makes its chunks silently vanish from retrieval. Both are safe — the failure
is closed — but "safe" here means the assistant would confidently know less than
the curriculum contains, and no signal anywhere would say so.

The work is small and well-bounded: re-index on the publish and archive
transitions, expose a staleness metric per course, and add the one alert that
says "this course's index is older than its content". It also forces a question
this task deferred — what happens when indexing a large course takes longer than
a request — which is much cheaper to answer now than after a tutor depends on
the answer.

The second candidate, and the one to do immediately after, is **a real embedding
model behind the existing `EmbeddingProvider` interface, with a relevance
evaluation harness**. RISK-RAG-01 is the largest unverified claim in this task,
and the abstraction was built specifically so that closing it is a
one-implementation change rather than a redesign. But it should be closed with a
measurement, and the measurement needs a harness that does not exist yet — which
is a task, not a footnote to this one.

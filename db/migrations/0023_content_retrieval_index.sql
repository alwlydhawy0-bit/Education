-- ============================================================================
-- 0023 — Full-text retrieval over live curriculum content (Task 013)
-- ============================================================================
--
-- WHAT THIS MIGRATION ADDS: two indexes. No table, no column, no policy, no
-- trigger, no function. That is the whole change, and the reasoning behind its
-- smallness is the most important thing in this file.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO `content_chunks` TABLE
-- ----------------------------------------------------------------------------
--
-- The obvious RAG design copies lesson text into a chunk table, embeds it, and
-- searches that. Every part of that is a liability here:
--
--   1. DUPLICATED TRUTH. A copy of a lesson's text is a second answer to "what
--      does this lesson say", and the two drift. Task 011 spent a whole task
--      establishing that a published objective's wording is what a learner's
--      mastery record MEANS; a stale copy in a retrieval table would quietly
--      un-establish it.
--
--   2. STALENESS IS A SECURITY BUG, not a freshness bug. When a lesson is
--      archived, the learner must stop being able to reach it — including
--      through the assistant. With a copy, that requires an invalidation path
--      that runs on every lifecycle move, and the day it misses one the
--      assistant serves retired material. With no copy, the row simply
--      disappears from the learner's view and there is nothing to invalidate.
--
--   3. A SECOND AUTHORIZATION SURFACE. A chunk table needs its own RLS,
--      mirroring `lessons_select` and `course_units_select` and the class
--      narrowing — a mirror that can be wrong. Reading the live rows means the
--      assistant is governed by the SAME policy as `GET /lessons/:id`, not by a
--      policy that resembles it.
--
-- So retrieval reads `lessons` and `learning_objectives` directly, as `edu_app`
-- with `app.actor_id` set to the authenticated learner. Chunking happens at
-- query time over a body the contract already caps at 64,000 characters.
--
-- ----------------------------------------------------------------------------
-- WHY FULL TEXT SEARCH AND NOT EMBEDDINGS
-- ----------------------------------------------------------------------------
--
-- `pgvector` is NOT AVAILABLE in this PostgreSQL installation — checked, not
-- assumed:
--
--   SELECT name FROM pg_available_extensions WHERE name = 'vector';  -- empty
--
-- The alternatives were a second database (which Task 013 forbids) or an
-- external vector service (which would put curriculum text outside the
-- authorization boundary this platform is built on). Neither is acceptable for
-- a foundation, so retrieval ranks by PostgreSQL full-text search, which the
-- installation already supports.
--
-- THE SECURITY PROPERTY IS INDEPENDENT OF THE RANKING FUNCTION. Authorization
-- constrains WHICH ROWS are searched; similarity only orders them. Swapping FTS
-- for vector similarity later changes the ORDER BY, not the WHERE — which is
-- exactly why the retrieval interface is shaped around a permitted scope rather
-- than around a search algorithm.
--
-- ----------------------------------------------------------------------------
-- WHY `simple` AND NOT `arabic`
-- ----------------------------------------------------------------------------
--
-- PostgreSQL ships an `arabic` snowball configuration, and it is the wrong
-- choice here for a reason worth stating: the corpus is MIXED. A Saudi
-- curriculum lesson routinely contains Arabic prose, English technical terms
-- and mathematical notation in the same paragraph, and a stemmer chosen for one
-- language mangles the others — `arabic` would stem English words by Arabic
-- rules, and `english` would do the reverse.
--
-- `simple` does no stemming and no stop-word removal: it lowercases and splits.
-- That loses Arabic morphological matching (a query for the definite form will
-- not match the indefinite one), which is a real and documented limitation —
-- see docs/security/limitations.md, RISK-AI-04. It is the honest trade for a
-- foundation: predictable behaviour in both languages beats good behaviour in
-- one and unpredictable behaviour in the other.
--
-- ----------------------------------------------------------------------------
-- IMMUTABILITY
-- ----------------------------------------------------------------------------
--
-- `to_tsvector(regconfig, text)` is IMMUTABLE only when the configuration is
-- passed explicitly. The one-argument `to_tsvector(text)` reads
-- `default_text_search_config`, which is a session setting, so it is STABLE and
-- PostgreSQL refuses it in an index. The explicit `'simple'::regconfig` below
-- is what makes these indexes legal, not a style preference.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Lessons
-- ----------------------------------------------------------------------------
--
-- Title, summary and body together. `coalesce` on every column because a NULL
-- anywhere in a concatenation makes the whole expression NULL, which would
-- silently drop the row from the index rather than indexing the parts that do
-- exist.
CREATE INDEX lessons_search_idx
    ON lessons
 USING GIN (
       to_tsvector(
         'simple'::regconfig,
         coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content_body, '')
       )
       );

-- ----------------------------------------------------------------------------
-- Learning objectives
-- ----------------------------------------------------------------------------
--
-- Indexed separately rather than folded into the lesson's vector, because an
-- objective is retrieved AS AN OBJECTIVE: it is the unit a learner's evidence
-- points at, and a citation naming one has to name the statement, not the
-- lesson that happens to contain it.
CREATE INDEX learning_objectives_search_idx
    ON learning_objectives
 USING GIN (to_tsvector('simple'::regconfig, coalesce(statement, '')));

-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--
--   - No new table, so nothing to keep in sync and nothing new to secure.
--   - No new RLS policy. Retrieval is governed by `lessons_select` and
--     `learning_objectives_select` exactly as every other read is.
--   - No new grant. `edu_app` already has SELECT on both tables; an index
--     confers no privilege.
--   - No trigger. There is no derived state to maintain.
--   - No change to any existing object, so the upgrade path is additive and the
--     rollback is `DROP INDEX` on two indexes that nothing depends on.
--
-- Retrieval is CORRECT without these indexes and merely slower — they are a
-- performance change, not a behavioural one. Dropping them cannot cause a
-- learner to see something they should not.
-- ============================================================================

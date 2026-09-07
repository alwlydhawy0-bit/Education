-- ============================================================================
-- 0026 — VECTOR INDEX OVER PUBLISHED CURRICULUM (Task 011)
-- ============================================================================
--
-- THIS MIGRATION REVERSES A DECISION 0023 ARGUED FOR AT LENGTH, so it owes that
-- argument an answer rather than a silence. 0023 declined to build a chunk
-- table and gave three reasons. Each is answered below by a mechanism in this
-- file, not by a change of mind.
--
-- What changed in the world: `pgvector` is now installed (0.6.0, with HNSW).
-- 0023's stated reason for full-text search — "pgvector is NOT AVAILABLE in
-- this PostgreSQL installation — checked, not assumed" — no longer holds. It
-- was true when written; `db/bootstrap.sql` now creates the extension.
--
-- ── 0023's OBJECTION 1: DUPLICATED TRUTH ────────────────────────────────────
--
--   "A copy of a lesson's text is a second answer to 'what does this lesson
--    say', and the two drift."
--
-- ANSWERED BY `source_updated_at`. Every chunk records the lesson's
-- `updated_at` as it stood when the chunk was cut. Retrieval joins the LIVE
-- lesson and returns a chunk only when the two still match. An edited lesson
-- does not serve stale text — its chunks simply stop being retrievable until
-- the course is re-indexed. The copy cannot drift from the original because a
-- drifted copy is invisible.
--
-- ── 0023's OBJECTION 2: STALENESS IS A SECURITY BUG ─────────────────────────
--
--   "When a lesson is archived, the learner must stop being able to reach it.
--    With a copy, that requires an invalidation path, and the day it misses one
--    the assistant serves retired material."
--
-- ANSWERED BY MAKING THE JOIN MANDATORY. Retrieval cannot read this table
-- alone: the pre-filter in §3 of the task requires joining `lessons` and
-- `course_units` anyway, so lifecycle and Row Level Security are inherited from
-- the live rows on every single query. Archiving a lesson removes it from the
-- learner's view and the chunk vanishes with it. THERE IS NO INVALIDATION PATH
-- BECAUSE THERE IS NOTHING TO INVALIDATE — the embedding is stale, not the
-- authorization.
--
-- ── 0023's OBJECTION 3: A SECOND AUTHORIZATION SURFACE ──────────────────────
--
--   "A chunk table needs its own RLS, mirroring lessons_select ... a mirror
--    that can be wrong."
--
-- ANSWERED BY NOT MIRRORING. The policy below is
-- `app_actor_sees_lesson(lesson_id)` — the SAME invoker-rights helper
-- `learning_activities_select` uses. It does not restate the lesson rule; it
-- delegates to it, so the two cannot disagree. (That helper must stay
-- invoker-rights: wrapping it in SECURITY DEFINER is VULN-040, where the
-- equivalent wrapper made every lab in the platform world-readable.)
--
-- ── WHAT REMAINS TRUE FROM 0023 ─────────────────────────────────────────────
--
-- "THE SECURITY PROPERTY IS INDEPENDENT OF THE RANKING FUNCTION. Authorization
--  constrains WHICH ROWS are searched; similarity only orders them."
--
-- That is still the design. This migration changes the ORDER BY and leaves the
-- WHERE exactly where 0023 put it.
-- ============================================================================

-- ── THE EXTENSION IS A PRECONDITION, NOT A STEP ─────────────────────────────
--
-- `CREATE EXTENSION vector` needs superuser and `edu_migrator` is deliberately
-- not one, so `db/bootstrap.sql` creates it — in the `extensions` schema, where
-- `--reset`'s `DROP SCHEMA public CASCADE` cannot destroy it. This refuses with
-- an instruction rather than with `type "vector" does not exist` forty lines
-- further down.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION
      'pgvector is not installed. Run db/bootstrap.sql as a superuser (it creates the extension in schema "extensions"), then re-run migrations.';
  END IF;
END
$$;

-- ── THE TABLE ───────────────────────────────────────────────────────────────

CREATE TABLE curriculum_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- STRUCTURAL ANCESTRY, all three levels, denormalized on purpose — and this
  -- is the one place on this platform where denormalizing the tree is right.
  -- Elsewhere (0024's missing class_id) a stored ancestor is a second source of
  -- truth about a live relationship. Here every one of these is FIXED for the
  -- life of the row: a lesson cannot move between units, and the row is deleted
  -- and rebuilt when the content changes. They exist so the tenant and course
  -- filters can be applied BEFORE the vector scan, which is §3's requirement.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id)      ON DELETE CASCADE,
  unit_id   uuid NOT NULL REFERENCES course_units(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES lessons(id)      ON DELETE CASCADE,

  -- CASCADE on all four, unlike the workspace tables in 0025 where SET NULL
  -- protects a child's writing. An embedding is DERIVED DATA with no
  -- independent worth: when the lesson goes, the chunk is meaningless, and
  -- keeping it would be keeping a searchable copy of deleted content.

  chunk_index   integer NOT NULL,
  chunk_content text    NOT NULL,

  -- 768 dimensions. Not configurable, because a vector column's dimension is
  -- part of its type and an index is built for it — "make it configurable"
  -- means "make every deployment a different schema". `embedding_model`
  -- records which model produced it so a change of provider is a visible
  -- re-index rather than a silent mixing of incomparable spaces.
  embedding extensions.vector(768) NOT NULL,
  embedding_model text NOT NULL,

  -- THE FRESHNESS GUARD: the lesson's `updated_at` as it stood when this chunk
  -- was cut. Retrieval compares it against the live lesson and skips a chunk
  -- whose source has moved on since. See objection 1 above.
  --
  -- A TIMESTAMP RATHER THAN A CONTENT DIGEST, and the first draft of this
  -- migration used a digest. The comparison has to happen inside the retrieval
  -- query — that is what makes it un-forgettable — so a digest would have to be
  -- recomputed in SQL, while the indexer computes it in TypeScript. Two
  -- implementations of one normalization (whitespace, field order, whether
  -- objectives are included) is a drift bug with a guaranteed arrival date, and
  -- the drift would present as "retrieval silently returns nothing".
  --
  -- `lessons.updated_at` is already this platform's answer to "has this
  -- changed": Task 011 made it the optimistic-concurrency precondition for
  -- every lesson write. Reusing it means ONE definition of change, compared as
  -- equality, with nothing to keep in sync.
  --
  -- THE RESIDUAL RISK, stated rather than hidden: an edit that changes
  -- `content_body` WITHOUT bumping `updated_at` — a hand-run UPDATE, or a
  -- future migration — would leave stale chunks looking fresh. Every
  -- application write path sets it (`notebook`, `curriculum` and the authoring
  -- routes all do), so this is an out-of-band-edit risk, recorded in
  -- docs/security/limitations.md as RISK-RAG-01.
  source_updated_at timestamptz NOT NULL,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT curriculum_embeddings_chunk_index_ck CHECK (chunk_index >= 0),
  CONSTRAINT curriculum_embeddings_content_len_ck
    CHECK (length(chunk_content) BETWEEN 1 AND 8000),
  CONSTRAINT curriculum_embeddings_model_len_ck
    CHECK (length(embedding_model) BETWEEN 1 AND 100),
  CONSTRAINT curriculum_embeddings_metadata_kind_ck CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT curriculum_embeddings_metadata_size_ck CHECK (pg_column_size(metadata) <= 8192),

  -- One row per (lesson, model, chunk). Re-indexing a lesson with the same
  -- model replaces its chunks rather than accumulating duplicates, and two
  -- models can coexist during a migration between them.
  CONSTRAINT curriculum_embeddings_chunk_uk UNIQUE (lesson_id, embedding_model, chunk_index)
);

-- ── INDEXES ─────────────────────────────────────────────────────────────────

-- THE PRE-FILTER INDEX, and it comes first because it is the one that carries
-- the security property. Every retrieval narrows by course before it ranks by
-- distance; this is what makes that narrowing cheap enough that nobody is ever
-- tempted to skip it "for performance".
CREATE INDEX curriculum_embeddings_scope_ix
  ON curriculum_embeddings (course_id, embedding_model);

CREATE INDEX curriculum_embeddings_lesson_ix
  ON curriculum_embeddings (lesson_id, embedding_model);

CREATE INDEX curriculum_embeddings_org_ix
  ON curriculum_embeddings (organization_id, embedding_model);

-- HNSW rather than IVFFlat: it needs no training pass over an existing corpus,
-- so it behaves correctly on an empty table and on a table that grows one
-- course at a time — which is exactly how this one fills. IVFFlat's lists must
-- be sized against a corpus that does not exist yet on a new deployment.
--
-- `vector_cosine_ops` because the embeddings are L2-normalized, making cosine
-- distance the metric that matches how they were produced.
--
-- THIS INDEX IS AN OPTIMIZATION AND NOTHING ELSE. Dropping it makes retrieval
-- slower and identical; it cannot cause a learner to see something they should
-- not, because it is never consulted before the scope filter. Same property
-- 0023 claimed for its GIN indexes, and worth keeping true.
CREATE INDEX curriculum_embeddings_vector_ix
  ON curriculum_embeddings
  USING hnsw (embedding extensions.vector_cosine_ops);

-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
--
-- DELEGATED, NOT MIRRORED. `app_actor_sees_lesson` is the invoker-rights helper
-- the rest of the platform uses; its EXISTS runs under the CALLER'S policies on
-- `lessons`, so this table's visibility IS the lesson's visibility rather than
-- a copy of it that could drift. Objection 3, answered.

ALTER TABLE curriculum_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE curriculum_embeddings FORCE  ROW LEVEL SECURITY;

CREATE POLICY curriculum_embeddings_definer_all ON curriculum_embeddings
  FOR ALL TO edu_migrator USING (true) WITH CHECK (true);

CREATE POLICY curriculum_embeddings_select ON curriculum_embeddings
  FOR SELECT TO edu_app
  USING (app_actor_sees_lesson(lesson_id));

-- WRITES ARE FOR CONTENT STAFF, and only within their own school.
--
-- `app_lesson_course` and `app_course_organization` are definer helpers, so the
-- organization is resolved from the CONTENT rather than from the payload — a
-- writer cannot claim a row belongs to a school by saying so.
CREATE POLICY curriculum_embeddings_insert ON curriculum_embeddings
  FOR INSERT TO edu_app
  WITH CHECK (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_actor_sees_lesson(lesson_id)
    AND app_course_organization(app_lesson_course(lesson_id)) IS NOT NULL
    AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
  );

CREATE POLICY curriculum_embeddings_delete ON curriculum_embeddings
  FOR DELETE TO edu_app
  USING (
    (app_actor_authors_content() OR app_actor_publishes_content())
    AND app_actor_sees_lesson(lesson_id)
    AND app_course_organization(app_lesson_course(lesson_id)) = app_actor_organization()
  );

-- NO UPDATE POLICY AND NO UPDATE GRANT. A chunk is derived data: re-indexing
-- deletes and re-inserts. Making it mutable would allow an embedding to be
-- edited away from the text it claims to represent — a chunk whose vector says
-- one thing and whose content says another is a retrieval result that cannot be
-- reasoned about.

-- ── THE GUARD ───────────────────────────────────────────────────────────────

/**
 * Ancestry is DERIVED, never accepted.
 *
 * A writer supplies `lesson_id` and the content; the unit, the course and the
 * organization are resolved here from the live tree. Accepting them would let
 * a row claim to belong to a course it does not — which matters more here than
 * almost anywhere, because those columns are the PRE-FILTER: a mislabelled row
 * is a row that answers queries scoped to somebody else's course.
 *
 * SECURITY DEFINER so it can walk the tree regardless of the writer's own
 * visibility. That is safe because it only ever writes back what the tree
 * already says, and the RLS insert check above independently requires the
 * writer to see the lesson in the first place.
 */
CREATE FUNCTION curriculum_embedding_ancestry_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  resolved_unit   uuid;
  resolved_course uuid;
BEGIN
  SELECT l.unit_id INTO resolved_unit FROM lessons l WHERE l.id = NEW.lesson_id;
  IF resolved_unit IS NULL THEN
    RAISE EXCEPTION 'Unknown lesson' USING ERRCODE = 'foreign_key_violation';
  END IF;

  resolved_course := app_unit_course(resolved_unit);

  NEW.unit_id         := resolved_unit;
  NEW.course_id       := resolved_course;
  NEW.organization_id := app_course_organization(resolved_course);
  NEW.created_at      := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER curriculum_embeddings_ancestry
  BEFORE INSERT ON curriculum_embeddings
  FOR EACH ROW EXECUTE FUNCTION curriculum_embedding_ancestry_guard();

-- ── PRIVILEGES ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, DELETE ON curriculum_embeddings TO edu_app;

REVOKE ALL ON FUNCTION curriculum_embedding_ancestry_guard() FROM PUBLIC;

-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT INDEX
-- ============================================================================
--
-- `notes`, `student_notebooks` and `student_artifacts` — the Task 010
-- workspace. A learner's private writing is not curriculum, and a knowledge
-- base that contained it would answer one child's question with another
-- child's notes. There is no column here that could reference them, no policy
-- branch that would admit them, and
-- `tests/architecture/knowledge-boundaries.test.ts` asserts the ingestion
-- source list mentions neither.
--
-- Assessment questions and answer keys, for the same reason plus a sharper one:
-- an assistant that retrieved from `assessment_answer_keys` would hand a
-- learner the marking scheme. 0019 keeps that table out of application SQL
-- entirely and this migration does not make an exception.
-- ============================================================================

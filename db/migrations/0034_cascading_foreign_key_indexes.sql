-- ===========================================================================
-- 0034 — INDEXES FOR EVERY CASCADING FOREIGN KEY
-- ===========================================================================
--
-- PostgreSQL indexes the REFERENCED side of a foreign key automatically (it has
-- to — the reference is to a primary key or a unique constraint). It does NOT
-- index the REFERENCING side, and nothing warns you.
--
-- That asymmetry is invisible until a parent row is deleted. To enforce
-- ON DELETE CASCADE or ON DELETE SET NULL, PostgreSQL must find every child row
-- pointing at the departing parent. With no index on the referencing column it
-- finds them by SEQUENTIALLY SCANNING the whole child table, holding a lock on
-- it while it does.
--
-- ---------------------------------------------------------------------------
-- WHY THIS PLATFORM IN PARTICULAR
-- ---------------------------------------------------------------------------
--
-- Deleting a parent row is not an exotic operation here. It is the erasure path
-- a school is legally obliged to have: remove a pupil, remove a class, remove
-- an organization at the end of a contract. Those deletes fan out across nearly
-- every table in the schema.
--
-- The audit found THIRTY-FIVE foreign keys with ON DELETE CASCADE or SET NULL
-- and no covering index, across ai_messages, assessment_attempt_answers,
-- discussion_replies, portfolio_items, project_artifacts and twenty more. On a
-- populated deployment, one deletion of one user would take an exclusive lock
-- on each of those tables in turn and scan it end to end — while lessons are
-- being marked complete and quizzes submitted on the same tables.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT INDEXED HERE
-- ---------------------------------------------------------------------------
--
-- Only the CASCADING and NULLING keys. A foreign key with the default
-- NO ACTION / RESTRICT behaviour also needs the parent's children found, but
-- only to REFUSE the delete, and refusing is bounded by the first match rather
-- than by the whole table.
--
-- The single-column index on assessment_attempt_answers (question_id) is
-- deliberately absent: the composite (question_id, option_id) below has it as a
-- leading column, and a redundant index costs a write on every insert forever
-- in exchange for nothing.
--
-- Composite keys get composite indexes IN THE KEY'S COLUMN ORDER. An index on
-- the columns in a different order does not serve the constraint.
--
-- ---------------------------------------------------------------------------
-- THE DELIVERABLE IS THE RULE, NOT THESE THIRTY-FOUR STATEMENTS
-- ---------------------------------------------------------------------------
--
-- `tools/db/audit-indexes.ts` derives this list from the catalog, and
-- `tests/integration/index-audit.test.ts` fails when a new cascading key lands
-- without one. These statements are what the rule found the first time it ran;
-- the rule is what stops the list growing again in silence.
--
-- IF NOT EXISTS throughout, so a deployment that already added one of these by
-- hand is not an error.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS ai_conversations_course_id_fk_ix
  ON ai_conversations (course_id);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_id_owner_id_fk_ix
  ON ai_messages (conversation_id, owner_id);
CREATE INDEX IF NOT EXISTS analytics_course_performance_course_id_fk_ix
  ON analytics_course_performance (course_id);
CREATE INDEX IF NOT EXISTS assessment_attempt_answers_question_id_option_id_fk_ix
  ON assessment_attempt_answers (question_id, option_id);
CREATE INDEX IF NOT EXISTS assessment_attempts_released_by_fk_ix
  ON assessment_attempts (released_by);
CREATE INDEX IF NOT EXISTS class_course_assignments_assigned_by_fk_ix
  ON class_course_assignments (assigned_by);
CREATE INDEX IF NOT EXISTS content_flags_reporter_id_fk_ix
  ON content_flags (reporter_id);
CREATE INDEX IF NOT EXISTS content_flags_reviewed_by_fk_ix
  ON content_flags (reviewed_by);
CREATE INDEX IF NOT EXISTS course_units_created_by_fk_ix
  ON course_units (created_by);
CREATE INDEX IF NOT EXISTS courses_created_by_fk_ix
  ON courses (created_by);
CREATE INDEX IF NOT EXISTS curricula_created_by_fk_ix
  ON curricula (created_by);
CREATE INDEX IF NOT EXISTS curriculum_embeddings_unit_id_fk_ix
  ON curriculum_embeddings (unit_id);
CREATE INDEX IF NOT EXISTS discussion_replies_parent_reply_id_thread_id_fk_ix
  ON discussion_replies (parent_reply_id, thread_id);
CREATE INDEX IF NOT EXISTS discussion_replies_thread_id_class_id_fk_ix
  ON discussion_replies (thread_id, class_id);
CREATE INDEX IF NOT EXISTS discussion_threads_course_id_fk_ix
  ON discussion_threads (course_id);
CREATE INDEX IF NOT EXISTS guardian_relationships_verified_by_fk_ix
  ON guardian_relationships (verified_by);
CREATE INDEX IF NOT EXISTS learning_activities_created_by_fk_ix
  ON learning_activities (created_by);
CREATE INDEX IF NOT EXISTS lessons_created_by_fk_ix
  ON lessons (created_by);
CREATE INDEX IF NOT EXISTS notes_course_id_fk_ix
  ON notes (course_id);
CREATE INDEX IF NOT EXISTS notes_lesson_id_fk_ix
  ON notes (lesson_id);
CREATE INDEX IF NOT EXISTS notes_organization_id_fk_ix
  ON notes (organization_id);
CREATE INDEX IF NOT EXISTS notes_unit_id_fk_ix
  ON notes (unit_id);
CREATE INDEX IF NOT EXISTS portfolio_items_portfolio_id_owner_id_fk_ix
  ON portfolio_items (portfolio_id, owner_id);
CREATE INDEX IF NOT EXISTS portfolio_items_project_id_owner_id_fk_ix
  ON portfolio_items (project_id, owner_id);
CREATE INDEX IF NOT EXISTS project_artifacts_project_id_owner_id_fk_ix
  ON project_artifacts (project_id, owner_id);
CREATE INDEX IF NOT EXISTS sessions_rotated_from_fk_ix
  ON sessions (rotated_from);
CREATE INDEX IF NOT EXISTS student_artifacts_note_id_owner_id_fk_ix
  ON student_artifacts (note_id, owner_id);
CREATE INDEX IF NOT EXISTS student_artifacts_organization_id_fk_ix
  ON student_artifacts (organization_id);
CREATE INDEX IF NOT EXISTS student_artifacts_session_id_owner_id_fk_ix
  ON student_artifacts (session_id, owner_id);
CREATE INDEX IF NOT EXISTS student_notebooks_organization_id_fk_ix
  ON student_notebooks (organization_id);
CREATE INDEX IF NOT EXISTS student_portfolios_organization_id_fk_ix
  ON student_portfolios (organization_id);
CREATE INDEX IF NOT EXISTS student_projects_course_id_fk_ix
  ON student_projects (course_id);
CREATE INDEX IF NOT EXISTS student_projects_featured_by_fk_ix
  ON student_projects (featured_by);
CREATE INDEX IF NOT EXISTS user_roles_granted_by_fk_ix
  ON user_roles (granted_by);

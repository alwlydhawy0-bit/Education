-- ============================================================================
-- 0031 — LETTING THE AUTOMATED FILTER FILE ITS OWN FLAG
-- ============================================================================
--
-- `content_flags_insert` in 0029 required `raised_by = 'member'`, which meant
-- the automated filter could never file anything: every post the filter caught
-- was created as 'flagged' and then the flag insert was refused by RLS, taking
-- the whole request down with it. A learner writing something offensive got a
-- 500, and the moderation queue never heard about it.
--
-- The adversarial probe missed this because it exercised the DATABASE and the
-- filter lives in the application: the probe filed member flags by hand and
-- they worked. Only the end-to-end suite, which posts real text through the
-- real service, could see it. That is the same lesson as Task 012's provider
-- gate — some defects are only visible from the layer that runs both halves.
--
-- ----------------------------------------------------------------------------
-- WHY NOT SIMPLY ALLOW `raised_by = 'automated_filter'`
-- ----------------------------------------------------------------------------
--
-- Because `content_flags_reporter_pairing_ck` pairs an automated flag with a
-- NULL reporter, and `content_flags_one_per_reporter_uk` is a partial index
-- that only constrains rows WHERE `reporter_id IS NOT NULL`. So a caller who
-- could claim `raised_by = 'automated_filter'` would get anonymous reporting
-- with no per-person limit — which is exactly the flag-flooding attack the
-- index exists to prevent, available to anyone who reads this schema.
--
-- ----------------------------------------------------------------------------
-- THE CONDITION THAT MAKES IT SAFE
-- ----------------------------------------------------------------------------
--
-- An automated flag may only ever be filed against a post THE CALLER THEMSELVES
-- AUTHORED. That is precisely the real case: the service screens the text a
-- learner is submitting, and files a flag about their own new post.
--
-- The consequence is that the escape hatch leads nowhere. Someone forging
-- `raised_by = 'automated_filter'` can only flood flags about their own posts,
-- which is bounded by the posting rate limit and harms nobody but themselves.
-- They cannot file an anonymous report about a classmate, which is the thing
-- worth preventing.
-- ============================================================================

DROP POLICY content_flags_insert ON content_flags;

CREATE POLICY content_flags_insert ON content_flags FOR INSERT TO edu_app
  WITH CHECK (
    status = 'pending'
    AND EXISTS (SELECT 1 FROM discussion_threads t WHERE t.id = content_flags.thread_id)
    AND (
      raised_by = 'member'
      OR (
        raised_by = 'automated_filter'
        AND app_current_actor() IS NOT NULL
        AND (
          (entity_type = 'thread' AND EXISTS (
             SELECT 1 FROM discussion_threads t
              WHERE t.id = content_flags.entity_id AND t.author_id = app_current_actor()))
          OR
          (entity_type = 'reply' AND EXISTS (
             SELECT 1 FROM discussion_replies r
              WHERE r.id = content_flags.entity_id AND r.author_id = app_current_actor()))
        )
      )
    )
  );

COMMENT ON POLICY content_flags_insert ON content_flags IS
  'Members report anything in their room; the filter flags only the caller''s own post.';

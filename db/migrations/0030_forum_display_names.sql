-- ============================================================================
-- 0030 — DISPLAY NAMES INSIDE A FORUM
-- ============================================================================
--
-- A forum where nobody has a name is not a forum, and 0029 shipped without a
-- way to give anyone one. This migration is the fix, and the bug it fixes is
-- one this codebase has now hit three times in three tasks.
--
-- ----------------------------------------------------------------------------
-- THE BUG, FOR THE THIRD TIME
-- ----------------------------------------------------------------------------
--
-- `users` has row-level security. `users_select` admits a row to the user
-- themselves, to a teacher of that learner, to a verified guardian, and to an
-- organization administrator. A CLASSMATE IS NONE OF THOSE.
--
-- So the obvious way to show who wrote a post — join `users`, take
-- `display_name` — returns nothing for every post by anybody other than the
-- reader. With an INNER JOIN the post disappears entirely; with a LEFT JOIN the
-- name is null and every post is by "somebody".
--
--   VULN-054 (Task 012): an inner join to `lessons` silently vetoed the
--   moderation policy and hid a departed learner's own transcript.
--   VULN-055 (Task 013): an inner join to `users` for a display name returned
--   zero rows for every published portfolio on the platform.
--   And now the same shape again, caught this time by reading the query rather
--   than by running it.
--
-- The general rule, which is worth stating once more: A JOIN ADDED TO FETCH A
-- DISPLAY VALUE IS AN ACCESS PREDICATE WHETHER OR NOT ANYBODY MEANT IT AS ONE.
--
-- ----------------------------------------------------------------------------
-- WHY THIS FUNCTION AND NOT A BROADER ONE
-- ----------------------------------------------------------------------------
--
-- Task 013 fixed its instance by REMOVING the field: an account display name is
-- registration data a child gave their school, and a portfolio is served to
-- strangers. That was right there and is wrong here. A forum post without an
-- author is unusable — you cannot follow a conversation, you cannot tell who
-- answered you, and a moderator cannot tell one participant from another.
--
-- So the name is fetched, and the function is bounded twice over:
--
--   THE CALLER MUST BE IN THE ROOM. `app_actor_in_class_forum(p_class_id)`, the
--   same predicate every policy in 0029 uses.
--
--   THE SUBJECT MUST BE IN THE SAME ROOM. Passing a user id from outside the
--   class returns NULL, so this cannot become a way to resolve arbitrary user
--   ids to names — which is what a bare `app_display_name(uuid)` would have
--   been, and why that simpler function is not what this is.
--
-- The result is that the function discloses exactly one thing: the names of
-- people the caller is already sitting in a class with. That is a fact the
-- class register already tells them.
--
-- SECURITY DEFINER, and the tables it reads all have a definer SELECT policy
-- already — `users_definer_select` from 0005, `class_memberships_definer_select`
-- and `teacher_assignments_definer_select` from 0014.
-- `tests/integration/rls-definer-coverage.test.ts` asserts that from the
-- catalog rather than from this comment.
-- ============================================================================

CREATE FUNCTION app_forum_display_name(p_user_id uuid, p_class_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.display_name
    FROM users u
   WHERE u.id = p_user_id
     AND p_class_id IS NOT NULL
     -- The caller is in this room.
     AND app_actor_in_class_forum(p_class_id)
     -- And so is the person being named.
     AND (
          EXISTS (SELECT 1 FROM class_memberships cm
                   WHERE cm.class_id = p_class_id AND cm.user_id = p_user_id
                     AND cm.status = 'active')
       OR EXISTS (SELECT 1 FROM teacher_assignments ta
                   WHERE ta.class_id = p_class_id AND ta.teacher_id = p_user_id
                     AND ta.status = 'active')
     );
$$;

COMMENT ON FUNCTION app_forum_display_name(uuid, uuid) IS
  'A forum author''s name, only to somebody in the same class. Never a general user lookup.';

REVOKE ALL ON FUNCTION app_forum_display_name(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_forum_display_name(uuid, uuid) TO edu_app;

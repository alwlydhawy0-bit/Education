-- ============================================================================
-- 0029 — DISCUSSION THREADS, REPLIES, FLAGS AND MODERATION
-- ============================================================================
--
-- The first place on this platform where one child writes and ANOTHER CHILD
-- READS. Everything before this was either private (notes, workspace, tutor
-- transcripts), authored by adults (curriculum), or shown to strangers only
-- through a page its owner deliberately published (portfolios). A forum is
-- different in kind: the audience is other minors, it is immediate, and nobody
-- chose it post by post.
--
-- That changes which risks matter. Cross-tenant leakage is still the one that
-- would be catastrophic and is handled the way it always is here. But the risk
-- that is NEW is peer-to-peer: a post is a thing one child can aim at another,
-- and the platform is the thing that delivers it.
--
-- ----------------------------------------------------------------------------
-- THE REPLY TREE IS THE NEW ATTACK SURFACE, AND A FOREIGN KEY CLOSES IT
-- ----------------------------------------------------------------------------
--
-- `discussion_replies.parent_reply_id` is the first self-referential pointer in
-- this schema, and it is a way to reach ACROSS a boundary that every other
-- column respects. Consider a reply whose `thread_id` names a thread in the
-- attacker's own class and whose `parent_reply_id` names a reply in a thread
-- belonging to somebody else's class. Every policy below would admit it: the
-- row is in a thread the author may post to, and the author is who they say
-- they are. The tree would then span two classes, and any renderer walking it
-- would carry a child's words out of the room they were spoken in.
--
-- No policy is asked to notice that, because a composite key makes it
-- impossible to write:
--
--   UNIQUE (id, thread_id)
--   FOREIGN KEY (parent_reply_id, thread_id) REFERENCES discussion_replies (id, thread_id)
--
-- A parent in another thread has no matching row, so the insert fails on
-- referential integrity — beneath RLS, beneath SECURITY DEFINER, and beneath
-- any question about which role is executing. This is the same technique 0028
-- used to stop one child publishing another's project, applied to the one
-- pointer in this migration that could cross a boundary.
--
-- ----------------------------------------------------------------------------
-- A LOCKED THREAD IS ENFORCED WHERE IT CANNOT BE ROUTED AROUND
-- ----------------------------------------------------------------------------
--
-- Section 3 requires that `is_locked` reject new replies "regardless of API
-- routes". So the check is in the INSERT policy's `WITH CHECK`, evaluated by
-- PostgreSQL against the thread row at write time:
--
--   EXISTS (SELECT 1 FROM discussion_threads t
--            WHERE t.id = thread_id AND NOT t.is_locked AND ...)
--
-- INVOKER RIGHTS ON THAT SUBQUERY, deliberately. It reads `discussion_threads`,
-- whose own policy already decides who may see the thread, so a caller who
-- cannot see the thread cannot satisfy the check either — the reply policy
-- INHERITS the thread policy rather than restating it. Making this a definer
-- helper would be the VULN-040 mistake exactly: "is this thread unlocked and
-- visible to me" would decay into "does this thread id exist and is it
-- unlocked", which is true for every unlocked thread on the platform.
--
-- Locking is a TEACHER'S CONTROL OVER A CONVERSATION, not a punishment aimed at
-- a person, so it stops new replies and hides nothing that was already said. A
-- locked thread stays readable. Deleting the argument is not moderating it.
--
-- ----------------------------------------------------------------------------
-- MODERATION STATUS, AND WHO CAN SEE THEIR OWN HIDDEN POST
-- ----------------------------------------------------------------------------
--
-- Three states, and the transitions are the interesting part:
--
--   'approved' — visible to the class. The state a post reaches when the
--                automated filter finds nothing and nobody has flagged it.
--   'flagged'  — the filter or a reporter raised it. Visible to staff and to
--                its own author, and to nobody else, pending review.
--   'hidden'   — a human decided it should not be read. Same visibility.
--
-- SECTION 3 SAYS FLAGGED AND HIDDEN POSTS ARE "EXCLUDED FROM STUDENT QUERIES",
-- AND THE AUTHOR IS THE ONE STUDENT THIS MIGRATION EXCLUDES THEM FROM SEEING.
-- That is a deliberate reading rather than an oversight. A child whose post
-- vanishes without trace learns that the platform is unreliable and posts it
-- again; a child who can see their own post marked "under review" has been told
-- something true. It is their own text, so showing it to them discloses
-- nothing — and the alternative teaches children that content disappears for
-- no reason, which is a worse lesson than the one moderation is trying to give.
--
-- What the author may NOT do is edit their way out of it: the guard below
-- refuses author edits to a hidden post, so the reviewed text stays the text
-- that was reviewed.
--
-- ----------------------------------------------------------------------------
-- THE AUTOMATED FILTER FLAGS. IT DOES NOT BLOCK, AND IT IS NOT SAFETY.
-- ----------------------------------------------------------------------------
--
-- `moderation_status` defaults to 'approved' and the application moves a post
-- to 'flagged' before insert when its keyword filter matches. Two consequences
-- worth stating in the schema rather than only in the code:
--
--   The database does not run the filter. A word list in a CHECK constraint
--   would be a migration every time a word changed, unversioned in any way a
--   reviewer could read, and impossible to test. The filter is a pure function
--   in TypeScript with its own suite.
--
--   Flagging is not blocking, and that is the safer of the two. A false
--   positive costs a teacher ten seconds; a false negative reaches a class that
--   can flag it. Blocking on a word list would make the list an oracle a child
--   can probe, and would teach the determined ones to spell around it while
--   punishing the child who used a clinical word in a biology thread.
--
-- NOTHING HERE IS A SAFETY SYSTEM. Bullying, exclusion, grooming and a child
-- disclosing self-harm are not lexical events; a list of rude words does not
-- see any of them. What this domain provides is a REPORTING PATH to a named
-- adult and a queue that adult can work. `docs/security/limitations.md` records
-- that distinction rather than letting the presence of a filter imply the
-- absence of the problem.
--
-- ============================================================================

-- ── DISCUSSION THREADS ──────────────────────────────────────────────────────

CREATE TABLE discussion_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE FORUM IS A ROOM, AND THE ROOM IS A CLASS. NOT NULL, unlike a project's
  -- class, because a thread with no class has no audience this schema can
  -- describe: every read policy below is anchored on class membership, so a
  -- classless thread would be visible to nobody and reachable by nothing.
  --
  -- CASCADE. A class that is gone takes its conversations with it. Contrast
  -- `student_projects.class_id`, which is ON DELETE SET NULL because a child's
  -- own work outlives the class it was made in — a thread is not one person's
  -- work, it is the room, and the room does not outlive the building.
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,

  -- Optional subject anchor. Validated by the guard as a course actually
  -- assigned to this class, so a thread cannot be filed under coursework the
  -- class never studied. RESTRICT would block deleting a course that has ever
  -- been discussed; SET NULL loses the anchor and keeps the conversation, which
  -- is the right way round.
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,

  -- Derived from the class by the guard, never accepted from a caller. Carried
  -- so the moderation queue and the org-admin policies can scope without
  -- dereferencing the class on every row.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- CASCADE, and this is a real decision rather than a default. When an account
  -- is deleted its posts go with it. The alternative — orphaned posts attributed
  -- to nobody — keeps a child's words on the platform after the child has been
  -- removed from it, which is the opposite of what deleting an account means.
  -- The conversation loses coherence; that is the correct price.
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title            text NOT NULL,
  content_markdown text NOT NULL,

  is_pinned boolean NOT NULL DEFAULT false,
  is_locked boolean NOT NULL DEFAULT false,

  moderation_status text NOT NULL DEFAULT 'approved',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT discussion_threads_title_ck
    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT discussion_threads_content_ck
    CHECK (length(btrim(content_markdown)) BETWEEN 1 AND 20000),
  CONSTRAINT discussion_threads_moderation_ck
    CHECK (moderation_status IN ('approved', 'flagged', 'hidden')),

  -- The target of the composite foreign key on `discussion_replies`. Redundant
  -- as uniqueness; load-bearing as a reference — see the header.
  CONSTRAINT discussion_threads_id_class_uk UNIQUE (id, class_id)
);

-- SECTION 2A'S FEED INDEX. Pinned first, then newest, which is the order the
-- listing actually asks for — an index on (class_id, created_at) alone would
-- leave the pin sort to a heap scan on every page of every class's forum.
CREATE INDEX discussion_threads_feed_ix
  ON discussion_threads (class_id, is_pinned DESC, created_at DESC);

CREATE INDEX discussion_threads_author_ix ON discussion_threads (author_id, created_at DESC);

-- The moderation queue: one school's non-approved threads. Partial, because the
-- queue is a small minority of rows and a moderator never pages through
-- approved ones.
CREATE INDEX discussion_threads_moderation_ix
  ON discussion_threads (organization_id, created_at DESC)
  WHERE moderation_status <> 'approved';

ALTER TABLE discussion_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_threads FORCE ROW LEVEL SECURITY;

-- ── DISCUSSION REPLIES ──────────────────────────────────────────────────────

CREATE TABLE discussion_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  thread_id uuid NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,

  -- Carried so the composite key below can bind a parent to THIS thread, and
  -- so the reply policies can scope by class without joining. It cannot drift
  -- from the thread's class, because a mismatched pair has no parent row.
  class_id uuid NOT NULL,

  -- THE POINTER THAT COULD CROSS A CLASS BOUNDARY. See the header: the
  -- composite foreign key below is what stops it, not a policy.
  parent_reply_id uuid,

  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  content_markdown text NOT NULL,

  -- Set by the THREAD'S AUTHOR or by staff, never by the reply's author — the
  -- guard enforces that. A learner marking their own answer as accepted is not
  -- an answer being accepted.
  is_accepted_answer boolean NOT NULL DEFAULT false,

  moderation_status text NOT NULL DEFAULT 'approved',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT discussion_replies_content_ck
    CHECK (length(btrim(content_markdown)) BETWEEN 1 AND 20000),
  CONSTRAINT discussion_replies_moderation_ck
    CHECK (moderation_status IN ('approved', 'flagged', 'hidden')),

  -- A reply cannot be its own parent. Deeper cycles are prevented by the depth
  -- guard below, which cannot be expressed as a CHECK.
  CONSTRAINT discussion_replies_not_self_parent_ck
    CHECK (parent_reply_id IS DISTINCT FROM id),

  CONSTRAINT discussion_replies_thread_class_fk
    FOREIGN KEY (thread_id, class_id)
    REFERENCES discussion_threads (id, class_id) ON DELETE CASCADE,

  CONSTRAINT discussion_replies_id_thread_uk UNIQUE (id, thread_id),

  -- THE ONE THAT MATTERS. A parent in another thread has no matching row.
  -- CASCADE so deleting a reply takes its subtree; the alternative is a forest
  -- of orphans pointing at nothing.
  CONSTRAINT discussion_replies_parent_fk
    FOREIGN KEY (parent_reply_id, thread_id)
    REFERENCES discussion_replies (id, thread_id) ON DELETE CASCADE
);

-- SECTION 2A'S REPLY INDEX.
CREATE INDEX discussion_replies_thread_ix ON discussion_replies (thread_id, created_at);
CREATE INDEX discussion_replies_parent_ix ON discussion_replies (parent_reply_id)
  WHERE parent_reply_id IS NOT NULL;
CREATE INDEX discussion_replies_author_ix ON discussion_replies (author_id, created_at DESC);

-- At most one accepted answer per thread. A partial unique index rather than a
-- constraint, because "unique among the true ones" is not something UNIQUE can
-- say on its own.
CREATE UNIQUE INDEX discussion_replies_one_accepted_uk
  ON discussion_replies (thread_id) WHERE is_accepted_answer;

ALTER TABLE discussion_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE discussion_replies FORCE ROW LEVEL SECURITY;

-- ── CONTENT FLAGS ───────────────────────────────────────────────────────────

/**
 * A report about a post, raised by a person or by the automated filter.
 *
 * `entity_type` / `entity_id` IS A POLYMORPHIC POINTER AND THEREFORE CANNOT
 * HAVE A FOREIGN KEY. That is a genuine weakness of this shape and it is worth
 * being explicit about rather than quietly accepting: nothing in the database
 * guarantees `entity_id` names a row that exists, and nothing cascades when the
 * target is deleted.
 *
 * Two things reduce the blast radius:
 *
 *   `thread_id` IS A REAL FOREIGN KEY, NOT NULL, ON DELETE CASCADE. Every flag
 *   names the thread it lives in — a reply's flag names the reply's thread — so
 *   deleting a thread takes its flags with it, and the moderation queue can be
 *   scoped by RLS through a column the database actually enforces rather than
 *   through a polymorphic id it cannot check.
 *
 *   A trigger cleans up reply-level flags when a reply is deleted, which is the
 *   one case `thread_id` does not cover. A trigger is a worse tool than a
 *   foreign key and is used here only because the spec'd shape leaves no better
 *   one; the comment on that trigger says so.
 */
CREATE TABLE content_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,

  -- The thread this flag lives in, for cascade and for scoping. Derived by the
  -- guard from the entity, never accepted from a caller — a caller who could
  -- choose it could file a flag about their own class's thread into somebody
  -- else's moderation queue.
  thread_id uuid NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,

  -- Derived likewise. The moderation queue is scoped by school.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- NULL when the automated filter raised it: no person reported this, and
  -- recording one would be a lie in an audit trail. SET NULL rather than
  -- CASCADE on account deletion, because a report about somebody ELSE'S post is
  -- a moderation record that should outlive the reporter's account.
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Whether a human raised this, distinct from `reporter_id IS NULL`, so that a
  -- deleted reporter's account cannot silently turn their report into an
  -- automated one.
  raised_by text NOT NULL DEFAULT 'member',

  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',

  -- Who closed it and when. NULL while pending.
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_flags_entity_type_ck CHECK (entity_type IN ('thread', 'reply')),
  CONSTRAINT content_flags_raised_by_ck CHECK (raised_by IN ('member', 'automated_filter')),
  CONSTRAINT content_flags_status_ck CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  CONSTRAINT content_flags_reason_ck CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  CONSTRAINT content_flags_reviewed_consistency_ck
    CHECK ((status = 'pending') = (reviewed_at IS NULL)),

  -- An automated flag has no reporter; a member's flag has one.
  CONSTRAINT content_flags_reporter_pairing_ck
    CHECK ((raised_by = 'automated_filter') = (reporter_id IS NULL))
);

-- ONE REPORT PER PERSON PER POST. Without this a single learner can file a
-- thousand reports against a classmate's post, which is both a denial of
-- service against the moderation queue and a way to use the reporting system
-- itself as harassment. Automated flags are excluded from the constraint by
-- having no reporter, and are deduplicated by the service instead.
CREATE UNIQUE INDEX content_flags_one_per_reporter_uk
  ON content_flags (entity_type, entity_id, reporter_id)
  WHERE reporter_id IS NOT NULL;

-- The teacher's queue: one school's pending flags, oldest first, because a
-- report that has waited longest is the one most in need of attention.
CREATE INDEX content_flags_queue_ix
  ON content_flags (organization_id, created_at)
  WHERE status = 'pending';

CREATE INDEX content_flags_entity_ix ON content_flags (entity_type, entity_id);
CREATE INDEX content_flags_thread_ix ON content_flags (thread_id);

ALTER TABLE content_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_flags FORCE ROW LEVEL SECURITY;

-- ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Whether the current actor may take part in a class's forum at all.
 *
 * Members and teachers of an ACTIVE class. One definition, called by every
 * policy below, so "who is in this room" cannot come to mean two things.
 *
 * A DEPARTED LEARNER LOSES THE ROOM, and that is the same rule Task 009 settled
 * for lab sessions and Task 012 for tutor conversations: `class_memberships`
 * must be 'active'. Their words remain in the thread — deleting a conversation
 * because somebody left would rewrite it for everybody who stayed — but they
 * can no longer read it or add to it.
 *
 * SECURITY DEFINER, composing two definer-rights helpers. That distinction is
 * VULN-040: a definer wrapped around an INVOKER-rights helper turns an
 * authorization check into a lookup. Both of these are already definer, so
 * nothing here inherits the caller's RLS and then silently stops doing so.
 */
CREATE FUNCTION app_actor_in_class_forum(p_class_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p_class_id IS NOT NULL
     AND (app_actor_is_member_of_class(p_class_id) OR app_actor_teaches_class(p_class_id));
$$;

/**
 * Whether the current actor may MODERATE a class's forum.
 *
 * Section 2C says "Teachers & Admins ... over all posts within their assigned
 * classes/organizations", and this reads that the same way 0027 read the
 * equivalent phrase: the organization is a CEILING nobody crosses, and inside
 * it the authority is the one the platform already recognises.
 *
 *   A TEACHER moderates the classes they actually teach. Not every class in the
 *   school — teaching 7B does not make somebody responsible for 9A's forum, and
 *   a moderation power that quietly spans a whole school is one nobody audits.
 *
 *   AN ORGANIZATION ADMIN moderates any class in their own school. They already
 *   administer every roster in it.
 *
 *   A MODERATOR likewise. This is the role `0007_rbac.sql` created in 2024 with
 *   the description "Moderates community content" and never used, because there
 *   was no community. This is the task it was reserved for.
 *
 * THE ORGANIZATION CHECK IS WRITTEN FIRST AND SEPARATELY so that the tenancy
 * bound cannot be lost inside a longer disjunction — the mistake 0027's comment
 * warns about. A thread whose organization is NULL is moderatable by nobody.
 *
 * A CAVEAT WORTH STATING: `app_actor_holds_role` ignores role SCOPE, so a
 * moderator scoped to one organization holds the role everywhere. The
 * organization comparison above is what bounds them — to THEIR OWN school, not
 * to the school their grant names. Those coincide today because a user has one
 * organization. `docs/security/limitations.md` records it.
 */
CREATE FUNCTION app_actor_moderates_class(p_class_id uuid, p_organization_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT p_organization_id IS NOT NULL
     AND p_organization_id = app_actor_organization()
     AND (
          (p_class_id IS NOT NULL AND app_actor_teaches_class(p_class_id))
       OR app_actor_is_org_admin()
       OR app_actor_holds_role('moderator')
     );
$$;

/**
 * Whether the current actor authored the thread a reply belongs to.
 *
 * Used by one rule only: who may mark a reply as the accepted answer. The
 * person who asked the question is the person who knows whether it was
 * answered, so `PATCH /replies/:id/accept` belongs to them and to staff.
 *
 * SECURITY DEFINER, AND THAT IS SAFE HERE FOR A SPECIFIC REASON. It reads
 * `discussion_threads` past the caller's RLS, which would be the VULN-040
 * mistake if it were answering "may I see this thread". It is not: it compares
 * the thread's author to the current actor and returns a boolean about the
 * CALLER. A caller who cannot see the thread gets `false` for every thread,
 * including ones they could see — the function grants nothing and discloses
 * nothing. It is definer only to break a policy cycle, since the reply policy
 * that calls it is itself consulted while evaluating thread visibility.
 */
CREATE FUNCTION app_actor_owns_thread(p_thread_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM discussion_threads t
     WHERE t.id = p_thread_id
       AND t.author_id = app_current_actor()
       AND app_current_actor() IS NOT NULL
  );
$$;

-- ── TRIGGERS ────────────────────────────────────────────────────────────────

/**
 * Derives what a caller must not choose, and keeps immutable things immutable.
 *
 * THE NULL-ACTOR EARLY RETURN IS NOT AN ESCAPE HATCH. Migrations, fixtures and
 * maintenance run with no `app.actor_id`, and asking "may the current actor
 * post to this class" of a caller who is not an actor has no true answer —
 * VULN-045, where a note-anchor trigger asked exactly that of every writer and
 * broke every backfill. RLS still applies to `edu_app`.
 */
CREATE FUNCTION discussion_thread_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.author_id  IS DISTINCT FROM OLD.author_id
       OR NEW.class_id   IS DISTINCT FROM OLD.class_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A thread''s author, room and origin are immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
    NEW.organization_id := OLD.organization_id;
    NEW.updated_at := now();

    -- AN AUTHOR MAY NOT EDIT THEIR WAY OUT OF MODERATION. A hidden post keeps
    -- the text that was hidden, so the record a reviewer acted on is the record
    -- that remains. Staff change `moderation_status` through the moderation
    -- path; this only stops the CONTENT moving underneath a decision.
    IF OLD.moderation_status = 'hidden'
       AND NEW.content_markdown IS DISTINCT FROM OLD.content_markdown THEN
      RAISE EXCEPTION 'A hidden post cannot be edited'
        USING ERRCODE = 'raise_exception';
    END IF;

    RETURN NEW;
  END IF;

  NEW.organization_id := app_class_organization(NEW.class_id);
  NEW.created_at := now();
  NEW.updated_at := now();

  IF app_current_actor() IS NULL THEN RETURN NEW; END IF;

  IF NOT app_actor_in_class_forum(NEW.class_id) THEN
    RAISE EXCEPTION 'You can only post in a class you are in'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A course, if named, must actually be taught to this class. Otherwise a
  -- learner could file a thread under any course id on the platform, and a
  -- course-filtered feed would show it to people studying something else.
  IF NEW.course_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM class_course_assignments a
        WHERE a.class_id = NEW.class_id
          AND a.course_id = NEW.course_id
          AND a.status = 'active')
  THEN
    RAISE EXCEPTION 'That course is not assigned to this class'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER discussion_threads_guard
  BEFORE INSERT OR UPDATE ON discussion_threads
  FOR EACH ROW EXECUTE FUNCTION discussion_thread_guard();

/**
 * THE COLUMN-LEVEL RULE FOR MODERATORS, which a policy cannot express.
 *
 * `discussion_threads_moderate` admits a ROW to a teacher, and 0028's probe
 * proved what that means in practice: with only the policy in place, a teacher
 * of the class could rewrite a child's post and the change would stand. On a
 * forum that is an adult putting words into a child's mouth, under the child's
 * name, in front of their classmates.
 *
 * So a non-author may change exactly four columns — `moderation_status`,
 * `is_pinned`, `is_locked`, `updated_at` — and nothing else. Not the title, not
 * the content.
 */
CREATE FUNCTION discussion_thread_moderation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_current_actor() IS NULL THEN RETURN NEW; END IF;
  IF NEW.author_id = app_current_actor() THEN RETURN NEW; END IF;

  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content_markdown IS DISTINCT FROM OLD.content_markdown
     OR NEW.course_id IS DISTINCT FROM OLD.course_id THEN
    RAISE EXCEPTION 'A moderator may pin, lock and change moderation status, and nothing else'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER discussion_threads_moderation_guard
  BEFORE UPDATE ON discussion_threads
  FOR EACH ROW EXECUTE FUNCTION discussion_thread_moderation_guard();

/**
 * The reply's equivalent, plus the two things only a reply has: its depth and
 * its class.
 *
 * DEPTH IS BOUNDED, AND A CHECK CONSTRAINT COULD NOT DO IT. Unbounded nesting
 * is not a security hole but it is a denial of service against every reader:
 * one learner replying to their own reply five thousand times produces a tree
 * no client can render and a recursive query that will not finish. Eight is
 * deep enough for a real conversation and shallow enough to walk.
 */
CREATE FUNCTION discussion_reply_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_depth integer;
  v_parent_thread uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.author_id IS DISTINCT FROM OLD.author_id
       OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
       OR NEW.parent_reply_id IS DISTINCT FROM OLD.parent_reply_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A reply''s author, thread, parent and origin are immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
    NEW.class_id := OLD.class_id;
    NEW.updated_at := now();

    IF OLD.moderation_status = 'hidden'
       AND NEW.content_markdown IS DISTINCT FROM OLD.content_markdown THEN
      RAISE EXCEPTION 'A hidden post cannot be edited'
        USING ERRCODE = 'raise_exception';
    END IF;

    -- A NON-AUTHOR MAY CHANGE MODERATION STATE AND ACCEPTANCE, NEVER THE TEXT.
    IF app_current_actor() IS NOT NULL
       AND NEW.author_id <> app_current_actor()
       AND NEW.content_markdown IS DISTINCT FROM OLD.content_markdown THEN
      RAISE EXCEPTION 'A moderator may change moderation status and acceptance, and nothing else'
        USING ERRCODE = 'raise_exception';
    END IF;

    -- ACCEPTING AN ANSWER IS THE QUESTIONER'S CALL, OR STAFF'S. Never the
    -- answerer's: a learner marking their own reply accepted is not an answer
    -- being accepted, it is a self-assigned badge.
    IF NEW.is_accepted_answer AND NOT OLD.is_accepted_answer
       AND app_current_actor() IS NOT NULL
       AND NOT app_actor_owns_thread(NEW.thread_id)
       AND NOT app_actor_moderates_class(NEW.class_id, app_class_organization(NEW.class_id))
    THEN
      RAISE EXCEPTION 'Only the person who asked, or staff, may accept an answer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
  END IF;

  -- The class comes from the thread, never from the caller.
  SELECT t.class_id INTO NEW.class_id FROM discussion_threads t WHERE t.id = NEW.thread_id;
  IF NEW.class_id IS NULL THEN
    RAISE EXCEPTION 'That thread does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.created_at := now();
  NEW.updated_at := now();
  NEW.is_accepted_answer := false;

  IF NEW.parent_reply_id IS NOT NULL THEN
    WITH RECURSIVE ancestry AS (
      SELECT r.id, r.parent_reply_id, 1 AS depth
        FROM discussion_replies r WHERE r.id = NEW.parent_reply_id
      UNION ALL
      SELECT r.id, r.parent_reply_id, a.depth + 1
        FROM discussion_replies r JOIN ancestry a ON r.id = a.parent_reply_id
       WHERE a.depth < 32
    )
    SELECT max(depth) INTO v_depth FROM ancestry;

    IF coalesce(v_depth, 0) >= 8 THEN
      RAISE EXCEPTION 'Replies cannot be nested more than eight deep'
        USING ERRCODE = 'program_limit_exceeded';
    END IF;
  END IF;

  IF app_current_actor() IS NULL THEN RETURN NEW; END IF;

  IF NOT app_actor_in_class_forum(NEW.class_id) THEN
    RAISE EXCEPTION 'You can only post in a class you are in'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER discussion_replies_guard
  BEFORE INSERT OR UPDATE ON discussion_replies
  FOR EACH ROW EXECUTE FUNCTION discussion_reply_guard();

/**
 * Derives a flag's thread and organization from the entity it reports.
 *
 * A CALLER WHO COULD CHOOSE `thread_id` COULD FILE A REPORT ABOUT THEIR OWN
 * CLASS'S POST INTO ANOTHER SCHOOL'S MODERATION QUEUE — which is both a leak
 * (the queue shows the reported text) and a way to waste another school's
 * staff time. So it is derived here from `entity_id`, and the entity must exist.
 */
CREATE FUNCTION content_flag_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_thread uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.entity_type = 'thread' THEN
      SELECT t.id INTO v_thread FROM discussion_threads t WHERE t.id = NEW.entity_id;
    ELSE
      SELECT r.thread_id INTO v_thread FROM discussion_replies r WHERE r.id = NEW.entity_id;
    END IF;

    IF v_thread IS NULL THEN
      RAISE EXCEPTION 'That post does not exist' USING ERRCODE = 'foreign_key_violation';
    END IF;

    NEW.thread_id := v_thread;
    SELECT t.organization_id INTO NEW.organization_id
      FROM discussion_threads t WHERE t.id = v_thread;
    NEW.created_at := now();

    IF app_current_actor() IS NOT NULL AND NEW.raised_by = 'member' THEN
      NEW.reporter_id := app_current_actor();
    END IF;

    RETURN NEW;
  END IF;

  -- On review, the closer and the clock are the server's to set.
  IF NEW.status <> 'pending' AND OLD.status = 'pending' THEN
    NEW.reviewed_at := now();
    NEW.reviewed_by := app_current_actor();
  END IF;

  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.reporter_id IS DISTINCT FROM OLD.reporter_id
     OR NEW.thread_id IS DISTINCT FROM OLD.thread_id THEN
    RAISE EXCEPTION 'A flag''s subject and reporter are immutable'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER content_flags_guard
  BEFORE INSERT OR UPDATE ON content_flags
  FOR EACH ROW EXECUTE FUNCTION content_flag_guard();

/**
 * Removes a deleted reply's flags.
 *
 * A TRIGGER IS A WORSE TOOL THAN A FOREIGN KEY AND IS USED HERE ONLY BECAUSE
 * THE POLYMORPHIC SHAPE LEAVES NO BETTER ONE. `content_flags.thread_id` is a
 * real foreign key and covers thread deletion; nothing can cover the reply case
 * without a second real column, which would be a second copy of the same
 * pointer and free to disagree with the first.
 *
 * AFTER DELETE rather than BEFORE, so that a delete refused by a policy leaves
 * the flags alone.
 *
 * SECURITY DEFINER, AND THE PROBE IS WHY. Written first as invoker-rights, it
 * ran as `edu_app` — which deliberately has no DELETE grant on `content_flags`,
 * because a moderation record that can be deleted is not a record. So the
 * trigger raised `permission denied` and took the whole statement with it, and
 * the consequence was not a dangling flag. It was this:
 *
 *   ANY LEARNER COULD MAKE A CLASSMATE'S REPLY PERMANENTLY UNDELETABLE BY
 *   REPORTING IT.
 *
 * Report the post, and its author can never remove it again. On a forum for
 * children that is not an integrity bug, it is a harassment primitive — the
 * reporting system turned into a way to pin somebody's words in place against
 * their will, which is close to the opposite of what reporting is for.
 *
 * `content_flags_definer_delete` below grants the definer role the DELETE that
 * FORCE ROW LEVEL SECURITY would otherwise bind. That policy was already
 * written when the probe found this; the policy without the DEFINER was inert,
 * which is its own lesson about half-finished thoughts in a migration.
 *
 * NOTE FOR THE CATALOG TEST. `tests/integration/rls-definer-coverage.test.ts`
 * checks that every SECURITY DEFINER function has a policy for what it does.
 * This bug was the mirror image — an INVOKER-rights function writing to a table
 * the invoking role has no grant on — and that test could not have caught it.
 * The gap is recorded in the Task 014 report rather than papered over.
 */
CREATE FUNCTION content_flag_reply_cleanup() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM content_flags WHERE entity_type = 'reply' AND entity_id = OLD.id;
  RETURN OLD;
END
$$;

CREATE TRIGGER discussion_replies_flag_cleanup
  AFTER DELETE ON discussion_replies
  FOR EACH ROW EXECUTE FUNCTION content_flag_reply_cleanup();

-- ── ROW-LEVEL SECURITY ──────────────────────────────────────────────────────

/**
 * A thread is visible to the room it was posted in — and a non-approved one is
 * visible only to its author and to staff.
 *
 * THE THREE BRANCHES ARE ORDERED BY HOW MUCH THEY ADMIT, narrowest first, so a
 * reader can stop at the one that applies:
 *
 *   1. THE AUTHOR, at any moderation status. Their own text, including the
 *      version a reviewer hid. See the header for why silence would be worse.
 *   2. THE ROOM, approved posts only. This is the ordinary case and the one
 *      section 3 constrains: "flagged or hidden posts must be excluded from
 *      student queries by default".
 *   3. STAFF, at any status, which is what makes a moderation queue possible.
 */
CREATE POLICY discussion_threads_select ON discussion_threads FOR SELECT TO edu_app
  USING (
    author_id = app_current_actor()
    OR (moderation_status = 'approved' AND app_actor_in_class_forum(class_id))
    OR app_actor_moderates_class(class_id, organization_id)
  );

CREATE POLICY discussion_threads_insert ON discussion_threads FOR INSERT TO edu_app
  WITH CHECK (
    author_id = app_current_actor()
    AND app_actor_in_class_forum(class_id)
    -- A NEW THREAD CANNOT BE BORN HIDDEN OR PINNED BY ITS AUTHOR. 'flagged' is
    -- permitted because the automated filter sets it on the way in; a learner
    -- who forges it only makes their own post invisible, which is a choice they
    -- are entitled to make about their own words.
    AND moderation_status IN ('approved', 'flagged')
    AND NOT is_pinned
    AND NOT is_locked
  );

/**
 * The author edits their own, while the thread is unlocked and not hidden.
 *
 * Section 2C: "Authors can UPDATE/DELETE their own posts ONLY IF the thread is
 * NOT locked and the post is NOT hidden by moderation." Both conditions are
 * here in `USING`, so a locked or hidden thread simply matches no row for its
 * author — no error, no edit.
 *
 * THE `WITH CHECK` HALF MATTERS AS MUCH AS THE `USING` HALF. Without it an
 * author could update their row into somebody else's, or into a locked state,
 * passing on the way in and landing outside their own reach. The columns a
 * moderator owns — `is_pinned`, `is_locked`, `moderation_status` — are pinned
 * to their old values here, which is what stops an author unlocking their own
 * thread and then editing it.
 */
CREATE POLICY discussion_threads_update_own ON discussion_threads FOR UPDATE TO edu_app
  USING (
    author_id = app_current_actor()
    AND NOT is_locked
    AND moderation_status <> 'hidden'
    AND app_actor_in_class_forum(class_id)
  )
  WITH CHECK (
    author_id = app_current_actor()
    AND NOT is_locked
    AND NOT is_pinned
    AND moderation_status <> 'hidden'
  );

/**
 * Staff pin, lock, hide and approve. A second UPDATE policy rather than a
 * branch in the first, because PostgreSQL ORs permissive policies and the
 * column-level rule — that a moderator changes four columns and no more — is
 * enforced by `discussion_thread_moderation_guard`, which a policy cannot do.
 */
CREATE POLICY discussion_threads_moderate ON discussion_threads FOR UPDATE TO edu_app
  USING (app_actor_moderates_class(class_id, organization_id))
  WITH CHECK (app_actor_moderates_class(class_id, organization_id));

CREATE POLICY discussion_threads_delete_own ON discussion_threads FOR DELETE TO edu_app
  USING (
    author_id = app_current_actor()
    AND NOT is_locked
    AND moderation_status <> 'hidden'
  );

/**
 * Staff delete too — but note what this is FOR. Hiding is the ordinary
 * moderation action and it preserves the record; deletion is for content that
 * must not persist at all. A moderator reaching for delete where hide would do
 * destroys the evidence of what they acted on.
 */
CREATE POLICY discussion_threads_delete_moderator ON discussion_threads FOR DELETE TO edu_app
  USING (app_actor_moderates_class(class_id, organization_id));

/**
 * A reply is visible when its thread is, and its own moderation status permits.
 *
 * DELEGATION RATHER THAN MIRRORING — the ADR 0010 rule. The `EXISTS` runs under
 * the caller's own RLS, so the reply policy INHERITS the thread policy instead
 * of restating its three branches. Restating them would create a second surface
 * free to drift from the first, and the drift would be invisible because both
 * would keep returning rows.
 *
 * The moderation half is the reply's own, because a reply can be hidden while
 * its thread is fine.
 */
CREATE POLICY discussion_replies_select ON discussion_replies FOR SELECT TO edu_app
  USING (
    EXISTS (SELECT 1 FROM discussion_threads t WHERE t.id = discussion_replies.thread_id)
    AND (
      author_id = app_current_actor()
      OR moderation_status = 'approved'
      OR app_actor_moderates_class(class_id, app_class_organization(class_id))
    )
  );

/**
 * THE LOCKED-THREAD ENFORCER. Section 3 requires that a locked thread reject
 * new replies "regardless of API routes", so it is here, in the WITH CHECK,
 * evaluated by PostgreSQL against the thread row at write time.
 *
 * The `EXISTS` is invoker-rights: a caller who cannot see the thread cannot
 * satisfy it either. See the file header for why a definer helper would be the
 * VULN-040 mistake.
 */
CREATE POLICY discussion_replies_insert ON discussion_replies FOR INSERT TO edu_app
  WITH CHECK (
    author_id = app_current_actor()
    AND app_actor_in_class_forum(class_id)
    AND moderation_status IN ('approved', 'flagged')
    AND NOT is_accepted_answer
    AND EXISTS (
          SELECT 1 FROM discussion_threads t
           WHERE t.id = discussion_replies.thread_id
             AND NOT t.is_locked
             AND t.moderation_status <> 'hidden'
        )
  );

/**
 * The author edits their own reply — unless the thread is locked, or the reply
 * is hidden. `is_accepted_answer` is pinned to its old value here, so an author
 * cannot accept their own answer through this policy; the guard refuses it a
 * second time for the moderation path.
 */
CREATE POLICY discussion_replies_update_own ON discussion_replies FOR UPDATE TO edu_app
  USING (
    author_id = app_current_actor()
    AND moderation_status <> 'hidden'
    AND app_actor_in_class_forum(class_id)
    AND EXISTS (
          SELECT 1 FROM discussion_threads t
           WHERE t.id = discussion_replies.thread_id AND NOT t.is_locked
        )
  )
  WITH CHECK (
    author_id = app_current_actor()
    AND moderation_status <> 'hidden'
    AND NOT is_accepted_answer
  );

/**
 * The questioner accepts an answer. A separate policy because the actor is not
 * the row's author and not necessarily staff — it is the person who opened the
 * thread, which is a relationship no other domain here has.
 *
 * The guard checks it again on the way through, because this policy admits the
 * ROW and the guard is what limits the change to `is_accepted_answer`.
 */
CREATE POLICY discussion_replies_accept ON discussion_replies FOR UPDATE TO edu_app
  USING (app_actor_owns_thread(thread_id) AND app_actor_in_class_forum(class_id))
  WITH CHECK (app_actor_owns_thread(thread_id) AND app_actor_in_class_forum(class_id));

CREATE POLICY discussion_replies_moderate ON discussion_replies FOR UPDATE TO edu_app
  USING (app_actor_moderates_class(class_id, app_class_organization(class_id)))
  WITH CHECK (app_actor_moderates_class(class_id, app_class_organization(class_id)));

CREATE POLICY discussion_replies_delete_own ON discussion_replies FOR DELETE TO edu_app
  USING (
    author_id = app_current_actor()
    AND moderation_status <> 'hidden'
    AND EXISTS (
          SELECT 1 FROM discussion_threads t
           WHERE t.id = discussion_replies.thread_id AND NOT t.is_locked
        )
  );

CREATE POLICY discussion_replies_delete_moderator ON discussion_replies FOR DELETE TO edu_app
  USING (app_actor_moderates_class(class_id, app_class_organization(class_id)));

/**
 * A flag is visible to the person who raised it and to the staff who work it.
 *
 * NOT TO THE REPORTED AUTHOR, and that is the one branch whose absence is
 * deliberate. Telling a child who reported them turns a reporting system into a
 * targeting system: the next thing that happens is retaliation, and the child
 * who reported the bullying stops reporting it. The author learns their post
 * was actioned — the moderation status is visible to them — and not by whom.
 */
CREATE POLICY content_flags_select ON content_flags FOR SELECT TO edu_app
  USING (
    (reporter_id IS NOT NULL AND reporter_id = app_current_actor())
    OR app_actor_moderates_class(
         (SELECT t.class_id FROM discussion_threads t WHERE t.id = content_flags.thread_id),
         organization_id)
  );

/**
 * Anyone in the room may report a post in it.
 *
 * `app_actor_in_class_forum` on the flag's own derived thread is what stops a
 * learner filing reports into a class they are not in. `reporter_id` is set by
 * the guard from the session, so the column here can only be the caller.
 */
CREATE POLICY content_flags_insert ON content_flags FOR INSERT TO edu_app
  WITH CHECK (
    raised_by = 'member'
    AND status = 'pending'
    AND EXISTS (SELECT 1 FROM discussion_threads t WHERE t.id = content_flags.thread_id)
  );

/**
 * Only staff close a flag. A reporter cannot withdraw one, which is deliberate:
 * a report that can be retracted can be retracted under pressure, and the
 * moderation record is the thing that survives the pressure.
 */
CREATE POLICY content_flags_review ON content_flags FOR UPDATE TO edu_app
  USING (app_actor_moderates_class(
           (SELECT t.class_id FROM discussion_threads t WHERE t.id = content_flags.thread_id),
           organization_id))
  WITH CHECK (app_actor_moderates_class(
           (SELECT t.class_id FROM discussion_threads t WHERE t.id = content_flags.thread_id),
           organization_id));

-- No DELETE policy and no DELETE grant on `content_flags`. A moderation record
-- that can be deleted is not a record. Flags disappear only with the thread
-- they concern, through the foreign key, or with the reply, through the
-- cleanup trigger.

/**
 * THE DEFINER-ROLE READ POLICIES.
 *
 * `FORCE ROW LEVEL SECURITY` binds the table OWNER too, a SECURITY DEFINER
 * function runs AS the owner, and every other policy here is `TO edu_app` — so
 * without these, `app_actor_owns_thread` answers false for every thread and
 * `discussion_reply_guard` cannot read the thread it derives `class_id` from.
 *
 * MIGRATION 0014 WROTE THIS RULE DOWN AND IT HAS BEEN MISSED THREE TIMES —
 * VULN-044, VULN-050, and `app_project_is_publicly_listed` in Task 013. Since
 * Task 013 it is derived from the catalog by
 * `tests/integration/rls-definer-coverage.test.ts`, which enumerates every
 * FORCE-RLS table a definer function touches and asserts a policy exists for
 * the command it performs. This is the first migration written with that test
 * in place; if these two lines were missing it would say so by name.
 *
 * Read-only, and only for the role no request ever runs as.
 */
CREATE POLICY discussion_threads_definer_select ON discussion_threads
  FOR SELECT TO edu_migrator USING (true);
CREATE POLICY discussion_replies_definer_select ON discussion_replies
  FOR SELECT TO edu_migrator USING (true);
-- The cleanup trigger deletes from `content_flags` as the definer.
CREATE POLICY content_flags_definer_select ON content_flags
  FOR SELECT TO edu_migrator USING (true);
CREATE POLICY content_flags_definer_delete ON content_flags
  FOR DELETE TO edu_migrator USING (true);

-- ── PERMISSIONS ─────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION app_actor_in_class_forum(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_moderates_class(uuid, uuid)   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_owns_thread(uuid)             FROM PUBLIC;
REVOKE ALL ON FUNCTION discussion_thread_guard()               FROM PUBLIC;
REVOKE ALL ON FUNCTION discussion_thread_moderation_guard()    FROM PUBLIC;
REVOKE ALL ON FUNCTION discussion_reply_guard()                FROM PUBLIC;
REVOKE ALL ON FUNCTION content_flag_guard()                    FROM PUBLIC;
REVOKE ALL ON FUNCTION content_flag_reply_cleanup()            FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_actor_in_class_forum(uuid)        TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_moderates_class(uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_owns_thread(uuid)           TO edu_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON discussion_threads TO edu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON discussion_replies TO edu_app;
-- No DELETE. See the comment above `content_flags_review`.
GRANT SELECT, INSERT, UPDATE ON content_flags TO edu_app;

COMMENT ON TABLE discussion_threads IS
  'Class forum threads. The room is the class; a thread cannot exist without one.';
COMMENT ON TABLE discussion_replies IS
  'Replies, nested. A composite foreign key makes cross-thread nesting impossible.';
COMMENT ON TABLE content_flags IS
  'Reports about posts. Polymorphic by specification; `thread_id` is the real key.';
COMMENT ON COLUMN discussion_threads.is_locked IS
  'Enforced in the reply INSERT policy, not only in the API. See migration header.';
COMMENT ON COLUMN discussion_replies.parent_reply_id IS
  'Bound to the same thread by a composite foreign key. See migration header.';

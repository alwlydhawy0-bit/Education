-- ============================================================================
-- 0027 — AI TUTOR CONVERSATIONS AND MESSAGES (Task 012)
-- ============================================================================
--
-- Two tables holding something this platform has never stored before: an
-- unfiltered record of what a child said to a machine while trying to
-- understand their coursework.
--
-- That is worth pausing on, because it decides most of what follows. A
-- conversation transcript is closer to `notes` (Task 010 — a minor's private
-- writing) than to `lesson_progress` (a fact the platform computed about them).
-- But unlike a note, it is BOTH private AND subject to safety moderation: the
-- whole reason an adult may read it is that a child talking to an AI is a
-- situation where somebody responsible needs to be able to look.
--
-- So the model here is not "private like a note" and not "visible like a
-- grade". It is: the learner owns it, a NAMED and NARROW set of adults may read
-- it for safety, nobody may edit it, and nothing crosses a school boundary.
--
-- ----------------------------------------------------------------------------
-- WHY A CONVERSATION IS ANCHORED TO A LESSON, AND THE COURSE IS DERIVED
-- ----------------------------------------------------------------------------
--
-- Section 2A names both `course_id` and `lesson_id`. Both are stored, but only
-- ONE is accepted from a caller: `lesson_id`. The course is resolved from the
-- lesson by a trigger, exactly as 0026 resolves a chunk's ancestry.
--
-- Two ids supplied independently are two answers to "what is this conversation
-- about", and they can disagree. A caller that sent a lesson from course A and
-- named course B would be asserting a scope the lesson does not have, and every
-- check downstream would then have to decide which of the two it trusted. One
-- accepted id and one derived id cannot disagree.
--
-- The scope question is then a single call to `app_actor_may_study_lesson`,
-- which is the function Task 006 already wrote for exactly this: published
-- lesson, published unit, published course, active assignment, active class,
-- ACTIVE MEMBERSHIP. Section 2C's "only for lessons/courses currently assigned
-- to their active class" is that function, unchanged and undiluted.
--
-- ----------------------------------------------------------------------------
-- WHY `organization_id` IS DENORMALIZED HERE
-- ----------------------------------------------------------------------------
--
-- The moderation policy has to ask "is this conversation in MY school?". The
-- honest way to answer is to join `users` on `student_id` — but `users` is
-- itself RLS-protected, and a policy that reads it recursively evaluates
-- another policy. `notes.organization_id` exists for precisely this reason and
-- the migration that added it says so.
--
-- The difference from `notes` is that here the column is NOT copied from the
-- writer's profile: it is derived from the COURSE, by the same trigger that
-- derives the course. A conversation about School A's biology course belongs to
-- School A even if the learner's own record were later moved, which is the
-- behaviour a moderation boundary should have. It also means the value cannot
-- drift from the thing it describes, because it is recomputed from that thing.
--
-- ----------------------------------------------------------------------------
-- WHY MESSAGES ARE APPEND-ONLY, AND WHY A TUTOR TURN NEEDS A FUNCTION
-- ----------------------------------------------------------------------------
--
-- There is no UPDATE and no DELETE on `ai_messages` — no grant, no policy, no
-- route. A transcript that can be edited after the fact is not a moderation
-- record; it is a draft. If a message must be withdrawn, the CONVERSATION is
-- archived and the reason lives in the audit trail.
--
-- The sharper problem is FORGERY, and it is specific to this domain. Everywhere
-- else on this platform, the rows a learner writes are rows a learner is
-- entitled to author. Here, two of the three sender types are the PLATFORM
-- speaking, and both are written during a request whose database session is the
-- learner's own. RLS cannot distinguish "the server recorded the model's reply"
-- from "the learner posted a message claiming to be the model" — the session is
-- identical.
--
-- Left alone, that would let a child fabricate a transcript in which the school
-- assistant told them something it never said. Against a homework dispute, a
-- safeguarding review, or a parent, a forged transcript is a serious thing.
--
-- The answer has two halves, and they are enforced by different mechanisms
-- because they are different questions.
--
-- OWNERSHIP is a COMPOSITE FOREIGN KEY: `ai_messages (conversation_id,
-- owner_id)` references `ai_conversations (id, student_id)`. A message may only
-- claim an owner that is genuinely that conversation's owner, and referential
-- integrity enforces it beneath RLS, beneath SECURITY DEFINER, and beneath any
-- question about which role is executing. The first draft of this migration
-- asked a SECURITY DEFINER helper instead, and the adversarial probe proved in
-- one line that it could not work — the helper runs as the table owner, FORCE
-- RLS subjects the owner to policies, every policy is `TO edu_app`, so it
-- answered NULL for every conversation on the platform. That is VULN-044,
-- rediscovered by the person who wrote VULN-044. The composite key is the fix
-- Task 010 landed on for the same reason, and it is used here for the same one.
--
-- SENDER TYPE cannot be decided by identity at all, and it is worth saying so
-- plainly rather than dressing it up: the learner's turn and the tutor's reply
-- are written in the same request, by the same session, as the same actor. The
-- database can only tell them apart by WHICH PATH wrote them. So one named
-- function sets a transaction-local marker, and the policy admits a non-student
-- turn only into the conversation that marker names.
--
-- That stops a forged tutor turn through the ordinary insert path and through
-- any future insert written by somebody who has not read this comment. It does
-- not stop code that deliberately calls the marker first — nothing at this
-- layer could. The other half of the defence is that the request contract has
-- no `senderType` field, and a fitness function asserts the marker has exactly
-- one call site.
-- ============================================================================

-- ── CONVERSATIONS ───────────────────────────────────────────────────────────

CREATE TABLE ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Derived from the course by `ai_conversation_scope_guard`. Never accepted
  -- from a caller; see the header.
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id       uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_conversations_status_ck CHECK (status IN ('active', 'archived')),
  CONSTRAINT ai_conversations_title_ck
    CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  -- THE TARGET OF THE COMPOSITE FOREIGN KEY ON `ai_messages`. Redundant as a
  -- uniqueness statement — `id` is already the primary key — and load-bearing
  -- as a REFERENCE: PostgreSQL will only point a foreign key at a unique
  -- constraint, and this is the one that lets a message say "my conversation is
  -- this one AND its owner is that person" as a single enforced fact. See the
  -- header section on forgery.
  CONSTRAINT ai_conversations_id_owner_uk UNIQUE (id, student_id)
);

-- The history query: one learner's conversations, newest first.
CREATE INDEX ai_conversations_student_ix
  ON ai_conversations (student_id, status, updated_at DESC);

-- The moderation query: one school's conversations, newest first. Separate from
-- the index above because a moderator filters by organization and never by
-- student, so the leading column has to differ.
CREATE INDEX ai_conversations_moderation_ix
  ON ai_conversations (organization_id, updated_at DESC);

-- The lesson-scoped lookup, used to resume rather than duplicate.
CREATE INDEX ai_conversations_lesson_ix ON ai_conversations (lesson_id, student_id);

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations FORCE ROW LEVEL SECURITY;

-- ── MESSAGES ────────────────────────────────────────────────────────────────

CREATE TABLE ai_messages (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id               uuid NOT NULL,
  -- DENORMALIZED, AND ENFORCED BY THE COMPOSITE FOREIGN KEY BELOW rather than
  -- trusted. It cannot drift from the conversation's `student_id`, because a
  -- row whose pair does not match a parent pair is rejected by referential
  -- integrity — which runs beneath RLS, beneath SECURITY DEFINER, and beneath
  -- every question about who is executing the statement.
  --
  -- That last property is the entire reason this column exists rather than a
  -- helper function. See the header.
  owner_id                      uuid NOT NULL,
  -- Monotonic within a conversation, assigned by the database rather than by a
  -- caller. Ordering a transcript by `created_at` alone is wrong the moment two
  -- rows share a millisecond, and a transcript in the wrong order is a
  -- different transcript.
  seq                           integer NOT NULL,
  sender_type                   text NOT NULL,
  content_text                  text NOT NULL,
  -- What the tutor was actually shown. Ids and labels of the retrieved chunks,
  -- never the chunk bodies: the bodies are curriculum and live in `lessons`,
  -- and copying them here would make this table a second, unmaintained copy of
  -- the very content 0026 went to some trouble to avoid duplicating.
  retrieved_context_chunks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_count                   integer NOT NULL DEFAULT 0,
  latency_ms                    integer,
  -- Set when the guardrail layer refused or altered a turn. Section 2E requires
  -- an intercepted jailbreak to be LOGGED, and the audit trail records that it
  -- happened; this records which turn it happened on, so a moderator reading a
  -- transcript can see the refusal in place rather than having to correlate.
  guardrail_verdict             text,
  created_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_messages_sender_ck
    CHECK (sender_type IN ('student', 'system', 'ai_tutor')),
  CONSTRAINT ai_messages_seq_ck CHECK (seq >= 1),
  CONSTRAINT ai_messages_token_ck CHECK (token_count >= 0),
  CONSTRAINT ai_messages_latency_ck CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT ai_messages_content_ck CHECK (length(content_text) <= 20000),
  CONSTRAINT ai_messages_verdict_ck
    CHECK (guardrail_verdict IS NULL
           OR guardrail_verdict IN ('blocked_injection', 'blocked_answer_seeking',
                                    'out_of_scope', 'truncated')),
  -- Section 2A's "unique constraints for fast conversation history retrieval".
  -- It is also what makes `seq` mean something: without it, two concurrent
  -- writes could both claim turn 4 and the transcript would silently have two.
  CONSTRAINT ai_messages_seq_uk UNIQUE (conversation_id, seq),
  -- "This message belongs to that conversation, AND that conversation belongs
  -- to this person" — as ONE fact the database enforces, not two the
  -- application coordinates.
  CONSTRAINT ai_messages_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_id)
    REFERENCES ai_conversations (id, student_id) ON DELETE CASCADE
);

-- The transcript read, in order, in one index scan.
CREATE INDEX ai_messages_history_ix ON ai_messages (conversation_id, seq);

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages FORCE ROW LEVEL SECURITY;

-- ── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Whether the current actor may READ a conversation for safety moderation.
 *
 * SECTION 2C SAYS "TEACHERS & ADMINS ... WITHIN THEIR ORGANIZATION BOUNDARY",
 * and this function reads that as a CEILING rather than as a grant. The
 * organization is the outer bound nobody crosses. Inside it, the authority is
 * the one this platform already recognises everywhere else, because inventing a
 * wider one here — where the data is a child's unfiltered conversation — would
 * be the wrong place to start being generous:
 *
 *   - A TEACHER reads the conversations of learners they actually teach, on
 *     lessons they actually teach. That is `app_actor_observes_learner_lesson`,
 *     the same function that decides whether they may see that learner's
 *     progress. A teacher does not acquire a new power here; the AI transcript
 *     is simply inside the boundary that already contained the child's work.
 *
 *   - An ORGANIZATION ADMIN reads any conversation in their own school. They
 *     already administer every class and roster in it.
 *
 *   - A MODERATOR reads any conversation in their own school. This is the role
 *     the platform reserved for exactly this and never used; safety review of
 *     children's AI conversations is what it is for.
 *
 * A GUARDIAN IS DELIBERATELY ABSENT, and that is the hardest call in this file.
 * A guardian may read their own child's notes-shared-with-them and their
 * progress, so extending the same reach to AI transcripts would look
 * consistent. It is not, for one reason: a child who believes a parent is
 * reading their questions asks different questions, and the questions a child
 * is least willing to ask in front of a parent are sometimes the ones that most
 * need answering. Building the pipe first and deciding the policy later would
 * mean the policy was never really decided, so there is no branch here.
 * `docs/security/limitations.md` records this as an open decision rather than a
 * settled one.
 *
 * SECURITY DEFINER, and every function it calls is too — so this is composition
 * of definer-rights helpers, not a definer wrapper around an invoker-rights one.
 * That distinction is VULN-040: wrapping `app_actor_sees_experiment` in a
 * definer turned an authorization check into a lookup and made every lab in the
 * country visible. Nothing here is invoker-rights, so nothing here inherits the
 * caller's RLS and then silently stops doing so.
 */
CREATE FUNCTION app_actor_moderates_conversation(
  p_student_id      uuid,
  p_organization_id uuid,
  p_lesson_id       uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT
    -- Never null-org, and never another school's. Written first and separately
    -- so that the tenancy check cannot be lost inside a longer disjunction: a
    -- conversation with a NULL organization (which the trigger cannot produce,
    -- but a future global course could) is readable by nobody but its owner.
    p_organization_id IS NOT NULL
    AND p_organization_id = app_actor_organization()
    AND (
         app_actor_observes_learner_lesson(p_student_id, p_lesson_id)
      OR app_actor_is_org_admin()
      OR app_actor_holds_role('moderator')
    );
$$;

/**
 * Whether the current actor may see a conversation at all — owner or moderator.
 *
 * `ai_messages` DELEGATES TO THIS rather than restating it. Two policies that
 * both describe "who may read this conversation" are two things that can drift
 * apart, and the drift would be invisible because both would keep returning
 * rows. ADR 0010 made the same choice for `curriculum_embeddings`, which asks
 * `app_actor_sees_lesson` instead of mirroring the curriculum's rules.
 *
 * INVOKER RIGHTS, deliberately. It reads `ai_conversations`, whose own RLS
 * policy already answers this question, so running it as the caller means the
 * message policy inherits the conversation policy instead of re-deriving it.
 * Making this SECURITY DEFINER would be the VULN-040 mistake exactly: the row
 * would become visible to the function regardless of the caller, and the
 * `EXISTS` would degrade from an authorization check into a "does this id
 * exist" lookup — which is true for every conversation on the platform.
 */
CREATE FUNCTION app_actor_sees_conversation(p_conversation_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = p_conversation_id);
$$;

/**
 * Marks the current transaction as recording a PLATFORM turn.
 *
 * THIS IS THE NAMED DOOR, and it is worth being exact about what it is and is
 * not, because the first version of this migration got it wrong in an
 * instructive way.
 *
 * The first version was a SECURITY DEFINER function that looked up the
 * conversation's owner and inserted on the caller's behalf. It could not work,
 * and the adversarial probe showed why in one line: a definer function runs as
 * the table's owner, `FORCE ROW LEVEL SECURITY` subjects the owner to policies
 * too, and every policy here is `TO edu_app` — so the lookup matched no policy,
 * saw no rows, and answered NULL for every conversation in the database. That
 * is VULN-044 exactly, rediscovered eleven migrations later by somebody who had
 * written the entry. A lesson that has to be remembered is not a control.
 *
 * So ownership is no longer a lookup at all. It is the composite foreign key on
 * `ai_messages`, which referential integrity enforces beneath RLS, beneath
 * definer rights, and beneath any question about who is executing — the one
 * layer where "this conversation belongs to this person" cannot be answered
 * wrongly by a privilege subtlety.
 *
 * WHAT REMAINS FOR THIS FUNCTION is only the sender_type gate, and no database
 * mechanism can do that one by identity: a learner's turn and the tutor's reply
 * are written in the same request, by the same session, as the same actor. The
 * database genuinely cannot tell them apart by WHO — only by WHICH PATH. So the
 * path sets a transaction-local marker naming the conversation it is writing
 * to, and the policy admits a non-student turn only for that conversation.
 *
 * BE HONEST ABOUT THE STRENGTH OF THIS. It stops a forged tutor message
 * arriving through the ordinary insert path, and it stops one arriving through
 * any future insert written by somebody who has not read this comment — which
 * is the realistic failure. It does not stop code that deliberately calls this
 * function first; nothing at this layer could. The application-side half is
 * that the request contract has no `senderType` field at all, and a fitness
 * function asserts this marker has exactly one call site.
 *
 * `set_config(..., true)` is TRANSACTION-LOCAL. It cannot leak into the next
 * statement on a pooled connection, which a session-level setting would.
 */
CREATE FUNCTION ai_begin_platform_turn(p_conversation_id uuid) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = pg_catalog, public
AS $$
  SELECT set_config('ai.platform_turn', p_conversation_id::text, true);
$$;

-- ── TRIGGERS ────────────────────────────────────────────────────────────────

/**
 * Derives the course and the organization from the lesson, and refuses a
 * conversation about a lesson the actor is not currently studying.
 *
 * THE SCOPE CHECK IS HERE AS WELL AS IN THE RLS POLICY, and that is deliberate
 * redundancy of the kind VULN-049 warns about being untestable — so the
 * layered-defence suite disables this trigger and asserts the policy refuses on
 * its own, and the RLS suite asserts the trigger refuses when the policy would
 * have admitted. Each is checked without the other.
 *
 * THE NULL-ACTOR EARLY RETURN IS NOT AN ESCAPE HATCH. Migrations, fixtures and
 * maintenance run with no `app.actor_id` set, and asking "may the current actor
 * study this lesson" of a caller who is not an actor is a question with no true
 * answer — VULN-045, where a note-anchor trigger asked exactly that of every
 * writer and broke every backfill. RLS still applies to `edu_app`; a superuser
 * seeding a fixture is already outside every gate and this changes nothing
 * about that.
 */
CREATE FUNCTION ai_conversation_scope_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE
  v_course uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The anchor is IMMUTABLE. Letting a conversation be re-pointed at another
    -- lesson would let a learner start one where they are entitled to and then
    -- move it somewhere they are not, carrying the transcript across a boundary
    -- the insert check had already enforced.
    IF NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.lesson_id IS DISTINCT FROM OLD.lesson_id
       OR NEW.course_id IS DISTINCT FROM OLD.course_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A conversation''s owner, anchor and origin are immutable'
        USING ERRCODE = 'raise_exception';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  SELECT u.course_id INTO v_course
    FROM lessons l JOIN course_units u ON u.id = l.unit_id
   WHERE l.id = NEW.lesson_id;
  IF v_course IS NULL THEN
    RAISE EXCEPTION 'Unknown lesson' USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.course_id       := v_course;
  NEW.organization_id := app_course_organization(v_course);
  NEW.created_at      := now();
  NEW.updated_at      := now();

  IF app_current_actor() IS NULL THEN RETURN NEW; END IF;

  IF NOT app_actor_may_study_lesson(NEW.lesson_id) THEN
    RAISE EXCEPTION 'You cannot start a tutor conversation about coursework you are not studying'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER ai_conversations_scope
  BEFORE INSERT OR UPDATE ON ai_conversations
  FOR EACH ROW EXECUTE FUNCTION ai_conversation_scope_guard();

/**
 * Refuses a message that is not the actor's, THEN assigns its position.
 *
 * THE ORDER OF THOSE TWO IS A SECURITY PROPERTY, and the adversarial probe is
 * what showed it. The first version only assigned `seq`, computed as
 * `max(seq) + 1` over `ai_messages` — which is read under the CALLER'S row
 * security. A stranger inserting into somebody else's conversation therefore
 * saw no rows, computed `seq = 1`, and collided with the existing turn 1:
 *
 *   ERROR: duplicate key value violates constraint "ai_messages_seq_uk"
 *
 * The write was refused, so nothing leaked into the table — but the REFUSAL
 * ITSELF leaked. "Duplicate key" means the conversation already has a first
 * message; a row-security refusal means it does not. Any authenticated user
 * holding a conversation id could tell an empty conversation from a used one,
 * in another class or another school, by reading which error came back. That is
 * a small oracle, and small oracles are how you enumerate a platform.
 *
 * So ownership is checked here, first, as a PURE COMPARISON — no table read, so
 * nothing to be visible or invisible, so nothing to infer. Every unauthorized
 * insert now fails identically and before `seq` is ever computed, and the
 * duplicate-key error goes back to meaning the one thing it should: two of the
 * owner's own turns raced, and one must retry.
 *
 * The comparison is safe to trust because the composite foreign key has already
 * made `owner_id` un-forgeable; this trigger is not re-deriving ownership, it is
 * refusing early so that the refusal says the same thing to everybody.
 */
CREATE FUNCTION ai_message_sequence_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_current_actor() IS NOT NULL THEN
    -- TWO CHECKS, because they catch different lies and the first one alone
    -- was not enough — the probe proved it. A forged `owner_id` is caught by
    -- the pure comparison; a HONEST owner_id pointing at somebody else's
    -- conversation passes that and needs the second.
    IF NEW.owner_id IS DISTINCT FROM app_current_actor()
       OR NOT EXISTS (
            SELECT 1 FROM ai_conversations c
             WHERE c.id = NEW.conversation_id
               AND c.student_id = app_current_actor())
    THEN
      -- Deliberately the same message whatever the reason: not yours, does not
      -- exist, or exists in another school. The EXISTS runs under the caller's
      -- own row security, so it can only ever confirm what they already see.
      RAISE EXCEPTION 'You may only append to your own conversation'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- STILL STUDYING IT, checked on EVERY turn and not only at creation.
    --
    -- The probe is what put this here. Creating a conversation was already
    -- gated on `app_actor_may_study_lesson`, so a learner in no class could not
    -- start one — but nothing re-asked the question afterwards, and a learner
    -- removed from the class mid-term could carry on adding turns to a
    -- conversation they had legitimately opened in September.
    --
    -- Task 009 settled the general form of this: "unenrolled or revoked
    -- students immediately lose the ability to update active sessions", and a
    -- tutor conversation is an active session by any reading. Enrolment is not
    -- a fact about the past that a row can carry forward; it is a fact about
    -- now, and every write has to ask it again.
    --
    -- READING and ARCHIVING deliberately survive: a learner keeps their own
    -- history when a course ends, and may still tidy it. It is only the ability
    -- to keep TALKING that revocation takes away.
    IF NOT EXISTS (
         SELECT 1 FROM ai_conversations c
          WHERE c.id = NEW.conversation_id
            AND app_actor_may_study_lesson(c.lesson_id))
    THEN
      RAISE EXCEPTION 'You are no longer studying the coursework this conversation is about'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT coalesce(max(m.seq), 0) + 1 INTO NEW.seq
    FROM ai_messages m WHERE m.conversation_id = NEW.conversation_id;
  NEW.created_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER ai_messages_sequence
  BEFORE INSERT ON ai_messages
  FOR EACH ROW EXECUTE FUNCTION ai_message_sequence_guard();

-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────────

/**
 * A learner sees their own; a narrow set of adults sees it for safety.
 *
 * The two halves are separate expressions rather than one clever predicate,
 * because they are answering different questions and a reader should be able to
 * check them independently.
 */
CREATE POLICY ai_conversations_select ON ai_conversations FOR SELECT TO edu_app
  USING (
    student_id = app_current_actor()
    OR app_actor_moderates_conversation(student_id, organization_id, lesson_id)
  );

/**
 * Only for yourself, and only about coursework you are currently studying.
 *
 * `student_id = app_current_actor()` is what makes this un-forgeable: a caller
 * cannot create a conversation owned by somebody else, whatever the request
 * body said, because the row would not satisfy the check. The scope half is the
 * same question the trigger asks, held here as well so that neither alone is
 * load-bearing.
 */
CREATE POLICY ai_conversations_insert ON ai_conversations FOR INSERT TO edu_app
  WITH CHECK (
    student_id = app_current_actor()
    AND app_actor_may_study_lesson(lesson_id)
  );

/**
 * The owner may rename and archive. Nobody else may write at all.
 *
 * NO MODERATOR BRANCH, and that is the point of a moderation power: reading a
 * transcript is oversight, editing one is tampering. A moderator who could
 * archive a conversation could hide it from the next moderator.
 *
 * Note the USING/WITH CHECK pair. `USING` decides which rows may be updated;
 * `WITH CHECK` decides what they may become. Without the second, a learner
 * could update their own row into one owned by somebody else — the row would
 * pass `USING` on its way in and land outside their reach.
 */
CREATE POLICY ai_conversations_update ON ai_conversations FOR UPDATE TO edu_app
  USING (student_id = app_current_actor())
  WITH CHECK (student_id = app_current_actor());

CREATE POLICY ai_conversations_delete ON ai_conversations FOR DELETE TO edu_app
  USING (student_id = app_current_actor());

/**
 * Message visibility is the conversation's visibility, asked once.
 */
CREATE POLICY ai_messages_select ON ai_messages FOR SELECT TO edu_app
  USING (app_actor_sees_conversation(conversation_id));

/**
 * A learner may append their OWN turn to their OWN conversation, and nothing
 * else may be written through this path.
 *
 * `sender_type = 'student'` is the forgery gate described in the header. A
 * request claiming to be the tutor fails the check rather than being quietly
 * relabelled, so the failure is visible in tests and in logs.
 *
 * The ownership half is a plain column comparison, which it can afford to be
 * because the composite foreign key has already guaranteed that `owner_id` is
 * the conversation's real owner. A policy that instead joined `ai_conversations`
 * would evaluate that table's policy as a subquery and entangle the two; a
 * policy that called a SECURITY DEFINER helper would answer NULL, which is what
 * the first draft did.
 */
CREATE POLICY ai_messages_insert ON ai_messages FOR INSERT TO edu_app
  WITH CHECK (
    -- OWNERSHIP, and note what is NOT here: no function call, no subquery, no
    -- join. `owner_id` is only allowed to be the conversation's real owner
    -- because the composite foreign key says so, so this single comparison
    -- carries the full weight of "your own conversation" without depending on
    -- any privilege subtlety. The first draft asked a SECURITY DEFINER helper
    -- and got NULL for every row; see `ai_begin_platform_turn`.
    owner_id = app_current_actor()
    AND (
      sender_type = 'student'
      -- A platform turn, and only into the conversation the marker names.
      -- Marking one conversation does not open the others.
      OR current_setting('ai.platform_turn', true) = conversation_id::text
    )
  );

-- NO UPDATE POLICY AND NO DELETE POLICY ON `ai_messages`, and no grant for
-- either. A transcript is append-only; see the header.

-- ── PRIVILEGES ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_conversations TO edu_app;
GRANT SELECT, INSERT ON ai_messages TO edu_app;

-- PostgreSQL grants EXECUTE to PUBLIC by default, so withholding it takes more
-- than not granting it — VULN-041, where the answer-key marker was callable by
-- every application session because nobody had revoked what nobody had granted.
REVOKE ALL ON FUNCTION app_actor_moderates_conversation(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_sees_conversation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_begin_platform_turn(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_conversation_scope_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION ai_message_sequence_guard() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_actor_moderates_conversation(uuid, uuid, uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_sees_conversation(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION ai_begin_platform_turn(uuid) TO edu_app;

-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--
-- It does not store the retrieved chunk BODIES on the message. Only ids and
-- labels. The bodies are curriculum, they live in `lessons`, and 0026's whole
-- argument against duplicating them applies here with more force: a transcript
-- is kept for years, so a copy of a lesson body inside one is a copy that
-- outlives every correction ever made to the original.
--
-- It does not store the system prompt. Not per conversation, not per message.
-- The instructions are a server-side module constant; a column holding them
-- would be a column somebody could eventually write to, and "the system prompt
-- is unreachable from a request" would stop being true at that moment.
--
-- It does not add a guardian read path. See `app_actor_moderates_conversation`.
--
-- It does not add retention or deletion. A child's conversation history has a
-- retention question attached to it that this platform has not answered for any
-- domain yet, and answering it here — for the most sensitive data on the
-- platform, in the migration that creates it — would be the wrong place to
-- decide it. `docs/security/limitations.md` records it.
-- ============================================================================

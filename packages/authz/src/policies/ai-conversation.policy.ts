import { allow, deny, type Decision } from '../decision.ts';
import type {
  AiConversationAction,
  AiConversationResource,
  AuthorizationContext,
} from '../types.ts';

/**
 * Who may do what with a learner's AI tutor conversation.
 *
 * THE SHAPE OF THIS POLICY IS UNUSUAL AND DELIBERATE: reading and WRITING are
 * governed by different rules, and the gap between them is the whole design.
 *
 * Everywhere else on this platform, an actor who may read a row is the same
 * actor who may write it, or the write set is a subset of the read set. Here
 * the read set is DELIBERATELY WIDER than the write set and can never overlap
 * it: adults read for safety, and no adult writes at all. A moderator who could
 * archive a conversation could hide it from the next moderator, and an
 * oversight power that can alter what it oversees is not oversight.
 *
 * ---------------------------------------------------------------------------
 * READING: THE OWNER, PLUS A NARROW SET OF ADULTS
 * ---------------------------------------------------------------------------
 *
 * Section 2C of the task says teachers and admins may read logs "within their
 * organization boundary". This policy reads that as a CEILING rather than as a
 * grant, and the difference matters because of what this data is: not a score
 * the platform computed about a child, but the unfiltered record of a child
 * trying to understand something and failing.
 *
 * So the organization is the outer bound nobody crosses, and inside it the
 * authority is the one the platform already recognises:
 *
 *   - A TEACHER reads the conversations of learners they actually teach, on
 *     lessons they actually teach. Resolved in SQL as
 *     `observableByActorAsTeacher`, from the same helper that governs their
 *     view of that learner's progress. A teacher gains no new REACH here; the
 *     transcript is simply inside the boundary that already held the child's
 *     coursework.
 *
 *   - A MODERATOR or an ORGANIZATION ADMIN reads any conversation in their own
 *     school. Resolved as `moderatableByActor`. This is a genuinely wider
 *     power than teaching, which is why it is a separate field rather than
 *     folded into the first: an audit of this domain has to be able to answer
 *     "which authority did this adult use", and a single boolean could not.
 *
 * THERE IS NO GUARDIAN BRANCH, and it is the hardest call in this file. A
 * guardian may already read a note their child shared and their child's
 * progress, so extending the same reach here would look consistent. It is not:
 * a child who believes a parent is reading their questions asks different
 * questions, and the ones they are least willing to ask in front of a parent
 * are sometimes the ones that most need answering. That is a decision for a
 * school and a family, not a default, so the branch is absent rather than
 * present-and-denying — and `docs/security/limitations.md` records it as open.
 *
 * THERE IS NO PLATFORM-OPERATOR BRANCH, matching `workspacePolicy` for the
 * reason it gives: an operator can read records the PLATFORM authored about a
 * child. This is a record the CHILD authored.
 *
 * ---------------------------------------------------------------------------
 * WRITING: THE OWNER, AND ONLY WHILE STILL STUDYING
 * ---------------------------------------------------------------------------
 *
 * `create` and `speak` additionally require `anchorStillAssigned` — the learner
 * is studying the anchor lesson RIGHT NOW, not merely was when they started.
 * Task 009 settled the general rule for this platform: a revoked learner
 * immediately loses the ability to update an active session. The database
 * enforces it too, on every turn; this is the same question asked in the layer
 * that can explain itself.
 *
 * `rename` and `archive` deliberately DO NOT require it. A learner keeps their
 * own history when a course ends and may still tidy it — revocation takes away
 * the ability to keep talking, not the record of having talked.
 */
export function aiConversationPolicy(
  ctx: AuthorizationContext,
  action: AiConversationAction,
  conversation: AiConversationResource,
): Decision {
  const isOwner = conversation.ownerId === ctx.actor.id;
  const verb = action.slice(action.indexOf(':') + 1);

  if (isOwner) {
    if (verb === 'read' || verb === 'list') {
      return allow(action, conversation.id, 'ai_conversation.owner');
    }

    if (verb === 'rename' || verb === 'archive') {
      // Available after enrolment ends, on purpose. See the header.
      if (conversation.status === 'archived' && verb === 'archive') {
        return deny(action, conversation.id, 'ai_conversation.already_archived', 'reveal');
      }
      return allow(action, conversation.id, 'ai_conversation.owner');
    }

    if (verb === 'create' || verb === 'speak') {
      if (!conversation.anchorStillAssigned) {
        // THE DISCLOSURE DIFFERS BETWEEN THE TWO VERBS, and the layered-defence
        // suite is what forced the distinction.
        //
        // For `speak` it is `reveal`: the learner is HOLDING this conversation,
        // so they already know it exists, and concealing the reason would leave
        // them staring at a silent failure with no way to understand that their
        // class had changed.
        //
        // For `create` it must be `hide`. There the id names a LESSON the actor
        // has not been granted anything about, and "you are not studying this"
        // says something a bare 404 would not: that the lesson is real. Run with
        // RLS switched off, that difference was measurable — creating against
        // another school's lesson answered 403 while a made-up id answered 404,
        // which is a cross-tenant existence oracle that only the database was
        // closing. Two gates, and one of them was carrying this alone.
        return deny(
          action,
          conversation.id,
          'ai_conversation.no_longer_studying',
          verb === 'speak' ? 'reveal' : 'hide',
        );
      }
      if (conversation.status === 'archived' && verb === 'speak') {
        return deny(action, conversation.id, 'ai_conversation.archived', 'reveal');
      }
      return allow(action, conversation.id, 'ai_conversation.owner');
    }
  }

  // ── Adults, reading only ────────────────────────────────────────────────
  //
  // Reached only when the actor is NOT the owner, so there is no path by which
  // a moderation branch could widen what an owner may do.
  if (verb === 'read' || verb === 'list') {
    if (conversation.observableByActorAsTeacher) {
      return allow(action, conversation.id, 'ai_conversation.teacher_of_this_learner');
    }
    if (conversation.moderatableByActor) {
      return allow(action, conversation.id, 'ai_conversation.safety_moderator_in_school');
    }
  }

  // `hide`, always, and for every remaining case at once: another learner's,
  // another school's, a moderator attempting to WRITE, and an id that names
  // nothing. A learner enumerating ids must not be able to tell them apart, and
  // an adult who may read but not write learns nothing from the refusal about
  // whether the row exists.
  return deny(action, conversation.id, 'ai_conversation.no_matching_grant', 'hide');
}

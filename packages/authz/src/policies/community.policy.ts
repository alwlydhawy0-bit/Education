import { allow, deny, type Decision } from '../decision.ts';
import type {
  AuthorizationContext,
  ContentFlagAction,
  ContentFlagResource,
  DiscussionReplyAction,
  DiscussionReplyResource,
  DiscussionThreadAction,
  DiscussionThreadResource,
} from '../types.ts';

/**
 * Who may do what in a class forum.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE FIRST DOMAIN WHERE ONE CHILD'S WRITING REACHES ANOTHER
 * ---------------------------------------------------------------------------
 *
 * Notes are private. Portfolios are shown to strangers only through a page
 * their owner deliberately published. Tutor transcripts are read by adults for
 * safety. A forum is different: the audience is other minors, it is immediate,
 * and nobody chose it post by post.
 *
 * So the policy has an obligation the others do not — it decides what a child
 * is exposed to, not only what a child discloses. Three consequences run
 * through everything below.
 *
 * THE ROOM IS THE BOUNDARY, AND IT IS ONE ROOM. `actorInForum` is a single
 * resolved fact meaning "a member or teacher of this active class". There is no
 * organization-wide read, no "same year group", no cross-class visibility of
 * any kind. A learner in 9A cannot see 9B's forum, and that is not a
 * conservative default to be relaxed later — it is what makes a class forum a
 * place children can speak in.
 *
 * MODERATION IS THE LIFECYCLE, so `moderationStatus` is on the resource and the
 * policy branches on it. A hidden post is one its own author may no longer
 * edit. Everywhere else on this platform state lives in the payload and the
 * policy only asks who; here the two are genuinely coupled.
 *
 * A LOCK BELONGS TO THE ROOM, NOT TO A PERSON. It stops new writing and hides
 * nothing already said. A teacher ending an argument is not the same act as
 * removing what was argued, and a policy that conflated them would let "calm
 * this down" delete a child's words as a side effect.
 */

/**
 * Threads.
 *
 * READING IS THE WIDEST BRANCH AND STILL NARROW: the room, plus the author for
 * their own non-approved posts, plus staff. WRITING is the author alone.
 * MODERATING is staff alone, and is three separate verbs.
 */
export function discussionThreadPolicy(
  ctx: AuthorizationContext,
  action: DiscussionThreadAction,
  thread: DiscussionThreadResource,
): Decision {
  const isAuthor = thread.ownerId === ctx.actor.id;
  const verb = action.slice(action.indexOf(':') + 1);
  const hidden = thread.moderationStatus === 'hidden';

  // ── Moderation, first, because staff may act on posts they could not edit ──
  if (verb === 'pin' || verb === 'lock' || verb === 'moderate') {
    if (thread.actorModerates) {
      return allow(action, thread.id, 'discussion_thread.moderates_this_class');
    }
    // `hide`, even for a learner who can plainly see the thread. A 403 here
    // would confirm that moderation is a thing that exists on this object and
    // invite them to look for the route; a 404 says only that this is not
    // something they can do to it.
    return deny(action, thread.id, 'discussion_thread.not_a_moderator', 'hide');
  }

  if (verb === 'read' || verb === 'list') {
    // The author, at any status. Their own words, including the version a
    // reviewer hid — see the migration header for why silence would be worse.
    if (isAuthor) return allow(action, thread.id, 'discussion_thread.author');
    if (thread.actorModerates) {
      return allow(action, thread.id, 'discussion_thread.moderates_this_class');
    }
    if (thread.actorInForum && thread.moderationStatus === 'approved') {
      return allow(action, thread.id, 'discussion_thread.in_this_class');
    }
    return deny(action, thread.id, 'discussion_thread.not_visible', 'hide');
  }

  if (verb === 'create') {
    if (thread.actorInForum) return allow(action, thread.id, 'discussion_thread.in_this_class');
    // `hide`: the id names a CLASS the actor has been granted nothing about, and
    // "you are not in this class" says something a bare 404 would not — that the
    // class is real. Task 012 measured that difference with RLS switched off and
    // found it was a cross-tenant existence oracle.
    return deny(action, thread.id, 'discussion_thread.not_in_this_class', 'hide');
  }

  if (verb === 'update' || verb === 'delete') {
    if (!isAuthor) {
      return deny(action, thread.id, 'discussion_thread.not_author', 'hide');
    }
    // SECTION 2C, BOTH CONDITIONS, AND THE DISCLOSURE DIFFERS FROM ABOVE.
    // `reveal`, because the author is looking at their own post and knows it
    // exists. A silent 404 would leave a child unable to tell whether their
    // edit failed, the post vanished, or the platform is broken — and the true
    // answer ("a teacher locked this") is one they are entitled to.
    if (thread.isLocked) {
      return deny(action, thread.id, 'discussion_thread.locked', 'reveal');
    }
    if (hidden) {
      return deny(action, thread.id, 'discussion_thread.hidden', 'reveal');
    }
    if (!thread.actorInForum) {
      // A learner who has left the class keeps their words in the thread and
      // loses the ability to change them. `reveal`, same reasoning.
      return deny(action, thread.id, 'discussion_thread.no_longer_in_class', 'reveal');
    }
    return allow(action, thread.id, 'discussion_thread.author');
  }

  return deny(action, thread.id, 'discussion_thread.no_matching_grant', 'hide');
}

/**
 * Replies.
 *
 * The same shape, plus the two things only a reply has: a thread that can be
 * locked underneath it, and an `accept` verb whose holder is the person who
 * asked the question.
 */
export function discussionReplyPolicy(
  ctx: AuthorizationContext,
  action: DiscussionReplyAction,
  reply: DiscussionReplyResource,
): Decision {
  const isAuthor = reply.ownerId === ctx.actor.id;
  const verb = action.slice(action.indexOf(':') + 1);

  if (verb === 'moderate') {
    if (reply.actorModerates) {
      return allow(action, reply.id, 'discussion_reply.moderates_this_class');
    }
    return deny(action, reply.id, 'discussion_reply.not_a_moderator', 'hide');
  }

  if (verb === 'accept') {
    // THE ANSWERER IS REFUSED EVEN IF THEY ALSO OPENED THE THREAD. Somebody who
    // answers their own question and then accepts it is marking their own
    // homework; the flag means "this resolved it" to everyone who reads later,
    // and a self-award makes that signal worthless. Checked before the
    // ownership branch so the two cannot be combined.
    if (isAuthor) {
      return deny(action, reply.id, 'discussion_reply.no_self_accept', 'reveal');
    }
    if (reply.actorOwnsThread && reply.actorInForum) {
      return allow(action, reply.id, 'discussion_reply.asked_the_question');
    }
    if (reply.actorModerates) {
      return allow(action, reply.id, 'discussion_reply.moderates_this_class');
    }
    return deny(action, reply.id, 'discussion_reply.not_the_questioner', 'hide');
  }

  if (verb === 'read' || verb === 'list') {
    if (isAuthor) return allow(action, reply.id, 'discussion_reply.author');
    if (reply.actorModerates) {
      return allow(action, reply.id, 'discussion_reply.moderates_this_class');
    }
    if (reply.actorInForum && reply.moderationStatus === 'approved') {
      return allow(action, reply.id, 'discussion_reply.in_this_class');
    }
    return deny(action, reply.id, 'discussion_reply.not_visible', 'hide');
  }

  if (verb === 'create') {
    if (!reply.actorInForum) {
      return deny(action, reply.id, 'discussion_reply.not_in_this_class', 'hide');
    }
    // THE LOCK, ASKED HERE AS WELL AS IN THE DATABASE. Section 3 puts the
    // enforcement in the INSERT policy so no route can go round it; this is the
    // same question asked in the layer that can explain the answer.
    if (reply.threadIsLocked) {
      return deny(action, reply.id, 'discussion_reply.thread_locked', 'reveal');
    }
    return allow(action, reply.id, 'discussion_reply.in_this_class');
  }

  if (verb === 'update' || verb === 'delete') {
    if (!isAuthor) return deny(action, reply.id, 'discussion_reply.not_author', 'hide');
    if (reply.threadIsLocked) {
      return deny(action, reply.id, 'discussion_reply.thread_locked', 'reveal');
    }
    if (reply.moderationStatus === 'hidden') {
      return deny(action, reply.id, 'discussion_reply.hidden', 'reveal');
    }
    if (!reply.actorInForum) {
      return deny(action, reply.id, 'discussion_reply.no_longer_in_class', 'reveal');
    }
    return allow(action, reply.id, 'discussion_reply.author');
  }

  return deny(action, reply.id, 'discussion_reply.no_matching_grant', 'hide');
}

/**
 * Flags.
 *
 * THE SHORTEST POLICY IN THIS FILE AND THE ONE WITH THE MOST AT STAKE.
 *
 * A flag is readable by the person who raised it and by the staff who work it.
 * THERE IS NO BRANCH FOR THE REPORTED AUTHOR, and `ContentFlagResource` does
 * not even carry their id, so no future edit can add one by accident.
 *
 * That is not squeamishness about transparency. On a forum for children,
 * telling somebody who reported them converts the reporting system into a
 * targeting system: the next thing that happens is retaliation, and the child
 * who reported the bullying learns not to. The author is told their post was
 * actioned — the moderation status is visible to them — and not by whom.
 *
 * NOBODY WITHDRAWS A FLAG, INCLUDING ITS REPORTER. A report that can be
 * retracted can be retracted under pressure, and pressure is precisely what the
 * reporting path exists to survive. Staff close it; the record remains.
 */
export function contentFlagPolicy(
  ctx: AuthorizationContext,
  action: ContentFlagAction,
  flag: ContentFlagResource,
): Decision {
  const verb = action.slice(action.indexOf(':') + 1);

  if (verb === 'create') {
    // Anyone may report; whether they are in the room is decided by the
    // database, which derives the flag's thread from the post being reported.
    return allow(action, flag.id, 'content_flag.anyone_may_report');
  }

  if (verb === 'review') {
    if (flag.actorModerates) return allow(action, flag.id, 'content_flag.moderates_this_class');
    return deny(action, flag.id, 'content_flag.not_a_moderator', 'hide');
  }

  if (verb === 'read' || verb === 'list') {
    if (flag.reporterId !== null && flag.reporterId === ctx.actor.id) {
      return allow(action, flag.id, 'content_flag.reporter');
    }
    if (flag.actorModerates) return allow(action, flag.id, 'content_flag.moderates_this_class');
  }

  return deny(action, flag.id, 'content_flag.no_matching_grant', 'hide');
}

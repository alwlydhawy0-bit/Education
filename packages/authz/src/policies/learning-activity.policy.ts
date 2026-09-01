import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  isPlatformOperator,
  CONTENT_AUTHOR_PERMISSION,
  CONTENT_PUBLISH_PERMISSION,
  type AuthorizationContext,
  type LearningActivityAction,
  type LearningActivityResource,
} from '../types.ts';

/**
 * Policy for a learning activity — and, through it, for the assessment,
 * questions and options an activity of type `assessment` carries.
 *
 * ONE resource kind for all four, deliberately. An assessment has no lifecycle
 * of its own: its activity's status IS its status, and its questions are its
 * content. Giving each of them a resource kind would create four rules for one
 * visible object, and four rules can disagree about whether a child may see it.
 *
 * The shape mirrors `contentPolicy` because an activity IS content — the same
 * two axes in the same order, and the same reason for the order:
 *
 *   1. SCOPE — may this actor see this at all? Failure is `hide` (404).
 *   2. STATE — does its lifecycle permit the action? Failure is `reveal` (403),
 *      because by then the actor can already see it.
 *
 * WHAT IS DIFFERENT FROM `contentPolicy`, and why it is not simply reused:
 *
 * An activity is only ever as visible as the LESSON above it, and the lesson's
 * own visibility already encodes the tenancy check, the whole-chain publication
 * rule and the Task 006 class narrowing. Rather than restate any of that, the
 * caller resolves it once in SQL — by asking `lessons_select` itself — and hands
 * the answer over as `lessonVisible`. So this policy has one ancestor test where
 * `contentPolicy` has two, and no copy of the narrowing logic to drift.
 *
 * `learnerReachesLesson` is the separate question of whether the actor reaches
 * that lesson AS A LEARNER. Content staff do not need it (choosing what to
 * publish means reading candidates first, VULN-023); a learner about to START an
 * assessment does.
 */
export function learningActivityPolicy(
  ctx: AuthorizationContext,
  action: LearningActivityAction,
  activity: LearningActivityResource,
): Decision {
  const { actor } = ctx;
  const verb = action.slice(action.indexOf(':') + 1);

  if (isPlatformOperator(actor)) {
    return allow(action, activity.id, 'learning_activity.platform_operator');
  }

  const isGlobal = activity.organizationId === null;
  const isOwnOrganization =
    actor.organizationId !== null && activity.organizationId === actor.organizationId;

  const mayAuthor = hasPermission(actor, CONTENT_AUTHOR_PERMISSION);
  const mayPublish = hasPermission(actor, CONTENT_PUBLISH_PERMISSION);
  // Editorial standing IN THIS CATALOG: the right to be aware of unpublished
  // work here. A reviewer holding only `content:publish` still has to read a
  // draft to decide about it, so the read gate asks for either permission and
  // each write gate asks for the specific one.
  const isEditorHere = isOwnOrganization && (mayAuthor || mayPublish);

  // --- Axis 1: scope ------------------------------------------------------
  if (verb === 'read' || verb === 'list') {
    if (!activity.lessonVisible) {
      // The lesson is already invisible, so the activity cannot be anything
      // else. This one test stands in for the tenancy check, the ancestor
      // chain and the class narrowing at once, because `lessons_select`
      // performed all three before answering.
      return deny(action, activity.id, 'learning_activity.lesson_not_visible', 'hide');
    }
    if (activity.status === 'published') {
      return allow(action, activity.id, 'learning_activity.published_on_a_visible_lesson');
    }
    if (isEditorHere) {
      return allow(action, activity.id, 'learning_activity.editor_of_organization');
    }
    // A draft or archived activity, to somebody with no editorial standing
    // here. Includes an editor of ANOTHER school, and an editor looking at the
    // global catalog — which only a platform operator may author.
    return deny(action, activity.id, 'learning_activity.not_published', 'hide');
  }

  // --- Every write below requires editorial standing in this catalog -------
  if (isGlobal) {
    // Reached only by a non-operator, since operators returned above. Global
    // activities are the platform's own, exactly as global courses are.
    return deny(action, activity.id, 'learning_activity.global_catalog_is_operator_only', 'hide');
  }
  if (!isEditorHere) {
    return deny(action, activity.id, 'learning_activity.not_an_editor_here', 'hide');
  }
  if (!activity.lessonVisible && verb !== 'create') {
    // An editor of the right school who still cannot see the lesson — a draft
    // lesson in another school's course filed here by mistake, say.
    return deny(action, activity.id, 'learning_activity.lesson_not_visible', 'hide');
  }

  // --- Axis 2: state, and which permission the verb needs ------------------
  if (verb === 'create') {
    if (!mayAuthor) {
      return deny(
        action,
        activity.id,
        'learning_activity.create_requires_author_permission',
        'reveal',
      );
    }
    if (!activity.lessonVisible) {
      return deny(action, activity.id, 'learning_activity.lesson_not_visible', 'hide');
    }
    if (activity.status !== 'draft') {
      // Born a draft. A request asserting its own publication is refused here
      // and, independently, by the RLS insert check.
      return deny(action, activity.id, 'learning_activity.must_start_as_draft', 'reveal');
    }
    return allow(action, activity.id, 'learning_activity.author_in_own_organization');
  }

  if (verb === 'update') {
    if (!mayAuthor) {
      return deny(
        action,
        activity.id,
        'learning_activity.edit_requires_author_permission',
        'reveal',
      );
    }
    if (activity.status !== 'draft') {
      // Stricter than `contentPolicy`, which permits editing published content.
      //
      // An activity's content is the paper a learner sits. Changing it after
      // publication would mean two attempts at "the same assessment" had been
      // marked against different papers, with no way to recover which. The
      // database enforces the same rule for questions, options and keys.
      return deny(action, activity.id, 'learning_activity.only_a_draft_may_be_edited', 'reveal');
    }
    return allow(action, activity.id, 'learning_activity.author_in_own_organization');
  }

  if (verb === 'publish' || verb === 'archive') {
    if (!mayPublish) {
      // The separation of duties: writing an assessment and deciding that
      // children will be scored by it are different authorities (ADR 0009).
      return deny(action, activity.id, 'learning_activity.requires_publish_permission', 'reveal');
    }
    if (verb === 'publish' && activity.status !== 'draft') {
      return deny(action, activity.id, 'learning_activity.only_a_draft_may_be_published', 'reveal');
    }
    if (verb === 'archive' && activity.status === 'archived') {
      return deny(action, activity.id, 'learning_activity.already_archived', 'reveal');
    }
    return allow(action, activity.id, 'learning_activity.publisher_in_own_organization');
  }

  return deny(action, activity.id, 'learning_activity.no_matching_grant', 'hide');
}

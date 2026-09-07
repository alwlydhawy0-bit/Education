import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  isPlatformOperator,
  CONTENT_AUTHOR_PERMISSION,
  CONTENT_PUBLISH_PERMISSION,
  type AuthorizationContext,
  type ContentAction,
  type CourseResource,
  type CourseUnitResource,
  type CurriculumResource,
  type LessonResource,
} from '../types.ts';

/**
 * Any node of the content tree.
 *
 * Spelled as the union rather than as the shared base, so that `kind` narrows
 * and `courseId` is readable where it exists without a cast. A cast here would
 * be a cast on the value the ANCESTRY check depends on, which is the last place
 * to be persuading the type system of something.
 */
type ContentNode = CurriculumResource | CourseResource | CourseUnitResource | LessonResource;

/**
 * Policy for every node of the educational content tree — curricula, courses,
 * units and lessons.
 *
 * ONE function for four resource kinds, deliberately. The rule genuinely is the
 * same rule at every level; writing it four times would mean four places for it
 * to drift, and the drift would be silent because each level is tested against
 * its own copy. What differs between the levels is only which ancestors have to
 * be published, and the caller answers that in `ancestorsPublished` before the
 * decision is made.
 *
 * TWO AXES, evaluated in this order, and the order is the disclosure rule:
 *
 *   1. SCOPE — may this actor see this catalog at all? A failure here is
 *      `hide` (404), because the actor may not learn the content exists.
 *   2. STATE — is this content in a state that permits the action? A failure
 *      here is `reveal` (403), because by this point the actor can already see
 *      the object and hiding it would only be confusing.
 *
 * Getting that order backwards would turn "this draft exists" into an oracle:
 * a 403 on a draft in another school confirms the id names something real.
 *
 * READING HAS A THIRD REQUIREMENT (Task 006). Published content reaches a
 * LEARNER only when it is assigned to a class they are in. That test runs
 * INSIDE the scope branch, after the catalog check, so it can only ever remove
 * content from the set the catalog already permitted — an assignment can never
 * carry a learner across an organization boundary.
 *
 * The requirement is on LEARNERS, not on staff. Somebody holding a content
 * permission still browses the published catalog freely, because choosing what
 * to assign to a class means reading the candidates first. Applying the
 * narrowing to them made the assignment endpoint unusable, which is how that
 * distinction was found rather than reasoned to.
 */
export function contentPolicy(
  ctx: AuthorizationContext,
  action: ContentAction,
  content: ContentNode,
): Decision {
  const { actor, relationships } = ctx;
  const verb = action.slice(action.indexOf(':') + 1);

  // A platform operator administers the whole platform, global catalog
  // included. Same standing as in `classPolicy` — see the risk register for
  // what that authority means in practice.
  if (isPlatformOperator(actor)) {
    return allow(action, content.id, 'content.platform_operator');
  }

  const isGlobal = content.organizationId === null;
  const isOwnOrganization =
    actor.organizationId !== null && content.organizationId === actor.organizationId;

  const mayAuthor = hasPermission(actor, CONTENT_AUTHOR_PERMISSION);
  const mayPublish = hasPermission(actor, CONTENT_PUBLISH_PERMISSION);
  // "Editorial standing" is the right to be aware of unpublished work at all.
  // A reviewer who may only publish still has to READ a draft to decide about
  // it, so the read gate asks for either permission and the write gates ask for
  // the specific one.
  const isEditorHere = isOwnOrganization && (mayAuthor || mayPublish);

  /**
   * Editorial standing ANYWHERE, not just in this catalog.
   *
   * This is what separates a learner from staff for the Task 006 narrowing. An
   * administrator has to be able to BROWSE the published global catalog in
   * order to choose what to assign to a class — a person who cannot see a
   * course cannot assign it — and a teacher has to be able to read the course
   * they are about to teach before a class exists for it.
   *
   * It grants nothing beyond what publication already made public: this branch
   * is only ever reached for content that is published AND in a catalog the
   * actor's organization can see. The learner narrowing is unaffected.
   */
  const isContentStaff = mayAuthor || mayPublish;

  // --- Axis 1: scope ----------------------------------------------------
  // The global catalog is readable by everyone once published, and writable by
  // nobody but a platform operator (who returned above). A school's content is
  // readable by that school and invisible everywhere else.
  const publishedAndVisible =
    content.status === 'published' && content.ancestorsPublished && (isGlobal || isOwnOrganization);

  if (verb === 'read' || verb === 'list') {
    // A LEARNER additionally needs the content to reach them through a class.
    //
    // `courseOf` is the course this node belongs to — itself, for a course; its
    // parent, for a unit or a lesson. A CURRICULUM has none, and is
    // deliberately exempt: the subject catalog names subjects, not content, and
    // gating it behind an assignment would mean a learner could not see that
    // their school teaches mathematics until somebody assigned them a maths
    // course.
    const courseOf =
      content.kind === 'course'
        ? content.id
        : content.kind === 'course_unit' || content.kind === 'lesson'
          ? content.courseId
          : null;

    const reachesThroughAClass =
      courseOf === null || relationships.coursesViaClasses.includes(courseOf);

    if (publishedAndVisible && (reachesThroughAClass || isContentStaff)) {
      return allow(
        action,
        content.id,
        reachesThroughAClass
          ? 'content.published_and_assigned_to_my_class'
          : 'content.published_and_actor_is_content_staff',
      );
    }
    if (isEditorHere) {
      // Editorial standing is not a learner relationship: an author reads their
      // school's content because they maintain it, not because they study it,
      // so no assignment is required of them.
      return allow(action, content.id, 'content.editor_of_organization');
    }
    // Covers every remaining case with one answer: another school's content, a
    // draft, an archived item, content whose ancestor is unpublished, and
    // published content nobody has assigned to a class this actor is in. A
    // learner cannot tell these apart, which is the point.
    return deny(action, content.id, 'content.not_visible', 'hide');
  }

  // --- Every write below requires editorial standing in this catalog ------
  if (isGlobal) {
    // Reached only by a non-operator, since operators returned above.
    return deny(action, content.id, 'content.global_catalog_is_operator_only', 'hide');
  }
  if (!isEditorHere) {
    return deny(action, content.id, 'content.not_an_editor_here', 'hide');
  }

  // --- Axis 2: state, and which permission the verb needs -----------------
  if (verb === 'create') {
    if (!mayAuthor) {
      return deny(action, content.id, 'content.create_requires_author_permission', 'reveal');
    }
    // Content is always born a draft. A request that arrives asserting its own
    // publication is refused here and, independently, by the RLS insert check.
    if (content.status !== 'draft') {
      return deny(action, content.id, 'content.must_start_as_draft', 'reveal');
    }
    return allow(action, content.id, 'content.author_in_own_organization');
  }

  if (verb === 'update' || verb === 'delete') {
    if (!mayAuthor) {
      return deny(action, content.id, 'content.edit_requires_author_permission', 'reveal');
    }
    if (content.status === 'archived') {
      // Archived content is settled history. Superseding it means publishing
      // something new, which keeps what learners were shown recoverable.
      return deny(action, content.id, 'content.archived_is_immutable', 'reveal');
    }
    if (verb === 'delete' && content.status !== 'draft') {
      // Published work has been seen. Removing the record of what was taught is
      // not an editing operation; archiving is the supported move.
      return deny(action, content.id, 'content.published_cannot_be_deleted', 'reveal');
    }
    return allow(action, content.id, 'content.author_in_own_organization');
  }

  /**
   * INDEXING: the same authority as publishing, over the opposite state.
   *
   * Rebuilding a course's knowledge-base entry decides what the assistant may
   * retrieve and quote to a child, so it takes publish standing rather than
   * author standing — writing content and deciding what learners may be told
   * are different authorities, and this is the second one.
   *
   * It requires a PUBLISHED course, which is where it parts company with
   * `publish` itself. Indexing a draft would put unpublished wording into a
   * store whose whole purpose is to be searched, and the state axis is the
   * right place to refuse it: `reveal`, because an actor who got this far can
   * already see the course.
   */
  if (verb === 'index') {
    if (!mayPublish) {
      return deny(action, content.id, 'content.requires_publish_permission', 'reveal');
    }
    if (content.status !== 'published') {
      return deny(action, content.id, 'content.only_published_content_is_indexed', 'reveal');
    }
    return allow(action, content.id, 'content.publisher_in_own_organization');
  }

  if (verb === 'publish' || verb === 'archive') {
    if (!mayPublish) {
      // The separation of duties, stated once: writing content and deciding
      // that learners may see it are different authorities.
      return deny(action, content.id, 'content.requires_publish_permission', 'reveal');
    }
    if (verb === 'publish' && content.status !== 'draft') {
      return deny(action, content.id, 'content.only_a_draft_may_be_published', 'reveal');
    }
    if (verb === 'archive' && content.status === 'archived') {
      return deny(action, content.id, 'content.already_archived', 'reveal');
    }
    return allow(action, content.id, 'content.publisher_in_own_organization');
  }

  return deny(action, content.id, 'content.no_matching_grant', 'hide');
}

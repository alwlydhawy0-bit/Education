import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  isPlatformOperator,
  CONTENT_AUTHOR_PERMISSION,
  CONTENT_PUBLISH_PERMISSION,
  type AuthorizationContext,
  type ContentAction,
  type ContentNodeResource,
} from '../types.ts';

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
 */
export function contentPolicy(
  ctx: AuthorizationContext,
  action: ContentAction,
  content: ContentNodeResource,
): Decision {
  const { actor } = ctx;
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

  // --- Axis 1: scope ----------------------------------------------------
  // The global catalog is readable by everyone once published, and writable by
  // nobody but a platform operator (who returned above). A school's content is
  // readable by that school and invisible everywhere else.
  const publishedAndVisible =
    content.status === 'published' && content.ancestorsPublished && (isGlobal || isOwnOrganization);

  if (verb === 'read' || verb === 'list') {
    if (publishedAndVisible) {
      return allow(action, content.id, 'content.published_in_visible_catalog');
    }
    if (isEditorHere) {
      return allow(action, content.id, 'content.editor_of_organization');
    }
    // Covers every remaining case with one answer: another school's content, a
    // draft, an archived item, and content whose ancestor is unpublished. A
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

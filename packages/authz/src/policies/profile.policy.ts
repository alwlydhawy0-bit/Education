import { allow, deny, type Decision } from '../decision.ts';
import {
  hasPermission,
  Role,
  type AuthorizationContext,
  type ProfileAction,
  type ProfileResource,
} from '../types.ts';

/**
 * Policy for user profiles.
 *
 * Profiles are separated from `users` because they have different sensitivity
 * and different write rules: a student may freely rewrite their own display
 * name and bio, but must never touch their own account status.
 *
 * The asymmetry to notice: several roles can READ a profile they have a
 * relationship with, but **nobody may UPDATE another person's profile** — not a
 * teacher, not an administrator. A profile is self-description. Removing
 * inappropriate content is a moderation action against the account, which is a
 * different capability and does not exist yet.
 */
export function profilePolicy(
  ctx: AuthorizationContext,
  action: ProfileAction,
  profile: ProfileResource,
): Decision {
  const { actor, relationships } = ctx;
  const isSelf = profile.userId === actor.id;

  if (isSelf) {
    return allow(action, profile.id, 'profile.self');
  }

  // Non-owner: reads only, and only with both a permission and a relationship.
  if (action !== 'profile:read') {
    return deny(action, profile.id, 'profile.non_owner_may_not_mutate', 'hide');
  }

  if (!hasPermission(actor, 'profiles:read')) {
    return deny(action, profile.id, 'profile.missing_permission', 'hide');
  }

  const sameOrg =
    profile.organizationId !== null && profile.organizationId === actor.organizationId;

  if (relationships.teacherOf.includes(profile.userId) && sameOrg) {
    return allow(action, profile.id, 'profile.teacher_of_student');
  }

  if (relationships.guardianOf.includes(profile.userId)) {
    // Guardianship is a family tie, not an institutional one, so it is
    // deliberately not gated on the organization matching.
    return allow(action, profile.id, 'profile.verified_guardian');
  }

  // Administrators manage accounts, and a profile is part of the account record
  // they are responsible for — but only inside their own organization.
  if ((actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.SECURITY_ADMIN)) && sameOrg) {
    return allow(action, profile.id, 'profile.admin_same_org');
  }

  return deny(action, profile.id, 'profile.no_matching_grant', 'hide');
}

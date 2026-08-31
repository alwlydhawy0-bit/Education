import { allow, deny, type Decision } from '../decision.ts';
import {
  Role,
  type AuthorizationContext,
  type GuardianRelationshipAction,
  type GuardianRelationshipResource,
} from '../types.ts';

/**
 * Policy for guardian relationships.
 *
 * The single most important rule here: **a guardian may not verify their own
 * relationship.** Verification is what turns a claim into an access grant over
 * a child's private work, so allowing self-verification would let anyone claim
 * guardianship of any student and confirm it themselves. It is the entire attack
 * against this table, and it is refused for every role including administrators
 * acting on their own relationships.
 *
 * Revocation is deliberately the opposite: it only ever REMOVES access, so both
 * participants may do it freely. A student must always be able to cut off an
 * adult's access to their work without asking permission.
 */
export function guardianRelationshipPolicy(
  ctx: AuthorizationContext,
  action: GuardianRelationshipAction,
  relationship: GuardianRelationshipResource,
): Decision {
  const { actor } = ctx;
  const isGuardian = relationship.guardianId === actor.id;
  const isChild = relationship.childId === actor.id;
  const isParticipant = isGuardian || isChild;

  /**
   * An administrator, of the CHILD'S OWN school.
   *
   * The organization test is not decoration. Without it this policy would allow
   * an administrator of any school to read, verify or revoke any link, and the
   * only thing refusing them would be RLS — one gate where the design claims
   * two. An actor with no organization, or a child whose school is unknown,
   * matches nothing.
   */
  const isAdminOfChildsOrganization =
    (actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.SECURITY_ADMIN)) &&
    actor.organizationId !== null &&
    relationship.childOrganizationId !== null &&
    relationship.childOrganizationId === actor.organizationId;

  if (action === 'guardian_relationship:create') {
    // A new claim is always PENDING and grants nothing. Creating one already
    // verified is refused here and independently by the RLS insert policy.
    if (relationship.state !== 'pending') {
      return deny(action, relationship.id, 'guardian_relationship.must_start_pending', 'reveal');
    }
    // A guardian may only ever claim a relationship ABOUT THEMSELVES. Claiming
    // one on somebody else's behalf would let an actor manufacture a link
    // between two accounts they do not control.
    if (isChild) {
      return deny(
        action,
        relationship.id,
        'guardian_relationship.cannot_claim_own_guardian',
        'reveal',
      );
    }
    if (isGuardian && actor.roles.includes(Role.GUARDIAN)) {
      return allow(action, relationship.id, 'guardian_relationship.self_claim_pending');
    }
    if (isAdminOfChildsOrganization) {
      return allow(action, relationship.id, 'guardian_relationship.created_by_admin');
    }
    return deny(
      action,
      relationship.id,
      'guardian_relationship.create_requires_guardian_or_admin',
      'hide',
    );
  }

  if (action === 'guardian_relationship:read') {
    if (isParticipant) {
      return allow(action, relationship.id, 'guardian_relationship.participant');
    }
    if (isAdminOfChildsOrganization) {
      return allow(action, relationship.id, 'guardian_relationship.admin');
    }
    return deny(action, relationship.id, 'guardian_relationship.not_a_participant', 'hide');
  }

  if (action === 'guardian_relationship:verify') {
    // Self-verification is the attack. Refused unconditionally.
    if (isParticipant) {
      return deny(
        action,
        relationship.id,
        'guardian_relationship.self_verification_forbidden',
        'reveal',
      );
    }
    if (relationship.state !== 'pending') {
      return deny(
        action,
        relationship.id,
        'guardian_relationship.only_pending_may_be_verified',
        'reveal',
      );
    }
    if (isAdminOfChildsOrganization) {
      return allow(action, relationship.id, 'guardian_relationship.verified_by_admin');
    }
    return deny(
      action,
      relationship.id,
      'guardian_relationship.verification_requires_admin',
      'hide',
    );
  }

  if (action === 'guardian_relationship:revoke') {
    if (relationship.state === 'revoked') {
      return deny(action, relationship.id, 'guardian_relationship.already_revoked', 'reveal');
    }
    // Revocation only removes access, so either participant may do it — the
    // child included, without needing anybody's approval.
    if (isParticipant) {
      return allow(action, relationship.id, 'guardian_relationship.participant_may_revoke');
    }
    if (isAdminOfChildsOrganization) {
      return allow(action, relationship.id, 'guardian_relationship.revoked_by_admin');
    }
  }

  return deny(action, relationship.id, 'guardian_relationship.no_matching_grant', 'hide');
}

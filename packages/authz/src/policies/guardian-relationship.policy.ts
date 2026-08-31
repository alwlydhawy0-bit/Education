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

  if (action === 'guardian_relationship:read') {
    if (isParticipant) {
      return allow(action, relationship.id, 'guardian_relationship.participant');
    }
    if (actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.SECURITY_ADMIN)) {
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
    if (actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.SECURITY_ADMIN)) {
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
    if (actor.roles.includes(Role.ADMIN) || actor.roles.includes(Role.SECURITY_ADMIN)) {
      return allow(action, relationship.id, 'guardian_relationship.revoked_by_admin');
    }
  }

  return deny(action, relationship.id, 'guardian_relationship.no_matching_grant', 'hide');
}

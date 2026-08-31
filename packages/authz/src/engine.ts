import { deny, type Decision } from './decision.ts';
import { notePolicy } from './policies/note.policy.ts';
import { userPolicy } from './policies/user.policy.ts';
import { profilePolicy } from './policies/profile.policy.ts';
import { roleGrantPolicy } from './policies/role-grant.policy.ts';
import { classMembershipPolicy } from './policies/class-membership.policy.ts';
import { guardianRelationshipPolicy } from './policies/guardian-relationship.policy.ts';
import { organizationPolicy } from './policies/organization.policy.ts';
import { classPolicy } from './policies/class.policy.ts';
import { teacherAssignmentPolicy } from './policies/teacher-assignment.policy.ts';
import { contentPolicy } from './policies/content.policy.ts';
import { educationLevelPolicy } from './policies/education-level.policy.ts';
import { classCourseAssignmentPolicy } from './policies/class-course-assignment.policy.ts';
import {
  resourceKindForAction,
  type Action,
  type AuthorizationContext,
  type NoteAction,
  type Resource,
  type ResourceKind,
  type UserAction,
} from './types.ts';

/**
 * Raised when the engine is asked to evaluate an action against the wrong kind
 * of resource, or a resource kind with no registered policy.
 *
 * Both are programming errors. The engine throws rather than returning deny so
 * that the mistake is loud in tests and in logs instead of silently becoming a
 * confusing permission failure in production. Failing this way is still
 * fail-closed: the request errors out and no payload is released.
 */
export class PolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigurationError';
  }
}

export interface PolicyEngine {
  decide(ctx: AuthorizationContext, action: Action, resource: Resource): Decision;
}

type PolicyFn = (ctx: AuthorizationContext, action: never, resource: never) => Decision;

/**
 * Policies are registered per resource kind. Adding a domain means adding an
 * entry here and a policy file — it never means editing another domain's rules.
 * That is what keeps the authorization surface reviewable as the platform grows.
 */
const DEFAULT_POLICIES: Readonly<Record<ResourceKind, PolicyFn>> = Object.freeze({
  note: notePolicy as unknown as PolicyFn,
  user: userPolicy as unknown as PolicyFn,
  profile: profilePolicy as unknown as PolicyFn,
  role_grant: roleGrantPolicy as unknown as PolicyFn,
  organization: organizationPolicy as unknown as PolicyFn,
  class: classPolicy as unknown as PolicyFn,
  teacher_assignment: teacherAssignmentPolicy as unknown as PolicyFn,
  class_membership: classMembershipPolicy as unknown as PolicyFn,
  guardian_relationship: guardianRelationshipPolicy as unknown as PolicyFn,
  education_level: educationLevelPolicy as unknown as PolicyFn,
  // One policy, registered four times. The rule is identical at every level of
  // the content tree; four copies would be four places for it to drift, and the
  // drift would be invisible because each copy has its own tests.
  curriculum: contentPolicy as unknown as PolicyFn,
  course: contentPolicy as unknown as PolicyFn,
  course_unit: contentPolicy as unknown as PolicyFn,
  lesson: contentPolicy as unknown as PolicyFn,
  class_course_assignment: classCourseAssignmentPolicy as unknown as PolicyFn,
});

export function createPolicyEngine(
  policies: Readonly<Record<ResourceKind, PolicyFn>> = DEFAULT_POLICIES,
): PolicyEngine {
  return {
    decide(ctx, action, resource): Decision {
      // --- Invariant: the action must belong to this resource kind --------
      // Without this, a handler that authorizes `note:read` against a user
      // record (or vice versa) would silently consult the wrong rule set.
      const expectedKind = resourceKindForAction(action);
      if (expectedKind !== resource.kind) {
        throw new PolicyConfigurationError(
          `Action "${action}" targets resource kind "${expectedKind}" but was evaluated against a "${resource.kind}".`,
        );
      }

      // --- Global pre-checks, applied before any per-resource policy ------
      // These are deny-only. A pre-check can never grant access; it can only
      // remove it. That ordering means a future pre-check cannot accidentally
      // widen a policy.
      if (ctx.actor.status === 'suspended') {
        return deny(action, resource.id, 'actor.suspended', 'reveal');
      }
      if (ctx.actor.status === 'pending_verification') {
        return deny(action, resource.id, 'actor.pending_verification', 'reveal');
      }
      if (ctx.actor.roles.length === 0) {
        return deny(action, resource.id, 'actor.no_roles', 'hide');
      }

      const policy = policies[resource.kind];
      if (!policy) {
        throw new PolicyConfigurationError(
          `No policy registered for resource kind "${resource.kind}".`,
        );
      }

      return policy(ctx, action as never, resource as never);
    },
  };
}

/** Convenience wrappers that keep action/resource types aligned at call sites. */
export type NoteDecider = (
  ctx: AuthorizationContext,
  action: NoteAction,
  resource: Extract<Resource, { kind: 'note' }>,
) => Decision;

export type UserDecider = (
  ctx: AuthorizationContext,
  action: UserAction,
  resource: Extract<Resource, { kind: 'user' }>,
) => Decision;

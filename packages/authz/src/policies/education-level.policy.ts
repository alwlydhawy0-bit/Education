import { allow, deny, type Decision } from '../decision.ts';
import {
  isPlatformOperator,
  type AuthorizationContext,
  type EducationLevelAction,
  type EducationLevelResource,
} from '../types.ts';

/**
 * Policy for education levels (grades and stages).
 *
 * Deliberately the simplest policy in the package. Levels are shared
 * vocabulary: every authenticated actor may read them, because every catalog
 * listing renders them, and nothing about "Grade 7" is sensitive.
 *
 * Writes are central. If each school could mint its own levels, content would
 * stop being comparable or shareable between schools — and the vocabulary that
 * a national curriculum depends on would fork silently, one school at a time.
 */
export function educationLevelPolicy(
  ctx: AuthorizationContext,
  action: EducationLevelAction,
  level: EducationLevelResource,
): Decision {
  if (action === 'education_level:read' || action === 'education_level:list') {
    // The engine has already refused suspended, unverified and role-less
    // actors, so reaching here means an ordinary authenticated user.
    return allow(action, level.id, 'education_level.readable_by_any_actor');
  }

  if (isPlatformOperator(ctx.actor)) {
    return allow(action, level.id, 'education_level.platform_operator');
  }

  // `reveal`, not `hide`: the actor can already read every level, so pretending
  // this one does not exist would be theatre.
  return deny(action, level.id, 'education_level.write_requires_platform_operator', 'reveal');
}

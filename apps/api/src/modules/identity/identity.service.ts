import type { Clock } from '@edu/kernel';
import { conflict, unauthenticated } from '@edu/kernel';
import type { Actor } from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { RegisterRequest, LoginRequest } from '@edu/contracts';
import { generateSessionToken, hashSessionToken } from '../../platform/security/tokens.ts';
import { getDummyHash, hashPassword, verifyPassword } from '../../platform/security/passwords.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import {
  EmailAlreadyRegisteredError,
  type IdentityRepository,
  type ResolvedSession,
} from './identity.repository.ts';

export interface IdentityServiceDeps {
  readonly repository: IdentityRepository;
  readonly securityEvents: SecurityEventRecorder;
  readonly clock: Clock;
  readonly sessionTtlHours: number;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface IdentityService {
  register(input: RegisterRequest, meta: RequestMeta): Promise<{ userId: string }>;
  login(input: LoginRequest, meta: RequestMeta): Promise<IssuedSession>;
  logout(token: string, meta: RequestMeta): Promise<void>;
  authenticate(token: string): Promise<{ actor: Actor; session: ResolvedSession } | null>;
}

export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const { repository, securityEvents, clock, sessionTtlHours } = deps;

  return {
    async register(input, meta) {
      const passwordHash = await hashPassword(input.password);
      try {
        const userId = await repository.register(
          input.email,
          passwordHash,
          input.displayName,
          input.locale,
        );
        await securityEvents.record({
          type: SecurityEventType.AUTH_REGISTERED,
          actorId: userId,
          correlationId: meta.correlationId,
          ip: meta.ip,
          detail: {},
          occurredAt: clock.now(),
        });
        return { userId };
      } catch (error) {
        if (error instanceof EmailAlreadyRegisteredError) {
          // NOTE — accepted, documented trade-off.
          //
          // This tells an unauthenticated caller that an email is registered,
          // which is account enumeration. The alternative (always return 201
          // and send a "someone tried to register with your address" email)
          // needs an email pipeline that does not exist yet.
          //
          // Compensating controls today: registration is rate-limited per IP.
          // Tracked in docs/security/threat-model.md as RISK-ENUM-01. This
          // comment exists so the trade-off is not mistaken for an oversight.
          throw conflict('Email already registered');
        }
        throw error;
      }
    },

    async login(input, meta) {
      const candidate = await repository.findForLogin(input.email);

      // Always run a real Argon2 verification, even when the account does not
      // exist, so that response time does not reveal which emails are
      // registered. See `getDummyHash`.
      const hashToCheck = candidate?.passwordHash ?? (await getDummyHash());
      const passwordValid = await verifyPassword(hashToCheck, input.password);

      const ok = candidate !== null && passwordValid && candidate.status === 'active';

      if (!ok) {
        await securityEvents.record({
          type: SecurityEventType.AUTH_LOGIN_FAILED,
          actorId: candidate?.id ?? null,
          correlationId: meta.correlationId,
          ip: meta.ip,
          // Deliberately does NOT record the attempted email: the audit log
          // would otherwise accumulate a list of addresses people typed by
          // mistake, including ones belonging to non-users.
          detail: { reason: candidate === null ? 'no_such_user' : 'rejected' },
          occurredAt: clock.now(),
        });
        // One message for every failure mode — wrong password, unknown account,
        // and suspended account are indistinguishable to the caller.
        throw unauthenticated('Invalid email or password');
      }

      const token = generateSessionToken();
      const expiresAt = new Date(clock.now().getTime() + sessionTtlHours * 3600_000);
      await repository.createSession(
        candidate.id,
        hashSessionToken(token),
        expiresAt,
        meta.ip,
        meta.userAgent,
      );

      await securityEvents.record({
        type: SecurityEventType.AUTH_LOGIN_SUCCEEDED,
        actorId: candidate.id,
        correlationId: meta.correlationId,
        ip: meta.ip,
        detail: {},
        occurredAt: clock.now(),
      });

      return { token, expiresAt };
    },

    async logout(token, meta) {
      const revoked = await repository.revokeSession(hashSessionToken(token));
      if (revoked) {
        await securityEvents.record({
          type: SecurityEventType.AUTH_LOGOUT,
          actorId: null,
          correlationId: meta.correlationId,
          ip: meta.ip,
          detail: {},
          occurredAt: clock.now(),
        });
      }
    },

    async authenticate(token) {
      const session = await repository.resolveSession(hashSessionToken(token));
      if (!session) return null;

      // The Actor is assembled entirely from server-side state. Roles come from
      // `user_roles`, status from `users` — never from the token, which carries
      // no claims at all.
      const actor: Actor = {
        id: session.userId,
        roles: session.roles,
        status: session.status,
        organizationId: session.organizationId,
      };
      return { actor, session };
    },
  };
}

import type { Clock } from '@edu/kernel';
import { conflict, unauthenticated, validationFailed } from '@edu/kernel';
import type { Actor } from '@edu/authz';
import { SecurityEventType } from '@edu/observability';
import type { LoginRequest, RegisterRequest } from '@edu/contracts';
import { generateSessionToken, hashSessionToken } from '../../platform/security/tokens.ts';
import { getDummyHash, hashPassword, verifyPassword } from '../../platform/security/passwords.ts';
import type { SecurityEventRecorder } from '../../platform/security/security-events.ts';
import {
  EmailAlreadyRegisteredError,
  type IdentityRepository,
  type ResolvedSession,
} from './identity.repository.ts';
import type { MailDelivery } from './mail-delivery.ts';

export interface IdentityPolicyOptions {
  readonly sessionTtlHours: number;
  readonly refreshTtlDays: number;
  readonly emailVerificationTtlHours: number;
  readonly passwordResetTtlMinutes: number;
  readonly maxFailedLogins: number;
  readonly lockoutMinutes: number;
  /**
   * Whether an unverified address blocks login.
   *
   * Defaults to false because enabling it without working mail delivery locks
   * every user out permanently — an availability failure worse than the risk it
   * addresses. It must be switched on together with a mail provider.
   */
  readonly requireVerifiedEmailForLogin: boolean;
}

export interface IdentityServiceDeps {
  readonly repository: IdentityRepository;
  readonly securityEvents: SecurityEventRecorder;
  readonly mail: MailDelivery;
  readonly clock: Clock;
  readonly options: IdentityPolicyOptions;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string;
}

export interface IssuedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
}

export interface IdentityService {
  register(input: RegisterRequest, meta: RequestMeta): Promise<{ userId: string }>;
  login(input: LoginRequest, meta: RequestMeta): Promise<IssuedSession>;
  logout(accessToken: string, meta: RequestMeta): Promise<void>;
  logoutAll(actorId: string, meta: RequestMeta): Promise<number>;
  refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedSession>;
  verifyEmail(token: string, meta: RequestMeta): Promise<void>;
  requestPasswordReset(email: string, meta: RequestMeta): Promise<void>;
  resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void>;
  authenticate(accessToken: string): Promise<{ actor: Actor; session: ResolvedSession } | null>;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const { repository, securityEvents, mail, clock, options } = deps;

  const record = (
    type: SecurityEventType,
    actorId: string | null,
    meta: RequestMeta,
    detail: Record<string, unknown> = {},
  ): Promise<void> =>
    securityEvents.record({
      type,
      actorId,
      correlationId: meta.correlationId,
      ip: meta.ip,
      detail,
      occurredAt: clock.now(),
    });

  /** Mints an access + refresh pair and persists the session. */
  async function issueSession(userId: string, meta: RequestMeta): Promise<IssuedSession> {
    const accessToken = generateSessionToken();
    const refreshToken = generateSessionToken();
    const now = clock.now().getTime();
    const expiresAt = new Date(now + options.sessionTtlHours * HOUR_MS);
    const refreshExpiresAt = new Date(now + options.refreshTtlDays * DAY_MS);

    await repository.createSession({
      userId,
      tokenHash: hashSessionToken(accessToken),
      refreshTokenHash: hashSessionToken(refreshToken),
      expiresAt,
      refreshExpiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
      deviceLabel: null,
    });

    return { accessToken, refreshToken, expiresAt, refreshExpiresAt };
  }

  return {
    async register(input, meta) {
      const passwordHash = await hashPassword(input.password);
      let userId: string;
      try {
        userId = await repository.register(
          input.email,
          passwordHash,
          input.displayName,
          input.locale,
        );
      } catch (error) {
        if (error instanceof EmailAlreadyRegisteredError) {
          await record(SecurityEventType.AUTH_REGISTER_FAILED, null, meta, {
            reason: 'email_already_registered',
          });
          // Accepted, documented trade-off: this discloses that an address is
          // registered. The non-enumerating alternative needs mail delivery,
          // which does not exist. Compensated by per-IP rate limiting.
          // Tracked as RISK-ENUM-01.
          throw conflict('Email already registered');
        }
        throw error;
      }

      // The verification token leaves the process only through the mail port —
      // never through the HTTP response, where anyone triggering a registration
      // could read it.
      const token = generateSessionToken();
      await repository.createEmailVerification(
        userId,
        hashSessionToken(token),
        input.email,
        new Date(clock.now().getTime() + options.emailVerificationTtlHours * HOUR_MS),
      );
      await mail.sendEmailVerification(input.email, token);

      await record(SecurityEventType.AUTH_REGISTERED, userId, meta);
      return { userId };
    },

    async login(input, meta) {
      const candidate = await repository.findForLogin(input.email);

      // Always run a real Argon2 verification, even for an unknown account, so
      // response time does not reveal which addresses are registered.
      const hashToCheck = candidate?.passwordHash ?? (await getDummyHash());
      const passwordValid = await verifyPassword(hashToCheck, input.password);

      const now = clock.now();
      const isLocked = candidate?.lockedUntil != null && candidate.lockedUntil > now;
      const verificationSatisfied =
        !options.requireVerifiedEmailForLogin || (candidate?.emailVerified ?? false);

      const ok =
        candidate !== null &&
        passwordValid &&
        candidate.status === 'active' &&
        !isLocked &&
        verificationSatisfied;

      if (!ok) {
        // Only a real account with a wrong password advances the lockout
        // counter. Counting unknown addresses would let an attacker lock out
        // nobody while filling the table with junk.
        let lockedNow = false;
        if (candidate !== null && !passwordValid && !isLocked) {
          lockedNow = await repository.recordLoginFailure(
            candidate.id,
            options.maxFailedLogins,
            options.lockoutMinutes,
          );
        }

        await record(SecurityEventType.AUTH_LOGIN_FAILED, candidate?.id ?? null, meta, {
          // Never the attempted address: the audit log would otherwise
          // accumulate addresses people mistyped, including non-users.
          reason: candidate === null ? 'no_such_user' : isLocked ? 'locked' : 'rejected',
        });

        if (lockedNow && candidate !== null) {
          await record(SecurityEventType.ACCOUNT_LOCKED, candidate.id, meta, {
            lockoutMinutes: options.lockoutMinutes,
          });
          // Every session is cut when an account locks: a lockout usually means
          // somebody is attacking the account, and a live session would survive
          // the very control meant to stop them.
          await repository.revokeAllSessions(candidate.id, 'account_locked');
        }

        // One message for every failure mode — wrong password, unknown account,
        // suspended, locked and unverified are indistinguishable to the caller.
        throw unauthenticated('Invalid email or password');
      }

      await repository.recordLoginSuccess(candidate.id);
      const session = await issueSession(candidate.id, meta);
      await record(SecurityEventType.AUTH_LOGIN_SUCCEEDED, candidate.id, meta);
      return session;
    },

    async logout(accessToken, meta) {
      const revoked = await repository.revokeSession(hashSessionToken(accessToken));
      if (revoked) await record(SecurityEventType.AUTH_LOGOUT, null, meta);
    },

    async logoutAll(actorId, meta) {
      const count = await repository.revokeAllSessions(actorId, 'logout_all');
      await record(SecurityEventType.AUTH_LOGOUT, actorId, meta, { scope: 'all_devices', count });
      return count;
    },

    async refresh(refreshToken, meta) {
      const accessToken = generateSessionToken();
      const nextRefreshToken = generateSessionToken();
      const now = clock.now().getTime();
      const expiresAt = new Date(now + options.sessionTtlHours * HOUR_MS);
      const refreshExpiresAt = new Date(now + options.refreshTtlDays * DAY_MS);

      const result = await repository.rotateRefresh(hashSessionToken(refreshToken), {
        tokenHash: hashSessionToken(accessToken),
        refreshTokenHash: hashSessionToken(nextRefreshToken),
        expiresAt,
        refreshExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
        deviceLabel: null,
      });

      if (result.outcome === 'reuse_detected') {
        // A refresh token is single use. Presenting a rotated one means either
        // the token was stolen or the client's copy was captured — in both cases
        // the whole family has already been revoked by the database function.
        await record(SecurityEventType.AUTH_REFRESH_REUSE_DETECTED, result.userId, meta);
        throw unauthenticated('Session is no longer valid');
      }

      if (result.outcome !== 'rotated') {
        await record(SecurityEventType.AUTH_SESSION_REJECTED, null, meta, { stage: 'refresh' });
        throw unauthenticated('Session is no longer valid');
      }

      await record(SecurityEventType.AUTH_TOKEN_REFRESHED, result.userId, meta);
      return { accessToken, refreshToken: nextRefreshToken, expiresAt, refreshExpiresAt };
    },

    async verifyEmail(token, meta) {
      const userId = await repository.verifyEmail(hashSessionToken(token));
      if (!userId) {
        // Expired, already used, or never existed — one response for all three.
        throw validationFailed('Verification link is invalid or has expired');
      }
      await record(SecurityEventType.AUTH_EMAIL_VERIFIED, userId, meta);
    },

    async requestPasswordReset(email, meta) {
      const candidate = await repository.findForLogin(email);

      // Deliberately silent about whether the address exists. Unlike
      // registration, this endpoint has a non-enumerating design available at no
      // cost: do the work when the account exists, return the same response
      // either way.
      if (candidate !== null) {
        const token = generateSessionToken();
        await repository.createPasswordReset(
          candidate.id,
          hashSessionToken(token),
          new Date(clock.now().getTime() + options.passwordResetTtlMinutes * MINUTE_MS),
          meta.ip,
        );
        await mail.sendPasswordReset(candidate.email, token);
      }

      await record(SecurityEventType.PASSWORD_RESET_REQUESTED, candidate?.id ?? null, meta);
    },

    async resetPassword(token, newPassword, meta) {
      const passwordHash = await hashPassword(newPassword);
      const userId = await repository.consumePasswordReset(hashSessionToken(token), passwordHash);

      if (!userId) {
        await record(SecurityEventType.PASSWORD_RESET_FAILED, null, meta);
        throw validationFailed('Reset link is invalid or has expired');
      }

      // The database function already revoked every session in the same
      // transaction as the password change — a reset is an account-recovery
      // event, so leaving an attacker's session alive would defeat it.
      await record(SecurityEventType.PASSWORD_RESET_SUCCEEDED, userId, meta);
    },

    async authenticate(accessToken) {
      const session = await repository.resolveSession(hashSessionToken(accessToken));
      if (!session) return null;

      // Assembled entirely from server-side state. Roles, scopes and permissions
      // all come from the database; the token carries no claims at all.
      const actor: Actor = {
        id: session.userId,
        roles: session.roles,
        grants: session.grants,
        permissions: session.permissions,
        status: session.status,
        emailVerified: session.emailVerified,
        organizationId: session.organizationId,
      };
      return { actor, session };
    },
  };
}

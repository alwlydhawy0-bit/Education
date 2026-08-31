import type { PermissionName, Role, RoleGrant, RoleScopeType } from '@edu/authz';
import type { Database, Tx } from '../../platform/db.ts';

/**
 * Identity persistence.
 *
 * Every pre-authentication operation goes through one of the SECURITY DEFINER
 * functions defined in migration 0006. This module never SELECTs from `users`
 * directly for those paths — that is what keeps the RLS policies on `users`
 * unweakened while still allowing login to work.
 */

export interface LoginCandidate {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly locale: 'ar' | 'en';
  readonly status: 'active' | 'suspended' | 'pending_verification';
  readonly organizationId: string | null;
  readonly emailVerified: boolean;
  readonly failedLoginCount: number;
  /** Non-null and in the future means the account is currently locked. */
  readonly lockedUntil: Date | null;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: 'ar' | 'en';
  readonly status: 'active' | 'suspended' | 'pending_verification';
  readonly organizationId: string | null;
  readonly emailVerified: boolean;
  /** Role names held in any scope. */
  readonly roles: readonly Role[];
  /** The same roles with their scopes, for scope-aware policy checks. */
  readonly grants: readonly RoleGrant[];
  /** Flattened `resource:action` permissions from every role held. */
  readonly permissions: readonly PermissionName[];
  readonly expiresAt: Date;
}

interface LoginRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  locale: 'ar' | 'en';
  status: 'active' | 'suspended' | 'pending_verification';
  organization_id: string | null;
  email_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  locale: 'ar' | 'en';
  status: 'active' | 'suspended' | 'pending_verification';
  organization_id: string | null;
  email_verified: boolean;
  grants: { role: string; scopeType: string; scopeId: string | null }[];
  permissions: string[];
  expires_at: Date;
}

/** Outcome of presenting a refresh token. See `auth_rotate_refresh` in 0011. */
export type RefreshOutcome = 'rotated' | 'reuse_detected' | 'invalid';

export interface RotationResult {
  readonly outcome: RefreshOutcome;
  readonly sessionId: string | null;
  readonly userId: string | null;
}

export interface NewSessionInput {
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly refreshTokenHash: Buffer;
  readonly expiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly deviceLabel: string | null;
}

export interface IdentityRepository {
  register(
    email: string,
    passwordHash: string,
    displayName: string,
    locale: 'ar' | 'en',
  ): Promise<string>;
  findForLogin(email: string): Promise<LoginCandidate | null>;
  createSession(input: NewSessionInput): Promise<string>;
  resolveSession(tokenHash: Buffer): Promise<ResolvedSession | null>;
  revokeSession(tokenHash: Buffer): Promise<boolean>;
  revokeAllSessions(userId: string, reason: string): Promise<number>;
  rotateRefresh(
    oldRefreshHash: Buffer,
    next: Omit<NewSessionInput, 'userId'>,
  ): Promise<RotationResult>;
  recordLoginFailure(userId: string, maxAttempts: number, lockoutMinutes: number): Promise<boolean>;
  recordLoginSuccess(userId: string): Promise<void>;
  createEmailVerification(
    userId: string,
    tokenHash: Buffer,
    email: string,
    expiresAt: Date,
  ): Promise<void>;
  verifyEmail(tokenHash: Buffer): Promise<string | null>;
  createPasswordReset(
    userId: string,
    tokenHash: Buffer,
    expiresAt: Date,
    ip: string | null,
  ): Promise<void>;
  consumePasswordReset(tokenHash: Buffer, newPasswordHash: string): Promise<string | null>;
  loadProfile(tx: Tx, userId: string): Promise<LoginCandidate | null>;
}

/** Raised when the unique index on `users.email` rejects a registration. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function createIdentityRepository(db: Database): IdentityRepository {
  return {
    async register(email, passwordHash, displayName, locale) {
      try {
        return await db.withoutActor(async (tx) => {
          const { rows } = await tx.query<{ auth_register_user: string }>(
            'SELECT auth_register_user($1, $2, $3, $4)',
            [email, passwordHash, displayName, locale],
          );
          const id = rows[0]?.auth_register_user;
          if (!id) throw new Error('auth_register_user returned no id');
          return id;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new EmailAlreadyRegisteredError();
        throw error;
      }
    },

    async findForLogin(email) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<LoginRow>('SELECT * FROM auth_find_user_for_login($1)', [
          email,
        ]);
        const row = rows[0];
        if (!row) return null;
        return {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          displayName: row.display_name,
          locale: row.locale,
          status: row.status,
          organizationId: row.organization_id,
          emailVerified: row.email_verified_at !== null,
          failedLoginCount: row.failed_login_count,
          lockedUntil: row.locked_until,
        };
      });
    },

    async createSession(input) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_create_session: string }>(
          'SELECT auth_create_session($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            input.userId,
            input.tokenHash,
            input.refreshTokenHash,
            input.expiresAt,
            input.refreshExpiresAt,
            input.ip,
            input.userAgent,
            input.deviceLabel,
            null,
          ],
        );
        const id = rows[0]?.auth_create_session;
        if (!id) throw new Error('auth_create_session returned no id');
        return id;
      });
    },

    async revokeAllSessions(userId, reason) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_revoke_all_sessions: number }>(
          'SELECT auth_revoke_all_sessions($1, $2)',
          [userId, reason],
        );
        return rows[0]?.auth_revoke_all_sessions ?? 0;
      });
    },

    async rotateRefresh(oldRefreshHash, next) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{
          outcome: RefreshOutcome;
          session_id: string | null;
          user_id: string | null;
        }>('SELECT * FROM auth_rotate_refresh($1, $2, $3, $4, $5, $6, $7, $8)', [
          oldRefreshHash,
          next.tokenHash,
          next.refreshTokenHash,
          next.expiresAt,
          next.refreshExpiresAt,
          next.ip,
          next.userAgent,
          next.deviceLabel,
        ]);
        const row = rows[0];
        if (!row) return { outcome: 'invalid', sessionId: null, userId: null };
        return { outcome: row.outcome, sessionId: row.session_id, userId: row.user_id };
      });
    },

    async recordLoginFailure(userId, maxAttempts, lockoutMinutes) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_record_login_failure: boolean }>(
          'SELECT auth_record_login_failure($1, $2, $3)',
          [userId, maxAttempts, lockoutMinutes],
        );
        return rows[0]?.auth_record_login_failure ?? false;
      });
    },

    async recordLoginSuccess(userId) {
      await db.withoutActor((tx) => tx.query('SELECT auth_record_login_success($1)', [userId]));
    },

    async createEmailVerification(userId, tokenHash, email, expiresAt) {
      await db.withoutActor((tx) =>
        tx.query('SELECT auth_create_email_verification($1, $2, $3, $4)', [
          userId,
          tokenHash,
          email,
          expiresAt,
        ]),
      );
    },

    async verifyEmail(tokenHash) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_verify_email: string | null }>(
          'SELECT auth_verify_email($1)',
          [tokenHash],
        );
        return rows[0]?.auth_verify_email ?? null;
      });
    },

    async createPasswordReset(userId, tokenHash, expiresAt, ip) {
      await db.withoutActor((tx) =>
        tx.query('SELECT auth_create_password_reset($1, $2, $3, $4)', [
          userId,
          tokenHash,
          expiresAt,
          ip,
        ]),
      );
    },

    async consumePasswordReset(tokenHash, newPasswordHash) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_consume_password_reset: string | null }>(
          'SELECT auth_consume_password_reset($1, $2)',
          [tokenHash, newPasswordHash],
        );
        return rows[0]?.auth_consume_password_reset ?? null;
      });
    },

    async resolveSession(tokenHash) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<SessionRow>('SELECT * FROM auth_resolve_session($1)', [
          tokenHash,
        ]);
        const row = rows[0];
        if (!row) return null;
        // `grants` arrives as jsonb and `permissions` as text[]. Both are
        // server-derived: nothing here is read from the request.
        const grants: RoleGrant[] = row.grants.map((g) => ({
          role: g.role as Role,
          scopeType: g.scopeType as RoleScopeType,
          scopeId: g.scopeId,
        }));

        return {
          sessionId: row.session_id,
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          locale: row.locale,
          status: row.status,
          organizationId: row.organization_id,
          emailVerified: row.email_verified,
          // De-duplicated: a role held in several scopes is still one role name.
          roles: [...new Set(grants.map((g) => g.role))],
          grants,
          permissions: row.permissions as PermissionName[],
          expiresAt: row.expires_at,
        };
      });
    },

    async revokeSession(tokenHash) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_revoke_session: boolean }>(
          'SELECT auth_revoke_session($1)',
          [tokenHash],
        );
        return rows[0]?.auth_revoke_session ?? false;
      });
    },

    async loadProfile(tx, userId) {
      // Runs under RLS with the actor set, so this can only ever return a row
      // the actor is permitted to see.
      const { rows } = await tx.query<LoginRow>(
        `SELECT id, email, password_hash, display_name, locale, status, organization_id,
                email_verified_at, failed_login_count, locked_until
           FROM users WHERE id = $1`,
        [userId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        displayName: row.display_name,
        locale: row.locale,
        status: row.status,
        organizationId: row.organization_id,
        emailVerified: row.email_verified_at !== null,
        failedLoginCount: row.failed_login_count,
        lockedUntil: row.locked_until,
      };
    },
  };
}

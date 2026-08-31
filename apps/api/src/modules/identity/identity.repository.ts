import type { Role } from '@edu/authz';
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
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: 'ar' | 'en';
  readonly status: 'active' | 'suspended' | 'pending_verification';
  readonly organizationId: string | null;
  readonly roles: readonly Role[];
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
}

interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  locale: 'ar' | 'en';
  status: 'active' | 'suspended' | 'pending_verification';
  organization_id: string | null;
  roles: string[];
  expires_at: Date;
}

export interface IdentityRepository {
  register(
    email: string,
    passwordHash: string,
    displayName: string,
    locale: 'ar' | 'en',
  ): Promise<string>;
  findForLogin(email: string): Promise<LoginCandidate | null>;
  createSession(
    userId: string,
    tokenHash: Buffer,
    expiresAt: Date,
    ip: string | null,
    userAgent: string | null,
  ): Promise<string>;
  resolveSession(tokenHash: Buffer): Promise<ResolvedSession | null>;
  revokeSession(tokenHash: Buffer): Promise<boolean>;
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
        };
      });
    },

    async createSession(userId, tokenHash, expiresAt, ip, userAgent) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<{ auth_create_session: string }>(
          'SELECT auth_create_session($1, $2, $3, $4, $5)',
          [userId, tokenHash, expiresAt, ip, userAgent],
        );
        const id = rows[0]?.auth_create_session;
        if (!id) throw new Error('auth_create_session returned no id');
        return id;
      });
    },

    async resolveSession(tokenHash) {
      return db.withoutActor(async (tx) => {
        const { rows } = await tx.query<SessionRow>('SELECT * FROM auth_resolve_session($1)', [
          tokenHash,
        ]);
        const row = rows[0];
        if (!row) return null;
        return {
          sessionId: row.session_id,
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          locale: row.locale,
          status: row.status,
          organizationId: row.organization_id,
          roles: row.roles as Role[],
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
        `SELECT id, email, password_hash, display_name, locale, status, organization_id
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
      };
    },
  };
}

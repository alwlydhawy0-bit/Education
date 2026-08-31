import { Guarded, type ProfileResource, type Role, type UserResource } from '@edu/authz';
import type { Tx } from '../../platform/db.ts';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: 'active' | 'suspended' | 'pending_verification';
  readonly organizationId: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}

export interface ProfileRecord {
  readonly userId: string;
  readonly displayName: string;
  readonly fullName: string | null;
  readonly avatarUrl: string | null;
  readonly bio: string;
  readonly locale: 'ar' | 'en';
  readonly organizationId: string | null;
  readonly updatedAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: UserRecord['status'];
  organization_id: string | null;
  email_verified_at: Date | null;
  created_at: Date;
}

interface ProfileRow {
  user_id: string;
  display_name: string;
  full_name: string | null;
  avatar_url: string | null;
  bio: string;
  locale: 'ar' | 'en';
  organization_id: string | null;
  updated_at: Date;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  status: row.status,
  organizationId: row.organization_id,
  emailVerified: row.email_verified_at !== null,
  createdAt: row.created_at,
});

const toUserResource = (row: UserRow): UserResource => ({
  kind: 'user',
  id: row.id,
  organizationId: row.organization_id,
  status: row.status,
});

const toProfile = (row: ProfileRow): ProfileRecord => ({
  userId: row.user_id,
  displayName: row.display_name,
  fullName: row.full_name,
  avatarUrl: row.avatar_url,
  bio: row.bio,
  locale: row.locale,
  organizationId: row.organization_id,
  updatedAt: row.updated_at,
});

const toProfileResource = (row: ProfileRow): ProfileResource => ({
  kind: 'profile',
  // Profiles are keyed by user id, so the resource id IS the user id.
  id: row.user_id,
  userId: row.user_id,
  organizationId: row.organization_id,
});

/**
 * Persistence for users and profiles.
 *
 * By-id loads return `Guarded<T>`: a caller physically cannot read the payload
 * without first producing an allow-decision for that exact object. Listing is
 * expressed as "within an organization" rather than taking an arbitrary filter,
 * so no route can widen it by passing a different value.
 */
export interface UsersRepository {
  findUserById(tx: Tx, id: string): Promise<Guarded<UserRecord> | null>;
  findProfileByUserId(tx: Tx, userId: string): Promise<Guarded<ProfileRecord> | null>;
  listByOrganization(
    tx: Tx,
    organizationId: string,
    limit: number,
    offset: number,
  ): Promise<UserRecord[]>;
  updateProfile(
    tx: Tx,
    userId: string,
    patch: {
      displayName?: string;
      fullName?: string | null;
      avatarUrl?: string | null;
      bio?: string;
      locale?: 'ar' | 'en';
    },
  ): Promise<ProfileRecord | null>;
  updateStatus(tx: Tx, userId: string, status: UserRecord['status']): Promise<boolean>;
  listGrants(
    tx: Tx,
    userId: string,
  ): Promise<{ role: Role; scopeType: string; scopeId: string | null }[]>;
}

const USER_COLUMNS = `id, email, display_name, status, organization_id, email_verified_at, created_at`;

export const usersRepository: UsersRepository = {
  async findUserById(tx, id) {
    const { rows } = await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toUser(row), toUserResource(row));
  },

  async findProfileByUserId(tx, userId) {
    const { rows } = await tx.query<ProfileRow>(
      `SELECT p.user_id, p.display_name, p.full_name, p.avatar_url, p.bio, p.locale,
              u.organization_id, p.updated_at
         FROM profiles p JOIN users u ON u.id = p.user_id
        WHERE p.user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    return Guarded.of(toProfile(row), toProfileResource(row));
  },

  async listByOrganization(tx, organizationId, limit, offset) {
    // Scoped to one organization by construction. RLS independently confirms
    // the caller may see each row, so this cannot become a platform-wide
    // enumeration even if the organization id were wrong.
    const { rows } = await tx.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE organization_id = $1
        ORDER BY created_at DESC, id ASC
        LIMIT $2 OFFSET $3`,
      [organizationId, limit, offset],
    );
    return rows.map(toUser);
  },

  async updateProfile(tx, userId, patch) {
    // COALESCE keeps a partial update to one statement, so there is no
    // read-modify-write window another request could interleave with. The
    // nullable fields use a sentinel-free pattern: `undefined` means "leave
    // alone", and an explicit null is passed as a separate flag.
    const { rows } = await tx.query<ProfileRow>(
      `UPDATE profiles p
          SET display_name = COALESCE($2, p.display_name),
              full_name    = CASE WHEN $3::boolean THEN $4 ELSE p.full_name END,
              avatar_url   = CASE WHEN $5::boolean THEN $6 ELSE p.avatar_url END,
              bio          = COALESCE($7, p.bio),
              locale       = COALESCE($8, p.locale),
              updated_at   = now()
        WHERE p.user_id = $1
      RETURNING p.user_id, p.display_name, p.full_name, p.avatar_url, p.bio, p.locale,
                (SELECT u.organization_id FROM users u WHERE u.id = p.user_id) AS organization_id,
                p.updated_at`,
      [
        userId,
        patch.displayName ?? null,
        patch.fullName !== undefined,
        patch.fullName ?? null,
        patch.avatarUrl !== undefined,
        patch.avatarUrl ?? null,
        patch.bio ?? null,
        patch.locale ?? null,
      ],
    );
    const row = rows[0];
    return row ? toProfile(row) : null;
  },

  async updateStatus(tx, userId, status) {
    const result = await tx.query(
      `UPDATE users SET status = $2, updated_at = now() WHERE id = $1`,
      [userId, status],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async listGrants(tx, userId) {
    // Goes through the SECURITY DEFINER function because `user_roles`' own RLS
    // policy is deliberately "own grants only", to avoid policy recursion.
    // Authorization for reading another user's grants happens in the service,
    // before this is called.
    const { rows } = await tx.query<{
      role_name: string;
      scope_type: string;
      scope_id: string | null;
    }>('SELECT * FROM auth_user_grants($1)', [userId]);
    return rows.map((r) => ({
      role: r.role_name as Role,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
    }));
  },
};

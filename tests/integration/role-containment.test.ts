import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { TEST_APP_URL } from '../setup/env.ts';
import { closeSeedDb, createOrganization, createUser, truncateAll } from '../setup/fixtures.ts';

/**
 * Role-grant containment at the DATABASE layer, with the application bypassed.
 *
 * `roleGrantPolicy` enforces these rules in the application, and
 * tests/security/rbac-authorization.test.ts proves that over HTTP. This file
 * asks the harder question: if a bug ever let a request reach `auth_assign_role`
 * without passing the policy, would the database still refuse?
 *
 * It matters because Task 003 weakened a Task 001 guarantee. Previously
 * `edu_app` could not write `user_roles` at all; now it may execute a function
 * that takes the role as a parameter. Migration 0013 puts the containment back
 * beneath the policy, so there are two gates again rather than one.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 4 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

async function scenario() {
  const org = await createOrganization('School A');
  const ordinaryAdmin = await createUser({
    email: 'contain-admin@test.local',
    roles: ['admin'],
    organizationId: org,
  });
  const securityAdmin = await createUser({
    email: 'contain-sec@test.local',
    roles: ['security_admin'],
    organizationId: org,
  });
  const target = await createUser({ email: 'contain-target@test.local', organizationId: org });
  return { org, ordinaryAdmin, securityAdmin, target };
}

const assign = (
  actorId: string,
  userId: string,
  role: string,
  scopeType = 'organization',
  scopeId: string | null = null,
) =>
  db.withActor(actorId, (tx) =>
    tx.query('SELECT auth_assign_role($1, $2, $3, $4, $5)', [
      userId,
      role,
      scopeType,
      scopeId,
      actorId,
    ]),
  );

describe('self-modification is refused by the database', () => {
  it('refuses an admin granting themselves any role', async () => {
    const { org, ordinaryAdmin } = await scenario();
    await expect(
      assign(ordinaryAdmin.id, ordinaryAdmin.id, 'teacher', 'organization', org),
    ).rejects.toThrow(/Refusing to grant a role to the acting user/);
  });

  it('refuses a SECURITY administrator granting themselves too', async () => {
    const { org, securityAdmin } = await scenario();
    await expect(
      assign(securityAdmin.id, securityAdmin.id, 'admin', 'organization', org),
    ).rejects.toThrow(/Refusing to grant a role to the acting user/);
  });

  it('refuses revoking your own role', async () => {
    const { securityAdmin } = await scenario();
    await expect(
      db.withActor(securityAdmin.id, (tx) =>
        tx.query('SELECT auth_revoke_role($1, $2, $3, $4)', [
          securityAdmin.id,
          'security_admin',
          'global',
          null,
        ]),
      ),
    ).rejects.toThrow(/Refusing to revoke a role from the acting user/);
  });
});

describe('privileged roles are contained by the database', () => {
  it.each(['admin', 'security_admin'])(
    'refuses an ordinary admin granting %s, even bypassing the policy engine',
    async (role) => {
      const { org, ordinaryAdmin, target } = await scenario();
      await expect(assign(ordinaryAdmin.id, target.id, role, 'organization', org)).rejects.toThrow(
        /Only a security administrator may grant/,
      );
    },
  );

  it('lets a security administrator grant a privileged role in a scope', async () => {
    const { org, securityAdmin, target } = await scenario();
    await expect(
      assign(securityAdmin.id, target.id, 'admin', 'organization', org),
    ).resolves.toBeDefined();
  });

  it.each(['admin', 'security_admin'])(
    'refuses %s granted GLOBALLY, regardless of who asks',
    async (role) => {
      // A global privileged grant would reach every organization on the
      // platform, so it is refused even for a security administrator.
      const { securityAdmin, target } = await scenario();
      await expect(assign(securityAdmin.id, target.id, role, 'global', null)).rejects.toThrow(
        /may not be granted globally/,
      );
    },
  );

  it('still allows an ordinary role to be granted normally', async () => {
    const { org, ordinaryAdmin, target } = await scenario();
    await expect(
      assign(ordinaryAdmin.id, target.id, 'teacher', 'organization', org),
    ).resolves.toBeDefined();
  });
});

describe('the application role still cannot write user_roles directly', () => {
  it('refuses a direct INSERT, as in Task 001', async () => {
    const { ordinaryAdmin, target } = await scenario();
    await expect(
      db.withActor(ordinaryAdmin.id, (tx) =>
        tx.query(
          `INSERT INTO user_roles (user_id, role_id, scope_type)
           SELECT $1, r.id, 'global' FROM roles r WHERE r.name = 'security_admin'`,
          [target.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a direct DELETE', async () => {
    const { ordinaryAdmin, target } = await scenario();
    await expect(
      db.withActor(ordinaryAdmin.id, (tx) =>
        tx.query('DELETE FROM user_roles WHERE user_id = $1', [target.id]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('unknown roles', () => {
  it('refuses a role name that does not exist', async () => {
    const { org, securityAdmin, target } = await scenario();
    await expect(
      assign(securityAdmin.id, target.id, 'superuser', 'organization', org),
    ).rejects.toThrow(/Unknown role/);
  });
});

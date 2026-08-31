-- =====================================================================
-- 0007 — RBAC: roles, permissions, and SCOPED role grants
-- =====================================================================
-- Task 001 modelled a role as a plain string on `user_roles`. That was right
-- for two domains and is wrong now, because in a school "teacher" is never a
-- global fact — it is "teacher OF this class". A flat role column forces every
-- future policy to re-derive scope from somewhere else, which is how
-- authorization logic ends up duplicated and inconsistent.
--
-- This migration reshapes `user_roles` into a scoped grant:
--
--     (user_id, role_id, scope_type, scope_id)
--
-- `scope_type = 'global'` reproduces the old behaviour exactly, so a student
-- grant is unchanged in meaning. Organization- and class-scoped grants are what
-- make "teacher of THIS class" expressible.
--
-- BREAKING: `user_roles` is dropped and recreated. Approved deliberately — see
-- the Task 003 decision record in docs/architecture/adr/0008-rbac-scopes.md.
-- Nothing is deployed and there are no users, so no data migration is required.
-- The migration still runs forward-only: 0001 stays immutable.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Roles. `system_role` marks the ones the platform depends on; those may not
-- be renamed or deleted by an administrator, because policies reference them.
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  system_role boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT roles_name_format_ck CHECK (name ~ '^[a-z][a-z0-9_]{1,49}$')
);

CREATE UNIQUE INDEX roles_name_uk ON roles (name);

-- ---------------------------------------------------------------------
-- Permissions are `resource:action` pairs. Storing the two parts separately
-- (rather than one opaque string) lets a policy ask "may this actor do ANY
-- action on notes?" without string parsing.
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  resource    text NOT NULL,
  action      text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT permissions_resource_ck CHECK (resource ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT permissions_action_ck   CHECK (action   ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- The name is derived, not free-form: it must always equal resource:action,
  -- so the two representations cannot drift apart.
  CONSTRAINT permissions_name_derived_ck CHECK (name = resource || ':' || action)
);

CREATE UNIQUE INDEX permissions_name_uk ON permissions (name);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX role_permissions_permission_idx ON role_permissions (permission_id);

-- ---------------------------------------------------------------------
-- Scoped role grants (replaces the flat user_roles table).
-- ---------------------------------------------------------------------
DROP TABLE user_roles;

CREATE TABLE user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,

  -- 'global'       — applies everywhere (student, administrator).
  -- 'organization' — applies within one school.
  -- 'class'        — applies within one class.
  scope_type text NOT NULL DEFAULT 'global',
  -- NULL exactly when the scope is global. The CHECK below enforces that
  -- pairing, so a scoped grant can never be stored without its target — which
  -- would otherwise silently widen into a global grant.
  scope_id   uuid,

  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT user_roles_scope_type_ck CHECK (scope_type IN ('global', 'organization', 'class')),
  CONSTRAINT user_roles_scope_pairing_ck CHECK ((scope_type = 'global') = (scope_id IS NULL))
);

-- One grant per (user, role, scope). COALESCE gives global grants a stable key
-- because NULL is not comparable in a unique index.
CREATE UNIQUE INDEX user_roles_grant_uk
  ON user_roles (user_id, role_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX user_roles_user_idx ON user_roles (user_id);
CREATE INDEX user_roles_scope_idx ON user_roles (scope_type, scope_id) WHERE scope_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Seed the system roles and the initial permission set.
-- ---------------------------------------------------------------------
INSERT INTO roles (name, description, system_role) VALUES
  ('student',        'A learner using the platform.', true),
  ('teacher',        'Teaches one or more classes.', true),
  ('guardian',       'Parent or guardian of a student.', true),
  ('content_author', 'Authors educational content.', true),
  ('reviewer',       'Reviews content for accuracy.', true),
  ('moderator',      'Moderates community content.', true),
  ('admin',          'Administers an organization.', true),
  ('security_admin', 'Administers security and account lifecycle.', true);

INSERT INTO permissions (name, resource, action, description) VALUES
  ('notes:read',        'notes',    'read',    'Read a note.'),
  ('notes:create',      'notes',    'create',  'Create a note.'),
  ('notes:update',      'notes',    'update',  'Update a note.'),
  ('notes:delete',      'notes',    'delete',  'Delete a note.'),
  ('users:read',        'users',    'read',    'Read a user record.'),
  ('users:update',      'users',    'update',  'Update a user record.'),
  ('users:suspend',     'users',    'suspend', 'Suspend or reinstate a user.'),
  ('users:list',        'users',    'list',    'List users within scope.'),
  ('profiles:read',     'profiles', 'read',    'Read a profile.'),
  ('profiles:update',   'profiles', 'update',  'Update a profile.'),
  ('roles:assign',      'roles',    'assign',  'Grant or revoke a role.'),
  ('classes:manage',    'classes',  'manage',  'Manage a class and its membership.'),
  ('students:read',     'students', 'read',    'Read information about an assigned student.');

-- Baseline role→permission mapping.
--
-- NOTE: a permission is NECESSARY, never SUFFICIENT. Object-level authorization
-- still runs for every request — holding `notes:read` does not grant access to
-- any particular note. See docs/security/authorization.md.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE (r.name = 'student'        AND p.name IN ('notes:read','notes:create','notes:update','notes:delete','profiles:read','profiles:update'))
   OR (r.name = 'teacher'        AND p.name IN ('notes:read','students:read','profiles:read','classes:manage'))
   OR (r.name = 'guardian'       AND p.name IN ('notes:read','students:read','profiles:read'))
   OR (r.name = 'content_author' AND p.name IN ('profiles:read','profiles:update'))
   OR (r.name = 'reviewer'       AND p.name IN ('profiles:read'))
   OR (r.name = 'moderator'      AND p.name IN ('profiles:read'))
   OR (r.name = 'admin'          AND p.name IN ('users:read','users:update','users:list','profiles:read','roles:assign','classes:manage'))
   OR (r.name = 'security_admin' AND p.name IN ('users:read','users:list','users:suspend','roles:assign'));

-- ---------------------------------------------------------------------
-- Privileges. As in 0001, `edu_app` gets NO write access to role grants:
-- privilege escalation stays impossible through ordinary application code.
-- ---------------------------------------------------------------------
GRANT SELECT ON roles TO edu_app;
GRANT SELECT ON permissions TO edu_app;
GRANT SELECT ON role_permissions TO edu_app;
GRANT SELECT ON user_roles TO edu_app;

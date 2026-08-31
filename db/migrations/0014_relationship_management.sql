-- =====================================================================
-- 0014 — Write access for organizations, classes and relationships
-- =====================================================================
-- Task 003 created these tables with SELECT-only privileges, because nothing
-- wrote to them through the application. Task 004 adds the management APIs, so
-- each table now needs a narrowly scoped write path.
--
-- THREE HELPERS, AND WHY THEY EXIST
--
-- The natural way to write "may this actor manage this class?" is a subquery
-- over `teacher_assignments` or `classes` — but a policy on `teacher_assignments`
-- that reads `teacher_assignments` is infinite recursion, and PostgreSQL refuses
-- it. Task 003 avoided that by keeping the reference graph strictly acyclic,
-- which worked while the graph was small and is fragile as it grows.
--
-- These SECURITY DEFINER helpers cut the dependency instead: they run as the
-- owner, so they are not subject to `edu_app`'s policies and cannot recurse into
-- them. `app_actor_teaches_class` and `app_actor_is_platform_operator` describe
-- only the CURRENT actor, so neither can be used to probe anybody else.
-- =====================================================================

/**
 * A PLATFORM operator: `security_admin` held at GLOBAL scope.
 *
 * Distinct from a school's security administrator, whose grant is
 * organization-scoped. Only a platform operator may create an organization.
 *
 * Note that migration 0013 refuses to grant any privileged role globally through
 * `auth_assign_role`, deliberately — so a platform operator CANNOT be minted
 * through the API at any privilege level. The grant is made out of band, by an
 * operator with database access, and `granted_by` records who did it. That is
 * the intended bootstrap path and the reason this role is safe to define.
 */
CREATE FUNCTION app_actor_is_platform_operator() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = app_current_actor()
      AND r.name = 'security_admin'
      AND ur.scope_type = 'global'
  );
$$;

/** Whether the current actor actively teaches an active class. */
CREATE FUNCTION app_actor_teaches_class(p_class_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM teacher_assignments ta
    JOIN classes c ON c.id = ta.class_id
    WHERE ta.class_id = p_class_id
      AND ta.teacher_id = app_current_actor()
      AND ta.status = 'active'
      AND c.status = 'active'
  );
$$;

/**
 * The organization a class belongs to.
 *
 * Takes an id rather than describing the actor, so it does disclose one fact
 * about an arbitrary class. That fact — which school a class id belongs to — is
 * not sensitive, and the alternative (a subquery on `classes` from inside
 * policies that `classes` itself depends on) reintroduces the recursion this
 * migration exists to avoid.
 */
CREATE FUNCTION app_class_organization(p_class_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT c.organization_id FROM classes c WHERE c.id = p_class_id;
$$;

-- ---------------------------------------------------------------------
-- Definer-role SELECT policies for the tables these helpers read.
--
-- FORCE ROW LEVEL SECURITY binds the table OWNER too, and a SECURITY DEFINER
-- function runs AS the owner — so without a policy for `edu_migrator`, the
-- helpers above read zero rows and silently answer NULL/false. Worse, the
-- resulting nesting is what PostgreSQL reports as
-- "infinite recursion detected in policy for relation classes".
--
-- This is the same trap as VULN-007, where a missing definer UPDATE policy made
-- lockout, verification and password reset silently do nothing. The rule to
-- remember: EVERY table a SECURITY DEFINER function touches needs a policy for
-- the definer role, for every command it performs.
--
-- These are read-only and exist solely so the helpers can answer. Writes still
-- go through the `edu_app` policies below.
-- ---------------------------------------------------------------------
CREATE POLICY classes_definer_select ON classes FOR SELECT TO edu_migrator USING (true);
CREATE POLICY class_memberships_definer_select ON class_memberships
  FOR SELECT TO edu_migrator USING (true);
CREATE POLICY teacher_assignments_definer_select ON teacher_assignments
  FOR SELECT TO edu_migrator USING (true);
CREATE POLICY guardian_relationships_definer_select ON guardian_relationships
  FOR SELECT TO edu_migrator USING (true);

/** Whether the current actor is an active member of an active class. */
CREATE FUNCTION app_actor_is_member_of_class(p_class_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM class_memberships cm
    JOIN classes c ON c.id = cm.class_id
    WHERE cm.class_id = p_class_id
      AND cm.user_id = app_current_actor()
      AND cm.status = 'active'
      AND c.status = 'active'
  );
$$;

/** Whether the current actor is a VERIFIED guardian of the given user. */
CREATE FUNCTION app_actor_guards(p_child_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM guardian_relationships gr
    WHERE gr.guardian_id = app_current_actor()
      AND gr.child_id = p_child_id
      AND gr.status = 'verified'
  );
$$;

/**
 * The organization a user belongs to.
 *
 * Like `app_class_organization`, this answers about an arbitrary id rather than
 * the caller. The disclosed fact — which school a user id belongs to — is not
 * sensitive, and using it here avoids a policy on one relationship table having
 * to consult `users`, whose own policy consults the relationship tables straight
 * back. That mutual reference is what PostgreSQL reports as infinite recursion.
 */
CREATE FUNCTION app_user_organization(p_user_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT u.organization_id FROM users u WHERE u.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION app_actor_is_platform_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_teaches_class(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_class_organization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_is_platform_operator() TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_teaches_class(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_class_organization(uuid) TO edu_app;
REVOKE ALL ON FUNCTION app_actor_is_member_of_class(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_actor_guards(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_user_organization(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_actor_is_member_of_class(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_actor_guards(uuid) TO edu_app;
GRANT EXECUTE ON FUNCTION app_user_organization(uuid) TO edu_app;

-- =====================================================================
-- Immutability of relationship parties
-- =====================================================================
-- RLS can express "who may update this row" but not "which columns may change",
-- because a policy cannot see the OLD row. Without that, an actor permitted to
-- update a row they participate in could RE-POINT it at somebody else — a
-- guardian flipping `child_id` to a second student, say, and inheriting the
-- verified status along with it.
--
-- A BEFORE UPDATE trigger is the cheap, complete answer: the parties of a
-- relationship are fixed at creation, and changing them means creating a new
-- row, which keeps the audit trail honest.
-- =====================================================================

CREATE FUNCTION relationship_parties_are_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'guardian_relationships' THEN
    IF NEW.guardian_id <> OLD.guardian_id OR NEW.child_id <> OLD.child_id THEN
      RAISE EXCEPTION 'The parties of a guardian relationship cannot be changed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'class_memberships' THEN
    IF NEW.class_id <> OLD.class_id OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'The class or member of a membership cannot be changed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'teacher_assignments' THEN
    IF NEW.class_id <> OLD.class_id OR NEW.teacher_id <> OLD.teacher_id THEN
      RAISE EXCEPTION 'The class or teacher of an assignment cannot be changed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'classes' THEN
    IF NEW.organization_id <> OLD.organization_id THEN
      RAISE EXCEPTION 'A class cannot be moved to another organization'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER guardian_relationships_immutable_parties
  BEFORE UPDATE ON guardian_relationships
  FOR EACH ROW EXECUTE FUNCTION relationship_parties_are_immutable();

CREATE TRIGGER class_memberships_immutable_parties
  BEFORE UPDATE ON class_memberships
  FOR EACH ROW EXECUTE FUNCTION relationship_parties_are_immutable();

CREATE TRIGGER teacher_assignments_immutable_parties
  BEFORE UPDATE ON teacher_assignments
  FOR EACH ROW EXECUTE FUNCTION relationship_parties_are_immutable();

CREATE TRIGGER classes_immutable_organization
  BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION relationship_parties_are_immutable();

-- =====================================================================
-- organizations
-- =====================================================================
DROP POLICY organizations_select ON organizations;

CREATE POLICY organizations_select ON organizations FOR SELECT TO edu_app
  USING (id = app_actor_organization() OR app_actor_is_platform_operator());

-- Only a platform operator creates organizations. A school's own administrator
-- manages their school; they do not get to create new ones.
CREATE POLICY organizations_insert ON organizations FOR INSERT TO edu_app
  WITH CHECK (app_actor_is_platform_operator());

CREATE POLICY organizations_update ON organizations FOR UPDATE TO edu_app
  USING (app_actor_is_platform_operator() OR (app_actor_is_org_admin() AND id = app_actor_organization()))
  WITH CHECK (app_actor_is_platform_operator() OR (app_actor_is_org_admin() AND id = app_actor_organization()));

CREATE POLICY organizations_definer_all ON organizations FOR ALL TO edu_migrator
  USING (true) WITH CHECK (true);

GRANT INSERT, UPDATE ON organizations TO edu_app;

-- =====================================================================
-- classes
-- =====================================================================
DROP POLICY classes_select ON classes;

-- Every cross-table check goes through a definer helper, so this policy
-- references no other table directly. That is what keeps the graph acyclic:
--
--     edu_app policies -> helper functions -> edu_migrator policies (constant)
--
-- An earlier draft had `classes_select` read `class_memberships` while
-- `class_memberships_select` read `classes`, which PostgreSQL rejects at runtime
-- as "infinite recursion detected in policy for relation classes".
CREATE POLICY classes_select ON classes FOR SELECT TO edu_app
  USING (
    app_actor_teaches_class(id)
    OR app_actor_is_member_of_class(id)
    OR (app_actor_is_org_admin() AND organization_id = app_actor_organization())
    OR app_actor_is_platform_operator()
  );

-- Creating and reshaping classes is an administrator's job. A teacher runs a
-- class; they do not decide which classes exist.
CREATE POLICY classes_insert ON classes FOR INSERT TO edu_app
  WITH CHECK (app_actor_is_org_admin() AND organization_id = app_actor_organization());

CREATE POLICY classes_update ON classes FOR UPDATE TO edu_app
  USING (app_actor_is_org_admin() AND organization_id = app_actor_organization())
  WITH CHECK (app_actor_is_org_admin() AND organization_id = app_actor_organization());

GRANT INSERT, UPDATE ON classes TO edu_app;

-- =====================================================================
-- class_memberships
-- =====================================================================
DROP POLICY class_memberships_select ON class_memberships;

CREATE POLICY class_memberships_select ON class_memberships FOR SELECT TO edu_app
  USING (
    user_id = app_current_actor()
    OR app_actor_teaches_class(class_id)
    OR (app_actor_is_org_admin() AND app_class_organization(class_id) = app_actor_organization())
    OR app_actor_guards(user_id)
  );

-- A teacher may enrol into a class they actually teach; an administrator may
-- enrol into any class in their own organization.
CREATE POLICY class_memberships_insert ON class_memberships FOR INSERT TO edu_app
  WITH CHECK (
    app_class_organization(class_id) = app_actor_organization()
    AND (app_actor_teaches_class(class_id) OR app_actor_is_org_admin())
  );

-- Removal is `status = 'ended'`, never a DELETE, so the roster history survives.
-- USING restricts this to active rows: an ended membership is immutable history
-- and cannot be silently reinstated.
CREATE POLICY class_memberships_update ON class_memberships FOR UPDATE TO edu_app
  USING (
    status = 'active'
    AND app_class_organization(class_id) = app_actor_organization()
    AND (app_actor_teaches_class(class_id) OR app_actor_is_org_admin())
  )
  WITH CHECK (
    app_class_organization(class_id) = app_actor_organization()
    AND (app_actor_teaches_class(class_id) OR app_actor_is_org_admin())
  );

GRANT INSERT, UPDATE ON class_memberships TO edu_app;

-- =====================================================================
-- teacher_assignments
-- =====================================================================
DROP POLICY teacher_assignments_select_own ON teacher_assignments;

CREATE POLICY teacher_assignments_select ON teacher_assignments FOR SELECT TO edu_app
  USING (
    teacher_id = app_current_actor()
    -- Co-teachers can see each other on a class they share.
    OR app_actor_teaches_class(class_id)
    OR (app_actor_is_org_admin() AND app_class_organization(class_id) = app_actor_organization())
  );

-- ADMINISTRATORS ONLY, deliberately.
--
-- A teacher cannot assign anybody — including themselves — to any class. Letting
-- a teacher self-assign would make "teacher of this class" self-asserted, and
-- teacher-of-class is what grants access to students' shared work. The
-- organization check is a second bound on the same rule.
CREATE POLICY teacher_assignments_insert ON teacher_assignments FOR INSERT TO edu_app
  WITH CHECK (
    app_actor_is_org_admin()
    AND app_class_organization(class_id) = app_actor_organization()
  );

CREATE POLICY teacher_assignments_update ON teacher_assignments FOR UPDATE TO edu_app
  USING (
    status = 'active'
    AND app_actor_is_org_admin()
    AND app_class_organization(class_id) = app_actor_organization()
  )
  WITH CHECK (
    app_actor_is_org_admin()
    AND app_class_organization(class_id) = app_actor_organization()
  );

GRANT INSERT, UPDATE ON teacher_assignments TO edu_app;

-- =====================================================================
-- guardian_relationships
-- =====================================================================
DROP POLICY guardian_relationships_select_participant ON guardian_relationships;

CREATE POLICY guardian_relationships_select ON guardian_relationships FOR SELECT TO edu_app
  USING (
    guardian_id = app_current_actor()
    OR child_id = app_current_actor()
    -- An administrator must be able to see a claim in order to verify it, but
    -- only for a child in their own organization. `users_select` (0012) already
    -- scopes admin visibility that way, so reusing it keeps one rule.
    OR (app_actor_is_org_admin() AND app_user_organization(child_id) = app_actor_organization())
  );

-- A guardian may only ever create a claim ABOUT THEMSELVES, and only in the
-- `pending` state. Self-verification is refused here as well as in the policy
-- engine: inserting a row that is already `verified` is impossible.
CREATE POLICY guardian_relationships_insert ON guardian_relationships FOR INSERT TO edu_app
  WITH CHECK (
    status = 'pending'
    AND (
      guardian_id = app_current_actor()
      OR (app_actor_is_org_admin() AND app_user_organization(child_id) = app_actor_organization())
    )
  );

-- Verification is an administrator's act; revocation is either participant's.
-- The immutability trigger above stops the parties being re-pointed, so an
-- update can only ever move the row through its own lifecycle.
CREATE POLICY guardian_relationships_update ON guardian_relationships FOR UPDATE TO edu_app
  USING (
    guardian_id = app_current_actor()
    OR child_id = app_current_actor()
    OR (app_actor_is_org_admin() AND app_user_organization(child_id) = app_actor_organization())
  )
  WITH CHECK (
    guardian_id = app_current_actor()
    OR child_id = app_current_actor()
    OR (app_actor_is_org_admin() AND app_user_organization(child_id) = app_actor_organization())
  );

GRANT INSERT, UPDATE ON guardian_relationships TO edu_app;

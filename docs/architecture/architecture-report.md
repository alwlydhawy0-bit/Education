# Architecture Report — Task 001

**Status:** Foundation established. Product features deliberately not built.
**Date:** 2026-08-30
**Scope:** Repository audit, architecture, security boundaries, and a working
foundation with executable evidence.

> **How to read this document.** Every claim is marked with what backs it.
>
> | Marker                | Meaning                                                                 |
> | --------------------- | ----------------------------------------------------------------------- |
> | **[BUILT]**           | Implemented in this repository and covered by a test that was executed. |
> | **[BUILT, UNTESTED]** | Implemented, but no automated test proves it.                           |
> | **[DESIGNED]**        | Decided and documented. No code exists yet.                             |
> | **[OPEN]**            | Not decided. Named here so it is not mistaken for settled.              |
>
> Nothing in this document should be read as a claim that the system is secure.
> See [`docs/security/limitations.md`](../security/limitations.md) for what was
> **not** tested and what remains unknown.

---

## 1. Current state

The repository was **empty** at the start of this task: no commits, no remote
branches, no code, no configuration. Verified with `git log` (fatal: no commits),
`git ls-remote` (no refs), and a directory listing (`.git` only).

There was therefore no existing implementation to audit, no framework already
chosen, no technical debt inherited, and no migration path to preserve. Section
27's audit branch did not apply; the design branch did.

What exists now is described in section 3 onward.

## 2. Architecture assessment

With no prior code, the assessment is of the _problem_, not of an existing
system. Three properties of this problem drove every subsequent decision:

1. **The data is a minor's private work.** Student notebooks, research drafts,
   assessment results and AI conversations belong to children. Privacy is not a
   compliance checkbox here; it is the product's duty of care. This is why an
   administrator has no implicit read access to note content
   (§8, and `notePolicy`).

2. **The authorization model is relational, not role-flat.** "A teacher" is
   never a sufficient answer — it is always _this teacher, of this student, in
   this organization, while the assignment is active_. A design that reduces
   authorization to a role column would need to be torn out later. This is why
   relationships are first-class tables and first-class policy inputs.

3. **The domain list is long and mostly unwritten.** Section 7 of the brief
   names ~30 domains; this task builds three. The architecture's job is to make
   domains 4 through 30 cheap to add and impossible to entangle. That is what
   the dependency rules and the fitness tests are for.

## 3. Recommended architecture

**A modular monolith**, deployed as one API process plus one static frontend,
with strict internal boundaries.

```
  apps/web            React + Vite. Arabic-first, RTL by default.
      │  HTTP only (no database access, ever)
      ▼
  apps/api            Fastify. One process, many modules.
      ├── platform/   Infrastructure: config, db, http, audit, crypto.
      └── modules/    Domain modules. identity | relationships | notebook
      │
      ▼
  packages/           Pure, dependency-free libraries.
      ├── kernel      Result, errors, clock, event bus.
      ├── authz       Policy engine, Guarded<T>. NO I/O.
      ├── contracts   Zod schemas shared by client and server.
      └── observability  Redacting logger, security-event taxonomy.
      │
      ▼
  PostgreSQL          Normalized schema + Row-Level Security.
```

**Why not microservices.** The brief asks for scale-readiness, not distribution.
Splitting three domains across services today would buy network partitions,
distributed transactions and eventual-consistency bugs, in exchange for scaling
properties nobody needs yet. The extraction path is kept open by the dependency
rules (a module never imports another module), and that openness is enforced by
a test rather than by intent — see
[`dependency-rules.md`](./dependency-rules.md) and ADR
[0001](./adr/0001-modular-monolith.md).

**[BUILT]** — the structure above exists and the boundaries are enforced by
`tests/architecture/dependency-rules.test.ts` (16 assertions, executed).

## 4. Domain boundaries

Full detail in [`domain-boundaries.md`](./domain-boundaries.md). Summary:

| Domain                                             | Owns (tables)                           | Status                         |
| -------------------------------------------------- | --------------------------------------- | ------------------------------ |
| `identity`                                         | `users`, `user_roles`, `sessions`       | **[BUILT]**                    |
| `relationships`                                    | `guardian_links`, `teacher_assignments` | **[BUILT]**                    |
| `notebook`                                         | `notes`                                 | **[BUILT]**                    |
| curriculum, assessments, experiments, files, AI, … | —                                       | **[DESIGNED]** boundaries only |

A domain owns its tables exclusively. No other module may query them; access is
through a contract the owning module exposes. `notebook` never reads
`guardian_links` — it receives a `RelationshipSnapshot`.

## 5. Dependency rules

Full detail in [`dependency-rules.md`](./dependency-rules.md).

```
  web → api(http) → modules → platform → packages → (nothing)
```

Five rules, all machine-enforced **[BUILT]**:

1. Pure packages (`kernel`, `authz`, `contracts`) import no infrastructure —
   no `pg`, no `fastify`, no `node:fs`, no network.
2. `platform` never imports from `modules`. It declares the interfaces it needs
   (`SessionAuthenticator`, `RelationshipLoader`); the composition root supplies
   implementations.
3. No module imports another module.
4. Only `app.ts` (the composition root) wires more than one module.
5. HTTP/route files never touch the database, and never construct an `Actor`.

Plus two structural rules: protected repositories return `Guarded<T>`, and only
`platform/db.ts` constructs a connection pool.

## 6. Data ownership rules

- One writer per table: the owning module.
- Cross-domain reads go through a contract, never a join into foreign tables.
- Denormalization is allowed where a database-level policy needs it, and must be
  justified in a comment. There is exactly one instance today: `notes.
organization_id`, copied from the owner so the RLS policy can evaluate the
  organization check without joining `users` (which would make the policy
  recursive, since `users` is itself protected).
- **[OPEN]** How that denormalized column is kept correct when a student
  transfers organizations. No transfer flow exists yet; when one is built it
  must update existing notes in the same transaction, or the column must become
  a lookup. Recorded in [`limitations.md`](../security/limitations.md).

## 7. Authentication architecture

**[BUILT]**

- **Passwords:** Argon2id, parameters pinned explicitly (m=19456 KiB, t=2, p=1 —
  the OWASP baseline) rather than left to library defaults, so a dependency
  upgrade cannot silently weaken them.
- **Sessions:** opaque 32-byte CSPRNG tokens, base64url. **Only the SHA-256 is
  stored** — a database disclosure yields no usable credential (proven by
  `session-hardening.test.ts`). SHA-256 is the right choice here because the
  token is high-entropy; there is nothing to brute-force.
- **Not JWTs.** A JWT cannot be revoked before it expires. For a platform
  serving minors, immediate revocation (compromised account, guardian request,
  moderator action) outweighs saving a database lookup. ADR
  [0005](./adr/0005-opaque-sessions.md).
- **Expiry and revocation are enforced in SQL**, inside `auth_resolve_session`.
  Application code cannot accidentally accept an expired session, because an
  expired session produces no row.
- **Enumeration resistance:** login runs a real Argon2 verification even when
  the account does not exist (against a fixed dummy hash), so response timing
  does not reveal which emails are registered. Unknown account, wrong password
  and suspended account return an identical 401.
- **Known gap:** registration returns 409 on a duplicate email, which _is_
  account enumeration. Accepted deliberately, compensated by rate limiting,
  tracked as RISK-ENUM-01 in the [threat model](../security/threat-model.md).

## 8. Authorization architecture

Full detail in [`authorization.md`](../security/authorization.md).

**Two independent gates, both required.**

| Gate               | Where            | Strength                                                             | Weakness                                            |
| ------------------ | ---------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| Policy engine      | `packages/authz` | Expressive; produces an auditable reason; exhaustively unit-testable | Only protects paths that call it                    |
| Row-Level Security | PostgreSQL       | Protects _every_ query, including ones nobody has written yet        | Cannot express everything; invisible in code review |

Neither is trusted alone, and this is not a slogan — each is tested _with the
other removed_:

- `tests/integration/rls.test.ts` queries the database directly, with no
  application code in the path. **[BUILT]** 24 tests.
- `tests/security/layered-defense.test.ts` runs the whole application against a
  role holding `BYPASSRLS`, and asserts cross-user access is _still_ refused.
  **[BUILT]** 4 tests, including one that verifies the bypass role really does
  bypass RLS — otherwise the suite would pass vacuously.

**Model:** RBAC + resource ownership + relationship context. Roles are rows in
`user_roles`, not a column, because a user can be both a teacher and a guardian.
Default deny; global pre-checks (suspended, unverified, no roles) can only
_remove_ access, never grant it.

**Privilege escalation is blocked at the database.** `edu_app` holds no write
privilege on `user_roles` at all. The only function that writes to it hardcodes
`'student'`, and an RLS policy independently restricts that insert to
`role = 'student'`. Three layers, verified.

## 9. IDOR / BOLA protection strategy

The centrepiece. Four layers:

1. **The contract has no field to attack.** Create/update schemas carry no
   `ownerId` and no `id`, and are `.strict()` — an extra field is a 400, not a
   silently ignored value. Ownership comes from the session.
2. **`Guarded<T>` makes the bug structural.** Repositories return
   `Guarded<NoteRecord>`, not `NoteRecord`. Reading the payload requires an
   allow-decision, and `unwrap` re-verifies the decision was made for _this
   resource id_ and _this action_. Authorizing one object and returning another
   — the exact shape of an IDOR bug — throws instead of leaking. **[BUILT]**
3. **One authorization funnel per domain.** Every individual-note operation goes
   through `authorizeNote`, so there is a single place to review.
4. **RLS backstops the lot.** A forgotten `WHERE owner_id = …` returns zero
   rows, proven by an explicit "unfiltered SELECT \*" test.

**Existence disclosure:** denials that hide existence return **404, not 403**.
403 would confirm that an id names a real object — the exact signal an enumerator
wants. A test asserts a real-but-forbidden note and a nonexistent note are
byte-for-byte indistinguishable.

**Detection:** every denial writes an `authz.denied` audit event — _including_
denials where RLS hid the row before the policy engine ran. Without that, id
enumeration blocked by RLS would produce no security signal at all. This gap was
found by a failing test during this task; see the
[vulnerability log](../security/vulnerability-log.md), VULN-002.

## 10. File security strategy

**[DESIGNED]** — no upload code exists. Detail in
[`file-security.md`](../security/file-security.md).

Pipeline: `upload → quarantine → validate → scan → safe store → parse → index`.
Nothing is served from the quarantine bucket; a file becomes reachable only
after scanning succeeds. Type is decided by **magic bytes**, never by extension,
filename, or client `Content-Type`. Files are served from a separate origin with
`Content-Disposition: attachment`, never executed, never rendered inline.

**No malware scanning exists today.** Stating that plainly because the brief
forbids implying otherwise.

## 11. AI security architecture

**[DESIGNED]** — no AI code exists. Detail in
[`ai-security.md`](../security/ai-security.md).

Two separate products (AI Tutor, AI Assistant), one mandatory **AI Gateway**.
The load-bearing rules:

- The frontend never names a tool, a model, or a context document. It sends an
  intent; the gateway decides.
- **Retrieval is filtered by authorization _before_ similarity, not after.**
  Semantic relevance must never widen access. This is the RAG equivalent of
  IDOR, and it is the single most likely way this platform would leak student
  data at scale.
- Retrieved document text is **data, never instructions**. Prompt injection is
  assumed, not hoped against: tools are authorized against the _user's_ actor,
  so an injected instruction cannot reach anything the user could not.

## 12. Knowledge / RAG architecture

**[DESIGNED]**. Ingestion: `parse → OCR (if needed) → clean → chunk → embed`,
with provenance retained per chunk (source document, version, page) so every
answer can cite. Every chunk carries an access-scope tag; retrieval filters on it
in the query, not in post-processing. Student-uploaded material is scoped to the
uploader by default and is never mixed into another student's retrieval set.

## 13. Database strategy

**[BUILT]** — PostgreSQL 16, normalized, with integrity enforced in the schema.

- Foreign keys, unique indexes, and CHECK constraints throughout. No giant JSON
  blob of student state. `audit_log.detail` is the only JSONB column, and it is
  size-capped.
- Constraints encode _authorization invariants_, not just tidiness: self-
  guardianship is impossible; a `verified` guardian link must record when it was
  verified; an `ended` assignment must record when it ended. Access is granted on
  those statuses, so status and evidence must not drift. **21 constraint tests.**
- **Roles:** `edu_migrator` owns the schema (non-superuser); `edu_app` runs the
  application with `NOBYPASSRLS` and the narrowest grants that work. The
  application never connects as a superuser — a superuser bypasses RLS entirely.
- **`FORCE ROW LEVEL SECURITY`** on every table, so policies bind the owner too.
- **Migrations are immutable once applied**, enforced by a SHA-256 checksum in
  the runner. Verified in practice during this task: editing an applied migration
  was rejected.
- **The pre-authentication boundary** is five `SECURITY DEFINER` functions with
  pinned `search_path`, `EXECUTE` revoked from `PUBLIC`. They are the only way
  to touch data before an actor exists.

## 14. Frontend strategy

**[BUILT]** — foundation only; no product UI, as section 28 requires.

Feature-oriented (`app/`, `shared/`, `features/`). Arabic is the default locale
and `dir="rtl"` ships in the served HTML rather than being applied after
hydration, so there is no left-to-right flash and the document is correct for
assistive technology even if the bundle fails. Direction is _derived_ from locale
so the two cannot drift. One API client; no feature calls `fetch` directly. No
global store — locale is UI state in its own small context, and server state will
get a separate cache. 11 i18n tests, including one asserting the Arabic
catalogue really is Arabic (a silent English fallback would be invisible to a
non-Arabic-speaking reviewer).

## 15. API strategy

**[BUILT]** — `/api/v1/…`. Versioned from the first endpoint, so a breaking
change has somewhere to go.

Contracts live in `packages/contracts` and are used by both sides, so client and
server cannot drift without a type error. Requests are validated on the way in;
`/auth/me` is validated on the way **out** as well, so a column accidentally
added to a query (a password hash) becomes a loud 500 rather than a silent
disclosure. Errors expose a stable `code` and a correlation id — never a stack
trace, SQL text, or driver message.

## 16. Testing strategy

**[BUILT]** — 208 tests, all executed. Detail in
[`testing-strategy.md`](../testing-strategy.md).

| Layer        | Count | Proves                                                               |
| ------------ | ----- | -------------------------------------------------------------------- |
| unit         | 112   | Policy decision table, `Guarded`, redaction, contracts, config, i18n |
| architecture | 16    | Dependency rules hold                                                |
| integration  | 45    | Schema, constraints, RLS against real PostgreSQL                     |
| security     | 35    | IDOR/BOLA, layer isolation, session, CSRF, audit, rate limiting      |

Security tests are a **named project**, so CI can gate on them specifically and
nobody can quietly drop them by editing an unrelated glob.

## 17. CI/CD strategy

**[BUILT]** — detail in [`cicd.md`](../cicd.md). Three jobs: static analysis,
supply chain (secret scan + `pnpm audit`, failing on high/critical), and
database-backed integration/security suites against a real PostgreSQL service.
Plus CodeQL on push, PR, and weekly schedule.

The provisioning script `tools/ci/setup-test-db.sh` was **executed locally** and
the full suite passes against the database it creates — the pipeline is not an
untested YAML file. The GitHub-hosted run itself has not executed yet.

## 18. Observability strategy

**[BUILT]** — structured JSON logs with **mandatory** redaction: there is no
raw-log escape hatch, and `child()` bindings are redacted too. Deny-list by
normalized key name (`apiKey`, `api_key`, `X-API-KEY` all collapse) plus
value-shape detection for bearer tokens, PEM blocks and session-token-shaped
strings. A closed `SecurityEventType` enum feeds an append-only `audit_log` that
the application role **cannot read back or amend**.

**Known limitation:** redaction cannot catch a secret pasted inside free text.
The mitigation is not logging user content at all.

## 19. Scalability strategy

**[DESIGNED]**, with the foundations **[BUILT]**: the API is stateless (sessions
live in PostgreSQL), so horizontal scaling needs no sticky sessions. Connection
pooling is centralized. Indexes are placed for the access patterns the policies
actually use, including partial indexes for the shared-note lookups.

Sequenced for when load justifies it, not before: read replicas for analytics →
caching (with authorization applied _before_ the cache, never after) → extracting
a hot domain into its own service along the existing module seam.

## 20. Extensibility strategy

Adding a domain is a fixed, small recipe: create `modules/<domain>/`, add its
tables in a new migration with RLS policies, add a policy file and register it in
the engine, wire it in `app.ts`, add tests. **No existing domain is edited.** The
policy registry is keyed by resource kind precisely so a new domain never means
touching another domain's rules.

Provider abstraction **[DESIGNED]**: AI providers, object storage, search, vector
store and email each get an interface owned by the consuming domain, with
adapters in `platform/`. None exist yet — there is nothing to abstract until
there is a second implementation, and premature interfaces are their own kind of
debt.

Feature flags **[DESIGNED]**, **[OPEN]** as to mechanism. Nothing is built.

## 21. Risks

Full register in the [threat model](../security/threat-model.md). The five that
would keep me up:

| #   | Risk                                                            | Status                                                                  |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | RAG retrieval leaking another student's material via similarity | **[DESIGNED]** mitigation only; the highest-consequence unbuilt control |
| 2   | Malicious uploads — no scanning exists                          | **[DESIGNED]** only                                                     |
| 3   | Prompt injection reaching privileged tools                      | **[DESIGNED]** only                                                     |
| 4   | Account enumeration at registration                             | **[BUILT]**, accepted, compensated                                      |
| 5   | Denormalized `notes.organization_id` going stale on transfer    | **[OPEN]**                                                              |

## 22. Technical debt

Taken deliberately, and small:

- No email pipeline, so registration cannot use the non-enumerating flow.
- No break-glass path for administrators. Deliberate: today an admin simply
  cannot read note content. When one is built it must be audited and time-boxed.
- No admin/moderation endpoints, so the `admin` and `security_admin` role paths
  in `userPolicy` are unit-tested but not exercised end-to-end.
- The secret scanner is homegrown. It should be replaced by gitleaks; it exists
  so the gate is real today.
- No API documentation generation (OpenAPI) yet.
- No load or performance testing of any kind.

## 23. Proposed implementation sequence

1. **File upload security pipeline** — recommended next; see the closing section
   of the task response for why.
2. Curriculum and content domain (courses, lessons, modules).
3. AI Gateway skeleton (authorization, rate limiting, logging) with no provider.
4. Knowledge base ingestion + authorization-filtered retrieval.
5. AI Tutor on top of the gateway.
6. Assessments and mastery.
7. Experiments/simulation engine.
8. Teacher and guardian surfaces (the first heavy use of relationship policies).
9. Admin, moderation, and the audited break-glass path.
10. Community features (highest moderation burden — deliberately last).

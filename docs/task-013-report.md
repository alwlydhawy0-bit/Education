# Task 013 — Student projects, research artifacts and verifiable portfolios

**Status: COMPLETE for the server. There is no user interface, and none was
built.** This task introduced the platform's first unauthenticated content
route, which is the fact that shapes every section below.

Vocabulary: **VERIFIED** — measured here. **PARTIALLY VERIFIED** — measured in
one layer only. **UNVERIFIED** — not measured. **OPEN RISK** — known and
accepted.

---

## 1. IMPLEMENTED

| Layer          | File                                                          |
| -------------- | ------------------------------------------------------------- |
| Schema         | `db/migrations/0028_projects_and_portfolios.sql` (937 lines)   |
| Public boundary| `apps/api/src/modules/portfolio/public-view.ts`                |
| Authorization  | `packages/authz/src/policies/portfolio.policy.ts`              |
| Contract       | `packages/contracts/src/portfolio.contract.ts`                 |
| API            | `apps/api/src/modules/portfolio/` — repository, service, routes|
| Events         | 3 new `SecurityEventType` members                              |
| Rate limits    | `portfolio.public` (60/15min), `project.write` (120/15min)     |
| Docs           | `docs/api/projects-portfolios.md`, ADR 0011                    |

Four tables, seventeen routes, one of which has no `requireActor`.

### The five decisions that shaped everything

1. **The public path never touches the policy engine.** A stranger has no
   actor, so there is no `AuthorizationContext` to evaluate. A public branch in
   the policy would be a second place deciding publication that could never be
   exercised by the gate that normally decides. The boundary is held by RLS
   keyed on a transaction-local GUC, plus a pure constructor.

2. **The sanitizer is a constructor, not a filter.** `toPublicPortfolio` builds
   a new object out of named pieces. A filter is a deny-list — the column added
   next year arrives on the public page by default. A constructor is an
   allow-list, and adding a field is the diff a reviewer gets to object to.

3. **A reviewer's authority is exactly one column wide.** A teacher may move
   `status` to `featured`. Not the title, not the description, and above all not
   `visibility` — a teacher cannot publish a child's work to the world on their
   behalf. Written in four places, because the probe used the featuring policy
   to rewrite a child's description and read back "Teacher wrote this".

4. **Ownership is a composite foreign key.** Putting another child's project in
   your portfolio is not refused by a policy somebody could edit; the row has no
   parent and cannot exist.

5. **Revocation rotates.** Unpublishing sets the flag false *and* mints a new
   `share_token`, in a trigger rather than in the service. That is the
   difference between "the flag is off" and "every link ever handed out is
   dead".

---

## 2. VERIFIED

| Requirement (§2, §3)                                          | Status | Evidence |
| ------------------------------------------------------------- | ------ | -------- |
| Four tables with the named constraints and indexes             | VERIFIED | 0028; unique on `public_slug`, `share_token`, `student_id`; 4 indexes |
| Students CRUD only their own projects                          | VERIFIED | 29 RLS + 59 HTTP + 9 RLS-off cases |
| Class members and teachers read shared class projects          | VERIFIED | Classmate needs `visibility` AND shared class AND not-draft |
| Public read via `share_token` or `public_slug`                 | VERIFIED | One route, both keys, anonymous, `withoutActor` |
| Strict zero-leakage on the public boundary                     | VERIFIED | Body searched by VALUE for every id, org, class, token, email |
| Hidden/draft items never leak, ids included                    | VERIFIED | RLS + HTTP; the probe's original 3-of-1 finding is pinned |
| Teachers and admins feature and review within their org        | VERIFIED | Teacher-of-this-class or org admin; a teacher of another class gets 404 |
| Nine required endpoints                                        | VERIFIED | Plus artifacts, feature, publish/unpublish, item removal |
| Sanitized DTO preventing internal ids, emails, private metadata| VERIFIED | Constructor + `.strict()` response schema + fitness functions |
| Strict URL regex on `repository_url` / `live_demo_url`         | VERIFIED | `https://` allow-list of one, three layers; 9 attack shapes |
| Byte caps on project artifacts                                 | VERIFIED | 25 MiB in contract and `CHECK`; the numbers are asserted equal |
| Revocation on unpublish                                        | VERIFIED | Token rotated; old link 404s; republishing does not resurrect it |
| Revocation on visibility change to private                     | VERIFIED | Off the live page on the next request |
| Public page under a REAL browser / renderer                    | **UNVERIFIED** | No UI exists (RISK-PF-03) |
| Behaviour of external links a learner publishes                | **UNVERIFIED** | Scheme-validated only (RISK-PF-05) |

---

## 3. SECURITY

**The public route is the whole security story, and it runs with no actor by
construction.** `resolvePublic` takes no `ActorContext` and calls
`db.withoutActor` even when the request carries a valid session. If it ran as
the caller, a learner opening their own share link would see their private and
draft projects on the page and conclude that is what strangers see — the page
would under-report what is hidden, to the one person deciding what to publish.
The suite asserts the owner's response is byte-identical to a stranger's.

**Two gates, including here — and that took a correction.** The public query
originally had no `WHERE` clause, on the reasoning that RLS matches the key and
duplication causes drift. Run against `edu_app_norls` it returned whichever
portfolio was first, to anybody, for any key (VULN-056). The repository now asks
the same predicate from the same GUC. The key is still never an argument, so
there is no value that can point the query at a different portfolio.

**A `share_token` is a capability; a `public_slug` is a name.** They are treated
identically by the policies — they differ only in how somebody comes to know
them — but not by the threat model. The token is 256 bits and unguessable; the
slug is guessable, which is what makes the public route the tightest-limited
read on the platform and the only one with an enumeration audit event.

**The audit trail never carries a key.** A valid token in a log is a working
capability sitting in a file more people can read than the page it opens. Only
its *shape* is recorded, because a burst of slug-shaped misses is somebody
walking the namespace and a token-shaped miss is not.

**A draft is absent from every adult, not merely read-only.** A draft is work in
progress that nobody has offered; a supervisor reading one is reading over a
child's shoulder. Submitting is the act that consents.

**Unpublishing is refused for nothing.** Not for an empty portfolio, not for an
already-unpublished one. A child who wants their work off the internet must not
meet a policy that argues with them. Publishing *is* refused when nothing public
is in the portfolio, because the alternative is a live URL showing a blank page
to somebody the child invited.

**No author name reaches the public page.** It was implemented, and removed —
see VULN-055 and §9.

---
## 4. IDOR / BOLA matrix

Over real HTTP in `tests/security/portfolio.test.ts` (60 cases). Letters match
the `IDOR-<letter>` markers in the file.

| #   | Attempt                                                          | Result | Refused by |
| --- | ---------------------------------------------------------------- | ------ | ---------- |
| A   | Forged `studentId` in the create body                             | 400 | `.strict()` contract |
| B   | Learner names `status: "featured"` for their own project          | 400 | contract enum has no such value |
| C   | Classmate reads / updates / deletes a private project by exact id | 404 | policy + RLS |
| D   | Made-up project id vs. somebody else's private project            | identical 404s | indistinguishable by design |
| E   | `/me/projects` while another learner has projects                 | own only | repository scopes by session id |
| F   | Classmate reads a `class` project, then a `private` one           | 200 / 404 | the visibility column, as designed |
| G   | Learner in another class of the same school reads shared work     | 404 | `app_actor_shares_project_class` |
| H   | Learner in another school reads a `public` project                | 404 | organization boundary |
| I   | Class showcase containing a draft and a private project           | neither shown | SQL + RLS + policy |
| J   | Class showcase for a class the caller is not in, and a fake id    | empty 200, not 403 | no class-existence oracle |
| K   | Teacher of another class in the same school reads / features      | 404 | `app_actor_reviews_project` |
| L   | Class teacher rewrites the learner's description                  | 404, text unchanged | policy + review guard |
| M   | Class teacher sets `visibility: "public"` on a child's work       | 404, still private | policy + review guard |
| N   | Classmate reads another learner's portfolio                       | 404 | no path parameter exists to try |
| O   | Learner adds another learner's project to their own portfolio     | 404/400, portfolio empty | composite foreign key |
| —   | Owner features their own work                                     | 403 | policy, `reveal` |
| —   | Draft featured by the class teacher                               | 404 | policy + RLS + `CHECK` |
| —   | Guardian reads a project of the child they are verified for       | 404 | no guardian branch exists |
| —   | Anonymous caller with a wrong 64-hex key                          | 404 | RLS + repository predicate |
| —   | Anonymous caller with a withdrawn portfolio's old token           | 404, identical body | token rotation |
| —   | Anonymous caller with `../`, `%2e%2e%2f`, SQL-shaped, over-length | 400/404/414 | route param regex, before any query |
| —   | Owner opens their own share link                                  | byte-identical to a stranger's | `withoutActor` |
| —   | Second portfolio, taken slug, duplicate item                      | 409 (+ suggestions) | unique constraints |
| —   | `shareToken` supplied on portfolio creation                       | 400 | `.strict()` contract |

**Every "not yours" answer is 404, never 403.** A 403 confirms the id names a
real object, which is the one bit an attacker walking ids is buying. The three
403s in this domain are cases where the caller demonstrably already knows the
object exists and needs to be told what to do instead: featuring your own work,
publishing an empty portfolio, and creating a project in a class you only teach.

---

## 5. ARCHITECTURE

```
                       anonymous request
                              │
                              ▼
              GET /portfolios/share/:key   ← the only route with no requireActor
                              │
              route param regex (token-shaped OR slug-shaped)
                              │
                    resolvePublic(key, {correlationId, ip})
                              │
                       db.withoutActor  ← never withActor, ever
                              │
              app_begin_public_portfolio(key)   ← transaction-local GUC
                              │
        ┌─────────────────────┴─────────────────────┐
        │  RLS: published AND key matches this row  │   gate 1
        │  repository WHERE: the same predicate     │   gate 2
        └─────────────────────┬─────────────────────┘
                              │
                    toPublicPortfolio(...)   ← constructor, allow-list
                              │
              publicPortfolioResponseSchema.parse()   ← .strict()
                              │
                     no-store, noindex
```

The authenticated half is the platform's ordinary shape: `requireActor` →
service → repository returns `Guarded<T>` → policy engine decides → `unwrap`
re-checks id and action. `listClassProjects` returns guarded rows and the
service re-decides each one; `listOwnProjects` does not, because it is
owner-scoped in SQL.

**What the module owns and what it borrows.** It owns four tables and writes to
nothing else. It reads the class graph only through `app_actor_shares_project_class`
and `app_actor_reviews_project` — the same SQL helpers the RLS policies call, so
the policy engine and the database answer from one definition rather than two
implementations of one idea. It reads `users` not at all, which is a change from
the first implementation (VULN-055).

---
## 6. FILES CHANGED

**New**

| File                                                    | Lines | What |
| ------------------------------------------------------- | ----- | ---- |
| `db/migrations/0028_projects_and_portfolios.sql`         | 937 | Four tables, 9 functions, 3 triggers, 17 policies |
| `apps/api/src/modules/portfolio/public-view.ts`          | 247 | The constructor, URL validation, slugs |
| `apps/api/src/modules/portfolio/portfolio.repository.ts` | 743 | Queries, including the two public statements |
| `apps/api/src/modules/portfolio/portfolio.service.ts`    | 555 | Both gates, translation, the public resolver |
| `apps/api/src/modules/portfolio/portfolio.routes.ts`     | 381 | 17 routes, 1 unauthenticated |
| `packages/authz/src/policies/portfolio.policy.ts`        | 144 | Two policies |
| `packages/contracts/src/portfolio.contract.ts`           | 333 | Strict schemas, `https://` allow-list |
| `tests/security/portfolio.test.ts`                       | 892 | 60 HTTP cases, IDOR matrix |
| `tests/integration/rls-projects.test.ts`                 | 575 | 29 RLS cases, no app code in the path |
| `tests/integration/rls-definer-coverage.test.ts`         | 194 | The catalog-derived definer rule |
| `tests/unit/portfolio-public-view.test.ts`               | 417 | 66 cases, leak property + slugs |
| `tests/unit/portfolio-policy.test.ts`                    | 303 | 33 decision-table cases |
| `tests/architecture/portfolio-boundaries.test.ts`        | 278 | 20 fitness functions |
| `docs/api/projects-portfolios.md`                        | 245 | |
| `docs/architecture/adr/0011-public-boundary.md`          | 177 | |

**Modified**

| File | Change |
| ---- | ------ |
| `packages/authz/src/types.ts` | 2 resources, 2 action sets, `ResourceKind` |
| `packages/authz/src/engine.ts`, `index.ts` | Registration and export |
| `packages/contracts/src/index.ts` | Export |
| `packages/observability/src/security-events.ts` | 3 event types |
| `apps/api/src/platform/security/rate-limit.ts` | 2 policies |
| `apps/api/src/app.ts` | Composition and route registration |
| `tests/security/layered-defense.test.ts` | 9 RLS-off cases |
| `docs/security/vulnerability-log.md` | VULN-055, VULN-056, the definer note |
| `docs/security/limitations.md` | RISK-PF-01 … RISK-PF-11 |
| `docs/architecture/domain-boundaries.md` | The `portfolio` domain |

---
## 7. TEST RESULTS

All suites run against a database rebuilt from all 28 migrations by
`globalSetup`.

| Suite | File | Cases |
| ----- | ---- | ----- |
| Unit — public boundary | `tests/unit/portfolio-public-view.test.ts` | 67 |
| Unit — policy tables   | `tests/unit/portfolio-policy.test.ts` | 33 |
| Architecture           | `tests/architecture/portfolio-boundaries.test.ts` | 20 |
| RLS, no app code       | `tests/integration/rls-projects.test.ts` | 30 |
| RLS definer coverage   | `tests/integration/rls-definer-coverage.test.ts` | 4 |
| HTTP / IDOR            | `tests/security/portfolio.test.ts` | 62 |
| Layered defence (RLS off) | `tests/security/layered-defense.test.ts` (new block) | 10 |

Whole-project gates: `pnpm typecheck` clean, `pnpm lint` clean, and the full
six-project run **86 files / 2933 tests passing**, exit 0.

### Live boot check

The suites drive the app through `app.inject`. A booted server is a different
thing, and it found something they could not: the first run returned **500** on
the public route, from `function app_begin_public_portfolio(unknown) does not
exist`. The development database was simply behind — migration 0028 had never
been applied there. Not a code defect, but exactly the class of problem a boot
check exists to catch, and it would have been a production outage on the one
route with no session to fail closed on.

After migrating, against a real process on a real database:

| Check | Result |
| ----- | ------ |
| Published portfolio by `share_token` | 200, one project, correct body |
| Same portfolio by `public_slug` | byte-identical to the token response |
| Headers on the 200 | `cache-control: no-store`, `x-robots-tag: noindex` |
| Token-shaped and slug-shaped misses | 404, identical bodies |
| Malformed, traversal, SQL-shaped keys | 400, before any query |
| Every other portfolio route, anonymous | 401 (nine routes checked) |
| Zero leakage, searched by value | portfolio id, project id, student id, organization id, share token and email all absent |
| Project set to `private` | page drops to zero projects on the next request |
| Portfolio unpublished | old token 404, slug 404, token rotated |

**One thing only the real logger could show.** The server's error log recorded
the failing path as `/api/v1/portfolios/share/[REDACTED]` for the token-shaped
key and `/api/v1/portfolios/share/noor-physics` for the slug. That is the right
distinction made by accident of the existing redaction rules: a share token is a
capability and must not sit in a log file; a slug is a public name and telling
an operator which page failed is useful. Worth knowing it holds, since nothing
asserts it.

### Defect injection round 12

Twelve defects, each applied to a **green baseline that the driver re-proves
before every run** — a precaution this environment earned, since PostgreSQL
stopped mid-round once and four verdicts had to be discarded as infrastructure
failures rather than detections.

| # | Defect | Caught by |
| - | ------ | --------- |
| F1  | Sanitizer becomes a filter: the source row is spread into the view | unit |
| F2  | `position` copied from `display_order`, so gaps disclose hidden items | unit |
| F3  | Artifact `https://` filter dropped, so `artifact://` reaches the page | unit |
| F4  | `publicUrlOrNull` accepts any scheme, so `javascript:` reaches an href | unit |
| F5  | The owner may feature their own work | unit |
| F6  | Classmate branch ignores `visibility`: a private project leaks to the class | unit, layered |
| F7  | Reviewer branch ignores `status`: a teacher reads an unfinished draft | unit |
| F8  | Unpublish refused for an empty portfolio | unit |
| F9  | Public query loses its key check and stands on RLS alone | arch, layered |
| F10 | Public project query loses its `visibility`/draft checks | arch, layered |
| F11 | Featuring widens to also set `title` | arch |
| F12 | Review guard trigger removed | rls |

**12 of 12 caught.** That number is the least interesting thing about the round.

**Six were caught by the unit suite alone, and the reason is structural, not a
gap in coverage.** Every layer above the sanitizer refuses to produce the state
it guards against: the contract rejects `javascript:` and `artifact://` before
the constructor sees them, and a teacher cannot own a project in a class they
teach, so the self-feature branch is unreachable over HTTP. The controls are
real and the tests are honest — but the public boundary's last line has exactly
one suite behind it, and that should be said plainly rather than counted as
depth. Five of those six now have a second test; see §9.

**F11 was caught by a fitness function and could not have been caught any other
way.** `title = title` is a no-op — the review guard compares `NEW.title` to
`OLD.title`, finds them equal, and permits it. Nothing behaves differently, so
no behavioural test *could* fail. What the source-text assertion catches is the
widening of the statement, which becomes a vulnerability the day somebody
changes `title = title` to `title = $3`. This is the clearest evidence in twelve
rounds for why this codebase asserts on source text as well as behaviour.

**F6 and F7 are the two-gate architecture visible in the results.** Both are
policy defects that the HTTP suite missed because RLS silently carried the rule.
F6 was caught by the layered-defence block, which runs the app against
`edu_app_norls`; F7 was not, and that was a genuine gap, now closed.

### Re-verification after closing the gaps

Fixing a test is worthless unless the fixed test fails against the defect it was
written for, so the five were re-injected against the closed gaps:

| # | Before | After |
| - | ------ | ----- |
| F1 | unit | unit, **arch** |
| F2 | unit | unit, **sec** |
| F3 | unit | unit — **the fix did not work**, see below |
| F7 | unit | unit, **layered** |
| F8 | unit | unit, **sec** |

**F3's first fix was wrong and the re-run is what said so.** It asserted in the
RLS suite that an `artifact://` row IS admitted to the public path — which
proves the state exists but never puts it in front of the thing that guards
against it, so removing the sanitizer's filter still passed everything above the
unit layer. *A test that establishes a precondition is not a test of the
control.* The row is now written directly in the HTTP suite and fetched through
the real public route, and F3 fails there.

That re-run is the part of this round worth keeping. Five tests were written
confidently to close five gaps; one of them closed nothing, and only re-running
the defect could tell which.

**One correction to the round itself.** F12 was first written as a rename of the
review-guard trigger and recorded as ESCAPED. A renamed trigger still fires — the
defect was inert, so there was nothing to catch. Re-run with the trigger
actually removed, the RLS suite catches it. Reporting the first result would
have raised a false alarm about a hole that does not exist, which is its own
kind of failure.

---

## 8. NOT IMPLEMENTED

**Explicitly out of scope, per the task:** community moderation, school
analytics, production hardening. None were built.

**Named in the task and not built, with reasons:**

- **No user interface.** Every route is exercised over HTTP by tests; nothing
  renders a portfolio. The public page's most important property — that a
  learner sees what a stranger sees — is asserted on the JSON, not on a page.
- **No `artifact://` production path.** The database accepts the form and the
  contract deliberately does not, because
  `docs/security/file-security.md` makes "never serve unscanned content"
  non-negotiable and this platform has no scanner, no quarantine and no storage
  adapter. Artifacts are `https://` references to things this platform does not
  host. The column shape is there so the migration does not need rewriting when
  the pipeline exists.
- **No un-feature verb.** A teacher who features the wrong project has no route
  back. Nobody has decided whether that should be a reviewer's power (RISK-PF-08).
- **No moderation, reporting or takedown path.** Only the owner can withdraw a
  page (RISK-PF-04). This is the out-of-scope item that matters most, because
  the public surface exists now and nothing watches it.
- **No measured byte sizes.** `byte_size` is a client claim, capped (RISK-PF-09).

**Deliberately absent, and not gaps:**

- **No author display name on the public page.** Removed rather than repaired;
  see VULN-055 and §9.
- **No `student_project:publish` action.** Making a project public is an
  ordinary `update` by its owner. A verb for it would suggest somebody else
  might hold the power.
- **No policy resource for `portfolio_items`.** Its `owner_id` is the portfolio
  owner's by composite foreign key, so a policy could only repeat the
  portfolio's — and two places stating one rule is how they disagree.
- **No transliteration in `slugFromTitle`.** An Arabic title has no honest ASCII
  slug. Returning null and asking the learner beats handing a child a URL they
  cannot read. A share token works with no slug at all.

---

## 9. KNOWN RISKS & DEFECTS FOUND

### Defects found and fixed during this task

**Four in the migration, all by the adversarial probe run before any application
code existed:**

1. **A teacher rewrote a child's `description_markdown`.** The
   `student_projects_feature` policy admits a ROW, not a column, and a comment
   two screens up claimed a guard that did not exist. On a public portfolio page
   this is not an abstract permissions bug: it is an adult putting words into a
   child's mouth, under the child's name, in front of an audience the child
   invited. Fixed with `student_project_review_guard`. *Prose describing a
   control is not a control* — that is the lesson, and the comment now says so.
2. **`app_mint_share_token` was revoked from PUBLIC and never granted to
   `edu_app`.** Every portfolio creation would have failed in production.
3. **Portfolio items leaked.** An anonymous token holder saw three items when
   one project was public — leaking the internal `project_id` of each hidden
   project, its position, and the fact that this child has work they chose not
   to show. The probe found it by counting.
4. **The definer/FORCE-RLS trap, third occurrence.**
   `app_project_is_publicly_listed` returned false for every project, so a
   genuinely public project was invisible to the world.

**Two in the application, found by tests written to prove properties rather than
to pass:**

5. **VULN-055 — every public page returned 404.** The resolver joined `users`
   for a display name; `users` has RLS; the public path has no actor; the inner
   join matched nothing for every portfolio on the platform. Fixed by removing
   the field, not by reaching past RLS for it — an account display name is
   registration data a child gave their school, and the specification never
   asked for one. *When a control fails because a field is hard to obtain
   safely, ask whether the field belongs there at all.*
6. **VULN-056 — the only anonymous route stood on a single gate.** The public
   query had no `WHERE` clause, on the explicit reasoning that duplication
   causes drift. Against `edu_app_norls` it served whichever portfolio was
   first, to anybody, for any key. *An argument for a single gate is strongest
   exactly where a single gate is least affordable.*

**Five test-coverage gaps, found by round 12 and closed:** the fitness function
that missed `...(portfolio as X)`; the position test whose page could not
distinguish renumbering from copying; the `artifact://` drop nothing could
reach; the draft-versus-teacher boundary that only RLS was holding; and the
revocation path for a learner who makes everything private before asking for the
page to come down. Each now has a test that fails when its defect is re-injected.

### Open risks

Eleven, recorded as RISK-PF-01 … RISK-PF-11 in `docs/security/limitations.md`.
The ones that would keep me up:

- **A slug is guessable, on an anonymous route, serving children's pages.** By
  design — that is what a portfolio is — with a rate limit and an audit event
  as the only mitigations. Neither stops a patient attacker with several
  addresses, and a learner is not warned at publish time that a memorable
  address is a discoverable one.
- **Nothing moderates what a learner publishes.** No review, no reporting path,
  no takedown by anybody but the owner. The public surface exists now; the
  moderation domain was explicitly out of scope.
- **`X-Robots-Tag: noindex` is unenforceable from a JSON API.** The judgement
  behind it is right and has no enforcement point until something serves HTML.
- **`:create` is single-gated**, here and in five other modules — the
  established pattern, not changed here, and named in the fitness suite.
- **The two-row guard is a detector with no alarm.** A uniqueness failure would
  present as one learner's page mysteriously not loading.

---
## 10. NEXT TASK — one recommendation

**Build the portfolio and project user interface, and make the public page a
real rendered page.**

Not because it is the next number in a sequence, but because this task shipped a
security property that cannot currently be checked by the person it protects.
The whole design turns on a learner understanding what they have published — the
resolver runs with no actor precisely so that the owner's view of their own
share link is the stranger's view. **Right now there is no view.** A learner
cannot see their page, cannot see which of their projects are on it, and cannot
see that the private ones are absent. The most carefully built property in the
task is invisible to its beneficiary.

Three things make it the right next step rather than a nice-to-have:

1. **RISK-PF-03 has no enforcement point until something serves HTML.** The
   `noindex` intent is unenforceable from a JSON API. The renderer is where that
   decision becomes real, or is quietly lost.

2. **The publish moment is where consent is actually given, and it currently has
   no interface.** A learner should see, before they publish, exactly what a
   stranger will see — and be told that a memorable slug is a discoverable one
   (RISK-PF-01). That is a UI concern that no amount of server work can cover.

3. **It is the smallest task that closes an open loop rather than opening new
   ones.** Community moderation (the other candidate) is a larger domain that
   would add a second public surface before the first one can be inspected;
   analytics reads data nobody can yet see; production hardening is premature
   while the API is still not deployed.

The one caveat worth stating: a renderer that puts a learner's title, bio and
description into a page is the first place on this platform where minor-authored
free text becomes HTML. That is an XSS surface this codebase has never had, and
it should be the first thing the task's threat model addresses.

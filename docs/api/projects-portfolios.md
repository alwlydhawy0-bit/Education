# Student Projects & Verifiable Portfolios API

Task 013. Work a learner makes, chooses an audience for, and can put on a page a
stranger can open — and take down again, completely, in one request.

## The one-paragraph version

A learner creates a **project** in a class they are a learner in. It is born
private and a draft, and moves outward only when they say so: `submitted` makes
it visible to their class and to the adult responsible for that class,
`visibility: "public"` makes it eligible for a public page. They compile chosen
projects into a **portfolio**, publish it, and share a link — either an
unguessable 256-bit token or a slug they chose. Anybody holding the link sees a
constructed page carrying no identifier of any kind. Unpublishing rotates the
token, so every link ever handed out stops working at once.

## Endpoints

| Method   | Path                             | Who                                     |
| -------- | -------------------------------- | --------------------------------------- |
| `POST`   | `/projects`                      | a learner, in a class they are in       |
| `GET`    | `/me/projects`                   | the caller's own                        |
| `GET`    | `/projects/:id`                  | owner, classmate, class reviewer        |
| `PUT`    | `/projects/:id`                  | the owner                               |
| `PATCH`  | `/projects/:id`                  | the owner                               |
| `DELETE` | `/projects/:id`                  | the owner                               |
| `POST`   | `/projects/:id/artifacts`        | the owner                               |
| `POST`   | `/projects/:id/feature`          | a teacher of the class, or an org admin |
| `GET`    | `/classes/:id/projects`          | members and teachers of that class      |
| `POST`   | `/me/portfolio`                  | the owner                               |
| `GET`    | `/me/portfolio`                  | the owner                               |
| `PUT`    | `/me/portfolio`                  | the owner                               |
| `PATCH`  | `/me/portfolio`                  | the owner                               |
| `POST`   | `/me/portfolio/items`            | the owner                               |
| `DELETE` | `/me/portfolio/items/:projectId` | the owner                               |
| `POST`   | `/me/portfolio/publish`          | the owner                               |
| `DELETE` | `/me/portfolio/publish`          | the owner                               |
| `GET`    | `/portfolios/share/:shareToken`  | **anybody — no session**                |

All paths are under `/api/v1`.

## The public route

`GET /api/v1/portfolios/share/:shareToken` is the **only unauthenticated content
route on this platform**. Everything else in this task exists to make it safe.

It accepts either entry point in the same parameter: a 64-character hex
`share_token`, or a `public_slug`. They differ in how somebody comes to know
them and not at all in what they admit, so there is one route rather than two
places to keep the rule.

**It runs with no actor, even for a caller who has a session.** If it ran as the
caller, a learner opening their own share link would see their private and draft
projects rendered onto the page and would reasonably conclude that is what
strangers see. The page would then under-report what is hidden, to the one
person deciding what to publish. `tests/security/portfolio.test.ts` asserts the
owner's response is byte-identical to a stranger's.

### What it returns

```json
{
  "title": "Y10 Physics",
  "bio": "Things I built that fell over.",
  "projects": [
    {
      "position": 1,
      "title": "Pendulum period vs. length",
      "description": "…",
      "repositoryUrl": "https://…",
      "liveDemoUrl": null,
      "featured": true,
      "artifacts": [{ "kind": "report_pdf", "url": "https://…", "byteSize": 4096 }]
    }
  ]
}
```

**No identifier appears, and none can.** Not the portfolio's, not a project's,
not the owner's. `toPublicPortfolio` is a _constructor_, not a filter: it builds
a new object out of named pieces rather than removing fields from a row, so a
column added to `student_projects` next year is invisible on the public page
until somebody deliberately writes a line to expose it — and writing that line
is the moment a reviewer gets to object.

**`position` is renumbered 1..n** from the sorted order rather than copied from
`display_order`. A gap left by a deleted or hidden item would tell a stranger
that something was removed.

**There is no author name.** An account display name is registration data a
child gave their school, not something they composed for a page served to
anybody with a link. The `title` and `bio` are what the learner wrote _for this
page_: if they want their name on it they can put it there, and if they want to
be "Y10 Physics" they can be that instead.

**`artifact://` references are dropped**, not rendered. A stranger has no
session, so an internal reference would be a broken link at best and a hint
about storage layout at worst. When signed URLs exist, the sanitizer is where
one gets minted.

### Headers

`Cache-Control: no-store`, because the answer depends on a revocation that can
happen at any moment and a shared cache holding the old page is exactly what the
token rotation exists to prevent.

`X-Robots-Tag: noindex` — a **judgement, not a control**. A child clicking
"publish" is choosing to hand a link to people they name, not to have their name
and school work indexed and kept after they graduate. But this is a JSON API:
nothing here can stop a frontend from rendering the same content into an
indexable HTML page. The real control belongs to whatever serves that HTML.

### Rate limit

60 requests per 15 minutes per IP — tighter than any other read on the platform.
A `share_token` is 256 bits and not worth guessing; a **`public_slug` is a
guessable name**, so somebody walking `/portfolios/share/ahmed`, `/omar`,
`/sara` is enumerating children's pages, and this limit is what makes that slow.
Every miss is recorded as `portfolio.public_resolve_failed` with the address and
the key's _shape_ — never the key, because a valid token in a log is a working
capability in a file more people can read than the page it opens.

## Visibility

| `visibility` | Who can read it (when `status <> 'draft'`)                                            |
| ------------ | ------------------------------------------------------------------------------------- |
| `private`    | the owner; the class teacher or org admin, for review                                 |
| `class`      | the above, plus learners in the same class                                            |
| `public`     | the above, plus anybody holding the link to a **published** portfolio it is listed in |

A **draft is invisible to every adult.** Not "visible but not editable":
absent. A draft is work in progress that nobody has offered, and a supervisor
reading one is reading over a child's shoulder. Submitting is the act that
consents.

A `private` project inside a school class is private **from other learners**,
not from the adult accountable for the work. That is why the reviewer branch is
deliberately not gated on visibility.

## Featuring

`POST /projects/:id/feature` takes an **empty body**. There is nothing to send:
the status is the only thing that changes and it can only change one way, so a
body would be a place for a caller to put a column name.

A reviewer's authority over a project is **exactly one column wide**. They move
`status` to `featured` and nothing else — not the title, not the description,
and above all not `visibility`, so a teacher cannot publish a child's work to
the world on their behalf. That refusal is written in four places: the authz
policy, the `student_projects_feature` RLS policy, the
`student_project_review_guard` trigger, and the repository's `SET` list. The
trigger exists because a policy admits a **row**, not a column — the adversarial
probe used the featuring policy to rewrite a child's description, and read back
"Teacher wrote this".

**Nobody features their own work**, including a teacher who owns a project in a
class they teach. A self-conferred distinction is not a distinction.

## Revocation

Section 3 requires that unpublishing, or making a project private, revokes
public access **immediately**. Four paths do it, and each is asserted end to end:

| Action                                  | What happens                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /me/portfolio/publish`          | `is_published` false **and the share token is rotated** by `student_portfolio_guard`, so every link ever handed out — including ones this platform never saw — stops resolving. Republishing does not resurrect them. |
| `PUT /projects/:id` → `private`         | The project stops satisfying `app_project_is_publicly_listed`, and drops off the page on the next request.                                                                                                            |
| `DELETE /projects/:id`                  | The artifacts and the portfolio item cascade through composite foreign keys in the same statement.                                                                                                                    |
| `DELETE /me/portfolio/items/:projectId` | The item row is what puts a project on the page; removing it takes it off.                                                                                                                                            |

There is no cache to expire and no second step to forget.

**Unpublishing is never refused** for any reason beyond not being the owner —
not even for an already-unpublished portfolio. A child who wants their work off
the internet must not meet a policy that argues with them. Publishing _is_
refused for a portfolio with no public projects (`403`), because otherwise the
learner gets a live URL showing a name, a bio and a blank space, and believes
they have shared their work.

## URLs

`repository_url`, `live_demo_url` and an artifact's location accept **`https://`
and nothing else**. Not a deny-list of bad schemes — the scheme nobody thought
of is the one that gets through. These values end up as `href` attributes on a
page a stranger is invited to click, which makes `javascript:` stored XSS with
no script tag in sight. Plain `http://` is refused too: a child's portfolio link
should not be downgradeable by whoever runs the coffee-shop wifi.

Checked three times — the request contract, a database `CHECK`, and
`publicUrlOrNull` immediately before the bytes reach a browser. Whitespace is
refused as firmly as the scheme: a URL containing a newline is how a value
smuggles a second thing into whatever consumes it.

Artifacts are capped at 25 MiB (26,214,400 bytes), the same number as
`student_artifacts`, so the two cannot drift into different answers to "how big
may a learner's file be".

## Slugs

A slug is `[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])` — 3 to 64 characters. It is
**proposed, not set**: the namespace is global and the unique index is the
arbiter, so a taken slug comes back `409` carrying alternatives rather than
being silently suffixed. `alex-chen` quietly becoming `alex-chen-4` hands a
learner a URL they did not choose and will not recognise on a poster.

`slugFromTitle` returns **null** for a title with no ASCII rather than inventing
one. This platform teaches in Arabic, and a title in Arabic has no honest ASCII
slug — transliteration would produce something the learner cannot read and did
not choose. Null means "ask them"; it does not mean Arabic portfolios cannot be
published, because a share token works with no slug at all.

A slug is **not a secret** and must never be treated as one. Anyone can try
`/portfolios/share/alex-chen`; that is what a portfolio is for. The consequence
— that publishing under a slug makes a portfolio discoverable by name — is
recorded in `docs/security/limitations.md` rather than mitigated, because
mitigating it would mean building something that is not a portfolio.

## What is never accepted from a client

`studentId`, `ownerId`, `organizationId`, `status` on create, `featuredBy`,
`featuredAt`, `shareToken`, and `isPublished`. Every request schema is
`.strict()`, so sending one is a `400` rather than a silently-dropped field —
silently dropping a forged field is indistinguishable from trusting it
(VULN-028).

`share_token` is minted by the database on every insert regardless of what was
sent. A caller who picks their own token picks a guessable one.

## Errors

| Status | When                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | A schema refusal: an unknown field, a bad URL scheme, an oversized artifact, a `status` a learner may not name.                                                                                          |
| `403`  | The caller plainly knows the object exists and the honest answer is that this is not theirs to do: featuring your own work, publishing an empty portfolio, creating a project in a class you only teach. |
| `404`  | Everything else — another learner's project, a draft, another school's, a wrong or withdrawn share key, and an id that names nothing. These are **indistinguishable by design**.                         |
| `409`  | A taken slug (with `suggestions`), a second portfolio, a project already in the portfolio.                                                                                                               |
| `429`  | The rate limit, sharpest on the public route.                                                                                                                                                            |

## Related

- `db/migrations/0028_projects_and_portfolios.sql` — the tables, the RLS, the triggers, and why each exists.
- `tests/security/portfolio.test.ts` — the IDOR/BOLA matrix over real HTTP, including the unauthenticated route.
- `tests/integration/rls-projects.test.ts` — the same boundaries with no application code in the path.
- `tests/integration/rls-definer-coverage.test.ts` — the definer/FORCE-RLS rule, derived from the catalog.
- `docs/security/limitations.md` — RISK-PF-01 onwards.

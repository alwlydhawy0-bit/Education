# Student Workspace API

Task 010. Notebooks, notes anchored to the curriculum, and personal file
artifacts — **the most privacy-sensitive ordinary data on this platform**: a
minor's unfiltered working thoughts about what they are studying.

Every other domain here records something the PLATFORM decided about a child: a
score, a mastery level, a lab verdict. This one records what the CHILD wrote.
That difference is behind every decision below, and it is why these policies are
the strictest on the platform rather than the most flexible.

## The one-paragraph version

A **notebook** is a folder; it belongs to one person and has no sharing model at
all. A **note** lives in `notes` — the table Task 002 built — and now carries a
notebook and at most one curriculum anchor. An **artifact** registers a personal
file: its size, its declared type, and a storage key the SERVER derives. Reads,
writes and deletes are the owner's, and there is no branch in any policy through
which a teacher, a guardian, an administrator or a platform operator reaches
them.

## Endpoints

Every route is under `/api/v1/me`. **None of them takes a user id** — in the
path, the query or the body. That is the structural half of the IDOR defence:
there is no parameter for an attacker to put somebody else's id into.

### Notebooks

| Method            | Path                        |
| ----------------- | --------------------------- |
| `POST`            | `/me/notebooks`             |
| `GET`             | `/me/notebooks`             |
| `GET`             | `/me/notebooks/:id`         |
| `PUT` / `PATCH`   | `/me/notebooks/:id`         |
| `DELETE`          | `/me/notebooks/:id`         |

**Deleting a notebook does not delete the notes in it.** A composite foreign key
sets their `notebook_id` to null and leaves the writing alone. Deleting a folder
is a filing action; losing a term of revision notes because somebody tidied up
is not something a learner should be able to do by accident.

### Notes

| Method            | Path                          |
| ----------------- | ----------------------------- |
| `POST`            | `/me/notes`                   |
| `GET`             | `/me/notes`                   |
| `GET`             | `/me/notes/lesson/:lessonId`  |
| `GET`             | `/me/notes/:id`               |
| `PUT` / `PATCH`   | `/me/notes/:id`               |
| `DELETE`          | `/me/notes/:id`               |

These are **aliases over the existing note service**, not a second
implementation. `/api/v1/notes` already served the same resource through the same
authorization funnel; a parallel module would be two write paths to one table
and two places for the ownership rule to drift.

`PUT` **merges rather than replaces.** The task asks for `PUT`; the platform's
update contract is partial. A true replace would let a client blank a field it
never read — an older tab that has never heard of `lessonId` would silently
unanchor a note on its next save.

### Artifacts

| Method   | Path                  |
| -------- | --------------------- |
| `POST`   | `/me/artifacts`       |
| `GET`    | `/me/artifacts`       |
| `GET`    | `/me/artifacts/:id`   |
| `DELETE` | `/me/artifacts/:id`   |
| `GET`    | `/me/storage`         |

## `POST /me/artifacts` registers metadata. It does not accept bytes.

`docs/security/file-security.md` makes **"never serve unscanned content"** a
non-negotiable, and this platform has no scanner, no quarantine bucket and no
storage adapter. So this endpoint reserves a tenant-scoped key and accounts for
the space, and **there is deliberately no upload route and no download route** to
pair with it. When the pipeline is built it has somewhere correct to write.

There is also no `student_artifact:download` action. Adding one is the visible
diff that says the pipeline now exists.

### The storage key is derived, never accepted

```
org/<organization_id>/user/<owner_id>/<artifact_id>
```

Built by a database trigger from the row's owner. **The request has no field for
a path or a URL** — not one that is validated, one that does not exist — so
`.strict()` turns any attempt to supply one into a 400.

This is the difference between validating a dangerous input and not having it. A
caller-supplied path is an arbitrary-reference bug wearing a metadata field's
clothes: it lets a client name a location inside another tenant's prefix, or
outside the store altogether, and every later reader inherits that choice.

`original_filename` is kept **for display only**. It never touches the key, so
traversal has nowhere to land.

## Anchoring: retention and rejection are different questions

A note hangs at **at most one** place in the tree — a course, a unit or a lesson
— or nowhere. Three columns that must agree are three columns that one day will
not; a lesson already determines its unit and its course.

| Statement                          | Asked?                                   |
| ---------------------------------- | ---------------------------------------- |
| CREATE a note anchored somewhere    | **yes** — `app_actor_may_anchor_here`   |
| READ an existing note               | no                                       |
| EDIT its title, body or visibility  | no                                       |
| MOVE its anchor                     | **yes**                                  |

A learner may not create a note against coursework they do not study — that
would be a way to probe the catalog. A learner keeps, reads and **edits** every
note they already wrote when the term ends, because revision notes are theirs
and not the school's.

Enforced twice, independently: the RLS insert policy asks, and the `notes_anchor`
trigger asks again. Only the trigger can handle the UPDATE case, because RLS
`WITH CHECK` sees the new row and not the old one and so cannot tell "moved the
anchor" from "edited a note anchored last term".

A free-standing note needs no permission at all. **A learner does not need a
course's permission to think.**

## The markdown gate is about link destinations, not HTML

**Nothing on this platform renders markdown as HTML.** There is no renderer in
the API or the web app, and `tests/architecture/workspace-boundaries.test.ts`
asserts that structurally — no `dangerouslySetInnerHTML`, no `innerHTML`, no
`document.write`, and no markdown-to-HTML library in any `package.json`. If
somebody adds one, that test fails and sanitization becomes a decision rather
than an inherited assumption.

What a check can usefully do today is refuse the vector that **survives
HTML-escaping**. `[click](javascript:alert(1))` is markdown's own syntax, so a
renderer that escapes raw HTML — the safe default — will still emit
`<a href="javascript:...">`. So `checkMarkdown` looks only in destination
position — inline links, autolinks, reference definitions — for `javascript:`,
`vbscript:` and `data:`, tolerating characters inserted between the scheme's
letters because entity decoding happens inside the browser's URL parser.

**It rejects rather than strips**, and only in destination position. Both halves
are about whose data this is:

- Silently rewriting a child's note is corrupting their work to make a
  validator's life easier — no error, no diff, no way to know.
- A computing student writing prose about `javascript:` URLs, or pasting one
  into a code fence to discuss it, is doing schoolwork. A stripping sanitizer
  would have to decide what to do with that code block, and every answer it
  could give edits their homework.

## Storage limits

| Limit                | Value       | Enforced by                    |
| -------------------- | ----------- | ------------------------------ |
| One artifact         | 25 MiB      | Zod, then a SQL `CHECK`        |
| One learner, total   | 256 MiB     | **a `BEFORE INSERT` trigger**  |
| Registrations        | 120 / 15 min | `workspace.artifact` rate limit |

**The quota is the database's rule, not the service's.** An application that
reads `sum(byte_size)` and then inserts loses a race with a very cheap exploit —
fire N registrations at once and every one reads the pre-insert total. Doing the
check under the insert's own lock closes it, and a test fires two overlapping
inserts that only fit one at a time and asserts exactly one is accepted.

**There is no UPDATE grant and no UPDATE policy on artifacts.** A mutable row
would make the quota a suggestion: register one byte, then edit it to 25 MiB.
Replacing an artifact is a delete and a fresh registration.

The rate limit bounds something the quota does not: **row count**. A million
one-byte registrations sit comfortably inside 256 MiB.

### File types are an allow-list

Per artifact type, never a deny-list. `image/svg+xml` is **absent on purpose**:
SVG is a document that can carry script, not a picture, and it is the classic
stored-XSS payload dressed as an image.

The declared type is metadata only. When an upload pipeline exists, the real
type must come from magic bytes and must match what was declared.

## Who may read a workspace

| Actor                          | Notebook | Private note | Shared note | Artifact |
| ------------------------------ | :------: | :----------: | :---------: | :------: |
| the owner                      |    ✓     |      ✓       |      ✓      |    ✓     |
| a peer                         |    —     |      —       |      —      |    —     |
| the teacher of their class     |    —     |      —       |   ✓ (opt-in) |    —     |
| a verified guardian            |    —     |      —       |   ✓ (opt-in) |    —     |
| an administrator of the school |    —     |      —       |      —      |    —     |
| a platform operator            |    —     |      —       |      —      |    —     |

Three of those absences are decisions, not omissions:

1. **No administrator access**, matching `notePolicy` since Task 002.
   Administrators manage accounts, not a minor's private writing.
2. **No platform-operator access** — unusual on this platform, where an operator
   can read an attempt, a lab session and a progress row. Those are records the
   platform authored ABOUT a child; a notebook is one the child authored, and
   operating the service does not require reading it.
3. **No guardian access to an artifact**, even one attached to a note the child
   HAS shared with them. Sharing a note is a decision about that note's text. A
   file is the hardest thing to un-share and the easiest to misjudge the
   contents of, so it does not ride along.

A notebook has **no sharing model at all**, and that is why: it is a container
whose contents are individually shareable, and sharing the container would share
things the child never opened — including notes they write into it tomorrow.

## Security events

| Event                          | When                                              |
| ------------------------------ | ------------------------------------------------- |
| `workspace.artifact_registered` | a file is registered. Type and size, never the filename or metadata |
| `workspace.markdown_refused`   | a link scheme is refused. The scheme, and nothing else |
| `authz.denied`                 | every denial, with ids and a reason               |

**Reading or listing a workspace is not recorded.** A child reading their own
notes is not a security event, and logging it would build exactly the
surveillance trail these policies exist to make unnecessary.

## Where each rule is enforced

| Property                                       | Policy engine | RLS | Constraint / trigger |
| ---------------------------------------------- | :-----------: | :-: | :------------------: |
| Only the owner reads or writes                 |       ✓       |  ✓  |          —           |
| A parent belongs to the same owner             |       —       |  —  |    ✓ (composite FK)  |
| A note anchors only where the owner may study  |       —       |  ✓  |          ✓           |
| Retention after enrolment ends                 |       ✓       |  ✓  |          —           |
| The storage key is tenant-scoped               |       —       |  —  |          ✓           |
| The per-learner quota                          |       —       |  —  |          ✓           |
| Artifacts are immutable                        |       ✓       |  ✓  |     ✓ (no grant)     |
| Markdown link schemes                          |       —       |  —  |   ✓ (service gate)   |
| File type and size                             |       —       |  —  |    ✓ (contract + CHECK) |

Each ✓ is asserted by its own suite: `tests/unit/workspace-policy.test.ts` for
the first column, `tests/integration/rls-workspace.test.ts` for the middle one
with no application code in the path, and `tests/security/workspace.test.ts`
plus the workspace block of `tests/security/layered-defense.test.ts` for the
whole stack over HTTP — the latter with RLS switched OFF, so the application's
own scoping is observable rather than merely present.

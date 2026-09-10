# Task 014 — Community, Discussion Forums & Moderation Engine

Branch `claude/platform-foundation-architecture-dop21k`. Migrations 0029, 0030,
0031. One new domain, `community`.

---

## 1. IMPLEMENTED

**Migration 0029** (1,056 lines) — three tables, four guard triggers, one
cleanup trigger, three SQL helpers, seventeen RLS policies.

- `discussion_threads` — class-scoped, `is_pinned`, `is_locked`,
  `moderation_status` of `approved | flagged | hidden`, plus
  `UNIQUE (id, class_id)` so a reply's class can be tied to its thread's.
- `discussion_replies` — nested to eight levels, with the tree held by a
  **composite foreign key** `(parent_reply_id, thread_id) → (id, thread_id)`
  rather than a check.
- `content_flags` — `entity_type`/`entity_id`, a derived `thread_id`,
  `raised_by` of `member | automated_filter`, and a partial unique index that
  makes one person's second report of the same post a no-op.

**Migration 0030** — `app_forum_display_name(user_id, class_id)`, a
`SECURITY DEFINER` function bounded twice, so an author's name can be shown
without joining `users`.

**Migration 0031** — `content_flags_insert` widened so the automated filter can
file, bounded to the case where the caller authored the reported post.

**`content-filter.ts`** (322 lines, zero imports) — `normalizeForFilter`,
`screenContent`, `MUST_NEVER_MATCH`, `nextModerationState`,
`isModerationNoop`. Pure functions, no database, no clock, no configuration.

**`community.policy.ts`** (248 lines) — `discussionThreadPolicy`,
`discussionReplyPolicy`, `contentFlagPolicy`. Twenty-one actions across three
resources; `ContentFlagResource` deliberately carries no `subjectAuthorId`.

**`community.contract.ts`** (259 lines) — every schema `.strict()`.

**`community.repository.ts`** (667), **`community.service.ts`** (672),
**`community.routes.ts`** (282) — fourteen endpoints.

**Three security events** — `moderation.auto_flagged`,
`moderation.content_reported`, `moderation.action`. The last is the event the
taxonomy reserved in 2024 and never had a caller for.

**Three rate-limit policies** — `forum.post` (60/15m), `moderation.report`
(20/15m), `moderation.action` (200/15m).

**`markdown-safety.ts` moved** from `modules/notebook/` to
`platform/security/`. It was always a platform primitive; the notebook module
was only its first caller. Importing it from a sibling module would have
violated dependency rule 3.

**Six test files**, 265 tests.

---

## 2. VERIFIED

| Gate                          | Result                      |
| ----------------------------- | --------------------------- |
| `pnpm typecheck`              | clean, exit 0               |
| `pnpm lint`                   | clean, exit 0               |
| `pnpm test` (all six projects)| 91 files, 3,223 tests, pass |
| Defect injection round 13     | 14 injected, 14 caught      |
| Live boot check               | see below                   |

**The live boot check, in full.** Migrations 0029–0031 applied to the
development database; the API booted as a real process; a learner registered,
logged in, and drove the endpoints over HTTP with a browser-shaped origin.

```
POST /api/v1/classes/:id/threads          201, moderationStatus "approved"
GET  /api/v1/threads/:id                  200, author.displayName "Live Learner"
GET  /api/v1/classes/:id/threads          200, the thread in the feed
POST /api/v1/classes/:id/threads (rude)   201, moderationStatus "flagged"
GET  /api/v1/moderation/flags (no session) 401
```

That fourth request is the one worth booting a server for: it is the exact path
VULN-058 broke, where every filter match returned a 500. The row it wrote is
`(thread, automated_filter, pending, "Automated filter matched: idiot")` and the
process emitted `moderation.auto_flagged`.

The `author.displayName` on the first two responses is the other thing only a
real boot proves: it comes from `app_forum_display_name`, a definer function
that did not exist in the development database until this task's migrations ran.
Task 013 shipped with exactly that mismatch and every public page 500'd.

**The server log contains neither the post body nor the matched term** — checked
directly, zero occurrences of `idiot`, and zero of the session password. The
moderation reason is in the database for a teacher to read and not in the
process log for anybody to grep.

**Verified with each gate removed, separately.**
`tests/integration/rls-community.test.ts` runs 38 statements as `edu_app` with
no application code in the path — the policy engine could be deleted and these
boundaries would hold. The community block of
`tests/security/layered-defense.test.ts` runs the whole application against
`edu_app_norls` (BYPASSRLS), where every row is visible to the client and what
refuses is the policy engine.

That second one is the load-bearing verification for section 3. The
locked-thread rule the task specifies as a database policy is bypassed
entirely under `edu_app_norls`, and the reply into a locked thread is still
refused — by `discussionReplyPolicy`, with 403 and the reason. Likewise
"flagged or hidden posts must be excluded from student queries by default via
RLS": with RLS gone the hidden rows come back from the query, and the per-row
`admit` in the service removes them.

---

## 3. SECURITY

**The room is the boundary, and it is one room.** `app_actor_in_class_forum`
resolves to a single fact — a member or teacher of this active class. There is
no organization-wide read, no year-group visibility, no cross-class path of any
kind. A teacher moderates the classes they teach; an administrator's reach stops
at their own school's classes.

**Markdown sanitization happens before storage, not before rendering.**
`checkMarkdown` refuses `javascript:` and `data:` URLs at the API boundary, so
unsafe markup never enters the database and no renderer anywhere can be the
place it is caught.

**The content filter never refuses a post.** It decides the status the row is
born with. A refusal would tell a learner exactly which word to change, turning
the filter into a tutorial in evading it; a quiet `flagged` puts the post in
front of an adult instead. Section 2B asked for a filter that flags, and that
is what this is.

**403 and 404 are chosen case by case.** A child whose reply was refused because
a teacher locked the thread is told so; a child probing another class's ids
learns nothing. The `disclosure` on every decision is asserted in
`tests/unit/community-policy.test.ts` as often as the effect.

**Nobody learns who reported them.** `ContentFlagResource` has no
`subjectAuthorId` — the field does not exist, so no future branch can add one by
accident. On a forum for minors, naming the reporter converts the reporting
system into a targeting system.

**Nobody withdraws a flag, including its reporter.** No `content_flag:delete`
verb, no DELETE grant, no DELETE policy. A report that can be retracted can be
retracted under pressure.

**A moderator cannot edit a child's words.** The policy admits the row and
`discussion_thread_moderation_guard` limits the columns to four. Both are
needed: a policy admits a ROW and only a trigger can limit a COLUMN.

**A reply cannot be born pinned, locked, hidden, or accepted.** The insert
policies refuse the first three; the guard pins `is_accepted_answer := false`
rather than refusing, so a genuine answer is not lost to an error about a field
the learner never chose.

---

## 4. IDOR / BOLA MATRIX

Every row traces to a marker in `tests/security/community.test.ts`. All run over
the real HTTP stack with both gates active.

| ID | Attempt | Result |
| -- | ------- | ------ |
| IDOR-A | A learner in another class of the same school reads a thread | 404 |
| IDOR-B | A learner in another school reads it | 404 |
| IDOR-C | A learner posts into a class they are not in | 404 |
| IDOR-D | A learner in another school posts | 404 |
| IDOR-E | A learner replies to a thread in a class they are not in | 404 |
| IDOR-F | A class feed for a class the caller is not in | 200, empty |
| IDOR-G | A made-up thread id | 404, identical to somebody else's |
| IDOR-H | A classmate edits or deletes another's thread | 404 |
| IDOR-I | A classmate edits or deletes another's reply | 404 |
| IDOR-J | A reply into a locked thread | 403, "locked" |
| IDOR-K | The author edits their own locked thread | 403 |
| IDOR-L | A learner performs any moderation verb | 404 (×4) |
| IDOR-M | The AUTHOR moderates their own thread | 404 |
| IDOR-N | A teacher of another class moderates here | 404 |
| IDOR-O | A moderator rewrites a child's post | refused by the guard |
| IDOR-P | A hidden thread in a classmate's feed and read | absent, 404 |
| IDOR-Q | Filter evasions a naive substring check would pass | flagged |
| IDOR-R | A reply parented in another class's thread | refused by the composite FK |
| IDOR-S | The ANSWERER accepts their own answer | 403 |
| IDOR-T | Somebody who neither asked nor answered accepts | 404 |
| IDOR-U | The reported author sees who reported them | never |
| IDOR-V | A teacher of another class reads the queue | empty |
| IDOR-W | Another school reads the queue | empty |

**The same boundaries, twice more.** Thirty-eight of these run again in
`tests/integration/rls-community.test.ts` with the application deleted, and
twelve run again in the layered-defence block with RLS switched off.

---

## 5. ARCHITECTURE

**The composite foreign key is the shape of the domain.** A reply's parent must
live in the same thread, and this is a schema constraint rather than a policy
because every policy on the platform would admit the violating row: the reply is
in a class the actor is in, and the parent id is just a uuid. The same technique
holds `discussion_replies.class_id` to its thread's, via `UNIQUE (id, class_id)`
on threads and a trigger that derives the value rather than accepting it.

**Two gates, and a third thing that is neither.** The rules split three ways:

- Rules both layers hold — the room, ownership, the lock, moderation authority.
  Each is tested with the other layer removed.
- Rules only the database can hold — the reply tree's containment, the derived
  `class_id`, the column limits on a moderator's write. These are structural:
  a constraint and two triggers, none of which a route can go round.
- One rule only the application holds — the content filter's verdict. It is a
  judgement about text, and a database has no opinion about text.

**The filter is pure and imports nothing.** That is what lets the unit suite
enumerate eighty cases in half a second, and what stops the verdict depending on
which rows the caller can see.

**A display value is fetched through a bounded definer, never a join.** Third
time this platform has met the lesson (VULN-054, VULN-055, and this domain
by anticipation), and the first time it is enforced rather than remembered:
`tests/architecture/community-boundaries.test.ts` fails on `JOIN users`.

**Nothing established was redesigned.** `Guarded`/`unwrap`, `db.withActor`,
`FORCE ROW LEVEL SECURITY`, the two-role test split, the disclosure model, the
security-event taxonomy and the migration checksum discipline are all used as
they were. The one file that moved — `markdown-safety.ts` — moved because
importing it where it was would have broken dependency rule 3, and it moved to
the layer it always belonged in.

---

## 6. FILES CHANGED

**New**

```
db/migrations/0029_community_discussions.sql          1056
db/migrations/0030_forum_display_names.sql              87
db/migrations/0031_automated_flag_insert.sql            68
apps/api/src/modules/community/content-filter.ts       322
apps/api/src/modules/community/community.repository.ts 667
apps/api/src/modules/community/community.service.ts    672
apps/api/src/modules/community/community.routes.ts     282
packages/authz/src/policies/community.policy.ts        248
packages/contracts/src/community.contract.ts           259
tests/unit/community-content-filter.test.ts            236
tests/unit/community-policy.test.ts                    527
tests/architecture/community-boundaries.test.ts        481
tests/integration/rls-community.test.ts                656
tests/security/community.test.ts                       992
docs/api/community.md                                  335
```

**Moved**

```
apps/api/src/modules/notebook/markdown-safety.ts
  → apps/api/src/platform/security/markdown-safety.ts
```

**Modified**

```
apps/api/src/app.ts                              +11   route registration
apps/api/src/modules/notebook/notebook.service.ts +5   the moved import
apps/api/src/platform/security/rate-limit.ts     +41   three policies
packages/authz/src/types.ts                     +150   resources and actions
packages/authz/src/engine.ts                      +8   dispatch
packages/authz/src/index.ts                       +5   exports
packages/contracts/src/index.ts                   +1   export
packages/observability/src/security-events.ts    +44   three events
tests/security/layered-defense.test.ts          +398   the community block
docs/architecture/domain-boundaries.md           +52   the community domain
docs/security/vulnerability-log.md              +109   VULN-057, VULN-058
docs/security/limitations.md                     +73   RISK-COM-01…11
```

29 files, ~7,900 lines.

---

## 7. TEST RESULTS

```
pnpm typecheck   exit 0
pnpm lint        exit 0
pnpm test        91 files, 3,223 tests, all passing
```

**This task's suites**

| Suite | Tests | What it removes |
| ----- | ----- | --------------- |
| `tests/unit/community-content-filter.test.ts` | 80 | the server |
| `tests/unit/community-policy.test.ts` | 59 | the server |
| `tests/architecture/community-boundaries.test.ts` | 34 | behaviour — asserts on source text |
| `tests/integration/rls-community.test.ts` | 38 | the application layer |
| `tests/security/community.test.ts` | 65 | nothing — both gates, real HTTP |
| `tests/security/layered-defense.test.ts` (community) | 12 | RLS |

**Defect injection round 13 — 14 injected, 14 caught.**

| # | Defect | Caught by |
| - | ------ | --------- |
| F1 | Separator-run collapse dropped (`f u c k` escapes) | unit, sec |
| F2 | Repeat collapse dropped (`assshole` escapes) | **ESCAPED, then unit** |
| F3 | The aggressive second reading dropped | unit, sec |
| F4 | Invisible characters no longer stripped | unit |
| F5 | Word boundaries dropped (`classic` flags) | unit, arch |
| F6 | Reply-create stops asking about the lock | unit, sec, layered |
| F7 | Thread read stops checking moderation status | unit, layered |
| F8 | Self-accept guard removed | unit, sec |
| F9 | A reporter may close their own flag | unit |
| F10 | Lock check moved below the allow | unit, arch, sec |
| F11 | `createFlag` regains `RETURNING` | arch, sec |
| F12 | An author's edit gains `is_locked` | arch, sec |
| F13 | Display name from a join to `users` | arch, sec |
| F14 | Reply edits no longer re-screened | **arch only**, then arch + sec |

**Two of these fourteen taught something, and both are recorded in the code.**

**F2 escaped.** Neutering the `{2,}` repeat collapse left every filter test
passing, because `screenContent` reads the text twice and the aggressive second
reading squashes every run to a single letter — which catches `idiiiiot` on its
own. The evasion table was entirely terms with no doubled letters, so the two
readings agreed on all of it and one was carrying nothing. They disagree exactly
where a term contains a double letter of its own: `assshole` needs the run
reduced to two, and the aggressive reading reduces it to one and produces
`ashole`. The whole argument for two readings had no test. It has four now.

**F14 was caught only structurally.** The behavioural suite tested re-screening
on a thread edit and not on a reply edit, so removing the reply re-screen passed
every HTTP test. Two paths do the same job, and testing one of them is testing
one of them. The reply case is now asserted.

**The baseline check earned its keep again.** The first attempt at this round
refused to run: PostgreSQL had stopped, and every suite was red for a reason
that had nothing to do with any defect. Without that check the round would have
reported fourteen catches and meant nothing by them.

---

## 8. NOT IMPLEMENTED

**Explicitly excluded by the task.**

- **School-Wide Analytics.** No aggregate, no dashboard, no cross-class query.
- **Production Hardening / CI-CD Deployment.** No pipeline, no deployment
  configuration, no observability wiring beyond the three security events.

**Not asked for, and not built.**

- **No frontend.** Every endpoint is server-side. There is no thread list, no
  composer, no moderation queue screen — a teacher's queue exists only as a
  JSON endpoint.
- **No notifications of any kind.** No email, no push, no digest, no unread
  count. See RISK-COM-05: this is the gap that decides whether the reporting
  path is worth anything.
- **No search.** A thread is found by opening its class.
- **No reactions, votes, mentions, or attachments.** A reply is text.
- **No cross-class or school-wide forum.** Deliberately, not as a stage.
- **No appeal path.** A learner whose post was hidden can see that it was and
  cannot contest it.
- **No moderator reason field.** See RISK-COM-08.
- **No guardian visibility.** A guardian cannot read their child's forum posts.
  This is the same open question Task 012 recorded for tutor conversations and
  is deliberately left in the same state rather than settled here.

---

## 9. KNOWN RISKS & DEFECTS FOUND

**Two defects found and fixed during this task, both recorded in
`docs/security/vulnerability-log.md`.**

**VULN-057 — report-to-freeze.** `content_flag_reply_cleanup()` was
invoker-rights; `edu_app` has no DELETE grant on `content_flags` by design; a
trigger that raises inside a DELETE takes the DELETE with it. So **any learner
could make a classmate's reply permanently undeletable — by anyone, forever —
with one ordinary click of the report button.** Found by the adversarial probe
against the migration, before any application code existed. Fixed with
`SECURITY DEFINER` and the definer-role policies it then needs.

*The lesson: a grant you withheld on purpose is a grant your own triggers also
do not have.*

**VULN-058 — the automated filter could not file.** Two layers. The insert
policy admitted only `raised_by = 'member'`, so the screener could never write.
With that fixed the same statement failed again, because **`RETURNING` is a
read**: PostgreSQL applies SELECT policies to it, an automated flag has a NULL
reporter, and `content_flags_select` refused to show the row to the author it
was filed against — while the error blamed the INSERT. Every post the filter
matched returned a 500. Fixed by removing the `RETURNING` clause.

The tempting fix — widening the read policy so an author can see flags against
them — was deliberately not made: the flag carries the matched term, so it would
have turned the queue into a word-list oracle.

*The lesson: some defects live in the seam between the database and the
application, and are invisible to both a probe and a unit test.*

**Two test errors of mine, fixed rather than blamed on the code.** A reply born
claiming `is_accepted_answer` is written with the claim dropped rather than
refused, and my assertion was wrong. And a `withoutActor` UPDATE on
`class_memberships` matched nothing — `class_memberships_update` restricts
removal to somebody who teaches the class and its USING clause goes quiet rather
than raising — so a test about a departed learner was measuring a learner who
never left.

**Eleven standing risks, RISK-COM-01…11** in `docs/security/limitations.md`.
The four that matter most:

- **RISK-COM-05 — nothing notifies a teacher that the queue has something in
  it.** No email, no push, no unread count anywhere. A teacher who does not
  open `/moderation/flags` never learns a child reported something. **This is
  the most consequential gap in the domain** and it is a product gap rather
  than a security one — the reporting path is worth exactly what that habit is
  worth.
- **RISK-COM-01 — the filter is a first-pass trigger for human review, not a
  content-safety system, and calling it one would be the actual risk.** It
  does not understand context, sarcasm, coded language, or bullying conducted
  in polite sentences, which is most of it.
- **RISK-COM-04 — a reported post stays visible until a human looks.**
  Deliberate: auto-hiding on report hands every learner a mute button for their
  classmates. But the interval between a report and a teacher opening the queue
  is an interval in which the reported post is being read.
- **RISK-COM-06 — deleting a thread deletes every reply in it, including other
  children's.** The cascade is on the foreign key, and the people whose answers
  vanish are neither warned nor asked.

**Carried forward from earlier tasks, unchanged and still true.** The API is
not deployed. Vercel's Root Directory is still `apps/api` rather than the repo
root, and `apps/api/vercel.json` should be deleted once that is corrected.
`@vercel/speed-insights` sends Web Vitals to a third party from a children's
platform.

---

## 10. NEXT TASK — ONE RECOMMENDATION

**Build the moderation queue frontend, and the notification that tells a teacher
to open it.**

Not analytics, not production hardening, and not another backend domain.

The reasoning is RISK-COM-05, and it is the plainest finding in this report. The
platform now has a complete reporting and moderation engine: a child can report
a post, the filter can flag one automatically, an adult can hide it, and every
step is authorized, audited and tested from three directions. **And there is no
way for a teacher to find out that any of it happened.** The queue is a JSON
endpoint nobody has a reason to call.

That makes this the first task on this platform where the security work is done
and the safety outcome still is not, because the last step is a habit rather
than a control. A moderation system with no notification is a system whose
median time-to-review is however long it takes a teacher to think of checking —
and the whole design of "flag rather than refuse, report rather than auto-hide"
rests on somebody looking soon.

Concretely: a queue screen a teacher can work through, an unread count where
they already look, and one digest. It is small, it is the only remaining thing
that turns this domain from correct into useful, and every risk in section 9 that
is not inherent to filtering gets smaller when it lands.

School-wide analytics is the natural next backend task and should follow this
one, not precede it. It aggregates what teachers do; there is no point measuring
a workflow before anybody can perform it.

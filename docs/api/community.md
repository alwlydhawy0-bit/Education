# Class Discussion Forums & Moderation API

Task 014. The first place on this platform where one child's writing is put in
front of another, and the first where the platform has to decide what a child is
**exposed to** rather than only what a child discloses.

## The one-paragraph version

Every conversation belongs to a **class**. A learner in that class opens a
**thread**, others post **replies** under it, and nobody outside the class can
read, write, or learn that any of it exists — there is no organization-wide
feed, no "same year group", and no public route at all. Every post is screened
for profanity and self-harm language before it is stored; a match does not
refuse the post, it is born `flagged` and out of sight while an adult looks.
Anybody in the room may **report** a post. The teacher of that class, or an
administrator or moderator of that school, may **hide**, **approve**, **pin**,
**lock** and **unlock** — and nothing else: a moderator cannot edit a child's
words. Locking ends a conversation without deleting it, and the refusal to post
into a locked thread is written twice, once in the policy engine and once in the
database, so no route can go round it.

## Endpoints

| Method   | Path                        | Who                                         |
| -------- | --------------------------- | ------------------------------------------- |
| `POST`   | `/classes/:classId/threads` | a member or teacher of that class           |
| `GET`    | `/classes/:classId/threads` | a member or teacher of that class           |
| `GET`    | `/threads/:id`              | the room; the author at any status; staff   |
| `PUT`    | `/threads/:id`              | the author, while unlocked and not hidden   |
| `PATCH`  | `/threads/:id`              | the author, while unlocked and not hidden   |
| `DELETE` | `/threads/:id`              | the author, while unlocked and not hidden   |
| `POST`   | `/threads/:id/replies`      | the room, while the thread is unlocked      |
| `PUT`    | `/replies/:id`              | the author, while unlocked and not hidden   |
| `PATCH`  | `/replies/:id`              | the author, while unlocked and not hidden   |
| `DELETE` | `/replies/:id`              | the author, while unlocked and not hidden   |
| `PATCH`  | `/replies/:id/accept`       | **the person who asked**, or staff          |
| `POST`   | `/discussions/flag`         | anybody in the room                         |
| `GET`    | `/moderation/flags`         | staff for that class; a reporter, their own |
| `PATCH`  | `/moderation/action`        | staff for that class                        |

All paths are under `/api/v1`. **Every route requires a session** — unlike Task
013 there is no public route here, because a class forum has no readership
outside the class.

## The class is the boundary

`app_actor_in_class_forum(class_id)` is one resolved fact meaning _a member or
teacher of this active class_, and it is the only way into a forum. On the
resource it appears as `actorInForum`; in the database it is a `SECURITY
DEFINER` function the RLS policies call.

There is no wider read anywhere in this domain. A learner in 9A cannot see 9B's
forum, an administrator's reach stops at their own school's classes, and a
teacher moderates the classes they actually teach rather than every class in the
building — teaching 7B does not make somebody responsible for 9A's forum, and a
moderation power that quietly spans a school is one nobody audits.

**A learner who leaves the class keeps their words and loses the ability to
change them.** Their posts stay readable to the people who stayed; their edit
and delete are refused with `reveal`, so they are told why rather than left to
conclude the platform broke.

### Feeds answer empty, not 403

`GET /classes/:id/threads` for a class the caller is not in returns
`{ "items": [] }` with a 200. There is no object to refuse — every row failed
both gates — and distinguishing "not your class" from "nothing posted here"
would be a class-existence oracle across the platform. `GET
/moderation/flags` behaves the same way for a caller who is not staff.

## Content screening

Every content-bearing write is screened **twice over**, by two checks with
different jobs:

- **`checkMarkdown`** (`platform/security/markdown-safety.ts`, written for Task
  010 and reused) refuses a `javascript:` or `data:` URL before storage. This is
  the XSS half of section 3's sanitization requirement: unsafe markup never
  reaches the database, so no renderer anywhere can be the place it is caught.
- **`screenContent`** (`modules/community/content-filter.ts`) is section 2B's
  profanity and self-harm filter. **It never refuses a post.** It decides the
  `moderation_status` the row is born with: `approved`, or `flagged` and out of
  the class's sight until an adult looks.

**Both run again on every edit.** A one-time check at creation is a check a
learner walks past by posting something innocuous and editing it a second later.

### What the filter does about evasion

The filter normalizes before matching: case folding, NFKD, confusable
characters mapped to the letter they imitate (`0`→`o`, `1`→`i`, Cyrillic
lookalikes), zero-width and bidirectional characters stripped, separator runs
inside a spelled-out word collapsed (`f.u.c.k`, `f u c k`), and repeated letters
reduced. It then matches against the term list **twice** — once on the
normalized text and once on an aggressive reading with every repeat squashed to
one, which catches `idiiiiot` without turning `bass` into `bas` for everybody
else.

Every term is matched with word boundaries. `MUST_NEVER_MATCH` is an exported
list of innocent words — `classic`, `assess`, `Scunthorpe`, `Cockburn` and
twenty more — that `tests/unit/community-content-filter.test.ts` asserts against
directly. A filter that flags a child for writing `classic` teaches them the
platform is broken and that reporting is noise.

**The filter is a pure function with no imports at all**, which is what lets the
unit suite enumerate seventy-six evasions in milliseconds, and what stops its
verdict depending on which rows a caller can see.

**It is not a content-safety system.** It is a first-pass trigger for human
review, and section 2B asks for exactly that. Known misses are recorded in
`docs/security/limitations.md` rather than implied away.

## Reporting

`POST /api/v1/discussions/flag` takes `entityType` (`thread` or `reply`),
`entityId` and a `reason`, and answers **202 with `{ "recorded": true }`
whether or not the report was new**. A duplicate — the same person reporting the
same post twice — answers exactly like a first report, because a child who
double-clicks should not be told off, and because a differing response would say
something about what the queue already holds.

The flag's own thread is derived from the post being reported, so the room check
happens in the database on a value the caller cannot supply.

### The report is written and not read back

`createFlag` ends `ON CONFLICT DO NOTHING` with **no `RETURNING` clause**, and
returns a row count. PostgreSQL applies SELECT policies to a `RETURNING` clause,
so reading the row back failed for exactly the author an automated flag was
filed against — see the defect record below. Widening the read policy so an
author could see flags against them would have turned the queue into an oracle:
file text, read back the matched term, and the moderation word list is yours.

### Nobody learns who reported them

`ContentFlagResource` has **no `subjectAuthorId`** — the reported author is
absent from the resource entirely, so no future branch can be added that names
the reporter to them. The author is told their post was actioned; its moderation
status is visible to them. They are never told by whom.

**Nobody withdraws a flag, including its reporter.** A report that can be
retracted can be retracted under pressure, and pressure is what the reporting
path exists to survive. Staff close it; the record remains. There is no
`content_flag:delete` and no DELETE grant on the table.

## Moderation

`PATCH /api/v1/moderation/action` takes `entityType`, `entityId`, an `action`
from `approve | hide | pin | unpin | lock | unlock`, and an optional
`resolveFlagsAs` of `reviewed | dismissed`.

One route for four powers, because section 2D asks for one — and the **action**
in the body is what the audit event records, so "who locked this conversation"
is answerable from the trail rather than from a diff of two rows. Every
moderation action emits `MODERATION_ACTION_TAKEN`: an adult acting on a child's
words in front of their class is exactly the event the security taxonomy
reserved and never had a caller for.

A moderator may change **status, pin and lock, and nothing else**. The policy
admits the row, `discussion_thread_moderation_guard` limits the columns, and the
two are needed separately — a policy admits a ROW and only a trigger can limit a
COLUMN.

`pin` and `unpin`, `lock` and `unlock` are separate verbs rather than a boolean,
so the audit trail names what happened rather than what the row now says.

### Locking is not deleting

A lock belongs to the room, not to a person. It stops new writing and hides
nothing already said: the thread stays fully readable, replies included. A
teacher ending an argument is not the same act as removing what was argued, and
a design that conflated them would let "calm this down" delete a child's words
as a side effect.

**The lock is enforced in both gates.** In the database it is a `WITH CHECK` on
`discussion_replies_insert` — section 3's "database-level policies must reject
any NEW reply inserts regardless of API routes". In the policy engine it is
`discussion_reply.thread_locked`, denied with `reveal` so a 403 explains itself.
`tests/security/layered-defense.test.ts` runs the whole application with the
database's enforcer bypassed and finds the policy still refusing.

### The moderation state machine

`nextModerationState` is total: every (state, action) pair has an answer, and
the answer is a state rather than an error. Re-approving an approved post is a
no-op rather than a 409, because two teachers clearing the same queue at once is
normal and making the second one an error teaches staff to expect failures from
the moderation tool.

**There is no transition out of `hidden` except `approve`.** A hidden post
cannot be moved back to `flagged`: once a human has looked, the post is either
fit to read or it is not, and "hidden, then re-queued for somebody else" would
let a decision be laundered into the backlog.

## Accepting an answer

`PATCH /api/v1/replies/:id/accept` is held by **the person who asked the
question** — neither the reply's author nor staff by default — and it is the only
relationship of its kind on this platform. Staff may also accept, so a question
whose asker has left the class can still be resolved.

**The answerer is refused even when they also opened the thread.** Somebody who
answers their own question and then accepts it is marking their own homework;
the flag means "this resolved it" to everyone who reads the thread later, and a
self-award makes the signal worthless. The self-check runs before the ownership
branch precisely so the two cannot be combined.

A reply that arrives claiming `is_accepted_answer: true` is **written with the
claim dropped**, not refused — `discussion_reply_guard` pins the column to
`false` on every INSERT. Refusing the statement would lose a genuine answer to
an error about a field the learner never chose.

At most one accepted answer per thread, enforced by a partial unique index.
Changing your mind works: the accept statement clears the previous one first,
inside the same transaction.

## Replies nest, inside one thread

`parentReplyId` builds a tree, capped at **eight levels** — deeper raises a
`54000` and the API answers "Replies cannot be nested that deeply".

The tree cannot cross a thread, and that is structural rather than checked:

```sql
CONSTRAINT discussion_replies_id_thread_uk UNIQUE (id, thread_id),
CONSTRAINT discussion_replies_parent_fk
  FOREIGN KEY (parent_reply_id, thread_id)
  REFERENCES discussion_replies (id, thread_id) ON DELETE CASCADE
```

A **composite foreign key**, so a reply whose parent lives in another class's
thread is refused by the schema itself. Every policy on the platform would admit
that row — the reply is in a class the actor is in, the parent id is just a
uuid — and the constraint refuses it anyway. Deleting a reply takes its subtree
with it.

`class_id` on a reply is **derived from the thread by a trigger**, never taken
from the caller. The insert passes a zero UUID as a visible placeholder.

## Author names

A post carries an author's display name, fetched through
`app_forum_display_name(user_id, class_id)` — a `SECURITY DEFINER` function
bounded **twice**: the caller must be in the room, and so must the person being
named. It discloses exactly what a forum already discloses.

**Nothing in this module joins `users`.** That is the third time this platform
has learned the same lesson — VULN-054 was a join to `lessons` and VULN-055 a
join to `users` for a portfolio author's name, which took down every public page
because `users` has RLS and the public path has no actor. _A join added to fetch
a display value is an access predicate whether or not anybody meant it as one._
`tests/architecture/community-boundaries.test.ts` fails on `JOIN users` in this
module.

## Rate limits

| Policy              | Limit        | What it is for                               |
| ------------------- | ------------ | -------------------------------------------- |
| `forum.post`        | 60 / 15 min  | Automated flooding of a class feed           |
| `moderation.report` | 20 / 15 min  | Burying a queue so genuine reports go unread |
| `moderation.action` | 200 / 15 min | A stuck client replaying moderation writes   |

None is aimed at ordinary use. A class arguing about a physics question does not
approach sixty posts in a quarter of an hour.

## Request limits

| Field             | Limit                        |
| ----------------- | ---------------------------- |
| `title`           | 1–200 characters, trimmed    |
| `contentMarkdown` | 1–20,000 characters, trimmed |
| `reason`          | 1–1,000 characters, trimmed  |
| reply nesting     | 8 levels                     |

**Every schema is `.strict()`.** A field that arrives without being declared is
a 400, not a silent ignore — which is how `is_locked: false` in a request body
would otherwise reach an UPDATE somebody widened later.

`PATCH /replies/:id/accept` takes **no body at all**, and the schema says so.
The only thing that changes is one boolean and it can only change one way
through this route; a body would be a place for a caller to put a column.

## Two gates, and what each one is

| The rule                                | Application                         | Database                                 |
| --------------------------------------- | ----------------------------------- | ---------------------------------------- |
| Only the room reads a thread            | `discussion_thread.in_this_class`   | `discussion_threads_select`              |
| Only the author edits their post        | `discussion_thread.not_author`      | `discussion_threads_update`              |
| No reply into a locked thread           | `discussion_reply.thread_locked`    | `discussion_replies_insert` `WITH CHECK` |
| Hidden posts out of a learner's queries | per-row `admit` in the service      | `discussion_threads_select`              |
| Only staff moderate                     | `discussion_thread.not_a_moderator` | `discussion_threads_moderate`            |
| A moderator moves only four columns     | —                                   | `discussion_thread_moderation_guard`     |
| Only staff close a flag                 | `content_flag.not_a_moderator`      | `content_flags_review`                   |
| A reply's parent is in the same thread  | —                                   | composite foreign key                    |
| A reply's class comes from its thread   | —                                   | `discussion_reply_guard`                 |

Each row where both columns are filled is a rule that survives the deletion of
either gate, and both directions are tested:
`tests/integration/rls-community.test.ts` runs the database with no application
code in the path, and the community block of
`tests/security/layered-defense.test.ts` runs the application against a
`BYPASSRLS` role.

The rows with a dash in the application column are the ones only the database
can hold, and they are structural rather than policy: a constraint and a
trigger, neither of which any route can go round.

## Errors

| Status | When                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 400    | A malformed body, an undeclared field, or a reply nested too deep                                       |
| 401    | No session                                                                                              |
| 403    | A refusal the caller is entitled to understand — a locked thread, a hidden post, a self-accept          |
| 404    | A refusal that must not confirm the object exists — another class, another school, somebody else's post |
| 409    | A second accepted answer, or a duplicate report                                                         |
| 429    | A rate limit                                                                                            |

**403 and 404 are not two spellings of "no".** A 403 says the object is real and
names the reason; a 404 says nothing at all. Which one a refusal produces is the
`disclosure` on the decision, it is asserted in
`tests/unit/community-policy.test.ts` as often as the effect, and it is chosen
case by case: a child whose reply was refused because a teacher locked the
thread is told that, and a child probing another class's ids learns nothing.

## Tests

| File                                              | What it proves                                           |
| ------------------------------------------------- | -------------------------------------------------------- |
| `tests/unit/community-content-filter.test.ts`     | 76 evasions and 23 innocent words, no server             |
| `tests/unit/community-policy.test.ts`             | The decision grid, effect and disclosure                 |
| `tests/architecture/community-boundaries.test.ts` | The properties a passing suite would not notice breaking |
| `tests/integration/rls-community.test.ts`         | The database alone, no application code                  |
| `tests/security/community.test.ts`                | End to end, both gates, IDOR-A … IDOR-W                  |
| `tests/security/layered-defense.test.ts`          | The application alone, RLS bypassed                      |

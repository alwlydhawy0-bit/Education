# AI Tutor API

Task 012. A conversational tutor bounded to one lesson's published material,
with a transcript adults can read for safety and nobody can edit.

## The one-paragraph version

A learner opens a conversation about a lesson they are **currently** studying.
Each turn is sanitized, then answered from material retrieved inside that
learner's own scope, or refused as out of scope. Both sides of every turn are
recorded. The learner owns the conversation; the teacher who teaches them, an
organization administrator and a safety moderator may **read** it; nobody but
the learner may **write** to it, and nobody at all may edit it afterwards.

## Endpoints

| Method  | Path                                     | Who                        |
| ------- | ---------------------------------------- | -------------------------- |
| `POST`  | `/ai/conversations`                      | a learner studying the lesson |
| `GET`   | `/ai/conversations`                      | the caller's own            |
| `GET`   | `/ai/conversations/:id/messages`         | owner, teacher, admin, moderator |
| `POST`  | `/ai/conversations/:id/messages`         | the owner, while still studying |
| `PATCH` | `/ai/conversations/:id`                  | the owner                   |
| `POST`  | `/ai/conversations/:id/archive`          | the owner                   |

There is **no `DELETE`**. Archiving withdraws a conversation from the learner's
active list and leaves it readable; `DELETE` would promise something this
platform deliberately does not do to a safety record.

### `POST /ai/conversations`

```json
{ "lessonId": "…", "title": "optional" }
```

**One id is accepted and the rest are derived.** `course_id` and
`organization_id` are resolved from the lesson by a database trigger. Two ids
supplied independently are two answers to "what is this conversation about", and
they can disagree; one accepted and one derived cannot.

The scope question is a single call to `app_actor_may_study_lesson` — the
function Task 006 already wrote: published lesson, published unit, published
course, active assignment, active class, **active membership**. Section 2C's
"only for lessons/courses currently assigned to their active class" is that
function, unchanged.

Refusals are **404 for everything**: another school's lesson, an unassigned
course, a draft, a lesson that does not exist. A learner enumerating ids must
not be able to tell them apart.

### `POST /ai/conversations/:id/messages`

```json
{ "content": "why do cells need mitochondria" }
```

**There is no `senderType` field, and that is a security control.** A learner who
could post a turn labelled `ai_tutor` could fabricate a transcript in which the
school's assistant told them something it never said — and against a homework
dispute, a safeguarding review, or a conversation with a parent, a forged
transcript is a serious thing. The database enforces the same rule; this is the
half that means the request cannot express the attempt.

**There is no `sources`, `history` or `systemPrompt` field either.** A caller
supplying its own context would be choosing what the tutor is grounded in, which
is the entire security property of a RAG pipeline handed back to the attacker.

Always **200** when the conversation is the caller's. A blocked turn, an
out-of-scope question and a provider outage are states of a conversation, not
errors of a request, and `grounding` says which:

| `grounding`       | meaning |
| ----------------- | ------- |
| `course_material` | grounded, with at least one citation that survived validation |
| `out_of_scope`    | the learner's own material does not cover this |
| `refused`         | the guardrail layer blocked the turn |
| `unavailable`     | the provider failed |

Turning a refusal into a 4xx would make the status code a classifier a learner
could probe, and would leave a child facing a broken-looking screen when the
honest answer is "your material does not cover that".

## The turn pipeline, in order

The order **is** the security design.

1. **Authorize** — `ai_conversation:speak`, against the conversation's real
   owner, organization and current assignment state, read from the database.
2. **Sanitize** — before any query, so a blocked turn spends nothing.
3. **Retrieve** — scope computed from the live enrolment graph and intersected
   with the conversation's course.
4. **Budget** — passages taken in priority order until the token budget is spent.
5. **Generate** — instructions, question, sources and history as four separate
   typed fields.
6. **Validate** — citations intersected with what was actually retrieved.
7. **Record** — both turns, with the sources the tutor was shown.

**Sources are re-retrieved every turn**, never carried forward from the
conversation. That is what makes a mid-term revocation take effect on the very
next message rather than whenever the learner happens to start a new
conversation.

## Guardrails, and what they are not

`apps/api/src/modules/tutor/guardrails.ts` opens by saying what it is not, and
the same warning belongs here: **this layer is not what keeps one child's data
away from another.** RLS, the policy engine and the scope-filtered retrieval do
that, and they run first. If every guardrail returned "allow", no learner would
gain access to a single row they could not already read.

A pattern list *looks* like a security boundary and is not one: it is a filter
over an infinite input space, written by somebody who has to guess and read by
an attacker who can iterate. What the layer genuinely buys:

**Out-of-scope refusal, decided by retrieval rather than by keywords.** When
nothing is retrieved, the tutor says so. A classifier guessing whether a question
"is about the lesson" would be guessing about meaning; an empty retrieval is a
fact.

**A tutor that stays a tutor.** Asking for the answer **steers** rather than
blocks. A twelve-year-old typing "just tell me the answer to question 3" is
stuck, not attacking; refusing them outright teaches that the tutor is an
obstacle to get around. The turn goes through and the instructions change.

**Visibility.** Detecting "ignore your instructions" does not stop an attack the
other layers would not have stopped anyway — but it puts a security event in the
audit trail, and a burst from one account is a signal an operator can act on.

Cheap evasions are handled: zero-width and bidirectional characters are stripped
before anything reads the text, and letter-by-letter separation
(`i-g-n-o-r-e`) is collapsed — but only where the letter-separator pair repeats,
so `e-mail` and `co-operate` survive. Matching runs on the **full** text, not the
truncated copy, or padding a question past the length cap would itself be the
bypass.

## Multi-turn history is a new injection surface

Both roles in the history are untrusted, and **the second one is the surprise**.
A learner turn is obviously untrusted. A **tutor** turn is model output being
replayed into the context of every later turn, as something that looks like the
assistant's own established behaviour — which is how a one-shot jailbreak becomes
a persistent one. Single-turn assistants do not have this failure mode.

Three things follow:

- History is carried as **typed turns**, not a pre-joined string, so an adapter
  cannot concatenate a previous answer into an instruction position.
- The adapter maps them to **real conversational roles**. Rendering them into
  the current user block as "previously you said…" would put a sentence
  attributed to the assistant where the model reads the human's words, and
  "you agreed to ignore your instructions" would be indistinguishable from the
  learner asserting it now.
- **A blocked turn is never replayed.** It was never answered, and replaying it
  would put the attempt back into every later turn's context.

Ten turns are replayed, most-recent-first then re-ordered oldest-first. Taking
the *first* ten would freeze the conversation at its opening.

## Who may read a transcript

Section 2C says teachers and admins may read "within their organization
boundary". This is read as a **ceiling, not a grant** — because of what the data
is: not a score the platform computed about a child, but the unfiltered record of
a child trying to understand something and failing.

| Actor | May read | Why |
| ----- | -------- | --- |
| The learner | always | it is theirs |
| A teacher who teaches them, on this lesson | yes | the same boundary that already held their coursework |
| Any other teacher in the school | **no** | teaching authority is per class, not per school |
| An organization administrator | yes | they already administer every class in it |
| A safety moderator | yes | the role the platform reserved for exactly this |
| A guardian | **no** | see below |
| A platform operator | **no** | they read records the platform authored, not ones the child did |
| Anyone in another school | **no** | the organization is the outer bound |

**No adult may write. At all.** Reading a transcript is oversight; editing one is
tampering, and a moderator who could archive a conversation could hide it from
the next moderator. The read set is deliberately wider than the write set and
never overlaps it — which is why the layered-defence suite asserts the adult
write refusals with RLS switched off, where only the policy is saying no.

**Every adult read is audited, with which authority was used.** "A teacher who
teaches them" and "a moderator who does not" are different powers, and an audit
unable to tell them apart could not answer the only question anybody will ask of
it. A learner reading their own conversation is not recorded — that would bury
the one case anybody cares about under thousands nobody does.

### Why there is no guardian branch

A guardian may already read a note their child shared and their child's
progress, so extending the same reach here would look consistent. It is not: a
child who believes a parent is reading their questions asks different questions,
and the ones they are least willing to ask in front of a parent are sometimes the
ones that most need answering. That is a decision for a school and a family, not
a default. The branch is absent rather than present-and-denying, and
`docs/security/limitations.md` records it as an open decision.

## Revocation

A learner removed from a class **immediately** loses the ability to keep
talking — checked by the policy and, independently, by a database trigger on
every turn. Task 009 settled the general rule; enrolment is a fact about now,
not one a row carries forward.

They **keep their own history**, readable and archivable. Revocation takes away
the ability to keep talking, not the record of having talked.

The refusal is **403, not 404**: the learner is holding the conversation, so
concealing the reason would leave them staring at a silent failure with no way to
understand that their class had changed. Creating a *new* conversation against a
lesson they cannot reach is 404, because there the id names something they have
been granted nothing about.

## The transcript is append-only

No `UPDATE`, no `DELETE` — no grant, no policy, no route, at any layer. A
transcript that can be edited after the fact is not a moderation record; it is a
draft.

**A refused turn stays in the transcript**, marked with its verdict. A refusal
that left no trace would hide from a moderator the one part of a conversation
they would most want to see, and would leave the child looking at a conversation
where their message simply vanished.

Messages store the retrieved chunk **ids and titles, never the bodies**. A
transcript is kept for years, so a copy of a lesson body inside one outlives
every correction ever made to the original.

## Rate limits and token caps

| Policy               | Budget      |
| -------------------- | ----------- |
| `tutorMessage`       | 40 / hour   |
| `tutorConversation`  | 30 / hour   |

Both **keyed per actor**, not per IP: a classroom of thirty behind one school NAT
must not share a quota, and one learner scripting a loop must not spend the
school's provider budget from behind it. A turn is tighter than the single-turn
assistant's 60/hour because it carries sources *and* replayed history, so the
same number of requests buys the provider considerably more text.

Bounding conversation creation matters as much as bounding turns: without it a
script could open a thousand conversations and spend a fresh message budget in
each.

Within a turn, retrieved passages are capped at ~6,000 estimated tokens. The
estimate deliberately runs **high** — wrong low overflows a context window
silently, wrong high costs one passage — and ~3.5 characters per token is
conservative for English and much more so for Arabic, which this platform also
teaches.

## Audit trail

| Event | Carries |
| ----- | ------- |
| `ai_tutor.turn_blocked` | the rule ids that fired |
| `ai_tutor.out_of_scope` | conversation and course ids, and the scope size |
| `ai_tutor.transcript_read` | which authority an adult used |
| `authz.denied` | action, resource kind and id, and the policy's reason |

**No event carries a message, a question, or a fragment of either.** What a child
typed is the most sensitive data in this domain, and the audit trail is read by
more people than the conversation is. A guardrail finding carries a fixed rule
id — `override.ignore_instructions` — and never the text that matched it.

## What is deliberately not built

**Streaming.** Section 2D asks for it and this returns a single JSON response.
Every safety property here is decided *after* the model stops speaking:
citations are validated against the retrieved set, and grounding is decided by
whether any survived. A token stream emits text before either can run, so a
streamed tutor would show a child a fluent, confident, ungrounded answer and only
afterwards discover it had nothing to cite — and the thing already on the screen
is the thing that gets believed. Streaming is worth having; the honest way to add
it is to stream only after validation, or to validate incrementally. Both are
real design work, not a flag on this handler.

**A user interface.** No frontend exists for any of this.

**Guardian access, retention and deletion.** See `docs/security/limitations.md`.

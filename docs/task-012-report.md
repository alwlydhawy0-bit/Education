# Task 012 — AI tutor and assistant integration

**Status: COMPLETE for the server. There is no user interface and no streaming
API, and neither was built.** Streaming is named in section 2D and is
deliberately absent for a reason given in §8 rather than skipped quietly.

Vocabulary: **VERIFIED** — measured here. **PARTIALLY VERIFIED** — measured in
one layer only. **UNVERIFIED** — not measured. **OPEN RISK** — known and
accepted.

---

## 1. IMPLEMENTED

| Layer          | File                                                        |
| -------------- | ----------------------------------------------------------- |
| Schema         | `db/migrations/0027_ai_tutor_conversations.sql` (636 lines)  |
| Guardrails     | `apps/api/src/modules/tutor/guardrails.ts`                   |
| Retrieval port | `apps/api/src/modules/tutor/retrieval.port.ts`               |
| Authorization  | `packages/authz/src/policies/ai-conversation.policy.ts`      |
| Contract       | `packages/contracts/src/tutor.contract.ts`                   |
| API            | `apps/api/src/modules/tutor/` — repository, service, routes  |
| Provider       | `platform/ai/provider.ts` — `AiConversationTurn`, `history`  |
| Docs           | `docs/api/ai-tutor.md`                                       |

Two tables and six routes:

- `POST /ai/conversations`, `GET /ai/conversations`
- `GET /ai/conversations/:id/messages`, `POST /ai/conversations/:id/messages`
- `PATCH /ai/conversations/:id`, `POST /ai/conversations/:id/archive`

`ai_conversations` accepts **one** id — the lesson — and derives `course_id` and
`organization_id` in a trigger. `ai_messages` is append-only, ordered by a
database-assigned `seq`, and carries `owner_id` under a composite foreign key.

### The four decisions that shaped everything

1. **The read set is wider than the write set, and never overlaps it.** Adults
   read for safety; nobody but the learner writes. A moderator who could archive
   a conversation could hide it from the next moderator.
2. **Ownership is a composite foreign key, not a lookup.** Referential integrity
   runs beneath RLS, beneath `SECURITY DEFINER`, and beneath any question about
   which role is executing.
3. **Sender type cannot be decided by identity.** The learner's turn and the
   tutor's reply are written in the same request, by the same session, as the
   same actor — so the database can only tell them apart by PATH. The migration
   says exactly what that buys and what it does not.
4. **Enrolment is re-asked on every turn**, in the trigger and independently in
   the policy.

---

## 2. VERIFIED

| Requirement (§2, §3)                                     | Status | Evidence |
| -------------------------------------------------------- | ------ | -------- |
| `ai_conversations` / `ai_messages` with CASCADE, indexes, unique constraints | VERIFIED | 0027; `ai_messages_seq_uk`; three purpose-built indexes |
| Prompts built ONLY from authorized context chunks         | VERIFIED | Provider-gate suite asserts on the request that leaves the server |
| Anti-injection middleware, jailbreak and override         | VERIFIED | 49 unit cases; 5 attack shapes over HTTP; F15 injection |
| Step-by-step rather than doing homework                   | VERIFIED | Steer, not block; separate appended constant; F7 injection |
| Out-of-scope refusal                                      | VERIFIED | Decided by retrieval, not keywords; F8, F16 injections |
| Students create/read messages ONLY in their own conversations | VERIFIED | 29 RLS + 40 HTTP + 11 RLS-off cases |
| Conversation scope limited to currently-assigned coursework | VERIFIED | `app_actor_may_study_lesson` at creation AND every turn; F4, F5 |
| Teachers/admins read within their organization boundary   | VERIFIED | Teacher-of-this-learner, org admin, moderator; F1, F2, F3 |
| Conversation lifecycle endpoints                          | VERIFIED | Six routes, live boot, all 401 anonymous |
| Streaming chat API                                        | **NOT BUILT** | §8 — deliberate, with reasoning |
| Never invent information outside retrieved chunks         | VERIFIED | Citations validated against the retrieved set; F9 injection |
| Prevent injection bypassing RLS or inspecting metadata    | VERIFIED | Layered-defence block with RLS off; provider-gate suite |
| Rate limits and token caps                                | VERIFIED | Two per-actor policies; 6,000-token source budget |
| Answer QUALITY from a real model                          | **UNVERIFIED** | RISK-TUTOR-05 |

---

## 3. SECURITY

**The guardrail layer is not the boundary, and its own header says so.** RLS,
the policy engine and the scope-filtered retrieval decide access and run first.
If every guardrail returned "allow", no learner would gain a single row. A
pattern list *looks* like a boundary and is a filter over an infinite input
space written by somebody who has to guess.

**A forged tutor turn is stopped at two layers that fail differently.** The
contract has no `senderType` field, so the request cannot express the attempt;
the RLS policy admits a non-student sender only for the conversation a
transaction-local marker names, set by one function with one call site that a
fitness function pins. The migration is explicit that this is a path marker, not
an identity check.

**The transcript is append-only at every layer** — no grant, no policy, no
route, no application statement. A transcript that can be edited is not a
moderation record.

**Multi-turn history is a new injection surface, and the tutor's own prior turns
are the dangerous half.** Model output replayed into later context looks like
the assistant's established behaviour, which is how a one-shot jailbreak becomes
persistent. History is carried as typed turns, mapped to real conversational
roles, and a blocked turn is never replayed.

**The audit trail carries rule ids, never text.** What a child typed is the most
sensitive data in this domain; the trail is read by more people than the
conversation is.

**Adult reads are audited with WHICH AUTHORITY was used.** "A teacher who
teaches them" and "a moderator who does not" are different powers.

---

## 4. IDOR / BOLA matrix

Over real HTTP in `tests/security/ai-tutor.test.ts` (40 cases, groups A–I).

| #  | Attempt                                                     | Result | Refused by |
| -- | ----------------------------------------------------------- | ------ | ---------- |
| 1  | Peer reads another learner's transcript by exact id          | 404 | policy + RLS |
| 2  | Peer speaks into another learner's conversation              | 404 | policy + RLS + trigger |
| 3  | Peer renames or archives it                                  | 404 | policy |
| 4  | Learner in another school reads it                           | 404 | policy + RLS |
| 5  | Id that names nothing                                        | 404 | indistinguishable from 1–4 |
| 6  | Create against another school's lesson                       | 404 | policy (`hide`) + RLS |
| 7  | Create against an unassigned course in the same school       | 404 | `app_actor_may_study_lesson` |
| 8  | Create against a draft lesson in a studied course            | 404 | same |
| 9  | Create by a learner in no class                              | 404 | same |
| 10 | Ask a question matching another school's text                | no leak | scope pre-filter |
| 11 | Jailbreak — ignore instructions / reveal prompt              | 200 `refused`, logged | guardrails |
| 12 | Jailbreak — answer key, api key, other students' answers     | 200 `refused`, logged | guardrails |
| 13 | Body carrying `senderType`                                   | 400 | `.strict()` |
| 14 | Body carrying `studentId` or `courseId`                      | 400 | `.strict()` |
| 15 | Body carrying `sources`, `history` or `systemPrompt`         | 400 | `.strict()` |
| 16 | Unrelated teacher in the same school reads                   | 404 | policy |
| 17 | Moderator of another school reads                            | 404 | `app_actor_moderates_conversation` |
| 18 | Moderator writes or archives                                 | 404 | policy (no write branch) |
| 19 | Learner speaks after leaving the class                       | 403 | policy + trigger |
| 20 | Learner speaks after the course is withdrawn                 | 403 | same |
| 21 | Teacher reads after the learner leaves their class           | 404 | `app_actor_observes_learner_lesson` |
| 22 | Response inspected for org id, token count, latency          | absent | field-by-field `.strict()` |
| 23 | Anonymous caller, all six routes                             | 401 | confirmed on a live boot |

**Cases 1–5, 16–19 re-run against `edu_app_norls` (BYPASSRLS)** in
`layered-defense.test.ts`, after a case proving both schools' conversations and
the transcript are visible to the raw connection.

**Provider-boundary cases** (`ai-tutor-provider-gate.test.ts`): a lying provider
claiming grounding with fabricated citations is refused; a blocked turn never
reaches the provider and never enters replayed history; the request carries no
learner id, email, organization or session token.

---

## 5. ARCHITECTURE

The `tutor` module owns `ai_conversations` and `ai_messages` and writes to no
other domain's tables. It **composes**: Task 011's vector retriever, Task 013's
live full-text retriever, the same policy engine, the same provider abstraction.

**It imports no other module.** It declares `TutorRetriever` — a port narrower
than either repository, unable to index, write, or accept a vector — and the
composition root supplies the adapter. That was not the first design;
`dependency-rules.test.ts` rule 3 caught the direct imports, and the fix is the
one the rule's own comment prescribes rather than an exception to it.

**Two retrievers, and the second is not convenience.** The Task 011 report
recommended automatic re-indexing *before* building the tutor, because the
vector index is a derived store nothing rebuilds on publish. Building them in
this order was the user's call; the mitigation is that full-text search reads
live lessons and cannot go stale, so a missing index costs relevance rather than
coverage. Both retrievers are independently scope-guarded.

---

## 6. FILES CHANGED

**Added**

- `db/migrations/0027_ai_tutor_conversations.sql`
- `apps/api/src/modules/tutor/{guardrails,retrieval.port,tutor.repository,tutor.service,tutor.routes}.ts`
- `packages/authz/src/policies/ai-conversation.policy.ts`
- `packages/contracts/src/tutor.contract.ts`
- `tests/unit/tutor-guardrails.test.ts` (49)
- `tests/integration/rls-ai-conversations.test.ts` (29)
- `tests/security/ai-tutor.test.ts` (40)
- `tests/security/ai-tutor-provider-gate.test.ts` (7)
- `tests/architecture/tutor-boundaries.test.ts` (34)
- `docs/api/ai-tutor.md`

**Modified**

- `platform/ai/provider.ts` — `AiConversationTurn`, optional `history`
- `platform/ai/anthropic.adapter.ts` — history as real conversational roles
- `packages/authz/src/{types.ts,engine.ts,index.ts}` — resource, actions, wiring
- `apps/api/src/app.ts` — the retriever adapter and tutor wiring
- `apps/api/src/modules/assistant/stop-words.ts` — closed-class English words
- `apps/api/src/platform/security/rate-limit.ts` — two policies
- `packages/observability/src/security-events.ts` — three event types
- `tests/setup/fixtures.ts`, `tests/security/layered-defense.test.ts` (+11)
- `docs/security/{limitations,vulnerability-log}.md`, `docs/architecture/domain-boundaries.md`

---

## 7. TEST RESULTS

Full serial gate, all six projects, clean tree:

| Project      | Files | Tests |
| ------------ | ----- | ----- |
| unit         | 24    | 962   |
| architecture | 9     | 244   |
| web          | 3     | 53    |
| integration  | 16    | 520   |
| security     | 26    | 887   |
| evaluation   | 2     | 38    |
| **total**    | **80** | **2,704** |

Typecheck and lint clean across all seven workspace projects. Live boot: all six
routes registered, all six 401 to an anonymous caller.

### Defect injection — round 11

Sixteen defects. **Fourteen caught on the first pass; both escapes closed and
the round re-run 16 for 16.**

| #   | Defect | Caught by |
| --- | ------ | --------- |
| F1  | Moderator may write as well as read | HTTP + RLS-off |
| F2  | Any teacher in the org may read any transcript | HTTP + RLS + RLS-off |
| F3  | Cross-tenant clause dropped from the moderation helper | HTTP + RLS |
| F4  | Assignment no longer re-asked per turn | RLS |
| F5  | Policy admits a speak turn after revocation | HTTP + RLS-off |
| F6  | Conversation course trusted instead of intersected | HTTP |
| F7  | Blocked turn sent to the provider anyway | 7 across three suites |
| F8  | Out-of-scope answered from general knowledge | HTTP |
| F9  | Citation validation skipped, model's claim trusted | **provider gate alone** |
| F10 | Blocked turn replayed into later context | **provider gate alone** |
| F11 | Caller-supplied `senderType` accepted | HTTP + fitness |
| F12 | Inner join restored, display lookup vetoes visibility | 7 across two suites |
| F13 | Owner scope dropped from the listing | RLS-off |
| F14 | Learner's message written into the audit trail | HTTP |
| F15 | Guardrails matched against the truncated text | unit |
| F16 | Closed-class stop words reverted | HTTP |

F9 and F10 escaped every suite because **nothing asserted on what the server
SENDS to a provider** — only on what comes back, where both are invisible.

---

## 8. NOT IMPLEMENTED

**Streaming (section 2D), and this is a deliberate deviation.** Every safety
property in this task is decided *after* the model stops speaking: citations are
validated against the retrieved set, and grounding is decided by whether any
survived. A token stream emits text before either can run, so a streamed tutor
would show a child a fluent, confident, ungrounded answer and only afterwards
discover it had nothing to cite — and the thing already on the screen is the
thing that gets believed. The honest way to add it is to stream only after
validation, or to validate incrementally; both are real design work, not a flag
on this handler.

**Any user interface.** No frontend for conversations, transcripts or moderation.

**Portfolios, research artifacts, community analytics** — excluded by §1.

Not excluded but absent, and named as gaps: guardian access, retention and
deletion, escalation on repeated jailbreak attempts, and any measurement of
answer quality.

---

## 9. KNOWN RISKS AND DEFECTS FOUND

### Found and fixed

**VULN-050 — the same `SECURITY DEFINER` mistake, eleven migrations later.**
`app_conversation_owner` returned NULL for every conversation: a definer
function runs as the table owner, `FORCE ROW LEVEL SECURITY` binds the owner
too, and every policy is `TO edu_app`. **This is VULN-044, rediscovered by the
person who wrote VULN-044.** The lesson had been written down, indexed and
searched, and cost the same day's work twice. Ownership is now a composite
foreign key — a structure that cannot be forgotten the way a rule can.

**VULN-051 — a refusal that leaked whether a stranger's conversation was
empty.** `seq` was computed under the caller's row security, so an outsider
always got 1 and received "duplicate key" for a used conversation and a
row-security refusal for an empty one. Both refused; the *refusal* leaked.

**VULN-052 — revocation stopped at the door.** Creation asked
`app_actor_may_study_lesson`; nothing asked again. Now every turn does.

**VULN-053 — a stop word that turned the honesty guarantee off.** "Who won the
football world cup in 1998", asked of a lesson about cells, came back grounded
as course material: `in` was not a stop word and the lesson says "respiration IN
the mitochondrion". **RISK-AI-09 is this exact failure, recorded as fixed** — the
fix landed for Arabic and the long English words and stopped. A fix applied to
the instance is not a fix applied to the class.

**VULN-054 — a display join held a veto over authorization.** An inner join to
`lessons` (RLS-narrowed) silently overrode the moderation policy and hid a
departed learner's own history. Every join in an authorization-sensitive read is
a potential AND in the access predicate whether or not it was meant as one.

**A cross-tenant existence oracle in the policy**, found by the RLS-off suite:
`create` denied with `reveal`, distinguishing "exists but not yours" from "does
not exist" whenever the database was not also refusing. Disclosure now differs by
verb.

**An architecture violation I shipped.** The tutor imported two other modules.
Caught by a rule written for a different task — the argument for platform-wide
structural rules over per-feature ones.

### Open risks

| Id | Risk |
| -- | ---- |
| RISK-TUTOR-01 | No guardian access, recorded as an OPEN decision rather than a settled one |
| RISK-TUTOR-02 | No retention policy and no deletion path, for the most sensitive data on the platform |
| RISK-TUTOR-03 | The guardrail layer is a filter over an infinite input space |
| RISK-TUTOR-04 | Blocked turns are recorded; nothing escalates or alerts |
| RISK-TUTOR-05 | No evidence about how a real model behaves under the multi-turn surface |
| RISK-TUTOR-06 | Retrieval quality unmeasured; the vector index may be empty |
| RISK-TUTOR-07 | Moderation reads are audited but otherwise uncontrolled — no rate limit, no justification, no notice to the learner |

Carried forward: the API is not deployed; the Vercel Root Directory is still
`apps/api` and `apps/api/vercel.json` should go once corrected;
`@vercel/speed-insights` sends Web Vitals to a third party from a children's
platform.

---

## 10. NEXT TASK

**Recommend ONE: moderation and safety operations for the tutor.**

Not the frontend, and not the streaming API. The tutor now produces the most
sensitive data this platform has ever stored, and the operational half of
handling it does not exist. Concretely: escalation when one account trips the
guardrails repeatedly (today fifty attempts an hour produce fifty audit rows and
nothing else); a moderator's working view over a school's conversations rather
than one-at-a-time id lookups; a retention schedule and a deletion path; and a
decision — with a design, not a default — on guardian access.

Every one of those is a RISK-TUTOR entry, and they share a property that makes
them one task rather than four: they are all about what happens *after* a
conversation exists, which is precisely the part this task built the data for
and none of the machinery for. Shipping a UI first would multiply the volume of
that data without improving anybody's ability to supervise it.

The second candidate, and the one to do immediately after, is **automatic
re-indexing on the content lifecycle** — carried over from the Task 011
recommendation, now with a second consumer depending on the index. The tutor's
full-text fallback means staleness costs relevance rather than correctness,
which is why it is no longer first; but two features now quietly degrade when
nobody re-indexes, and neither says so.

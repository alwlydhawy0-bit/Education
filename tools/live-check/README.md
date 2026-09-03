# Live check — release and review over real HTTP

**Development only.** This seeds a school, a class, a learner, a teacher and one
assessment whose `review_policy` is `on_release` into a database you name, so
the Task 009 endpoints can be driven against a BOOTED server rather than through
`app.inject`.

The automated suites already cover the behaviour. What they cannot cover is what
a real server process writes to its log, and that is the reason this exists: the
review endpoint is the only one in the platform that returns answer keys, so
"does it end up in the log?" is a question worth answering against the real
logger rather than the test harness.

It refuses to run without an explicit `LIVE_PASSWORD`; there is no default,
because a seed script with a built-in password is a credential in the
repository. It writes only through the test fixtures, so a schema change cannot
leave a second, stale copy of the seeding SQL behind here.

```sh
# 1. Point at a DEVELOPMENT database. Never a real one.
export TEST_SUPERUSER_URL='postgres://…/edu_dev'
export LIVE_PASSWORD='<a passphrase you choose>'

# 2. Seed. Prints the ids the requests need, as JSON.
node --experimental-strip-types tools/live-check/seed.ts

# 3. Boot the API and drive the endpoints with those ids, then search the
#    server log for the correct option id, the prompt, the explanation, the
#    teacher's comment, the password and any session token. None should appear.
```

`seed-mastery.ts` does the same for Task 010: a course with two objectives and
two assessments, so the `demonstrated` → `mastered` transition (which needs two
DIFFERENT assessments passed, not two attempts at one) can be walked through the
real endpoints.

`seed-assistant.ts` does the same for Task 013, and seeds **two** schools —
because the property worth driving against a real server is a negative one, and
one school cannot demonstrate it. Each school's lesson carries a marker word
absent from the other's, and school B's lesson additionally carries an injected
instruction, so one run covers cross-tenant refusal, draft refusal, absent-lesson
refusal, prompt injection, forged request fields, the read-only guarantee, the
per-actor quota, and what the real logger writes.

```sh
export TEST_SUPERUSER_URL='postgres://…/edu_dev'
export LIVE_PASSWORD='<a passphrase you choose>'
node --experimental-strip-types tools/live-check/seed-assistant.ts

# Then boot the API and, with the ids it printed:
#   A asks about A's lesson           → 200, grounding=course_material
#   A names B's lesson                → 404
#   A names A's own DRAFT lesson      → 404
#   A names a lesson that does not exist → 404   (all three IDENTICAL)
#   B asks with an injected instruction in B's own lesson → quoted as prose
#   any forged field (learnerId, organizationId, role, sources, systemPrompt,
#     model, instructions)            → 400
#   61st request in an hour           → 429, and the other learner is unaffected
# Then snapshot lesson_progress / objective_evidence / assessment_attempts /
# lessons before and after a batch of imperative questions: identical.
# Finally search the log for the question text, the answer text, the injected
# instruction, the system instructions, the password, a session token, the
# database password and a chunk id. None should appear.
```

The results of all three runs are recorded under "What was actually verified" in
`docs/security/limitations.md`.

## Task 014 — the first live provider call

**Not performed.** No provider credential exists in this development
environment, so no request has ever been made to a real model from this
repository. The adapter is exercised against the real SDK over a stubbed
transport (`tests/unit/anthropic-adapter.test.ts`), which proves how the
platform treats a provider's output and proves nothing about the model.

When a credential does exist, the first live call is a deployment step with its
own verification, not a configuration change. Run it on a development database,
with the seed above, and treat a surprise as a blocker:

```sh
export AI_PROVIDER=anthropic
export AI_API_KEY='<the credential>'   # server-side only; never a VITE_ variable
export AI_MODEL=claude-opus-5          # allowlisted; an unknown value refuses to boot
node --env-file-if-exists=.env --experimental-strip-types apps/api/src/main.ts

# 1. An authorized question, against the learner's own lesson.
#    Expect 200, grounding=course_material, and EVERY source naming a lesson of
#    that learner's own course.
# 2. An irrelevant question ("explain photosynthesis" against a cell lesson).
#    Expect insufficient — NOT a confident answer from general knowledge.
# 3. A prompt injection, in the question and in a lesson body.
#    Expect no other school's marker word, no answer key, no system prompt.
# 4. A malformed/edge question (one word, punctuation only, 1,000 characters).
# 5. A failure: point AI_TIMEOUT_MS at 1000 and confirm the learner sees the
#    ordinary "unavailable" state and the log carries ai.provider_failed with a
#    kind and nothing else.
# 6. Citations: check every returned source id against what the lesson actually
#    contains. A citation naming something not retrieved is a BLOCKER, not a
#    quality issue — though the server should already have dropped it.
#
# Then search the log for the question text, the answer text, the API key, the
# system instructions and any vendor error string. None should appear.
```

Record what actually happened, including anything that did not match the
expectations above. A live run that is not written down is a live run that was
not performed.

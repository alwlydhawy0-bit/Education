# Interactive Labs API

Task 009. A **lab** is a practical the learner works through in the browser: a
circuit to close, a logic gate to wire, a physics scene to settle. The browser
runs the simulation; **this server runs nothing**. It stores the state the
learner reached and decides, from declarative rules the learner cannot read,
whether that state satisfies the lab.

The thing that makes labs different from every surface before them is how you
finish one. An assessment is finished by CHOOSING; a lab is finished by
REACHING A STATE. That single difference is behind most of the decisions below —
above all the reason nobody but the learner may write into a session, including
their teacher.

## The one-paragraph version

A lab hangs off a `learning_activity` of type `simulation` or `experiment`. Its
**scene** (`initial_config`) is public to anyone who may see the activity — it is
the question. Its **validation rules** live in their own table with their own
policy, because they are the answer. A learner **starts a session**, **saves**
the state as they build it, and **submits**; a trigger marks the submitted state
against the rules using a function the application role may not call, and
overwrites `passed` and `status` from the result. Everything about who may read
that session is the same rule, through the same helpers, that governs an
assessment attempt.

## Endpoints

### Authoring — requires a content permission

| Method | Path                                | Permission       |
| ------ | ----------------------------------- | ---------------- |
| `PUT`  | `/api/v1/activities/:id/experiment` | `content:author` |

**There is no `POST /experiments`, and no publish route here.** A lab is an
activity, and `POST /api/v1/lessons/:id/activities`,
`POST /api/v1/activities/:id/publish` and `.../archive` already create, publish
and archive one. A second publish path would mean two places deciding when
children can see a lab, and the database's publication gate would be enforcing
only one of them.

The `PUT` is an **upsert carrying the scene and the rules together**. Two
endpoints would leave a window in which a lab had a scene and no rules row — and
the database refuses to publish such a lab, so the window is an activity an
author can neither publish nor diagnose.

### Reading

| Method | Path                      | Who                             |
| ------ | ------------------------- | ------------------------------- |
| `GET`  | `/api/v1/experiments/:id` | anyone who may see the activity |

**Two response shapes, not an optional field.** A learner receives
`ExperimentResponse`, which has no property that could hold a rule.
An author receives `AuthoredExperimentResponse`, which adds `rules`. Which one
is sent is decided by whether the database handed over a rules row at all — RLS
does that for `content:author` or `content:publish` in the lab's own school, and
for nobody else. An optional field would be a shape whose safety depended on
somebody remembering to omit it.

### Working

| Method | Path                                        | Who                                       |
| ------ | ------------------------------------------- | ----------------------------------------- |
| `POST` | `/api/v1/experiments/:id/sessions`          | the learner, if they reach it via a class |
| `PUT`  | `/api/v1/experiment-sessions/:id/state`     | the session's owner, while in progress    |
| `POST` | `/api/v1/experiment-sessions/:id/submit`    | ”                                         |
| `POST` | `/api/v1/experiment-sessions/:id/artifacts` | ”                                         |

`POST .../sessions` **resumes rather than duplicates**: one live session per
learner per lab is a partial unique index, so a second start returns the session
already open. Reopening a lab you left open is what a learner expects, and it
means a flaky network cannot cost somebody their work.

### Reading sessions

| Method | Path                                                          | Who                                                                             |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/experiment-sessions/:id`                             | owner · verified guardian · teacher of the shared class · `admin` of the school |
| `GET`  | `/api/v1/experiment-sessions/:id/artifacts`                   | ”                                                                               |
| `GET`  | `/api/v1/me/experiment-sessions`                              | the learner                                                                     |
| `GET`  | `/api/v1/classes/:id/students/:studentId/experiment-sessions` | teacher of THAT class · `admin` of its school                                   |
| `GET`  | `/api/v1/guardians/children/:childId/experiment-sessions`     | verified guardian                                                               |

## Writing is the learner's alone

There is no route, and no branch in `experimentSessionPolicy`, through which a
teacher, a guardian, an administrator or a platform operator can open, save or
submit a lab session in somebody else's name. All three write actions are
checked BEFORE the platform-operator branch — the same inversion
`lessonProgressPolicy` and `assessmentAttemptPolicy` make, for the same reason.

The rule is sharper here than for an assessment, and this is why it is stated
twice. **A lab is finished by reaching a state.** An adult who could save into a
child's session could assemble the passing circuit themselves and let the
trigger mark it — and the record would say the child did it. `save` is a write
action rather than an incidental part of reading precisely so that denial has
somewhere to live.

Appending an artifact is authorized as `experiment_session:save`, not as a
fourth action: it is available at the same moments, to the same person, and
refused by the same RLS clause. A separate action would be a second rule for one
authority.

## The rule language

A rule is `{"path": "a.b.c", "op": "<operator>", "value": <json>}`.

- **`path`** is a dot-separated walk into the state object. Segments are
  `[A-Za-z0-9_]` only, at most eight deep. No wildcards, no array slicing, no
  `..`. It reaches SQL as an ARRAY argument to `#>`, never as interpolated text.
- **`op`** is one of a closed set: `exists`, `absent`, `eq`, `neq`, `isTrue`,
  `isFalse`, `lengthEq`, `lengthGte`, `lengthLte`, `gt`, `gte`, `lt`, `lte`,
  `approx`.
- **`value`** is compared, never executed. `approx` carries a `tolerance`,
  because physics does not land on exact decimals.

**There is no evaluator.** There is nothing to parse, no recursion, and no
function call, so there is nothing to escape from. The most dangerous thing a
malicious rule can do is fail to match.

**Evaluation is total.** An unknown operator, an unresolvable path, a value of
the wrong shape and a malformed rule all evaluate to false, and an outer
`EXCEPTION WHEN OTHERS` returns false as well. An error on a child's submission
would be a way to make their lab unmarkable.

The operator list and the path pattern exist in two places — the Zod contract
and the SQL publication gate — and
`tests/architecture/experiment-boundaries.test.ts` compares the two texts. A
divergence would not open a hole; it would produce a lab an author can save and
can never publish, which is a worse day than a 400.

## `code_sandbox` is a label

`simulation_type` accepts `code_sandbox`. It names a sandbox that runs **in the
browser**. Nothing on the server executes learner code, nothing here is a step
toward that, and a future task that wanted server-side execution would be a
different piece of work with a different threat model — not a new value in this
enum.

## Payload limits, in the order they fire

| Layer                       | `currentState` | `initialConfig` | artifact `payload` |
| --------------------------- | -------------- | --------------- | ------------------ |
| Zod contract → `400`        | 192 KiB        | 64 KiB          | 128 KiB            |
| Fastify `bodyLimit` → `413` | 256 KiB        | 256 KiB         | 256 KiB            |
| SQL `CHECK`                 | 256 KiB        | 64 KiB          | 128 KiB            |

The contract cap sits strictly below the transport limit **so that it can
actually fire**; set equal, the transport refused first and the 400 naming the
field was unreachable (VULN-043).

Bytes are not the only bound. `checkStatePayload` also caps **depth** (12) and
**node count** (20 000), because `{"a":{"a":{"a":…}}}` is small and deep, and
deep is what costs a JSON serializer. It walks with an explicit stack: a
recursive walk would answer "too deep" with a stack overflow, which is a 500
rather than a 400.

## A lab has no attempt limit, deliberately

An assessment has `max_attempts`, enforced per learner by a database trigger. A
lab has nothing equivalent, and should not: **"keep adjusting it until the
circuit works" is the pedagogy, not a loophole in it.** A lab that locked a child
out after three tries would be a worse lab.

The consequence is that `lab.session_start`'s rate limit is the only bound on
how many sessions one source can open. It protects platform cost. It does not
protect the rules, and does not need to: a submission answers "not yet", never
"the voltage must be 5", so a scripted grinder learns one bit per attempt about
a lab it was already allowed to attempt.

## Security events

| Event                     | When                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `lab.session_started`     | a learner opens a new session                                     |
| `lab.submitted`           | a session is marked. Carries the STATUS, never the state or rules |
| `lab.state_write_refused` | the policy allowed a write and RLS then matched zero rows         |
| `authz.denied`            | every denial, with ids and a reason and nothing that was refused  |

`lab.state_write_refused` is the one that is not a mirror of an assessment
event. It records an access loss that landed BETWEEN the policy decision and the
`UPDATE` — a class ended, a course was withdrawn mid-session. It is expected and
it is not an error. A burst across many learners is a roster change nobody
warned the teachers about; a burst from one actor across many sessions is
somebody replaying a session id they no longer hold.

The ordinary case — an access loss that has already happened when the request
arrives — is refused by the POLICY and recorded as `authz.denied`. Which of the
two fires tells you which layer caught it.

## Where each rule is enforced

| Property                                | Policy engine | RLS | Trigger / CHECK |
| --------------------------------------- | :-----------: | :-: | :-------------: |
| Only the learner writes their session   |       ✓       |  ✓  |        ✓        |
| The outcome is computed, never accepted |       —       |  —  |        ✓        |
| The rules are hidden from learners      |       —       |  ✓  |        —        |
| A published lab is frozen               |       ✓       |  ✓  |        ✓        |
| One live session per learner per lab    |       —       |  —  |        ✓        |
| Instant state isolation                 |       ✓       |  ✓  |        —        |
| Payload size and shape                  |       ✓       |  —  |        ✓        |
| Artifacts are append-only               |       —       |  ✓  |   (no grant)    |

Each ✓ is asserted by its own suite: `tests/unit/experiment-policy.test.ts` for
the policy column, `tests/integration/rls-experiments.test.ts` for the middle
one with no application code in the path, `tests/security/experiments.test.ts`
for all of it end to end over HTTP.

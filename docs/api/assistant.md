# Learning Assistant API

Task 013. One endpoint. A learner asks a question about the lesson they are
reading and gets an answer built from **their own course material**, with
references they can check.

It is a foundation, not a tutor: no conversation, no history, no follow-up, no
personalisation, no tools, and no ability to change anything on the platform.

The security architecture is in
[`docs/security/ai-security.md`](../security/ai-security.md). This document is
the wire contract.

## `POST /api/v1/assistant/ask`

**Authentication:** required. **Quota:** 60 requests per hour per authenticated
actor (`ai.request`), enforced _after_ authentication so it keys on the actor
rather than an IP.

### Request

```json
{
  "question": "ما هي وظيفة الميتوكوندريا؟",
  "lessonId": "0f0a7c3e-…"
}
```

| Field      | Type   | Rules                             |
| ---------- | ------ | --------------------------------- |
| `question` | string | trimmed, 3–1,000 **characters**   |
| `lessonId` | uuid   | the lesson the learner is reading |

The schema is `.strict()`. **Any other field is a `400`**, not a silently
ignored extra — including `learnerId`, `userId`, `organizationId`, `classId`,
`role`, `sources`, `systemPrompt`, `model` and `temperature`. None of those
exist in the shape, so a forged identity is not filtered out; it is
unrepresentable.

`lessonId` is **navigation intent, not authorization**. The server re-resolves
it against the caller's own permissions — the same `lesson:read` decision
`GET /lessons/:id` makes — and answers `404` if it does not reach them.

The cap is in characters rather than bytes because Arabic costs two UTF-8 bytes
per character and the limit has to mean the same thing in both languages. It is
far below the body limit on purpose: a 50,000-character "question" is either an
attempt to exhaust provider tokens or an attempt to bury an instruction where a
reviewer skims past it.

### Response — `200`

```json
{
  "grounding": "course_material",
  "answer": "…",
  "sources": [
    {
      "id": "lesson:0f0a7c3e-…#2",
      "kind": "lesson",
      "lessonId": "0f0a7c3e-…",
      "lessonTitle": "الخلية",
      "excerpt": "الميتوكوندريا هي مصدر الطاقة في الخلية…"
    }
  ],
  "searchedSources": 7
}
```

| Field             | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `grounding`       | `course_material` \| `insufficient` \| `unavailable` — **decided by the server** |
| `answer`          | Empty unless `grounding` is `course_material`                                    |
| `sources`         | Validated references. Empty unless `grounding` is `course_material`              |
| `searchedSources` | How many authorized passages were searched. A **count**, never the passages      |

#### `grounding` is the field that matters

A learner has to be able to tell "your textbook says this" from "a language
model says this".

- **`course_material`** — at least one citation survived validation against what
  was actually retrieved.
- **`insufficient`** — the learner's authorized material does not cover the
  question. The assistant says so rather than answering from general knowledge
  and letting it look like coursework.
- **`unavailable`** — the assistant could not answer at all. Says nothing about
  the question or about the material.

The server decides this from whether a validated citation exists — never from
the model's claim about itself. **A client must render this field and must not
re-derive it** from `sources.length`; doing so would be a second implementation
of the rule, and the copy nobody tests is the one that drifts.

#### `sources` are validated, not claimed

Every field of a reference is copied from a row the server read under the
caller's own authorization, _after_ the provider answered. The provider's claimed
citation ids are intersected with the ids actually retrieved and the survivors
are rebuilt from the retrieved rows.

So a reference **cannot** name a lesson that does not exist, a lesson the caller
cannot read, or a passage that was never retrieved. Fabricated book names, page
numbers, URLs and quotations have no field to arrive in.

`excerpt` is the **retrieved text**, not the model's paraphrase — so a reader can
check the answer against the source without trusting the answer.

#### `id` shape

`lesson:<uuid>#<n>` for a body paragraph, `objective:<uuid>` for a learning
objective. Chunking happens at read time, so `<n>` is stable for a given body
and **changes when the body changes**: a citation cannot outlive the text it
pointed at.

### Errors

| Status | When                                                                       |
| ------ | -------------------------------------------------------------------------- |
| `400`  | The body does not match the contract — including any unknown field         |
| `401`  | Not authenticated                                                          |
| `404`  | The lesson does not exist, is not the caller's, is a draft, or is archived |
| `429`  | Quota exhausted                                                            |
| `500`  | Unexpected server fault                                                    |

**All five `404` reasons give the same answer**, exactly as `GET /lessons/:id`
does. A caller is not entitled to learn which — and the assistant is a
particularly attractive endpoint on which to probe, because a `200` would
summarise whatever it found.

A provider outage is **not** an error status. It is a `200` with
`grounding: "unavailable"`, because the request was valid and was authorized;
only the answer is missing.

### What is never in a response

System instructions, the provider's name, the model, the raw completion,
retrieval internals (search terms, ranks, SQL, chunking), reasoning or
chain-of-thought, provider error text, and any hint that a lesson exists but is
not the caller's.

The response is parsed field-by-field through a `.strict()` schema on the way
out, so a future change that started returning an internal field fails at the
boundary rather than reaching a browser.

## Retrieval scope

The **course of the lesson named**, and nothing else. `lessons` and
`learning_objectives` only — assessment questions, options, explanations and
answer keys are never read, by any query, at all.

Retrieval reads the **live** curriculum rows. There is no chunk table and no
embedding, so an archived lesson becomes unretrievable in the same instant it
leaves the learner's view.

Matching is lexical (PostgreSQL full-text search, `simple` configuration), which
means paraphrases and Arabic morphological variants can be missed —
`insufficient` where the material does in fact answer the question. Recorded as
RISK-AI-04 and RISK-AI-05.

## The assistant changes nothing

Asking a question records no progress, writes no evidence, moves no mastery,
creates no attempt, and touches no curriculum row. It is read-only with respect
to the entire platform, and the security suite proves it by snapshotting those
tables around a batch of imperative questions.

## Configuration

| Variable        | Visibility                 | Default |
| --------------- | -------------------------- | ------- |
| `AI_PROVIDER`   | server                     | `none`  |
| `AI_API_KEY`    | **server, secret-bearing** | unset   |
| `AI_TIMEOUT_MS` | server                     | `15000` |

`AI_API_KEY` is listed in `SECRET_BEARING_KEYS`, so the redacting logger and the
configuration summary mask it. **No `VITE_*` variable names an AI provider, key
or model** — `VITE_` is the only prefix Vite inlines into the browser bundle.
The browser talks only to this endpoint, on the same origin.

With `AI_PROVIDER=none` the endpoint runs on a deterministic offline composer
that quotes retrieved passages and cites exactly what it quoted. The whole
pipeline — authorization, retrieval, citation validation, refusal, quota — is
live and testable with no vendor account and no network. A missing key costs
fluency, never safety.

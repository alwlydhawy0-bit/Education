# ADR 0107 — The AI proposes; it never executes and never approves

**Status:** Accepted · **Date:** 2026-09-03 · **Phase 0**
**Live provider behaviour is BLOCKED — no application AI credential exists.**

## Context

"AI automation platform" admits two very different products:

- **A**: an agent that, at runtime, decides which tools to call.
- **B**: a compiler front-end that turns natural language into a reviewable
  spec, which a human approves, which is compiled, which then executes
  deterministically.

The brief's own pipeline — _natural language → spec → validation → compilation →
testing → approval → deployment → execution_ — describes B. This ADR makes that
explicit rather than leaving it to be eroded later.

## Decision

**The model's entire role is: natural language → candidate spec IR.**

It does not decide authorization, does not select credentials, does not run at
execution time, and does not see run data or tenant secrets. Its output is a
**draft** that must pass validation and receive an explicit human approval before
it can be deployed. A clean validation is not an approval.

## Rationale

Under (A), every control in the security spec becomes conditional on model
behaviour: egress policy, credential scoping, cost bounds, idempotency and
approval would all have to hold against an actor whose next action is
unpredictable and whose input includes attacker-controlled text from connector
responses. Prompt injection would be a **privilege escalation** primitive.

Under (B), the same controls are build-time and deterministic. The strongest
anti-injection defence is not a prompt instruction — it is that **the model
cannot cause an effect**. An injected step is a step a human sees in a rendered
diff.

This is the same shape as the education platform's grounded assistant, where the
server decides grounding and citations are validated against the retrieved set
rather than believed. The general rule: **the model's claim about its own output
is never the thing that is trusted.**

## Consequences

- The product is less magical. It cannot adapt mid-run to something unexpected.
  That is the trade, stated plainly, and it is the product.
- Output handling is **reject, never repair**: a proposal that fails to parse, or
  that names a connector or capability that does not exist, is rejected with a
  finding. Silent repair is how a user comes to believe the system understood
  them.
- Evaluation measures proposal quality (validity, capability faithfulness,
  intent coverage, **over-reach**, refusal correctness) — not "agent success
  rate", which would be the wrong question for this product.
- Provider posture is inherited whole from Tasks 013–015: vendor SDK confined to
  `platform/ai`, only the composition root constructs a provider, model
  allow-list, config-pinned HTTPS base URL, vendor retries off, two-layer
  timeout, normalized error kinds, boot refuses without a credential.

## What would make this wrong

If users overwhelmingly need runtime adaptivity that a static plan cannot
express. The honest response would then be a **separate, opt-in, heavily bounded
agentic step type** with its own threat model and its own ADR — never a quiet
relaxation of this one.

# ADR 0009 — Content lifecycle, and splitting authoring from publishing

**Status:** Accepted (Task 005)
**Supersedes:** nothing
**Related:** [0002 RLS defence in depth](0002-postgres-rls-defense-in-depth.md),
[0008 RBAC scopes](0008-rbac-scopes.md)

## Context

Task 005 introduced the educational content tree — curricula, courses, units,
lessons. Unlike every domain before it, this content is **published to
children**. That changes what the authorization question is. For a note, the
question is "may this actor read this row?". For a lesson it is also "who
decided that a class of twelve-year-olds should see this, and when?".

Two decisions followed from that, and both cost more than the obvious
alternative.

## Decision 1 — A one-way lifecycle, not a visibility flag

Content moves `draft → published → archived`, and no edge runs backwards.

The obvious alternative is a boolean `published` that can be toggled. It was
rejected because un-publishing is not the inverse of publishing. By the time
content is retracted, a class may be midway through it, a guardian may have seen
it, and a lesson plan may reference it. A toggle makes that reversal look like a
routine edit. Archiving is the supported move: the content stops being visible,
the record of what was taught survives, and superseding it means publishing
something new.

The same reasoning drives deletion. `DELETE` works only on a **draft** — content
no learner has ever seen. Anything published is archived instead, so the answer
to "what were they taught last term?" does not depend on nobody having pressed
delete.

The transition graph is enforced by a database trigger, not only by the policy
engine, because a policy sees only the new row and cannot tell that `status` is
what changed.

## Decision 2 — `content:author` and `content:publish` are different permissions

A teacher who may write a draft may not make it visible to students. That
requires `content:publish`, held by `reviewer` and `admin`.

This is more friction than a single `content:manage` permission, and the friction
is the point. The platform's priority order puts SCIENTIFIC INTEGRITY above
convenience, and the cheapest structural control over what reaches a classroom is
that the person who wrote it is not the only person who decided it was ready.

Three consequences worth stating plainly:

- **A reviewer can read drafts.** They must, to review them. So the read gate
  asks for _either_ permission while the write gates ask for the specific one.
- **A reviewer cannot edit.** Holding `content:publish` grants no authority over
  the text; a reviewer who disagrees returns it to the author.
- **`security_admin` holds neither.** That role administers accounts and
  lockouts. Giving it editorial control over what children read would merge two
  unrelated authorities into one compromise.

Enforcing this needed something new. A row-level policy admits _either_
authority, because it cannot see which columns moved; the trigger then compares
the row's non-lifecycle columns as `jsonb` and requires `content:author` for a
content change and `content:publish` for a status change. That is why the two
gates are phrased differently here rather than mirroring each other.

## Decision 3 — A platform operator is exempt from the split

The global catalog can only be authored by a platform operator. If the trigger
also demanded `content:publish` of them — which `security_admin` deliberately
does not carry — global content could be created and then never published.

The exemption was added after a test caught exactly that: the policy engine
granted the operator every content action while the database refused. Two gates
are only worth having while they agree about what is permitted; a disagreement
is a defect in one of them, not extra safety.

## Consequences

- A school cannot publish content without at least one `reviewer` or `admin`.
  For a small school where one person does everything, that means granting one
  account both roles — which is a decision someone makes explicitly, and which
  the audit trail records.
- There is no submit-for-review state, no reviewer comment, and no approval
  record beyond the `content.published` audit event. The permission split is the
  control; a workflow around it is not built.
- Content cannot be un-published, so a mistake published in error is archived
  and replaced. The archived row remains readable to editors.

## Alternatives considered

**One `content:manage` permission.** Simpler, and it is what most CMSs do. It
was rejected because it makes the author the only check on what a classroom
sees, and no technical control would remain if that account were compromised.

**Publishing gated on a workflow table** (submitted → approved → published).
Richer, and probably where this ends up. It was rejected for Task 005 as scope
the brief explicitly excludes; the permission split is the smallest thing that
delivers the property, and a workflow can be added on top without changing it.

**Making visibility a per-class assignment** rather than a global status. That is
a _learning-engine_ concern — which course a class is taught — and Task 005 is
explicitly the content baseline. The two compose later: a class assignment will
narrow who sees published content, never widen it.

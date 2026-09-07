# ADR 0011 — The public boundary: one anonymous route, and what it costs

**Status:** Accepted (Task 013)
**Related:** [0002 RLS defence in depth](0002-postgres-rls-defense-in-depth.md),
[0007 soft delete and RLS](0007-soft-delete-and-rls.md),
[0010 vector knowledge base](0010-vector-knowledge-base.md)

## Context

Every route on this platform before Task 013 required a session. The
authorization model is built on that assumption: `app.actor_id` is set on the
transaction, RLS policies are written `TO edu_app` and compare against
`app_current_actor()`, the policy engine takes an `AuthorizationContext` whose
first field is an actor, and `Guarded<T>` cannot be unwrapped without a decision
made for a specific actor and object.

Task 013 asks for a portfolio a learner can put on a CV. A page that requires
the reader to have an account is not that. So the platform needed one route that
answers with no actor at all — and the entire authorization model has nothing to
say about such a request, because every mechanism in it starts by asking who is
calling.

This ADR records how that route was built without weakening anything else, and
what was deliberately given up.

## Decision

### 1. The absence of an actor is a positive fact, carried in a named door

`app_begin_public_portfolio(key)` sets `app.portfolio_key` with
`set_config(..., true)` — transaction-local, so it cannot survive onto the next
request on a pooled connection, where the next request may be a different
child's. `app_portfolio_key()` reads it, and the RLS policies compare it against
`share_token` and `public_slug`.

Two properties follow, and both matter:

**It grants nothing by itself.** It states a claim — "the caller says they hold
this key" — and every policy still checks the claim against a published row. A
caller who invents a key gets exactly what a caller who presents none gets.

**A request that never calls it matches no public branch.**
`app_portfolio_key()` returns NULL, and NULL equals nothing — not a
`share_token`, which is `NOT NULL`, and not a `public_slug`. So an ordinary
authenticated request cannot accidentally fall through into the public path.

This is the same mechanism `ai_begin_platform_turn` uses in migration 0027, and
the reason for the shared shape is that a named function is greppable where an
implicit query shape is not. "Which code paths can open the public door" is
answerable by searching for one identifier.

### 2. The public path runs with NO actor, even for a caller who has one

`resolvePublic` takes no `ActorContext` and calls `db.withoutActor`, and this is
the single most consequential line in the module.

If it ran as the caller, the RLS policies would ALSO match their owner branch. A
learner opening their own share link would see their private and draft projects
rendered onto the page, and would reasonably conclude that this is what
strangers see. The page would then be a liar in the most dangerous direction: it
would **under-report what is hidden, to the exact person deciding what to
publish**.

`tests/security/portfolio.test.ts` asserts the owner's response is
byte-identical to a stranger's. A learner checking their own link is doing the
thing they think they are doing.

### 3. The sanitizer is a constructor, and therefore the boundary is an allow-list

`toPublicPortfolio` does not take a row and remove fields. It builds a new object
out of named pieces.

The difference is the whole point. A filter is a deny-list: it removes what
somebody remembered to remove, and a column added to `student_projects` next
year arrives on the public page by default. A constructor is an allow-list: the
new column is invisible until somebody deliberately writes a line to expose it,
and writing that line is the moment a reviewer gets to object.

No identifier leaves it — not the portfolio's, not a project's, not the owner's.
A public project is addressed by its **position in the list**, renumbered 1..n
from the sorted order, which is meaningful on the page and meaningless anywhere
else. Copying `display_order` would have leaked something real: a gap says an
item was removed or is hidden.

The function is pure, which is what lets the unit suite enumerate the leak cases
without a server — and lets the central assertion be a property rather than a
field list. It serializes the whole output and searches it for every secret
present in the input, so the field somebody forgets is caught by the fact that
the value appears, not by anybody having named it.

### 4. TWO gates, even here — the correction this task had to make

The first implementation gave the public query no `WHERE` clause at all. The
reasoning, written in the file, was that the key lives in the GUC, RLS matches
it, and two places deciding one thing is how they come to disagree.

That reasoning is real and this codebase has applied it correctly elsewhere. It
was wrong here, and the layered-defence suite proved it: run against
`edu_app_norls`, the resolver returned whichever portfolio happened to be first,
to anybody, for any key. **The one route with no session had one gate**
(VULN-056).

The fix is not a re-derivation from different facts, which is the drift the
original reasoning feared. The repository asks the SAME predicate — published,
and the presented key matches this row — from the SAME GUC, in the layer that
would still be running if the database's copy were dropped. Where they could
disagree, the application answers more narrowly, and more narrowly on a public
route is the safe direction.

The key is still never an argument. There is no `$1` in either public statement,
so the query cannot be pointed at a different portfolio by passing it a value.

### 5. Revocation is structural, and rotation is what makes it real

Unpublishing sets `is_published` false **and rotates `share_token`**, in
`student_portfolio_guard` rather than in the service — so it holds for any
writer, not just the one that exists today.

Rotation is the difference between "the flag is off" and "the link is dead".
Without it, republishing would resurrect every link ever handed out, including
ones pasted into somebody else's chat history months ago. With it, a child who
takes their work down and later puts it back up gets a new address, and the old
one stays dead.

Three other paths revoke and all are immediate because they are the same
statement: making a project private removes it from
`app_project_is_publicly_listed`; deleting a project cascades its artifacts and
its portfolio item through composite foreign keys; removing an item deletes the
row that put the project on the page. There is no cache to expire and no second
step to forget.

### 6. Ownership is a foreign key, not a rule

`portfolio_items` carries `owner_id` and has TWO composite foreign keys —
`(portfolio_id, owner_id) → student_portfolios (id, student_id)` and
`(project_id, owner_id) → student_projects (id, student_id)`. Putting another
child's project into your public portfolio is not refused by a policy somebody
could edit; the row **has no parent** and cannot exist.

This is the platform's now-standard answer to the definer/FORCE-RLS trap
(VULN-044, VULN-050): where a `SECURITY DEFINER` helper would have been needed
to establish ownership, a composite key establishes it in the schema instead.

## Consequences

**Accepted.** The public route is rate-limited harder than any other read (60 in
15 minutes per IP, keyed by address because there is no actor to key by), which
means a classroom behind one NAT shares a budget with an attacker. A
`public_slug` is guessable by design and publishing under one makes a portfolio
discoverable by name. `X-Robots-Tag: noindex` states an intent this API cannot
enforce. Nothing moderates what a learner publishes. All are recorded as
RISK-PF-01 through RISK-PF-11 in `docs/security/limitations.md`.

**Rejected: authenticating the reader.** A portfolio a prospective employer
needs an account to open is not a portfolio.

**Rejected: signed, expiring URLs.** They would make the link a capability with
a lifetime, which is better security and worse for the purpose — a CV outlives
any expiry a platform would pick, and a learner cannot re-issue a link already
printed on paper. The share token is unguessable and revocable, which is the
part that matters, and `no-store` plus fresh-per-request serving is what makes
the revocation land.

**Rejected: an author display name on the page.** It was implemented, and
removed. The join to `users` killed every public page (VULN-055) — but the
reason it was not repaired with a definer function is that the field should not
have existed. An account display name is registration data a child gave their
school; the `title` and `bio` are what they wrote for this page. The failure was
the prompt to ask whether the field belonged, and the answer was no.

**A precedent, and its limit.** The next domain that wants an anonymous route
can follow this shape: a named door, a transaction-local key, RLS plus an
application-level predicate reading the same source, and a constructed response.
What it cannot borrow is the assumption that this is cheap. This route needed
its own migration section, its own rate-limit policy, its own audit event, its
own fitness functions and its own layered-defence block, and it still shipped
with eleven recorded risks. One anonymous route is a domain's worth of work.

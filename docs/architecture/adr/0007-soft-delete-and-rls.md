# ADR 0007 — Soft delete under Row-Level Security

**Status:** Accepted · **Date:** 2026-08-30
**Discovered empirically during Task 001.**

## Context

`notes` uses soft delete (`state = 'deleted'`) so content is retained for a
retention window while being invisible to readers.

The first RLS policy read:

```sql
USING (state <> 'deleted' AND (owner_id = app_current_actor() OR …shares…))
```

The owner's own `UPDATE notes SET state = 'deleted'` then failed with
_new row violates row-level security policy for table "notes"_ — even though the
UPDATE policy's `WITH CHECK` was only `owner_id = app_current_actor()`.

## The finding

**PostgreSQL applies the SELECT policy to the NEW row of an UPDATE**, in addition
to the UPDATE policy's `WITH CHECK`. A row therefore cannot be updated _out of_
the actor's own visibility.

Verified with a minimal probe table: a SELECT policy of `state <> 'deleted'` and
an UPDATE policy of `USING (true) WITH CHECK (true)` still rejects an update
setting `state = 'deleted'`. Widening the SELECT policy makes the same update
succeed.

This is not documented prominently, and the error message points at `WITH CHECK`,
which sends you looking in the wrong place.

## Decision

The owner branch of the SELECT policy does **not** filter on `state`:

```sql
USING (
  owner_id = app_current_actor()
  OR (state <> 'deleted' AND ( …teacher share… OR …guardian share… ))
)
```

The owner can see their own rows at the database layer, soft-deleted ones
included. Hiding a deleted note from its owner is an **application-layer**
guarantee: `notePolicy` denies `state = 'deleted'` for everyone, and `listOwn`
filters it out.

## Rationale

The alternatives were worse. A `SECURITY DEFINER` function for soft delete would
expand the trusted pre-authentication boundary — currently five audited
functions — to cover an ordinary CRUD operation. A hard delete plus an archive
table is more machinery than the retention requirement justifies today.

The security-relevant behaviour is unchanged: the shared branches still filter on
state, so a soft-deleted note remains invisible to teachers and guardians at the
database layer regardless of what the application does.

## Consequences

- The owner-side "deleted" guarantee rests on one layer, not two. Covered by unit
  tests on `notePolicy` and an end-to-end test asserting the owner receives 404
  for their own deleted note.
- Any future soft-deleted resource must apply this same shape. The trap is easy
  to fall into twice.
- If owner-side hiding must be enforced at the database layer later, the option
  is a separate `deleted_notes` table written in the same transaction.

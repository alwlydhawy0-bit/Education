import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../apps/api/src/platform/db.ts';
import { notebookRepository } from '../../apps/api/src/modules/notebook/notebook.repository.ts';
import type { ListNotesQuery } from '@edu/contracts';
import { TEST_APP_URL } from '../setup/env.ts';
import { closeSeedDb, createNote, createUser, truncateAll } from '../setup/fixtures.ts';

/**
 * Sort/filter handling at the repository layer, with schema validation BYPASSED.
 *
 * The route validates the query against an allow-list, and unit tests cover that.
 * This file asks the harder question: if a future caller ever reached the
 * repository without validating first, would a crafted sort value become SQL?
 *
 * It must not. The sort target is an SQL IDENTIFIER, which cannot be bound as a
 * parameter, so the exhaustive column map is the control — and it must fail
 * closed on anything it does not recognise rather than pass the value through.
 */
const db: Database = createDatabase({ connectionString: TEST_APP_URL, poolMax: 2 });

afterAll(async () => {
  await db.close();
  await closeSeedDb();
});

beforeEach(truncateAll);

async function seedOwnerWithNotes(): Promise<string> {
  const owner = await createUser({ email: 'sortsafe@test.local' });
  await createNote({ ownerId: owner.id, title: 'A note' });
  await createNote({ ownerId: owner.id, title: 'B note' });
  return owner.id;
}

/** Deliberately malformed, as if validation had been skipped. */
const unvalidated = (sort: string): ListNotesQuery =>
  ({ limit: 20, offset: 0, sort, order: 'desc' }) as unknown as ListNotesQuery;

describe('sort values that never passed validation', () => {
  it.each([
    'title; DROP TABLE notes',
    "title' --",
    'password_hash',
    'owner_id',
    '(SELECT 1)',
    'body',
    '',
  ])('refuses "%s" instead of interpolating it', async (malicious) => {
    const ownerId = await seedOwnerWithNotes();

    await expect(
      db.withActor(ownerId, (tx) =>
        notebookRepository.listOwn(tx, ownerId, unvalidated(malicious)),
      ),
    ).rejects.toThrow(/No SQL column mapped/);
  });

  it('leaves the table intact after the injection attempts', async () => {
    const ownerId = await seedOwnerWithNotes();
    await db
      .withActor(ownerId, (tx) =>
        notebookRepository.listOwn(tx, ownerId, unvalidated('title; DROP TABLE notes')),
      )
      .catch(() => undefined);

    const remaining = await db.withActor(ownerId, (tx) =>
      notebookRepository.listOwn(tx, ownerId, {
        limit: 20,
        offset: 0,
        sort: 'title',
        order: 'asc',
      } as ListNotesQuery),
    );
    expect(remaining).toHaveLength(2);
  });
});

describe('allow-listed sorting behaves correctly', () => {
  it('orders ascending and descending by title', async () => {
    const ownerId = await seedOwnerWithNotes();

    const ascending = await db.withActor(ownerId, (tx) =>
      notebookRepository.listOwn(tx, ownerId, {
        limit: 20,
        offset: 0,
        sort: 'title',
        order: 'asc',
      } as ListNotesQuery),
    );
    expect(ascending.map((n) => n.title)).toEqual(['A note', 'B note']);

    const descending = await db.withActor(ownerId, (tx) =>
      notebookRepository.listOwn(tx, ownerId, {
        limit: 20,
        offset: 0,
        sort: 'title',
        order: 'desc',
      } as ListNotesQuery),
    );
    expect(descending.map((n) => n.title)).toEqual(['B note', 'A note']);
  });

  it('applies limit and offset', async () => {
    const ownerId = await seedOwnerWithNotes();
    const page = await db.withActor(ownerId, (tx) =>
      notebookRepository.listOwn(tx, ownerId, {
        limit: 1,
        offset: 1,
        sort: 'title',
        order: 'asc',
      } as ListNotesQuery),
    );
    expect(page.map((n) => n.title)).toEqual(['B note']);
  });

  it('never returns another owner’s rows, whatever the sort', async () => {
    const ownerId = await seedOwnerWithNotes();
    const stranger = await createUser({ email: 'sortsafe-other@test.local' });
    await createNote({ ownerId: stranger.id, title: 'Z stranger note' });

    const rows = await db.withActor(ownerId, (tx) =>
      notebookRepository.listOwn(tx, ownerId, {
        limit: 50,
        offset: 0,
        sort: 'title',
        order: 'desc',
      } as ListNotesQuery),
    );
    expect(rows.every((n) => n.ownerId === ownerId)).toBe(true);
    expect(rows.map((n) => n.title)).not.toContain('Z stranger note');
  });
});

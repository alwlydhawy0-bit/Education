import { describe, expect, it } from 'vitest';
import {
  createListQuerySchema,
  listNotesQuerySchema,
  resolveSortColumn,
  resolveSortDirection,
  NOTE_SORTABLE_FIELDS,
} from '@edu/contracts';

/**
 * List-query validation.
 *
 * The sort parameter is the interesting one: it ends up as an SQL IDENTIFIER,
 * which cannot be bound as a parameter, so the allow-list IS the defence.
 */
describe('sort field allow-list', () => {
  it.each(NOTE_SORTABLE_FIELDS)('accepts the allow-listed field "%s"', (field) => {
    expect(listNotesQuerySchema.safeParse({ sort: field }).success).toBe(true);
  });

  it.each([
    'created_at; DROP TABLE notes',
    "title' --",
    'password_hash',
    'owner_id',
    '(SELECT 1)',
    'updatedAt,createdAt',
    '1',
  ])('rejects "%s"', (injection) => {
    // Rejected at the schema, so it never reaches the column map or the query.
    const result = listNotesQuerySchema.safeParse({ sort: injection });
    expect(result.success).toBe(false);
  });

  it('rejects a field that exists on the row but is not sortable', () => {
    // `body` is a real column. Not being in the allow-list is what matters.
    expect(listNotesQuerySchema.safeParse({ sort: 'body' }).success).toBe(false);
  });
});

describe('unknown parameters are rejected, not ignored', () => {
  it.each(['cursor', 'ownerId', 'userId', 'admin', 'orderBy'])('rejects "%s"', (param) => {
    // A silently-ignored filter is a lie to the client: it believes it narrowed
    // the result set and it did not.
    expect(listNotesQuerySchema.safeParse({ [param]: 'x' }).success).toBe(false);
  });
});

describe('pagination bounds', () => {
  it('applies safe defaults', () => {
    const parsed = listNotesQuerySchema.parse({});
    expect(parsed).toMatchObject({ limit: 20, offset: 0, sort: 'updatedAt', order: 'desc' });
  });

  it.each([0, -1, 101, 100000])('rejects limit=%s', (limit) => {
    expect(listNotesQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('caps the offset so deep paging cannot be used as a cost attack', () => {
    expect(listNotesQuerySchema.safeParse({ offset: 10_000 }).success).toBe(true);
    expect(listNotesQuerySchema.safeParse({ offset: 10_001 }).success).toBe(false);
    expect(listNotesQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it('coerces numeric strings, since query parameters arrive as text', () => {
    expect(listNotesQuerySchema.parse({ limit: '50', offset: '10' })).toMatchObject({
      limit: 50,
      offset: 10,
    });
  });

  it('rejects a non-numeric limit rather than falling back to the default', () => {
    expect(listNotesQuerySchema.safeParse({ limit: 'all' }).success).toBe(false);
  });
});

describe('filters', () => {
  it('accepts an allow-listed visibility filter', () => {
    expect(listNotesQuerySchema.parse({ visibility: 'private' }).visibility).toBe('private');
  });

  it('rejects an unknown visibility value', () => {
    expect(listNotesQuerySchema.safeParse({ visibility: 'public' }).success).toBe(false);
  });

  it('does NOT offer a filter for deleted notes', () => {
    // A soft-deleted note behaves as if it does not exist. Offering the filter
    // would be a way to ask "what did I delete?" that the policy does not grant.
    expect(listNotesQuerySchema.safeParse({ state: 'deleted' }).success).toBe(false);
    expect(listNotesQuerySchema.safeParse({ state: 'active' }).success).toBe(true);
    expect(listNotesQuerySchema.safeParse({ state: 'archived' }).success).toBe(true);
  });
});

describe('sort resolution helpers', () => {
  const columns = { updatedAt: 'updated_at', createdAt: 'created_at', title: 'title' } as const;

  it('maps an allow-listed field to its literal column', () => {
    expect(resolveSortColumn(columns, 'updatedAt')).toBe('updated_at');
  });

  it('throws rather than defaulting when a field has no mapping', () => {
    // Silently sorting by something unintended is worse than failing.
    expect(() => resolveSortColumn(columns, 'nope' as never)).toThrow(/No SQL column mapped/);
  });

  it('emits only literal ASC/DESC', () => {
    expect(resolveSortDirection('asc')).toBe('ASC');
    expect(resolveSortDirection('desc')).toBe('DESC');
  });
});

describe('createListQuerySchema is reusable for future domains', () => {
  const schema = createListQuerySchema({
    sortableFields: ['name', 'createdAt'],
    defaultSort: 'name',
    defaultOrder: 'asc',
  });

  it('defaults to the declared sort and order', () => {
    expect(schema.parse({})).toMatchObject({ sort: 'name', order: 'asc' });
  });

  it('is strict even with no filters declared', () => {
    expect(schema.safeParse({ anything: 1 }).success).toBe(false);
  });

  it('rejects a sort field belonging to a different resource', () => {
    expect(schema.safeParse({ sort: 'updatedAt' }).success).toBe(false);
  });
});

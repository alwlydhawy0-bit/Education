import { z } from 'zod';

/**
 * List-query validation: pagination, sorting and filtering.
 *
 * Sorting and filtering are the two request surfaces most often left
 * unvalidated, and both are security-relevant:
 *
 *   - A sort field that reaches SQL as a string is SQL injection. The defence
 *     here is an ALLOW-LIST of field names; the repository then maps an
 *     allow-listed name to a fixed, literal SQL fragment. User input never
 *     becomes an identifier, and a parameter placeholder cannot help — an
 *     identifier is not a value.
 *
 *   - A filter over a field the caller may not read is an information leak, even
 *     when the rows themselves are protected: filtering by a hidden attribute
 *     and observing result counts discloses it. So filterable fields are
 *     allow-listed too, per resource.
 *
 * Unknown query parameters are REJECTED rather than ignored. A silently-ignored
 * parameter is a lie to the client — the caller believes it filtered and it did
 * not, which is how "why is this student seeing everything?" bugs happen.
 */

export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** Bounds a page. The maximum caps the work one request can demand. */
export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

/**
 * Offset pagination.
 *
 * Deliberately offset, not cursor. Task 001's schema accepted a `cursor` that
 * nothing implemented, so a client could paginate and silently receive page one
 * forever. Accepting a parameter you do not honour is worse than not offering
 * it. The ceiling bounds deep-paging cost; cursor pagination replaces this when
 * a list needs to exceed it.
 */
export const offsetSchema = z.coerce.number().int().min(0).max(10_000).default(0);

export interface ListQueryOptions<
  TSortField extends string,
  TFilters extends Record<string, z.ZodTypeAny>,
> {
  /** Field names a caller may sort by. Anything else is a 400. */
  readonly sortableFields: readonly [TSortField, ...TSortField[]];
  readonly defaultSort: TSortField;
  readonly defaultOrder?: SortOrder;
  /** Optional per-field filter schemas. Absent means "no filtering offered". */
  readonly filters?: TFilters;
}

/**
 * Builds a strict schema for a list endpoint.
 *
 * Every list route in the platform should use this rather than hand-rolling
 * query parsing, so the allow-list discipline is the default rather than
 * something each author has to remember.
 *
 * The generics keep the literal types: `sort` narrows to the allow-listed union
 * (not `string`), and each filter keeps its own schema's type. That is what lets
 * the repository's sort-column map be checked for exhaustiveness at compile
 * time.
 */
export function createListQuerySchema<
  TSortField extends string,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TFilters extends Record<string, z.ZodTypeAny> = {},
>(options: ListQueryOptions<TSortField, TFilters>) {
  return z
    .object({
      limit: limitSchema,
      offset: offsetSchema,
      sort: z
        .enum(options.sortableFields as unknown as [TSortField, ...TSortField[]])
        .default(options.defaultSort),
      order: sortOrderSchema.default(options.defaultOrder ?? 'desc'),
      ...((options.filters ?? {}) as TFilters),
    })
    .strict();
}

/**
 * Maps an allow-listed sort field to a literal SQL fragment.
 *
 * The `Record` is exhaustive over the allow-list, so adding a sortable field
 * without deciding its SQL representation is a type error. Callers must use the
 * returned fragment verbatim and must never build one from the request.
 */
export function resolveSortColumn<TSortField extends string>(
  columns: Readonly<Record<TSortField, string>>,
  field: TSortField,
): string {
  const column = columns[field];
  if (!column) {
    // Unreachable if the schema validated first. Throwing rather than defaulting
    // means a mismatch between schema and map fails loudly instead of silently
    // sorting by something unintended.
    throw new Error(`No SQL column mapped for sort field "${String(field)}".`);
  }
  return column;
}

/** ORDER BY direction as a literal. Never interpolate the raw value. */
export function resolveSortDirection(order: SortOrder): 'ASC' | 'DESC' {
  return order === 'asc' ? 'ASC' : 'DESC';
}

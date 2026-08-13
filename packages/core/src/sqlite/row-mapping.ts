/**
 * drizzle's sqlite-proxy driver (see ./driver.ts) maps result rows onto
 * query fields *positionally*, not by column name — a row is just
 * `unknown[]`, ordered to match the columns the SQL asked for. A driver
 * naturally gets rows back as column-named objects (node:sqlite does; so
 * will a native mobile bridge), so something has to turn `{ body: "...",
 * created_at: "..." }` into `["...", "..."]` in the right order.
 *
 * Get that translation wrong — say, by sorting keys, or reading from a
 * cache that reordered them — and drizzle doesn't throw. It just assigns
 * whatever value landed in the timestamp column's position to the
 * `createdAt` field. So this lives in one place, called by every
 * `SqliteDriver` implementation, instead of being reimplemented per driver
 * where a second, differently-wrong version could exist.
 *
 * `Object.keys`/`Object.values` on a plain object both iterate in
 * insertion order (per spec, for string keys), and a fresh row object
 * built by a SQL driver is inserted in column order — so this only needs
 * to assert the row is the shape it depends on, not reorder anything
 * itself.
 */
export function toPositionalRow(row: unknown): unknown[] {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(
      `sqlite row mapping expected a column-named object, got ${JSON.stringify(row)}`,
    );
  }
  return Object.values(row);
}

export function toPositionalRows(rows: unknown[]): unknown[][] {
  return rows.map(toPositionalRow);
}

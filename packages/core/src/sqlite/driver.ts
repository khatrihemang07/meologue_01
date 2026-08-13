export type SqliteMethod = "run" | "all" | "values" | "get";

export interface SqliteResult {
  rows: unknown[];
}

/**
 * The one platform-specific seam (ADR 0007): everything else in
 * `packages/core`'s sqlite support is platform-free and talks to a database
 * only through this. A driver just has to run SQL and hand rows back; it
 * shapes its own result into drizzle's positional-row contract via
 * `toPositionalRow`/`toPositionalRows` (./row-mapping.ts) rather than
 * inventing its own translation.
 */
export interface SqliteDriver {
  execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult>;
}

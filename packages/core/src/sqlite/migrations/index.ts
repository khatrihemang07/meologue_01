import initial from "./0000_initial.sql?raw";

export interface Migration {
  version: number;
  sql: string;
}

/**
 * Generated SQL (drizzle-kit, from ../schema.ts — never hand-edited except
 * to add `IF NOT EXISTS`), embedded at build time via Vite's `?raw` import
 * rather than read from disk at runtime: the migrator drizzle ships for
 * this driver hard-imports node:fs to do that, which can't run in a
 * WebView (ADR 0007).
 *
 * Add a migration by running `drizzle-kit generate`, editing its DDL to be
 * idempotent, and appending an entry here. `version` is the ledger key
 * (../migrator.ts) — never reuse or reorder one once committed.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: initial }];

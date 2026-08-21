import type { SqliteDriver } from "./driver";
import { MIGRATIONS } from "./migrations";

const LEDGER_TABLE = "meologue_migrations";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

// SQLite's own error text when a statement re-adds a column that's already
// there. Verified against node:sqlite; it's SQLite's message, not any
// driver's, so it's identical across all four drivers (ADR 0007's
// amendment, ADR 0028). See its use in migrate() below.
const DUPLICATE_COLUMN_NAME = /duplicate column name/i;

/**
 * Hand-written because drizzle's own migrator for this driver hard-imports
 * node:fs to read migration files off disk, which can't run in a WebView
 * (ADR 0007). Applies every migration in ../migrations/index.ts whose
 * version isn't yet in the ledger table, in order, and records it once
 * applied.
 *
 * Most migrations get "re-running an interrupted one is harmless" from
 * their DDL being entirely `IF NOT EXISTS`. `ALTER TABLE ADD COLUMN` (first
 * used by migration 3, ../migrations/0001_entry_deleted_at.sql) has no such
 * form — SQLite doesn't support `IF NOT EXISTS` on it. If the process dies
 * after that statement lands but before the ledger row below is written,
 * re-running it throws `duplicate column name`, and without the guard
 * below that would brick the store permanently: migrate() runs before
 * anything else touches the database (see open.ts), so a throw here means
 * the store can never open again.
 *
 * The obvious fix — wrap each migration in a transaction — isn't
 * available. `TauriSqliteDriver` (apps/web/src/platform/
 * tauri-sqlite-driver.ts) runs statements through `@tauri-apps/plugin-sql`'s
 * connection pool, which has no transaction API: `BEGIN` and the statement
 * after it may not reach the same connection. A transaction issued there
 * would appear to work and protect nothing, while passing every test run
 * against the single-connection node driver, so it can't be trusted
 * anywhere.
 *
 * The fix instead lives at the statement level: when a statement throws,
 * re-throw unless the message matches DUPLICATE_COLUMN_NAME, in which case
 * swallow it — that error means the column this statement was trying to
 * add is already present, which is exactly the outcome the statement
 * wanted. This is what obtains "re-running an interrupted migration is
 * harmless" without a transaction, and it's deliberately narrow: only this
 * error, only for this reason. A future migration whose statements aren't
 * each individually re-runnable this way — an unguarded backfill, a
 * multi-statement table rewrite — cannot fall back on a transaction on any
 * platform either, and has to solve it at the statement level the way this
 * one does.
 */
export async function migrate(driver: SqliteDriver): Promise<void> {
  await driver.execute(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (version INTEGER PRIMARY KEY NOT NULL)`,
    [],
    "run",
  );

  const applied = await driver.execute(`SELECT version FROM ${LEDGER_TABLE}`, [], "all");
  const appliedVersions = new Set(applied.rows.map(parseVersion));

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    for (const statement of splitStatements(migration.sql)) {
      try {
        await driver.execute(statement, [], "run");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!DUPLICATE_COLUMN_NAME.test(message)) {
          throw error;
        }
        // The column this statement adds is already there — a previous,
        // interrupted run of this same migration got this far already.
        // Treat it as done and move on to the next statement.
      }
    }
    await driver.execute(
      `INSERT INTO ${LEDGER_TABLE} (version) VALUES (?)`,
      [migration.version],
      "run",
    );
  }
}

// Matches drizzle-kit's own generated marker, which separates statements
// within one migration file — a single `execute` call runs one statement.
function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function parseVersion(row: unknown): number {
  const value = Array.isArray(row) ? row[0] : undefined;
  if (typeof value !== "number") {
    throw new Error(
      `expected a numeric migration version in the ledger, got ${JSON.stringify(row)}`,
    );
  }
  return value;
}

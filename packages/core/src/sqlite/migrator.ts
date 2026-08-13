import type { SqliteDriver } from "./driver";
import { MIGRATIONS } from "./migrations";

const LEDGER_TABLE = "meologue_migrations";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * Hand-written because drizzle's own migrator for this driver hard-imports
 * node:fs to read migration files off disk, which can't run in a WebView
 * (ADR 0007). Applies every migration in ../migrations/index.ts whose
 * version isn't yet in the ledger table, in order, and records it once
 * applied. Every migration's DDL is entirely `IF NOT EXISTS`, so re-running
 * this — including re-applying a migration whose ledger write never
 * committed — is harmless; see ADR 0007 for the conditions under which
 * that stops being true and a transaction becomes necessary.
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
      await driver.execute(statement, [], "run");
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

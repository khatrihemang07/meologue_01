import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDriver, SqliteMethod, SqliteResult } from "./driver";
import { toPositionalRow } from "./row-mapping";

/**
 * The Node-backed SqliteDriver (ADR 0007) — used only by tests, so the
 * contract suite (../test-support/entry-store-contract.ts) verifies the
 * SQLite EntryStore against a real database rather than a promise. Every
 * other platform's driver lives beside its own app, not here.
 */
export class NodeSqliteDriver implements SqliteDriver {
  private readonly db: DatabaseSync;

  constructor(location = ":memory:") {
    this.db = new DatabaseSync(location);
  }

  async execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult> {
    const statement = this.db.prepare(sql);
    const boundParams = params as SQLInputValue[];

    switch (method) {
      case "run": {
        statement.run(...boundParams);
        return { rows: [] };
      }
      case "get": {
        const row = statement.get(...boundParams);
        return { rows: row === undefined ? [] : toPositionalRow(row) };
      }
      case "all":
      case "values": {
        const rows = statement.all(...boundParams);
        return { rows: rows.map(toPositionalRow) };
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

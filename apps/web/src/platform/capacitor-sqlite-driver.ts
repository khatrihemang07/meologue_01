import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import type { SqliteDriver, SqliteMethod, SqliteResult } from "@meologue/core";
import { toPositionalRow, toPositionalRows } from "@meologue/core";

const DB_NAME = "meologue";
const DB_VERSION = 1;

/** The slice of a Capacitor `SQLiteDBConnection` this driver needs — narrow enough to fake in tests. */
export interface SqliteDbConnection {
  open(): Promise<void>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
}

/** The slice of `SQLiteConnection` this driver needs to open (or reattach to) a connection. */
export interface SqliteConnectionFactory {
  checkConnectionsConsistency(): Promise<{ result?: boolean }>;
  isConnection(database: string, readonly: boolean): Promise<{ result?: boolean }>;
  retrieveConnection(database: string, readonly: boolean): Promise<SqliteDbConnection>;
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SqliteDbConnection>;
}

/**
 * Android's SqliteDriver (ticket 22), backed by `@capacitor-community/sqlite`.
 * Everything platform-specific about running SQL lives here; `packages/core`
 * never sees this plugin.
 *
 * Encryption stays off: the plugin can bind a database key to the Android
 * keystore, but a device restore with a stale key yields a database that
 * cannot be opened at all — a worse failure than the one it prevents, for
 * data no more sensitive than the WebView cache sitting beside it.
 */
export class CapacitorSqliteDriver implements SqliteDriver {
  private readonly sqlite: SqliteConnectionFactory;
  private connection: SqliteDbConnection | null = null;

  constructor(sqlite: SqliteConnectionFactory = new SQLiteConnection(CapacitorSQLite)) {
    this.sqlite = sqlite;
  }

  /**
   * Opens this Device's database connection, reattaching to one the native
   * side already has open (e.g. a JS-side reload during development) rather
   * than failing to create a second one.
   */
  async connect(): Promise<void> {
    const consistent = (await this.sqlite.checkConnectionsConsistency()).result ?? false;
    const alreadyOpen = (await this.sqlite.isConnection(DB_NAME, false)).result ?? false;

    this.connection =
      consistent && alreadyOpen
        ? await this.sqlite.retrieveConnection(DB_NAME, false)
        : await this.sqlite.createConnection(DB_NAME, false, "no-encryption", DB_VERSION, false);

    await this.connection.open();
  }

  async execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult> {
    if (!this.connection) {
      throw new Error("CapacitorSqliteDriver: execute called before connect()");
    }

    if (method === "run") {
      // transaction: false — the plugin wraps every run()/execute() in its
      // own transaction by default, which would nest a transaction inside
      // whatever migrator.ts or sqlite-entry-store.ts issues itself (the
      // no-transaction reasoning in ADR 0007).
      await this.connection.run(sql, params, false);
      return { rows: [] };
    }

    const result = await this.connection.query(sql, params);
    const rows = result.values ?? [];
    if (method === "get") {
      return { rows: rows.length === 0 ? [] : toPositionalRow(rows[0]) };
    }
    return { rows: toPositionalRows(rows) };
  }
}

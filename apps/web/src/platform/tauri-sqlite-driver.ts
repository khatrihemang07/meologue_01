import type { SqliteDriver, SqliteMethod, SqliteResult } from "@meologue/core";
import { toPositionalRow, toPositionalRows } from "@meologue/core";
import Database from "@tauri-apps/plugin-sql";

const DB_PATH = "sqlite:meologue.db";

/** The slice of `@tauri-apps/plugin-sql`'s `Database` this driver needs — narrow enough to fake in tests. */
export interface TauriDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<unknown>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
}

/** Loads (or connects to) the database this driver talks to — `Database.load` in production. */
export type TauriDatabaseLoader = (path: string) => Promise<TauriDatabase>;

/**
 * macOS's SqliteDriver (ticket 23), backed by `@tauri-apps/plugin-sql`.
 * Everything platform-specific about running SQL lives here; `packages/core`
 * never sees this plugin.
 *
 * The plugin's SQLite backend takes numbered placeholders (`$1`, `$2`, ...)
 * rather than the positional `?` drizzle emits, so every statement is
 * rewritten via `toNumberedPlaceholders` before it reaches the plugin.
 *
 * The plugin runs statements through a connection pool with no transaction
 * API — `BEGIN` and the statement after it may not reach the same
 * connection, so a `BEGIN`/`COMMIT`/`ROLLBACK` a caller issues passes
 * through `execute` below like any other statement, with no guarantee it
 * does anything at all. `migrate()` (../../../packages/core/src/sqlite/
 * migrator.ts) never issues one — ADR 0007's no-transaction posture makes
 * every migration statement individually idempotent instead — so this was
 * harmless until Restore (#197, ../../../packages/core/src/backup/
 * restore.ts's `restoreFromBackup`) started relying on one for real.
 *
 * Issue #204 doesn't fix that here — this driver still cannot offer a
 * transaction, and nothing in this file changed to accommodate it — it
 * mitigates the gap one layer up instead: `restoreFromBackup` now takes
 * and durably saves a safety Backup before it writes anything, so an apply
 * interrupted partway on exactly this driver's pooled connections is
 * recoverable, even though it was never atomic and still isn't. See that
 * function's own doc comment for the full reasoning.
 */
export class TauriSqliteDriver implements SqliteDriver {
  private readonly load: TauriDatabaseLoader;
  private db: TauriDatabase | null = null;

  constructor(load: TauriDatabaseLoader = Database.load) {
    this.load = load;
  }

  async connect(): Promise<void> {
    this.db = await this.load(DB_PATH);
  }

  async execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult> {
    if (!this.db) {
      throw new Error("TauriSqliteDriver: execute called before connect()");
    }
    const statement = toNumberedPlaceholders(sql);

    if (method === "run") {
      await this.db.execute(statement, params);
      return { rows: [] };
    }

    const rows = await this.db.select<unknown[]>(statement, params);
    if (method === "get") {
      return { rows: rows.length === 0 ? [] : toPositionalRow(rows[0]) };
    }
    return { rows: toPositionalRows(rows) };
  }
}

/**
 * Rewrites drizzle's positional `?` placeholders into the numbered
 * placeholders (`$1`, `$2`, ...) the Tauri SQL plugin's SQLite backend
 * requires (ticket 23). Tracks single-quoted string literals (SQL's own
 * `''`-escaping toggles quote state correctly without special-casing it)
 * so a `?` inside a stored value's text can never be mistaken for one.
 */
export function toNumberedPlaceholders(sql: string): string {
  let result = "";
  let placeholderCount = 0;
  let inString = false;

  for (const char of sql) {
    if (char === "'") {
      inString = !inString;
      result += char;
    } else if (char === "?" && !inString) {
      placeholderCount += 1;
      result += `$${placeholderCount}`;
    } else {
      result += char;
    }
  }

  return result;
}

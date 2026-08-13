import type { SqliteDriver } from "@meologue/core";
import { TauriSqliteDriver } from "./tauri-sqlite-driver";

/**
 * macOS's sqlite-driver seam (ticket 23, collapsed in ticket 24): connects
 * a SqliteDriver backed by `@tauri-apps/plugin-sql` rather than the
 * browser-local store this used before. Existing local data is not
 * migrated — entries already synced return from the server on the first
 * pull, and only never-synced entries are lost, the trade ticket 22
 * accepted for Android and carried over here.
 */
export async function createDriver(): Promise<SqliteDriver> {
  const driver = new TauriSqliteDriver();
  await driver.connect();
  return driver;
}

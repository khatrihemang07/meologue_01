import type { SqliteDriver } from "@meologue/core";
import { CapacitorSqliteDriver } from "./capacitor-sqlite-driver";

/**
 * Android's sqlite-driver seam (ticket 22, collapsed in ticket 24): connects
 * a SqliteDriver backed by `@capacitor-community/sqlite` rather than the
 * browser-local store this used before. Existing local data is not
 * migrated — entries already synced return from the server on the first
 * pull, and only never-synced entries are lost, the trade accepted for
 * ticket 22.
 */
export async function createDriver(): Promise<SqliteDriver> {
  const driver = new CapacitorSqliteDriver();
  await driver.connect();
  return driver;
}

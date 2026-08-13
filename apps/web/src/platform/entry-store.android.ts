import type { EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { CapacitorSqliteDriver } from "./capacitor-sqlite-driver";

/**
 * Android's entry-store seam (ticket 22): opens the SQLite store behind
 * `@capacitor-community/sqlite` rather than the browser-local store this
 * used before. Existing local data is not migrated — entries already
 * synced return from the server on the first pull, and only never-synced
 * entries are lost, the trade accepted for this ticket.
 */
export async function openEntryStore(): Promise<{ store: EntryStore; deviceId: string }> {
  const driver = new CapacitorSqliteDriver();
  await driver.connect();
  return open(driver);
}

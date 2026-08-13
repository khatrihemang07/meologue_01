import type { EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { TauriSqliteDriver } from "./tauri-sqlite-driver";

/**
 * macOS's entry-store seam (ticket 23): opens the SQLite store behind
 * `@tauri-apps/plugin-sql` rather than the browser-local store this used
 * before. Existing local data is not migrated — entries already synced
 * return from the server on the first pull, and only never-synced entries
 * are lost, the trade ticket 22 accepted for Android and carried over here.
 */
export async function openEntryStore(): Promise<{ store: EntryStore; deviceId: string }> {
  const driver = new TauriSqliteDriver();
  await driver.connect();
  return open(driver);
}

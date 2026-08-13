import type { SqliteDriver } from "./driver";
import { migrate } from "./migrator";
import { SqliteEntryStore } from "./sqlite-entry-store";

export interface OpenedSqliteStore {
  store: SqliteEntryStore;
  deviceId: string;
}

/**
 * Opens the SQLite EntryStore behind a driver (ADR 0007): applies any
 * migrations not yet recorded in the ledger, then resolves this Device's
 * id, minting one on first run. Prefer this over constructing
 * SqliteEntryStore directly — a store that hasn't been migrated can't be
 * queried.
 */
export async function open(driver: SqliteDriver): Promise<OpenedSqliteStore> {
  await migrate(driver);
  const store = new SqliteEntryStore(driver);
  const deviceId = await store.ensureDeviceId();
  return { store, deviceId };
}
